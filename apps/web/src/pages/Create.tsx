import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Icon, ICONS } from '../components/ui';
import { useApp } from '../lib/store';

export default function Create() {
  const { t } = useI18n(); const { config } = useApp();
  const tools = [
    ['/create/assistant', 'qa.assistant', ICONS.sparkle, 'Chat, write, translate, code and analyse documents'],
    ['/create/image', 'qa.image', ICONS.image, `Text → Image · Image → Image · from ${config.creditCosts.image ?? '…'} credits`],
    ['/create/video', 'qa.video', ICONS.video, `Text → Video · Image → Video · from ${config.creditCosts.video_5s ?? '…'} credits`],
    ['/create/photo-editor', 'qa.photo', ICONS.edit, 'Background removal, object removal, filters, text'],
    ['/create/video-editor', 'qa.videoedit', ICONS.reels, 'Trim, split, merge, captions, music, export'],
    ['/create/promo', 'qa.promo', ICONS.gift, 'Poster, ad copy, caption, hashtags and video'],
    ['/compose', 'common.post', ICONS.create, 'Publish a post or reel'],
  ] as const;
  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('create.title')}</h1><p className="muted">{t('create.sub')}</p></header>
      <div className="grid g4">{tools.map(([to, label, ico, desc]) => (
        <Link key={to} to={to} className="card hover stack" style={{ gap: 10 }}><span className="qa-ico" style={{ width: 46, height: 46, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--primary) 16%, transparent)' }}><Icon d={ico} /></span><h3>{t(label)}</h3><p className="muted" style={{ fontSize: '.85rem' }}>{desc}</p></Link>))}
      </div>
    </div>
  );
}
