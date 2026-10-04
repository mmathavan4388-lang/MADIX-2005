import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, verifyLast, makeAdmin, bal } from './helpers.js';
import { sentMail } from '../src/lib/mail.js';
import { pool } from '../src/db/pool.js';
import { totpAt } from '../src/lib/crypto.js';

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe('registration, verification and trial', () => {
  it('registers, requires verification, then activates a 3-day trial with free credits', async () => {
    const u = await signup(app, { verify: false });
    expect((await pool.query('SELECT 1 FROM trials WHERE user_id=$1', [u.id])).rowCount).toBe(0);
    expect(await bal(u.id)).toBe(0);
    await verifyLast(app, u.email);
    const trial = (await pool.query('SELECT * FROM trials WHERE user_id=$1', [u.id])).rows[0];
    expect(trial).toBeTruthy();
    const days = (new Date(trial.ends_at).getTime() - new Date(trial.started_at).getTime()) / 86400000;
    expect(Math.round(days)).toBe(3);
    expect(await bal(u.id)).toBe(60);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: u.password } });
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(me.json().trial.active).toBe(true);
    expect(me.json().credits).toBe(60);
    expect(me.json().trial.msRemaining).toBeGreaterThan(2.9 * 86400000);
  });
  it('verification link is single use and trial is granted only once', async () => {
    const u = await signup(app);
    const mail = [...sentMail].reverse().find((m) => m.to === u.email)!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token } });
    expect(again.statusCode).toBe(400);
    expect(await bal(u.id)).toBe(60);
  });
  it('rejects weak passwords, duplicates, and invalid input without leaking internals', async () => {
    const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'a@b.com', username: 'abc_def', password: 'short' } });
    expect(weak.statusCode).toBe(400);
    const u = await signup(app);
    const dup = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: u.email, username: 'different_name', password: 'Str0ngPassw0rd!' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.body).not.toMatch(/duplicate key|constraint|pg/i);
  });
  it('trial expiry is automatic', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE trials SET ends_at = now() - interval '1 minute' WHERE user_id=$1`, [u.id]);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth });
    expect(me.json().trial.active).toBe(false);
    expect(me.json().access.trialActive).toBe(false);
  });
});

describe('login, sessions, password reset', () => {
  it('logs in with email or username, rejects bad password generically', async () => {
    const u = await signup(app);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.username, password: u.password } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: 'Wrong-password1' } });
    const none = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: 'nobody@example.com', password: 'Wrong-password1' } });
    expect(bad.statusCode).toBe(401); expect(none.statusCode).toBe(401);
    expect(bad.json().error.message).toBe(none.json().error.message);
  });
  it('rotates refresh tokens and revokes everything on refresh-token reuse', async () => {
    const u = await signup(app);
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: u.refresh } });
    expect(r1.statusCode).toBe(200);
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: u.refresh } });
    expect(reuse.statusCode).toBe(401);
    const newer = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: r1.json().refreshToken } });
    expect(newer.statusCode).toBe(401);
  });
  it('logout invalidates the session immediately', async () => {
    const u = await signup(app);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: u.auth, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).statusCode).toBe(401);
  });
  it('forgot/reset password flow works, link is single-use, old sessions die', async () => {
    const u = await signup(app);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: 'ghost@example.com' } })).statusCode).toBe(200);
    expect(sentMail.some((m) => m.to === 'ghost@example.com')).toBe(false);
    await app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { email: u.email } });
    const mail = [...sentMail].reverse().find((m) => m.to === u.email && /reset-password/.test(m.text))!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password: 'weak' } });
    expect(weak.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password: 'N3w-Password-Value' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, password: 'An0ther-Password-Value' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: 'N3w-Password-Value' } })).statusCode).toBe(200);
  });
  it('locks the account after repeated failures', async () => {
    const u = await signup(app);
    for (let i = 0; i < 8; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: `10.9.9.${i}`, payload: { identifier: u.email, password: 'Wrong-password1' } });
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.9.9.100', payload: { identifier: u.email, password: u.password } });
    expect(r.statusCode).toBe(429);
  });
  it('blocked and suspended users cannot sign in or use existing tokens', async () => {
    const u = await signup(app);
    await pool.query(`UPDATE users SET status='blocked' WHERE id=$1`, [u.id]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: u.password } })).statusCode).toBe(403);
  });
});

describe('admin authentication and authorization', () => {
  it('only one primary admin can ever exist and public registration cannot create one', async () => {
    await pool.query(`DELETE FROM audit_logs`); await pool.query(`DELETE FROM users WHERE role='admin'`);
    const admin = await makeAdmin(app);
    await expect(pool.query(`INSERT INTO users(email, username, password_hash, role) VALUES ('x@y.com','second_admin','x','admin')`)).rejects.toThrow();
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'e@x.com', username: 'eve_admin', password: 'Str0ngPassw0rd!', role: 'admin' } });
    expect(reg.json().user.role).toBe('user');
    expect(admin.auth).toBeTruthy();
  });
  it('requires correct password AND valid TOTP code; regular login endpoint refuses admin', async () => {
    await pool.query(`DELETE FROM audit_logs`); await pool.query(`DELETE FROM users WHERE role='admin'`);
    const a = await makeAdmin(app);
    const noTotp = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: 'owner@sayrix.test', password: a.password, totp: '000000' } });
    expect(noTotp.statusCode).toBe(401);
    const badPw = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', remoteAddress: '10.1.1.1', payload: { email: 'owner@sayrix.test', password: 'nope-nope-nope-12', totp: totpAt(a.secret, Date.now()) } });
    expect(badPw.statusCode).toBe(401);
    const normal = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: 'owner@sayrix.test', password: a.password } });
    expect(normal.statusCode).toBe(401);
    const good = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard', headers: a.auth });
    expect(good.statusCode).toBe(200);
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action='admin.login'`)).rowCount).toBeGreaterThan(0);
  });
  it('regular users get 403 on every admin route; unauthenticated get 401', async () => {
    const u = await signup(app);
    for (const url of ['/api/v1/admin/dashboard', '/api/v1/admin/users', '/api/v1/admin/plans', '/api/v1/admin/settings/branding', '/api/v1/admin/audit-logs', '/api/v1/admin/reports']) {
      expect((await app.inject({ method: 'GET', url, headers: u.auth })).statusCode, url).toBe(403);
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'PUT', url: '/api/v1/admin/plans/' + crypto.randomUUID(), headers: u.auth, payload: {} })).statusCode).toBe(403);
  });
});
void beforeEach;
