import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Field, Segmented, Icon, ICONS } from '../components/ui';
import { CreationList, SourcePicker, useCreations, type Generation } from '../components/Gen';

const STYLES = ['', 'Photorealistic', 'Cinematic', 'Anime', '3D render', 'Watercolor', 'Minimal vector', 'Cyberpunk', 'Oil painting'];
export default function ImageStudio() {
  const { t } = useI18n(); const { config, handleError, refreshMe } = useApp(); const creations = useCreations('image');
  const [prompt, setPrompt] = useState(''); const [style, setStyle] = useState(''); const [aspect, setAspect] = useState('1:1'); const [n, setN] = useState(1);
  const [src, setSrc] = useState<{ id: string; url: string } | null>(null); const [busy, setBusy] = useState(false); const [enh, setEnh] = useState(false);
  const cost = (config.creditCosts.image ?? 0) + (n - 1) * (config.creditCosts.image_variation ?? 0);
  const submit = async () => {
    setBusy(true);
    try { const r = await api('/generations/image', { body: { prompt, style: style || undefined, aspect, variations: n, sourceFileId: src?.id } }); void r; await creations.reload(); void refreshMe(); setPrompt(''); }
    catch (e) { handleError(e); } finally { setBusy(false); }
  };
  const enhance = async () => { setEnh(true); try { setPrompt((await api('/ai/enhance-prompt', { body: { prompt, kind: 'image' } })).prompt); void refreshMe(); } catch (e) { handleError(e); } finally { setEnh(false); } };
  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('img.title')}</h1><p className="muted">Text → Image · Image → Image</p></header>
      <div className="card stack">
        <Field label={t('img.prompt')}><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} placeholder="A neon-lit street in Chennai after rain, cinematic" /></Field>
        <div className="row between wrap gap"><Btn variant="soft" className="sm" loading={enh} disabled={prompt.trim().length < 3} onClick={enhance}><Icon d={ICONS.sparkle} size={16} /> {t('img.enhance')}</Btn><span className="muted" style={{ fontSize: '.8rem' }}>{config.creditCosts.prompt_enhance ?? 0} {t('common.credits')}</span></div>
        <Field label={t('img.style')}><select value={style} onChange={(e) => setStyle(e.target.value)}>{STYLES.map((s) => <option key={s} value={s}>{s || '—'}</option>)}</select></Field>
        <div className="field"><span>{t('img.aspect')}</span><Segmented label={t('img.aspect')} value={aspect} onChange={setAspect} options={['1:1', '4:5', '16:9', '9:16', '4:3'].map((v) => ({ value: v, label: v }))} /></div>
        <div className="field"><span>{t('img.variations')}</span><Segmented label={t('img.variations')} value={n} onChange={setN} options={[1, 2, 3, 4].map((v) => ({ value: v, label: String(v) }))} /></div>
        <SourcePicker label={t('img.source')} value={src} onChange={setSrc} />
        <Btn loading={busy} disabled={prompt.trim().length < 3} onClick={submit}>{t('common.generate')} · {cost} {t('common.credits')}</Btn>
      </div>
      <section className="stack"><h2>{t('img.history')}</h2>
        <CreationList kind="image" creations={creations} renderExtra={(g: Generation) => g.status === 'completed' ? <Btn variant="ghost" className="sm" onClick={() => { setPrompt(g.prompt); setStyle(g.params.style ?? ''); setAspect(g.params.aspect ?? '1:1'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>↻ {t('common.regenerate')}</Btn> : null} />
      </section>
    </div>
  );
}
