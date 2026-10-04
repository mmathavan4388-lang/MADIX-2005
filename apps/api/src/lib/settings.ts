import { pool, Q } from '../db/pool.js';
import { z } from 'zod';

// Typed defaults. Anything the owner should tune lives here and in app_settings — never hardcoded in clients.
export const defaults = {
  branding: {
    appName: 'MADIX', companyText: 'from SAYRIX MATHAV', tagline: 'Your AI. Your Creativity. Your World.',
    positioning: 'Create. Chat. Edit. Share. — All in MADIX.',
    logoFileId: null as string | null, splashLogoFileId: null as string | null, loginLogoFileId: null as string | null,
    iconFileId: null as string | null, homeBranding: '', promoBranding: '',
  },
  theme: {
    name: 'MADIX DARK', primary: '#8B5CF6', secondary: '#22D3EE', accent: '#8B5CF6',
    background: '#050507', text: '#FFFFFF', mutedText: '#A1A1AA', gradient: ['#8B5CF6', '#22D3EE'], allowLight: false, allowDark: true,
  },
  home: {
    title: 'What do you want to create?', subtitle: 'Your AI. Your Creativity. Your World.',
    aiPlaceholder: 'What do you want to create?',
    quickActions: [
      { key: 'assistant', label: 'AI Assistant', route: '/create/assistant', visible: true },
      { key: 'image', label: 'Create Image', route: '/create/image', visible: true },
      { key: 'video', label: 'Create Video', route: '/create/video', visible: true },
      { key: 'photo', label: 'Edit Photo', route: '/create/photo-editor', visible: true },
      { key: 'videoedit', label: 'Edit Video', route: '/create/video-editor', visible: true },
      { key: 'promo', label: 'Promo Creator', route: '/create/promo', visible: true },
    ] as { key: string; label: string; route: string; visible: boolean }[],
    sections: [
      { key: 'banners', visible: true }, { key: 'posts', visible: true }, { key: 'reels', visible: true },
      { key: 'recommended', visible: true }, { key: 'tools', visible: true },
    ] as { key: string; visible: boolean; title?: string }[],
    featuredTools: [
      { key: 'image', title: 'AI Image', description: 'Text or image to stunning visuals', route: '/create/image', badge: '' },
      { key: 'video', title: 'AI Video', description: 'Turn ideas into motion', route: '/create/video', badge: 'New' },
      { key: 'promo', title: 'Promo Creator', description: 'Ads, posters and captions in one go', route: '/create/promo', badge: '' },
    ] as { key: string; title: string; description: string; route: string; badge?: string }[],
    announcement: { text: '', visible: false },
  },
  credit_costs: { chat_message: 1, image: 5, image_variation: 4, video_5s: 40, video_per_extra_5s: 30, promo_image: 6, promo_video: 45, promo_copy: 2, photo_edit_ai: 3, video_edit_ai: 8, video_edit_basic: 1, prompt_enhance: 1, document_analysis: 3 } as Record<string, number>,
  trial: {
    enabled: true, durationDays: 3, freeCredits: 60,
    // Max successful uses per feature during the trial (independent of credits)
    featureLimits: { chat: 30, image: 6, video: 1, promo: 2, edit: 5 } as Record<string, number>,
    endingNotifyHours: 24,
  },
  entitlements: {
    // Features and which are usable without any plan/trial (nothing by default: gated by trial/plan/unlock)
    features: ['chat', 'image', 'video', 'promo', 'edit'],
    freeTierCredits: 0,
    featureEnabled: { chat: true, image: true, video: true, promo: true, edit: true } as Record<string, boolean>, // global kill-switches
  },
  referral: {
    enabled: true, expiryDays: 30, maxQualifiedPerReferrer: 50, dailyInviteCap: 20,
    // A referral counts only after verified registration AND these requirements are met:
    requireEmailVerified: true, minAccountAgeHours: 0, maxPerDevice: 1, maxPerIp: 3,
  },
  limits: { maxFileMb: { avatar: 5, post: 20, reel: 200, ai_image: 20, ai_video: 200, document: 25, chat: 50, branding: 5, promo: 200, edit_source: 100, edit_output: 200 } as Record<string, number> },
};
export type SettingKey = keyof typeof defaults;
export const SETTING_KEYS = Object.keys(defaults) as SettingKey[];

const cache = new Map<string, { at: number; value: any }>();
const TTL = 5000;
export function clearSettingsCache() { cache.clear(); }

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = k in (base as any) ? deepMerge((base as any)[k], over[k]) : over[k];
  return out;
}

export async function getSetting<K extends SettingKey>(key: K, q: Q = pool): Promise<(typeof defaults)[K]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const r = await q.query('SELECT published FROM app_settings WHERE key=$1', [key]);
  const value = deepMerge(defaults[key], r.rows[0]?.published);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function getDraft(key: SettingKey) {
  const r = await pool.query('SELECT draft, published, version, published_at FROM app_settings WHERE key=$1', [key]);
  const row = r.rows[0];
  return { draft: deepMerge(defaults[key], row?.draft ?? row?.published), published: deepMerge(defaults[key], row?.published), version: row?.version ?? 0, publishedAt: row?.published_at ?? null, hasUnpublished: !!row?.draft };
}
export async function saveDraft(key: SettingKey, value: unknown) {
  await pool.query(
    `INSERT INTO app_settings(key, draft) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET draft=$2, updated_at=now()`, [key, value]);
}
export async function publish(key: SettingKey) {
  const r = await pool.query(
    `UPDATE app_settings SET published=draft, draft=NULL, version=version+1, published_at=now(), updated_at=now()
     WHERE key=$1 AND draft IS NOT NULL RETURNING version`, [key]);
  clearSettingsCache();
  return r.rows[0]?.version ?? null;
}
export async function discardDraft(key: SettingKey) {
  await pool.query('UPDATE app_settings SET draft=NULL WHERE key=$1', [key]);
}

// Validation of admin-supplied setting values (guards against nonsense that would break the app / accessibility).
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
function luminance(h: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

export const settingSchemas: Record<SettingKey, z.ZodTypeAny> = {
  branding: z.object({
    appName: z.string().min(1).max(40), companyText: z.string().max(80), tagline: z.string().max(120), positioning: z.string().max(160),
    logoFileId: z.string().uuid().nullable(), splashLogoFileId: z.string().uuid().nullable(), loginLogoFileId: z.string().uuid().nullable(),
    iconFileId: z.string().uuid().nullable(), homeBranding: z.string().max(200), promoBranding: z.string().max(200),
  }).partial(),
  theme: z.object({
    name: z.string().max(40), primary: hex, secondary: hex, accent: hex, background: hex, text: hex, mutedText: hex,
    gradient: z.array(hex).min(2).max(3), allowLight: z.boolean(), allowDark: z.boolean(),
  }).partial().superRefine((t, ctx) => {
    // WCAG AA: body text 4.5:1, muted text 4.5:1 and accent on background 3:1
    const d = defaults.theme; const bg = t.background ?? d.background;
    if (contrast(t.text ?? d.text, bg) < 4.5) ctx.addIssue({ code: 'custom', message: 'Text colour has insufficient contrast (needs 4.5:1).' });
    if (contrast(t.mutedText ?? d.mutedText, bg) < 4.5) ctx.addIssue({ code: 'custom', message: 'Secondary text has insufficient contrast (needs 4.5:1).' });
    for (const k of ['primary', 'secondary', 'accent'] as const)
      if (contrast(t[k] ?? d[k], bg) < 3) ctx.addIssue({ code: 'custom', message: `${k} colour has insufficient contrast against background (needs 3:1).` });
    if (t.allowLight === false && t.allowDark === false) ctx.addIssue({ code: 'custom', message: 'At least one colour mode must be available.' });
  }),
  home: z.object({
    title: z.string().max(120), subtitle: z.string().max(160), aiPlaceholder: z.string().max(120),
    quickActions: z.array(z.object({ key: z.string(), label: z.string().max(40), route: z.string().startsWith('/'), visible: z.boolean() })).max(12),
    sections: z.array(z.object({ key: z.string(), visible: z.boolean(), title: z.string().max(60).optional() })).max(12),
    featuredTools: z.array(z.object({ key: z.string(), title: z.string().max(40), description: z.string().max(120), route: z.string().startsWith('/'), badge: z.string().max(16).optional() })).max(12),
    announcement: z.object({ text: z.string().max(240), visible: z.boolean() }),
  }).partial(),
  credit_costs: z.record(z.string(), z.number().int().min(0).max(100000)),
  trial: z.object({
    enabled: z.boolean(), durationDays: z.number().int().min(0).max(90), freeCredits: z.number().int().min(0).max(100000),
    featureLimits: z.record(z.string(), z.number().int().min(0).max(10000)), endingNotifyHours: z.number().int().min(1).max(72),
  }).partial(),
  entitlements: z.object({ features: z.array(z.string()), freeTierCredits: z.number().int().min(0), featureEnabled: z.record(z.string(), z.boolean()) }).partial(),
  referral: z.object({
    enabled: z.boolean(), expiryDays: z.number().int().min(1).max(365), maxQualifiedPerReferrer: z.number().int().min(1).max(10000),
    dailyInviteCap: z.number().int().min(1).max(1000), requireEmailVerified: z.boolean(), minAccountAgeHours: z.number().int().min(0).max(720),
    maxPerDevice: z.number().int().min(1).max(10), maxPerIp: z.number().int().min(1).max(50),
  }).partial(),
  limits: z.object({ maxFileMb: z.record(z.string(), z.number().int().min(1).max(2000)) }).partial(),
};
