import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, getTokens, setTokens } from './api';
import { t } from '../i18n';

export interface AppConfig {
  branding: { appName: string; companyText: string; tagline: string; positioning: string; homeBranding: string; promoBranding: string; logoUrl: string | null; splashLogoUrl: string | null; loginLogoUrl: string | null; iconUrl: string | null };
  theme: { primary: string; secondary: string; accent: string; background: string; text: string; mutedText: string; gradient: string[]; allowLight: boolean; allowDark: boolean };
  home: { title: string; subtitle: string; aiPlaceholder: string; quickActions: { key: string; label: string; route: string }[]; sections: { key: string; visible: boolean; title?: string }[]; featuredTools: { key: string; title: string; description: string; route: string; badge?: string }[]; announcement: { text: string; visible: boolean } };
  promotions: { id: string; title: string; body: string; kind: string; ctaLabel: string | null; ctaUrl: string | null; discountPercent: number | null; couponCode: string | null; asset: { url: string; mime: string } | null }[];
  features: Record<string, boolean>; creditCosts: Record<string, number>; trial: { enabled: boolean; durationDays: number }; referralEnabled: boolean; razorpayKeyId: string | null;
}
export interface Me {
  user: { id: string; email: string; username: string; role: string; displayName: string; bio: string; interests: string[]; avatar: { url: string } | null; emailVerified: boolean; locale: string };
  credits: number;
  access: { trialActive: boolean; subscriptionActive: boolean; subscriptionEndsAt: string | null; planCode: string | null; features: string[] };
  trial: null | { active: boolean; endsAt: string; msRemaining: number; remaining: Record<string, number>; limits: Record<string, number> };
  trialEligible: boolean; counts: { followers: number; following: number; posts: number };
}

const DEFAULT_CONFIG: AppConfig = {
  branding: { appName: 'MADIX', companyText: 'from SAYRIX MATHAV', tagline: 'Your AI. Your Creativity. Your World.', positioning: 'Create. Chat. Edit. Share. — All in MADIX.', homeBranding: '', promoBranding: '', logoUrl: null, splashLogoUrl: null, loginLogoUrl: null, iconUrl: null },
  theme: { primary: '#8B5CF6', secondary: '#22D3EE', accent: '#8B5CF6', background: '#050507', text: '#FFFFFF', mutedText: '#A1A1AA', gradient: ['#8B5CF6', '#22D3EE'], allowLight: false, allowDark: true },
  home: { title: 'What do you want to create?', subtitle: 'Your AI. Your Creativity. Your World.', aiPlaceholder: 'What do you want to create?', quickActions: [], sections: [], featuredTools: [], announcement: { text: '', visible: false } },
  promotions: [], features: {}, creditCosts: {}, trial: { enabled: true, durationDays: 3 }, referralEnabled: true, razorpayKeyId: null,
};

interface Ctx {
  config: AppConfig; configReady: boolean; reloadConfig: () => Promise<void>;
  me: Me | null; authReady: boolean; refreshMe: () => Promise<void>; signOut: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  paywall: (info: { kind: 'credits' | 'locked'; needed?: number }) => void;
  handleError: (e: unknown) => void;
  unread: number; setUnread: (n: number) => void; chatUnread: number;
}
const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.code === 'network' ? t('common.network') : e.status >= 500 || e.code === 'error' ? t('common.error') : e.message;
  return t('common.error');
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [wall, setWall] = useState<{ kind: 'credits' | 'locked'; needed?: number } | null>(null);
  const [unread, setUnread] = useState(0);
  const [chatUnread, setChatUnread] = useState(0);
  const seq = useRef(0);

  const reloadConfig = useCallback(async () => {
    try { setConfig(await api<AppConfig>('/app-config', { auth: false })); } catch { /* keep defaults */ }
    setConfigReady(true);
  }, []);
  const refreshMe = useCallback(async () => {
    if (!getTokens()) { setMe(null); setAuthReady(true); return; }
    try { setMe(await api<Me>('/me')); } catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setTokens(null); setMe(null); } }
    setAuthReady(true);
  }, []);
  const signOut = useCallback(async () => {
    const t0 = getTokens();
    try { await api('/auth/logout', { body: { refreshToken: t0?.refreshToken } }); } catch { /* already invalid */ }
    setTokens(null); setMe(null);
  }, []);
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = ++seq.current; setToasts((l) => [...l, { id, msg, kind }]); setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 4500);
  }, []);
  const handleError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.code === 'insufficient_credits') return setWall({ kind: 'credits', needed: e.extra.needed });
    if (e instanceof ApiError && e.code === 'feature_locked') return setWall({ kind: 'locked' });
    if (e instanceof Error && e.name === 'AbortError') return;
    toast(errMessage(e), 'err');
  }, [toast]);

  useEffect(() => { void reloadConfig(); void refreshMe(); const h = () => void refreshMe(); window.addEventListener('madix-auth', h); return () => window.removeEventListener('madix-auth', h); }, [reloadConfig, refreshMe]);

  // Apply admin-configured theme (colours are validated for contrast on the server)
  useEffect(() => {
    const th = config.theme, r = document.documentElement.style;
    r.setProperty('--bg', th.background); r.setProperty('--text', th.text); r.setProperty('--muted', th.mutedText);
    r.setProperty('--primary', th.primary); r.setProperty('--secondary', th.secondary); r.setProperty('--accent', th.accent);
    r.setProperty('--grad', `linear-gradient(135deg, ${th.gradient.join(', ')})`);
    document.title = config.branding.appName;
    if (config.branding.iconUrl) (document.getElementById('favicon') as HTMLLinkElement | null)?.setAttribute('href', config.branding.iconUrl);
  }, [config]);

  // Live updates: notifications, payments, generations
  useEffect(() => {
    const tk = getTokens(); if (!tk || !me) return;
    const es = new EventSource(`/api/v1/events?token=${encodeURIComponent(tk.accessToken)}`);
    const bump = () => { void api<{ unread: number }>('/notifications').then((r) => setUnread(r.unread)).catch(() => {}); };
    const bumpChat = () => { void api<{ unread: number }>('/chat/unread').then((r) => setChatUnread(r.unread)).catch(() => {}); };
    es.addEventListener('notification', bump);
    es.addEventListener('account', () => void refreshMe());
    es.addEventListener('generation', () => { window.dispatchEvent(new Event('madix-generation')); void refreshMe(); });
    es.addEventListener('message', () => { window.dispatchEvent(new Event('madix-message')); bumpChat(); });
    window.addEventListener('madix-message', bumpChat);
    bump(); bumpChat();
    return () => { es.close(); window.removeEventListener('madix-message', bumpChat); };
  }, [me?.user.id, refreshMe]);  // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => ({ config, configReady, reloadConfig, me, authReady, refreshMe, signOut, toast, paywall: setWall, handleError, unread, setUnread, chatUnread }), [config, configReady, reloadConfig, me, authReady, refreshMe, signOut, toast, handleError, unread, chatUnread]);
  return (
    <C.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{toasts.map((x) => <div key={x.id} className={`toast ${x.kind}`}>{x.msg}</div>)}</div>
      {wall && <PaywallModal wall={wall} onClose={() => setWall(null)} />}
    </C.Provider>
  );
}

import { Link } from 'react-router-dom';
function PaywallModal({ wall, onClose }: { wall: { kind: 'credits' | 'locked'; needed?: number }; onClose: () => void }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="pw-title" onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <div className="pw-orb" aria-hidden />
        <h2 id="pw-title">{wall.kind === 'credits' ? t('pay.buyCredits') : t('pay.upgrade')}</h2>
        <p className="muted">{wall.kind === 'credits' ? t('pay.insufficient', { n: wall.needed ?? 0 }) : t('pay.locked')}</p>
        <div className="row gap">
          <Link className="btn primary" to="/pricing" onClick={onClose}>{wall.kind === 'credits' ? t('pay.buyCredits') : t('pay.upgrade')}</Link>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
