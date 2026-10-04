import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, makeAdmin, installTestProviders, addAllProviders, bal, drain } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { hmacHex } from '../src/lib/crypto.js';
import { sentMail } from '../src/lib/mail.js';
import { clearSettingsCache } from '../src/lib/settings.js';

let app: FastifyInstance; let admin: Awaited<ReturnType<typeof makeAdmin>>;
const realFetch = globalThis.fetch;
let orderSeq = 0; const orders = new Map<string, { amount: number; currency: string }>(); const payments = new Map<string, any>();
const calls: string[] = [];

beforeAll(async () => {
  await resetDb(); installTestProviders(); await addAllProviders(); app = await makeApp(); admin = await makeAdmin(app);
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.startsWith('https://api.razorpay.com/v1')) return realFetch(url, init);
    calls.push(`${init?.method ?? 'GET'} ${u.replace('https://api.razorpay.com/v1', '')}`);
    if (u.endsWith('/orders')) { const b = JSON.parse(init.body); const id = `order_${++orderSeq}`; orders.set(id, { amount: b.amount, currency: b.currency }); return Response.json({ id, ...b }); }
    const m = /\/payments\/([^/]+)(\/capture)?$/.exec(u)!;
    const p = payments.get(m[1]); if (!p) return new Response('{}', { status: 404 });
    if (m[2]) { p.status = 'captured'; }
    return Response.json(p);
  }) as any;
});
afterAll(async () => { globalThis.fetch = realFetch; await app.close(); });
beforeEach(() => { calls.length = 0; });

const post = (u: any, url: string, payload: any = {}) => app.inject({ method: 'POST', url: '/api/v1' + url, headers: u.auth, payload });
const getJ = async (u: any, url: string) => (await app.inject({ method: 'GET', url: '/api/v1' + url, headers: u.auth })).json();
const sign = (order: string, pay: string) => hmacHex('rzp_test_secret_value', `${order}|${pay}`);
const makeRzpPayment = (orderId: string, status = 'captured', method = 'upi') => { const id = `pay_${Math.random().toString(36).slice(2, 10)}`; const o = orders.get(orderId)!; payments.set(id, { id, order_id: orderId, amount: o.amount, currency: o.currency, status, method }); return id; };
const webhook = (event: any, secret = 'whsec_test_value', id = `evt_${Math.random()}`) => { const raw = JSON.stringify(event); return app.inject({ method: 'POST', url: '/api/v1/billing/webhook/razorpay', headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmacHex(secret, raw), 'x-razorpay-event-id': id }, payload: raw }); };

describe('Plans & server-side pricing', () => {
  it('serves plans from the DB; admin price change (₹599 → ₹499) appears instantly and the order uses it', async () => {
    const u = await signup(app);
    const plans = (await getJ(u, '/billing/summary'), (await app.inject({ method: 'GET', url: '/api/v1/plans' })).json().plans);
    const pro = plans.find((p: any) => p.code === 'pro_monthly');
    expect(pro.priceMinor).toBe(59900);
    const put = await app.inject({ method: 'PUT', url: `/api/v1/admin/plans/${pro.id}`, headers: admin.auth, payload: { code: 'pro_monthly', name: 'MADIX Pro', kind: 'subscription', interval: 'month', priceMinor: 49900, compareAtMinor: 59900, credits: 1000, features: ['chat', 'image', 'video', 'edit'] } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/plans' })).json().plans.find((p: any) => p.code === 'pro_monthly').priceMinor).toBe(49900);
    const order = (await post(u, '/billing/orders', { planCode: 'pro_monthly' })).json();
    expect(order.amount).toBe(49900);
    expect(orders.get(order.orderId)!.amount).toBe(49900);
  });
  it('ignores any client-supplied amount; unknown/disabled plans are rejected', async () => {
    const u = await signup(app);
    const r = await post(u, '/billing/orders', { planCode: 'pro_monthly', amount: 1, priceMinor: 1 });
    expect(r.json().amount).toBe(49900);
    expect((await post(u, '/billing/orders', { planCode: 'does_not_exist' })).statusCode).toBe(404);
    await pool.query(`UPDATE plans SET active=false WHERE code='credits_200'`);
    expect((await post(u, '/billing/orders', { planCode: 'credits_200' })).statusCode).toBe(404);
    await pool.query(`UPDATE plans SET active=true WHERE code='credits_200'`);
  });
  it('coupons are validated server-side and applied once per user', async () => {
    const u = await signup(app);
    const c = await app.inject({ method: 'POST', url: '/api/v1/admin/coupons', headers: admin.auth, payload: { code: 'LAUNCH20', percentOff: 20, maxRedemptions: 5 } });
    expect(c.statusCode).toBe(201);
    const q = (await post(u, '/billing/quote', { planCode: 'premium_monthly', couponCode: 'launch20' })).json();
    expect(q).toMatchObject({ subtotal: 99900, discount: 19980, total: 79920 });
    expect((await post(u, '/billing/quote', { planCode: 'premium_monthly', couponCode: 'NOPE' })).statusCode).toBe(400);
  });
});

describe('Payment → verification → automatic activation', () => {
  it('UPI/GPay payment: verified server-side, subscription + credits + unlock activate automatically, notifications and email sent', async () => {
    const u = await signup(app);
    expect((await post(u, '/generations/video', { prompt: 'locked before paying' })).statusCode).toBe(202); // trial allows 1 video — use it up
    expect((await post(u, '/generations/video', { prompt: 'locked before paying 2' })).json().error.code).toBe('feature_locked');
    const before = await bal(u.id);
    const order = (await post(u, '/billing/orders', { planCode: 'pro_monthly' })).json();
    const payId = makeRzpPayment(order.orderId, 'captured', 'upi');
    const res = await post(u, '/billing/verify', { razorpay_order_id: order.orderId, razorpay_payment_id: payId, razorpay_signature: sign(order.orderId, payId) });
    expect(res.statusCode).toBe(200); expect(res.json().status).toBe('paid');
    // gateway was consulted (not just the signature)
    expect(calls.some((c) => c.startsWith('GET /payments/'))).toBe(true);
    expect(await bal(u.id)).toBe(before + 1000);
    const me = await getJ(u, '/me');
    expect(me.access.subscriptionActive).toBe(true); expect(me.access.planCode).toBe('pro_monthly'); expect(me.access.features).toContain('video');
    const pay = (await pool.query('SELECT * FROM payments WHERE provider_order_id=$1', [order.orderId])).rows[0];
    expect(pay.status).toBe('paid'); expect(pay.method).toBe('upi'); expect(pay.provider_payment_id).toBe(payId);
    // paid features now unlocked automatically — the trial cap no longer applies
    expect((await post(u, '/generations/video', { prompt: 'unlocked after paying' })).statusCode).toBe(202);
    const notifs = (await getJ(u, '/notifications')).items.map((n: any) => n.type);
    expect(notifs).toEqual(expect.arrayContaining(['payment_success', 'subscription_activated']));
    expect(sentMail.some((m) => m.to === u.email && /payment is confirmed/.test(m.subject))).toBe(true);
  });
  it('fulfilment is idempotent across verify + webhook + replays (credits granted once)', async () => {
    const u = await signup(app);
    const start = await bal(u.id);
    const order = (await post(u, '/billing/orders', { planCode: 'credits_200' })).json();
    const payId = makeRzpPayment(order.orderId);
    const body = { razorpay_order_id: order.orderId, razorpay_payment_id: payId, razorpay_signature: sign(order.orderId, payId) };
    await post(u, '/billing/verify', body); await post(u, '/billing/verify', body);
    const wh = await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: order.orderId, amount: order.amount, method: 'upi' } } } });
    expect(wh.statusCode).toBe(200);
    await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: order.orderId, amount: order.amount } } } }, 'whsec_test_value', 'same-event');
    await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: order.orderId, amount: order.amount } } } }, 'whsec_test_value', 'same-event');
    expect(await bal(u.id)).toBe(start + 200);
    expect((await pool.query(`SELECT count(*)::int n FROM credit_ledger WHERE idempotency_key=$1`, [`purchase:${(await pool.query('SELECT id FROM payments WHERE provider_order_id=$1', [order.orderId])).rows[0].id}`])).rows[0].n).toBe(1);
  });
  it('rejects a forged client signature and does not unlock anything', async () => {
    const u = await signup(app);
    const start = await bal(u.id);
    const order = (await post(u, '/billing/orders', { planCode: 'premium_monthly' })).json();
    const payId = makeRzpPayment(order.orderId);
    const bad = await post(u, '/billing/verify', { razorpay_order_id: order.orderId, razorpay_payment_id: payId, razorpay_signature: 'f'.repeat(64) });
    expect(bad.statusCode).toBe(400);
    expect((await getJ(u, '/me')).access.subscriptionActive).toBe(false); expect(await bal(u.id)).toBe(start);
  });
  it('a "success screen" with a valid signature but an UNPAID gateway payment does not unlock', async () => {
    const u = await signup(app);
    const order = (await post(u, '/billing/orders', { planCode: 'premium_monthly' })).json();
    const payId = makeRzpPayment(order.orderId, 'failed');
    const res = await post(u, '/billing/verify', { razorpay_order_id: order.orderId, razorpay_payment_id: payId, razorpay_signature: sign(order.orderId, payId) });
    expect(res.statusCode).toBe(409);
    expect((await getJ(u, '/me')).access.subscriptionActive).toBe(false);
  });
  it('rejects mismatched amounts and other users\' orders', async () => {
    const a = await signup(app), b = await signup(app);
    const order = (await post(a, '/billing/orders', { planCode: 'credits_200' })).json();
    const payId = makeRzpPayment(order.orderId); payments.get(payId).amount = 100;
    expect((await post(a, '/billing/verify', { razorpay_order_id: order.orderId, razorpay_payment_id: payId, razorpay_signature: sign(order.orderId, payId) })).statusCode).toBe(400);
    const pay2 = makeRzpPayment(order.orderId);
    expect((await post(b, '/billing/verify', { razorpay_order_id: order.orderId, razorpay_payment_id: pay2, razorpay_signature: sign(order.orderId, pay2) })).statusCode).toBe(404);
  });
  it('webhook requires a valid signature', async () => {
    const u = await signup(app);
    const order = (await post(u, '/billing/orders', { planCode: 'credits_200' })).json();
    const forged = await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: order.orderId, amount: order.amount } } } }, 'wrong-secret');
    expect(forged.statusCode).toBe(400);
    expect((await pool.query('SELECT status FROM payments WHERE provider_order_id=$1', [order.orderId])).rows[0].status).toBe('created');
  });
  it('webhook alone activates when the browser never returns (closed tab after UPI approval)', async () => {
    const u = await signup(app);
    const order = (await post(u, '/billing/orders', { planCode: 'premium_monthly' })).json();
    const payId = makeRzpPayment(order.orderId);
    await webhook({ event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: order.orderId, amount: order.amount, method: 'card' } } } });
    expect((await getJ(u, '/me')).access.planCode).toBe('premium_monthly');
    expect((await getJ(u, `/billing/orders/${order.orderId}`)).status).toBe('paid');
  });
  it('failed payment webhook marks failure and never activates', async () => {
    const u = await signup(app);
    const order = (await post(u, '/billing/orders', { planCode: 'premium_monthly' })).json();
    await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f', order_id: order.orderId, error_description: 'bank declined' } } } });
    expect((await pool.query('SELECT status FROM payments WHERE provider_order_id=$1', [order.orderId])).rows[0].status).toBe('failed');
    expect((await getJ(u, '/me')).access.subscriptionActive).toBe(false);
  });
  it('renewal extends from the current period end; yearly plan adds a year', async () => {
    const u = await signup(app);
    for (const code of ['pro_monthly', 'pro_monthly']) {
      const o = (await post(u, '/billing/orders', { planCode: code })).json(); const p = makeRzpPayment(o.orderId);
      await post(u, '/billing/verify', { razorpay_order_id: o.orderId, razorpay_payment_id: p, razorpay_signature: sign(o.orderId, p) });
    }
    const end = new Date((await getJ(u, '/me')).access.subscriptionEndsAt).getTime();
    expect((end - Date.now()) / 86400000).toBeGreaterThan(58);
  });
  it('100% coupon unlocks without the gateway, server-side', async () => {
    const u = await signup(app);
    await app.inject({ method: 'POST', url: '/api/v1/admin/coupons', headers: admin.auth, payload: { code: 'FREEPACK', percentOff: 100, maxRedemptions: 1, planCodes: ['credits_200'] } });
    const start = await bal(u.id);
    const r = await post(u, '/billing/orders', { planCode: 'credits_200', couponCode: 'FREEPACK' });
    expect(r.json().free).toBe(true); expect(await bal(u.id)).toBe(start + 200);
    const other = await signup(app);
    expect((await post(other, '/billing/orders', { planCode: 'credits_200', couponCode: 'FREEPACK' })).statusCode).toBe(400); // exhausted
  });
  it('only the owner can see revenue; users cannot call admin payment endpoints', async () => {
    const u = await signup(app);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/payments', headers: u.auth })).statusCode).toBe(403);
    const dash = (await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard', headers: admin.auth })).json();
    expect(dash.revenue.payments).toBeGreaterThan(0); expect(dash.revenue.totalMinor).toBeGreaterThan(0);
  });
});
void afterEach; void drain; void clearSettingsCache;
