import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, uploadFile, fmtBytes } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Empty, ErrorState, Loading, Icon, ICONS } from './ui';

export interface Generation {
  id: string; kind: string; prompt: string; params: any; status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'; progress: number; queuePosition: number | null;
  creditsCharged: number; error: string | null; meta: any; files: { id: string; url: string; thumbUrl: string | null; mime: string }[]; createdAt: string;
}

/** Loads creation history and keeps in-flight jobs fresh (SSE nudge + 3s polling fallback). */
export function useCreations(kind: string) {
  const [items, setItems] = useState<Generation[] | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(async () => { try { setItems((await api(`/generations?kind=${kind}`)).items); setErr(null); } catch (e) { setErr(e); } }, [kind]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const active = items?.some((g) => g.status === 'queued' || g.status === 'processing');
    const id = active ? setInterval(() => void load(), 3000) : undefined;
    const h = () => void load(); window.addEventListener('madix-generation', h);
    return () => { clearInterval(id); window.removeEventListener('madix-generation', h); };
  }, [items, load]);
  return { items, err, reload: load, add: (g: Generation) => setItems((l) => [g, ...(l ?? [])]) };
}

export function StatusPill({ g }: { g: Generation }) {
  const { t } = useI18n(); return <span className={`pill-status ${g.status}`}>{t(`vid.${g.status}`)}</span>;
}

export function CreationCard({ g, onChange, renderExtra }: { g: Generation; onChange: () => void; renderExtra?: (g: Generation) => ReactNode }) {
  const { t } = useI18n(); const { handleError, toast } = useApp(); const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast(ok); onChange(); } catch (e) { handleError(e); } finally { setBusy(false); } };
  const publish = (f: Generation['files'][number]) => act(() => api('/posts', { body: { kind: f.mime.startsWith('video/') ? 'video' : 'image', body: g.prompt.slice(0, 200), fileId: f.id, aiGenerated: true } }), '✓');
  const active = g.status === 'queued' || g.status === 'processing';
  return (
    <div className="card gen-card">
      <div className="row between gap"><StatusPill g={g} /><span className="muted" style={{ fontSize: '.78rem' }}>{g.creditsCharged} {t('common.credits')}</span></div>
      <p style={{ fontSize: '.9rem' }} className="muted">{g.prompt.slice(0, 140)}</p>
      {active && (<><div className="progress" role="progressbar" aria-valuenow={g.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(6, g.progress)}%` }} /></div>
        <div className="row between"><span className="muted" style={{ fontSize: '.8rem' }}>{g.status === 'queued' && g.queuePosition ? t('vid.position', { n: g.queuePosition }) : `${g.progress}%`}</span><Btn variant="ghost" className="sm" disabled={busy} onClick={() => act(() => api(`/generations/${g.id}/cancel`, { body: {} }))}>{t('vid.cancel')}</Btn></div></>)}
      {g.status === 'failed' && <p className="err" role="alert">{t('common.error')} · {t('pay.insufficient', { n: 0 }).length ? 'Credits refunded.' : ''}</p>}
      {g.files.length > 0 && <div className="thumbs">{g.files.map((f) => f.mime.startsWith('video/') ? <video key={f.id} src={f.url} poster={f.thumbUrl ?? undefined} controls preload="none" playsInline /> : <a key={f.id} href={f.url} target="_blank" rel="noreferrer"><img src={f.thumbUrl ?? f.url} alt={g.prompt} loading="lazy" /></a>)}</div>}
      {renderExtra?.(g)}
      {!active && (
        <div className="row wrap" style={{ gap: 6 }}>
          {g.files.slice(0, 1).map((f) => (<span key={f.id} className="row wrap" style={{ gap: 6 }}>
            <a className="btn soft sm" href={f.url} download target="_blank" rel="noreferrer"><Icon d={ICONS.share} size={16} /> {t('common.download')}</a>
            <Btn variant="soft" className="sm" disabled={busy} onClick={() => publish(f)}>{t('common.share')}</Btn></span>))}
          <Btn variant="ghost" className="sm" disabled={busy} onClick={() => act(() => api(`/generations/${g.id}`, { method: 'DELETE' }))}><Icon d={ICONS.trash} size={16} /></Btn>
        </div>)}
    </div>
  );
}

export function CreationList({ kind, creations, renderExtra }: { kind: string; creations: ReturnType<typeof useCreations>; renderExtra?: (g: Generation) => ReactNode }) {
  const { t } = useI18n(); void kind;
  if (creations.err) return <ErrorState error={creations.err} onRetry={creations.reload} />;
  if (!creations.items) return <Loading rows={2} />;
  if (!creations.items.length) return <Empty icon="✦" title={t('common.empty')} hint="Your creations will appear here." />;
  return <div className="stack">{creations.items.map((g) => <CreationCard key={g.id} g={g} onChange={creations.reload} renderExtra={renderExtra} />)}</div>;
}

export function SourcePicker({ label, accept = 'image/*', purpose = 'edit_source', value, onChange }: { label: string; accept?: string; purpose?: string; value: { id: string; url: string } | null; onChange: (v: { id: string; url: string } | null) => void }) {
  const { handleError } = useApp(); const [busy, setBusy] = useState(false); const [pct, setPct] = useState(0);
  const pick = async (f?: File) => { if (!f) return; setBusy(true); try { const r = await uploadFile(f, purpose, 'user', setPct); onChange({ id: r.id, url: r.file.url }); } catch (e) { handleError(e); } finally { setBusy(false); } };
  return (
    <div className="field"><span>{label}</span>
      {value ? <div className="row gap"><img src={value.url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 12 }} /><Btn variant="ghost" className="sm" onClick={() => onChange(null)}>{'✕'}</Btn></div>
        : <label className="btn ghost" style={{ cursor: 'pointer' }}>{busy ? <><span className="spinner" /> {Math.round(pct * 100)}%</> : <><Icon d={ICONS.paperclip} size={18} /> Choose file</>}<input type="file" hidden accept={accept} onChange={(e) => void pick(e.target.files?.[0])} /></label>}
    </div>
  );
}
export { fmtBytes };
export function useLatest<T>(v: T) { const r = useRef(v); r.current = v; return r; }
