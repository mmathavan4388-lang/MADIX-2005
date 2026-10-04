import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { pool, one } from '../db/pool.js';
import { providersFor, withFailover, notConfigured } from '../ai/registry.js';
import type { ImageProvider, ImageEditProvider, VideoProvider, TextProvider } from '../ai/types.js';
import { ProviderError } from '../ai/types.js';
import { storeGenerated } from '../lib/files.js';
import { storage } from '../storage/index.js';
import { finishGeneration, ASPECTS } from '../services/generate.js';
import { requeue, type ClaimedJob } from '../services/jobs.js';
import { buildFfmpegArgs, probe, run } from './ffmpeg.js';

export class Cancelled extends Error {}
const VIDEO_TIMEOUT_MS = 30 * 60_000;

async function gen(id: string) { return one(pool, 'SELECT * FROM generations WHERE id=$1', [id]); }
async function assertNotCancelled(job: ClaimedJob) {
  const j = await one(pool, 'SELECT cancel_requested FROM jobs WHERE id=$1', [job.id]);
  if (j?.cancel_requested) throw new Cancelled();
}
async function setProgress(jobId: string, p: number) { await pool.query('UPDATE jobs SET progress=$2 WHERE id=$1', [jobId, p]); }
async function loadFile(userId: string, id: string) {
  const f = await one(pool, `SELECT * FROM files WHERE id=$1 AND owner_id=$2 AND status='ready'`, [id, userId]);
  if (!f) throw new Error('source file missing');
  return { mime: f.mime as string, bytes: await storage().get(f.storage_key), row: f };
}
async function download(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new ProviderError(`download failed ${r.status}`, true);
  return { bytes: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' };
}

// ───────── image ─────────
export async function handleImage(job: ClaimedJob) {
  const g = await gen(job.payload.generationId); const p = g.params;
  await pool.query(`UPDATE generations SET status='processing' WHERE id=$1`, [g.id]);
  const [w, h] = ASPECTS[p.aspect as keyof typeof ASPECTS];
  const src = p.sourceFileId ? await loadFile(g.user_id, p.sourceFileId) : undefined;
  await setProgress(job.id, 10);
  const imgs = await withFailover<ImageProvider, { mime: string; bytes: Buffer }[]>('image', (impl) =>
    impl.generate({ prompt: g.prompt, width: w, height: h, n: p.variations, style: p.style, sourceImage: src && { mime: src.mime, bytes: src.bytes }, strength: p.strength }));
  await assertNotCancelled(job);
  const ids: string[] = [];
  for (const im of imgs) ids.push((await storeGenerated(g.user_id, 'ai_image', im.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', im.bytes)).id);
  await finishGeneration(g.id, { status: 'completed', files: ids });
}

// ───────── video (submit → poll, never blocks a worker slot) ─────────
export async function handleVideo(job: ClaimedJob) {
  const g = await gen(job.payload.generationId); const p = g.params;
  if (!job.external_id) {
    await pool.query(`UPDATE generations SET status='processing' WHERE id=$1`, [g.id]);
    const src = p.sourceFileId ? await loadFile(g.user_id, p.sourceFileId) : undefined;
    const { externalId } = await withFailover<VideoProvider, { externalId: string }>('video', async (impl, row) => {
      const r = await impl.submit({ prompt: g.prompt, durationSec: p.durationSec, aspect: p.aspect, style: p.style, image: src && { mime: src.mime, bytes: src.bytes } });
      return { externalId: `${row.id}:${r.externalId}` };
    });
    await requeue(job.id, 8, { progress: 5, externalId });
    return 'requeued';
  }
  await assertNotCancelled(job);
  if (Date.now() - new Date(g.created_at).getTime() > VIDEO_TIMEOUT_MS) throw new ProviderError('video generation timed out', false);
  const [providerId, extId] = [job.external_id.slice(0, job.external_id.indexOf(':')), job.external_id.slice(job.external_id.indexOf(':') + 1)];
  const list = await providersFor<VideoProvider>('video');
  const impl = list.find((x) => x.row.id === providerId)?.impl;
  if (!impl) throw new ProviderError('video provider no longer configured', false);
  const st = await impl.poll(extId);
  if (st.state === 'processing') { await requeue(job.id, 10, { progress: st.progress ?? Math.min(95, (job.payload.polls ?? 0) * 3 + 10), payload: { ...job.payload, polls: (job.payload.polls ?? 0) + 1 } }); return 'requeued'; }
  if (st.state === 'failed') throw new ProviderError(st.error ?? 'provider failed', false);
  const vid = await download(st.videoUrl!);
  const f = await storeGenerated(g.user_id, 'ai_video', vid.mime === 'video/webm' ? 'video/webm' : 'video/mp4', vid.bytes);
  await finishGeneration(g.id, { status: 'completed', files: [f.id] });
}

// ───────── promo (copy + poster + optional video) ─────────
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);
function wrap(text: string, max: number) { const out: string[] = []; let line = ''; for (const w of text.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } if (line) out.push(line); return out.slice(0, 3); }

async function composePoster(base: Buffer, copy: { headline: string; subline: string; offer: string; price: string; brand: string }) {
  const meta = await sharp(base).metadata(); const W = meta.width!, H = meta.height!;
  const hl = wrap(copy.headline, Math.max(12, Math.floor(W / 38)));
  const fs1 = Math.round(W / 14);
  const lines = hl.map((l, i) => `<text x="${W * 0.06}" y="${H * 0.72 + i * fs1 * 1.15}" font-size="${fs1}" font-weight="800" fill="#fff" font-family="sans-serif">${esc(l)}</text>`).join('');
  const tag = [copy.offer, copy.price].filter(Boolean).join('  ·  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#050507" stop-opacity="0"/><stop offset="1" stop-color="#050507" stop-opacity="0.92"/></linearGradient>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${lines}
    ${tag ? `<rect x="${W * 0.06}" y="${H * 0.72 + hl.length * fs1 * 1.15 - fs1 * 0.2}" rx="${fs1 * 0.4}" height="${fs1 * 0.95}" width="${Math.min(W * 0.88, tag.length * fs1 * 0.52 + fs1)}" fill="url(#b)"/><text x="${W * 0.06 + fs1 * 0.5}" y="${H * 0.72 + hl.length * fs1 * 1.15 + fs1 * 0.5}" font-size="${fs1 * 0.55}" font-weight="700" fill="#050507" font-family="sans-serif">${esc(tag)}</text>` : ''}
    ${copy.brand ? `<text x="${W * 0.06}" y="${H * 0.06 + fs1 * 0.4}" font-size="${fs1 * 0.5}" font-weight="700" fill="#fff" font-family="sans-serif" opacity="0.95">${esc(copy.brand)}</text>` : ''}
  </svg>`;
  return sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

async function collect(stream: AsyncIterable<string>) { let s = ''; for await (const t of stream) s += t; return s; }

export async function handlePromo(job: ClaimedJob) {
  const g = await gen(job.payload.generationId); const p = g.params;
  if (!job.external_id) {
    await pool.query(`UPDATE generations SET status='processing' WHERE id=$1`, [g.id]);
    const ask = `You are an expert advertising copywriter. Create a promotion for:
Product: ${p.productName}\nDescription: ${p.description}\nAudience: ${p.audience}\nBrand: ${p.brandName}\nPromotion type: ${p.promotionType}\nOffer: ${p.offer}\nPrice: ${p.price}\nLanguage: ${p.language}\nStyle: ${p.style}
Return ONLY minified JSON with keys: headline (<=8 words), subline (<=14 words), adCopy (60-90 words), caption (<=220 chars), hashtags (array of 6-10 strings without #), videoConcept (2-3 sentences, scene by scene), imagePrompt (detailed visual prompt for a text-free promotional product image), videoPrompt (one paragraph prompt for a 5-10s ad video). All text in ${p.language}, except imagePrompt/videoPrompt in English.`;
    const raw = await withFailover<TextProvider, string>('text', (impl) => collect(impl.stream({ messages: [{ role: 'user', content: ask }], maxTokens: 1200, temperature: 0.8 })));
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    await setProgress(job.id, 30); await assertNotCancelled(job);
    const [w, h] = ASPECTS[p.aspect as keyof typeof ASPECTS];
    const imgs = await withFailover<ImageProvider, { mime: string; bytes: Buffer }[]>('image', (impl) => impl.generate({ prompt: `${json.imagePrompt}. No text, no letters, no watermarks. Space at the bottom for text overlay.`, width: w, height: h, n: 1, style: p.style }));
    const raw1 = await storeGenerated(g.user_id, 'ai_image', 'image/png', imgs[0].bytes);
    const poster = await storeGenerated(g.user_id, 'ai_image', 'image/png', await composePoster(imgs[0].bytes, { headline: json.headline, subline: json.subline, offer: p.offer, price: p.price, brand: p.brandName }));
    const meta = { headline: json.headline, subline: json.subline, adCopy: json.adCopy, caption: json.caption, hashtags: (json.hashtags as string[]).map((t) => t.replace(/^#/, '')), videoConcept: json.videoConcept, posterFileId: poster.id, imageFileId: raw1.id };
    await pool.query(`UPDATE generations SET result_file_ids=$2, result_meta=$3 WHERE id=$1`, [g.id, [poster.id, raw1.id], meta]);
    if (!p.includeVideo) { await finishGeneration(g.id, { status: 'completed', files: [poster.id, raw1.id], meta }); return; }
    const { externalId } = await withFailover<VideoProvider, { externalId: string }>('video', async (impl, row) => {
      const r = await impl.submit({ prompt: json.videoPrompt, durationSec: 5, aspect: p.aspect === '9:16' ? '9:16' : p.aspect === '1:1' ? '1:1' : '16:9', style: p.style });
      return { externalId: `${row.id}:${r.externalId}` };
    });
    await requeue(job.id, 8, { progress: 60, externalId }); return 'requeued';
  }
  await assertNotCancelled(job);
  const cur = await gen(g.id);
  if (Date.now() - new Date(g.created_at).getTime() > VIDEO_TIMEOUT_MS) {
    // Deliver what we have (poster + copy) rather than failing the whole promo; credits for video are not refunded partially in v1.
    await finishGeneration(g.id, { status: 'completed', files: cur.result_file_ids, meta: { ...cur.result_meta, videoError: 'timeout' } }); return;
  }
  const [providerId, extId] = [job.external_id!.slice(0, job.external_id!.indexOf(':')), job.external_id!.slice(job.external_id!.indexOf(':') + 1)];
  const impl = (await providersFor<VideoProvider>('video')).find((x) => x.row.id === providerId)?.impl;
  if (!impl) throw new ProviderError('video provider no longer configured', false);
  const st = await impl.poll(extId);
  if (st.state === 'processing') { await requeue(job.id, 10, { progress: Math.min(95, 60 + (st.progress ?? 0) * 0.3) }); return 'requeued'; }
  if (st.state === 'failed') { await finishGeneration(g.id, { status: 'completed', files: cur.result_file_ids, meta: { ...cur.result_meta, videoError: 'failed' } }); return; }
  const vid = await download(st.videoUrl!);
  const f = await storeGenerated(g.user_id, 'ai_video', 'video/mp4', vid.bytes);
  await finishGeneration(g.id, { status: 'completed', files: [...cur.result_file_ids, f.id], meta: { ...cur.result_meta, videoFileId: f.id } });
}

// ───────── photo edit (AI ops) ─────────
export async function handlePhotoEdit(job: ClaimedJob) {
  const g = await gen(job.payload.generationId); const p = g.params;
  await pool.query(`UPDATE generations SET status='processing' WHERE id=$1`, [g.id]);
  const src = await loadFile(g.user_id, p.sourceFileId);
  const mask = p.maskFileId ? (await loadFile(g.user_id, p.maskFileId)).bytes : undefined;
  const out = await withFailover<ImageEditProvider, { mime: string; bytes: Buffer }>('image_edit', (impl) => impl.edit({ op: p.op, image: { mime: src.mime, bytes: src.bytes }, mask, prompt: p.prompt }));
  await assertNotCancelled(job);
  const f = await storeGenerated(g.user_id, 'edit_output', out.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', out.bytes);
  await finishGeneration(g.id, { status: 'completed', files: [f.id] });
}

// ───────── video edit (ffmpeg) ─────────
export async function handleVideoEdit(job: ClaimedJob) {
  const g = await gen(job.payload.generationId); const edl = g.params;
  await pool.query(`UPDATE generations SET status='processing' WHERE id=$1`, [g.id]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madix-edit-'));
  try {
    const inputs: { path: string; probe: Awaited<ReturnType<typeof probe>> }[] = [];
    for (let i = 0; i < edl.clips.length; i++) {
      const f = await loadFile(g.user_id, edl.clips[i].fileId);
      const pth = path.join(dir, `in${i}.${f.row.storage_key.split('.').pop()}`); fs.writeFileSync(pth, f.bytes);
      inputs.push({ path: pth, probe: await probe(pth) });
    }
    let audio: { path: string } | null = null;
    if (edl.audio) { const a = await loadFile(g.user_id, edl.audio.fileId); const pth = path.join(dir, `music.${a.row.storage_key.split('.').pop()}`); fs.writeFileSync(pth, a.bytes); audio = { path: pth }; }
    const out = path.join(dir, 'out.mp4');
    const { args, totalSec } = buildFfmpegArgs(edl, inputs, audio, out);
    await setProgress(job.id, 15);
    let last = 0;
    await run('ffmpeg', [...args.slice(0, -1), '-progress', 'pipe:2', out], {
      timeoutMs: 20 * 60_000,
      onStderr: (l) => { const m = /out_time_ms=(\d+)/.exec(l); if (m) { const pct = Math.min(95, 15 + Math.round((Number(m[1]) / 1e6 / totalSec) * 80)); if (pct - last >= 5) { last = pct; void setProgress(job.id, pct); } } },
    });
    await assertNotCancelled(job);
    const f = await storeGenerated(g.user_id, 'edit_output', 'video/mp4', fs.readFileSync(out));
    await finishGeneration(g.id, { status: 'completed', files: [f.id] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ───────── video post-processing: thumbnail, probe, 720p faststart rendition ─────────
export async function handleVideoPostprocess(job: ClaimedJob) {
  const f = await one(pool, `SELECT * FROM files WHERE id=$1 AND status='ready'`, [job.payload.fileId]);
  if (!f) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madix-pp-'));
  try {
    const src = path.join(dir, 'src'); fs.writeFileSync(src, await storage().get(f.storage_key));
    const info = await probe(src);
    const base = f.storage_key.replace(/\.[a-z0-9]+$/, '');
    const thumb = path.join(dir, 'thumb.jpg');
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.min(1, info.duration / 2)), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb]);
    await storage().put(`${base}_thumb.jpg`, fs.readFileSync(thumb), 'image/jpeg');
    let optimizedKey: string | null = null;
    if (info.width > 0 && f.mime.startsWith('video/')) {
      const opt = path.join(dir, 'opt.mp4');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', opt], { timeoutMs: 15 * 60_000 });
      optimizedKey = `${base}_720.mp4`;
      await storage().put(optimizedKey, fs.readFileSync(opt), 'video/mp4');
    }
    await pool.query(`UPDATE files SET duration_ms=$2, width=$3, height=$4, thumb_key=$5, optimized_key=$6 WHERE id=$1`, [f.id, Math.round(info.duration * 1000), info.width, info.height, `${base}_thumb.jpg`, optimizedKey]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const handlers: Record<string, (job: ClaimedJob) => Promise<string | void>> = {
  image: handleImage, video: handleVideo, promo: handlePromo, photo_edit: handlePhotoEdit, video_edit: handleVideoEdit, video_postprocess: handleVideoPostprocess,
};
void notConfigured;
