import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Field, Segmented } from '../components/ui';

export default function Compose() {
  const { t } = useI18n(); const { handleError, toast } = useApp(); const nav = useNavigate(); const [sp] = useSearchParams();
  const [kind, setKind] = useState<'text' | 'image' | 'video' | 'reel'>((sp.get('kind') as any) || 'text'); const [body, setBody] = useState(''); const [captions, setCaptions] = useState('');
  const [media, setMedia] = useState<{ id: string; url: string; mime: string } | null>(null); const [audio, setAudio] = useState<{ id: string; name: string } | null>(null); const [pct, setPct] = useState(0); const [busy, setBusy] = useState(false); const [up, setUp] = useState(false);
  const pick = async (f?: File, as: 'media' | 'audio' = 'media') => {
    if (!f) return; setUp(true);
    try { const r = await uploadFile(f, as === 'audio' ? 'reel' : kind === 'reel' ? 'reel' : 'post', 'user', setPct); as === 'audio' ? setAudio({ id: r.id, name: f.name }) : setMedia({ id: r.id, url: r.file.url, mime: f.type }); } catch (e) { handleError(e); } finally { setUp(false); setPct(0); }
  };
  const submit = async () => { setBusy(true); try { await api('/posts', { body: { kind, body, fileId: media?.id, audioFileId: audio?.id, captions: captions || undefined } }); toast('✓'); nav(kind === 'reel' ? '/reels' : '/'); } catch (e) { handleError(e); } finally { setBusy(false); } };
  return (
    <div className="stack-lg">
      <header><h1>{t('common.post')}</h1></header>
      <div className="card stack">
        <Segmented label="Type" value={kind} onChange={(k) => { setKind(k); setMedia(null); }} options={[{ value: 'text', label: 'Text' }, { value: 'image', label: 'Photo' }, { value: 'video', label: 'Video' }, { value: 'reel', label: 'Reel' }]} />
        <Field label="Write something… use #hashtags"><textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2200} /></Field>
        {kind !== 'text' && (media ? <div className="stack">{media.mime.startsWith('video/') ? <video src={media.url} controls playsInline style={{ maxHeight: 320, borderRadius: 14 }} /> : <img src={media.url} alt="" style={{ maxHeight: 320, borderRadius: 14, objectFit: 'contain' }} />}<Btn variant="ghost" className="sm" onClick={() => setMedia(null)}>✕ {t('common.delete')}</Btn></div>
          : <label className="btn ghost" style={{ cursor: 'pointer' }}>{up ? <><span className="spinner" /> {Math.round(pct * 100)}%</> : t('common.upload')}<input type="file" hidden accept={kind === 'image' ? 'image/png,image/jpeg,image/webp,image/gif' : 'video/mp4,video/webm,video/quicktime'} onChange={(e) => void pick(e.target.files?.[0])} /></label>)}
        {kind === 'reel' && <>
          <Field label="Captions (shown over the video)"><textarea value={captions} onChange={(e) => setCaptions(e.target.value)} maxLength={4000} style={{ minHeight: 60 }} /></Field>
          {audio ? <div className="row between"><span className="chip hot">♪ {audio.name.slice(0, 28)}</span><Btn variant="ghost" className="sm" onClick={() => setAudio(null)}>✕</Btn></div> : <label className="btn ghost sm" style={{ cursor: 'pointer', justifySelf: 'start' }}>♪ Add audio<input type="file" hidden accept="audio/mpeg,audio/mp4,audio/wav,audio/webm" onChange={(e) => void pick(e.target.files?.[0], 'audio')} /></label>}</>}
        <Btn loading={busy} disabled={(kind === 'text' ? !body.trim() : !media) || up} onClick={submit}>{t('common.post')}</Btn>
      </div>
    </div>
  );
}
