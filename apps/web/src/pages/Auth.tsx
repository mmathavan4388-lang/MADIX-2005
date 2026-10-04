import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, setTokens, ApiError } from '../lib/api';
import { useApp, errMessage } from '../lib/store';
import { Btn, Field, Logo } from '../components/ui';
import { useI18n, LANGUAGES } from '../i18n';

function AuthFrame({ children, title }: { children: ReactNode; title: string }) {
  const { config } = useApp(); const { lang, setLang } = useI18n();
  return (
    <div className="auth">
      <div className="auth-card glass">
        <Logo kind="login" size={44} stacked />
        <p className="muted" style={{ textAlign: 'center', marginTop: -6 }}>{config.branding.tagline}</p>
        <h1 style={{ fontSize: '1.4rem' }}>{title}</h1>
        {children}
        <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: 'auto', justifySelf: 'center', minHeight: 36, padding: '6px 12px' }}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
      </div>
    </div>
  );
}
const deviceId = () => { try { let d = localStorage.getItem('madix_device'); if (!d) { d = crypto.randomUUID(); localStorage.setItem('madix_device', d); } return d; } catch { return undefined; } };

export function Login() {
  const { t } = useI18n(); const { me, refreshMe } = useApp(); const nav = useNavigate();
  const [identifier, setI] = useState(''); const [password, setP] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  if (me) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { const r = await api('/auth/login', { body: { identifier, password }, auth: false }); setTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken }); await refreshMe(); nav('/'); }
    catch (x) { setErr(errMessage(x)); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={t('auth.login')}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('auth.identifier')}><input value={identifier} onChange={(e) => setI(e.target.value)} autoComplete="username" required autoFocus /></Field>
        <Field label={t('auth.password')} error={err}><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></Field>
        <Btn type="submit" loading={busy} className="block">{t('auth.login')}</Btn>
        <Link to="/forgot-password" className="muted" style={{ textAlign: 'center' }}>{t('auth.forgot')}</Link>
      </form>
      <p className="muted" style={{ textAlign: 'center' }}>{t('auth.noAccount')} <Link to="/register" className="grad-text"><b>{t('auth.register')}</b></Link> · {t('auth.trialPromo')}</p>
    </AuthFrame>
  );
}

export function Register() {
  const { t } = useI18n(); const { me } = useApp(); const [sp] = useSearchParams(); const { lang } = useI18n();
  const [f, setF] = useState({ email: '', username: '', password: '', referralCode: sp.get('ref') ?? '' }); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState(false);
  if (me) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/auth/register', { body: { ...f, referralCode: f.referralCode || undefined, deviceId: deviceId(), locale: lang }, auth: false }); setDone(true); }
    catch (x) { setErr(x instanceof ApiError && x.code === 'validation' ? x.message : errMessage(x)); } finally { setBusy(false); }
  };
  if (done) return <AuthFrame title={t('auth.verifyTitle')}><p>{t('auth.verifyBody', { email: f.email })}</p><Btn variant="soft" onClick={() => api('/auth/resend-verification', { body: { email: f.email }, auth: false })}>{t('auth.resend')}</Btn><Link className="btn primary" to="/login">{t('auth.login')}</Link></AuthFrame>;
  return (
    <AuthFrame title={t('auth.register')}>
      <form className="stack" onSubmit={submit}>
        <Field label={t('auth.email')}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required /></Field>
        <Field label={t('auth.username')}><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" pattern="[a-zA-Z0-9_.]{3,30}" required /></Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" minLength={10} required /></Field>
        <Field label={t('auth.referral')}><input value={f.referralCode} onChange={(e) => setF({ ...f, referralCode: e.target.value.toUpperCase() })} maxLength={16} /></Field>
        {err && <div className="err" role="alert">{err}</div>}
        <Btn type="submit" loading={busy} className="block">{t('auth.register')}</Btn>
      </form>
      <p className="muted" style={{ textAlign: 'center' }}>{t('auth.haveAccount')} <Link to="/login" className="grad-text"><b>{t('auth.login')}</b></Link></p>
    </AuthFrame>
  );
}

export function Forgot() {
  const { t } = useI18n(); const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title={t('auth.forgot')}>
      {sent ? <p>{t('auth.sent')}</p> : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api('/auth/forgot-password', { body: { email }, auth: false }); } catch { /* generic */ } setSent(true); setBusy(false); }}>
          <Field label={t('auth.email')}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <Btn type="submit" loading={busy}>{t('auth.sendLink')}</Btn>
        </form>
      )}
      <Link to="/login" className="muted" style={{ textAlign: 'center' }}>{t('auth.login')}</Link>
    </AuthFrame>
  );
}

export function ResetPassword() {
  const { t } = useI18n(); const [sp] = useSearchParams(); const nav = useNavigate(); const { toast } = useApp();
  const [password, setP] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title={t('auth.reset')}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { await api('/auth/reset-password', { body: { token: sp.get('token'), password }, auth: false }); toast('✓'); nav('/login'); } catch (x) { setErr(errMessage(x)); } finally { setBusy(false); } }}>
        <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')} error={err}><input type="password" value={password} onChange={(e) => setP(e.target.value)} minLength={10} autoComplete="new-password" required /></Field>
        <Btn type="submit" loading={busy}>{t('auth.reset')}</Btn>
      </form>
    </AuthFrame>
  );
}

export function VerifyEmail() {
  const { t } = useI18n(); const [sp] = useSearchParams(); const [state, setState] = useState<'idle' | 'ok' | 'bad'>('idle'); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { await api('/auth/verify-email', { body: { token: sp.get('token') }, auth: false }); setState('ok'); } catch { setState('bad'); } finally { setBusy(false); } };
  return (
    <AuthFrame title={t('auth.verifyTitle')}>
      {state === 'idle' && <Btn loading={busy} onClick={run}>{t('auth.verifyTitle')}</Btn>}
      {state === 'ok' && <><p className="ok">✓ {t('auth.trialPromo')}</p><Link className="btn primary" to="/login">{t('auth.login')}</Link></>}
      {state === 'bad' && <p className="err" role="alert">{t('common.error')}</p>}
    </AuthFrame>
  );
}
