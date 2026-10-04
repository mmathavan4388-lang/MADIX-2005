import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, one, many } from '../db/pool.js';
import { adminLogin } from '../services/auth.js';
import { audit } from '../lib/audit.js';
import { getDraft, saveDraft, publish, discardDraft, SETTING_KEYS, settingSchemas, type SettingKey } from '../lib/settings.js';
import { dashboard, analytics, systemStatus } from '../services/adminStats.js';
import { adjustCredits } from '../services/credits.js';
import { deletePost, deleteComment } from '../services/social.js';
import { notify, broadcast } from '../services/notify.js';
import { clearProviderCache, providersFor } from '../ai/registry.js';
import { badRequest, notFound } from '../lib/errors.js';
import { fileDtos } from '../lib/files.js';
import { hashIp } from '../lib/crypto.js';
import { logout } from '../services/auth.js';

const idp = z.object({ id: z.string().uuid() });
const page = z.object({ cursor: z.string().optional() });

export async function adminRoutes(app: FastifyInstance) {
  // 2FA login — stricter rate limit; there is no public path to obtain an admin account.
  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1).max(128), totp: z.string().length(6) }).parse(req.body);
    return adminLogin(b.email, b.password, b.totp, { ip: req.ip, ua: req.headers['user-agent'] });
  });

  // ───────────── Moderator-accessible: reports & moderation ─────────────
  await app.register(async (mod) => {
    mod.addHook('preHandler', app.modOnly);

    mod.get('/reports', async (req) => {
      const q = z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), type: z.string().optional() }).merge(page).parse(req.query);
      const rows = await many(pool, `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at, u.username AS reporter,
          CASE r.target_type WHEN 'post' THEN (SELECT json_build_object('body', p.body, 'kind', p.kind, 'author', au.username, 'authorId', p.author_id, 'removed', p.status='removed', 'fileId', p.file_id) FROM posts p JOIN users au ON au.id=p.author_id WHERE p.id=r.target_id)
            WHEN 'comment' THEN (SELECT json_build_object('body', c.body, 'author', au.username, 'authorId', c.author_id) FROM comments c JOIN users au ON au.id=c.author_id WHERE c.id=r.target_id)
            WHEN 'user' THEN (SELECT json_build_object('username', tu.username, 'status', tu.status) FROM users tu WHERE tu.id=r.target_id)
            WHEN 'message' THEN (SELECT json_build_object('body', m.body, 'author', au.username, 'authorId', m.sender_id) FROM messages m JOIN users au ON au.id=m.sender_id WHERE m.id=r.target_id) END AS target,
          (SELECT count(*)::int FROM reports r2 WHERE r2.target_type=r.target_type AND r2.target_id=r.target_id) AS report_count
        FROM reports r JOIN users u ON u.id=r.reporter_id WHERE r.status=$1 AND ($2::text IS NULL OR r.target_type=$2) AND ($3::timestamptz IS NULL OR r.created_at < $3) ORDER BY r.created_at DESC LIMIT 30`, [q.status, q.type ?? null, q.cursor ?? null]);
      const files = await fileDtos(rows.map((r) => r.target?.fileId));
      return { items: rows.map((r) => ({ ...r, target: r.target && { ...r.target, media: r.target.fileId ? files.get(r.target.fileId) ?? null : null } })), next: rows.length === 30 ? rows[29].created_at : null };
    });

    mod.post('/reports/:id/action', async (req) => {
      const { id } = idp.parse(req.params);
      const b = z.object({ action: z.enum(['dismiss', 'remove_content', 'suspend_user', 'block_user']), note: z.string().max(300).default(''), suspendDays: z.number().int().min(1).max(365).default(7) }).parse(req.body);
      const r = await one(pool, 'SELECT * FROM reports WHERE id=$1', [id]);
      if (!r) throw notFound();
      let authorId: string | null = null;
      if (r.target_type === 'user') authorId = r.target_id;
      else if (r.target_type === 'post') authorId = (await one(pool, 'SELECT author_id FROM posts WHERE id=$1', [r.target_id]))?.author_id ?? null;
      else if (r.target_type === 'comment') authorId = (await one(pool, 'SELECT author_id FROM comments WHERE id=$1', [r.target_id]))?.author_id ?? null;
      else authorId = (await one(pool, 'SELECT sender_id FROM messages WHERE id=$1', [r.target_id]))?.sender_id ?? null;
      const actor = req.user!.id;
      if (b.action === 'remove_content') {
        if (r.target_type === 'post') await deletePost(actor, r.target_id, true).catch(() => {});
        else if (r.target_type === 'comment') await deleteComment(actor, r.target_id, true).catch(() => {});
        else if (r.target_type === 'message') await pool.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [r.target_id]);
        else throw badRequest('Choose suspend or block for users.');
        if (authorId) await notify(authorId, 'moderation', 'Your content was removed', 'It violated MADIX community guidelines.');
      }
      if ((b.action === 'suspend_user' || b.action === 'block_user') && authorId) {
        const target = await one(pool, 'SELECT role FROM users WHERE id=$1', [authorId]);
        if (target?.role !== 'user') throw badRequest('Staff accounts cannot be moderated here.');
        await pool.query(`UPDATE users SET status=$2, suspended_until = CASE WHEN $2='suspended' THEN now() + make_interval(days => $3) ELSE NULL END WHERE id=$1`, [authorId, b.action === 'block_user' ? 'blocked' : 'suspended', b.suspendDays]);
        await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [authorId]);
      }
      await tx(async (c) => {
        await c.query(`UPDATE reports SET status=$1, handled_by=$2 WHERE target_type=$3 AND target_id=$4 AND status='open'`, [b.action === 'dismiss' ? 'dismissed' : 'actioned', actor, r.target_type, r.target_id]);
        await c.query(`INSERT INTO moderation_logs(actor_id, action, target_type, target_id, note) VALUES ($1,$2,$3,$4,$5)`, [actor, b.action, r.target_type, r.target_id, b.note]);
      });
      return { ok: true };
    });
    mod.get('/moderation-logs', async (req) => {
      const q = page.parse(req.query);
      return { items: await many(pool, `SELECT l.id, l.action, l.target_type, l.target_id, l.note, l.created_at, u.username AS actor FROM moderation_logs l LEFT JOIN users u ON u.id=l.actor_id WHERE ($1::bigint IS NULL OR l.id < $1) ORDER BY l.id DESC LIMIT 50`, [q.cursor ? Number(q.cursor) : null]) };
    });
  });

  // ───────────── Owner-only ─────────────
  await app.register(async (adm) => {
    adm.addHook('preHandler', app.adminOnly);
    const A = (req: any, action: string, target?: string, meta: any = {}) => audit(req.user.id, action, target, meta, hashIp(req.ip));

    adm.post('/auth/logout', async (req) => { await logout(undefined, req.user!.sid); await A(req, 'admin.logout'); return { ok: true }; });
    adm.get('/me', async (req) => ({ id: req.user!.id, role: req.user!.role }));
    adm.get('/dashboard', async () => dashboard());
    adm.get('/analytics', async (req) => analytics(z.object({ days: z.coerce.number().int().min(7).max(180).default(30) }).parse(req.query).days));
    adm.get('/system', async () => systemStatus());
    adm.get('/audit-logs', async (req) => {
      const q = page.parse(req.query);
      return { items: await many(pool, `SELECT a.id, a.action, a.target, a.meta, a.created_at, u.username AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 100`, [q.cursor ? Number(q.cursor) : null]) };
    });

    // Users
    adm.get('/users', async (req) => {
      const q = z.object({ q: z.string().max(80).optional(), status: z.string().optional() }).merge(page).parse(req.query);
      const rows = await many(pool, `SELECT u.id, u.email, u.username, u.status, u.role, u.created_at, u.email_verified_at, COALESCE(w.balance,0) AS credits,
          EXISTS (SELECT 1 FROM trials t WHERE t.user_id=u.id AND t.ends_at > now()) AS trial_active,
          EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND s.status='active' AND s.current_period_end > now()) AS paid
        FROM users u LEFT JOIN credit_wallets w ON w.user_id=u.id
        WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR u.status=$2) AND ($3::timestamptz IS NULL OR u.created_at < $3)
        ORDER BY u.created_at DESC LIMIT 30`, [q.q ?? null, q.status ?? null, q.cursor ?? null]);
      return { items: rows, next: rows.length === 30 ? rows[29].created_at : null };
    });
    adm.post('/users/:id/status', async (req) => {
      const { id } = idp.parse(req.params);
      const b = z.object({ status: z.enum(['active', 'suspended', 'blocked']), days: z.number().int().min(1).max(365).optional(), note: z.string().max(300).default('') }).parse(req.body);
      const t = await one(pool, 'SELECT role FROM users WHERE id=$1', [id]);
      if (!t) throw notFound(); if (t.role === 'admin') throw badRequest('The owner account cannot be restricted.');
      await pool.query(`UPDATE users SET status=$2, suspended_until = CASE WHEN $2='suspended' THEN now() + make_interval(days => $3) ELSE NULL END WHERE id=$1`, [id, b.status, b.days ?? 7]);
      if (b.status !== 'active') await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await pool.query(`INSERT INTO moderation_logs(actor_id, action, target_type, target_id, note) VALUES ($1,$2,'user',$3,$4)`, [req.user!.id, `status:${b.status}`, id, b.note]);
      await A(req, 'user.status', id, b); return { ok: true };
    });
    adm.post('/users/:id/credits', async (req) => {
      const { id } = idp.parse(req.params); const b = z.object({ amount: z.number().int().min(-100000).max(100000).refine((n) => n !== 0), reason: z.string().min(3).max(200) }).parse(req.body);
      const r = await tx((c) => adjustCredits(c, id, b.amount, 'admin_adjustment', { type: 'admin', id: req.user!.id }));
      await A(req, 'user.credits', id, b); return r;
    });
    adm.post('/users/:id/unlock', async (req) => {
      const { id } = idp.parse(req.params); const b = z.object({ feature: z.enum(['chat', 'image', 'video', 'promo', 'edit']), days: z.number().int().min(1).max(3650).optional() }).parse(req.body);
      await pool.query(`INSERT INTO feature_unlocks(user_id, feature_key, source, source_ref, expires_at) VALUES ($1,$2,'admin',$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4) END) ON CONFLICT (user_id, feature_key, source, source_ref) DO UPDATE SET expires_at=EXCLUDED.expires_at`, [id, b.feature, req.user!.id, b.days ?? null]);
      await A(req, 'user.unlock', id, b); return { ok: true };
    });

    // Config (draft → publish)
    adm.get('/settings/:key', async (req) => {
      const key = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]).parse((req.params as any).key);
      return getDraft(key);
    });
    adm.put('/settings/:key', async (req) => {
      const key = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]).parse((req.params as any).key);
      const value = settingSchemas[key].parse(req.body);
      const cur = (await getDraft(key)).draft;
      const merged = Array.isArray(value) || typeof value !== 'object' ? value : { ...(cur as object), ...(value as object) };
      await saveDraft(key, merged); await A(req, 'settings.draft', key);
      return getDraft(key);
    });
    adm.post('/settings/:key/publish', async (req) => {
      const key = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]).parse((req.params as any).key);
      const v = await publish(key); if (v === null) throw badRequest('Nothing to publish.', 'no_draft');
      await A(req, 'settings.publish', key, { version: v }); return { version: v };
    });
    adm.delete('/settings/:key/draft', async (req) => {
      const key = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]).parse((req.params as any).key);
      await discardDraft(key); await A(req, 'settings.discard', key); return { ok: true };
    });
    adm.get('/branding/preview', async () => {
      const draft = (await getDraft('branding')).draft as any;
      const files = await fileDtos([draft.logoFileId, draft.splashLogoFileId, draft.loginLogoFileId, draft.iconFileId]);
      return { draft, urls: Object.fromEntries(['logoFileId', 'splashLogoFileId', 'loginLogoFileId', 'iconFileId'].map((k) => [k, files.get(draft[k])?.url ?? null])) };
    });

    // Plans & pricing
    const planBody = z.object({
      code: z.string().regex(/^[a-z0-9_-]{2,40}$/), name: z.string().min(1).max(60), kind: z.enum(['subscription', 'credit_pack', 'promo']), interval: z.enum(['month', 'year']).nullable().default(null),
      priceMinor: z.number().int().min(0).max(100_000_000), compareAtMinor: z.number().int().min(0).nullable().default(null), currency: z.string().length(3).default('INR'), credits: z.number().int().min(0).max(10_000_000).default(0),
      features: z.array(z.enum(['chat', 'image', 'video', 'promo', 'edit'])).default([]), description: z.string().max(300).default(''), badge: z.string().max(20).nullable().default(null), sort: z.number().int().default(100), active: z.boolean().default(true),
      startsAt: z.string().datetime().nullable().default(null), endsAt: z.string().datetime().nullable().default(null),
    }).refine((p) => (p.kind === 'subscription') === (p.interval !== null), 'Subscriptions need an interval; packs must not have one.');
    adm.get('/plans', async () => ({ items: await many(pool, 'SELECT * FROM plans ORDER BY sort, price_minor') }));
    adm.post('/plans', async (req, reply) => {
      const p = planBody.parse(req.body);
      const r = await one(pool, `INSERT INTO plans(code,name,kind,interval,price_minor,compare_at_minor,currency,credits,features,description,badge,sort,active,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [p.code, p.name, p.kind, p.interval, p.priceMinor, p.compareAtMinor, p.currency, p.credits, p.features, p.description, p.badge, p.sort, p.active, p.startsAt, p.endsAt]).catch((e) => { if (e.code === '23505') throw badRequest('A plan with this code already exists.'); throw e; });
      await A(req, 'plan.create', r.id, p); return reply.status(201).send(r);
    });
    adm.put('/plans/:id', async (req) => {
      const { id } = idp.parse(req.params); const p = planBody.parse(req.body);
      const r = await one(pool, `UPDATE plans SET code=$2,name=$3,kind=$4,interval=$5,price_minor=$6,compare_at_minor=$7,currency=$8,credits=$9,features=$10,description=$11,badge=$12,sort=$13,active=$14,starts_at=$15,ends_at=$16 WHERE id=$1 RETURNING *`,
        [id, p.code, p.name, p.kind, p.interval, p.priceMinor, p.compareAtMinor, p.currency, p.credits, p.features, p.description, p.badge, p.sort, p.active, p.startsAt, p.endsAt]);
      if (!r) throw notFound(); await A(req, 'plan.update', id, p); return r; // takes effect immediately in /plans and checkout
    });
    adm.delete('/plans/:id', async (req) => {
      const { id } = idp.parse(req.params);
      await pool.query('UPDATE plans SET active=false WHERE id=$1', [id]); // never hard-delete: payments reference plans
      await A(req, 'plan.disable', id); return { ok: true };
    });

    // Coupons
    const couponBody = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{3,30}$/), percentOff: z.number().int().min(1).max(100).nullable().default(null), amountOffMinor: z.number().int().min(1).nullable().default(null), maxRedemptions: z.number().int().min(1).nullable().default(null),
      planCodes: z.array(z.string()).nullable().default(null), startsAt: z.string().datetime().nullable().default(null), endsAt: z.string().datetime().nullable().default(null), active: z.boolean().default(true) })
      .refine((c) => (c.percentOff === null) !== (c.amountOffMinor === null), 'Set either a percentage or a fixed amount.');
    adm.get('/coupons', async () => ({ items: await many(pool, 'SELECT * FROM coupons ORDER BY created_at DESC') }));
    adm.post('/coupons', async (req, reply) => {
      const c = couponBody.parse(req.body);
      const r = await one(pool, `INSERT INTO coupons(code,percent_off,amount_off_minor,max_redemptions,plan_codes,starts_at,ends_at,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [c.code, c.percentOff, c.amountOffMinor, c.maxRedemptions, c.planCodes, c.startsAt, c.endsAt, c.active]).catch((e) => { if (e.code === '23505') throw badRequest('Coupon code already exists.'); throw e; });
      await A(req, 'coupon.create', r.id, c); return reply.status(201).send(r);
    });
    adm.put('/coupons/:id', async (req) => {
      const { id } = idp.parse(req.params); const c = couponBody.parse(req.body);
      const r = await one(pool, `UPDATE coupons SET code=$2,percent_off=$3,amount_off_minor=$4,max_redemptions=$5,plan_codes=$6,starts_at=$7,ends_at=$8,active=$9 WHERE id=$1 RETURNING *`, [id, c.code, c.percentOff, c.amountOffMinor, c.maxRedemptions, c.planCodes, c.startsAt, c.endsAt, c.active]);
      if (!r) throw notFound(); await A(req, 'coupon.update', id, c); return r;
    });

    // Referrals
    const ruleBody = z.object({ requiredCount: z.number().int().min(1).max(1000), rewardType: z.enum(['feature', 'credits']), featureKey: z.enum(['chat', 'image', 'video', 'promo', 'edit']).nullable().default(null), credits: z.number().int().min(1).nullable().default(null),
      unlockDays: z.number().int().min(1).max(3650).nullable().default(null), maxAwardsPerUser: z.number().int().min(1).max(100).default(1), active: z.boolean().default(true), label: z.string().max(120).default('') })
      .refine((r) => (r.rewardType === 'feature' ? !!r.featureKey : !!r.credits), 'Feature rewards need a feature; credit rewards need an amount.');
    adm.get('/referral-rules', async () => ({ items: await many(pool, 'SELECT * FROM referral_rules ORDER BY required_count') }));
    adm.post('/referral-rules', async (req, reply) => {
      const r = ruleBody.parse(req.body);
      const row = await one(pool, `INSERT INTO referral_rules(required_count,reward_type,feature_key,credits,unlock_days,max_awards_per_user,active,label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [r.requiredCount, r.rewardType, r.rewardType === 'feature' ? r.featureKey : null, r.rewardType === 'credits' ? r.credits : null, r.unlockDays, r.maxAwardsPerUser, r.active, r.label]);
      await A(req, 'referral_rule.create', row.id, r); return reply.status(201).send(row);
    });
    adm.put('/referral-rules/:id', async (req) => {
      const { id } = idp.parse(req.params); const r = ruleBody.parse(req.body);
      const row = await one(pool, `UPDATE referral_rules SET required_count=$2,reward_type=$3,feature_key=$4,credits=$5,unlock_days=$6,max_awards_per_user=$7,active=$8,label=$9 WHERE id=$1 RETURNING *`, [id, r.requiredCount, r.rewardType, r.rewardType === 'feature' ? r.featureKey : null, r.rewardType === 'credits' ? r.credits : null, r.unlockDays, r.maxAwardsPerUser, r.active, r.label]);
      if (!row) throw notFound(); await A(req, 'referral_rule.update', id, r); return row;
    });
    adm.delete('/referral-rules/:id', async (req) => { const { id } = idp.parse(req.params); await pool.query('UPDATE referral_rules SET active=false WHERE id=$1', [id]); await A(req, 'referral_rule.disable', id); return { ok: true }; });
    adm.get('/referrals', async (req) => {
      const q = z.object({ status: z.string().optional(), flagged: z.coerce.boolean().optional() }).merge(page).parse(req.query);
      const rows = await many(pool, `SELECT r.id, r.status, r.abuse_flags, r.created_at, r.qualified_at, a.username AS referrer, a.id AS referrer_id, b.username AS referred, b.email AS referred_email,
          (SELECT count(*)::int FROM referral_rewards rw WHERE rw.user_id=r.referrer_id AND rw.status='granted') AS referrer_rewards
        FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referred_id
        WHERE ($1::text IS NULL OR r.status=$1) AND (NOT COALESCE($2,false) OR cardinality(r.abuse_flags) > 0) AND ($3::timestamptz IS NULL OR r.created_at < $3) ORDER BY r.created_at DESC LIMIT 50`, [q.status ?? null, q.flagged ?? null, q.cursor ?? null]);
      return { items: rows, next: rows.length === 50 ? rows[49].created_at : null };
    });
    adm.get('/referral-rewards', async () => ({ items: await many(pool, `SELECT rw.id, rw.status, rw.award_no, rw.created_at, u.username, rl.label, rl.reward_type, rl.feature_key, rl.credits FROM referral_rewards rw JOIN users u ON u.id=rw.user_id JOIN referral_rules rl ON rl.id=rw.rule_id ORDER BY rw.created_at DESC LIMIT 100`) }));
    adm.post('/referrals/:id/reject', async (req) => {
      const { id } = idp.parse(req.params);
      await pool.query(`UPDATE referrals SET status='rejected', abuse_flags=array_append(abuse_flags,'admin_rejected') WHERE id=$1`, [id]); await A(req, 'referral.reject', id); return { ok: true };
    });

    // Promotions
    const promoBody = z.object({ title: z.string().min(1).max(100), body: z.string().max(400).default(''), kind: z.enum(['banner', 'offer', 'announcement']), assetFileId: z.string().uuid().nullable().default(null), ctaLabel: z.string().max(30).nullable().default(null), ctaUrl: z.string().max(300).nullable().default(null),
      couponId: z.string().uuid().nullable().default(null), discountPercent: z.number().int().min(1).max(100).nullable().default(null), startsAt: z.string().datetime().nullable().default(null), endsAt: z.string().datetime().nullable().default(null), active: z.boolean().default(false) });
    adm.get('/promotions', async () => {
      const rows = await many(pool, 'SELECT * FROM promotions ORDER BY created_at DESC LIMIT 100');
      const files = await fileDtos(rows.map((r) => r.asset_file_id));
      return { items: rows.map((r) => ({ ...r, asset: files.get(r.asset_file_id) ?? null })) };
    });
    adm.post('/promotions', async (req, reply) => {
      const p = promoBody.parse(req.body);
      const r = await one(pool, `INSERT INTO promotions(title,body,kind,asset_file_id,cta_label,cta_url,coupon_id,discount_percent,starts_at,ends_at,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [p.title, p.body, p.kind, p.assetFileId, p.ctaLabel, p.ctaUrl, p.couponId, p.discountPercent, p.startsAt, p.endsAt, p.active]);
      await A(req, 'promotion.create', r.id); return reply.status(201).send(r);
    });
    adm.put('/promotions/:id', async (req) => {
      const { id } = idp.parse(req.params); const p = promoBody.parse(req.body);
      const r = await one(pool, `UPDATE promotions SET title=$2,body=$3,kind=$4,asset_file_id=$5,cta_label=$6,cta_url=$7,coupon_id=$8,discount_percent=$9,starts_at=$10,ends_at=$11,active=$12 WHERE id=$1 RETURNING *`, [id, p.title, p.body, p.kind, p.assetFileId, p.ctaLabel, p.ctaUrl, p.couponId, p.discountPercent, p.startsAt, p.endsAt, p.active]);
      if (!r) throw notFound(); await A(req, 'promotion.update', id); return r;
    });
    adm.delete('/promotions/:id', async (req) => { const { id } = idp.parse(req.params); await pool.query('DELETE FROM promotions WHERE id=$1', [id]); await A(req, 'promotion.delete', id); return { ok: true }; });
    adm.post('/promotions/:id/push', async (req) => {
      const { id } = idp.parse(req.params);
      const p = await one(pool, 'UPDATE promotions SET push_sent_at=now() WHERE id=$1 AND push_sent_at IS NULL RETURNING title, body', [id]);
      if (!p) throw badRequest('Already sent or not found.');
      await broadcast(p.title, p.body); await A(req, 'promotion.push', id); return { ok: true };
    });
    adm.post('/announcements', async (req) => {
      const b = z.object({ title: z.string().min(1).max(100), body: z.string().max(400).default('') }).parse(req.body);
      await broadcast(b.title, b.body); await A(req, 'announcement.send', undefined, b); return { ok: true };
    });

    // AI providers (secrets stay in environment variables; DB stores only the variable NAME)
    const provBody = z.object({ capability: z.enum(['text', 'image', 'image_edit', 'video', 'voice', 'embedding']), name: z.string().min(1).max(60), adapter: z.string().min(1).max(40), model: z.string().min(1).max(120),
      baseUrl: z.string().url().nullable().default(null), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/).nullable().default(null), config: z.record(z.any()).default({}), priority: z.number().int().min(1).max(1000).default(100), enabled: z.boolean().default(true) });
    adm.get('/ai-providers', async () => ({ items: (await many(pool, 'SELECT * FROM ai_providers ORDER BY capability, priority')).map((p) => ({ ...p, keyConfigured: p.api_key_env ? !!process.env[p.api_key_env] : null })) }));
    adm.post('/ai-providers', async (req, reply) => {
      const p = provBody.parse(req.body);
      const r = await one(pool, `INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env,config,priority,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [p.capability, p.name, p.adapter, p.model, p.baseUrl, p.apiKeyEnv, p.config, p.priority, p.enabled]).catch((e) => { if (e.code === '23505') throw badRequest('A provider with this name already exists.'); throw e; });
      clearProviderCache(); await A(req, 'ai_provider.create', r.id, { ...p }); return reply.status(201).send(r);
    });
    adm.put('/ai-providers/:id', async (req) => {
      const { id } = idp.parse(req.params); const p = provBody.parse(req.body);
      const r = await one(pool, `UPDATE ai_providers SET capability=$2,name=$3,adapter=$4,model=$5,base_url=$6,api_key_env=$7,config=$8,priority=$9,enabled=$10 WHERE id=$1 RETURNING *`, [id, p.capability, p.name, p.adapter, p.model, p.baseUrl, p.apiKeyEnv, p.config, p.priority, p.enabled]);
      if (!r) throw notFound(); clearProviderCache(); await A(req, 'ai_provider.update', id); return r;
    });
    adm.delete('/ai-providers/:id', async (req) => { const { id } = idp.parse(req.params); await pool.query('DELETE FROM ai_providers WHERE id=$1', [id]); clearProviderCache(); await A(req, 'ai_provider.delete', id); return { ok: true }; });
    adm.get('/payments', async (req) => {
      const q = z.object({ status: z.string().optional() }).merge(page).parse(req.query);
      return { items: await many(pool, `SELECT p.id, p.status, p.amount_minor, p.currency, p.method, p.created_at, p.failure_reason, u.username, pl.name AS plan FROM payments p JOIN users u ON u.id=p.user_id JOIN plans pl ON pl.id=p.plan_id WHERE ($1::text IS NULL OR p.status=$1) AND ($2::timestamptz IS NULL OR p.created_at < $2) ORDER BY p.created_at DESC LIMIT 50`, [q.status ?? null, q.cursor ?? null]) };
    });
    void providersFor;
  });
}
