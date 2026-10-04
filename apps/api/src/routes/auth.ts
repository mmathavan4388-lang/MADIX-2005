import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auth from '../services/auth.js';
import { pool, one } from '../db/pool.js';
import { sendSms } from '../services/sms.js';
import { sha256 } from '../lib/crypto.js';
import crypto from 'node:crypto';
import { badRequest } from '../lib/errors.js';

const tight = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance) {
  const ctx = (req: any) => ({ ip: req.ip as string, ua: req.headers['user-agent'] as string | undefined });

  app.post('/register', tight, async (req, reply) => {
    const body = auth.registerSchema.parse(req.body);
    return reply.status(201).send(await auth.register(body, ctx(req)));
  });
  app.post('/login', tight, async (req) => {
    const b = z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(128) }).parse(req.body);
    return auth.login(b.identifier, b.password, ctx(req));
  });
  app.post('/refresh', tight, async (req) => auth.refresh(z.object({ refreshToken: z.string().min(20) }).parse(req.body).refreshToken, ctx(req)));
  app.post('/logout', { preHandler: app.auth }, async (req) => {
    const b = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    await auth.logout(b.refreshToken, req.user!.sid);
    return { ok: true };
  });
  app.post('/verify-email', tight, async (req) => auth.verifyEmail(z.object({ token: z.string().min(10) }).parse(req.body).token));
  app.post('/resend-verification', tight, async (req) => { await auth.resendVerification(z.object({ email: z.string().email() }).parse(req.body).email); return { ok: true }; });
  app.post('/forgot-password', tight, async (req) => { await auth.forgotPassword(z.object({ email: z.string().email() }).parse(req.body).email); return { ok: true }; });
  app.post('/reset-password', tight, async (req) => {
    const b = z.object({ token: z.string().min(10), password: auth.passwordSchema }).parse(req.body);
    await auth.resetPassword(b.token, b.password);
    return { ok: true };
  });

  // ───── Phone verification (OTP over SMS) ─────
  const phoneLimit = { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } };
  app.post('/phone/send-otp', { preHandler: app.auth, ...phoneLimit }, async (req) => {
    const b = z.object({ phone: z.string().regex(/^\+[0-9]{8,15}$/, 'Use international format, e.g. +919876543210') }).parse(req.body);
    const taken = await one(pool, 'SELECT id FROM users WHERE phone=$1 AND id<>$2', [b.phone, req.user!.id]);
    if (taken) throw badRequest('This phone number is already in use.', 'phone_taken');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query(`UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND kind='verify_phone' AND used_at IS NULL`, [req.user!.id]);
    await pool.query(`INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at) VALUES ($1,'verify_phone',$2, now() + interval '10 minutes')`, [req.user!.id, sha256(`${req.user!.id}:${b.phone}:${code}`)]);
    await sendSms(b.phone, `Your MADIX verification code is ${code}. It expires in 10 minutes.`);
    return { ok: true };
  });
  app.post('/phone/verify', { preHandler: app.auth, ...phoneLimit }, async (req) => {
    const b = z.object({ phone: z.string().regex(/^\+[0-9]{8,15}$/), code: z.string().regex(/^[0-9]{6}$/) }).parse(req.body);
    const t = await one(pool, `UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND kind='verify_phone' AND token_hash=$2 AND used_at IS NULL AND expires_at > now() RETURNING id`, [req.user!.id, sha256(`${req.user!.id}:${b.phone}:${b.code}`)]);
    if (!t) throw badRequest('That code is incorrect or has expired.', 'invalid_code');
    try { await pool.query('UPDATE users SET phone=$2, phone_verified_at=now() WHERE id=$1', [req.user!.id, b.phone]); }
    catch (e: any) { if (e.code === '23505') throw badRequest('This phone number is already in use.', 'phone_taken'); throw e; }
    return { ok: true };
  });
}
