import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { buildApp } from '../src/app.js';
import { sentMail } from '../src/lib/mail.js';
import { registerAdapter, clearProviderCache } from '../src/ai/registry.js';
import { clearSettingsCache } from '../src/lib/settings.js';
import { claim } from '../src/services/jobs.js';
import { processJob } from '../src/worker.js';
import { hashPassword, newTotpSecret, encrypt, totpAt } from '../src/lib/crypto.js';
import { ProviderError } from '../src/ai/types.js';

export const quiet = () => {};

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(quiet);
  await seed(quiet);
  clearSettingsCache(); clearProviderCache();
  fs.rmSync('/tmp/madix-test-uploads', { recursive: true, force: true });
  sentMail.length = 0;
}
export const makeApp = () => buildApp();

// ───── Test AI adapter (registered only inside the test process) ─────
export const ai = { failText: false, failImage: false, textReply: ['Hello', ' from', ' MADIX'], videoPolls: 1, videoFail: false, calls: { image: 0, video: 0 } };
const PNG = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#8B5CF6' } }).png().toBuffer();
export function installTestProviders() {
  registerAdapter('test', (row) => {
    const impl: any = {
      async *stream(req: any) {
        if (ai.failText) throw new ProviderError('boom', false);
        const raw = JSON.stringify({ headline: 'Fresh Brew', subline: 'Wake up to flavour', adCopy: 'Great coffee.', caption: 'Coffee time', hashtags: ['coffee', '#morning'], videoConcept: 'A cup steams.', imagePrompt: 'coffee cup', videoPrompt: 'steaming coffee' });
        if (/advertising copywriter/.test(req.messages.at(-1).content)) { yield raw; return; }
        for (const t of ai.textReply) { await new Promise((r) => setTimeout(r, 2)); yield t; }
      },
      async generate({ n }: any) { ai.calls.image++; if (ai.failImage) throw new ProviderError('image boom', false); return Promise.all(Array.from({ length: n }, async () => ({ mime: 'image/png', bytes: await PNG() }))); },
      async edit() { return { mime: 'image/png', bytes: await PNG() }; },
      async submit() { ai.calls.video++; return { externalId: 'vid_' + ai.calls.video }; },
      async poll() {
        if (ai.videoFail) return { state: 'failed', error: 'nope' };
        if (ai.videoPolls-- > 0) return { state: 'processing', progress: 30 };
        return { state: 'completed', videoUrl: 'http://test.local/video.mp4' };
      },
    };
    return impl;
  });
}
export async function addProvider(capability: string, name = `t-${capability}`) {
  await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model) VALUES ($1,$2,'test','test-model') ON CONFLICT DO NOTHING`, [capability, name]);
  clearProviderCache();
}
export async function addAllProviders() { for (const c of ['text', 'image', 'image_edit', 'video']) await addProvider(c); }

// ───── User helpers ─────
let n = 0;
export async function signup(app: FastifyInstance, opts: { verify?: boolean; ref?: string; deviceId?: string; ip?: string } = {}) {
  const i = ++n; const email = `user${i}_${Date.now() % 100000}@example.com`; const username = `user_${i}_${Date.now() % 100000}`;
  const password = 'Str0ngPassw0rd!';
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', remoteAddress: opts.ip ?? `10.0.${i % 250}.${(i * 7) % 250}`, payload: { email, username, password, referralCode: opts.ref, deviceId: opts.deviceId } });
  if (res.statusCode !== 201) throw new Error('register failed ' + res.body);
  if (opts.verify !== false) await verifyLast(app, email);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: email, password } });
  const j = login.json();
  return { email, username, password, id: res.json().user.id as string, token: j.accessToken as string, refresh: j.refreshToken as string, auth: { authorization: `Bearer ${j.accessToken}` } };
}
export async function verifyLast(app: FastifyInstance, email: string) {
  const mail = [...sentMail].reverse().find((m) => m.to === email && /verify-email\?token=/.test(m.text))!;
  const token = /token=([\w-]+)/.exec(mail.text)![1];
  return app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } });
}
export async function makeAdmin(app: FastifyInstance) {
  const secret = newTotpSecret();
  const password = 'Adm1n-Super-Strong-Pass!';
  const r = await pool.query(`INSERT INTO users(email, username, password_hash, role, email_verified_at, totp_secret, totp_enabled) VALUES ('owner@sayrix.test','sayrix_owner',$1,'admin',now(),$2,true) RETURNING id`, [await hashPassword(password), encrypt(secret)]);
  await pool.query('INSERT INTO profiles(user_id, display_name) VALUES ($1,$2)', [r.rows[0].id, 'Owner']);
  const login = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: 'owner@sayrix.test', password, totp: totpAt(secret, Date.now()) } });
  if (login.statusCode !== 200) throw new Error('admin login failed ' + login.body);
  return { id: r.rows[0].id as string, secret, password, auth: { authorization: `Bearer ${login.json().accessToken}` } };
}
export const bal = async (id: string) => (await pool.query('SELECT balance FROM credit_wallets WHERE user_id=$1', [id])).rows[0].balance as number;

/** Run the worker loop until the queue is idle (pulls run_at forward so polling steps run immediately). */
export async function drain(max = 50) {
  for (let i = 0; i < max; i++) {
    await pool.query(`UPDATE jobs SET run_at=now() WHERE status='queued'`);
    const job = await claim();
    if (!job) return;
    await processJob(job);
  }
}

export async function uploadFile(app: FastifyInstance, auth: any, purpose: string, mime: string, body: Buffer) {
  const init = await app.inject({ method: 'POST', url: '/api/v1/files/init', headers: auth, payload: { purpose, mime, size: body.length } });
  if (init.statusCode !== 200) throw new Error('init failed ' + init.body);
  const { fileId, upload } = init.json();
  const u = new URL(upload.url);
  const put = await app.inject({ method: 'PUT', url: u.pathname + u.search, headers: { 'content-type': mime }, payload: body });
  if (put.statusCode !== 200) throw new Error('put failed ' + put.body);
  const done = await app.inject({ method: 'POST', url: `/api/v1/files/${fileId}/complete`, headers: auth });
  return { fileId: fileId as string, res: done };
}
export const pngBuf = () => PNG();
export function makeVideo(seconds = 2, withAudio = true): Buffer {
  const out = path.join(os.tmpdir(), `madix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(withAudio ? ['-c:a', 'aac'] : []), '-shortest', out);
  execFileSync('ffmpeg', args);
  const b = fs.readFileSync(out); fs.rmSync(out); return b;
}
export async function grantPaid(userId: string, features = ['chat', 'image', 'video', 'promo', 'edit'], credits = 500) {
  const plan = (await pool.query(`INSERT INTO plans(code,name,kind,interval,price_minor,credits,features) VALUES ($1,'T','subscription','month',100,0,$2) RETURNING id`, ['t_' + Math.random().toString(36).slice(2), features])).rows[0];
  await pool.query(`INSERT INTO subscriptions(user_id, plan_id, current_period_end) VALUES ($1,$2, now() + interval '30 days')`, [userId, plan.id]);
  await pool.query(`UPDATE credit_wallets SET balance=balance+$2 WHERE user_id=$1`, [userId, credits]);
}
