import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetDb, makeApp, signup, makeAdmin, uploadFile, pngBuf, makeVideo, drain } from './helpers.js';
import { pool } from '../src/db/pool.js';

let app: FastifyInstance; let adminP: Promise<Awaited<ReturnType<typeof makeAdmin>>> | null = null;
const getAdmin = () => (adminP ??= makeAdmin(app));
beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });
const call = (u: any, method: string, url: string, payload?: any) => app.inject({ method: method as any, url: '/api/v1' + url, headers: u.auth, payload });

describe('files & cloud storage', () => {
  it('uploads via signed URL, validates content, generates thumbnail', async () => {
    const u = await signup(app);
    const ok = await uploadFile(app, u.auth, 'post', 'image/png', await pngBuf());
    const f = ok.res.json().file; expect(f.width).toBe(64); expect(f.thumbUrl).toMatch(/_thumb\.webp/);
  });
  it('rejects disguised files, disallowed types and oversize', async () => {
    const u = await signup(app);
    const fake = await uploadFile(app, u.auth, 'post', 'image/png', Buffer.from('<?php echo 1; ?> not an image'));
    expect(fake.res.statusCode).toBe(400); expect(fake.res.json().error.code).toBe('content_mismatch');
    const exe = await call(u, 'POST', '/files/init', { purpose: 'post', mime: 'application/x-msdownload', size: 100 });
    expect(exe.statusCode).toBe(400);
    const big = await call(u, 'POST', '/files/init', { purpose: 'avatar', mime: 'image/png', size: 50 * 1024 * 1024 });
    expect(big.statusCode).toBe(400); expect(big.json().error.code).toBe('file_too_large');
    const svg = await uploadFile(app, (await getAdmin()).auth, 'branding', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(svg.res.statusCode).toBe(400);
  });
  it('unverified accounts cannot upload; expired signed links are refused', async () => {
    const u = await signup(app, { verify: false });
    expect((await call(u, 'POST', '/files/init', { purpose: 'post', mime: 'image/png', size: 100 })).statusCode).toBe(403);
    const v = await signup(app);
    const init = (await call(v, 'POST', '/files/init', { purpose: 'post', mime: 'image/png', size: 10 })).json();
    const u2 = new URL(init.upload.url); const expired = u2.search.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 10}`);
    expect((await app.inject({ method: 'PUT', url: u2.pathname + expired, payload: Buffer.from('x') })).statusCode).toBe(403);
  });
});

describe('social feed', () => {
  it('text/image/video posts, likes, saves, comments, shares, counters and notifications', async () => {
    const a = await signup(app), b = await signup(app);
    const img = await uploadFile(app, a.auth, 'post', 'image/png', await pngBuf());
    const p = (await call(a, 'POST', '/posts', { kind: 'image', body: 'Sunset #golden #Sky', fileId: img.fileId })).json();
    expect(p.hashtags).toEqual(['golden', 'sky']); expect(p.media.url).toBeTruthy();
    expect((await call(a, 'POST', '/posts', { kind: 'image', body: 'no media' })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/posts', { kind: 'video', body: 'wrong type', fileId: img.fileId })).statusCode).toBe(400);
    const like = await call(b, 'POST', `/posts/${p.id}/like`); expect(like.json().likes).toBe(1);
    expect((await call(b, 'POST', `/posts/${p.id}/like`)).json().likes).toBe(1);   // idempotent
    expect((await call(b, 'POST', `/posts/${p.id}/save`)).json().saves).toBe(1);
    expect((await call(b, 'POST', `/posts/${p.id}/comments`, { body: 'Beautiful!' })).statusCode).toBe(201);
    await call(b, 'POST', `/posts/${p.id}/share`);
    const full = (await call(b, 'GET', `/posts/${p.id}`)).json();
    expect(full.counts).toMatchObject({ likes: 1, comments: 1, saves: 1, shares: 1 }); expect(full.viewer).toEqual({ liked: true, saved: true });
    expect((await call(b, 'GET', '/saved')).json().items).toHaveLength(1);
    const n = (await call(a, 'GET', '/notifications')).json().items.map((x: any) => x.type);
    expect(n).toEqual(expect.arrayContaining(['like', 'comment']));
    await call(b, 'DELETE', `/posts/${p.id}/like`); expect((await call(a, 'GET', `/posts/${p.id}`)).json().counts.likes).toBe(0);
    expect((await call(b, 'DELETE', `/posts/${p.id}`)).statusCode).toBe(404);          // not yours
    expect((await call(a, 'DELETE', `/posts/${p.id}`)).statusCode).toBe(200);
    expect((await call(b, 'GET', `/posts/${p.id}`)).statusCode).toBe(404);
  });
  it('follow/unfollow updates counts and notifies; search finds users and hashtags', async () => {
    const a = await signup(app), b = await signup(app);
    await call(b, 'POST', `/users/${a.id}/follow`);
    expect((await call(a, 'GET', `/users/${a.username}`)).json().followers).toBe(1);
    expect((await call(a, 'GET', '/notifications')).json().items.some((x: any) => x.type === 'follow')).toBe(true);
    expect((await call(b, 'POST', `/users/${b.id}/follow`)).statusCode).toBe(400);
    await call(b, 'DELETE', `/users/${a.id}/follow`); expect((await call(a, 'GET', `/users/${a.username}`)).json().followers).toBe(0);
    const s = (await call(b, 'GET', `/search?type=users&q=${a.username.slice(0, 8)}`)).json().items; expect(s.some((x: any) => x.id === a.id)).toBe(true);
    await call(a, 'POST', '/posts', { kind: 'text', body: 'Hello #madixtest world' });
    expect((await call(b, 'GET', '/search?type=hashtags&q=%23madixt')).json().items[0].tag).toBe('madixtest');
    expect((await call(b, 'GET', '/search?type=posts&q=madixtest')).json().items).toHaveLength(1);
  });
  it('ranking: followed authors and learned interests outrank strangers; watched content is demoted; blocked users hidden', async () => {
    const me = await signup(app), friend = await signup(app), stranger = await signup(app), blocked = await signup(app);
    await call(me, 'POST', `/users/${friend.id}/follow`);
    const pf = (await call(friend, 'POST', '/posts', { kind: 'text', body: 'from my friend #cooking' })).json();
    const ps = (await call(stranger, 'POST', '/posts', { kind: 'text', body: 'from a stranger #travel' })).json();
    const pb = (await call(blocked, 'POST', '/posts', { kind: 'text', body: 'from blocked #cooking' })).json();
    await call(me, 'POST', `/users/${blocked.id}/block`);
    const ids = (await call(me, 'GET', '/feed?kind=post')).json().items.map((p: any) => p.id);
    expect(ids).not.toContain(pb.id);
    expect(ids.indexOf(pf.id)).toBeLessThan(ids.indexOf(ps.id));
    // interest learning: likes on #travel boost the stranger's other travel posts
    await call(me, 'POST', `/posts/${ps.id}/like`); await call(me, 'POST', `/posts/${ps.id}/save`);
    const interest = (await pool.query(`SELECT score FROM user_interests WHERE user_id=$1 AND tag='travel'`, [me.id])).rows[0];
    expect(interest.score).toBeGreaterThan(2);
    // fatigue: completed views are demoted
    await call(me, 'POST', `/posts/${pf.id}/view`, { watchMs: 12000, completed: true });
    const ids2 = (await call(me, 'GET', '/feed?kind=post')).json().items.map((p: any) => p.id);
    expect(ids2.indexOf(pf.id)).toBeGreaterThan(ids2.indexOf(ps.id));
  });
  it('reels: upload video, watch tracking, pagination, trending, optimised rendition', async () => {
    const a = await signup(app), b = await signup(app);
    const v = await uploadFile(app, a.auth, 'reel', 'video/mp4', makeVideo(2));
    await drain();
    const r = (await call(a, 'POST', '/posts', { kind: 'reel', body: 'My first reel #reels', fileId: v.fileId })).json();
    expect(r.media.url).toMatch(/_720\.mp4/); expect(r.media.thumbUrl).toMatch(/_thumb\.jpg/); expect(r.media.durationMs).toBeGreaterThan(1500);
    const feed = (await call(b, 'GET', '/feed?kind=reel')).json(); expect(feed.items.some((p: any) => p.id === r.id)).toBe(true);
    await call(b, 'POST', `/posts/${r.id}/view`, { watchMs: 8000, completed: false });
    expect((await call(b, 'GET', `/posts/${r.id}`)).json().counts.views).toBe(1);
    await call(b, 'POST', `/posts/${r.id}/like`);
    expect((await call(b, 'GET', '/reels/trending')).json().items[0].id).toBe(r.id);
    expect((await call(b, 'GET', '/home')).json()).toHaveProperty('trending');
  });
  it('reporting: a report is stored once per user; moderators act; content removed; user suspended; logs written', async () => {
    const admin = await getAdmin();
    const a = await signup(app), b = await signup(app);
    const p = (await call(a, 'POST', '/posts', { kind: 'text', body: 'bad content' })).json();
    expect((await call(b, 'POST', '/reports', { targetType: 'post', targetId: p.id, reason: 'abuse' })).statusCode).toBe(200);
    await call(b, 'POST', '/reports', { targetType: 'post', targetId: p.id, reason: 'spam' });
    expect((await pool.query('SELECT count(*)::int n FROM reports WHERE target_id=$1', [p.id])).rows[0].n).toBe(1);
    expect((await call(a, 'GET', '/admin/reports')).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/admin/reports', headers: admin.auth })).json().items;
    const rep = list.find((r: any) => r.target_id === p.id); expect(rep.target.body).toBe('bad content');
    const act = await app.inject({ method: 'POST', url: `/api/v1/admin/reports/${rep.id}/action`, headers: admin.auth, payload: { action: 'remove_content', note: 'violates rules' } });
    expect(act.statusCode).toBe(200);
    expect((await call(b, 'GET', `/posts/${p.id}`)).statusCode).toBe(404);
    expect((await call(a, 'GET', '/notifications')).json().items.some((n: any) => n.type === 'moderation')).toBe(true);
    const susp = await app.inject({ method: 'POST', url: `/api/v1/admin/reports/${rep.id}/action`, headers: admin.auth, payload: { action: 'suspend_user', suspendDays: 2 } });
    expect(susp.statusCode).toBe(200);
    expect((await call(a, 'GET', '/me')).statusCode).toBe(401);
    expect((await pool.query('SELECT count(*)::int n FROM moderation_logs')).rows[0].n).toBe(2);
  });
});

describe('chat', () => {
  it('direct chat: send text/files, reply, react, delete, unread counts, access control', async () => {
    const a = await signup(app), b = await signup(app), c = await signup(app);
    const conv = (await call(a, 'POST', '/chat/conversations', { userIds: [b.id] })).json();
    expect((await call(b, 'POST', '/chat/conversations', { userIds: [a.id] })).json().id).toBe(conv.id);   // deduped
    const m1 = (await call(a, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'hello' })).json();
    const att = await uploadFile(app, a.auth, 'chat', 'image/png', await pngBuf());
    const m2 = (await call(a, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'look', fileId: att.fileId, replyTo: m1.id })).json();
    expect(m2.file.url).toBeTruthy(); expect(m2.replyTo).toBe(m1.id);
    expect((await call(b, 'GET', '/chat/conversations')).json().items[0].unread).toBe(2);
    expect((await call(b, 'GET', `/chat/conversations/${conv.id}/messages`)).json().items).toHaveLength(2);
    expect((await call(b, 'GET', '/chat/conversations')).json().items[0].unread).toBe(0);
    expect((await call(c, 'GET', `/chat/conversations/${conv.id}/messages`)).statusCode).toBe(404);
    expect((await call(c, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'intruder' })).statusCode).toBe(404);
    await call(b, 'PUT', `/chat/messages/${m1.id}/reaction`, { emoji: '🔥' });
    expect((await call(a, 'GET', `/chat/conversations/${conv.id}/messages`)).json().items[0].reactions).toEqual([{ emoji: '🔥', count: 1, mine: false }]);
    expect((await call(b, 'DELETE', `/chat/messages/${m1.id}`)).statusCode).toBe(404);   // not sender
    expect((await call(a, 'DELETE', `/chat/messages/${m1.id}`)).statusCode).toBe(200);
    expect((await call(b, 'GET', `/chat/conversations/${conv.id}/messages`)).json().items[0]).toMatchObject({ deleted: true, body: '' });
    const att2 = await uploadFile(app, a.auth, 'post', 'image/png', await pngBuf());
    expect((await call(a, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'x', fileId: att2.fileId })).statusCode).toBe(400); // wrong purpose
  });
  it('blocking stops messages both ways', async () => {
    const a = await signup(app), b = await signup(app);
    const conv = (await call(a, 'POST', '/chat/conversations', { userIds: [b.id] })).json();
    await call(b, 'POST', `/users/${a.id}/block`);
    expect((await call(a, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'hi' })).statusCode).toBe(403);
    expect((await call(b, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'hi' })).statusCode).toBe(403);
    expect((await call(a, 'POST', '/chat/conversations', { userIds: [b.id] })).statusCode).toBe(403);
    await call(b, 'DELETE', `/users/${a.id}/block`);
    expect((await call(a, 'POST', `/chat/conversations/${conv.id}/messages`, { body: 'hi' })).statusCode).toBe(201);
  });
  it('group chat with a title; members can message and leave', async () => {
    const a = await signup(app), b = await signup(app), c = await signup(app);
    expect((await call(a, 'POST', '/chat/conversations', { userIds: [b.id, c.id] })).statusCode).toBe(400);
    const g = (await call(a, 'POST', '/chat/conversations', { userIds: [b.id, c.id], title: 'Team' })).json();
    expect((await call(c, 'POST', `/chat/conversations/${g.id}/messages`, { body: 'hey team' })).statusCode).toBe(201);
    expect((await call(b, 'GET', `/chat/conversations/${g.id}/messages`)).json().items).toHaveLength(1);
    await call(c, 'POST', `/chat/conversations/${g.id}/leave`);
    expect((await call(c, 'GET', `/chat/conversations/${g.id}/messages`)).statusCode).toBe(404);
  });
});

describe('notifications & realtime', () => {
  it('lists, counts unread and marks read', async () => {
    const a = await signup(app), b = await signup(app);
    await call(b, 'POST', `/users/${a.id}/follow`);
    const n = (await call(a, 'GET', '/notifications')).json(); expect(n.unread).toBeGreaterThan(0);
    await call(a, 'POST', '/notifications/read', {});
    expect((await call(a, 'GET', '/notifications')).json().unread).toBe(0);
  });
  it('validates input; errors never expose internals', async () => {
    const a = await signup(app);
    const r = await call(a, 'GET', '/posts/not-a-uuid'); expect(r.statusCode).toBe(400); expect(r.json().error.message).toBeTruthy();
    expect(r.body).not.toMatch(/ZodError|stack|at /);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad json' })).statusCode).toBe(400);
  });
});

describe('media delivery', () => {
  it('local media supports HTTP range requests for video seeking', async () => {
    const u = await signup(app);
    const up = await uploadFile(app, u.auth, 'reel', 'video/mp4', makeVideo(1));
    const url = new URL(up.res.json().file.originalUrl ?? up.res.json().file.url);
    const full = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(full.statusCode).toBe(200); expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206); expect(part.rawPayload.length).toBe(100); expect(part.headers['content-range']).toMatch(/^bytes 0-99\//);
    const bad = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { range: 'bytes=99999999-' } });
    expect(bad.statusCode).toBe(416);
  });
});
