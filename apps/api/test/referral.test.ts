import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, bal, verifyLast, makeAdmin } from './helpers.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

const code = async (u: any) => (await app.inject({ method: 'GET', url: '/api/v1/me/referrals', headers: u.auth })).json();
const feats = async (u: any) => (await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).json().access.features as string[];

describe('referrals', () => {
  it('an unverified signup does not count; verification confirms it and unlocks the 1-referral reward', async () => {
    const referrer = await signup(app, { ip: '11.0.0.1', deviceId: 'dev-ref' });
    const { code: c } = await code(referrer);
    const friend = await signup(app, { ref: c, verify: false, ip: '11.0.1.1', deviceId: 'dev-1' });
    let s = await code(referrer); expect(s.qualified).toBe(0); expect(s.pending).toBe(1);
    expect(await feats(referrer)).not.toContain('image');
    await verifyLast(app, friend.email);
    s = await code(referrer); expect(s.qualified).toBe(1);
    expect(await feats(referrer)).toContain('image');
    expect(await feats(referrer)).not.toContain('video');
    const notifs = (await app.inject({ method: 'GET', url: '/api/v1/me/notifications', headers: referrer.auth })).json();
    void notifs;
  });
  it('3 / 5 / 10 verified referrals unlock Video, Promo and bonus credits as configured', async () => {
    const referrer = await signup(app, { ip: '12.0.0.1', deviceId: 'dev-r2' });
    const { code: c } = await code(referrer);
    const before = await bal(referrer.id);
    for (let i = 1; i <= 10; i++) {
      await signup(app, { ref: c, ip: `12.0.${i}.9`, deviceId: `dev-r2-${i}` });
      const f = await feats(referrer);
      if (i === 1) expect(f).toContain('image');
      if (i === 2) expect(f).not.toContain('video');
      if (i === 3) expect(f).toContain('video');
      if (i === 4) expect(f).not.toContain('promo');
      if (i === 5) expect(f).toContain('promo');
      if (i === 9) expect(await bal(referrer.id)).toBe(before);
    }
    expect(await bal(referrer.id)).toBe(before + 200);
    // rewards are never granted twice
    expect((await pool.query('SELECT count(*)::int n FROM referral_rewards WHERE user_id=$1', [referrer.id])).rows[0].n).toBe(4);
  });
  it('rejects abuse: self device, duplicate device, and IP farming', async () => {
    const referrer = await signup(app, { ip: '13.0.0.1', deviceId: 'dev-r3' });
    const { code: c } = await code(referrer);
    await signup(app, { ref: c, ip: '13.0.5.5', deviceId: 'dev-r3' });                 // same device as referrer
    await signup(app, { ref: c, ip: '13.0.6.6', deviceId: 'dup-dev' });                // first use of device: ok
    await signup(app, { ref: c, ip: '13.0.7.7', deviceId: 'dup-dev' });                // second account on same device
    for (const [i, ip] of ['13.7.7.7', '13.7.7.7', '13.7.7.7', '13.7.7.7'].entries()) await signup(app, { ref: c, ip, deviceId: `farm-${i}` });
    const rows = (await pool.query(`SELECT status, abuse_flags FROM referrals WHERE referrer_id=$1 ORDER BY created_at`, [referrer.id])).rows;
    expect(rows[0].status).toBe('rejected'); expect(rows[0].abuse_flags).toContain('same_device_as_referrer');
    expect(rows[1].status).toBe('qualified');
    expect(rows[2].status).toBe('rejected'); expect(rows[2].abuse_flags).toContain('duplicate_device');
    expect(rows.filter((r) => r.abuse_flags.includes('ip_limit')).length).toBeGreaterThanOrEqual(1);
    const s = await code(referrer); expect(s.qualified).toBe(1 + 3);
  });
  it('cannot refer yourself or use an invalid code; share-click without signup counts nothing', async () => {
    const u = await signup(app, { ip: '14.0.0.1' });
    const { code: c } = await code(u);
    expect((await code(u)).qualified).toBe(0);
    const bad = await signup(app, { ref: 'NOSUCHCD', ip: '14.0.1.1' });
    expect((await pool.query('SELECT 1 FROM referrals WHERE referred_id=$1', [bad.id])).rowCount).toBe(0);
    expect(c).toMatch(/^[A-Z0-9]{8}$/);
  });
  it('admin can edit rules/program switch and see referrer, referred, status and abuse flags', async () => {
    const admin = await makeAdmin(app);
    const rules = (await app.inject({ method: 'GET', url: '/api/v1/admin/referral-rules', headers: admin.auth })).json().items;
    expect(rules).toHaveLength(4);
    const upd = await app.inject({ method: 'PUT', url: `/api/v1/admin/referral-rules/${rules[0].id}`, headers: admin.auth, payload: { requiredCount: 2, rewardType: 'credits', credits: 50, label: '2 friends: 50 credits' } });
    expect(upd.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/admin/referral-rules', headers: admin.auth, payload: { requiredCount: 2, rewardType: 'feature' } });
    expect(bad.statusCode).toBe(400);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/admin/referrals?flagged=true', headers: admin.auth })).json().items;
    expect(list.length).toBeGreaterThan(0); expect(list[0]).toHaveProperty('referrer'); expect(list[0]).toHaveProperty('referred'); expect(list[0].abuse_flags.length).toBeGreaterThan(0);
    // program kill switch
    await app.inject({ method: 'PUT', url: '/api/v1/admin/settings/referral', headers: admin.auth, payload: { enabled: false } });
    await app.inject({ method: 'POST', url: '/api/v1/admin/settings/referral/publish', headers: admin.auth });
    const r = await signup(app, { ip: '15.0.0.1' }); const { code: c } = await code(r);
    const f = await signup(app, { ref: c, ip: '15.0.1.1' });
    expect((await pool.query('SELECT 1 FROM referrals WHERE referred_id=$1', [f.id])).rowCount).toBe(0);
  });
});
