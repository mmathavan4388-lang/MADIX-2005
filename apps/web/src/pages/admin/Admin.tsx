import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, getTokens, setTokens, ApiError, fmtMoney, fmtBytes } from '../../lib/api';
import { errMessage, useApp } from '../../lib/store';
import { Btn, Card, Empty, ErrorState, Field, Loading, Logo, Modal, Segmented } from '../../components/ui';
import { LineChart, BarList } from '../../components/Charts';
import { Content } from './Content';
import { Pricing as PricingAdmin } from './PricingAdmin';
import { Referrals, Promotions, Moderation, Users, Providers, Audit } from './Others';

export const A = <T = any,>(path: string, o: { method?: string; body?: unknown } = {}) => api<T>(`/admin${path}`, { ...o, scope: 'admin' });

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ email: '', password: '', totp: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <div className="auth"><form className="auth-card glass" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { const r = await api('/admin/auth/login', { body: f, auth: false, scope: 'admin' }); setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken }, 'admin'); onDone(); } catch (x) { setErr(x instanceof ApiError && x.status === 429 ? x.message : errMessage(x)); } finally { setBusy(false); } }}>
      <Logo kind="login" size={40} stacked /><h1 style={{ fontSize: '1.3rem' }}>Owner console</h1>
      <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" required /></Field>
      <Field label="Password"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" required /></Field>
      <Field label="Authenticator code (2FA)" error={err}><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={f.totp} onChange={(e) => setF({ ...f, totp: e.target.value.replace(/\D/g, '') })} autoComplete="one-time-code" required /></Field>
      <Btn type="submit" loading={busy}>Sign in</Btn>
    </form></div>
  );
}

export function Draft({ k, onPublished, children, label }: { k: string; onPublished?: () => void; children: (v: any, set: (patch: any) => void) => ReactNode; label: string }) {
  const { toast, reloadConfig } = useApp(); const [d, setD] = useState<any>(null); const [local, setLocal] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(''); const [msg, setMsg] = useState('');
  const load = useCallback(() => { setErr(null); A(`/settings/${k}`).then((r) => { setD(r); setLocal(r.draft); }).catch(setErr); }, [k]);
  useEffect(load, [load]);
  if (err) return <ErrorState error={err} onRetry={load} />; if (!d) return <Loading rows={2} />;
  const dirty = JSON.stringify(local) !== JSON.stringify(d.draft);
  const run = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); setMsg(''); try { await fn(); load(); } catch (e) { setMsg(errMessage(e)); } finally { setBusy(''); } };
  return (
    <Card className="stack">
      <div className="row between wrap gap"><h2>{label}</h2><span className={`chip ${dirty || d.hasUnpublished ? 'hot' : ''}`}>{dirty ? 'Unsaved changes' : d.hasUnpublished ? 'Draft not published' : `Published v${d.version}`}</span></div>
      {children(local, (p) => setLocal({ ...local, ...p }))}
      {msg && <div className="err" role="alert">{msg}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <Btn variant="soft" loading={busy === 'save'} disabled={!dirty} onClick={() => run('save', () => A(`/settings/${k}`, { method: 'PUT', body: local }))}>Save draft</Btn>
        <Btn loading={busy === 'pub'} disabled={!dirty && !d.hasUnpublished} onClick={() => run('pub', async () => { if (dirty) await A(`/settings/${k}`, { method: 'PUT', body: local }); await A(`/settings/${k}/publish`, { body: {} }); await reloadConfig(); toast('Published — live for all users'); onPublished?.(); })}>Save &amp; Publish</Btn>
        <Btn variant="ghost" disabled={!d.hasUnpublished && !dirty} onClick={() => run('x', async () => { await A(`/settings/${k}/draft`, { method: 'DELETE' }); })}>Discard</Btn>
      </div>
    </Card>
  );
}

function Dashboard() {
  const [d, setD] = useState<any>(null); const [an, setAn] = useState<any>(null); const [sys, setSys] = useState<any>(null); const [days, setDays] = useState(30); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => { setErr(null); Promise.all([A('/dashboard'), A(`/analytics?days=${days}`), A('/system')]).then(([a, b, c]) => { setD(a); setAn(b); setSys(c); }).catch(setErr); }, [days]);
  useEffect(load, [load]);
  if (err) return <ErrorState error={err} onRetry={load} />; if (!d || !an) return <Loading rows={4} />;
  const Stat = ({ l, v, sub }: { l: string; v: string | number; sub?: string }) => <Card className="stat"><small>{l}</small><b>{v}</b>{sub && <small>{sub}</small>}</Card>;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <div className="stack-lg">
      <div className="row between wrap gap"><h1>Dashboard</h1><Segmented label="Range" value={days} onChange={setDays} options={[7, 30, 90].map((v) => ({ value: v, label: `${v}d` }))} /></div>
      <div className="grid g4">
        <Stat l="Total users" v={d.users.total} sub={`+${d.users.new7} this week`} /><Stat l="Active today / 7d / 30d" v={`${d.users.activeToday} / ${d.users.active7} / ${d.users.active30}`} />
        <Stat l="Trial users" v={d.users.trial} /><Stat l="Paid users" v={d.users.paid} />
        <Stat l="Revenue (30d)" v={fmtMoney(d.revenue.last30Minor)} sub={`All time ${fmtMoney(d.revenue.totalMinor)}`} /><Stat l="Payments" v={d.revenue.payments} sub={`${d.revenue.failedPayments} failed`} />
        <Stat l="AI generations" v={d.ai.generations} sub={`${d.ai.images} image · ${d.ai.videos} video`} /><Stat l="Credits used (30d)" v={d.ai.creditsSpent30} />
        <Stat l="Storage" v={fmtBytes(d.storageBytes)} /><Stat l="Open reports" v={d.openReports} /><Stat l="Queue" v={d.queue.pending} sub={`${d.queue.failed24h} failed (24h)`} /><Stat l="Trial → paid" v={pct(an.trialConversion.converted, an.trialConversion.started)} sub={`${an.trialConversion.converted}/${an.trialConversion.started}`} />
      </div>
      <div className="grid g2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <Card className="stack"><h3>Daily active users &amp; registrations</h3><LineChart label="DAU and signups" data={an.daily} series={[{ key: 'dau', color: '#8B5CF6', name: 'DAU' }, { key: 'signups', color: '#22D3EE', name: 'New users' }]} /></Card>
        <Card className="stack"><h3>AI generations</h3><LineChart label="Generations" data={an.daily} series={[{ key: 'generations', color: '#22D3EE', name: 'Generations' }]} /></Card>
        <Card className="stack"><h3>Revenue (₹)</h3><LineChart label="Revenue" data={an.daily.map((x: any) => ({ ...x, rev: Math.round(x.revenue_minor / 100) }))} series={[{ key: 'rev', color: '#34D399', name: 'Revenue ₹' }]} /></Card>
        <Card className="stack"><h3>Popular AI tools</h3>{an.tools.length ? <BarList rows={an.tools.map((x: any) => ({ name: x.name, n: x.n }))} color="var(--secondary)" /> : <Empty />}<small className="muted">AI chat messages: {an.chatMessages}</small></Card>
        <Card className="stack"><h3>Popular features</h3>{an.popularFeatures.length ? <BarList rows={an.popularFeatures} /> : <Empty />}</Card>
        <Card className="stack"><h3>Funnel &amp; retention</h3>
          <dl className="kv"><dt>Registered</dt><dd>{an.verificationRate.registered}</dd><dt>Verified</dt><dd>{an.verificationRate.verified} ({pct(an.verificationRate.verified, an.verificationRate.registered)})</dd>
            <dt>Paid conversion</dt><dd>{an.paidUsersInRange} paying users</dd><dt>Day-1 retention</dt><dd>{pct(an.retention.d1, an.retention.cohort)}</dd><dt>Day-7 retention</dt><dd>{pct(an.retention.d7, an.retention.d7_eligible)}</dd>
            <dt>Referrals</dt><dd>{an.referrals.qualified} qualified / {an.referrals.total} ({an.referrals.rejected} rejected)</dd></dl></Card>
      </div>
      {sys && <Card className="stack"><h3>System status</h3><div className="grid g4">
        <div className="lvl"><i className={`dot ${sys.database ? 'on' : ''}`} /> Database</div><div className="lvl"><i className={`dot ${sys.storage.ok && sys.storage.driver === 's3' ? 'on' : ''}`} /> Storage ({sys.storage.driver}{sys.storage.cdn ? ' + CDN' : ''})</div>
        <div className="lvl"><i className={`dot ${sys.payments.razorpayConfigured ? 'on' : ''}`} /> Payments gateway</div><div className="lvl"><i className={`dot ${sys.payments.webhookConfigured ? 'on' : ''}`} /> Payment webhook</div>
        <div className="lvl"><i className={`dot ${sys.email ? 'on' : ''}`} /> Email (SMTP)</div><div className="lvl"><i className={`dot ${sys.push ? 'on' : ''}`} /> Push notifications</div>
        {Object.entries(sys.providers).map(([k, v]) => <div key={k} className="lvl"><i className={`dot ${(v as number) > 0 ? 'on' : ''}`} /> AI {k}: {v as number} provider(s)</div>)}
        <div className="lvl"><i className={`dot ${sys.oldestQueuedJobSec < 300 ? 'on' : ''}`} /> Queue lag {sys.oldestQueuedJobSec}s</div></div></Card>}
    </div>
  );
}

export default function Admin() {
  const [authed, setAuthed] = useState(!!getTokens('admin')); const nav = useNavigate(); const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { if (!authed) return; A('/me').then(() => setOk(true)).catch(() => { setTokens(null, 'admin'); setAuthed(false); setOk(null); }); }, [authed]);
  if (!authed) return <AdminLogin onDone={() => setAuthed(true)} />;
  if (!ok) return <div className="auth"><Loading rows={2} /></div>;
  const links: [string, string][] = [['', 'Dashboard'], ['content', 'Content & Branding'], ['pricing', 'Pricing & Plans'], ['referrals', 'Referrals'], ['promotions', 'Promotions'], ['moderation', 'Moderation'], ['users', 'Users'], ['providers', 'AI & System'], ['audit', 'Audit log']];
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Admin"><div style={{ padding: '4px 10px' }} className="rail-brand-admin"><Logo size={24} /></div>
        {links.map(([to, l]) => <NavLink key={to} to={`/admin/${to}`} end={to === ''}>{l}</NavLink>)}
        <a href="/" style={{ marginTop: 'auto' }}>← App</a><a role="button" tabIndex={0} onClick={async () => { await A('/auth/logout', { body: {} }).catch(() => {}); setTokens(null, 'admin'); setAuthed(false); nav('/admin'); }}>Sign out</a></nav>
      <main className="admin-main">
        <Routes><Route index element={<Dashboard />} /><Route path="content" element={<Content />} /><Route path="pricing" element={<PricingAdmin />} /><Route path="referrals" element={<Referrals />} />
          <Route path="promotions" element={<Promotions />} /><Route path="moderation" element={<Moderation />} /><Route path="users" element={<Users />} /><Route path="providers" element={<Providers />} /><Route path="audit" element={<Audit />} /><Route path="*" element={<Navigate to="/admin" replace />} /></Routes>
      </main>
    </div>
  );
}
void Modal;
