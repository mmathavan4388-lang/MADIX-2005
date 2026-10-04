import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, streamPost, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Empty, ErrorState, Icon, ICONS, Loading } from '../components/ui';
import { Markdown } from '../components/Markdown';

interface Msg { id?: string; role: 'user' | 'assistant'; content: string; pending?: boolean }
interface Conv { id: string; title: string; updated_at: string }

export default function Assistant() {
  const { t } = useI18n(); const { handleError, refreshMe, toast } = useApp(); const [sp, setSp] = useSearchParams();
  const [convs, setConvs] = useState<Conv[] | null>(null); const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]); const [loading, setLoading] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [text, setText] = useState(''); const [streaming, setStreaming] = useState(false); const [q, setQ] = useState(''); const [drawer, setDrawer] = useState(false);
  const [file, setFile] = useState<{ id: string; name: string } | null>(null); const [uploading, setUploading] = useState(false);
  const abort = useRef<AbortController | null>(null); const endRef = useRef<HTMLDivElement>(null); const sent = useRef(false);

  const loadConvs = useCallback(async (query = '') => { try { setConvs((await api(`/ai/conversations${query ? `?q=${encodeURIComponent(query)}` : ''}`)).items); } catch (e) { setErr(e); } }, []);
  useEffect(() => { void loadConvs(); }, [loadConvs]);
  useEffect(() => { const id = setTimeout(() => void loadConvs(q), 250); return () => clearTimeout(id); }, [q, loadConvs]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const open = async (id: string) => {
    setActive(id); setDrawer(false); setLoading(true); setErr(null);
    try { setMsgs((await api(`/ai/conversations/${id}/messages`)).items); } catch (e) { setErr(e); } finally { setLoading(false); }
  };
  const run = async (convId: string, path: string, body: unknown, assistantIndexBase: Msg[]) => {
    setStreaming(true); const ac = new AbortController(); abort.current = ac;
    setMsgs([...assistantIndexBase, { role: 'assistant', content: '', pending: true }]);
    try {
      await streamPost(path, body, (ev, d) => {
        if (ev === 'token') setMsgs((l) => { const c = [...l]; const last = c[c.length - 1]; c[c.length - 1] = { ...last, content: last.content + d.t }; return c; });
        if (ev === 'error') toast(d.message, 'err');
      }, ac.signal);
    } catch (e) { if ((e as Error).name !== 'AbortError') { handleError(e); setMsgs(assistantIndexBase); } }
    finally { setStreaming(false); abort.current = null; setMsgs((l) => l.map((m) => ({ ...m, pending: false })).filter((m) => m.content || m.role === 'user')); void loadConvs(q); void refreshMe(); void convId; }
  };
  const send = async (content: string) => {
    if (!content.trim() || streaming) return;
    let id = active;
    try { if (!id) { id = (await api('/ai/conversations', { body: {} })).id as string; setActive(id); } } catch (e) { return handleError(e); }
    const base: Msg[] = [...(active ? msgs : []), { role: 'user', content }];
    const fid = file?.id ?? null; setText(''); setFile(null);
    await run(id!, `/ai/conversations/${id}/messages`, { content, fileId: fid }, base);
  };
  const regenerate = async () => { if (!active || streaming) return; const base = msgs.filter((m, i) => !(i === msgs.length - 1 && m.role === 'assistant')); await run(active, `/ai/conversations/${active}/regenerate`, {}, base); };
  const newChat = () => { abort.current?.abort(); setActive(null); setMsgs([]); setDrawer(false); };

  // Home → "What do you want to create?" hands the prompt over once
  useEffect(() => { const p = sp.get('q'); if (p && !sent.current) { sent.current = true; setSp({}, { replace: true }); void send(p); } }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const attach = async (f: File | undefined) => {
    if (!f) return; setUploading(true);
    try { const r = await uploadFile(f, f.type.startsWith('image/') ? 'edit_source' : 'document'); setFile({ id: r.id, name: f.name }); } catch (e) { handleError(e); } finally { setUploading(false); }
  };

  const ConvList = (
    <>
      <Btn onClick={newChat}><Icon d={ICONS.create} size={18} /> {t('ai.newChat')}</Btn>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('ai.searchChats')} aria-label={t('ai.searchChats')} />
      {convs === null ? <Loading rows={3} /> : convs.length === 0 ? <p className="muted">{t('common.empty')}</p> : convs.map((c) => (
        <div key={c.id} className={`conv-item ${c.id === active ? 'on' : ''}`} onClick={() => void open(c.id)}>
          <span>{c.title}</span>
          <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label={t('ai.rename')} onClick={async (e) => { e.stopPropagation(); const n = prompt(t('ai.rename'), c.title); if (n?.trim()) { await api(`/ai/conversations/${c.id}`, { method: 'PATCH', body: { title: n } }).catch(handleError); void loadConvs(q); } }}><Icon d={ICONS.edit} size={15} /></button>
          <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label={t('common.delete')} onClick={async (e) => { e.stopPropagation(); if (!confirm(t('common.delete') + '?')) return; await api(`/ai/conversations/${c.id}`, { method: 'DELETE' }).catch(handleError); if (c.id === active) newChat(); void loadConvs(q); }}><Icon d={ICONS.trash} size={15} /></button>
        </div>))}
    </>
  );

  return (
    <div className="chat-split" style={{ gap: 18 }}>
      <aside className="hide-sm stack" style={{ alignContent: 'start', display: 'none' }} id="conv-side">{ConvList}</aside>
      <style>{`@media (min-width: 900px){ #conv-side{display:grid !important} .only-sm{display:none !important} }`}</style>
      <div className="chat-layout">
        <div className="row between"><div className="row gap"><button className="icon-btn only-sm" onClick={() => setDrawer(true)} aria-label={t('ai.history')}><Icon d={ICONS.menu} /></button><h2>MADIX AI</h2></div><Btn variant="ghost" className="sm" onClick={newChat}>{t('ai.newChat')}</Btn></div>
        <div className="msgs" aria-live="polite">
          {loading ? <Loading /> : err ? <ErrorState error={err} onRetry={() => (active ? open(active) : loadConvs())} /> : msgs.length === 0 ? (
            <Empty icon="✦" title={t('ai.emptyTitle')} hint={t('ai.emptySub')} action={<div className="row wrap gap" style={{ justifyContent: 'center' }}>{['Summarise this text for me', 'Translate to Tamil', 'Write a Python function', 'Brainstorm 10 startup ideas'].map((s) => <button key={s} className="chip" style={{ cursor: 'pointer', border: 0 }} onClick={() => setText(s)}>{s}</button>)}</div>} />
          ) : msgs.map((m, i) => (
            <div key={i} className="stack" style={{ gap: 4 }}>
              <div className={`bubble ${m.role === 'user' ? 'me' : 'ai'}`}>{m.role === 'user' ? m.content : m.content ? <Markdown text={m.content} /> : <span className="typing" aria-label={t('ai.thinking')}><i /><i /><i /></span>}</div>
              {m.role === 'assistant' && m.content && !m.pending && (
                <div className="row" style={{ gap: 2 }}>
                  <button className="act" onClick={() => { void navigator.clipboard.writeText(m.content); toast(t('common.copied')); }}><Icon d={ICONS.copy} size={16} /> {t('common.copy')}</button>
                  {i === msgs.length - 1 && <button className="act" onClick={regenerate} disabled={streaming}>↻ {t('common.regenerate')}</button>}
                </div>)}
            </div>))}
          <div ref={endRef} />
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {file && <span className="chip hot">📎 {file.name} <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setFile(null)} aria-label={t('common.close')}>✕</button></span>}
          <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <label className="icon-btn" title={t('ai.attach')} aria-label={t('ai.attach')}>{uploading ? <span className="spinner" /> : <Icon d={ICONS.paperclip} />}<input type="file" hidden accept="image/*,.pdf,.txt,.md,.docx" onChange={(e) => void attach(e.target.files?.[0])} /></label>
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ai.placeholder')} aria-label={t('ai.placeholder')} maxLength={8000}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
            {streaming ? <Btn type="button" variant="danger" onClick={() => abort.current?.abort()} aria-label={t('ai.stop')}><Icon d={ICONS.stop} size={18} /> {t('ai.stop')}</Btn> : <Btn type="submit" disabled={!text.trim()} aria-label={t('common.send')}><Icon d={ICONS.send} size={18} /></Btn>}
          </form>
        </div>
      </div>
      {drawer && <div className="drawer" onClick={() => setDrawer(false)}><div onClick={(e) => e.stopPropagation()}>{ConvList}</div></div>}
    </div>
  );
}
