import { useEffect, useState } from 'react';
import { A, Draft } from './Admin';
import { fmtMoney } from '../../lib/api';
import { errMessage, useApp } from '../../lib/store';
import { Btn, Card, ErrorState, Field, Loading, Modal } from '../../components/ui';

const FEATURES = ['chat', 'image', 'video', 'promo', 'edit'];
const blankPlan = { code: '', name: '', kind: 'subscription', interval: 'month', priceMinor: 0, compareAtMinor: null, currency: 'INR', credits: 0, features: [] as string[], description: '', badge: null, sort: 100, active: true, startsAt: null, endsAt: null };

function PlanForm({ plan, onClose, onSaved }: { plan: any; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp(); const [p, setP] = useState({ ...plan }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { code: p.code, name: p.name, kind: p.kind, interval: p.kind === 'subscription' ? p.interval : null, priceMinor: Math.round(Number(p.priceMinor)), compareAtMinor: p.compareAtMinor ? Math.round(Number(p.compareAtMinor)) : null, currency: p.currency, credits: Number(p.credits), features: p.features, description: p.description, badge: p.badge || null, sort: Number(p.sort), active: p.active, startsAt: p.startsAt, endsAt: p.endsAt };
      await A(plan.id ? `/plans/${plan.id}` : '/plans', { method: plan.id ? 'PUT' : 'POST', body }); toast('Saved — live immediately'); onSaved(); onClose();
    } catch (e) { setErr(errMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={plan.id ? 'Edit plan' : 'New plan'} onClose={onClose}>
      <div className="grid g2"><Field label="Code"><input value={p.code} onChange={(e) => set('code', e.target.value)} disabled={!!plan.id} /></Field><Field label="Name"><input value={p.name} onChange={(e) => set('name', e.target.value)} /></Field></div>
      <div className="grid g2"><Field label="Type"><select value={p.kind} onChange={(e) => set('kind', e.target.value)}><option value="subscription">Subscription</option><option value="credit_pack">Credit pack</option><option value="promo">Promotional</option></select></Field>
        {p.kind === 'subscription' && <Field label="Interval"><select value={p.interval} onChange={(e) => set('interval', e.target.value)}><option value="month">Monthly</option><option value="year">Yearly</option></select></Field>}</div>
      <div className="grid g2"><Field label="Price (minor units, e.g. paise)" hint={`= ${fmtMoney(Number(p.priceMinor) || 0, p.currency)}`}><input type="number" min={0} value={p.priceMinor} onChange={(e) => set('priceMinor', e.target.value)} /></Field><Field label="Strike-through price (optional)"><input type="number" min={0} value={p.compareAtMinor ?? ''} onChange={(e) => set('compareAtMinor', e.target.value)} /></Field></div>
      <div className="grid g2"><Field label="Credits granted"><input type="number" min={0} value={p.credits} onChange={(e) => set('credits', e.target.value)} /></Field><Field label="Badge"><input value={p.badge ?? ''} onChange={(e) => set('badge', e.target.value)} maxLength={20} /></Field></div>
      <div className="field"><span>Unlocks</span><div className="row wrap gap">{FEATURES.map((f) => <label key={f} className="chip row gap"><input type="checkbox" checked={p.features.includes(f)} onChange={(e) => set('features', e.target.checked ? [...p.features, f] : p.features.filter((x: string) => x !== f))} />{f}</label>)}</div></div>
      <Field label="Description"><input value={p.description} onChange={(e) => set('description', e.target.value)} maxLength={300} /></Field>
      <label className="row gap"><input type="checkbox" checked={p.active} onChange={(e) => set('active', e.target.checked)} /> Active (visible in app)</label>
      {err && <div className="err" role="alert">{err}</div>}<Btn loading={busy} onClick={save}>Save &amp; Publish</Btn>
    </Modal>
  );
}

function Coupons() {
  const { toast } = useApp(); const [items, setItems] = useState<any[] | null>(null); const [f, setF] = useState({ code: '', percentOff: '', amountOffMinor: '', maxRedemptions: '' }); const [err, setErr] = useState('');
  const load = () => A('/coupons').then((r) => setItems(r.items)).catch(() => setItems([])); useEffect(() => { void load(); }, []);
  return (
    <Card className="stack"><h2>Coupons</h2>
      <div className="grid g4"><Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field><Field label="% off"><input type="number" min={1} max={100} value={f.percentOff} onChange={(e) => setF({ ...f, percentOff: e.target.value, amountOffMinor: '' })} /></Field><Field label="or amount off (minor)"><input type="number" min={1} value={f.amountOffMinor} onChange={(e) => setF({ ...f, amountOffMinor: e.target.value, percentOff: '' })} /></Field><Field label="Max uses"><input type="number" min={1} value={f.maxRedemptions} onChange={(e) => setF({ ...f, maxRedemptions: e.target.value })} /></Field></div>
      {err && <div className="err" role="alert">{err}</div>}
      <Btn className="sm" style={{ justifySelf: 'start' }} onClick={async () => { setErr(''); try { await A('/coupons', { body: { code: f.code, percentOff: f.percentOff ? Number(f.percentOff) : null, amountOffMinor: f.amountOffMinor ? Number(f.amountOffMinor) : null, maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null } }); setF({ code: '', percentOff: '', amountOffMinor: '', maxRedemptions: '' }); toast('Coupon created'); void load(); } catch (e) { setErr(errMessage(e)); } }}>Create coupon</Btn>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Code</th><th>Discount</th><th>Used</th><th>Active</th></tr></thead><tbody>{(items ?? []).map((c) => <tr key={c.id}><td><b>{c.code}</b></td><td>{c.percent_off ? `${c.percent_off}%` : fmtMoney(c.amount_off_minor)}</td><td>{c.redeemed}{c.max_redemptions ? `/${c.max_redemptions}` : ''}</td><td><input type="checkbox" checked={c.active} aria-label="Active" onChange={async (e) => { await A(`/coupons/${c.id}`, { method: 'PUT', body: { code: c.code, percentOff: c.percent_off, amountOffMinor: c.amount_off_minor, maxRedemptions: c.max_redemptions, planCodes: c.plan_codes, startsAt: c.starts_at, endsAt: c.ends_at, active: e.target.checked } }); void load(); }} /></td></tr>)}</tbody></table></div></Card>
  );
}

export function Pricing() {
  const [plans, setPlans] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null); const [edit, setEdit] = useState<any | null>(null);
  const load = () => { setErr(null); A('/plans').then((r) => setPlans(r.items)).catch(setErr); }; useEffect(load, []);
  return (
    <div className="stack-lg">
      <h1>Pricing &amp; Plans</h1>
      <Card className="stack"><div className="row between"><h2>Plans &amp; credit packs</h2><Btn className="sm" onClick={() => setEdit({ ...blankPlan })}>+ New plan</Btn></div>
        {err ? <ErrorState error={err} onRetry={load} /> : !plans ? <Loading rows={2} /> : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Type</th><th>Price</th><th>Credits</th><th>Unlocks</th><th>Status</th><th /></tr></thead><tbody>
          {plans.map((p) => <tr key={p.id}><td><b>{p.name}</b><div className="muted">{p.code}</div></td><td>{p.kind}{p.interval ? ` · ${p.interval}` : ''}</td><td>{fmtMoney(p.price_minor, p.currency)}{p.compare_at_minor ? <span className="muted"> <s>{fmtMoney(p.compare_at_minor, p.currency)}</s></span> : null}</td><td>{p.credits}</td><td>{p.features.join(', ') || '—'}</td><td><span className={`chip ${p.active ? 'hot' : ''}`}>{p.active ? 'active' : 'disabled'}</span></td><td><Btn variant="soft" className="sm" onClick={() => setEdit({ id: p.id, code: p.code, name: p.name, kind: p.kind, interval: p.interval, priceMinor: p.price_minor, compareAtMinor: p.compare_at_minor, currency: p.currency, credits: p.credits, features: p.features, description: p.description, badge: p.badge, sort: p.sort, active: p.active, startsAt: p.starts_at, endsAt: p.ends_at })}>Edit</Btn></td></tr>)}</tbody></table></div>}
      </Card>
      <Coupons />
      <Draft k="credit_costs" label="Credit costs (per action)">{(v, set) => (<div className="grid g4">{Object.keys(v).sort().map((k) => <Field key={k} label={k}><input type="number" min={0} value={v[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} /></Field>)}</div>)}</Draft>
      <Draft k="trial" label="Free trial">{(v, set) => (<>
        <label className="row gap"><input type="checkbox" checked={v.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Trial enabled for new verified users</label>
        <div className="grid g3"><Field label="Duration (days)"><input type="number" min={0} max={90} value={v.durationDays} onChange={(e) => set({ durationDays: Number(e.target.value) })} /></Field><Field label="Free credits"><input type="number" min={0} value={v.freeCredits} onChange={(e) => set({ freeCredits: Number(e.target.value) })} /></Field><Field label="Reminder (hours before end)"><input type="number" min={1} max={72} value={v.endingNotifyHours} onChange={(e) => set({ endingNotifyHours: Number(e.target.value) })} /></Field></div>
        <b>Per-feature trial limits (uses)</b><div className="grid g4">{Object.keys(v.featureLimits).map((k) => <Field key={k} label={k}><input type="number" min={0} value={v.featureLimits[k]} onChange={(e) => set({ featureLimits: { ...v.featureLimits, [k]: Number(e.target.value) } })} /></Field>)}</div></>)}</Draft>
      <Draft k="entitlements" label="AI feature availability (kill-switches)">{(v, set) => (<div className="row wrap gap">{Object.keys(v.featureEnabled).map((k) => <label key={k} className="chip row gap"><input type="checkbox" checked={v.featureEnabled[k]} onChange={(e) => set({ featureEnabled: { ...v.featureEnabled, [k]: e.target.checked } })} />{k}</label>)}</div>)}</Draft>
      {edit && <PlanForm plan={edit} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
