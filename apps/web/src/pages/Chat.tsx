import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, timeAgo, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Avatar, Btn, Empty, ErrorState, Icon, ICONS, Loading, Modal } from '../components/ui';

interface Conv { id: string; kind: 'direct' | 'group'; title: string | null; last_message_at: string; others: { id: string; username: string; displayName: string; avatar: { url: string } | null }[]; last: { body: string; deleted_at: string | null; has_file: boolean } | null; unread: number }
interface Msg { id: string; senderId: string; senderName: string; body: string; deleted: boolean; file: { url: string; mime: string; thumbUrl: string | null } | null; replyTo: string | null; createdAt: string; reactions: { emoji: string; count: number; mine: boolean }[] }
const EMOJI = ['👍', '❤️', '😂', '🔥', '😮', '🙏'];

function NewChat({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n(); const { handleError } = useApp(); const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]); const [picked, setPicked] = useState<any[]>([]); const [title, setTitle] = useState('');
  useEffect(() => { if (q.length < 2) return setRes([]); const id = setTimeout(() => api(`/search?type=users&q=${encodeURIComponent(q)}`).then((r) => setRes(r.items)).catch(() => {}), 250); return () => clearTimeout(id); }, [q]);
  const go = async () => { try { onCreated((await api('/chat/conversations', { body: { userIds: picked.map((p) => p.id), title: picked.length > 1 ? title : undefined } })).id); } catch (e) { handleError(e); } };
  return (
    <Modal title={t('chat.new')} onClose={onClose}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} autoFocus />
      <div className="row wrap" style={{ gap: 6 }}>{picked.map((p) => <button key={p.id} className="chip hot" style={{ border: 0, cursor: 'pointer' }} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}>@{p.username} ✕</button>)}</div>
      <div className="stack" style={{ maxHeight: 220, overflowY: 'auto' }}>{res.filter((r) => !picked.some((p) => p.id === r.id)).map((u) => <button key={u.id} className="card row gap" onClick={() => setPicked([...picked, u])}><Avatar url={u.avatar?.url} name={u.username} size={32} /><span>@{u.username}</span></button>)}</div>
      {picked.length > 1 && <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Group name" aria-label="Group name" maxLength={60} />}
      <Btn disabled={!picked.length || (picked.length > 1 && !title.trim())} onClick={go}>{t('chat.new')}</Btn>
    </Modal>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useI18n(); const { me, handleError, toast } = useApp(); const [msgs, setMsgs] = useState<Msg[] | null>(null); const [err, setErr] = useState<unknown>(null); const [text, setText] = useState('');
  const [reply, setReply] = useState<Msg | null>(null); const [menu, setMenu] = useState<string | null>(null); const [busy, setBusy] = useState(false); const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => { try { setMsgs((await api(`/chat/conversations/${id}/messages`)).items); setErr(null); } catch (e) { setErr(e); } }, [id]);
  useEffect(() => { setMsgs(null); void load(); }, [load]);
  useEffect(() => { const h = () => void load(); window.addEventListener('madix-message', h); const poll = setInterval(h, 15000); return () => { window.removeEventListener('madix-message', h); clearInterval(poll); }; }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);
  const send = async (fileId?: string) => {
    if (!text.trim() && !fileId) return; setBusy(true);
    try { await api(`/chat/conversations/${id}/messages`, { body: { body: text, fileId, replyTo: reply?.id } }); setText(''); setReply(null); await load(); } catch (e) { handleError(e); } finally { setBusy(false); }
  };
  const attach = async (f?: File) => { if (!f) return; setBusy(true); try { const r = await uploadFile(f, 'chat'); await send(r.id); } catch (e) { handleError(e); setBusy(false); } };
  if (err) return <ErrorState error={err} onRetry={load} />;
  if (!msgs) return <Loading />;
  const byId = new Map(msgs.map((m) => [m.id, m]));
  return (
    <div className="chat-layout">
      <div className="row between"><div className="row gap"><button className="icon-btn" onClick={onBack} aria-label={t('common.back')}>←</button></div>
        <Link className="btn ghost sm" to={`/create/assistant`}>✦ {t('chat.ask')}</Link></div>
      <div className="msgs">
        {msgs.length === 0 && <Empty title={t('chat.empty')} />}
        {msgs.map((m) => { const mine = m.senderId === me?.user.id; const rp = m.replyTo ? byId.get(m.replyTo) : null; return (
          <div key={m.id} style={{ display: 'grid', justifyItems: mine ? 'end' : 'start' }}>
            <div className={`bubble ${mine ? 'me' : 'other'}`} onClick={() => setMenu(menu === m.id ? null : m.id)} style={{ cursor: 'pointer', opacity: m.deleted ? 0.5 : 1 }}>
              {!mine && <b style={{ fontSize: '.75rem', display: 'block' }}>{m.senderName}</b>}
              {rp && <div className="muted" style={{ fontSize: '.78rem', borderLeft: '2px solid currentColor', paddingLeft: 8, marginBottom: 4 }}>{rp.deleted ? '…' : rp.body.slice(0, 60) || '📎'}</div>}
              {m.deleted ? <i>Message deleted</i> : <>{m.file && (m.file.mime.startsWith('image/') ? <img src={m.file.thumbUrl ?? m.file.url} alt="" style={{ maxWidth: 240, borderRadius: 12, marginBottom: 4 }} loading="lazy" /> : m.file.mime.startsWith('video/') ? <video src={m.file.url} controls preload="none" style={{ maxWidth: 260, borderRadius: 12 }} /> : <a href={m.file.url} target="_blank" rel="noreferrer">📎 File</a>)}{m.body}</>}
            </div>
            {m.reactions.length > 0 && <div className="react-bar">{m.reactions.map((r) => <span key={r.emoji} className={`chip ${r.mine ? 'hot' : ''}`}>{r.emoji} {r.count}</span>)}</div>}
            <span className="muted" style={{ fontSize: '.68rem' }}>{timeAgo(m.createdAt)}</span>
            {menu === m.id && !m.deleted && (
              <div className="react-bar glass" style={{ padding: 6, borderRadius: 14 }}>{EMOJI.map((e) => <button key={e} className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { await api(`/chat/messages/${m.id}/reaction`, { method: 'PUT', body: { emoji: e } }).catch(handleError); setMenu(null); void load(); }}>{e}</button>)}
                <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => { setReply(m); setMenu(null); }}>↩</button>
                {mine ? <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { await api(`/chat/messages/${m.id}`, { method: 'DELETE' }).catch(handleError); setMenu(null); void load(); }}>🗑</button>
                  : <><button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { await api('/reports', { body: { targetType: 'message', targetId: m.id, reason: 'abuse' } }).catch(handleError); toast('Reported'); setMenu(null); }}>⚑</button>
                    <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={async () => { if (confirm('Block this user?')) { await api(`/users/${m.senderId}/block`, { body: {} }).catch(handleError); onBack(); } }}>⛔</button></>}</div>)}
          </div>); })}
        <div ref={end} />
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {reply && <div className="chip hot">↩ {reply.body.slice(0, 40) || '📎'} <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => setReply(null)} aria-label={t('common.close')}>✕</button></div>}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="icon-btn" aria-label={t('ai.attach')}><Icon d={ICONS.paperclip} /><input type="file" hidden accept="image/*,video/*,application/pdf,text/plain,audio/*" onChange={(e) => void attach(e.target.files?.[0])} /></label>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')} maxLength={4000} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <Btn type="submit" loading={busy} disabled={!text.trim()} aria-label={t('common.send')}><Icon d={ICONS.send} size={18} /></Btn>
        </form>
      </div>
    </div>
  );
}

export default function Chat() {
  const { t } = useI18n(); const { id } = useParams(); const nav = useNavigate(); const [convs, setConvs] = useState<Conv[] | null>(null); const [err, setErr] = useState<unknown>(null); const [newOpen, setNewOpen] = useState(false);
  const load = useCallback(async () => { try { setConvs((await api('/chat/conversations')).items); setErr(null); } catch (e) { setErr(e); } }, []);
  useEffect(() => { void load(); const h = () => void load(); window.addEventListener('madix-message', h); return () => window.removeEventListener('madix-message', h); }, [load]);
  const name = (c: Conv) => c.title ?? c.others[0]?.displayName ?? 'Chat';
  const list = (
    <div className="stack">
      <div className="row between"><h1>{t('chat.title')}</h1><Btn className="sm" onClick={() => setNewOpen(true)}>+ {t('chat.new')}</Btn></div>
      <Link to="/create/assistant" className="card hover row gap"><span className="pw-orb" style={{ width: 40, height: 40, margin: 0, borderRadius: 14 }} /><div className="grow"><b>MADIX AI</b><div className="muted" style={{ fontSize: '.85rem' }}>{t('chat.ask')}</div></div></Link>
      {err ? <ErrorState error={err} onRetry={load} /> : !convs ? <Loading /> : convs.length === 0 ? <Empty icon="💬" title={t('chat.empty')} /> : convs.map((c) => (
        <Link key={c.id} to={`/chat/${c.id}`} className={`card row gap hover`} style={{ borderColor: c.id === id ? 'var(--primary)' : undefined }}>
          <Avatar url={c.others[0]?.avatar?.url} name={name(c)} /><div className="grow"><b>{name(c)}{c.kind === 'group' && ' 👥'}</b><div className="muted" style={{ fontSize: '.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last ? (c.last.deleted_at ? 'Message deleted' : c.last.body || (c.last.has_file ? '📎' : '')) : t('chat.empty')}</div></div>
          {c.unread > 0 && <span className="chip hot">{c.unread}</span>}</Link>))}
    </div>
  );
  return (
    <>
      <div className="chat-wide">
        <div className={id ? 'chat-list hide-mobile' : 'chat-list'}>{list}</div>
        <div className={id ? '' : 'hide-mobile'}>{id ? <Thread id={id} onBack={() => nav('/chat')} /> : <Empty icon="💬" title={t('chat.empty')} />}</div>
      </div>
      {newOpen && <NewChat onClose={() => setNewOpen(false)} onCreated={(cid) => { setNewOpen(false); void load(); nav(`/chat/${cid}`); }} />}
    </>
  );
}
