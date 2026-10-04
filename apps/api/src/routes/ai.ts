import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, many } from '../db/pool.js';
import { notFound, AppError } from '../lib/errors.js';
import { sendAiMessage, enhancePrompt, MAX_INPUT_CHARS } from '../services/aiChat.js';

const idp = z.object({ id: z.string().uuid() });

export async function aiRoutes(app: FastifyInstance) {
  const pre = { preHandler: app.verified };

  app.get('/conversations', pre, async (req) => {
    const q = z.object({ q: z.string().max(100).optional(), cursor: z.string().optional() }).parse(req.query);
    const rows = await many(pool, `SELECT c.id, c.title, c.updated_at FROM ai_conversations c
      WHERE c.user_id=$1 AND ($3::timestamptz IS NULL OR c.updated_at < $3)
        AND ($2::text IS NULL OR c.title ILIKE '%' || $2 || '%' OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id=c.id AND to_tsvector('simple', m.content) @@ plainto_tsquery('simple', $2)))
      ORDER BY c.updated_at DESC LIMIT 30`, [req.user!.id, q.q?.trim() || null, q.cursor ?? null]);
    return { items: rows, next: rows.length === 30 ? rows[29].updated_at : null };
  });
  app.post('/conversations', pre, async (req) => {
    const b = z.object({ title: z.string().max(80).optional() }).parse(req.body ?? {});
    return one(pool, `INSERT INTO ai_conversations(user_id, title) VALUES ($1, COALESCE($2,'New chat')) RETURNING id, title, updated_at`, [req.user!.id, b.title ?? null]);
  });
  app.patch('/conversations/:id', pre, async (req) => {
    const { id } = idp.parse(req.params); const b = z.object({ title: z.string().trim().min(1).max(80) }).parse(req.body);
    const r = await one(pool, 'UPDATE ai_conversations SET title=$3 WHERE id=$1 AND user_id=$2 RETURNING id, title', [id, req.user!.id, b.title]);
    if (!r) throw notFound(); return r;
  });
  app.delete('/conversations/:id', pre, async (req) => {
    const { id } = idp.parse(req.params);
    const r = await pool.query('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2', [id, req.user!.id]);
    if (!r.rowCount) throw notFound(); return { ok: true };
  });
  app.get('/conversations/:id/messages', pre, async (req) => {
    const { id } = idp.parse(req.params);
    if (!(await one(pool, 'SELECT 1 FROM ai_conversations WHERE id=$1 AND user_id=$2', [id, req.user!.id]))) throw notFound();
    return { items: await many(pool, 'SELECT id, role, content, file_id, created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY created_at', [id]) };
  });

  /** Streaming reply over SSE. Closing the connection = "Stop generating" (partial text is kept). */
  async function stream(req: any, reply: any, regenerate: boolean) {
    const { id } = idp.parse(req.params);
    const b = regenerate ? { content: '', fileId: null } : z.object({ content: z.string().min(1).max(MAX_INPUT_CHARS), fileId: z.string().uuid().nullable().optional() }).parse(req.body);
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    let started = false;
    const start = () => { if (started) return; started = true; reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': req.headers.origin ?? '*' }); };
    const write = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const res = await sendAiMessage(req.user.id, id, b.content, (b as any).fileId ?? null, { signal: ac.signal, onToken: (t) => { start(); write('token', { t }); } }, { regenerate });
      start(); write('done', { messageId: (res as any).messageId ?? null, stopped: res.stopped });
    } catch (e: any) {
      if (!started) throw e; // normal JSON error before streaming began (402 insufficient credits etc.)
      write('error', { code: e.code ?? 'ai_failed', message: e instanceof AppError ? e.message : 'MADIX AI hit a problem. Please try again.' });
    }
    if (started) reply.raw.end();
  }
  app.post('/conversations/:id/messages', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (req, reply) => stream(req, reply, false));
  app.post('/conversations/:id/regenerate', { ...pre, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, (req, reply) => stream(req, reply, true));

  app.post('/enhance-prompt', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ prompt: z.string().trim().min(3).max(1000), kind: z.enum(['image', 'video', 'promo']) }).parse(req.body);
    return { prompt: await enhancePrompt(req.user!.id, b.prompt, b.kind) };
  });
}
