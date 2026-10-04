import { useEffect, useState } from 'react';
import { api, fmtMoney, ApiError } from '../lib/api';
import { useApp } from '../lib/store';
import { useI18n } from '../i18n';
import { Btn, Card, ErrorState, Loading, Segmented } from '../components/ui';
import { fmtRemaining } from './Home';

interface Plan { id: string; code: string; name: string; kind: 'subscription' | 'credit_pack' | 'promo'; interval: 'month' | 'year' | null; priceMinor: number; compareAtMinor: number | null; currency: string; credits: number; features: string[]; description: string; badge: string | null }
declare global { interface Window { Razorpay?: any } }
const loadRzp = () => new Promise<void>((res, rej) => { if (window.Razorpay) return res(); const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = () => res(); s.onerror = () => rej(new Error('checkout')); document.head.appendChild(s); });
const FEATURE_LABEL: Record<string, string> = { chat: 'AI Assistant', image: 'AI Image', video: 'AI Video', promo: 'Promo Creator', edit: 'AI Photo & Video editing' };

export default function Pricing() {
  const { t } = useI18n(); const { me, config, refreshMe, toast, handleError } = useApp();
  const [plans, setPlans] = useState<Plan[] | null>(null); const [err, setErr] = useState<unknown>(null); const [tab, setTab] = useState<'subscription' | 'credit_pack'>('subscription'); const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [coupon, setCoupon] = useState(''); const [quotes, setQuotes] = useState<Record<string, { total: number; discount: number } | undefined>>({}); const [busy, setBusy] = useState<string | null>(null); const [ledger, setLedger] = useState<any[] | null>(null);
  const load = () => { setErr(null); api('/plans', { auth: false }).then((r) => setPlans(r.plans)).catch(setErr); };
  useEffect(() => { load(); void api('/me/credits').then((r) => setLedger(r.items)).catch(() => setLedger([])); }, []);
  const shown = (plans ?? []).filter((p) => (tab === 'credit_pack' ? p.kind !== 'subscription' : p.kind === 'subscription' && p.interval === period));

  const applyCoupon = async () => {
    if (!coupon.trim()) return setQuotes({});
    const out: typeof quotes = {};
    for (const p of shown) { try { out[p.code] = await api('/billing/quote', { body: { planCode: p.code, couponCode: coupon } }); } catch (e) { if (e instanceof ApiError) { toast(e.message, 'err'); break; } } }
    setQuotes(out);
  };
  const buy = async (p: Plan) => {
    setBusy(p.code);
    try {
      const o = await api('/billing/orders', { body: { planCode: p.code, couponCode: coupon.trim() || undefined } });
      if (o.free) { await refreshMe(); toast(t('pay.success')); return; }
      await loadRzp();
      await new Promise<void>((resolve, reject) => {
        const rz = new window.Razorpay({
          key: o.keyId ?? config.razorpayKeyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: config.branding.appName, description: o.planName, theme: { color: config.theme.primary },
          prefill: { email: me?.user.email }, // GPay / UPI / cards / netbanking are all offered by the gateway
          handler: async (r: any) => {
            try {
              const v = await api('/billing/verify', { body: r }); // server verifies signature AND asks the gateway before unlocking anything
              void v; await refreshMe(); toast(t('pay.success')); resolve();
            } catch (e) {
              if (e instanceof ApiError && e.code === 'payment_pending') { toast(t('pay.pending')); for (let i = 0; i < 20; i++) { await new Promise((r2) => setTimeout(r2, 3000)); const s = await api(`/billing/orders/${o.orderId}`); if (s.status === 'paid') { await refreshMe(); toast(t('pay.success')); break; } } resolve(); } else reject(e);
            }
          },
          modal: { ondismiss: () => resolve() },
        });
        rz.on('payment.failed', () => toast('Payment failed. You have not been charged.', 'err'));
        rz.open();
      });
    } catch (e) { handleError(e); } finally { setBusy(null); }
  };

  return (
    <div className="stack-lg">
      <header><h1 className="grad-text">{t('pay.choose')}</h1>
        {me && <p className="muted">{me.trial?.active ? `⏳ ${t('trial.remaining')}: ${fmtRemaining(me.trial.msRemaining)} · ` : me.trial ? `${t('trial.ended')} · ` : ''}{t('home.credits', { n: me.credits })}{me.access.subscriptionActive && ` · ${me.access.planCode} → ${new Date(me.access.subscriptionEndsAt!).toLocaleDateString()}`}</p>}</header>
      {me?.trial?.active && (
        <Card className="stack"><b>{t('trial.usage')}</b><div className="status-strip">{Object.entries(me.trial.remaining).map(([k, v]) => <span key={k} className="chip">{FEATURE_LABEL[k] ?? k}: {v}/{me.trial!.limits[k]}</span>)}</div></Card>)}
      <div className="row between wrap gap"><Segmented label="Type" value={tab} onChange={setTab} options={[{ value: 'subscription', label: 'Plans' }, { value: 'credit_pack', label: t('pay.buyCredits') }]} />
        {tab === 'subscription' && <Segmented label="Period" value={period} onChange={setPeriod} options={[{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }]} />}</div>
      <div className="row gap"><input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder={t('pay.coupon')} aria-label={t('pay.coupon')} style={{ maxWidth: 260 }} /><Btn variant="soft" onClick={applyCoupon}>{t('pay.apply')}</Btn></div>
      {err ? <ErrorState error={err} onRetry={load} /> : !plans ? <Loading /> : shown.length === 0 ? <p className="muted">{t('common.empty')}</p> : (
        <div className="grid g4">{shown.map((p) => { const q = quotes[p.code]; const price = q ? q.total : p.priceMinor; return (
          <Card key={p.code} className={`plan ${p.badge ? 'best' : ''}`}>{p.badge && <span className="badge-top">{p.badge}</span>}
            <h2>{p.name}</h2>
            <div className="price">{fmtMoney(price, p.currency)}{(q && q.discount > 0) || p.compareAtMinor ? <span className="strike">{fmtMoney(q ? p.priceMinor : p.compareAtMinor!, p.currency)}</span> : null}<small className="muted" style={{ fontSize: '.8rem', fontWeight: 400 }}> {p.interval === 'month' ? t('pay.month') : p.interval === 'year' ? t('pay.year') : ''}</small></div>
            <p className="muted" style={{ fontSize: '.88rem' }}>{p.description}</p>
            <ul>{p.credits > 0 && <li>{p.credits} {t('common.credits')}</li>}{p.features.map((f) => <li key={f}>{FEATURE_LABEL[f] ?? f}</li>)}</ul>
            <Btn loading={busy === p.code} onClick={() => buy(p)}>{t('pay.pay')}</Btn>
          </Card>); })}</div>)}
      <p className="muted" style={{ fontSize: '.8rem', textAlign: 'center' }}>🔒 Google Pay · UPI · Cards · Netbanking. Your plan unlocks automatically after the payment is verified on our servers.</p>
      {ledger && ledger.length > 0 && (<section className="stack"><h2>Credit history</h2><div className="card tbl-wrap"><table className="tbl"><tbody>{ledger.slice(0, 12).map((l) => <tr key={l.id}><td>{new Date(l.created_at).toLocaleDateString()}</td><td>{l.reason.replace(/^spend:|^purchase:/, '')}</td><td style={{ textAlign: 'right', color: l.delta > 0 ? 'var(--ok)' : undefined }}>{l.delta > 0 ? '+' : ''}{l.delta}</td></tr>)}</tbody></table></div></section>)}
    </div>
  );
}
