import { useState } from 'react';
import { A, Draft } from './Admin';
import { uploadFile } from '../../lib/api';
import { useApp } from '../../lib/store';
import { Btn, Field } from '../../components/ui';

function LogoSlot({ label, field, v, set }: { label: string; field: string; v: any; set: (p: any) => void }) {
  const { handleError } = useApp(); const [busy, setBusy] = useState(false); const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  if (!loaded && v[field]) { setLoaded(true); void A('/branding/preview').then((r) => setUrl(r.urls[field])).catch(() => {}); }
  const pick = async (f?: File) => { if (!f) return; setBusy(true); try { const r = await uploadFile(f, 'branding', 'admin'); set({ [field]: r.id }); setUrl(r.file.url); } catch (e) { handleError(e); } finally { setBusy(false); } };
  return (
    <div className="card stack"><b>{label}</b>
      <div className="canvas-wrap" style={{ minHeight: 90 }}>{v[field] && url ? <img src={url} alt={label} style={{ maxHeight: 80, maxWidth: '100%' }} /> : <span className="muted">Default wordmark</span>}</div>
      <div className="row wrap" style={{ gap: 6 }}><label className="btn soft sm" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : v[field] ? 'Replace' : 'Upload'}<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => void pick(e.target.files?.[0])} /></label>
        {v[field] && <Btn variant="danger" className="sm" onClick={() => { set({ [field]: null }); setUrl(null); }}>Delete</Btn>}</div></div>
  );
}

export function Content() {
  return (
    <div className="stack-lg">
      <h1>Content &amp; Branding</h1>
      <Draft k="branding" label="Branding (logo, text)">{(v, set) => (<>
        <div className="grid g2"><Field label="App name"><input value={v.appName} onChange={(e) => set({ appName: e.target.value })} maxLength={40} /></Field><Field label="Company text"><input value={v.companyText} onChange={(e) => set({ companyText: e.target.value })} maxLength={80} /></Field></div>
        <Field label="Tagline"><input value={v.tagline} onChange={(e) => set({ tagline: e.target.value })} maxLength={120} /></Field>
        <Field label="Positioning line"><input value={v.positioning} onChange={(e) => set({ positioning: e.target.value })} maxLength={160} /></Field>
        <div className="grid g2"><Field label="Home branding text"><input value={v.homeBranding} onChange={(e) => set({ homeBranding: e.target.value })} maxLength={200} /></Field><Field label="Promotional branding text"><input value={v.promoBranding} onChange={(e) => set({ promoBranding: e.target.value })} maxLength={200} /></Field></div>
        <div className="grid g4"><LogoSlot label="App logo" field="logoFileId" v={v} set={set} /><LogoSlot label="Splash logo" field="splashLogoFileId" v={v} set={set} /><LogoSlot label="Login / register logo" field="loginLogoFileId" v={v} set={set} /><LogoSlot label="App icon (favicon)" field="iconFileId" v={v} set={set} /></div>
        <p className="muted" style={{ fontSize: '.85rem' }}>Splash and login fall back to the app logo when not set. Changes go live for everyone on <b>Save &amp; Publish</b> — no rebuild.</p></>)}</Draft>

      <Draft k="home" label="Home screen">{(v, set) => (<>
        <Field label="Title"><input value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} /></Field>
        <Field label="Subtitle"><input value={v.subtitle} onChange={(e) => set({ subtitle: e.target.value })} maxLength={160} /></Field>
        <Field label="AI input placeholder"><input value={v.aiPlaceholder} onChange={(e) => set({ aiPlaceholder: e.target.value })} maxLength={120} /></Field>
        <b>Announcement bar</b><div className="row gap"><label className="row gap"><input type="checkbox" checked={v.announcement.visible} onChange={(e) => set({ announcement: { ...v.announcement, visible: e.target.checked } })} /> Visible</label><input value={v.announcement.text} onChange={(e) => set({ announcement: { ...v.announcement, text: e.target.value } })} maxLength={240} aria-label="Announcement text" /></div>
        <b>Quick actions</b>{v.quickActions.map((a: any, i: number) => <div key={a.key} className="row gap"><input type="checkbox" checked={a.visible} aria-label={`Show ${a.label}`} onChange={(e) => set({ quickActions: v.quickActions.map((x: any, j: number) => j === i ? { ...x, visible: e.target.checked } : x) })} /><input value={a.label} onChange={(e) => set({ quickActions: v.quickActions.map((x: any, j: number) => j === i ? { ...x, label: e.target.value } : x) })} aria-label="Label" /><code className="muted">{a.route}</code></div>)}
        <b>Sections</b><div className="row wrap gap">{v.sections.map((s: any, i: number) => <label key={s.key} className="row gap chip"><input type="checkbox" checked={s.visible} onChange={(e) => set({ sections: v.sections.map((x: any, j: number) => j === i ? { ...x, visible: e.target.checked } : x) })} />{s.key}</label>)}</div>
        <b>Featured AI tools</b>{v.featuredTools.map((tl: any, i: number) => <div key={tl.key} className="grid g3" style={{ gridTemplateColumns: '1fr 2fr 90px auto' }}><input value={tl.title} onChange={(e) => set({ featuredTools: v.featuredTools.map((x: any, j: number) => j === i ? { ...x, title: e.target.value } : x) })} aria-label="Title" /><input value={tl.description} onChange={(e) => set({ featuredTools: v.featuredTools.map((x: any, j: number) => j === i ? { ...x, description: e.target.value } : x) })} aria-label="Description" /><input value={tl.badge ?? ''} placeholder="Badge" onChange={(e) => set({ featuredTools: v.featuredTools.map((x: any, j: number) => j === i ? { ...x, badge: e.target.value } : x) })} aria-label="Badge" /><Btn variant="ghost" className="sm" onClick={() => set({ featuredTools: v.featuredTools.filter((_: any, j: number) => j !== i) })}>✕</Btn></div>)}</>)}</Draft>

      <Draft k="theme" label="Theme (MADIX DARK)">{(v, set) => (<>
        <div className="grid g4">{(['primary', 'secondary', 'accent', 'background', 'text', 'mutedText'] as const).map((k) => <Field key={k} label={k}><input type="color" value={v[k]} onChange={(e) => set({ [k]: e.target.value })} /></Field>)}</div>
        <div className="row gap"><Field label="Gradient start"><input type="color" value={v.gradient[0]} onChange={(e) => set({ gradient: [e.target.value, v.gradient[1]] })} /></Field><Field label="Gradient end"><input type="color" value={v.gradient[1]} onChange={(e) => set({ gradient: [v.gradient[0], e.target.value] })} /></Field></div>
        <div className="row gap wrap"><label className="row gap"><input type="checkbox" checked={v.allowDark} onChange={(e) => set({ allowDark: e.target.checked })} /> Dark mode available</label><label className="row gap"><input type="checkbox" checked={v.allowLight} onChange={(e) => set({ allowLight: e.target.checked })} /> Light mode available</label></div>
        <div style={{ height: 14, borderRadius: 8, background: `linear-gradient(135deg, ${v.gradient.join(',')})` }} aria-hidden />
        <p className="muted" style={{ fontSize: '.85rem' }}>Colours that fail WCAG AA contrast against the background are rejected on save.</p></>)}</Draft>
    </div>
  );
}
