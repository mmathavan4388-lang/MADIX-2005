import type { FastifyInstance } from 'fastify';
import { many, pool } from '../db/pool.js';
import { getSetting } from '../lib/settings.js';
import { fileDtos } from '../lib/files.js';
import { config } from '../config.js';

export async function publicRoutes(app: FastifyInstance) {
  /** Everything the client needs to render brand, theme, home and tool config — all from the DB, no rebuild needed. */
  app.get('/app-config', async (_req, reply) => {
    const [branding, theme, home, trial, ent, costs, referral] = await Promise.all([
      getSetting('branding'), getSetting('theme'), getSetting('home'), getSetting('trial'), getSetting('entitlements'), getSetting('credit_costs'), getSetting('referral'),
    ]);
    const files = await fileDtos([branding.logoFileId, branding.splashLogoFileId, branding.loginLogoFileId, branding.iconFileId]);
    const logo = (id: string | null) => (id ? files.get(id)?.url ?? null : null);
    const promos = await many(pool, `SELECT p.id, p.title, p.body, p.kind, p.cta_label, p.cta_url, p.discount_percent, p.asset_file_id, c.code AS coupon_code
      FROM promotions p LEFT JOIN coupons c ON c.id=p.coupon_id
      WHERE p.active AND (p.starts_at IS NULL OR p.starts_at <= now()) AND (p.ends_at IS NULL OR p.ends_at > now()) ORDER BY p.created_at DESC LIMIT 20`);
    const pf = await fileDtos(promos.map((p) => p.asset_file_id));
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
    return {
      branding: { appName: branding.appName, companyText: branding.companyText, tagline: branding.tagline, positioning: branding.positioning, homeBranding: branding.homeBranding, promoBranding: branding.promoBranding,
        logoUrl: logo(branding.logoFileId), splashLogoUrl: logo(branding.splashLogoFileId) ?? logo(branding.logoFileId), loginLogoUrl: logo(branding.loginLogoFileId) ?? logo(branding.logoFileId), iconUrl: logo(branding.iconFileId) },
      theme,
      home: { ...home, quickActions: home.quickActions.filter((a) => a.visible), sections: home.sections },
      promotions: promos.map((p) => ({ id: p.id, title: p.title, body: p.body, kind: p.kind, ctaLabel: p.cta_label, ctaUrl: p.cta_url, discountPercent: p.discount_percent, couponCode: p.coupon_code, asset: pf.get(p.asset_file_id) ?? null })),
      features: ent.featureEnabled,
      trial: { enabled: trial.enabled, durationDays: trial.durationDays },
      creditCosts: costs,
      referralEnabled: referral.enabled,
      razorpayKeyId: config.RAZORPAY_KEY_ID ?? null, // publishable key only
    };
  });

  app.get('/plans', async (_req, reply) => {
    const plans = await many(pool, `SELECT id, code, name, kind, interval, price_minor, compare_at_minor, currency, credits, features, description, badge
      FROM plans WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()) ORDER BY sort, price_minor`);
    reply.header('Cache-Control', 'public, max-age=15');
    return { plans: plans.map((p) => ({ ...p, priceMinor: p.price_minor, compareAtMinor: p.compare_at_minor })) };
  });
}
