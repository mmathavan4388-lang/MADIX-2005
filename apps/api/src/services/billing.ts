import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, one, many, Q } from '../db/pool.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { adjustCredits } from './credits.js';
import { notify } from './notify.js';
import { sendMail } from '../lib/mail.js';
import { hmacHex, safeEqualHex } from '../lib/crypto.js';
import { audit, track } from '../lib/audit.js';
import { emit } from './events.js';

export const orderSchema = z.object({ planCode: z.string().min(1).max(60), couponCode: z.string().trim().max(40).optional() });

/** Server-side price computation — the client never supplies an amount. */
export async function quote(userId: string, planCode: string, couponCode?: string, q: Q = pool) {
  const plan = await one(q, `SELECT * FROM plans WHERE code=$1 AND active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [planCode]);
  if (!plan) throw notFound('This plan is not available.');
  let coupon: any = null; let discount = 0;
  if (couponCode) {
    coupon = await one(q, `SELECT * FROM coupons WHERE code=$1 AND active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`, [couponCode]);
    if (!coupon || (coupon.max_redemptions !== null && coupon.redeemed >= coupon.max_redemptions) || (coupon.plan_codes && !coupon.plan_codes.includes(plan.code)))
      throw badRequest('This coupon is not valid.', 'invalid_coupon');
    const used = await one(q, `SELECT 1 FROM payments WHERE user_id=$1 AND coupon_id=$2 AND status='paid'`, [userId, coupon.id]);
    if (used) throw badRequest('You have already used this coupon.', 'coupon_used');
    discount = coupon.percent_off ? Math.floor((plan.price_minor * coupon.percent_off) / 100) : Math.min(plan.price_minor, coupon.amount_off_minor);
  }
  return { plan, coupon, subtotal: plan.price_minor, discount, total: Math.max(0, plan.price_minor - discount) };
}

async function rzp(path: string, init: RequestInit = {}) {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) throw new AppError(503, 'payments_unavailable', 'Payments are not available right now. Please try again later.');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64'), ...init.headers },
  });
  if (!res.ok) { console.error('[razorpay]', res.status, (await res.text()).slice(0, 300)); throw new AppError(502, 'payments_unavailable', 'We could not reach the payment provider. Please try again.'); }
  return res.json() as Promise<any>;
}

export async function createOrder(userId: string, input: z.infer<typeof orderSchema>) {
  const qt = await quote(userId, input.planCode, input.couponCode);
  const paymentId = (await one(pool, 'SELECT gen_random_uuid() id')).id as string;
  if (qt.total === 0) {
    // Fully discounted: no gateway involved; fulfilled by the server directly.
    await pool.query(`INSERT INTO payments(id,user_id,plan_id,coupon_id,provider,provider_order_id,amount_minor,currency,status) VALUES ($1,$2,$3,$4,'coupon',$5,0,$6,'created')`,
      [paymentId, userId, qt.plan.id, qt.coupon?.id ?? null, `free_${paymentId}`, qt.plan.currency]);
    await fulfill(`free_${paymentId}`, `free_${paymentId}`, 'coupon', 0);
    return { free: true, paymentId };
  }
  if (qt.total < 100) throw badRequest('Order amount is below the minimum.');
  const order = await rzp('/orders', { method: 'POST', body: JSON.stringify({ amount: qt.total, currency: qt.plan.currency, receipt: paymentId.slice(0, 36), notes: { userId, planCode: qt.plan.code, paymentId } }) });
  await pool.query(`INSERT INTO payments(id,user_id,plan_id,coupon_id,provider,provider_order_id,amount_minor,currency) VALUES ($1,$2,$3,$4,'razorpay',$5,$6,$7)`,
    [paymentId, userId, qt.plan.id, qt.coupon?.id ?? null, order.id, qt.total, qt.plan.currency]);
  void track(userId, 'checkout_started', { plan: qt.plan.code });
  return { free: false, paymentId, orderId: order.id as string, amount: qt.total, currency: qt.plan.currency, keyId: config.RAZORPAY_KEY_ID, planName: qt.plan.name };
}

/** Client-reported success: verify HMAC signature, then confirm with the gateway before fulfilling. */
export async function verifyClientPayment(userId: string, orderId: string, paymentId: string, signature: string) {
  const pay = await one(pool, 'SELECT * FROM payments WHERE provider_order_id=$1 AND user_id=$2', [orderId, userId]);
  if (!pay) throw notFound('Payment not found.');
  if (!config.RAZORPAY_KEY_SECRET) throw new AppError(503, 'payments_unavailable', 'Payments are not available right now.');
  if (!safeEqualHex(hmacHex(config.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature)) {
    await audit(userId, 'payment.bad_signature', orderId);
    throw badRequest('Payment verification failed.', 'bad_signature');
  }
  await confirmWithGateway(orderId, paymentId, pay.amount_minor);
  return fulfill(orderId, paymentId, null, pay.amount_minor);
}

async function confirmWithGateway(orderId: string, paymentId: string, expectedAmount: number) {
  let p = await rzp(`/payments/${encodeURIComponent(paymentId)}`);
  if (p.order_id !== orderId || p.amount !== expectedAmount) throw badRequest('Payment verification failed.', 'mismatch');
  if (p.status === 'authorized') p = await rzp(`/payments/${encodeURIComponent(paymentId)}/capture`, { method: 'POST', body: JSON.stringify({ amount: expectedAmount, currency: p.currency }) });
  if (p.status !== 'captured') throw new AppError(409, 'payment_pending', 'Your payment is still being confirmed. We will unlock your plan as soon as it completes.');
  await pool.query('UPDATE payments SET method=$2 WHERE provider_order_id=$1', [orderId, p.method ?? null]);
}

/** Idempotent, transactional fulfilment: payment → subscription/credits/unlocks. Safe to call from both verify and webhook. */
export async function fulfill(orderId: string, providerPaymentId: string, method: string | null, amountPaid: number) {
  const result = await tx(async (c) => {
    const pay = await one(c, 'SELECT * FROM payments WHERE provider_order_id=$1 FOR UPDATE', [orderId]);
    if (!pay) throw notFound('Payment not found.');
    if (pay.fulfilled_at) return { already: true, pay };
    if (pay.amount_minor !== amountPaid) { await c.query(`UPDATE payments SET status='failed', failure_reason='amount_mismatch' WHERE id=$1`, [pay.id]); throw badRequest('Payment amount mismatch.', 'mismatch'); }
    const plan = await one(c, 'SELECT * FROM plans WHERE id=$1', [pay.plan_id]);
    await c.query(`UPDATE payments SET status='paid', provider_payment_id=$2, method=COALESCE($3,method), paid_at=now(), fulfilled_at=now() WHERE id=$1`, [pay.id, providerPaymentId, method]);
    if (pay.coupon_id) await c.query('UPDATE coupons SET redeemed=redeemed+1 WHERE id=$1', [pay.coupon_id]);
    let periodEnd: Date | null = null;
    if (plan.kind === 'subscription') {
      const cur = await one(c, `SELECT max(current_period_end) AS e FROM subscriptions WHERE user_id=$1 AND status='active' AND current_period_end > now()`, [pay.user_id]);
      const start = cur?.e ? new Date(cur.e) : new Date();
      periodEnd = new Date(start); plan.interval === 'year' ? periodEnd.setFullYear(periodEnd.getFullYear() + 1) : periodEnd.setMonth(periodEnd.getMonth() + 1);
      await c.query(`INSERT INTO subscriptions(user_id, plan_id, payment_id, current_period_start, current_period_end) VALUES ($1,$2,$3,$4,$5)`, [pay.user_id, plan.id, pay.id, start, periodEnd]);
    } else if (plan.features.length) {
      for (const f of plan.features) await c.query(`INSERT INTO feature_unlocks(user_id, feature_key, source, source_ref) VALUES ($1,$2,'purchase',$3) ON CONFLICT DO NOTHING`, [pay.user_id, f, pay.id]);
    }
    if (plan.credits > 0) await adjustCredits(c, pay.user_id, plan.credits, `purchase:${plan.code}`, { type: 'payment', id: pay.id }, `purchase:${pay.id}`);
    return { already: false, pay, plan, periodEnd };
  });
  if (result.already) return { status: 'paid', alreadyProcessed: true };
  const { pay, plan, periodEnd } = result as any;
  await notify(pay.user_id, 'payment_success', 'Payment successful', `${plan.name} — thank you!`, { paymentId: pay.id });
  await notify(pay.user_id, 'subscription_activated', `${plan.name} is active`, plan.credits ? `${plan.credits} credits added. AI features unlocked.` : 'AI features unlocked.', { planCode: plan.code });
  void emit([pay.user_id], 'account', { reason: 'payment' });
  void track(pay.user_id, 'payment_success', { plan: plan.code, amount: pay.amount_minor });
  const u = await one(pool, 'SELECT email FROM users WHERE id=$1', [pay.user_id]);
  void sendMail(u.email, 'Your MADIX payment is confirmed', `Thanks for choosing ${plan.name}.\nAmount: ${(pay.amount_minor / 100).toFixed(2)} ${pay.currency}\n${periodEnd ? `Active until: ${periodEnd.toISOString().slice(0, 10)}\n` : ''}${plan.credits ? `Credits added: ${plan.credits}\n` : ''}\nMADIX — from SAYRIX MATHAV`).catch(() => {});
  return { status: 'paid', alreadyProcessed: false };
}

export async function handleWebhook(rawBody: Buffer, signature: string | undefined, eventId: string | undefined) {
  if (!config.RAZORPAY_WEBHOOK_SECRET) throw new AppError(503, 'payments_unavailable', 'Webhook not configured.');
  if (!signature || !safeEqualHex(hmacHex(config.RAZORPAY_WEBHOOK_SECRET, rawBody), signature)) throw new AppError(400, 'bad_signature', 'Invalid signature.');
  const evt = JSON.parse(rawBody.toString('utf8'));
  const id = eventId ?? `${evt.event}:${evt.payload?.payment?.entity?.id ?? evt.payload?.order?.entity?.id}`;
  const fresh = await pool.query(`INSERT INTO webhook_events(id, provider, payload) VALUES ($1,'razorpay',$2) ON CONFLICT DO NOTHING RETURNING id`, [id, evt]);
  if (!fresh.rowCount) return { duplicate: true };
  const p = evt.payload?.payment?.entity;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && p) {
    await fulfill(p.order_id, p.id, p.method ?? null, p.amount).catch(async (e) => { await pool.query('DELETE FROM webhook_events WHERE id=$1', [id]); throw e; });
  } else if (evt.event === 'payment.failed' && p) {
    await pool.query(`UPDATE payments SET status='failed', failure_reason=$2 WHERE provider_order_id=$1 AND status='created'`, [p.order_id, (p.error_description ?? 'failed').slice(0, 200)]);
    const pay = await one(pool, 'SELECT user_id FROM payments WHERE provider_order_id=$1', [p.order_id]);
    if (pay) await notify(pay.user_id, 'payment_success', 'Payment failed', 'Your payment did not go through. You have not been charged. Please try again.', { failed: true });
  } else if (evt.event === 'refund.processed') {
    const rp = evt.payload?.payment?.entity;
    if (rp) await pool.query(`UPDATE payments SET status='refunded' WHERE provider_payment_id=$1`, [rp.id]);
    if (rp) await pool.query(`UPDATE subscriptions SET status='cancelled' WHERE payment_id=(SELECT id FROM payments WHERE provider_payment_id=$1)`, [rp.id]);
  }
  return { ok: true };
}

export async function billingSummary(userId: string) {
  const subs = await many(pool, `SELECT s.id, s.status, s.current_period_end, p.code, p.name, p.interval FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.current_period_end DESC LIMIT 5`, [userId]);
  const pays = await many(pool, `SELECT pay.id, pay.status, pay.amount_minor, pay.currency, pay.method, pay.created_at, pl.name AS plan_name FROM payments pay JOIN plans pl ON pl.id=pay.plan_id WHERE pay.user_id=$1 ORDER BY pay.created_at DESC LIMIT 20`, [userId]);
  return { subscriptions: subs, payments: pays };
}
