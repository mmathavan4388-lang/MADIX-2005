import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as s from '../services/social.js';
import { pool, many } from '../db/pool.js';
import { getSetting } from '../lib/settings.js';

const idp = z.object({ id: z.string().uuid() });
export async function socialRoutes(app: FastifyInstance) {
  const pre = { preHandler: app.verified };

  app.get('/feed', pre, async (req) => {
    const q = z.object({ kind: z.enum(['post', 'reel', 'all']).default('post'), cursor: z.coerce.number().int().min(0).max(500).default(0) }).parse(req.query);
    return s.rankedFeed(req.user!.id, q.kind, q.cursor);
  });
  app.get('/reels/trending', pre, async (req) => ({ items: await s.trendingReels(req.user!.id) }));

  /** Single call for the Home screen sections. */
  app.get('/home', pre, async (req) => {
    const uid = req.user!.id;
    const [posts, reels, trending] = await Promise.all([s.rankedFeed(uid, 'post', 0, 6), s.rankedFeed(uid, 'reel', 0, 8), s.trendingReels(uid, 8)]);
    const tags = await many(pool, `SELECT t AS tag, count(*)::int AS n FROM posts p, unnest(p.hashtags) t WHERE p.created_at > now() - interval '3 days' AND p.status='published' GROUP BY t ORDER BY n DESC LIMIT 10`);
    return { posts: posts.items, reels: reels.items, trending, trendingTags: tags, home: await getSetting('home') };
  });

  app.post('/posts', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ kind: z.enum(['text', 'image', 'video', 'reel']), body: z.string().max(2200).default(''), fileId: z.string().uuid().optional(), audioFileId: z.string().uuid().optional(), captions: z.string().max(4000).optional(), aiGenerated: z.boolean().optional() }).parse(req.body);
    return reply.status(201).send(await s.createPost(req.user!.id, b));
  });
  app.get('/posts/:id', pre, async (req) => s.getPost(req.user!.id, idp.parse(req.params).id));
  app.delete('/posts/:id', pre, async (req) => { await s.deletePost(req.user!.id, idp.parse(req.params).id); return { ok: true }; });
  app.post('/posts/:id/like', pre, async (req) => s.toggleReaction(req.user!.id, idp.parse(req.params).id, 'like', true));
  app.delete('/posts/:id/like', pre, async (req) => s.toggleReaction(req.user!.id, idp.parse(req.params).id, 'like', false));
  app.post('/posts/:id/save', pre, async (req) => s.toggleReaction(req.user!.id, idp.parse(req.params).id, 'save', true));
  app.delete('/posts/:id/save', pre, async (req) => s.toggleReaction(req.user!.id, idp.parse(req.params).id, 'save', false));
  app.post('/posts/:id/share', pre, async (req) => { await s.addShare(req.user!.id, idp.parse(req.params).id); return { ok: true }; });
  app.post('/posts/:id/view', pre, async (req) => {
    const b = z.object({ watchMs: z.number().min(0), completed: z.boolean().default(false) }).parse(req.body);
    await s.recordView(req.user!.id, idp.parse(req.params).id, b.watchMs, b.completed); return { ok: true };
  });
  app.get('/posts/:id/comments', pre, async (req) => s.listComments(req.user!.id, idp.parse(req.params).id, (req.query as any).cursor));
  app.post('/posts/:id/comments', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.status(201).send(await s.addComment(req.user!.id, idp.parse(req.params).id, z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body).body)));
  app.delete('/comments/:id', pre, async (req) => { await s.deleteComment(req.user!.id, idp.parse(req.params).id); return { ok: true }; });

  app.get('/saved', pre, async (req) => s.savedPosts(req.user!.id, (req.query as any).cursor));
  app.get('/users/:id/posts', pre, async (req) => {
    const q = z.object({ kind: z.string().optional(), cursor: z.string().optional() }).parse(req.query);
    return s.postsOf(req.user!.id, idp.parse(req.params).id, q.kind, q.cursor);
  });
  app.post('/users/:id/follow', pre, async (req) => { await s.setFollow(req.user!.id, idp.parse(req.params).id, true); return { ok: true }; });
  app.delete('/users/:id/follow', pre, async (req) => { await s.setFollow(req.user!.id, idp.parse(req.params).id, false); return { ok: true }; });
  app.post('/users/:id/block', pre, async (req) => {
    const { id } = idp.parse(req.params);
    if (id === req.user!.id) return { ok: true };
    await pool.query('INSERT INTO blocks(blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user!.id, id]);
    await pool.query('DELETE FROM follows WHERE (follower_id=$1 AND followee_id=$2) OR (follower_id=$2 AND followee_id=$1)', [req.user!.id, id]);
    return { ok: true };
  });
  app.delete('/users/:id/block', pre, async (req) => { await pool.query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user!.id, idp.parse(req.params).id]); return { ok: true }; });

  app.get('/search', pre, async (req) => {
    const q = z.object({ q: z.string().max(80), type: z.enum(['users', 'posts', 'hashtags']).default('posts') }).parse(req.query);
    return s.search(req.user!.id, q.q, q.type);
  });
  app.post('/reports', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ targetType: z.enum(['post', 'comment', 'user', 'message']), targetId: z.string().uuid(), reason: z.enum(['spam', 'abuse', 'nudity', 'violence', 'misinformation', 'copyright', 'other']), details: z.string().max(500).default('') }).parse(req.body);
    await s.report(req.user!.id, b.targetType, b.targetId, b.reason, b.details); return { ok: true };
  });
}
