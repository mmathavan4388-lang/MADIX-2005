import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, uploadFile } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n, LANGUAGES } from '../i18n';
import { Avatar, Btn, Card, Empty, ErrorState, Field, Loading, Logo, Modal, Segmented, useInfinite, usePaged } from '../components/ui';
import { PostCard } from '../components/PostCard';
import { CreationCard, type Generation } from '../components/Gen';
import { fmtRemaining } from './Home';

type Tab = 'posts' | 'reels' | 'saved' | 'ai' | 'invite' | 'settings';

function PostList({ fetcher, deps }: { fetcher: (c: any) => Promise<any>; deps: unknown[] }) {
  const list = usePaged<any>(fetcher, deps); const s = useInfinite(list.more, list.hasMore);
  if (list.state === 'loading') return <Loading />; if (list.state === 'error') return <ErrorState error={list.err} onRetry={list.reload} />;
  if (!list.items.length) return <Empty />;
  return <div className="stack">{list.items.map((p) => <PostCard key={p.id} post={p} onRemoved={list.reload} />)}<div ref={s} /></div>;
}
function History() {
  const list = usePaged<Generation>((c) => api(`/generations${c ? `?cursor=${encodeURIComponent(String(c))}` : ''}`), []); const s = useInfinite(list.more, list.hasMore);
  if (list.state === 'loading') return <Loading />; if (list.state === 'error') return <ErrorState error={list.err} onRetry={list.reload} />; if (!list.items.length) return <Empty />;
  return <div className="stack">{list.items.map((g) => <CreationCard key={g.id} g={g} onChange={list.reload} />)}<div ref={s} /></div>;
}
function Invite() {
  const { t } = useI18n(); const { toast } = useApp(); const [d, setD] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { api('/me/referrals').then(setD).catch(setErr); }, []);
  if (err) return <ErrorState error={err} />; if (!d) return <Loading rows={2} />;
  if (!d.enabled) return <Empty title="Referral program is paused" />;
  const label = (r: any) => r.label || (r.reward_type === 'credits' ? `${r.credits} credits` : `${r.feature_key} unlock`);
  return (
    <div className="stack">
      <Card className="stack"><h2>{t('ref.title')}</h2><p className="muted">{t('ref.sub')}</p>
        <div className="row gap"><input readOnly value={d.link} aria-label="Invite link" onFocus={(e) => e.target.select()} /><Btn onClick={async () => { if (navigator.share) await navigator.share({ title: 'MADIX', text: 'Join me on MADIX — 3 days free', url: d.link }).catch(() => {}); else { await navigator.clipboard.writeText(d.link); toast(t('common.copied')); } }}>{t('ref.copy')}</Btn></div>
        <div className="status-strip"><span className="chip hot">{t('ref.verified')}: {d.qualified}</span><span className="chip">{t('ref.pending')}: {d.pending}</span></div></Card>
      {d.rules.map((r: any) => { const need = r.required_count; const pct = Math.min(100, (d.qualified / need) * 100); return (
        <Card key={r.id} className="stack"><div className="row between"><b>{need} {t('ref.verified').toLowerCase()}</b><span className="chip hot">{label(r)}</span></div><div className="progress"><i style={{ width: `${pct}%` }} /></div><small className="muted">{Math.min(d.qualified, need)}/{need}{r.awarded > 0 && ' · ✓ unlocked'}</small></Card>); })}
    </div>
  );
}
function PhoneVerify() {
  const { me, refreshMe, handleError, toast } = useApp(); const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false);
  if ((me as any)?.user.phoneVerified) return <span className="chip hot">✓ Phone verified</span>;
  return (
    <div className="stack"><Field label="Phone (international format)"><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" inputMode="tel" autoComplete="tel" /></Field>
      {sent && <Field label="6-digit code"><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} autoComplete="one-time-code" /></Field>}
      <Btn variant="soft" loading={busy} disabled={!phone || (sent && code.length !== 6)} onClick={async () => { setBusy(true); try { if (!sent) { await api('/auth/phone/send-otp', { body: { phone } }); setSent(true); } else { await api('/auth/phone/verify', { body: { phone, code } }); toast('✓'); setSent(false); await refreshMe(); } } catch (e) { handleError(e); } finally { setBusy(false); } }}>{sent ? 'Verify phone' : 'Send code'}</Btn></div>
  );
}
function Settings() {
  const { t, lang, setLang } = useI18n(); const { me, signOut, refreshMe, handleError, toast } = useApp(); const nav = useNavigate();
  const [open, setOpen] = useState(false); const [f, setF] = useState({ displayName: me!.user.displayName, bio: me!.user.bio }); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('/me', { method: 'PATCH', body: f }); await refreshMe(); setOpen(false); } catch (e) { handleError(e); } finally { setBusy(false); } };
  const avatar = async (file?: File) => { if (!file) return; try { const r = await uploadFile(file, 'avatar'); await api('/me', { method: 'PATCH', body: { avatarFileId: r.id } }); await refreshMe(); } catch (e) { handleError(e); } };
  return (
    <div className="stack">
      <Card className="stack"><Field label={t('profile.language')}><select value={lang} onChange={(e) => { setLang(e.target.value); void api('/me', { method: 'PATCH', body: { locale: e.target.value } }).catch(() => {}); }}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select></Field>
        <label className="btn ghost" style={{ cursor: 'pointer' }}>Change photo<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => void avatar(e.target.files?.[0])} /></label>
        <Btn variant="soft" onClick={() => setOpen(true)}>{t('profile.edit')}</Btn>
        <PhoneVerify />
        <Link className="btn soft" to="/pricing">{t('pay.upgrade')} / {t('pay.buyCredits')}</Link>
        <Btn variant="ghost" onClick={async () => { await api('/me/sessions/others', { method: 'DELETE' }).catch(handleError); toast('✓'); }}>Sign out other devices</Btn>
        <Btn variant="danger" onClick={async () => { await signOut(); nav('/login'); }}>{t('auth.logout')}</Btn></Card>
      {open && <Modal title={t('profile.edit')} onClose={() => setOpen(false)}><Field label="Name"><input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} maxLength={60} /></Field><Field label="Bio"><textarea value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={300} /></Field><Btn loading={busy} onClick={save}>{t('common.save')}</Btn></Modal>}
    </div>
  );
}

export default function Profile() {
  const { t } = useI18n(); const { me, config } = useApp(); const [tab, setTab] = useState<Tab>('posts');
  if (!me) return null; const u = me.user;
  return (
    <div className="stack-lg">
      <header className="row between"><Logo size={26} /></header>
      <Card className="stack">
        <div className="row gap"><Avatar url={u.avatar?.url} name={u.displayName || u.username} size={72} /><div className="grow"><h2>{u.displayName}</h2><div className="muted">@{u.username}</div></div></div>
        {u.bio && <p>{u.bio}</p>}
        <div className="row" style={{ justifyContent: 'space-around', textAlign: 'center' }}>
          <div className="stat"><b>{me.counts.posts}</b><small>{t('profile.posts')}</small></div><div className="stat"><b>{me.counts.followers}</b><small>{t('profile.followers')}</small></div><div className="stat"><b>{me.counts.following}</b><small>{t('profile.following')}</small></div></div>
        <div className="status-strip">
          {me.trial?.active && <Link to="/pricing" className="chip hot">⏳ {fmtRemaining(me.trial.msRemaining)}</Link>}
          {me.access.subscriptionActive && <span className="chip hot">✦ {me.access.planCode}</span>}
          <Link to="/pricing" className="chip">{me.credits} {t('common.credits')}</Link>
          {config.referralEnabled && <button className="chip hot" style={{ border: 0, cursor: 'pointer' }} onClick={() => setTab('invite')}>🎁 {t('profile.invite')}</button>}
        </div>
      </Card>
      <div style={{ overflowX: 'auto' }}><Segmented label="Sections" value={tab} onChange={setTab} options={[{ value: 'posts', label: t('profile.posts') }, { value: 'reels', label: t('nav.reels') }, { value: 'saved', label: t('profile.saved') }, { value: 'ai', label: t('profile.history') }, { value: 'invite', label: '🎁' }, { value: 'settings', label: t('profile.settings') }]} /></div>
      {tab === 'posts' && <PostList deps={[tab]} fetcher={(c) => api(`/users/${u.id}/posts${c ? `?cursor=${encodeURIComponent(c)}` : ''}`)} />}
      {tab === 'reels' && <PostList deps={[tab]} fetcher={(c) => api(`/users/${u.id}/posts?kind=reel${c ? `&cursor=${encodeURIComponent(c)}` : ''}`)} />}
      {tab === 'saved' && <PostList deps={[tab]} fetcher={(c) => api(`/saved${c ? `?cursor=${encodeURIComponent(c)}` : ''}`)} />}
      {tab === 'ai' && <History />}{tab === 'invite' && <Invite />}{tab === 'settings' && <Settings />}
    </div>
  );
}
