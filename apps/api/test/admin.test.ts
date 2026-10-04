import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, makeAdmin, uploadFile, pngBuf, installTestProviders, addAllProviders, bal } from './helpers.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance; let admin: Awaited<ReturnType<typeof makeAdmin>>;
beforeAll(async () => { await resetDb(); installTestProviders(); app = await makeApp(); admin = await makeAdmin(app); });
afterAll(async () => { await app.close(); });
const A = (method: string, url: string, payload?: any) => app.inject({ method: method as any, url: '/api/v1/admin' + url, headers: admin.auth, payload });
const cfg = async () => (await app.inject({ method: 'GET', url: '/api/v1/app-config' })).json();

describe('admin-controlled content (no rebuild)', () => {
  it('defaults to MADIX / from SAYRIX MATHAV with the dark theme', async () => {
    const c = await cfg();
    expect(c.branding.appName).toBe('MADIX'); expect(c.branding.companyText).toBe('from SAYRIX MATHAV'); expect(c.branding.logoUrl).toBeNull();
    expect(c.theme.background).toBe('#050507'); expect(c.theme.primary).toBe('#8B5CF6'); expect(c.theme.secondary).toBe('#22D3EE');
    expect(c.home.quickActions.map((a: any) => a.label)).toEqual(['AI Assistant', 'Create Image', 'Create Video', 'Edit Photo', 'Edit Video', 'Promo Creator']);
  });
  it('Home edits stay invisible until Save & Publish, then apply instantly', async () => {
    await A('PUT', '/settings/home', { title: 'Create something wild', announcement: { text: 'Diwali offer live!', visible: true } });
    expect((await cfg()).home.title).toBe('What do you want to create?');
    expect((await A('GET', '/settings/home')).json().draft.title).toBe('Create something wild');
    expect((await A('POST', '/settings/home/publish')).statusCode).toBe(200);
    const c = await cfg();
    expect(c.home.title).toBe('Create something wild'); expect(c.home.announcement.text).toBe('Diwali offer live!');
    expect((await A('POST', '/settings/home/publish')).statusCode).toBe(400);
  });
  it('can hide a quick action and a section', async () => {
    await A('PUT', '/settings/home', { quickActions: [{ key: 'assistant', label: 'Ask MADIX', route: '/create/assistant', visible: true }, { key: 'image', label: 'Create Image', route: '/create/image', visible: false }] });
    await A('POST', '/settings/home/publish');
    expect((await cfg()).home.quickActions).toEqual([{ key: 'assistant', label: 'Ask MADIX', route: '/create/assistant', visible: true }]);
  });
  it('logo upload → preview → publish: logo appears in app-config for splash/login/home', async () => {
    const up = await uploadFile(app, admin.auth, 'branding', 'image/png', await pngBuf());
    expect(up.res.statusCode).toBe(200);
    await A('PUT', '/settings/branding', { logoFileId: up.fileId, companyText: 'from SAYRIX MATHAV' });
    expect((await cfg()).branding.logoUrl).toBeNull();
    const prev = (await A('GET', '/branding/preview')).json(); expect(prev.urls.logoFileId).toMatch(/\/media\/branding\//);
    await A('POST', '/settings/branding/publish');
    const c = await cfg();
    expect(c.branding.logoUrl).toMatch(/\/media\/branding\//); expect(c.branding.splashLogoUrl).toBe(c.branding.logoUrl); expect(c.branding.loginLogoUrl).toBe(c.branding.logoUrl);
    // delete logo
    await A('PUT', '/settings/branding', { logoFileId: null }); await A('POST', '/settings/branding/publish');
    expect((await cfg()).branding.logoUrl).toBeNull();
  });
  it('only admins can upload branding assets', async () => {
    const u = await signup(app);
    const init = await app.inject({ method: 'POST', url: '/api/v1/files/init', headers: u.auth, payload: { purpose: 'branding', mime: 'image/png', size: 100 } });
    expect(init.statusCode).toBe(400);
  });
  it('theme: accepts accessible colours, rejects ones that break contrast', async () => {
    const bad = await A('PUT', '/settings/theme', { background: '#FFFFFF' });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.message).toMatch(/contrast/i);
    const bad2 = await A('PUT', '/settings/theme', { primary: '#111111' });
    expect(bad2.statusCode).toBe(400);
    expect((await A('PUT', '/settings/theme', { primary: '#A78BFA', secondary: '#67E8F9', gradient: ['#A78BFA', '#67E8F9'] })).statusCode).toBe(200);
    await A('DELETE', '/settings/theme/draft');
  });
  it('trial duration, free credits and AI costs are configurable and validated', async () => {
    expect((await A('PUT', '/settings/trial', { durationDays: 7, freeCredits: 100, featureLimits: { chat: 50, image: 10, video: 2, promo: 3, edit: 5 } })).statusCode).toBe(200);
    expect((await A('PUT', '/settings/trial', { durationDays: -1 })).statusCode).toBe(400);
    await A('POST', '/settings/trial/publish');
    const u = await signup(app);
    expect(await bal(u.id)).toBe(100);
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).json();
    expect(Math.round(me.trial.msRemaining / 86400000)).toBe(7);
    expect((await A('PUT', '/settings/credit_costs', { image: 7, video_5s: 55 })).statusCode).toBe(200);
    await A('POST', '/settings/credit_costs/publish');
    expect((await cfg()).creditCosts.image).toBe(7);
    // set back for other tests
    await A('PUT', '/settings/trial', { durationDays: 3, freeCredits: 60 }); await A('POST', '/settings/trial/publish');
  });
  it('promotions: create, activate with dates, appear in app-config, expire', async () => {
    const co = (await A('POST', '/coupons', { code: 'DIWALI25', percentOff: 25 })).json();
    const p = (await A('POST', '/promotions', { title: 'Diwali Sale', body: '25% off all plans', kind: 'offer', couponId: co.id, discountPercent: 25, ctaLabel: 'Upgrade', ctaUrl: '/pricing', active: true })).json();
    let promos = (await cfg()).promotions; expect(promos).toHaveLength(1); expect(promos[0].couponCode).toBe('DIWALI25');
    await A('PUT', `/promotions/${p.id}`, { title: 'Diwali Sale', kind: 'offer', startsAt: new Date(Date.now() + 86400000).toISOString(), active: true });
    expect((await cfg()).promotions).toHaveLength(0);
    await A('PUT', `/promotions/${p.id}`, { title: 'Diwali Sale', kind: 'offer', endsAt: new Date(Date.now() - 1000).toISOString(), active: true });
    expect((await cfg()).promotions).toHaveLength(0);
  });
  it('announcements reach users as in-app notifications', async () => {
    const u = await signup(app);
    expect((await A('POST', '/announcements', { title: 'New feature!', body: 'Reels audio is live.' })).statusCode).toBe(200);
    const n = (await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: u.auth })).json();
    expect(n.items.some((x: any) => x.type === 'announcement' && x.title === 'New feature!')).toBe(true);
  });
});

describe('plan management, users, audit, system', () => {
  it('create/disable plans and validate shape', async () => {
    const bad = await A('POST', '/plans', { code: 'x1', name: 'Bad', kind: 'subscription', priceMinor: 100 });
    expect(bad.statusCode).toBe(400);
    const ok = await A('POST', '/plans', { code: 'starter_pack', name: 'Starter', kind: 'credit_pack', priceMinor: 9900, credits: 100 });
    expect(ok.statusCode).toBe(201);
    await A('DELETE', `/plans/${ok.json().id}`);
    expect((await app.inject({ method: 'GET', url: '/api/v1/plans' })).json().plans.some((p: any) => p.code === 'starter_pack')).toBe(false);
  });
  it('block / unblock / suspend a user; sessions are revoked; the owner cannot be blocked', async () => {
    const u = await signup(app);
    expect((await A('POST', `/users/${u.id}/status`, { status: 'blocked', note: 'spam' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: u.auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: u.password } })).statusCode).toBe(403);
    await A('POST', `/users/${u.id}/status`, { status: 'active' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: u.password } })).statusCode).toBe(200);
    await A('POST', `/users/${u.id}/status`, { status: 'suspended', days: 3 });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identifier: u.email, password: u.password } })).statusCode).toBe(403);
    expect((await A('POST', `/users/${admin.id}/status`, { status: 'blocked' })).statusCode).toBe(400);
    expect((await pool.query(`SELECT count(*)::int n FROM moderation_logs WHERE target_id=$1`, [u.id])).rows[0].n).toBeGreaterThanOrEqual(3);
  });
  it('manual credit grant is audited', async () => {
    const u = await signup(app); const start = await bal(u.id);
    expect((await A('POST', `/users/${u.id}/credits`, { amount: 25, reason: 'support goodwill' })).statusCode).toBe(200);
    expect(await bal(u.id)).toBe(start + 25);
    const logs = (await A('GET', '/audit-logs')).json().items;
    expect(logs.some((l: any) => l.action === 'user.credits' && l.target === u.id)).toBe(true);
  });
  it('AI providers: store only env-var NAMES; never raw secrets; replaceable at runtime', async () => {
    const r = await A('POST', '/ai-providers', { capability: 'text', name: 'prod-llm', adapter: 'openai-compatible', model: 'gpt-x', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'LLM_API_KEY' });
    expect(r.statusCode).toBe(201);
    expect((await A('POST', '/ai-providers', { capability: 'text', name: 'leak', adapter: 'openai-compatible', model: 'm', apiKeyEnv: 'sk-live-abc123' })).statusCode).toBe(400);
    const list = (await A('GET', '/ai-providers')).json().items; expect(list[0].keyConfigured).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/sk-/);
    await A('DELETE', `/ai-providers/${r.json().id}`);
  });
  it('dashboard, analytics and system status return the owner metrics', async () => {
    await addAllProviders();
    const d = (await A('GET', '/dashboard')).json();
    for (const k of ['users', 'revenue', 'ai', 'storageBytes', 'openReports', 'queue']) expect(d).toHaveProperty(k);
    expect(d.users.total).toBeGreaterThan(0); expect(d.users.trial).toBeGreaterThan(0);
    const an = (await A('GET', '/analytics?days=14')).json();
    expect(an.daily).toHaveLength(14); expect(an).toHaveProperty('trialConversion'); expect(an).toHaveProperty('retention'); expect(an).toHaveProperty('referrals');
    const sys = (await A('GET', '/system')).json();
    expect(sys.database).toBe(true); expect(sys.providers.text).toBeGreaterThan(0);
    expect(JSON.stringify(sys)).not.toMatch(/secret|password/i);
  });
});
