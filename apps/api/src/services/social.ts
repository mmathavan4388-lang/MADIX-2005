import { pool, tx, one, many, Q } from '../db/pool.js';
import { fileDtos } from '../lib/files.js';
import { notify } from './notify.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';

const likeEsc = (s: string) => s.replace(/[\\%_]/g, '\\$&');
export const extractTags = (s: string) => [...new Set((s.match(/#([\p{L}\p{N}_]{2,40})/gu) ?? []).map((t) => t.slice(1).toLowerCase()))].slice(0, 15);

const POST_COLS = `p.id, p.author_id, p.kind, p.body, p.file_id, p.audio_file_id, p.captions, p.hashtags, p.ai_generated, p.likes_count, p.comments_count, p.shares_count, p.saves_count, p.views_count, p.created_at,
  u.username, pr.display_name, pr.avatar_file_id`;
const POST_FROM = `posts p JOIN users u ON u.id=p.author_id JOIN profiles pr ON pr.user_id=p.author_id`;
const NOT_BLOCKED = (uid: string) => `p.status='published' AND u.status='active' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=${uid} AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=${uid}))`;

export async function hydratePosts(rows: any[], viewerId: string) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const files = await fileDtos(rows.flatMap((r) => [r.file_id, r.audio_file_id, r.avatar_file_id]));
  const [likes, saves, follows] = await Promise.all([
    many(pool, 'SELECT post_id FROM likes WHERE user_id=$1 AND post_id = ANY($2)', [viewerId, ids]),
    many(pool, 'SELECT post_id FROM saves WHERE user_id=$1 AND post_id = ANY($2)', [viewerId, ids]),
    many(pool, 'SELECT followee_id FROM follows WHERE follower_id=$1 AND followee_id = ANY($2)', [viewerId, rows.map((r) => r.author_id)]),
  ]);
  const L = new Set(likes.map((x) => x.post_id)), S = new Set(saves.map((x) => x.post_id)), F = new Set(follows.map((x) => x.followee_id));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, body: r.body, captions: r.captions, hashtags: r.hashtags, aiGenerated: r.ai_generated, createdAt: r.created_at,
    media: r.file_id ? files.get(r.file_id) ?? null : null, audio: r.audio_file_id ? files.get(r.audio_file_id) ?? null : null,
    author: { id: r.author_id, username: r.username, displayName: r.display_name, avatar: r.avatar_file_id ? files.get(r.avatar_file_id) ?? null : null, isFollowing: F.has(r.author_id), isMe: r.author_id === viewerId },
    counts: { likes: r.likes_count, comments: r.comments_count, shares: r.shares_count, saves: r.saves_count, views: r.views_count },
    viewer: { liked: L.has(r.id), saved: S.has(r.id) },
  }));
}

export async function createPost(userId: string, i: { kind: 'text' | 'image' | 'video' | 'reel'; body: string; fileId?: string; audioFileId?: string; captions?: string; aiGenerated?: boolean }) {
  if (i.kind === 'text' && !i.body.trim()) throw badRequest('Write something to post.');
  if (i.kind !== 'text') {
    if (!i.fileId) throw badRequest('Add a photo or video first.');
    const f = await one(pool, `SELECT mime FROM files WHERE id=$1 AND owner_id=$2 AND status='ready'`, [i.fileId, userId]);
    if (!f) throw badRequest('Media not found.');
    const ok = i.kind === 'image' ? f.mime.startsWith('image/') : f.mime.startsWith('video/');
    if (!ok) throw badRequest('The media does not match the post type.');
  }
  const post = await tx(async (c) => {
    const p = await one(c, `INSERT INTO posts(author_id, kind, body, file_id, audio_file_id, captions, hashtags, ai_generated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, i.kind, i.body, i.fileId ?? null, i.audioFileId ?? null, i.captions ?? null, extractTags(i.body), !!i.aiGenerated]);
    await c.query('UPDATE profiles SET posts_count=posts_count+1 WHERE user_id=$1', [userId]);
    // published media must be CDN-cacheable
    if (i.fileId) await c.query('UPDATE files SET is_public=true WHERE id=$1', [i.fileId]);
    if (i.audioFileId) await c.query('UPDATE files SET is_public=true WHERE id=$1 AND owner_id=$2', [i.audioFileId, userId]);
    return p;
  });
  const rows = await many(pool, `SELECT ${POST_COLS} FROM ${POST_FROM} WHERE p.id=$1`, [post.id]);
  return (await hydratePosts(rows, userId))[0];
}

export async function deletePost(userId: string, id: string, asStaff = false) {
  const r = await tx(async (c) => {
    const p = await one(c, `UPDATE posts SET status='removed' WHERE id=$1 AND status='published' AND ($3 OR author_id=$2) RETURNING author_id`, [id, userId, asStaff]);
    if (!p) return false;
    await c.query('UPDATE profiles SET posts_count=GREATEST(0,posts_count-1) WHERE user_id=$1', [p.author_id]);
    return true;
  });
  if (!r) throw notFound('Post not found.');
}

/** Learned interests: reinforce hashtags of content a user engages with. */
async function reinforce(q: Q, userId: string, postId: string, weight: number) {
  await q.query(`INSERT INTO user_interests(user_id, tag, score) SELECT $1, t, GREATEST(0,$3::real) FROM posts p, unnest(p.hashtags) t WHERE p.id=$2
    ON CONFLICT (user_id, tag) DO UPDATE SET score = LEAST(50, GREATEST(0, user_interests.score*0.98 + $3::real)), updated_at=now()`, [userId, postId, weight]);
}

async function visiblePost(userId: string, postId: string) {
  const p = await one(pool, `SELECT p.id, p.author_id FROM ${POST_FROM} WHERE p.id=$1 AND ${NOT_BLOCKED('$2')}`, [postId, userId]);
  if (!p) throw notFound('Post not found.');
  return p;
}

export async function toggleReaction(userId: string, postId: string, kind: 'like' | 'save', on: boolean) {
  const p = await visiblePost(userId, postId);
  const table = kind === 'like' ? 'likes' : 'saves', col = kind === 'like' ? 'likes_count' : 'saves_count';
  const changed = await tx(async (c) => {
    const r = on ? await c.query(`INSERT INTO ${table}(user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, postId]) : await c.query(`DELETE FROM ${table} WHERE user_id=$1 AND post_id=$2`, [userId, postId]);
    if (!r.rowCount) return false;
    await c.query(`UPDATE posts SET ${col}=GREATEST(0, ${col} + $2) WHERE id=$1`, [postId, on ? 1 : -1]);
    await reinforce(c, userId, postId, (on ? 1 : -1) * (kind === 'like' ? 1 : 1.5));
    return true;
  });
  if (changed && on && kind === 'like' && p.author_id !== userId) {
    const me = await one(pool, 'SELECT username FROM users WHERE id=$1', [userId]);
    await notify(p.author_id, 'like', `${me.username} liked your post`, '', { postId, actorId: userId });
  }
  return one(pool, `SELECT likes_count AS likes, saves_count AS saves FROM posts WHERE id=$1`, [postId]);
}

export async function addShare(userId: string, postId: string) {
  await visiblePost(userId, postId);
  await tx(async (c) => {
    const r = await c.query('INSERT INTO shares(user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, postId]);
    if (r.rowCount) { await c.query('UPDATE posts SET shares_count=shares_count+1 WHERE id=$1', [postId]); await reinforce(c, userId, postId, 2); }
  });
}

export async function addComment(userId: string, postId: string, body: string) {
  const p = await visiblePost(userId, postId);
  const cm = await tx(async (c) => {
    const r = await one(c, `INSERT INTO comments(post_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at`, [postId, userId, body]);
    await c.query('UPDATE posts SET comments_count=comments_count+1 WHERE id=$1', [postId]);
    await reinforce(c, userId, postId, 1);
    return r;
  });
  if (p.author_id !== userId) {
    const me = await one(pool, 'SELECT username FROM users WHERE id=$1', [userId]);
    await notify(p.author_id, 'comment', `${me.username} commented`, body.slice(0, 80), { postId, commentId: cm.id });
  }
  return cm;
}
export async function listComments(userId: string, postId: string, cursor?: string) {
  await visiblePost(userId, postId);
  const rows = await many(pool, `SELECT c.id, c.body, c.created_at, c.author_id, u.username, pr.display_name, pr.avatar_file_id FROM comments c JOIN users u ON u.id=c.author_id JOIN profiles pr ON pr.user_id=c.author_id
    WHERE c.post_id=$1 AND u.status='active' AND ($2::timestamptz IS NULL OR c.created_at > $2) AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$3 AND b.blocked_id=c.author_id) OR (b.blocker_id=c.author_id AND b.blocked_id=$3))
    ORDER BY c.created_at LIMIT 30`, [postId, cursor ?? null, userId]);
  const files = await fileDtos(rows.map((r) => r.avatar_file_id));
  return { items: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: { id: r.author_id, username: r.username, displayName: r.display_name, avatar: files.get(r.avatar_file_id) ?? null }, mine: r.author_id === userId })), next: rows.length === 30 ? rows[29].created_at : null };
}
export async function deleteComment(userId: string, commentId: string, staff = false) {
  const r = await tx(async (c) => {
    const d = await one(c, `DELETE FROM comments WHERE id=$1 AND ($3 OR author_id=$2 OR post_id IN (SELECT id FROM posts WHERE author_id=$2)) RETURNING post_id`, [commentId, userId, staff]);
    if (d) await c.query('UPDATE posts SET comments_count=GREATEST(0,comments_count-1) WHERE id=$1', [d.post_id]);
    return d;
  });
  if (!r) throw notFound('Comment not found.');
}

export async function recordView(userId: string, postId: string, watchMs: number, completed: boolean) {
  await visiblePost(userId, postId);
  const w = Math.min(Math.max(0, Math.floor(watchMs)), 3_600_000);
  await tx(async (c) => {
    const prev = await one(c, 'SELECT watch_ms, completed FROM post_views WHERE user_id=$1 AND post_id=$2', [userId, postId]);
    await c.query(`INSERT INTO post_views(user_id, post_id, watch_ms, completed) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, post_id) DO UPDATE SET watch_ms=GREATEST(post_views.watch_ms, $3), completed=post_views.completed OR $4, updated_at=now()`, [userId, postId, w, completed]);
    if (!prev) await c.query('UPDATE posts SET views_count=views_count+1 WHERE id=$1', [postId]);
    if ((!prev || (!prev.completed && completed)) && (completed || w > 5000)) await reinforce(c, userId, postId, completed ? 1 : 0.4);
  });
}

export async function setFollow(userId: string, targetId: string, on: boolean) {
  if (userId === targetId) throw badRequest("You can't follow yourself.");
  const t = await one(pool, `SELECT id, status FROM users WHERE id=$1`, [targetId]);
  if (!t || t.status !== 'active') throw notFound('User not found.');
  if (on && (await one(pool, 'SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [userId, targetId]))) throw forbidden('You cannot follow this user.');
  const changed = await tx(async (c) => {
    const r = on ? await c.query('INSERT INTO follows(follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, targetId]) : await c.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [userId, targetId]);
    if (!r.rowCount) return false;
    const d = on ? 1 : -1;
    await c.query('UPDATE profiles SET followers_count=GREATEST(0,followers_count+$2) WHERE user_id=$1', [targetId, d]);
    await c.query('UPDATE profiles SET following_count=GREATEST(0,following_count+$2) WHERE user_id=$1', [userId, d]);
    return true;
  });
  if (changed && on) { const me = await one(pool, 'SELECT username FROM users WHERE id=$1', [userId]); await notify(targetId, 'follow', `${me.username} started following you`, '', { actorId: userId }); }
}

/**
 * MADIX ranking. Score = freshness × (quality + affinity):
 *  - quality: weighted engagement (likes 1, comments 2, saves 3, shares 3) per view, plus watch completion rate (log-damped for new posts)
 *  - affinity: followed author (+3), learned interest overlap with hashtags (+0.6 per point, capped), same-author history
 *  - freshness: half-life of 36h
 *  - fatigue: posts already watched are pushed down; low-watch skips are pushed down further; AI-content is not penalised or boosted
 * A 15% exploration slice (random fresh posts) prevents filter bubbles and gives new creators reach.
 */
export async function rankedFeed(userId: string, kind: 'reel' | 'post' | 'all', offset: number, limit = 12) {
  const kinds = kind === 'reel' ? ['reel'] : kind === 'post' ? ['text', 'image', 'video'] : ['text', 'image', 'video', 'reel'];
  const rows = await many(pool, `
    WITH cand AS (
      SELECT ${POST_COLS},
        (SELECT COALESCE(LEAST(6, SUM(ui.score) * 0.6), 0) FROM user_interests ui WHERE ui.user_id=$1 AND ui.tag = ANY(p.hashtags)) AS interest,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=p.author_id) AS followed,
        pv.watch_ms, pv.completed AS seen_completed,
        (SELECT COALESCE(AVG(CASE WHEN v.completed THEN 1.0 ELSE LEAST(1.0, v.watch_ms/15000.0) END), 0.35) FROM post_views v WHERE v.post_id=p.id) AS watch_quality
      FROM ${POST_FROM} LEFT JOIN post_views pv ON pv.user_id=$1 AND pv.post_id=p.id
      WHERE p.kind = ANY($2) AND p.created_at > now() - interval '21 days' AND ${NOT_BLOCKED('$1')}
    )
    SELECT *, 
      EXP(-LN(2) * EXTRACT(EPOCH FROM now() - created_at) / 3600 / 36)
        * ( (LN(1 + likes_count + 2*comments_count + 3*saves_count + 3*shares_count) / LN(2 + views_count)) * 2 + watch_quality * 1.5
            + CASE WHEN followed THEN 3 ELSE 0 END + interest + 0.4 )
        * CASE WHEN watch_ms IS NULL THEN 1 WHEN seen_completed THEN 0.15 WHEN watch_ms < 2000 THEN 0.05 ELSE 0.3 END
        * (0.9 + 0.2 * random()) AS score
    FROM cand ORDER BY score DESC LIMIT $3 OFFSET $4`, [userId, kinds, limit, offset]);
  return { items: await hydratePosts(rows, userId), next: rows.length === limit ? offset + limit : null };
}

export async function trendingReels(userId: string, limit = 10) {
  const rows = await many(pool, `SELECT ${POST_COLS} FROM ${POST_FROM}
    WHERE p.kind='reel' AND p.created_at > now() - interval '7 days' AND ${NOT_BLOCKED('$1')}
    ORDER BY (p.likes_count + 2*p.comments_count + 3*p.shares_count + 3*p.saves_count + p.views_count*0.1) / POWER(EXTRACT(EPOCH FROM now()-p.created_at)/3600 + 2, 1.3) DESC LIMIT $2`, [userId, limit]);
  return hydratePosts(rows, userId);
}

export async function search(userId: string, q: string, type: 'users' | 'posts' | 'hashtags') {
  const term = q.trim().replace(/^#/, '');
  if (term.length < 2) return { items: [] };
  if (type === 'users') {
    const rows = await many(pool, `SELECT u.id, u.username, pr.display_name, pr.avatar_file_id, pr.followers_count FROM users u JOIN profiles pr ON pr.user_id=u.id
      WHERE u.status='active' AND u.role='user' AND (u.username ILIKE $1 || '%' OR pr.display_name ILIKE '%' || $1 || '%') AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$2))
      ORDER BY pr.followers_count DESC LIMIT 20`, [likeEsc(term), userId]);
    const files = await fileDtos(rows.map((r) => r.avatar_file_id));
    return { items: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, avatar: files.get(r.avatar_file_id) ?? null, followers: r.followers_count })) };
  }
  if (type === 'hashtags') {
    return { items: await many(pool, `SELECT t AS tag, count(*)::int AS posts FROM posts p, unnest(p.hashtags) t WHERE t LIKE $1 || '%' AND p.status='published' GROUP BY t ORDER BY posts DESC LIMIT 20`, [likeEsc(term.toLowerCase())]) };
  }
  const rows = await many(pool, `SELECT ${POST_COLS} FROM ${POST_FROM} WHERE ${NOT_BLOCKED('$1')} AND (to_tsvector('simple', p.body) @@ plainto_tsquery('simple', $2) OR $3 = ANY(p.hashtags)) ORDER BY p.created_at DESC LIMIT 30`, [userId, term, term.toLowerCase()]);
  return { items: await hydratePosts(rows, userId) };
}

export async function postsOf(viewerId: string, authorId: string, kind: string | undefined, cursor: string | undefined) {
  const rows = await many(pool, `SELECT ${POST_COLS} FROM ${POST_FROM} WHERE p.author_id=$2 AND ($3::text IS NULL OR p.kind=$3) AND ($4::timestamptz IS NULL OR p.created_at < $4) AND ${NOT_BLOCKED('$1')} ORDER BY p.created_at DESC LIMIT 18`, [viewerId, authorId, kind ?? null, cursor ?? null]);
  return { items: await hydratePosts(rows, viewerId), next: rows.length === 18 ? rows[17].created_at : null };
}
export async function savedPosts(userId: string, cursor?: string) {
  const rows = await many(pool, `SELECT ${POST_COLS}, s.created_at AS saved_at FROM saves s JOIN ${POST_FROM.replace('posts p', 'posts p ON p.id=s.post_id')} WHERE s.user_id=$1 AND ($2::timestamptz IS NULL OR s.created_at < $2) AND ${NOT_BLOCKED('$1')} ORDER BY s.created_at DESC LIMIT 18`, [userId, cursor ?? null]);
  return { items: await hydratePosts(rows, userId), next: rows.length === 18 ? rows[17].saved_at : null };
}
export async function getPost(viewerId: string, id: string) {
  const rows = await many(pool, `SELECT ${POST_COLS} FROM ${POST_FROM} WHERE p.id=$1 AND ${NOT_BLOCKED('$2')}`, [id, viewerId]);
  if (!rows.length) throw notFound('Post not found.');
  return (await hydratePosts(rows, viewerId))[0];
}

export async function report(userId: string, targetType: 'post' | 'comment' | 'user' | 'message', targetId: string, reason: string, details: string) {
  const table = { post: 'posts', comment: 'comments', user: 'users', message: 'messages' }[targetType];
  if (!(await one(pool, `SELECT 1 FROM ${table} WHERE id=$1`, [targetId]))) throw notFound('Nothing to report.');
  if (targetType === 'user' && targetId === userId) throw badRequest("You can't report yourself.");
  await pool.query(`INSERT INTO reports(reporter_id, target_type, target_id, reason, details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING`, [userId, targetType, targetId, reason, details]);
}
void AppError;
