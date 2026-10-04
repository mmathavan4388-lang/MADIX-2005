import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Avatar, Btn, Empty, ErrorState, Icon, ICONS, Loading } from '../components/ui';
import { Comments, renderBody, usePostActions, type Post } from '../components/PostCard';

function Reel({ post, active, near, muted, onMute }: { post: Post; active: boolean; near: boolean; muted: boolean; onMute: () => void }) {
  const { t } = useI18n(); const { p, react, share, follow, report } = usePostActions(post);
  const v = useRef<HTMLVideoElement>(null); const a = useRef<HTMLAudioElement>(null); const watched = useRef(0); const startedAt = useRef<number | null>(null); const [cm, setCm] = useState(false); const [err, setErr] = useState(false);
  const flush = useCallback((completed: boolean) => {
    if (startedAt.current) { watched.current += Date.now() - startedAt.current; startedAt.current = null; }
    if (watched.current > 800) { void api(`/posts/${p.id}/view`, { body: { watchMs: watched.current, completed } }).catch(() => {}); }
  }, [p.id]);
  useEffect(() => {
    const el = v.current; if (!el) return;
    if (active) { el.currentTime = 0; void el.play().catch(() => {}); void a.current?.play().catch(() => {}); startedAt.current = Date.now(); }
    else { el.pause(); a.current?.pause(); flush(false); }
    return () => { if (active) flush(false); };
  }, [active, flush]);
  const dur = p.media && 'durationMs' in p.media ? 0 : 0; void dur;
  return (
    <section className="reel" aria-label={`Reel by ${p.author.username}`}>
      {p.media && near ? <video ref={v} src={p.media.url} poster={p.media.thumbUrl ?? undefined} loop playsInline muted={muted || !!p.audio} preload={active ? 'auto' : 'metadata'} onClick={onMute} onError={() => setErr(true)} onEnded={() => flush(true)} /> : <div style={{ backgroundImage: `url(${p.media?.thumbUrl})`, width: '100%', height: '100%', backgroundSize: 'cover' }} />}
      {p.audio && near && <audio ref={a} src={p.audio.url} loop muted={muted} preload="none" />}
      {err && <div className="empty" style={{ position: 'absolute' }}><p>{t('common.error')}</p><Btn variant="soft" onClick={() => { setErr(false); v.current?.load(); }}>{t('common.retry')}</Btn></div>}
      <div className="shade" />
      {p.captions && active && <div className="cap">{p.captions.split('\n')[0]}</div>}
      <div className="meta">
        <div className="row gap"><Link to={`/u/${p.author.username}`}><Avatar url={p.author.avatar?.url} name={p.author.username} size={36} /></Link><b>@{p.author.username}</b>
          {!p.author.isMe && <Btn variant={p.author.isFollowing ? 'ghost' : 'soft'} className="sm" onClick={follow}>{p.author.isFollowing ? t('profile.unfollow') : t('profile.follow')}</Btn>}</div>
        {p.body && <div style={{ fontSize: '.92rem' }}>{renderBody(p.body)}</div>}
        {p.audio && <div className="chip">♪ Original audio</div>}{p.aiGenerated && <div className="chip hot">✦ AI-generated</div>}
      </div>
      <div className="side">
        <button className={`act ${p.viewer.liked ? 'on' : ''}`} onClick={() => react('like')} aria-label="Like" aria-pressed={p.viewer.liked}><Icon d={ICONS.heart} size={26} />{p.counts.likes}</button>
        <button className="act" onClick={() => setCm(true)} aria-label="Comments"><Icon d={ICONS.comment} size={26} />{p.counts.comments}</button>
        <button className={`act save ${p.viewer.saved ? 'on' : ''}`} onClick={() => react('save')} aria-label="Save" aria-pressed={p.viewer.saved}><Icon d={ICONS.bookmark} size={26} />{p.counts.saves}</button>
        <button className="act" onClick={share} aria-label={t('common.share')}><Icon d={ICONS.share} size={26} />{p.counts.shares}</button>
        {!p.author.isMe && <button className="act" onClick={report} aria-label="Report"><Icon d={ICONS.flag} size={22} /></button>}
      </div>
      {cm && <Comments postId={p.id} onClose={() => setCm(false)} />}
    </section>
  );
}

export default function Reels() {
  const { t } = useI18n(); const [items, setItems] = useState<Post[]>([]); const [next, setNext] = useState<number | null>(0); const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading'); const [err, setErr] = useState<unknown>(null);
  const [cur, setCur] = useState(0); const [muted, setMuted] = useState(true); const box = useRef<HTMLDivElement>(null); const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current || next === null) return; busy.current = true;
    try { const r = await api(`/feed?kind=reel&cursor=${next}`); setItems((l) => { const seen = new Set(l.map((x) => x.id)); return [...l, ...r.items.filter((x: Post) => !seen.has(x.id))]; }); setNext(r.next); setState('ok'); } catch (e) { setErr(e); setState('error'); } finally { busy.current = false; }
  }, [next]);
  useEffect(() => { void load(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // active reel by scroll position; prefetch more near the end
    const el = box.current; if (!el) return;
    const on = () => { const i = Math.round(el.scrollTop / el.clientHeight); setCur(i); if (i >= items.length - 3) void load(); };
    el.addEventListener('scroll', on, { passive: true }); return () => el.removeEventListener('scroll', on);
  }, [items.length, load]);
  useEffect(() => { const k = (e: KeyboardEvent) => { const el = box.current; if (!el) return; if (e.key === 'ArrowDown') el.scrollBy({ top: el.clientHeight, behavior: 'smooth' }); if (e.key === 'ArrowUp') el.scrollBy({ top: -el.clientHeight, behavior: 'smooth' }); if (e.key === 'm') setMuted((m) => !m); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  if (state === 'loading') return <Loading />;
  if (state === 'error' && !items.length) return <ErrorState error={err} onRetry={() => { setState('loading'); void load(); }} />;
  if (!items.length) return <Empty icon="🎬" title={t('reels.empty')} action={<Link className="btn primary" to="/compose?kind=reel">{t('reels.upload')}</Link>} />;
  return (
    <>
      <div className="reels" ref={box} tabIndex={0} aria-label="Reels">
        {items.map((p, i) => <Reel key={p.id} post={p} active={i === cur} near={Math.abs(i - cur) <= 1} muted={muted} onMute={() => setMuted((m) => !m)} />)}
        {next !== null && <div className="reel"><Loading rows={1} /></div>}
      </div>
      <Link to="/compose?kind=reel" className="btn primary" style={{ position: 'fixed', top: 14, right: 14, zIndex: 20 }}>+ {t('reels.upload')}</Link>
      <button className="btn soft sm" style={{ position: 'fixed', top: 14, left: 14, zIndex: 20 }} onClick={() => setMuted(!muted)} aria-pressed={!muted}>{muted ? '🔇' : '🔊'}</button>
    </>
  );
}
