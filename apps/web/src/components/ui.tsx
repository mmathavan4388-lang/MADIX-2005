import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { useApp, errMessage } from '../lib/store';
import { t } from '../i18n';

export function Logo({ kind = 'logo', size = 36, stacked = false }: { kind?: 'logo' | 'splash' | 'login'; size?: number; stacked?: boolean }) {
  const { config } = useApp(); const b = config.branding;
  const url = kind === 'splash' ? b.splashLogoUrl : kind === 'login' ? b.loginLogoUrl : b.logoUrl;
  return (
    <div className={`logo ${stacked ? 'stacked' : ''}`}>
      {url ? <img src={url} alt={b.appName} style={{ height: size }} /> : <span className="wordmark" style={{ fontSize: size * 0.72 }}>{b.appName}</span>}
      <span className="from">{b.companyText}</span>
    </div>
  );
}

export function Btn({ variant = 'primary', loading, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'soft'; loading?: boolean }) {
  return <button {...p} disabled={p.disabled || loading} className={`btn ${variant} ${p.className ?? ''}`}>{loading && <span className="spinner" aria-hidden />}{children}</button>;
}
export const Card = ({ children, className = '', ...r }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) => <div {...r} className={`card ${className}`}>{children}</div>;
export const Skeleton = ({ h = 16, w = '100%', r = 10 }: { h?: number; w?: number | string; r?: number }) => <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
export function Loading({ rows = 3 }: { rows?: number }) { return <div className="stack" aria-busy="true" aria-label={t('common.loading')}>{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={72} r={16} />)}</div>; }
export function Empty({ icon = '✦', title, hint, action }: { icon?: string; title?: string; hint?: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-orb" aria-hidden>{icon}</div><h3>{title ?? t('common.empty')}</h3>{hint && <p className="muted">{hint}</p>}{action}</div>;
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="empty" role="alert"><div className="empty-orb err" aria-hidden>!</div><p>{errMessage(error)}</p>{onRetry && <Btn variant="soft" onClick={onRetry}>{t('common.retry')}</Btn>}</div>;
}
export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}{error && <small className="err" role="alert">{error}</small>}</label>;
}
export function Avatar({ url, name, size = 40 }: { url?: string | null; name: string; size?: number }) {
  return url ? <img className="avatar" src={url} alt="" width={size} height={size} loading="lazy" style={{ width: size, height: size }} /> : <div className="avatar ph" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{name.slice(0, 1).toUpperCase()}</div>;
}
export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return <div className="seg" role="radiogroup" aria-label={label}>{options.map((o) => <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="modal-back" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}><div className="modal glass" onClick={(e) => e.stopPropagation()}><div className="row between"><h2>{title}</h2><button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>✕</button></div>{children}</div></div>;
}

/** Infinite scroll sentinel. */
export function useInfinite(load: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && load(), { rootMargin: '400px' });
    io.observe(ref.current); return () => io.disconnect();
  }, [load, enabled]);
  return ref;
}

/** Generic paginated list loader with loading / error / empty states. */
export function usePaged<T>(fetcher: (cursor: string | number | null) => Promise<{ items: T[]; next: string | number | null }>, deps: unknown[] = []) {
  const [items, setItems] = useState<T[]>([]); const [next, setNext] = useState<string | number | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading'); const [err, setErr] = useState<unknown>(null); const busy = useRef(false);
  const load = async (cursor: string | number | null, reset = false) => {
    if (busy.current) return; busy.current = true;
    try { const r = await fetcher(cursor); setItems((l) => (reset ? r.items : [...l, ...r.items])); setNext(r.next); setState('ok'); } catch (e) { setErr(e); setState('error'); } finally { busy.current = false; }
  };
  useEffect(() => { setState('loading'); void load(null, true); }, deps);  // eslint-disable-line react-hooks/exhaustive-deps
  return { items, setItems, state, err, hasMore: next !== null, more: () => next !== null && void load(next), reload: () => { setState('loading'); void load(null, true); } };
}

export function Gated({ children, to = '/login' }: { children: ReactNode; to?: string }) {
  const { me, authReady } = useApp();
  if (!authReady) return <Loading />;
  if (!me) return <div className="empty"><h3>{t('auth.login')}</h3><Link className="btn primary" to={to}>{t('auth.login')}</Link></div>;
  return <>{children}</>;
}
export const Icon = ({ d, size = 22 }: { d: string; size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
export const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', create: 'M12 5v14M5 12h14', reels: 'M4 5h16v14H4zM10 9l5 3-5 3z', chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  heart: 'M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z', comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', share: 'M4 12v7h16v-7M12 3v13M7 8l5-5 5 5', bookmark: 'M6 3h12v18l-6-4-6 4z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z', stop: 'M6 6h12v12H6z', copy: 'M9 9h11v11H9zM5 15V4h11', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', image: 'M4 5h16v14H4zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 16l-5-5-9 8',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3', sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', menu: 'M4 6h16M4 12h16M4 18h16', paperclip: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', gift: 'M20 12v9H4v-9M2 7h20v5H2zM12 22V7M12 7H8a2.5 2.5 0 1 1 0-5c3 0 4 5 4 5zM12 7h4a2.5 2.5 0 1 0 0-5c-3 0-4 5-4 5z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', flag: 'M4 22V4M4 4h13l-2 4 2 4H4',
};
