import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import { Avatar, Icon, ICONS, Btn } from './ui';
import { t } from '../i18n';

export interface Post {
  id: string; kind: 'text' | 'image' | 'video' | 'reel'; body: string; captions: string | null; hashtags: string[]; aiGenerated: boolean; createdAt: string;
  media: { url: string; thumbUrl: string | null; mime: string; width?: number; height?: number } | null; audio: { url: string } | null;
  author: { id: string; username: string; displayName: string; avatar: { url: string } | null; isFollowing: boolean; isMe: boolean };
  counts: { likes: number; comments: number; shares: number; saves: number; views: number }; viewer: { liked: boolean; saved: boolean };
}

export function renderBody(body: string) {
  return body.split(/(#[\p{L}\p{N}_]{2,40})/gu).map((p, i) => (p.startsWith('#') ? <Link key={i} className="tag" to={`/search?q=${encodeURIComponent(p)}&type=posts`}>{p}</Link> : <span key={i}>{p}</span>));
}

export function usePostActions(initial: Post, onRemoved?: () => void) {
  const { handleError, toast } = useApp();
  const [p, setP] = useState(initial);
  const react = async (kind: 'like' | 'save') => {
    const on = !(kind === 'like' ? p.viewer.liked : p.viewer.saved);
    setP((x) => ({ ...x, viewer: { ...x.viewer, [kind === 'like' ? 'liked' : 'saved']: on }, counts: { ...x.counts, [kind === 'like' ? 'likes' : 'saves']: x.counts[kind === 'like' ? 'likes' : 'saves'] + (on ? 1 : -1) } }));
    try { await api(`/posts/${p.id}/${kind}`, { method: on ? 'POST' : 'DELETE' }); } catch (e) { setP(p); handleError(e); }
  };
  const share = async () => {
    const url = `${location.origin}/post/${p.id}`;
    try { if (navigator.share) await navigator.share({ title: 'MADIX', url }); else { await navigator.clipboard.writeText(url); toast(t('common.copied')); } await api(`/posts/${p.id}/share`, { method: 'POST' }); setP((x) => ({ ...x, counts: { ...x.counts, shares: x.counts.shares + 1 } })); } catch (e) { if ((e as Error).name !== 'AbortError') handleError(e); }
  };
  const follow = async () => {
    const on = !p.author.isFollowing; setP((x) => ({ ...x, author: { ...x.author, isFollowing: on } }));
    try { await api(`/users/${p.author.id}/follow`, { method: on ? 'POST' : 'DELETE' }); } catch (e) { setP(p); handleError(e); }
  };
  const report = async () => { try { await api('/reports', { body: { targetType: 'post', targetId: p.id, reason: 'other' } }); toast('Thanks — our team will review this.'); } catch (e) { handleError(e); } };
  const remove = async () => { if (!confirm(t('common.delete') + '?')) return; try { await api(`/posts/${p.id}`, { method: 'DELETE' }); onRemoved?.(); } catch (e) { handleError(e); } };
  return { p, react, share, follow, report, remove };
}

export function PostCard({ post, onRemoved }: { post: Post; onRemoved?: () => void }) {
  const { p, react, share, follow, report, remove } = usePostActions(post, onRemoved);
  const [open, setOpen] = useState(false);
  return (
    <article className="card post">
      <div className="post-head">
        <Link to={`/u/${p.author.username}`}><Avatar url={p.author.avatar?.url} name={p.author.displayName || p.author.username} /></Link>
        <div className="grow"><Link to={`/u/${p.author.username}`}><b>{p.author.displayName || p.author.username}</b></Link><div className="muted" style={{ fontSize: '.78rem' }}>@{p.author.username} · {timeAgo(p.createdAt)}{p.aiGenerated && ' · ✦ AI'}</div></div>
        {!p.author.isMe && <Btn variant={p.author.isFollowing ? 'ghost' : 'soft'} className="sm" onClick={follow}>{p.author.isFollowing ? t('profile.unfollow') : t('profile.follow')}</Btn>}
      </div>
      {p.body && <div className="post-body">{renderBody(p.body)}</div>}
      {p.media && <div className="post-media">{p.media.mime.startsWith('video/') ? <video src={p.media.url} poster={p.media.thumbUrl ?? undefined} controls preload="none" playsInline /> : <img src={p.media.thumbUrl && p.media.width && p.media.width > 900 ? p.media.url : p.media.url} alt="" loading="lazy" />}</div>}
      <div className="post-actions">
        <button className={`act ${p.viewer.liked ? 'on' : ''}`} onClick={() => react('like')} aria-pressed={p.viewer.liked} aria-label="Like"><Icon d={ICONS.heart} /> {p.counts.likes}</button>
        <button className="act" onClick={() => setOpen(true)} aria-label="Comments"><Icon d={ICONS.comment} /> {p.counts.comments}</button>
        <button className="act" onClick={share} aria-label={t('common.share')}><Icon d={ICONS.share} /> {p.counts.shares}</button>
        <button className={`act save ${p.viewer.saved ? 'on' : ''}`} onClick={() => react('save')} aria-pressed={p.viewer.saved} aria-label="Save"><Icon d={ICONS.bookmark} /></button>
        <span className="grow" />
        {p.author.isMe ? <button className="act" onClick={remove} aria-label={t('common.delete')}><Icon d={ICONS.trash} /></button> : <button className="act" onClick={report} aria-label="Report"><Icon d={ICONS.flag} /></button>}
      </div>
      {open && <Comments postId={p.id} onClose={() => setOpen(false)} />}
    </article>
  );
}

export function Comments({ postId, onClose }: { postId: string; onClose: () => void }) {
  const { handleError } = useApp();
  const [items, setItems] = useState<any[] | null>(null); const [text, setText] = useState('');
  useState(() => { api(`/posts/${postId}/comments`).then((r) => setItems(r.items)).catch((e) => { handleError(e); setItems([]); }); });
  const send = async () => { if (!text.trim()) return; try { await api(`/posts/${postId}/comments`, { body: { body: text } }); setText(''); setItems((await api(`/posts/${postId}/comments`)).items); } catch (e) { handleError(e); } };
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Comments" onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()} style={{ gridTemplateRows: 'auto 1fr auto' }}>
        <div className="row between"><h2>Comments</h2><button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>✕</button></div>
        <div className="stack" style={{ minHeight: 120, maxHeight: '45dvh', overflowY: 'auto' }}>
          {items === null ? <div className="muted">{t('common.loading')}</div> : items.length === 0 ? <div className="muted">{t('common.empty')}</div> : items.map((c) => (
            <div key={c.id} className="row gap" style={{ alignItems: 'flex-start' }}><Avatar url={c.author.avatar?.url} name={c.author.username} size={32} /><div className="grow"><b style={{ fontSize: '.85rem' }}>{c.author.username}</b><div>{c.body}</div></div>
              {c.mine && <button className="icon-btn" aria-label={t('common.delete')} onClick={async () => { await api(`/comments/${c.id}`, { method: 'DELETE' }).catch(handleError); setItems((l) => l!.filter((x) => x.id !== c.id)); }}><Icon d={ICONS.trash} size={16} /></button>}</div>
          ))}
        </div>
        <form className="row gap" onSubmit={(e) => { e.preventDefault(); void send(); }}><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…" maxLength={1000} aria-label="Add a comment" /><Btn type="submit">{t('common.send')}</Btn></form>
      </div>
    </div>
  );
}
