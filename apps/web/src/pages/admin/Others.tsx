import { useCallback, useEffect, useState } from 'react';
import { A, Draft } from './Admin';
import { api, fmtMoney, uploadFile } from '../../lib/api';
import { errMessage, useApp } from '../../lib/store';
import { Btn, Card, Empty, ErrorState, Field, Loading, Segmented } from '../../components/ui';

function useList<T = any>(path: string) {
  const [items, setItems] = useState<T[] | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => { setErr(null); A(path).then((r) => setItems(r.items)).catch(setErr); }, [path]); useEffect(load, [load]);
  return { items, err, load };
}
const Table = ({ head, children }: { head: string[]; children: React.ReactNode }) => <div className="tbl-wrap"><table className="tbl"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
const when = (s: string) => new Date(s).toLocaleString();

export function Referrals() {
  const { toast } = useApp(); const rules = useList('/referral-rules'); const refs = useList('/referrals'); const rewards = useList('/referral-rewards'); const [f, setF] = useState<any>({ requiredCount: 1, rewardType: 'feature', featureKey: 'image', credits: 100, unlockDays: 7, maxAwardsPerUser: 1, label: '' });
  return (
    <div className="stack-lg"><h1>Referrals</h1>
      <Draft k="referral" label="Program settings">{(v, set) => (<>
        <label className="row gap"><input type="checkbox" checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Referral program enabled</label>
        <div className="grid g4">{([['expiryDays', 'Referral expiry (days)'], ['maxQualifiedPerReferrer', 'Max qualified / user'], ['dailyInviteCap', 'Daily signup cap / referrer'], ['minAccountAgeHours', 'Min account age (h)'], ['maxPerDevice', 'Max accounts / device'], ['maxPerIp', 'Max signups / IP / referrer']] as const).map(([k, l]) => <Field key={k} label={l}><input type="number" min={0} value={v[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} /></Field>)}</div>
        <label className="row gap"><input type="checkbox" checked={v.requireEmailVerified} onChange={(e) => set({ requireEmailVerified: e.target.checked })} /> Require verified email to qualify</label></>)}</Draft>
      <Card className="stack"><h2>Reward rules</h2>
        {rules.err ? <ErrorState error={rules.err} onRetry={rules.load} /> : !rules.items ? <Loading rows={1} /> : <Table head={['Needs', 'Reward', 'Duration', 'Max', 'Active', '']}>{rules.items.map((r) => <tr key={r.id}><td>{r.required_count} verified</td><td>{r.reward_type === 'credits' ? `${r.credits} credits` : `${r.feature_key} unlock`}<div className="muted">{r.label}</div></td><td>{r.unlock_days ? `${r.unlock_days}d` : 'permanent'}</td><td>{r.max_awards_per_user}</td><td>{r.active ? '✓' : '—'}</td><td><Btn variant="ghost" className="sm" onClick={async () => { await A(`/referral-rules/${r.id}`, { method: 'DELETE' }); rules.load(); }}>Disable</Btn></td></tr>)}</Table>}
        <b>Add rule</b><div className="grid g4"><Field label="Required referrals"><input type="number" min={1} value={f.requiredCount} onChange={(e) => setF({ ...f, requiredCount: Number(e.target.value) })} /></Field>
          <Field label="Reward"><select value={f.rewardType} onChange={(e) => setF({ ...f, rewardType: e.target.value })}><option value="feature">Unlock AI feature</option><option value="credits">Credits</option></select></Field>
          {f.rewardType === 'feature' ? <Field label="Feature"><select value={f.featureKey} onChange={(e) => setF({ ...f, featureKey: e.target.value })}>{['chat', 'image', 'video', 'promo', 'edit'].map((x) => <option key={x}>{x}</option>)}</select></Field> : <Field label="Credits"><input type="number" min={1} value={f.credits} onChange={(e) => setF({ ...f, credits: Number(e.target.value) })} /></Field>}
          <Field label="Unlock days (blank = permanent)"><input type="number" min={1} value={f.unlockDays ?? ''} onChange={(e) => setF({ ...f, unlockDays: e.target.value ? Number(e.target.value) : null })} /></Field><Field label="Max awards / user"><input type="number" min={1} value={f.maxAwardsPerUser} onChange={(e) => setF({ ...f, maxAwardsPerUser: Number(e.target.value) })} /></Field><Field label="Label shown to users"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={120} /></Field></div>
        <Btn className="sm" style={{ justifySelf: 'start' }} onClick={async () => { try { await A('/referral-rules', { body: { ...f, featureKey: f.rewardType === 'feature' ? f.featureKey : null, credits: f.rewardType === 'credits' ? f.credits : null } }); toast('Rule added'); rules.load(); } catch (e) { toast(errMessage(e), 'err'); } }}>Add rule</Btn></Card>
      <Card className="stack"><h2>Referrals</h2>{refs.err ? <ErrorState error={refs.err} onRetry={refs.load} /> : !refs.items ? <Loading rows={1} /> : refs.items.length === 0 ? <Empty /> : <Table head={['Referrer', 'Referred', 'Status', 'Abuse flags', 'Date', '']}>{refs.items.map((r) => <tr key={r.id}><td>@{r.referrer}</td><td>@{r.referred}<div className="muted">{r.referred_email}</div></td><td><span className={`pill-status ${r.status === 'qualified' ? 'completed' : r.status === 'rejected' ? 'failed' : 'queued'}`}>{r.status}</span></td><td>{r.abuse_flags.map((x: string) => <span key={x} className="chip" style={{ marginRight: 4 }}>{x}</span>)}</td><td>{when(r.created_at)}</td><td>{r.status !== 'rejected' && <Btn variant="danger" className="sm" onClick={async () => { await A(`/referrals/${r.id}/reject`, { body: {} }); refs.load(); }}>Reject</Btn>}</td></tr>)}</Table>}</Card>
      <Card className="stack"><h2>Rewards granted</h2>{!rewards.items ? <Loading rows={1} /> : rewards.items.length === 0 ? <Empty /> : <Table head={['User', 'Reward', 'Status', 'Date']}>{rewards.items.map((r) => <tr key={r.id}><td>@{r.username}</td><td>{r.label || (r.reward_type === 'credits' ? `${r.credits} credits` : r.feature_key)}</td><td>{r.status}</td><td>{when(r.created_at)}</td></tr>)}</Table>}</Card>
    </div>
  );
}

export function Promotions() {
  const { toast, handleError } = useApp(); const list = useList('/promotions'); const [f, setF] = useState<any>({ title: '', body: '', kind: 'banner', ctaLabel: '', ctaUrl: '/pricing', discountPercent: '', startsAt: '', endsAt: '', couponCode: '' }); const [asset, setAsset] = useState<{ id: string; name: string } | null>(null); const [busy, setBusy] = useState(false); const [ann, setAnn] = useState({ title: '', body: '' });
  const create = async () => {
    setBusy(true);
    try {
      let couponId: string | null = null;
      if (f.couponCode) { const c = (await A('/coupons')).items.find((x: any) => x.code.toLowerCase() === f.couponCode.toLowerCase()); if (!c) throw new Error('Coupon not found — create it under Pricing first.'); couponId = c.id; }
      await A('/promotions', { body: { title: f.title, body: f.body, kind: f.kind, assetFileId: asset?.id ?? null, ctaLabel: f.ctaLabel || null, ctaUrl: f.ctaUrl || null, couponId, discountPercent: f.discountPercent ? Number(f.discountPercent) : null, startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null, active: true } });
      toast('Campaign live'); setAsset(null); setF({ ...f, title: '', body: '' }); list.load();
    } catch (e) { handleError(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack-lg"><h1>Promotion Manager</h1>
      <Card className="stack"><h2>New campaign</h2>
        <div className="grid g2"><Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={100} /></Field><Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="banner">Banner</option><option value="offer">Offer</option><option value="announcement">Announcement</option></select></Field></div>
        <Field label="Message"><input value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={400} /></Field>
        <div className="grid g4"><Field label="Button label"><input value={f.ctaLabel} onChange={(e) => setF({ ...f, ctaLabel: e.target.value })} maxLength={30} /></Field><Field label="Button link"><input value={f.ctaUrl} onChange={(e) => setF({ ...f, ctaUrl: e.target.value })} /></Field><Field label="Coupon code (optional)"><input value={f.couponCode} onChange={(e) => setF({ ...f, couponCode: e.target.value })} /></Field><Field label="Discount % (display)"><input type="number" min={1} max={100} value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: e.target.value })} /></Field></div>
        <div className="grid g2"><Field label="Starts"><input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field><Field label="Ends"><input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field></div>
        <div className="row gap wrap"><label className="btn soft sm" style={{ cursor: 'pointer' }}>{asset ? `✓ ${asset.name.slice(0, 20)}` : 'Upload banner / image / video'}<input type="file" hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { const r = await uploadFile(file, 'promo', 'admin'); setAsset({ id: r.id, name: file.name }); } catch (x) { handleError(x); } }} /></label><Btn loading={busy} disabled={!f.title.trim()} onClick={create}>Publish campaign</Btn></div></Card>
      <Card className="stack"><h2>Campaigns</h2>{list.err ? <ErrorState error={list.err} onRetry={list.load} /> : !list.items ? <Loading rows={1} /> : list.items.length === 0 ? <Empty /> : <Table head={['Title', 'Type', 'Window', 'Active', '']}>{list.items.map((p) => <tr key={p.id}><td><b>{p.title}</b><div className="muted">{p.body}</div></td><td>{p.kind}</td><td className="muted">{p.starts_at ? when(p.starts_at) : 'now'} → {p.ends_at ? when(p.ends_at) : '∞'}</td>
          <td><input type="checkbox" checked={p.active} aria-label="Active" onChange={async (e) => { await A(`/promotions/${p.id}`, { method: 'PUT', body: { title: p.title, body: p.body, kind: p.kind, assetFileId: p.asset_file_id, ctaLabel: p.cta_label, ctaUrl: p.cta_url, couponId: p.coupon_id, discountPercent: p.discount_percent, startsAt: p.starts_at, endsAt: p.ends_at, active: e.target.checked } }); list.load(); }} /></td>
          <td className="row" style={{ gap: 4 }}><Btn variant="soft" className="sm" disabled={!!p.push_sent_at} onClick={async () => { if (confirm('Send push + in-app notification to all users?')) { await A(`/promotions/${p.id}/push`, { body: {} }).catch(handleError); list.load(); } }}>{p.push_sent_at ? 'Pushed' : 'Push'}</Btn><Btn variant="ghost" className="sm" onClick={async () => { await A(`/promotions/${p.id}`, { method: 'DELETE' }); list.load(); }}>✕</Btn></td></tr>)}</Table>}</Card>
      <Card className="stack"><h2>Send announcement</h2><Field label="Title"><input value={ann.title} onChange={(e) => setAnn({ ...ann, title: e.target.value })} maxLength={100} /></Field><Field label="Message"><input value={ann.body} onChange={(e) => setAnn({ ...ann, body: e.target.value })} maxLength={400} /></Field>
        <Btn style={{ justifySelf: 'start' }} disabled={!ann.title.trim()} onClick={async () => { if (confirm('Notify ALL active users?')) { try { await A('/announcements', { body: ann }); toast('Announcement sent'); setAnn({ title: '', body: '' }); } catch (e) { handleError(e); } } }}>Send to all users</Btn></Card>
    </div>
  );
}

export function Moderation() {
  const { handleError, toast } = useApp(); const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open'); const list = useList(`/reports?status=${status}`); const logs = useList('/moderation-logs');
  const act = async (id: string, action: string) => { const note = action === 'dismiss' ? '' : prompt('Moderator note (optional)') ?? ''; try { await A(`/reports/${id}/action`, { body: { action, note } }); toast('Done'); list.load(); logs.load(); } catch (e) { handleError(e); } };
  return (
    <div className="stack-lg"><h1>Moderation</h1><Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'actioned', label: 'Actioned' }, { value: 'dismissed', label: 'Dismissed' }]} />
      {list.err ? <ErrorState error={list.err} onRetry={list.load} /> : !list.items ? <Loading /> : list.items.length === 0 ? <Empty icon="🛡" title="No reports" /> : <div className="stack">{list.items.map((r) => (
        <Card key={r.id} className="stack"><div className="row between wrap gap"><span className="chip hot">{r.target_type} · {r.reason}</span><span className="muted">{r.report_count} report(s) · by @{r.reporter} · {when(r.created_at)}</span></div>
          {r.target ? <div>{r.target.media && (r.target.media.mime.startsWith('video/') ? <video src={r.target.media.url} controls preload="none" style={{ maxHeight: 220, borderRadius: 12 }} /> : <img src={r.target.media.url} alt="" style={{ maxHeight: 220, borderRadius: 12 }} />)}<p>{r.target.body ?? `@${r.target.username}`}</p><div className="muted">{r.target.author && `by @${r.target.author}`} {r.target.removed && '· removed'} {r.target.status && `· ${r.target.status}`}</div></div> : <p className="muted">Content no longer exists.</p>}
          {r.details && <p className="muted">“{r.details}”</p>}
          {status === 'open' && <div className="row wrap" style={{ gap: 6 }}><Btn variant="ghost" className="sm" onClick={() => act(r.id, 'dismiss')}>Dismiss</Btn>{r.target_type !== 'user' && <Btn variant="soft" className="sm" onClick={() => act(r.id, 'remove_content')}>Remove content</Btn>}<Btn variant="soft" className="sm" onClick={() => act(r.id, 'suspend_user')}>Suspend 7d</Btn><Btn variant="danger" className="sm" onClick={() => act(r.id, 'block_user')}>Block user</Btn></div>}</Card>))}</div>}
      <Card className="stack"><h2>Moderation log</h2>{!logs.items ? <Loading rows={1} /> : <Table head={['When', 'Moderator', 'Action', 'Target', 'Note']}>{logs.items.map((l) => <tr key={l.id}><td>{when(l.created_at)}</td><td>{l.actor}</td><td>{l.action}</td><td className="muted">{l.target_type} {String(l.target_id).slice(0, 8)}</td><td>{l.note}</td></tr>)}</Table>}</Card>
    </div>
  );
}

export function Users() {
  const { handleError, toast } = useApp(); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const list = useList(`/users?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`);
  const [debounced, setDebounced] = useState(q); void debounced; useEffect(() => { const id = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(id); }, [q]);
  const setSt = async (id: string, s: string) => { try { await A(`/users/${id}/status`, { body: { status: s, days: 7 } }); toast('Updated'); list.load(); } catch (e) { handleError(e); } };
  return (
    <div className="stack-lg"><h1>Users</h1><div className="row gap wrap"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or username" aria-label="Search users" style={{ maxWidth: 320 }} /><Segmented label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'blocked', label: 'Blocked' }]} /></div>
      {list.err ? <ErrorState error={list.err} onRetry={list.load} /> : !list.items ? <Loading /> : <Card><Table head={['User', 'Plan', 'Credits', 'Status', 'Joined', 'Actions']}>{list.items.map((u) => <tr key={u.id}><td><b>@{u.username}</b><div className="muted">{u.email}{!u.email_verified_at && ' · unverified'}</div></td><td>{u.paid ? 'Paid' : u.trial_active ? 'Trial' : 'Free'}</td><td>{u.credits}</td><td><span className={`pill-status ${u.status === 'active' ? 'completed' : 'failed'}`}>{u.status}</span></td><td>{new Date(u.created_at).toLocaleDateString()}</td>
        <td className="row wrap" style={{ gap: 4 }}>{u.role === 'admin' ? <span className="muted">owner</span> : <>{u.status === 'active' ? <><Btn variant="ghost" className="sm" onClick={() => setSt(u.id, 'suspended')}>Suspend</Btn><Btn variant="danger" className="sm" onClick={() => setSt(u.id, 'blocked')}>Block</Btn></> : <Btn variant="soft" className="sm" onClick={() => setSt(u.id, 'active')}>Unblock</Btn>}
          <Btn variant="ghost" className="sm" onClick={async () => { const n = Number(prompt('Credits to add (negative to deduct)')); if (!n) return; const reason = prompt('Reason (audited)') ?? ''; try { await A(`/users/${u.id}/credits`, { body: { amount: n, reason } }); toast('Credits updated'); list.load(); } catch (e) { handleError(e); } }}>±Credits</Btn></>}</td></tr>)}</Table></Card>}
    </div>
  );
}

export function Providers() {
  const { handleError, toast } = useApp(); const list = useList('/ai-providers'); const pays = useList('/payments');
  const [f, setF] = useState<any>({ capability: 'text', name: '', adapter: 'openai-compatible', model: '', baseUrl: '', apiKeyEnv: '', priority: 100, config: '{}' });
  return (
    <div className="stack-lg"><h1>AI providers &amp; payments</h1>
      <Card className="stack"><h2>AI providers</h2><p className="muted" style={{ fontSize: '.88rem' }}>Add or swap models without code changes. API keys are never entered here — enter the <b>name of the server environment variable</b> that holds the key.</p>
        {list.err ? <ErrorState error={list.err} onRetry={list.load} /> : !list.items ? <Loading rows={1} /> : <Table head={['Capability', 'Name', 'Adapter / model', 'Key env', 'Priority', 'On', '']}>{list.items.map((p) => <tr key={p.id}><td>{p.capability}</td><td>{p.name}</td><td>{p.adapter}<div className="muted">{p.model}</div></td><td>{p.api_key_env ?? '—'} {p.api_key_env && <span className={`chip ${p.keyConfigured ? 'hot' : ''}`}>{p.keyConfigured ? 'set' : 'missing'}</span>}</td><td>{p.priority}</td>
          <td><input type="checkbox" checked={p.enabled} aria-label="Enabled" onChange={async (e) => { await A(`/ai-providers/${p.id}`, { method: 'PUT', body: { capability: p.capability, name: p.name, adapter: p.adapter, model: p.model, baseUrl: p.base_url, apiKeyEnv: p.api_key_env, config: p.config, priority: p.priority, enabled: e.target.checked } }); list.load(); }} /></td><td><Btn variant="ghost" className="sm" onClick={async () => { if (confirm('Delete provider?')) { await A(`/ai-providers/${p.id}`, { method: 'DELETE' }); list.load(); } }}>✕</Btn></td></tr>)}</Table>}
        <b>Add provider</b>
        <div className="grid g4"><Field label="Capability"><select value={f.capability} onChange={(e) => setF({ ...f, capability: e.target.value })}>{['text', 'image', 'image_edit', 'video', 'voice', 'embedding'].map((c) => <option key={c}>{c}</option>)}</select></Field><Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Adapter"><select value={f.adapter} onChange={(e) => setF({ ...f, adapter: e.target.value })}><option>openai-compatible</option><option>anthropic</option><option>http-async-video</option></select></Field><Field label="Model"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
          <Field label="Base URL"><input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field><Field label="API key env var name"><input value={f.apiKeyEnv} onChange={(e) => setF({ ...f, apiKeyEnv: e.target.value.toUpperCase() })} placeholder="MY_PROVIDER_API_KEY" /></Field><Field label="Priority (low = first)"><input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} /></Field><Field label="Adapter config (JSON)"><input value={f.config} onChange={(e) => setF({ ...f, config: e.target.value })} /></Field></div>
        <Btn className="sm" style={{ justifySelf: 'start' }} onClick={async () => { try { await A('/ai-providers', { body: { capability: f.capability, name: f.name, adapter: f.adapter, model: f.model, baseUrl: f.baseUrl || null, apiKeyEnv: f.apiKeyEnv || null, priority: f.priority, config: JSON.parse(f.config || '{}') } }); toast('Provider added'); list.load(); } catch (e) { handleError(e); } }}>Add provider</Btn></Card>
      <Card className="stack"><h2>Payments</h2>{!pays.items ? <Loading rows={1} /> : pays.items.length === 0 ? <Empty /> : <Table head={['When', 'User', 'Plan', 'Amount', 'Method', 'Status']}>{pays.items.map((p) => <tr key={p.id}><td>{when(p.created_at)}</td><td>@{p.username}</td><td>{p.plan}</td><td>{fmtMoney(p.amount_minor, p.currency)}</td><td>{p.method ?? '—'}</td><td><span className={`pill-status ${p.status === 'paid' ? 'completed' : p.status === 'failed' ? 'failed' : 'queued'}`}>{p.status}</span>{p.failure_reason && <div className="muted">{p.failure_reason}</div>}</td></tr>)}</Table>}</Card>
      <Draft k="limits" label="Upload limits (MB per purpose)">{(v, set) => <div className="grid g4">{Object.keys(v.maxFileMb).map((k) => <Field key={k} label={k}><input type="number" min={1} value={v.maxFileMb[k]} onChange={(e) => set({ maxFileMb: { ...v.maxFileMb, [k]: Number(e.target.value) } })} /></Field>)}</div>}</Draft>
    </div>
  );
}

export function Audit() {
  const list = useList('/audit-logs');
  return <div className="stack-lg"><h1>Audit log</h1>{list.err ? <ErrorState error={list.err} onRetry={list.load} /> : !list.items ? <Loading /> : <Card><Table head={['When', 'Actor', 'Action', 'Target', 'Details']}>{list.items.map((l) => <tr key={l.id}><td>{when(l.created_at)}</td><td>{l.actor ?? '—'}</td><td>{l.action}</td><td className="muted">{l.target ? String(l.target).slice(0, 12) : ''}</td><td className="muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{Object.keys(l.meta ?? {}).length ? JSON.stringify(l.meta).slice(0, 120) : ''}</td></tr>)}</Table></Card>}</div>;
}
void api;
