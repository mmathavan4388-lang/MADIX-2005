import { z } from 'zod';
import { pool, tx, one, many } from '../db/pool.js';
import { authorizeAndCharge, costOf, adjustCredits, refundCredits, type Feature } from './credits.js';
import { enqueue } from './jobs.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { fileDtos } from '../lib/files.js';
import { track } from '../lib/audit.js';
import { emit } from './events.js';
import { providersFor, notConfigured } from '../ai/registry.js';
import type { Capability } from '../ai/types.js';
import { notify } from './notify.js';

export const ASPECTS = { '1:1': [1024, 1024], '16:9': [1536, 864], '9:16': [864, 1536], '4:5': [1024, 1280], '4:3': [1280, 960] } as const;
const aspect = z.enum(['1:1', '16:9', '9:16', '4:5', '4:3']);
const fileId = z.string().uuid();

export const imageSchema = z.object({ prompt: z.string().trim().min(3).max(2000), style: z.string().max(60).optional(), aspect: aspect.default('1:1'), variations: z.number().int().min(1).max(4).default(1), sourceFileId: fileId.optional(), strength: z.number().min(0.1).max(1).optional() });
export const videoSchema = z.object({ prompt: z.string().trim().min(3).max(2000), style: z.string().max(60).optional(), aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'), durationSec: z.union([z.literal(5), z.literal(10), z.literal(15)]).default(5), sourceFileId: fileId.optional() });
export const promoSchema = z.object({
  productName: z.string().trim().min(1).max(120), description: z.string().trim().min(5).max(1500), audience: z.string().max(200).default(''), brandName: z.string().max(80).default(''),
  promotionType: z.string().max(60).default('sale'), language: z.string().max(30).default('English'), style: z.string().max(60).default('modern'),
  offer: z.string().max(200).default(''), price: z.string().max(40).default(''), includeVideo: z.boolean().default(false), aspect: aspect.default('1:1'),
});
export const photoEditSchema = z.object({ op: z.enum(['remove_background', 'replace_background', 'remove_object', 'enhance', 'effect']), sourceFileId: fileId, maskFileId: fileId.optional(), prompt: z.string().max(500).optional() });
const Clip = z.object({ fileId, start: z.number().min(0).default(0), end: z.number().positive().optional(), speed: z.number().min(0.25).max(4).default(1), volume: z.number().min(0).max(2).default(1), crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional() });
export const videoEditSchema = z.object({
  clips: z.array(Clip).min(1).max(20),
  format: z.enum(['reel_9_16', 'square_1_1', 'landscape_16_9', 'portrait_4_5']).default('reel_9_16'),
  filter: z.enum(['none', 'warm', 'cool', 'noir', 'vivid', 'fade', 'cinematic']).default('none'),
  transition: z.enum(['none', 'fade']).default('none'),
  texts: z.array(z.object({ text: z.string().max(120), start: z.number().min(0), end: z.number().positive(), x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.8), size: z.number().min(10).max(120).default(48), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF') })).max(20).default([]),
  captions: z.array(z.object({ text: z.string().max(200), start: z.number().min(0), end: z.number().positive() })).max(200).default([]),
  audio: z.object({ fileId, volume: z.number().min(0).max(2).default(0.8), start: z.number().min(0).default(0) }).optional(),
  aiEnhance: z.boolean().default(false),
});

async function ownedFile(c: any, userId: string, id: string, kinds: string[]) {
  const f = await one(c, `SELECT id, mime FROM files WHERE id=$1 AND owner_id=$2 AND status='ready'`, [id, userId]);
  if (!f || !kinds.some((k) => f.mime.startsWith(k))) throw badRequest('One of the selected files is not available.', 'bad_file');
  return f;
}

const NEEDS: Record<string, Capability[]> = { image: ['image'], video: ['video'], promo: ['text', 'image'], photo_edit: ['image_edit'], video_edit: [] };

interface Spec { feature: Feature; kind: 'image' | 'video' | 'promo' | 'photo_edit' | 'video_edit'; prompt: string; params: any; costKey: string; multiplier?: number; extra?: { key: string; times: number }[]; }

async function create(userId: string, s: Spec) {
  // Fail fast (before charging) when no provider is configured for what this job needs.
  const needs = [...NEEDS[s.kind], ...(s.kind === 'promo' && (s.params as any).includeVideo ? (['video'] as Capability[]) : [])];
  for (const cap of needs) if (!(await providersFor(cap)).length) throw notConfigured();
  const genId = (await one(pool, 'SELECT gen_random_uuid() id')).id as string;
  const out = await tx(async (c) => {
    const ch = await authorizeAndCharge(c, userId, s.feature, s.costKey, { type: 'generation', id: genId }, { multiplier: s.multiplier });
    let extraTotal = 0;
    for (const e of s.extra ?? []) { const amt = (await costOf(e.key)) * e.times; if (amt > 0) { await adjustCredits(c, userId, -amt, `spend:${e.key}`, { type: 'generation', id: genId }); extraTotal += amt; } }
    const total = ch.cost + extraTotal;
    const jobId = await enqueue(c, s.kind, userId, { generationId: genId });
    await c.query(`INSERT INTO generations(id, user_id, job_id, kind, prompt, params, credits_charged, trial_counted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [genId, userId, jobId, s.kind, s.prompt, s.params, total, ch.trialCounted]);
    return { balance: ch.balance - extraTotal, total };
  });
  void track(userId, `generate_${s.kind}`);
  return { id: genId, status: 'queued', creditsCharged: out.total, balance: out.balance };
}

export async function requestImage(userId: string, p: z.infer<typeof imageSchema>) {
  if (p.sourceFileId) await ownedFile(pool, userId, p.sourceFileId, ['image/']);
  return create(userId, { feature: 'image', kind: 'image', prompt: p.prompt, params: p, costKey: 'image', extra: p.variations > 1 ? [{ key: 'image_variation', times: p.variations - 1 }] : [] });
}
export async function requestVideo(userId: string, p: z.infer<typeof videoSchema>) {
  if (p.sourceFileId) await ownedFile(pool, userId, p.sourceFileId, ['image/']);
  const extra = Math.ceil((p.durationSec - 5) / 5);
  return create(userId, { feature: 'video', kind: 'video', prompt: p.prompt, params: p, costKey: 'video_5s', extra: extra > 0 ? [{ key: 'video_per_extra_5s', times: extra }] : [] });
}
export async function requestPromo(userId: string, p: z.infer<typeof promoSchema>) {
  const extra = [{ key: 'promo_image', times: 1 }, ...(p.includeVideo ? [{ key: 'promo_video', times: 1 }] : [])];
  return create(userId, { feature: 'promo', kind: 'promo', prompt: `${p.productName}: ${p.description}`.slice(0, 500), params: p, costKey: 'promo_copy', extra });
}
export async function requestPhotoEdit(userId: string, p: z.infer<typeof photoEditSchema>) {
  await ownedFile(pool, userId, p.sourceFileId, ['image/']);
  if (p.maskFileId) await ownedFile(pool, userId, p.maskFileId, ['image/']);
  if (p.op === 'remove_object' && !p.maskFileId) throw badRequest('Paint over the object you want to remove first.', 'mask_required');
  return create(userId, { feature: 'edit', kind: 'photo_edit', prompt: p.prompt ?? p.op, params: p, costKey: 'photo_edit_ai' });
}
export async function requestVideoEdit(userId: string, p: z.infer<typeof videoEditSchema>) {
  for (const c of p.clips) await ownedFile(pool, userId, c.fileId, ['video/']);
  if (p.audio) await ownedFile(pool, userId, p.audio.fileId, ['audio/', 'video/']);
  return create(userId, { feature: 'edit', kind: 'video_edit', prompt: `Video edit (${p.clips.length} clips)`, params: p, costKey: 'video_edit_basic', extra: p.aiEnhance ? [{ key: 'video_edit_ai', times: 1 }] : [] });
}

export async function getGeneration(userId: string, id: string) {
  const g = await one(pool, `SELECT g.*, j.progress, j.attempts, (SELECT count(*)::int FROM jobs q WHERE q.status='queued' AND q.type=j.type AND q.created_at < j.created_at) AS ahead
    FROM generations g LEFT JOIN jobs j ON j.id=g.job_id WHERE g.id=$1 AND g.user_id=$2`, [id, userId]);
  if (!g) throw notFound('Creation not found.');
  return (await dto([g]))[0];
}
export async function listGenerations(userId: string, kind: string | undefined, cursor: string | undefined) {
  const rows = await many(pool, `SELECT g.*, j.progress, 0 AS ahead FROM generations g LEFT JOIN jobs j ON j.id=g.job_id
    WHERE g.user_id=$1 AND ($2::text IS NULL OR g.kind=$2) AND ($3::timestamptz IS NULL OR g.created_at < $3) ORDER BY g.created_at DESC LIMIT 24`, [userId, kind ?? null, cursor ?? null]);
  return { items: await dto(rows), next: rows.length === 24 ? rows[23].created_at : null };
}
async function dto(rows: any[]) {
  const files = await fileDtos(rows.flatMap((r) => r.result_file_ids));
  return rows.map((g) => ({
    id: g.id, kind: g.kind, prompt: g.prompt, params: g.params, status: g.status, progress: g.status === 'completed' ? 100 : g.progress ?? 0,
    queuePosition: g.status === 'queued' ? (g.ahead ?? 0) + 1 : null, creditsCharged: g.credits_charged,
    error: g.error, meta: g.result_meta, files: g.result_file_ids.map((f: string) => files.get(f)).filter(Boolean), createdAt: g.created_at, completedAt: g.completed_at,
  }));
}

export async function cancelGeneration(userId: string, id: string) {
  const r = await tx(async (c) => {
    const g = await one(c, `SELECT g.id, g.job_id, g.status, g.credits_charged FROM generations g WHERE g.id=$1 AND g.user_id=$2 FOR UPDATE`, [id, userId]);
    if (!g) throw notFound('Creation not found.');
    if (!['queued', 'processing'].includes(g.status)) throw new AppError(409, 'not_cancellable', 'This creation can no longer be cancelled.');
    // queued jobs cancel immediately; processing jobs are flagged and stopped by the worker at its next checkpoint
    const j = await one(c, `UPDATE jobs SET cancel_requested=true, status = CASE WHEN status='queued' THEN 'cancelled' ELSE status END, finished_at = CASE WHEN status='queued' THEN now() ELSE finished_at END WHERE id=$1 RETURNING status`, [g.job_id]);
    if (j.status === 'cancelled') {
      await c.query(`UPDATE generations SET status='cancelled', completed_at=now() WHERE id=$1`, [id]);
      await adjustCredits(c, userId, g.credits_charged, 'refund:cancelled', { type: 'generation', id }, `refund:generation:${id}`);
      return 'cancelled';
    }
    return 'cancelling';
  });
  void emit([userId], 'generation', { id });
  return { status: r };
}
export async function deleteGeneration(userId: string, id: string) {
  const g = await one(pool, `SELECT status, result_file_ids FROM generations WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!g) throw notFound('Creation not found.');
  if (['queued', 'processing'].includes(g.status)) throw new AppError(409, 'in_progress', 'Cancel this creation before deleting it.');
  await pool.query(`UPDATE files SET status='deleted' WHERE id = ANY($1) AND owner_id=$2 AND id NOT IN (SELECT file_id FROM posts WHERE file_id IS NOT NULL)`, [g.result_file_ids, userId]);
  await pool.query('DELETE FROM generations WHERE id=$1', [id]);
}

/** Called by the worker when a generation reaches a terminal state. Refunds on failure; notifies the user. */
export async function finishGeneration(id: string, outcome: { status: 'completed' | 'failed' | 'cancelled'; files?: string[]; meta?: any; error?: string }) {
  const g = await tx(async (c) => {
    const cur = await one(c, `SELECT * FROM generations WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur || ['completed', 'failed', 'cancelled'].includes(cur.status)) return null;
    await c.query(`UPDATE generations SET status=$2, result_file_ids=$3, result_meta=$4, error=$5, completed_at=now() WHERE id=$1`, [id, outcome.status, outcome.files ?? [], outcome.meta ?? null, outcome.error ?? null]);
    await c.query(`UPDATE jobs SET status=$2, error=$3, finished_at=now(), progress=CASE WHEN $2='completed' THEN 100 ELSE progress END WHERE id=$1`, [cur.job_id, outcome.status, outcome.error ?? null]);
    if (outcome.status !== 'completed') await adjustCredits(c, cur.user_id, cur.credits_charged, `refund:${outcome.status}`, { type: 'generation', id }, `refund:generation:${id}`);
    return cur;
  });
  if (!g) return;
  void emit([g.user_id], 'generation', { id, status: outcome.status });
  if (outcome.status === 'completed') await notify(g.user_id, 'ai_complete', 'Your creation is ready ✨', g.prompt.slice(0, 80), { generationId: id, kind: g.kind });
  else if (outcome.status === 'failed') await notify(g.user_id, 'ai_complete', 'Generation failed — credits refunded', 'Something went wrong creating this. Your credits were returned.', { generationId: id, kind: g.kind });
}
