import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, installTestProviders, addAllProviders, ai, bal, drain, grantPaid, makeVideo, uploadFile, pngBuf } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { clearSettingsCache } from '../src/lib/settings.js';

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); installTestProviders(); await addAllProviders(); app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { Object.assign(ai, { failText: false, failImage: false, videoPolls: 1, videoFail: false }); await pool.query('DELETE FROM jobs'); });

const post = (u: any, url: string, payload: any = {}) => app.inject({ method: 'POST', url: '/api/v1' + url, headers: u.auth, payload });
const get = (u: any, url: string) => app.inject({ method: 'GET', url: '/api/v1' + url, headers: u.auth });
const parseSse = (body: string) => body.split('\n\n').filter(Boolean).map((b) => ({ event: /event: (\w+)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)![1]) }));

describe('AI chat', () => {
  it('streams a markdown reply, stores history, charges credits, supports rename/search/regenerate/delete', async () => {
    const u = await signup(app);
    const conv = (await post(u, '/ai/conversations')).json();
    const res = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'Explain recursion' });
    expect(res.statusCode).toBe(200);
    const ev = parseSse(res.body);
    expect(ev.filter((e) => e.event === 'token').map((e) => e.data.t).join('')).toBe('Hello from MADIX');
    expect(ev.at(-1)!.event).toBe('done');
    expect(await bal(u.id)).toBe(59);
    const msgs = (await get(u, `/ai/conversations/${conv.id}/messages`)).json().items;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect((await get(u, '/ai/conversations')).json().items[0].title).toBe('Explain recursion');
    expect((await get(u, '/ai/conversations?q=recursion')).json().items).toHaveLength(1);
    expect((await get(u, '/ai/conversations?q=zzzznomatch')).json().items).toHaveLength(0);
    ai.textReply = ['Second', ' answer'];
    const re = await post(u, `/ai/conversations/${conv.id}/regenerate`);
    expect(parseSse(re.body).filter((e) => e.event === 'token').map((e) => e.data.t).join('')).toBe('Second answer');
    const after = (await get(u, `/ai/conversations/${conv.id}/messages`)).json().items;
    expect(after).toHaveLength(2); expect(after[1].content).toBe('Second answer');
    const rn = await app.inject({ method: 'PATCH', url: `/api/v1/ai/conversations/${conv.id}`, headers: u.auth, payload: { title: 'Renamed' } });
    expect(rn.json().title).toBe('Renamed');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/ai/conversations/${conv.id}`, headers: u.auth })).statusCode).toBe(200);
    expect((await get(u, `/ai/conversations/${conv.id}/messages`)).statusCode).toBe(404);
    ai.textReply = ['Hello', ' from', ' MADIX'];
  });
  it("isolates users: you cannot read or write someone else's conversation", async () => {
    const a = await signup(app), b = await signup(app);
    const conv = (await post(a, '/ai/conversations')).json();
    expect((await get(b, `/ai/conversations/${conv.id}/messages`)).statusCode).toBe(404);
    expect((await post(b, `/ai/conversations/${conv.id}/messages`, { content: 'hi' })).statusCode).toBe(404);
  });
  it('refunds the charge and shows a friendly error when the provider fails; no raw errors leak', async () => {
    const u = await signup(app);
    const conv = (await post(u, '/ai/conversations')).json();
    ai.failText = true;
    const res = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'hello' });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/boom/);
    expect(await bal(u.id)).toBe(60);
  });
  it('blocks chat when not entitled (trial expired, no plan) and when credits are insufficient', async () => {
    const u = await signup(app);
    const conv = (await post(u, '/ai/conversations')).json();
    await pool.query('UPDATE credit_wallets SET balance=0 WHERE user_id=$1', [u.id]);
    const poor = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'hi' });
    expect(poor.statusCode).toBe(402); expect(poor.json().error.code).toBe('insufficient_credits'); expect(poor.json().error.action).toBe('buy_credits');
    await pool.query('UPDATE credit_wallets SET balance=50 WHERE user_id=$1', [u.id]);
    await pool.query(`UPDATE trials SET ends_at=now()-interval '1 hour' WHERE user_id=$1`, [u.id]);
    const locked = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'hi' });
    expect(locked.statusCode).toBe(402); expect(locked.json().error.code).toBe('feature_locked'); expect(locked.json().error.action).toBe('upgrade');
    expect(await bal(u.id)).toBe(50);
  });
  it('enforces the admin-configured trial limit per feature', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE trials SET limits = limits || '{"chat":2}'::jsonb WHERE user_id=$1`, [u.id]);
    const conv = (await post(u, '/ai/conversations')).json();
    expect((await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'one' })).statusCode).toBe(200);
    expect((await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'two' })).statusCode).toBe(200);
    const third = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'three' });
    expect(third.statusCode).toBe(402); expect(third.json().error.reason).toBe('trial_limit_reached');
  });
  it('analyses an uploaded text document', async () => {
    const u = await signup(app);
    const conv = (await post(u, '/ai/conversations')).json();
    const up = await uploadFile(app, u.auth, 'document', 'text/plain', Buffer.from('Quarterly revenue grew 12%.'));
    expect(up.res.statusCode).toBe(200);
    const res = await post(u, `/ai/conversations/${conv.id}/messages`, { content: 'Summarise', fileId: up.fileId });
    expect(res.statusCode).toBe(200);
    expect(await bal(u.id)).toBe(60 - 1 - 3);
  });
});

describe('AI image generation (async job)', () => {
  it('queues, generates through the worker, stores in cloud storage, charges once', async () => {
    const u = await signup(app);
    const r = await post(u, '/generations/image', { prompt: 'a neon city at night', aspect: '16:9', variations: 2 });
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('queued');
    expect(r.json().creditsCharged).toBe(5 + 4);
    expect(await bal(u.id)).toBe(60 - 9);
    expect((await get(u, `/generations/${r.json().id}`)).json().status).toBe('queued');
    await drain();
    const g = (await get(u, `/generations/${r.json().id}`)).json();
    expect(g.status).toBe('completed'); expect(g.files).toHaveLength(2);
    expect(g.files[0].url).toMatch(/\/media\/ai_image\//);
    const dl = await app.inject({ method: 'GET', url: g.files[0].url.replace('http://localhost:4000', '') });
    expect(dl.statusCode).toBe(200); expect(dl.headers['content-type']).toBe('image/png');
    const bad = await app.inject({ method: 'GET', url: g.files[0].url.replace('http://localhost:4000', '').replace(/sig=\w+/, 'sig=deadbeef') });
    expect(bad.statusCode).toBe(403);
    expect((await get(u, '/generations?kind=image')).json().items).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/generations/${g.id}`, headers: u.auth })).statusCode).toBe(200);
  });
  it('refunds credits when generation ultimately fails and tells the user', async () => {
    const u = await signup(app);
    ai.failImage = true;
    const r = await post(u, '/generations/image', { prompt: 'will fail' });
    await drain();
    const g = (await get(u, `/generations/${r.json().id}`)).json();
    expect(g.status).toBe('failed'); expect(g.error).not.toMatch(/boom/);
    expect(await bal(u.id)).toBe(60);
    const ledger = (await pool.query(`SELECT count(*)::int n FROM credit_ledger WHERE user_id=$1 AND reason LIKE 'refund:%'`, [u.id])).rows[0].n;
    expect(ledger).toBe(1);
    const notifs = (await get(u, '/notifications')).json().items;
    expect(notifs.some((n: any) => n.type === 'ai_complete')).toBe(true);
  });
  it('rejects up-front (no charge) when no provider is configured', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE ai_providers SET enabled=false WHERE capability='image'`);
    const { clearProviderCache } = await import('../src/ai/registry.js'); clearProviderCache();
    const r = await post(u, '/generations/image', { prompt: 'x y z' });
    expect(r.statusCode).toBe(503); expect(await bal(u.id)).toBe(60);
    await pool.query(`UPDATE ai_providers SET enabled=true WHERE capability='image'`); clearProviderCache();
  });
  it('uses admin-changed credit costs immediately (nothing hardcoded)', async () => {
    const u = await signup(app);
    await pool.query(`INSERT INTO app_settings(key, published) VALUES ('credit_costs', '{"image": 11}') ON CONFLICT (key) DO UPDATE SET published='{"image": 11}'`);
    clearSettingsCache();
    const r = await post(u, '/generations/image', { prompt: 'cost check' });
    expect(r.json().creditsCharged).toBe(11);
    await pool.query(`DELETE FROM app_settings WHERE key='credit_costs'`); clearSettingsCache();
  });
  it('concurrent requests cannot overspend a wallet', async () => {
    const u = await signup(app);
    await pool.query('UPDATE credit_wallets SET balance=10 WHERE user_id=$1', [u.id]);
    await pool.query(`UPDATE trials SET limits = limits || '{"image":100}'::jsonb WHERE user_id=$1`, [u.id]);
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(u, '/generations/image', { prompt: 'race condition test' })));
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(2);
    expect(rs.filter((r) => r.statusCode === 402)).toHaveLength(3);
    expect(await bal(u.id)).toBe(0);
  });
  it('enforces the trial limit for images', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE trials SET limits = limits || '{"image":1}'::jsonb WHERE user_id=$1`, [u.id]);
    expect((await post(u, '/generations/image', { prompt: 'first image' })).statusCode).toBe(202);
    const second = await post(u, '/generations/image', { prompt: 'second image' });
    expect(second.statusCode).toBe(402); expect(second.json().error.reason).toBe('trial_limit_reached');
  });
});

describe('AI video generation (queue, progress, cancel)', () => {
  it('runs the full async flow: queued → processing → completed with stored video', async () => {
    const u = await signup(app);
    await grantPaid(u.id);
    const video = makeVideo(1);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => String(url).startsWith('http://test.local/') ? new Response(new Uint8Array(video), { headers: { 'content-type': 'video/mp4' } }) : origFetch(url, init)) as any;
    try {
      const r = await post(u, '/generations/video', { prompt: 'a drone shot over mountains', durationSec: 10, aspect: '9:16' });
      expect(r.statusCode).toBe(202); expect(r.json().creditsCharged).toBe(40 + 30);
      const id = r.json().id;
      const { claim } = await import('../src/services/jobs.js'); const { processJob } = await import('../src/worker.js');
      await pool.query(`UPDATE jobs SET run_at=now()`);
      await processJob((await claim())!);               // submit
      expect((await get(u, `/generations/${id}`)).json().status).toBe('processing');
      await pool.query(`UPDATE jobs SET run_at=now() WHERE status='queued'`);
      await processJob((await claim())!);               // poll → still processing
      const mid = (await get(u, `/generations/${id}`)).json(); expect(mid.status).toBe('processing'); expect(mid.progress).toBeGreaterThan(0);
      await drain();                                    // poll → done
      const g = (await get(u, `/generations/${id}`)).json();
      expect(g.status).toBe('completed'); expect(g.files[0].mime).toBe('video/mp4');
      await drain();                                    // post-process (thumbnail + 720p)
      const f = (await pool.query('SELECT * FROM files WHERE id=$1', [g.files[0].id])).rows[0];
      expect(f.thumb_key).toBeTruthy(); expect(f.optimized_key).toMatch(/_720\.mp4$/); expect(f.duration_ms).toBeGreaterThan(500);
    } finally { globalThis.fetch = origFetch; }
  });
  it('cancel while queued refunds immediately; the worker never runs it', async () => {
    const u = await signup(app);
    const r = await post(u, '/generations/video', { prompt: 'cancel me please' });
    expect(await bal(u.id)).toBe(20);
    const c = await post(u, `/generations/${r.json().id}/cancel`);
    expect(c.json().status).toBe('cancelled'); expect(await bal(u.id)).toBe(60);
    await drain(); expect((await get(u, `/generations/${r.json().id}`)).json().status).toBe('cancelled');
    expect((await post(u, `/generations/${r.json().id}/cancel`)).statusCode).toBe(409);
  });
  it('provider failure marks the generation failed and refunds', async () => {
    const u = await signup(app);
    ai.videoFail = true;
    const r = await post(u, '/generations/video', { prompt: 'this fails at provider' });
    await drain();
    expect((await get(u, `/generations/${r.json().id}`)).json().status).toBe('failed');
    expect(await bal(u.id)).toBe(60);
  });
  it('trial allows very limited video (1) then asks to upgrade', async () => {
    const u = await signup(app);
    await pool.query('UPDATE credit_wallets SET balance=500 WHERE user_id=$1', [u.id]);
    expect((await post(u, '/generations/video', { prompt: 'first trial video' })).statusCode).toBe(202);
    const r2 = await post(u, '/generations/video', { prompt: 'second trial video' });
    expect(r2.statusCode).toBe(402); expect(r2.json().error.code).toBe('feature_locked');
  });
});

describe('Promo creator', () => {
  it('generates poster, copy, caption and hashtags in one job', async () => {
    const u = await signup(app);
    const r = await post(u, '/generations/promo', { productName: 'Brew Co Coffee', description: 'Small-batch roasted coffee beans', audience: 'students', brandName: 'Brew Co', offer: '20% off', price: '₹399' });
    expect(r.statusCode).toBe(202); expect(r.json().creditsCharged).toBe(2 + 6);
    await drain();
    const g = (await get(u, `/generations/${r.json().id}`)).json();
    expect(g.status).toBe('completed');
    expect(g.meta.caption).toBe('Coffee time'); expect(g.meta.hashtags).toEqual(['coffee', 'morning']);
    expect(g.files.length).toBe(2); expect(g.files[0].mime).toBe('image/png');
  });
});

describe('AI photo & video editing', () => {
  it('runs AI background removal as a job and requires a mask for object removal', async () => {
    const u = await signup(app);
    const up = await uploadFile(app, u.auth, 'edit_source', 'image/png', await pngBuf());
    expect(up.res.statusCode).toBe(200);
    const noMask = await post(u, '/generations/photo-edit', { op: 'remove_object', sourceFileId: up.fileId });
    expect(noMask.statusCode).toBe(400);
    const r = await post(u, '/generations/photo-edit', { op: 'remove_background', sourceFileId: up.fileId });
    expect(r.statusCode).toBe(202); expect(r.json().creditsCharged).toBe(3);
    await drain();
    expect((await get(u, `/generations/${r.json().id}`)).json().status).toBe('completed');
  });
  it("cannot edit another user's file", async () => {
    const a = await signup(app), b = await signup(app);
    const up = await uploadFile(app, a.auth, 'edit_source', 'image/png', await pngBuf());
    expect((await post(b, '/generations/photo-edit', { op: 'enhance', sourceFileId: up.fileId })).statusCode).toBe(400);
  });
  it('renders a real video edit with trim, speed, text, captions, filter and music through ffmpeg', async () => {
    const u = await signup(app);
    const v = await uploadFile(app, u.auth, 'edit_source', 'video/mp4', makeVideo(3));
    const v2 = await uploadFile(app, u.auth, 'edit_source', 'video/mp4', makeVideo(2, false));
    const m = await uploadFile(app, u.auth, 'edit_source', 'video/mp4', makeVideo(4));
    expect(v.res.statusCode).toBe(200);
    const r = await post(u, '/generations/video-edit', {
      clips: [{ fileId: v.fileId, start: 0.5, end: 2.5, speed: 2 }, { fileId: v2.fileId, speed: 1 }], format: 'square_1_1', filter: 'vivid', transition: 'fade',
      texts: [{ text: "MADIX: Launch's day", start: 0, end: 1.5 }], captions: [{ text: 'Hello world', start: 0.2, end: 1 }], audio: { fileId: m.fileId, volume: 0.5 }, aiEnhance: true,
    });
    expect(r.statusCode).toBe(202); expect(r.json().creditsCharged).toBe(1 + 8);
    await drain();
    const g = (await get(u, `/generations/${r.json().id}`)).json();
    expect(g.error).toBeNull(); expect(g.status).toBe('completed');
    expect(g.files[0].mime).toBe('video/mp4');
    const f = (await pool.query('SELECT * FROM files WHERE id=$1', [g.files[0].id])).rows[0];
    await drain(); // postprocess
    const f2 = (await pool.query('SELECT * FROM files WHERE id=$1', [f.id])).rows[0];
    expect(f2.width).toBe(1080); expect(f2.height).toBe(1080);
    expect(f2.duration_ms).toBeGreaterThan(2500); expect(f2.duration_ms).toBeLessThan(3500);   // 1s (2s@2x) + 2s
  });
});
void clearSettingsCache;
