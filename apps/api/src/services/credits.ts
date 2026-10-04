import type { PoolClient } from 'pg';
import { pool, tx, one, many, Q } from '../db/pool.js';
import { getSetting } from '../lib/settings.js';
import { insufficientCredits, featureLocked, AppError } from '../lib/errors.js';

export type Feature = 'chat' | 'image' | 'video' | 'promo' | 'edit';

/** Atomically change a wallet. Positive = grant, negative = spend. Idempotent on idempotencyKey. */
export async function adjustCredits(c: Q, userId: string, delta: number, reason: string, ref?: { type: string; id: string }, idempotencyKey?: string): Promise<{ balance: number; applied: boolean }> {
  if (idempotencyKey) {
    const dup = await one(c, 'SELECT balance_after FROM credit_ledger WHERE idempotency_key=$1', [idempotencyKey]);
    if (dup) return { balance: dup.balance_after, applied: false };
  }
  await c.query('INSERT INTO credit_wallets(user_id, balance) VALUES ($1,0) ON CONFLICT DO NOTHING', [userId]);
  const w = await one(c, 'SELECT balance FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [userId]);
  if (w.balance + delta < 0) throw insufficientCredits(-delta, w.balance);
  const balance = w.balance + delta;
  await c.query('UPDATE credit_wallets SET balance=$2 WHERE user_id=$1', [userId, balance]);
  await c.query('INSERT INTO credit_ledger(user_id,delta,balance_after,reason,ref_type,ref_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId, delta, balance, reason, ref?.type ?? null, ref?.id ?? null, idempotencyKey ?? null]);
  return { balance, applied: true };
}

export async function getBalance(userId: string, q: Q = pool): Promise<number> {
  return (await one(q, 'SELECT balance FROM credit_wallets WHERE user_id=$1', [userId]))?.balance ?? 0;
}

export async function costOf(key: string): Promise<number> {
  const costs = await getSetting('credit_costs');
  if (!(key in costs)) throw new AppError(500, 'cost_missing', 'Pricing is not configured for this action.');
  return costs[key];
}

export interface Entitlement { trialActive: boolean; trialEndsAt: string | null; subscriptionActive: boolean; subscriptionEndsAt: string | null; planCode: string | null; unlocked: string[]; }

/** Single source of truth for what a user may use. Computed from DB state only. */
export async function getEntitlement(userId: string, q: Q = pool): Promise<Entitlement & { features: Set<string> }> {
  const trial = await one(q, `SELECT ends_at FROM trials WHERE user_id=$1 AND ends_at > now()`, [userId]);
  const sub = await one(q, `SELECT s.current_period_end, p.code, p.features FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    WHERE s.user_id=$1 AND s.status='active' AND s.current_period_end > now() ORDER BY s.current_period_end DESC LIMIT 1`, [userId]);
  const unlocks = await many(q, `SELECT feature_key FROM feature_unlocks WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > now())`, [userId]);
  const ent = await getSetting('entitlements');
  const features = new Set<string>(unlocks.map((u) => u.feature_key));
  if (sub) for (const f of sub.features) features.add(f);
  return {
    trialActive: !!trial, trialEndsAt: trial?.ends_at ?? null,
    subscriptionActive: !!sub, subscriptionEndsAt: sub?.current_period_end ?? null, planCode: sub?.code ?? null,
    unlocked: [...features], features: ent.freeTierCredits > 0 ? new Set([...features, ...ent.features]) : features,
  };
}

/**
 * Authorise + charge a billable action in ONE transaction. Rules, all server-side:
 *  1. feature kill-switch from Admin
 *  2. user must have paid feature access (plan/unlock) OR an active trial with remaining per-feature quota
 *  3. credits are debited up-front (hold); refundCredits() returns them if the work fails/cancels
 */
export async function authorizeAndCharge(c: PoolClient, userId: string, feature: Feature, costKey: string, ref: { type: string; id: string }, opts: { multiplier?: number } = {}) {
  const ent = await getSetting('entitlements');
  if (ent.featureEnabled[feature] === false) throw new AppError(503, 'feature_disabled', 'This feature is temporarily unavailable.');
  const access = await getEntitlement(userId, c);
  let trialCounted = false;
  if (!access.features.has(feature)) {
    if (!access.trialActive) throw featureLocked(feature, 'trial_expired_or_no_plan');
    const trial = await one(c, 'SELECT limits FROM trials WHERE user_id=$1 FOR UPDATE', [userId]);
    const cap = trial.limits?.[feature];
    if (cap !== undefined) {
      const used = await usageDuringTrial(c, userId, feature);
      if (used >= cap) throw featureLocked(feature, 'trial_limit_reached');
    }
    trialCounted = true;
  }
  const cost = (await costOf(costKey)) * (opts.multiplier ?? 1);
  let balance = await getBalance(userId, c);
  if (cost > 0) balance = (await adjustCredits(c, userId, -cost, `spend:${costKey}`, ref)).balance;
  return { cost, balance, trialCounted };
}

async function usageDuringTrial(c: Q, userId: string, feature: Feature): Promise<number> {
  const kinds: Record<Feature, string[]> = { chat: [], image: ['image'], video: ['video'], promo: ['promo'], edit: ['photo_edit', 'video_edit'] };
  if (feature === 'chat') {
    return (await one(c, `SELECT count(*)::int AS n FROM ai_messages m JOIN ai_conversations cv ON cv.id=m.conversation_id
      WHERE cv.user_id=$1 AND m.role='user' AND m.created_at >= (SELECT started_at FROM trials WHERE user_id=$1)`, [userId])).n;
  }
  return (await one(c, `SELECT count(*)::int AS n FROM generations WHERE user_id=$1 AND kind = ANY($2) AND trial_counted AND status <> 'failed' AND status <> 'cancelled'`, [userId, kinds[feature]])).n;
}

export async function refundCredits(userId: string, amount: number, reason: string, ref: { type: string; id: string }) {
  if (amount <= 0) return;
  await tx((c) => adjustCredits(c, userId, amount, reason, ref, `refund:${ref.type}:${ref.id}`));
}

/** Grant the free trial exactly once, at verified registration. Admin-configurable. */
export async function activateTrial(c: Q, userId: string): Promise<boolean> {
  const t = await getSetting('trial');
  if (!t.enabled || t.durationDays <= 0) return false;
  const r = await c.query(`INSERT INTO trials(user_id, ends_at, credits_granted, limits)
    VALUES ($1, now() + make_interval(days => $2), $3, $4) ON CONFLICT DO NOTHING RETURNING user_id`,
    [userId, t.durationDays, t.freeCredits, t.featureLimits]);
  if (!r.rowCount) return false;
  if (t.freeCredits > 0) await adjustCredits(c, userId, t.freeCredits, 'trial_grant', { type: 'trial', id: userId }, `trial:${userId}`);
  return true;
}
