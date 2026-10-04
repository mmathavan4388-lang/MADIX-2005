import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Field, Segmented, Icon, ICONS } from '../components/ui';
import { CreationList, SourcePicker, useCreations, type Generation } from '../components/Gen';

const STYLES = ['', 'Cinematic', 'Documentary', 'Anime', 'Time-lapse', 'Drone shot', 'Product showcase', '3D animation'];
export default function VideoStudio() {
  const { t } = useI18n(); const { config, handleError, refreshMe } = useApp(); const creations = useCreations('video');
  const [prompt, setPrompt] = useState(''); const [style, setStyle] = useState(''); const [aspect, setAspect] = useState('16:9'); const [dur, setDur] = useState(5);
  const [src, setSrc] = useState<{ id: string; url: string } | null>(null); const [busy, setBusy] = useState(false); const [enh, setEnh] = useState(false);
  const cost = (config.creditCosts.video_5s ?? 0) + Math.ceil((dur - 5) / 5) * (config.creditCosts.video_per_extra_5s ?? 0);
  const submit = async () => { setBusy(true); try { await api('/generations/video', { body: { prompt, style: style || undefined, aspect, durationSec: dur, sourceFileId: src?.id } }); await creations.reload(); void refreshMe(); setPrompt(''); } catch (e) { handleError(e); } finally { setBusy(false); } };
  const enhance = async () => { setEnh(true); try { setPrompt((await api('/ai/enhance-prompt', { body: { prompt, kind: 'video' } })).prompt); void refreshMe(); } catch (e) { handleError(e); } finally { setEnh(false); } };
  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('vid.title')}</h1><p className="muted">Text → Video · Image → Video · runs in the background — keep using MADIX while it renders.</p></header>
      <div className="card stack">
        <Field label={t('vid.prompt')}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="Slow aerial shot over misty tea hills at sunrise" /></Field>
        <Btn variant="soft" className="sm" loading={enh} disabled={prompt.trim().length < 3} onClick={enhance} style={{ justifySelf: 'start' }}><Icon d={ICONS.sparkle} size={16} /> {t('img.enhance')}</Btn>
        <SourcePicker label="Start from an image (Image → Video)" value={src} onChange={setSrc} />
        <div className="field"><span>{t('vid.duration')}</span><Segmented label={t('vid.duration')} value={dur} onChange={setDur} options={[5, 10, 15].map((v) => ({ value: v, label: `${v}s` }))} /></div>
        <div className="field"><span>{t('img.aspect')}</span><Segmented label={t('img.aspect')} value={aspect} onChange={setAspect} options={['16:9', '9:16', '1:1'].map((v) => ({ value: v, label: v }))} /></div>
        <Field label={t('img.style')}><select value={style} onChange={(e) => setStyle(e.target.value)}>{STYLES.map((s) => <option key={s} value={s}>{s || '—'}</option>)}</select></Field>
        <Btn loading={busy} disabled={prompt.trim().length < 3} onClick={submit}>{t('common.generate')} · {cost} {t('common.credits')}</Btn>
      </div>
      <section className="stack"><h2>{t('img.history')}</h2>
        <CreationList kind="video" creations={creations} renderExtra={(g: Generation) => g.status === 'completed' ? <Btn variant="ghost" className="sm" onClick={() => { setPrompt(g.prompt); setDur(g.params.durationSec ?? 5); setAspect(g.params.aspect ?? '16:9'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>↻ {t('common.regenerate')}</Btn> : null} />
      </section>
    </div>
  );
}
