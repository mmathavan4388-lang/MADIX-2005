import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Avatar, Btn, Card, Empty, ErrorState, Loading, useInfinite, usePaged } from '../components/ui';
import { PostCard } from '../components/PostCard';

export default function UserPage() {
  const { t } = useI18n(); const { username } = useParams(); const { handleError, toast } = useApp(); const nav = useNavigate();
  const [u, setU] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  const load = () => { setErr(null); api(`/users/${username}`).then(setU).catch(setErr); };
  useEffect(load, [username]);  // eslint-disable-line react-hooks/exhaustive-deps
  const list = usePaged<any>((c) => (u ? api(`/users/${u.id}/posts${c ? `?cursor=${encodeURIComponent(String(c))}` : ''}`) : Promise.resolve({ items: [], next: null })), [u?.id]);
  const s = useInfinite(list.more, list.hasMore);
  if (err) return <ErrorState error={err} onRetry={load} />; if (!u) return <Loading />;
  const toggle = async () => { try { await api(`/users/${u.id}/follow`, { method: u.isFollowing ? 'DELETE' : 'POST' }); load(); } catch (e) { handleError(e); } };
  return (
    <div className="stack-lg">
      <Card className="stack"><div className="row gap"><Avatar url={u.avatar?.url} name={u.displayName} size={72} /><div className="grow"><h2>{u.displayName}</h2><div className="muted">@{u.username}</div></div></div>
        {u.bio && <p>{u.bio}</p>}
        <div className="row" style={{ justifyContent: 'space-around' }}><div className="stat"><b>{u.posts}</b><small>{t('profile.posts')}</small></div><div className="stat"><b>{u.followers}</b><small>{t('profile.followers')}</small></div><div className="stat"><b>{u.following}</b><small>{t('profile.following')}</small></div></div>
        {!u.isMe && <div className="row gap"><Btn className="grow" variant={u.isFollowing ? 'ghost' : 'primary'} onClick={toggle}>{u.isFollowing ? t('profile.unfollow') : t('profile.follow')}</Btn>
          <Btn variant="soft" onClick={async () => { try { nav(`/chat/${(await api('/chat/conversations', { body: { userIds: [u.id] } })).id}`); } catch (e) { handleError(e); } }}>{t('nav.chat')}</Btn>
          <Btn variant="ghost" onClick={async () => { await api('/reports', { body: { targetType: 'user', targetId: u.id, reason: 'other' } }).catch(handleError); toast('Reported'); }}>⚑</Btn></div>}
      </Card>
      {list.state === 'loading' ? <Loading /> : list.items.length === 0 ? <Empty /> : <div className="stack">{list.items.map((p) => <PostCard key={p.id} post={p} />)}<div ref={s} /></div>}
    </div>
  );
}
