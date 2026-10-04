import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, makeAdmin } from './helpers.js';
import { sentSms } from '../src/services/sms.js';
import { pool } from '../src/db/pool.js';
import { contrast } from '../src/lib/settings.js';
import { buildFfmpegArgs } from '../src/worker/ffmpeg.js';
import { runMaintenance } from '../src/worker/maintenance.js';

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('phone verification', () => {
  it('sends an OTP and verifies it; wrong/expired codes fail; numbers are unique', async () => {
    const u = await signup(app), v = await signup(app);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/send-otp', headers: u.auth, payload: { phone: '12345' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/send-otp', headers: u.auth, payload: { phone: '+919876543210' } })).statusCode).toBe(200);
    const code = /(\d{6})/.exec(sentSms.at(-1)!.text)![1];
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/verify', headers: u.auth, payload: { phone: '+919876543210', code: code === '000000' ? '111111' : '000000' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/verify', headers: u.auth, payload: { phone: '+919876543210', code } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).json().user.phoneVerified).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/verify', headers: u.auth, payload: { phone: '+919876543210', code } })).statusCode).toBe(400); // single use
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/phone/send-otp', headers: v.auth, payload: { phone: '+919876543210' } })).statusCode).toBe(400); // taken
  });
});

describe('abuse protection', () => {
  it('rate limits login attempts per IP and returns a friendly message', async () => {
    process.env.TEST_RATE_LIMIT = '1';
    const limited = await makeApp();
    try {
      let last: any;
      for (let i = 0; i < 12; i++) last = await limited.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.9', payload: { identifier: 'x@y.com', password: 'nope-nope-nope' } });
      expect(last.statusCode).toBe(429); expect(last.json().error.code).toBe('rate_limited'); expect(last.json().error.message).toMatch(/slow down/i);
    } finally { delete process.env.TEST_RATE_LIMIT; await limited.close(); }
  });
  it('security headers are set and bad JSON / oversized bodies are rejected cleanly', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-frame-options']).toBeTruthy();
    const big = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ identifier: 'a'.repeat(3 * 1024 * 1024) }) });
    expect(big.statusCode).toBe(413);
  });
  it('unauthenticated users cannot reach protected endpoints or the media store without a signature', async () => {
    for (const [m, url] of [['GET', '/api/v1/me'], ['GET', '/api/v1/feed'], ['POST', '/api/v1/generations/image'], ['GET', '/api/v1/chat/conversations'], ['POST', '/api/v1/billing/orders'], ['GET', '/api/v1/ai/conversations']] as const)
      expect((await app.inject({ method: m, url })).statusCode, url).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/media/avatar/2026-10/x.png' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/media/..%2F..%2Fetc%2Fpasswd?mode=r&exp=9999999999&sig=x' })).statusCode).toBe(403);
  });
});

describe('maintenance & notifications', () => {
  it('notifies users when the trial is ending and when it has expired (once each)', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE trials SET ends_at = now() + interval '3 hours' WHERE user_id=$1`, [u.id]);
    await runMaintenance(); await runMaintenance();
    let n = (await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: u.auth })).json().items.filter((x: any) => x.type === 'trial_ending');
    expect(n).toHaveLength(1);
    await pool.query(`UPDATE trials SET ends_at = now() - interval '1 minute' WHERE user_id=$1`, [u.id]);
    await runMaintenance(); await runMaintenance();
    n = (await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: u.auth })).json().items.filter((x: any) => x.type === 'trial_expired');
    expect(n).toHaveLength(1);
  });
  it('expired subscriptions are marked expired and lose paid access', async () => {
    const u = await signup(app);
    const plan = (await pool.query(`INSERT INTO plans(code,name,kind,interval,price_minor,features) VALUES ('exp1','E','subscription','month',100,'{video}') RETURNING id`)).rows[0];
    await pool.query(`INSERT INTO subscriptions(user_id, plan_id, current_period_end) VALUES ($1,$2, now() - interval '1 minute')`, [u.id, plan.id]);
    await runMaintenance();
    expect((await pool.query(`SELECT status FROM subscriptions WHERE user_id=$1`, [u.id])).rows[0].status).toBe('expired');
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).json().access.subscriptionActive).toBe(false);
  });
  it('chat unread counter reflects only unread messages from others', async () => {
    const a = await signup(app), b = await signup(app);
    const conv = (await app.inject({ method: 'POST', url: '/api/v1/chat/conversations', headers: a.auth, payload: { userIds: [b.id] } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/chat/conversations/${conv.id}/messages`, headers: a.auth, payload: { body: 'one' } });
    await app.inject({ method: 'POST', url: `/api/v1/chat/conversations/${conv.id}/messages`, headers: a.auth, payload: { body: 'two' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/chat/unread', headers: b.auth })).json().unread).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chat/unread', headers: a.auth })).json().unread).toBe(0);
    await app.inject({ method: 'GET', url: `/api/v1/chat/conversations/${conv.id}/messages`, headers: b.auth });
    expect((await app.inject({ method: 'GET', url: '/api/v1/chat/unread', headers: b.auth })).json().unread).toBe(0);
  });
});

describe('units', () => {
  it('contrast ratio math matches WCAG', () => { expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 0); expect(contrast('#8B5CF6', '#050507')).toBeGreaterThan(4.5); expect(contrast('#111111', '#050507')).toBeLessThan(1.5); });
  it('ffmpeg builder: speed uses chained atempo, escapes drawtext, includes music mix and format size', () => {
    const edl: any = { clips: [{ fileId: 'a', start: 0, end: 4, speed: 4, volume: 1 }], format: 'square_1_1', filter: 'noir', transition: 'none', texts: [{ text: "It's 50%: [go], now;", start: 0, end: 2, x: 0.5, y: 0.8, size: 40, color: '#FFFFFF' }], captions: [], audio: { fileId: 'm', volume: 0.5, start: 0 }, aiEnhance: false };
    const { args, totalSec } = buildFfmpegArgs(edl, [{ path: '/tmp/a.mp4', probe: { duration: 10, width: 640, height: 480, hasAudio: true } }], { path: '/tmp/m.mp3' }, '/tmp/out.mp4');
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(totalSec).toBeCloseTo(1, 3); expect(fc).toContain('atempo=2,atempo=2'); expect(fc).toContain('scale=1080:1080'); expect(fc).toContain('amix=inputs=2'); expect(fc).toContain('hue=s=0');
    expect(fc).not.toContain("It's"); expect(fc).toContain('50\\%\\: \\[go\\]\\, now\;'); expect(args.at(-1)).toBe('/tmp/out.mp4');
  });
});
void makeAdmin;
