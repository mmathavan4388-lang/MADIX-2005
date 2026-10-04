import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Field, Segmented } from '../components/ui';
import { CreationList, useCreations, type Generation } from '../components/Gen';

const TYPES = ['sale', 'launch', 'festival', 'discount', 'event', 'brand awareness'];
const LANGS = ['English', 'Tamil', 'Hindi', 'Telugu', 'Malayalam', 'Kannada', 'Spanish', 'French'];
export default function PromoStudio() {
  const { t } = useI18n(); const { config, handleError, refreshMe, toast } = useApp(); const creations = useCreations('promo');
  const [f, setF] = useState({ productName: '', description: '', audience: '', brandName: '', promotionType: 'sale', language: 'English', style: 'modern', offer: '', price: '', includeVideo: false, aspect: '1:1' });
  const [busy, setBusy] = useState(false); const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const cost = (config.creditCosts.promo_copy ?? 0) + (config.creditCosts.promo_image ?? 0) + (f.includeVideo ? config.creditCosts.promo_video ?? 0 : 0);
  const submit = async () => { setBusy(true); try { await api('/generations/promo', { body: f }); await creations.reload(); void refreshMe(); } catch (e) { handleError(e); } finally { setBusy(false); } };
  const copy = (s: string) => { void navigator.clipboard.writeText(s); toast(t('common.copied')); };
  const publish = async (g: Generation) => {
    try { await api('/posts', { body: { kind: 'image', body: `${g.meta.caption}\n\n${g.meta.hashtags.map((h: string) => '#' + h).join(' ')}`, fileId: g.meta.posterFileId, aiGenerated: true } }); toast('✓ Published'); } catch (e) { handleError(e); }
  };
  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('promo.title')}</h1><p className="muted">{config.branding.promoBranding || 'Poster · ad copy · caption · hashtags · video concept · promo video'}</p></header>
      <div className="card stack">
        <div className="grid g2"><Field label="Product name"><input value={f.productName} onChange={(e) => set('productName', e.target.value)} maxLength={120} /></Field><Field label="Brand name"><input value={f.brandName} onChange={(e) => set('brandName', e.target.value)} maxLength={80} /></Field></div>
        <Field label="Product description"><textarea value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1500} /></Field>
        <Field label="Target audience"><input value={f.audience} onChange={(e) => set('audience', e.target.value)} maxLength={200} /></Field>
        <div className="grid g2"><Field label="Promotion type"><select value={f.promotionType} onChange={(e) => set('promotionType', e.target.value)}>{TYPES.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Language"><select value={f.language} onChange={(e) => set('language', e.target.value)}>{LANGS.map((x) => <option key={x}>{x}</option>)}</select></Field></div>
        <div className="grid g2"><Field label="Offer"><input value={f.offer} onChange={(e) => set('offer', e.target.value)} placeholder="20% off this week" maxLength={200} /></Field><Field label="Price"><input value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="₹499" maxLength={40} /></Field></div>
        <Field label="Style"><input value={f.style} onChange={(e) => set('style', e.target.value)} placeholder="modern, festive, luxury…" maxLength={60} /></Field>
        <div className="field"><span>{t('img.aspect')}</span><Segmented label={t('img.aspect')} value={f.aspect} onChange={(v) => set('aspect', v)} options={['1:1', '4:5', '9:16', '16:9'].map((v) => ({ value: v, label: v }))} /></div>
        <label className="row gap"><input type="checkbox" checked={f.includeVideo} onChange={(e) => set('includeVideo', e.target.checked)} /> Include promotional video (+{config.creditCosts.promo_video ?? 0} {t('common.credits')})</label>
        <Btn loading={busy} disabled={f.productName.trim().length < 1 || f.description.trim().length < 5} onClick={submit}>{t('common.generate')} · {cost} {t('common.credits')}</Btn>
      </div>
      <section className="stack"><h2>{t('img.history')}</h2>
        <CreationList kind="promo" creations={creations} renderExtra={(g) => g.status === 'completed' && g.meta ? (
          <div className="stack" style={{ gap: 10 }}>
            <div><b>{g.meta.headline}</b><div className="muted">{g.meta.subline}</div></div>
            <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: '.9rem' }}>{g.meta.adCopy}</div>
            <div className="card" style={{ fontSize: '.9rem' }}>{g.meta.caption}<div className="tag">{g.meta.hashtags.map((h: string) => '#' + h).join(' ')}</div></div>
            <div className="card muted" style={{ fontSize: '.85rem' }}>🎬 {g.meta.videoConcept}</div>
            {g.meta.videoError && <p className="muted" style={{ fontSize: '.8rem' }}>Video could not be completed; poster and copy are ready.</p>}
            <div className="row wrap" style={{ gap: 6 }}><Btn variant="soft" className="sm" onClick={() => copy(g.meta.caption + '\n' + g.meta.hashtags.map((h: string) => '#' + h).join(' '))}>{t('common.copy')} caption</Btn><Btn variant="soft" className="sm" onClick={() => copy(g.meta.adCopy)}>{t('common.copy')} ad copy</Btn><Btn className="sm" onClick={() => publish(g)}>{t('common.post')}</Btn></div>
          </div>) : null} />
      </section>
    </div>
  );
}
