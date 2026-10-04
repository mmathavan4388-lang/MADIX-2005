import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as b from '../services/billing.js';
import { pool, one } from '../db/pool.js';

export async function billingRoutes(app: FastifyInstance) {
  const lim = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };
  app.post('/quote', { preHandler: app.verified, ...lim }, async (req) => {
    const i = b.orderSchema.parse(req.body);
    const q = await b.quote(req.user!.id, i.planCode, i.couponCode);
    return { planCode: q.plan.code, currency: q.plan.currency, subtotal: q.subtotal, discount: q.discount, total: q.total };
  });
  app.post('/orders', { preHandler: app.verified, ...lim }, async (req) => b.createOrder(req.user!.id, b.orderSchema.parse(req.body)));
  app.post('/verify', { preHandler: app.verified, ...lim }, async (req) => {
    const i = z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }).parse(req.body);
    return b.verifyClientPayment(req.user!.id, i.razorpay_order_id, i.razorpay_payment_id, i.razorpay_signature);
  });
  app.get('/summary', { preHandler: app.auth }, async (req) => b.billingSummary(req.user!.id));
  app.get('/orders/:orderId', { preHandler: app.auth }, async (req) => {
    const { orderId } = z.object({ orderId: z.string() }).parse(req.params);
    const p = await one(pool, 'SELECT status FROM payments WHERE provider_order_id=$1 AND user_id=$2', [orderId, req.user!.id]);
    return { status: p?.status ?? 'unknown' };
  });
  // Gateway → server. Authenticated by signature, not by session.
  app.post('/webhook/razorpay', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) =>
    b.handleWebhook(req.rawBody ?? Buffer.from(''), req.headers['x-razorpay-signature'] as string | undefined, req.headers['x-razorpay-event-id'] as string | undefined));
}
