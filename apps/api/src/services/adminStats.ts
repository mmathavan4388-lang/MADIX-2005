import { pool, one, many } from '../db/pool.js';
import { config } from '../config.js';
import { storage } from '../storage/index.js';
import { providersFor } from '../ai/registry.js';

export async function dashboard() {
  const n = (sql: string, p: any[] = []) => one(pool, sql, p).then((r) => Object.values(r!)[0] as number);
  const [totalUsers, activeToday, active7, active30, new7, trialUsers, paidUsers, revenue30, revenueAll, paymentsOk, paymentsFailed, gens, imgs, vids, creditsSpent30, storageBytes, openReports, pendingJobs, failedJobs] = await Promise.all([
    n(`SELECT count(*)::int FROM users WHERE role='user'`),
    n(`SELECT count(DISTINCT user_id)::int FROM analytics_events WHERE day = current_date AND user_id IS NOT NULL`),
    n(`SELECT count(DISTINCT user_id)::int FROM analytics_events WHERE day > current_date - 7 AND user_id IS NOT NULL`),
    n(`SELECT count(DISTINCT user_id)::int FROM analytics_events WHERE day > current_date - 30 AND user_id IS NOT NULL`),
    n(`SELECT count(*)::int FROM users WHERE role='user' AND created_at > now() - interval '7 days'`),
    n(`SELECT count(*)::int FROM trials WHERE ends_at > now()`),
    n(`SELECT count(DISTINCT user_id)::int FROM subscriptions WHERE status='active' AND current_period_end > now()`),
    n(`SELECT COALESCE(sum(amount_minor),0)::bigint FROM payments WHERE status='paid' AND paid_at > now() - interval '30 days'`),
    n(`SELECT COALESCE(sum(amount_minor),0)::bigint FROM payments WHERE status='paid'`),
    n(`SELECT count(*)::int FROM payments WHERE status='paid'`),
    n(`SELECT count(*)::int FROM payments WHERE status='failed'`),
    n(`SELECT count(*)::int FROM generations`),
    n(`SELECT count(*)::int FROM generations WHERE kind IN ('image','photo_edit')`),
    n(`SELECT count(*)::int FROM generations WHERE kind IN ('video','video_edit')`),
    n(`SELECT COALESCE(-sum(delta),0)::bigint FROM credit_ledger WHERE delta < 0 AND reason LIKE 'spend:%' AND created_at > now() - interval '30 days'`),
    n(`SELECT COALESCE(sum(size_bytes),0)::bigint FROM files WHERE status='ready'`),
    n(`SELECT count(*)::int FROM reports WHERE status='open'`),
    n(`SELECT count(*)::int FROM jobs WHERE status IN ('queued','processing')`),
    n(`SELECT count(*)::int FROM jobs WHERE status='failed' AND finished_at > now() - interval '24 hours'`),
  ]);
  return {
    users: { total: totalUsers, activeToday, active7, active30, new7, trial: trialUsers, paid: paidUsers },
    revenue: { last30Minor: revenue30, totalMinor: revenueAll, payments: paymentsOk, failedPayments: paymentsFailed },
    ai: { generations: gens, images: imgs, videos: vids, creditsSpent30 },
    storageBytes, openReports, queue: { pending: pendingJobs, failed24h: failedJobs },
  };
}

export async function analytics(days: number) {
  const daily = await many(pool, `SELECT d::date AS day,
      (SELECT count(*)::int FROM users u WHERE u.created_at::date = d::date AND u.role='user') AS signups,
      (SELECT count(DISTINCT user_id)::int FROM analytics_events e WHERE e.day = d::date AND e.user_id IS NOT NULL) AS dau,
      (SELECT count(*)::int FROM generations g WHERE g.created_at::date = d::date) AS generations,
      (SELECT COALESCE(sum(amount_minor),0)::bigint FROM payments p WHERE p.status='paid' AND p.paid_at::date = d::date) AS revenue_minor
    FROM generate_series(current_date - ($1::int - 1), current_date, '1 day') d ORDER BY d`, [days]);
  const tools = await many(pool, `SELECT kind AS name, count(*)::int AS n FROM generations WHERE created_at > now() - make_interval(days => $1) GROUP BY kind ORDER BY n DESC`, [days]);
  const chat = (await one(pool, `SELECT count(*)::int n FROM analytics_events WHERE name='ai_chat' AND day > current_date - $1::int`, [days])).n;
  const features = await many(pool, `SELECT name, count(*)::int AS n FROM analytics_events WHERE day > current_date - $1::int AND name <> 'login' GROUP BY name ORDER BY n DESC LIMIT 12`, [days]);
  const trial = await one(pool, `SELECT count(*)::int started, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=t.user_id))::int converted FROM trials t WHERE t.started_at > now() - make_interval(days => $1)`, [days]);
  const verified = (await one(pool, `SELECT count(*)::int n FROM users WHERE email_verified_at IS NOT NULL AND created_at > now() - make_interval(days => $1)`, [days])).n;
  const registered = (await one(pool, `SELECT count(*)::int n FROM users WHERE role='user' AND created_at > now() - make_interval(days => $1)`, [days])).n;
  const referrals = await one(pool, `SELECT count(*)::int total, count(*) FILTER (WHERE status='qualified')::int qualified, count(*) FILTER (WHERE status='rejected')::int rejected FROM referrals WHERE created_at > now() - make_interval(days => $1)`, [days]);
  // D1/D7 retention for signup cohorts in range
  const retention = await one(pool, `WITH c AS (SELECT id, created_at::date d0 FROM users WHERE role='user' AND created_at > now() - make_interval(days => $1) AND created_at < now() - interval '1 day')
    SELECT count(*)::int cohort,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id=c.id AND e.day = c.d0 + 1))::int d1,
      count(*) FILTER (WHERE c.d0 <= current_date - 7 AND EXISTS (SELECT 1 FROM analytics_events e WHERE e.user_id=c.id AND e.day BETWEEN c.d0 + 7 AND c.d0 + 8))::int d7,
      count(*) FILTER (WHERE c.d0 <= current_date - 7)::int d7_eligible FROM c`, [days]);
  const paidConv = await one(pool, `SELECT count(DISTINCT user_id)::int paid FROM payments WHERE status='paid' AND created_at > now() - make_interval(days => $1)`, [days]);
  return { daily, tools, chatMessages: chat, popularFeatures: features, trialConversion: trial, verificationRate: { registered, verified }, referrals, retention, paidUsersInRange: paidConv.paid };
}

export async function systemStatus() {
  const db = await pool.query('SELECT 1').then(() => true, () => false);
  const providers: Record<string, number> = {};
  for (const cap of ['text', 'image', 'image_edit', 'video', 'voice', 'embedding'] as const) providers[cap] = (await providersFor(cap)).length;
  let storageOk = false; try { storage(); storageOk = true; } catch { /* misconfigured */ }
  const oldest = await one(pool, `SELECT EXTRACT(EPOCH FROM now() - min(created_at))::int AS age FROM jobs WHERE status='queued'`);
  return {
    database: db, storage: { driver: config.STORAGE_DRIVER, ok: storageOk, cdn: !!config.CDN_BASE_URL }, providers,
    payments: { razorpayConfigured: !!(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET), webhookConfigured: !!config.RAZORPAY_WEBHOOK_SECRET },
    email: !!config.SMTP_URL, push: !!config.FCM_SERVER_KEY, oldestQueuedJobSec: oldest?.age ?? 0, env: config.NODE_ENV,
  };
}
