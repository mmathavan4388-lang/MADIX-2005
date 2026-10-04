import { pool, one, many } from '../db/pool.js';
import { getEntitlement, getBalance } from './credits.js';
import { getSetting } from '../lib/settings.js';
import { fileDto } from '../lib/files.js';
import { publicUser } from './auth.js';

export async function accountSummary(userId: string) {
  const u = await one(pool, 'SELECT * FROM users WHERE id=$1', [userId]);
  const p = await one(pool, 'SELECT * FROM profiles WHERE user_id=$1', [userId]);
  const [ent, balance, trialRow, trialCfg] = await Promise.all([getEntitlement(userId), getBalance(userId), one(pool, 'SELECT * FROM trials WHERE user_id=$1', [userId]), getSetting('trial')]);
  const avatar = p.avatar_file_id ? await fileDto(await one(pool, 'SELECT * FROM files WHERE id=$1', [p.avatar_file_id])) : null;
  let trial: any = null;
  if (trialRow) {
    const usage = await many(pool, `SELECT kind, count(*)::int n FROM generations WHERE user_id=$1 AND trial_counted AND status NOT IN ('failed','cancelled') AND created_at >= $2 GROUP BY kind`, [userId, trialRow.started_at]);
    const chat = (await one(pool, `SELECT count(*)::int n FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 AND m.role='user' AND m.created_at >= $2`, [userId, trialRow.started_at])).n;
    const used: Record<string, number> = { chat, image: 0, video: 0, promo: 0, edit: 0 };
    for (const r of usage) used[r.kind === 'photo_edit' || r.kind === 'video_edit' ? 'edit' : r.kind] += r.n;
    const limits = trialRow.limits as Record<string, number>;
    trial = {
      active: new Date(trialRow.ends_at) > new Date(), startedAt: trialRow.started_at, endsAt: trialRow.ends_at,
      msRemaining: Math.max(0, new Date(trialRow.ends_at).getTime() - Date.now()),
      remaining: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Math.max(0, v - (used[k] ?? 0))])), limits,
    };
  }
  return {
    user: { ...publicUser(u), displayName: p.display_name, bio: p.bio, interests: p.interests, avatar },
    credits: balance,
    access: { trialActive: ent.trialActive, subscriptionActive: ent.subscriptionActive, subscriptionEndsAt: ent.subscriptionEndsAt, planCode: ent.planCode, features: [...ent.features] },
    trial, trialEligible: trialCfg.enabled && !trialRow,
    counts: { followers: p.followers_count, following: p.following_count, posts: p.posts_count },
  };
}
