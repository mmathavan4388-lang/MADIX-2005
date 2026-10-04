import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as g from '../services/generate.js';

const idp = z.object({ id: z.string().uuid() });
export async function generationRoutes(app: FastifyInstance) {
  const pre = { preHandler: app.verified, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.post('/image', pre, async (req, reply) => reply.status(202).send(await g.requestImage(req.user!.id, g.imageSchema.parse(req.body))));
  app.post('/video', pre, async (req, reply) => reply.status(202).send(await g.requestVideo(req.user!.id, g.videoSchema.parse(req.body))));
  app.post('/promo', pre, async (req, reply) => reply.status(202).send(await g.requestPromo(req.user!.id, g.promoSchema.parse(req.body))));
  app.post('/photo-edit', pre, async (req, reply) => reply.status(202).send(await g.requestPhotoEdit(req.user!.id, g.photoEditSchema.parse(req.body))));
  app.post('/video-edit', pre, async (req, reply) => reply.status(202).send(await g.requestVideoEdit(req.user!.id, g.videoEditSchema.parse(req.body))));

  app.get('/', { preHandler: app.verified }, async (req) => {
    const q = z.object({ kind: z.enum(['image', 'video', 'promo', 'photo_edit', 'video_edit']).optional(), cursor: z.string().optional() }).parse(req.query);
    return g.listGenerations(req.user!.id, q.kind, q.cursor);
  });
  app.get('/:id', { preHandler: app.verified }, async (req) => g.getGeneration(req.user!.id, idp.parse(req.params).id));
  app.post('/:id/cancel', { preHandler: app.verified }, async (req) => g.cancelGeneration(req.user!.id, idp.parse(req.params).id));
  app.delete('/:id', { preHandler: app.verified }, async (req) => { await g.deleteGeneration(req.user!.id, idp.parse(req.params).id); return { ok: true }; });
}
