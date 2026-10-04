import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config, isProd } from './config.js';
import { AppError, unauthorized, forbidden } from './lib/errors.js';
import { verifyAccess } from './services/auth.js';
import { one, pool } from './db/pool.js';
import { hashIp } from './lib/crypto.js';

export interface AuthUser { id: string; role: 'user' | 'moderator' | 'admin'; sid: string; adm: boolean; username: string; locale: string }
declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser; rawBody?: Buffer }
  interface FastifyInstance {
    auth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verified: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    adminOnly: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    modOnly: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' && !process.env.TEST_LOG ? false : { level: isProd ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.TRUST_PROXY, bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, { origin: [config.PUBLIC_WEB_URL], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    allowList: () => config.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMIT,
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: () => ({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' } }),
  });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try { done(null, JSON.parse(body.toString('utf8'))); } catch { done(new AppError(400, 'bad_json', 'Invalid JSON body.')); }
  });

  app.decorate('auth', async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    let claims;
    try { claims = await verifyAccess(h.slice(7)); } catch { throw unauthorized('Session expired. Please sign in again.'); }
    const u = await one(pool, `SELECT u.id, u.role, u.status, u.suspended_until, u.username, u.locale, s.revoked_at, s.expires_at
      FROM users u JOIN sessions s ON s.id=$2 AND s.user_id=u.id WHERE u.id=$1`, [claims.id, claims.sid]);
    if (!u || u.revoked_at || new Date(u.expires_at) < new Date()) throw unauthorized('Session expired. Please sign in again.');
    if (u.status === 'blocked') throw forbidden('This account has been blocked.');
    if (u.status === 'suspended' && (!u.suspended_until || new Date(u.suspended_until) > new Date())) throw forbidden('This account is temporarily suspended.');
    req.user = { id: u.id, role: u.role, sid: claims.sid, adm: claims.adm, username: u.username, locale: u.locale };
  });
  app.decorate('verified', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.auth(req, reply);
    const v = await one(pool, 'SELECT email_verified_at FROM users WHERE id=$1', [req.user!.id]);
    if (!v.email_verified_at) throw new AppError(403, 'email_unverified', 'Please verify your email to use this feature.');
  });
  app.decorate('adminOnly', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.auth(req, reply);
    if (req.user!.role !== 'admin' || !req.user!.adm) throw forbidden('Admin access required.');
    const u = await one(pool, 'SELECT totp_enabled FROM users WHERE id=$1', [req.user!.id]);
    if (!u?.totp_enabled) throw forbidden('Two-factor authentication is required for admin access.');
  });
  app.decorate('modOnly', async (req: FastifyRequest, reply: FastifyReply) => {
    await app.auth(req, reply);
    if (!['admin', 'moderator'].includes(req.user!.role) || (req.user!.role === 'admin' && !req.user!.adm)) throw forbidden('Moderator access required.');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'validation', message: err.issues[0]?.message ?? 'Invalid input.', fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: 'The request could not be processed.' } });
    req.log.error({ err }, 'unhandled');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => { try { await pool.query('SELECT 1'); return { ok: true }; } catch { return reply.status(503).send({ ok: false }); } });

  const { registerRoutes } = await import('./routes/index.js');
  await app.register(registerRoutes, { prefix: '/api/v1' });
  const { mediaRoutes } = await import('./routes/media.js');
  await app.register(mediaRoutes);
  return app;
}
export const ipOf = (req: FastifyRequest) => req.ip;
export const ipHashOf = (req: FastifyRequest) => hashIp(req.ip);
