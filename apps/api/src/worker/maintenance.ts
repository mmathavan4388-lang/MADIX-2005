import { pool, many } from '../db/pool.js';
import { notify } from '../services/notify.js';
import { getSetting } from '../lib/settings.js';

/** Periodic housekeeping: trial reminders/expiry notices, subscription expiry, expired sessions/tokens, stale pending files. */
export async function runMaintenance() {
  const t = await getSetting('trial');
  const ending = await many(pool, `UPDATE trials SET ending_notified=true WHERE ending_notified=false AND ends_at > now() AND ends_at < now() + make_interval(hours => $1) RETURNING user_id`, [t.endingNotifyHours]);
  for (const r of ending) await notify(r.user_id, 'trial_ending', 'Your free trial ends soon', 'Upgrade to keep creating with MADIX AI.', { action: 'upgrade' });
  const expired = await many(pool, `UPDATE trials SET expiry_notified=true WHERE expiry_notified=false AND ends_at <= now() RETURNING user_id`);
  for (const r of expired) await notify(r.user_id, 'trial_expired', 'Your free trial has ended', 'Choose a plan to continue using AI features.', { action: 'upgrade' });
  await pool.query(`UPDATE subscriptions SET status='expired' WHERE status='active' AND current_period_end <= now()`);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
  await pool.query(`UPDATE files SET status='failed' WHERE status='pending' AND created_at < now() - interval '1 day'`);
  await pool.query(`DELETE FROM analytics_events WHERE created_at < now() - interval '400 days'`);
}
