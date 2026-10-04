import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { localStorageDriver } from '../storage/index.js';
import { config } from '../config.js';

// Local-driver media endpoint (development). In production use S3 + CDN; this route 404s.
export async function mediaRoutes(app: FastifyInstance) {
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.MAX_UPLOAD_MB * 1024 * 1024 }, (_r, body, done) => done(null, body));
  app.route({
    method: ['GET', 'PUT'], url: '/media/*',
    bodyLimit: config.MAX_UPLOAD_MB * 1024 * 1024,
    handler: async (req, reply) => {
      const drv = localStorageDriver();
      if (!drv) return reply.status(404).send();
      const key = decodeURIComponent((req.params as any)['*']);
      const q = req.query as { mode?: string; exp?: string; sig?: string };
      const mode = req.method === 'PUT' ? 'w' : 'r';
      if (q.mode !== mode || !drv.verify(key, mode, Number(q.exp), q.sig ?? '')) return reply.status(403).send({ error: { code: 'forbidden', message: 'Link expired or invalid.' } });
      if (mode === 'w') { await drv.put(key, req.body as Buffer); return reply.status(200).send(); }
      const f = path.resolve(drv.root, key);
      if (!f.startsWith(drv.root + path.sep) || !fs.existsSync(f)) return reply.status(404).send();
      const ext = path.extname(f).slice(1);
      const types: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', svg: 'image/svg+xml', pdf: 'application/pdf' };
      reply.header('Content-Type', types[ext] ?? 'application/octet-stream').header('Cache-Control', 'private, max-age=3000').header('X-Content-Type-Options', 'nosniff');
      if (ext === 'svg') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      const size = fs.statSync(f).size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      reply.header('Accept-Ranges', 'bytes');
      if (range && (range[1] || range[2])) {            // partial content so <video> can seek and start fast
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) return reply.status(416).header('Content-Range', `bytes */${size}`).send();
        return reply.status(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(fs.createReadStream(f, { start, end }));
      }
      return reply.header('Content-Length', size).send(fs.createReadStream(f));
    },
  });
}
