import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as auth from '../services/auth.js';

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
}
