import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../i18n';
import { Avatar, Empty, ErrorState, Loading, Segmented } from '../components/ui';
import { PostCard } from '../components/PostCard';

export default function Search() {
  const { t } = useI18n(); const [sp, setSp] = useSearchParams(); const [q, setQ] = useState(sp.get('q') ?? ''); const [type, setType] = useState<'posts' | 'users' | 'hashtags'>((sp.get('type') as any) || 'posts');
  const [items, setItems] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (q.trim().replace('#', '').length < 2) { setItems(null); return; }
    const id = setTimeout(() => { setErr(null); setItems(null); setSp({ q, type }, { replace: true }); api(`/search?type=${type}&q=${encodeURIComponent(q)}`).then((r) => setItems(r.items)).catch(setErr); }, 300);
    return () => clearTimeout(id);
  }, [q, type]);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack-lg">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} autoFocus />
      <Segmented label="Type" value={type} onChange={setType} options={[{ value: 'posts', label: 'Posts' }, { value: 'users', label: 'People' }, { value: 'hashtags', label: '#Tags' }]} />
      {err ? <ErrorState error={err} onRetry={() => setQ(q + ' ')} /> : q.trim().length < 2 ? <Empty icon="🔎" title={t('common.search')} /> : items === null ? <Loading /> : items.length === 0 ? <Empty title={t('common.empty')} /> : (
        <div className="stack">{type === 'posts' ? items.map((p) => <PostCard key={p.id} post={p} />) : type === 'users' ? items.map((u) => (
          <Link key={u.id} to={`/u/${u.username}`} className="card row gap"><Avatar url={u.avatar?.url} name={u.username} /><div><b>{u.displayName}</b><div className="muted">@{u.username} · {u.followers} {t('profile.followers')}</div></div></Link>
        )) : items.map((h) => <button key={h.tag} className="card row between" onClick={() => { setType('posts'); setQ('#' + h.tag); }}><b className="tag">#{h.tag}</b><span className="muted">{h.posts}</span></button>)}</div>)}
    </div>
  );
}
