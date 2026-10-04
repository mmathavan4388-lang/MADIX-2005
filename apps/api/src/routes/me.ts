import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, many, one } from '../db/pool.js';
import { accountSummary } from '../services/account.js';
import { referralSummary } from '../services/referrals.js';
import { subscribe } from '../services/events.js';
import { badRequest, notFound } from '../lib/errors.js';
import { verifyAccess } from '../services/auth.js';
import { fileDto } from '../lib/files.js';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: app.auth }, async (req) => accountSummary(req.user!.id));

  app.patch('/me', { preHandler: app.auth }, async (req) => {
    const b = z.object({
      displayName: z.string().trim().min(1).max(60), bio: z.string().max(300), interests: z.array(z.string().max(30)).max(20),
      avatarFileId: z.string().uuid().nullable(), locale: z.enum(['en', 'ta', 'hi']),
      username: z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/),
    }).partial().parse(req.body);
    if (b.avatarFileId) {
      const f = await one(pool, `SELECT 1 FROM files WHERE id=$1 AND owner_id=$2 AND purpose='avatar' AND status='ready'`, [b.avatarFileId, req.user!.id]);
      if (!f) throw badRequest('Invalid avatar file.');
    }
    try {
      await pool.query(`UPDATE profiles SET display_name=COALESCE($2,display_name), bio=COALESCE($3,bio), interests=COALESCE($4,interests),
        avatar_file_id = CASE WHEN $5::boolean THEN $6::uuid ELSE avatar_file_id END WHERE user_id=$1`,
        [req.user!.id, b.displayName ?? null, b.bio ?? null, b.interests ? b.interests.map((t) => t.toLowerCase()) : null, 'avatarFileId' in b, b.avatarFileId ?? null]);
      if (b.locale || b.username) await pool.query('UPDATE users SET locale=COALESCE($2,locale), username=COALESCE($3,username) WHERE id=$1', [req.user!.id, b.locale ?? null, b.username ?? null]);
    } catch (e: any) { if (e.code === '23505') throw badRequest('That username is taken.', 'username_taken'); throw e; }
    return accountSummary(req.user!.id);
  });

  app.get('/me/credits', { preHandler: app.auth }, async (req) => {
    const q = z.object({ before: z.coerce.number().optional() }).parse(req.query);
    const rows = await many(pool, `SELECT id, delta, balance_after, reason, created_at FROM credit_ledger WHERE user_id=$1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 50`, [req.user!.id, q.before ?? null]);
    return { items: rows, next: rows.length === 50 ? rows[49].id : null };
  });

  app.get('/me/referrals', { preHandler: app.verified }, async (req) => referralSummary(req.user!.id));

  app.post('/me/push-token', { preHandler: app.auth }, async (req) => {
    const b = z.object({ token: z.string().min(10).max(4096), platform: z.enum(['web', 'android', 'ios']) }).parse(req.body);
    await pool.query(`INSERT INTO push_tokens(token,user_id,platform) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET user_id=$2, platform=$3`, [b.token, req.user!.id, b.platform]);
    return { ok: true };
  });

  app.delete('/me/sessions/others', { preHandler: app.auth }, async (req) => {
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [req.user!.id, req.user!.sid]);
    return { ok: true };
  });

  // ───── Notifications ─────
  app.get('/notifications', { preHandler: app.auth }, async (req) => {
    const q = z.object({ cursor: z.string().optional(), unread: z.coerce.boolean().optional() }).parse(req.query);
    const rows = await many(pool, `SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE user_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT 30`, [req.user!.id, q.cursor ?? null]);
    const unread = (await one(pool, 'SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user!.id])).n;
    return { items: rows, unread, next: rows.length === 30 ? rows[29].created_at : null };
  });
  app.post('/notifications/read', { preHandler: app.auth }, async (req) => {
    const b = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [req.user!.id, b.ids ?? null]);
    return { ok: true };
  });

  // ───── Server-Sent Events: notifications, chat and job updates ─────
  app.get('/events', async (req, reply) => {
    const token = (req.query as any).token as string | undefined;
    let uid: string;
    try { uid = (await verifyAccess(token ?? '')).id; } catch { return reply.status(401).send({ error: { code: 'unauthorized', message: 'Please sign in.' } }); }
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': req.headers.origin ?? '*' });
    const send = (e: string, d: unknown) => reply.raw.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    send('ready', {});
    const off = subscribe(uid, send);
    const ka = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ka); off(); });
    return reply;
  });

  app.get('/users/:username', { preHandler: app.auth }, async (req) => {
    const { username } = z.object({ username: z.string() }).parse(req.params);
    const u = await one(pool, `SELECT u.id, u.username, u.status, p.display_name, p.bio, p.avatar_file_id, p.followers_count, p.following_count, p.posts_count
      FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.username=$1`, [username]);
    if (!u || u.status === 'blocked') throw notFound('User not found.');
    const [following, avatar] = await Promise.all([
      one(pool, 'SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.user!.id, u.id]),
      u.avatar_file_id ? one(pool, 'SELECT * FROM files WHERE id=$1', [u.avatar_file_id]).then(fileDto) : null,
    ]);
    return { id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, avatar, followers: u.followers_count, following: u.following_count, posts: u.posts_count, isFollowing: !!following, isMe: u.id === req.user!.id };
  });
}
