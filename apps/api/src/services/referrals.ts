import { pool, tx, one, many, Q } from '../db/pool.js';
import { getSetting } from '../lib/settings.js';
import { adjustCredits } from './credits.js';
import { notify } from './notify.js';
import { randomToken } from '../lib/crypto.js';
import { track } from '../lib/audit.js';

export async function getOrCreateCode(userId: string): Promise<string> {
  const ex = await one(pool, 'SELECT code FROM referral_codes WHERE user_id=$1', [userId]);
  if (ex) return ex.code;
  for (let i = 0; i < 5; i++) {
    const code = randomToken(6).replace(/[-_]/g, 'x').toUpperCase().slice(0, 8);
    const r = await pool.query('INSERT INTO referral_codes(user_id, code) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING code', [userId, code]);
    if (r.rowCount) return code;
    const again = await one(pool, 'SELECT code FROM referral_codes WHERE user_id=$1', [userId]);
    if (again) return again.code;
  }
  throw new Error('could not allocate referral code');
}

/** Called inside the registration transaction. Records a *pending* referral with abuse screening; never fails signup. */
export async function registerReferral(c: Q, newUser: any, code: string) {
  const cfg = await getSetting('referral');
  if (!cfg.enabled) return;
  const ref = await one(c, 'SELECT user_id FROM referral_codes WHERE code=$1', [code.toUpperCase()]);
  if (!ref || ref.user_id === newUser.id) return;
  const referrer = await one(c, 'SELECT id, status, device_hash, signup_ip_hash, email FROM users WHERE id=$1', [ref.user_id]);
  if (!referrer || referrer.status !== 'active') return;
  const flags: string[] = [];
  if (newUser.device_hash && newUser.device_hash === referrer.device_hash) flags.push('same_device_as_referrer');
  if (newUser.signup_ip_hash && newUser.signup_ip_hash === referrer.signup_ip_hash) flags.push('same_ip_as_referrer');
  if (newUser.device_hash) {
    const n = (await one(c, `SELECT count(*)::int n FROM users WHERE device_hash=$1 AND id<>$2`, [newUser.device_hash, newUser.id])).n;
    if (n >= cfg.maxPerDevice) flags.push('duplicate_device');
  }
  if (newUser.signup_ip_hash) {
    const n = (await one(c, `SELECT count(*)::int n FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 AND u.signup_ip_hash=$2`, [ref.user_id, newUser.signup_ip_hash])).n;
    if (n >= cfg.maxPerIp) flags.push('ip_limit');
  }
  const recent = (await one(c, `SELECT count(*)::int n FROM referrals WHERE referrer_id=$1 AND created_at > now() - interval '24 hours'`, [ref.user_id])).n;
  if (recent >= cfg.dailyInviteCap) flags.push('daily_cap');
  const total = (await one(c, `SELECT count(*)::int n FROM referrals WHERE referrer_id=$1 AND status='qualified'`, [ref.user_id])).n;
  if (total >= cfg.maxQualifiedPerReferrer) flags.push('referrer_cap');
  const hard = flags.some((f) => ['same_device_as_referrer', 'duplicate_device', 'ip_limit', 'daily_cap', 'referrer_cap'].includes(f));
  await c.query(`INSERT INTO referrals(referrer_id, referred_id, status, abuse_flags) VALUES ($1,$2,$3,$4)`, [ref.user_id, newUser.id, hard ? 'rejected' : 'pending', flags]);
}

/** After verified registration: qualify the referral if configured requirements are met, then evaluate reward rules. */
export async function onUserVerified(c: Q, referredId: string) {
  const r = await one(c, `SELECT * FROM referrals WHERE referred_id=$1 AND status='pending' FOR UPDATE`, [referredId]);
  if (!r) return;
  const cfg = await getSetting('referral');
  const u = await one(c, 'SELECT email_verified_at, created_at, status FROM users WHERE id=$1', [referredId]);
  if (!cfg.enabled) return;
  const expired = Date.now() - new Date(r.created_at).getTime() > cfg.expiryDays * 86400_000;
  if (expired || u.status !== 'active') { await c.query(`UPDATE referrals SET status='rejected', abuse_flags=array_append(abuse_flags,$2) WHERE id=$1`, [r.id, expired ? 'expired' : 'inactive']); return; }
  if (cfg.requireEmailVerified && !u.email_verified_at) return;
  if (Date.now() - new Date(u.created_at).getTime() < cfg.minAccountAgeHours * 3600_000) return; // sweeper will retry
  await c.query(`UPDATE referrals SET status='qualified', qualified_at=now() WHERE id=$1`, [r.id]);
  await evaluateRewards(c, r.referrer_id);
  void track(r.referrer_id, 'referral_qualified');
}

export async function evaluateRewards(c: Q, referrerId: string) {
  const count = (await one(c, `SELECT count(*)::int n FROM referrals WHERE referrer_id=$1 AND status='qualified'`, [referrerId])).n;
  const rules = await many(c, `SELECT * FROM referral_rules WHERE active ORDER BY required_count`);
  for (const rule of rules) {
    const due = Math.min(Math.floor(count / rule.required_count), rule.max_awards_per_user);
    for (let k = 1; k <= due; k++) {
      const ins = await c.query(`INSERT INTO referral_rewards(user_id, rule_id, award_no) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [referrerId, rule.id, k]);
      if (!ins.rowCount) continue;
      if (rule.reward_type === 'feature') {
        await c.query(`INSERT INTO feature_unlocks(user_id, feature_key, source, source_ref, expires_at)
          VALUES ($1,$2,'referral',$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4) END) ON CONFLICT DO NOTHING`,
          [referrerId, rule.feature_key, `${rule.id}:${k}`, rule.unlock_days]);
      } else {
        await adjustCredits(c, referrerId, rule.credits, 'referral_reward', { type: 'referral_rule', id: rule.id }, `refrw:${referrerId}:${rule.id}:${k}`);
      }
      await notify(referrerId, 'referral_reward', 'Referral reward unlocked 🎉', rule.label || 'A friend joined MADIX — your reward is ready.', { ruleId: rule.id }, c);
    }
  }
}

/** Worker sweep: qualify referrals that were waiting on min account age; reject expired ones. */
export async function sweepReferrals() {
  const cfg = await getSetting('referral');
  await pool.query(`UPDATE referrals SET status='rejected', abuse_flags=array_append(abuse_flags,'expired') WHERE status='pending' AND created_at < now() - make_interval(days => $1)`, [cfg.expiryDays]);
  const pend = await many(pool, `SELECT referred_id FROM referrals WHERE status='pending' LIMIT 200`);
  for (const p of pend) await tx((c) => onUserVerified(c, p.referred_id));
}

export async function referralSummary(userId: string) {
  const code = await getOrCreateCode(userId);
  const counts = await one(pool, `SELECT count(*) FILTER (WHERE status='qualified')::int qualified, count(*) FILTER (WHERE status='pending')::int pending FROM referrals WHERE referrer_id=$1`, [userId]);
  const rules = await many(pool, `SELECT id, required_count, reward_type, feature_key, credits, unlock_days, max_awards_per_user, label FROM referral_rules WHERE active ORDER BY required_count`);
  const granted = await many(pool, `SELECT rule_id, count(*)::int n FROM referral_rewards WHERE user_id=$1 AND status='granted' GROUP BY rule_id`, [userId]);
  const cfg = await getSetting('referral');
  return { enabled: cfg.enabled, code, link: `${(await import('../config.js')).config.PUBLIC_WEB_URL}/register?ref=${code}`, ...counts, rules: rules.map((r) => ({ ...r, awarded: granted.find((g) => g.rule_id === r.id)?.n ?? 0 })) };
}
