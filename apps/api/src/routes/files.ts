import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PURPOSES, initUpload, completeUpload, fileDto } from '../lib/files.js';
import { one, pool } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { storage } from '../storage/index.js';

export async function fileRoutes(app: FastifyInstance) {
  app.post('/init', { preHandler: app.verified, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ purpose: z.enum(PURPOSES), mime: z.string().max(100), size: z.number().int().positive() }).parse(req.body);
    return initUpload(req.user!.id, b.purpose, b.mime, b.size, req.user!.role === 'admin' && req.user!.adm);
  });
  app.post('/:id/complete', { preHandler: app.verified }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { file: await fileDto(await completeUpload(req.user!.id, id)) };
  });
  app.get('/:id', { preHandler: app.auth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const f = await one(pool, `SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND status='ready'`, [id, req.user!.id]);
    if (!f) throw notFound();
    return { file: await fileDto(f) };
  });
  app.delete('/:id', { preHandler: app.auth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const f = await one(pool, `UPDATE files SET status='deleted' WHERE id=$1 AND owner_id=$2 AND status<>'deleted' RETURNING storage_key, thumb_key`, [id, req.user!.id]);
    if (!f) throw notFound();
    await storage().delete(f.storage_key).catch(() => {}); if (f.thumb_key) await storage().delete(f.thumb_key).catch(() => {});
    return { ok: true };
  });
}
