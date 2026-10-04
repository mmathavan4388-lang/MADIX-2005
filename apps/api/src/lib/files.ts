import sharp from 'sharp';
import { pool, many, one } from '../db/pool.js';
import { storage, newKey } from '../storage/index.js';
import { getSetting } from './settings.js';
import { badRequest } from './errors.js';

export const PURPOSES = ['avatar', 'post', 'reel', 'ai_image', 'ai_video', 'document', 'chat', 'branding', 'promo', 'edit_source', 'edit_output'] as const;
export type Purpose = (typeof PURPOSES)[number];

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/webm': 'weba',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
const ALLOWED: Record<Purpose, string[]> = {
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
  post: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'],
  reel: ['video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'],
  ai_image: ['image/png', 'image/jpeg', 'image/webp'], ai_video: ['video/mp4', 'video/webm'],
  document: ['application/pdf', 'text/plain', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  chat: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'text/plain', 'audio/mpeg', 'audio/mp4', 'audio/webm'],
  branding: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
  promo: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
  edit_source: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'],
  edit_output: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
};
const PUBLIC_PURPOSES = new Set<Purpose>(['avatar', 'branding', 'promo', 'post', 'reel']);

export function sniff(buf: Buffer): string | null {
  const h = buf.subarray(0, 16);
  const hex = h.toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (h.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (h.subarray(4, 8).toString() === 'ftyp') return 'video/mp4'; // mp4/mov/m4a share ISO-BMFF
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (h.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  if (h.subarray(0, 3).toString() === 'ID3' || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'audio/mpeg';
  if (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (h.subarray(0, 4).toString() === 'PK\u0003\u0004') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}
const compat = (declared: string, actual: string) =>
  declared === actual || (actual === 'video/mp4' && ['video/quicktime', 'audio/mp4', 'video/mp4'].includes(declared)) ||
  (actual === 'video/webm' && ['audio/webm', 'video/webm'].includes(declared)) ||
  (actual === 'audio/mpeg' && declared === 'audio/mpeg');
const TEXTUAL = new Set(['text/plain', 'text/markdown', 'image/svg+xml']);

export async function initUpload(userId: string, purpose: Purpose, mime: string, size: number, isAdmin: boolean) {
  if (purpose === 'branding' && !isAdmin) throw badRequest('Not allowed.');
  if (!ALLOWED[purpose].includes(mime)) throw badRequest('This file type is not supported here.', 'unsupported_type');
  const limits = (await getSetting('limits')).maxFileMb;
  const maxBytes = Math.min(limits[purpose] ?? 25, config_maxMb()) * 1024 * 1024;
  if (size <= 0 || size > maxBytes) throw badRequest(`File is too large (max ${Math.floor(maxBytes / 1048576)} MB).`, 'file_too_large');
  const key = newKey(purpose, MIME_EXT[mime]);
  const f = await one(pool, `INSERT INTO files(owner_id, purpose, storage_key, mime, size_bytes, is_public) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, storage_key`,
    [userId, purpose, key, mime, size, PUBLIC_PURPOSES.has(purpose)]);
  const target = await storage().uploadTarget(key, mime);
  return { fileId: f.id, upload: target };
}
import { config } from '../config.js';
const config_maxMb = () => config.MAX_UPLOAD_MB;

export async function completeUpload(userId: string, fileId: string) {
  const f = await one(pool, 'SELECT * FROM files WHERE id=$1 AND owner_id=$2', [fileId, userId]);
  if (!f) throw badRequest('File not found.', 'not_found');
  if (f.status === 'ready') return f;
  const head = await storage().head(f.storage_key);
  if (!head) throw badRequest('Upload was not received. Please try again.', 'upload_missing');
  if (head.size > f.size_bytes + 0 || head.size === 0) { await fail(f); throw badRequest('Uploaded file size mismatch.', 'size_mismatch'); }
  const buf = await storage().get(f.storage_key);
  if (!TEXTUAL.has(f.mime)) {
    const actual = sniff(buf);
    if (!actual || !compat(f.mime, actual)) { await fail(f); throw badRequest('File contents do not match its type.', 'content_mismatch'); }
  } else if (f.mime === 'image/svg+xml' && /<script|on\w+\s*=|javascript:/i.test(buf.toString('utf8'))) {
    await fail(f); throw badRequest('Unsafe SVG rejected.', 'unsafe_svg');
  }
  let width: number | null = null, height: number | null = null, thumb: string | null = null;
  if (f.mime.startsWith('image/') && f.mime !== 'image/svg+xml') {
    try {
      const img = sharp(buf, { limitInputPixels: 80_000_000 });
      const meta = await img.metadata(); width = meta.width ?? null; height = meta.height ?? null;
      thumb = f.storage_key.replace(/\.[a-z0-9]+$/, '') + '_thumb.webp';
      await storage().put(thumb, await img.rotate().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer(), 'image/webp');
    } catch { await fail(f); throw badRequest('Image could not be processed.', 'bad_image'); }
  }
  const r = await one(pool, `UPDATE files SET status='ready', width=$2, height=$3, thumb_key=$4, size_bytes=$5 WHERE id=$1 RETURNING *`, [fileId, width, height, thumb, head.size]);
  if (f.mime.startsWith('video/')) await enqueueVideoPostProcess(fileId, userId);
  return r;
}
async function fail(f: any) { await pool.query(`UPDATE files SET status='failed' WHERE id=$1`, [f.id]); await storage().delete(f.storage_key).catch(() => {}); }
async function enqueueVideoPostProcess(fileId: string, userId: string) {
  await pool.query(`INSERT INTO jobs(type, user_id, payload) VALUES ('video_postprocess',$1,$2)`, [userId, { fileId }]);
}

/** Store server-produced bytes (AI outputs, edits) as a ready file. */
export async function storeGenerated(userId: string, purpose: Purpose, mime: string, body: Buffer, opts: { isPublic?: boolean } = {}) {
  const key = newKey(purpose, MIME_EXT[mime] ?? 'bin');
  await storage().put(key, body, mime);
  let width: number | null = null, height: number | null = null, thumb: string | null = null;
  if (mime.startsWith('image/')) {
    const img = sharp(body); const m = await img.metadata(); width = m.width ?? null; height = m.height ?? null;
    thumb = key.replace(/\.[a-z0-9]+$/, '') + '_thumb.webp';
    await storage().put(thumb, await img.resize({ width: 480, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer(), 'image/webp');
  }
  const f = await one(pool, `INSERT INTO files(owner_id, purpose, storage_key, thumb_key, mime, size_bytes, width, height, status, is_public)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9) RETURNING *`, [userId, purpose, key, thumb, mime, body.length, width, height, !!opts.isPublic]);
  if (mime.startsWith('video/')) await enqueueVideoPostProcess(f.id, userId);
  return f;
}

export async function fileDto(f: any) {
  if (!f) return null;
  const s = storage();
  return {
    id: f.id, mime: f.mime, width: f.width, height: f.height, durationMs: f.duration_ms, size: f.size_bytes,
    url: await s.readUrl(f.optimized_key ?? f.storage_key, f.is_public),
    originalUrl: f.optimized_key ? await s.readUrl(f.storage_key, f.is_public) : undefined,
    thumbUrl: f.thumb_key ? await s.readUrl(f.thumb_key, f.is_public) : null,
  };
}
export async function fileDtos(ids: (string | null)[]) {
  const clean = [...new Set(ids.filter(Boolean))] as string[];
  if (!clean.length) return new Map<string, any>();
  const rows = await many(pool, `SELECT * FROM files WHERE id = ANY($1) AND status='ready'`, [clean]);
  const out = new Map<string, any>();
  for (const r of rows) out.set(r.id, await fileDto(r));
  return out;
}
