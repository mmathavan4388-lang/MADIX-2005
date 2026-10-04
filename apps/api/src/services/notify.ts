import { pool, Q, many } from '../db/pool.js';
import { config } from '../config.js';
import { emit } from './events.js';

export type NotifType = 'follow' | 'like' | 'comment' | 'message' | 'ai_complete' | 'payment_success' | 'trial_ending' | 'trial_expired'
  | 'subscription_activated' | 'announcement' | 'referral_reward' | 'moderation';

/** In-app notification + best-effort push. Never throws into the caller's business flow. */
export async function notify(userId: string, type: NotifType, title: string, body = '', data: Record<string, unknown> = {}, q: Q = pool) {
  try {
    await q.query('INSERT INTO notifications(user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5)', [userId, type, title, body, data]);
  } catch (e) { console.error('notify failed', e); return; }
  void emit([userId], 'notification', { type });
  void push([userId], title, body, data);
}

export async function push(userIds: string[], title: string, body: string, data: Record<string, unknown> = {}) {
  if (!config.FCM_SERVER_KEY || config.NODE_ENV === 'test') return;
  try {
    const rows = await many<{ token: string }>(pool, 'SELECT token FROM push_tokens WHERE user_id = ANY($1)', [userIds]);
    if (!rows.length) return;
    // FCM legacy HTTP API (multicast ≤ 500 tokens per request)
    for (let i = 0; i < rows.length; i += 500) {
      const res = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `key=${config.FCM_SERVER_KEY}` },
        body: JSON.stringify({ registration_ids: rows.slice(i, i + 500).map((r) => r.token), notification: { title, body }, data }),
      });
      if (!res.ok) console.error('push failed', res.status);
    }
  } catch (e) { console.error('push error', e); }
}

export async function broadcast(title: string, body: string) {
  await pool.query(`INSERT INTO notifications(user_id,type,title,body) SELECT id,'announcement',$1,$2 FROM users WHERE status='active'`, [title, body]);
  const ids = await many<{ id: string }>(pool, `SELECT user_id AS id FROM push_tokens GROUP BY user_id`);
  void push(ids.map((r) => r.id), title, body);
}
