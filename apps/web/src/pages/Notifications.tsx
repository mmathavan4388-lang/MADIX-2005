import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Empty, ErrorState, Loading, useInfinite, usePaged } from '../components/ui';

const ICON: Record<string, string> = { follow: '👤', like: '❤️', comment: '💬', message: '✉️', ai_complete: '✨', payment_success: '💳', trial_ending: '⏳', trial_expired: '⏳', subscription_activated: '🚀', announcement: '📣', referral_reward: '🎁', moderation: '🛡' };
export default function Notifications() {
  const { t } = useI18n(); const { setUnread } = useApp();
  const list = usePaged<any>((c) => api(`/notifications${c ? `?cursor=${encodeURIComponent(String(c))}` : ''}`).then((r) => ({ items: r.items, next: r.next })), []);
  const sentinel = useInfinite(list.more, list.hasMore);
  useEffect(() => { if (list.state === 'ok') { void api('/notifications/read', { body: {} }).then(() => setUnread(0)); } }, [list.state]);  // eslint-disable-line react-hooks/exhaustive-deps
  const target = (n: any) => n.data?.postId ? `/post/${n.data.postId}` : n.data?.conversationId ? `/chat/${n.data.conversationId}` : n.data?.generationId ? (n.data.kind === 'video' ? '/create/video' : '/create/image') : n.type.startsWith('trial') ? '/pricing' : n.type === 'referral_reward' ? '/profile' : null;
  return (
    <div className="stack-lg"><div className="row between"><h1>{t('notif.title')}</h1><Btn variant="ghost" className="sm" onClick={() => api('/notifications/read', { body: {} }).then(() => { setUnread(0); list.reload(); })}>✓</Btn></div>
      {list.state === 'loading' ? <Loading /> : list.state === 'error' ? <ErrorState error={list.err} onRetry={list.reload} /> : list.items.length === 0 ? <Empty icon="🔔" title={t('notif.empty')} /> : (
        <div className="stack">{list.items.map((n) => { const to = target(n); const body = (<><span style={{ fontSize: '1.4rem' }}>{ICON[n.type] ?? '•'}</span><div className="grow"><b style={{ opacity: n.read_at ? 0.75 : 1 }}>{n.title}</b>{n.body && <div className="muted" style={{ fontSize: '.88rem' }}>{n.body}</div>}</div><span className="muted" style={{ fontSize: '.75rem' }}>{timeAgo(n.created_at)}</span></>);
          return to ? <Link key={n.id} to={to} className="card row gap">{body}</Link> : <div key={n.id} className="card row gap">{body}</div>; })}<div ref={sentinel} /></div>)}
    </div>
  );
}
