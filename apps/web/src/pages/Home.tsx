import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Card, Empty, ErrorState, Icon, ICONS, Loading, Logo } from '../components/ui';
import { PostCard, type Post } from '../components/PostCard';

const QA_ICON: Record<string, string> = { assistant: ICONS.sparkle, image: ICONS.image, video: ICONS.video, photo: ICONS.edit, videoedit: ICONS.reels, promo: ICONS.gift };
export const fmtRemaining = (ms: number) => { const h = Math.floor(ms / 3600000); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `${h}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.max(1, Math.floor(ms / 60000))}m`; };

export default function Home() {
  const { t } = useI18n(); const { config, me, unread } = useApp(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [data, setData] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  const load = () => { setErr(null); setData(null); api('/home').then(setData).catch(setErr); };
  useEffect(load, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const h = config.home;
  const visible = (k: string) => h.sections.length === 0 || h.sections.find((s) => s.key === k)?.visible !== false;
  const go = (e: React.FormEvent) => { e.preventDefault(); if (q.trim()) nav(`/create/assistant?q=${encodeURIComponent(q.trim())}`); };
  const trial = me?.trial?.active ? me.trial : null;
  const qaLabel = (a: { key: string; label: string }) => { const k = `qa.${a.key}`; const tr = t(k); return tr === k ? a.label : tr; };

  return (
    <div className="stack-lg">
      <header className="topbar">
        <div><Logo size={32} />{config.branding.homeBranding && <div className="muted" style={{ fontSize: '.75rem', marginTop: 4 }}>{config.branding.homeBranding}</div>}</div>
        <div className="row">
          <Link className="icon-btn" to="/search" aria-label={t('common.search')}><Icon d={ICONS.search} /></Link>
          <Link className="icon-btn" to="/notifications" aria-label={t('notif.title')}><Icon d={ICONS.bell} />{unread > 0 && <i className="badge" style={{ position: 'absolute', top: 2, right: 2 }}>{unread > 9 ? '9+' : unread}</i>}</Link>
        </div>
      </header>

      <section className="stack">
        <h1><span className="grad-text">{h.title || t('home.prompt')}</span></h1>
        <p className="muted">{h.subtitle || t('brand.tagline')}</p>
        <form className="hero-input" onSubmit={go}>
          <Icon d={ICONS.sparkle} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={h.aiPlaceholder || t('home.prompt')} aria-label={h.aiPlaceholder || t('home.prompt')} />
          <Btn type="submit" aria-label={t('common.send')}><Icon d={ICONS.send} size={18} /></Btn>
        </form>
        {h.announcement?.visible && h.announcement.text && <div className="announce" role="note">📣 {h.announcement.text}</div>}
        {me && (
          <div className="status-strip">
            {trial && <Link to="/pricing" className="chip hot">⏳ {t('home.trialLeft', { time: fmtRemaining(trial.msRemaining) })}</Link>}
            {!trial && !me.access.subscriptionActive && <Link to="/pricing" className="chip hot">{t('pay.upgrade')}</Link>}
            {me.access.subscriptionActive && <span className="chip hot">✦ {me.access.planCode}</span>}
            <Link to="/pricing" className="chip">{t('home.credits', { n: me.credits })}</Link>
          </div>
        )}
      </section>

      <section className="qa-grid" aria-label="Quick actions">
        {h.quickActions.map((a) => <Link key={a.key} to={a.route} className="qa"><span className="qa-ico"><Icon d={QA_ICON[a.key] ?? ICONS.sparkle} /></span>{qaLabel(a)}</Link>)}
      </section>

      {err ? <ErrorState error={err} onRetry={load} /> : !data ? <Loading /> : (
        <>
          {visible('banners') && config.promotions.length > 0 && (
            <section className="stack">{config.promotions.slice(0, 3).map((p) => (
              <div key={p.id} className="banner">
                {p.asset && (p.asset.mime.startsWith('video/') ? <video src={p.asset.url} autoPlay muted loop playsInline /> : <img src={p.asset.url} alt="" loading="lazy" />)}
                <h2>{p.title}</h2>{p.body && <p>{p.body}</p>}
                <div className="row gap wrap">{p.couponCode && <span className="chip hot">Code {p.couponCode}</span>}{p.ctaLabel && <Link className="btn primary sm" to={p.ctaUrl || '/pricing'}>{p.ctaLabel}</Link>}</div>
              </div>))}
            </section>
          )}
          {visible('tools') && h.featuredTools.length > 0 && (
            <section className="stack"><h2>{h.sections.find((s) => s.key === 'tools')?.title || t('home.tools')}</h2>
              <div className="grid g4">{h.featuredTools.map((x) => (
                <Link key={x.key} to={x.route} className="card hover"><div className="row between"><h3>{x.title}</h3>{x.badge && <span className="chip hot">{x.badge}</span>}</div><p className="muted" style={{ fontSize: '.88rem' }}>{x.description}</p></Link>))}
              </div>
            </section>
          )}
          {visible('reels') && (data.trending.length > 0 || data.reels.length > 0) && (
            <section className="stack"><div className="row between"><h2>{t('home.reels')}</h2><Link to="/reels" className="muted">{t('nav.reels')} →</Link></div>
              <div className="hscroll">{(data.trending.length ? data.trending : data.reels).map((r: Post) => (
                <Link key={r.id} to="/reels" className="reel-thumb" style={{ backgroundImage: r.media?.thumbUrl ? `url(${r.media.thumbUrl})` : undefined }}><span>@{r.author.username}</span></Link>))}
              </div>
            </section>
          )}
          {visible('recommended') && data.trendingTags.length > 0 && (
            <section className="stack"><h2>{t('home.recommended')}</h2><div className="row wrap" style={{ gap: 8 }}>{data.trendingTags.map((x: any) => <Link key={x.tag} className="chip" to={`/search?q=${encodeURIComponent('#' + x.tag)}&type=posts`}>#{x.tag}</Link>)}</div></section>
          )}
          {visible('posts') && (
            <section className="stack"><h2>{t('home.posts')}</h2>
              {data.posts.length === 0 ? <Empty icon="✦" title={t('common.empty')} hint={t('home.empty')} action={<Link className="btn primary" to="/compose">{t('common.post')}</Link>} /> : data.posts.map((p: Post) => <PostCard key={p.id} post={p} />)}
            </section>
          )}
        </>
      )}
      <Card className="muted" style={{ textAlign: 'center', fontSize: '.85rem' }}>{config.branding.positioning}</Card>
    </div>
  );
}
