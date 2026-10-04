import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx, one } from '../db/pool.js';
import { hashPassword, verifyPassword, randomToken, sha256, hashIp, verifyTotp, decrypt } from '../lib/crypto.js';
import { AppError, badRequest, unauthorized, conflict, forbidden } from '../lib/errors.js';
import { sendMail } from '../lib/mail.js';
import { activateTrial } from './credits.js';
import { onUserVerified, registerReferral } from './referrals.js';
import { notify } from './notify.js';
import { track } from '../lib/audit.js';

const key = new TextEncoder().encode(config.JWT_SECRET);

export const passwordSchema = z.string().min(10, 'Password must be at least 10 characters.').max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Use upper and lower case letters and a number.');

export const registerSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase()),
  username: z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/, 'Username: 3–30 letters, numbers, _ or .'),
  password: passwordSchema,
  phone: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  referralCode: z.string().max(32).optional(),
  deviceId: z.string().max(100).optional(),
  locale: z.enum(['en', 'ta', 'hi']).default('en'),
});

export async function signAccess(user: { id: string; role: string }, sid: string, admin = false) {
  const ttl = admin ? config.ADMIN_SESSION_TTL_MIN : config.ACCESS_TOKEN_TTL_MIN;
  return new SignJWT({ role: user.role, sid, adm: admin }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id)
    .setIssuedAt().setExpirationTime(`${ttl}m`).setIssuer('madix').sign(key);
}
export async function verifyAccess(token: string) {
  const { payload } = await jwtVerify(token, key, { issuer: 'madix' });
  return { id: payload.sub as string, sid: payload.sid as string, adm: payload.adm === true };
}

async function createSession(userId: string, ua: string | undefined, ip: string, admin: boolean) {
  const refresh = randomToken(48);
  const days = admin ? 1 : config.REFRESH_TOKEN_TTL_DAYS;
  const s = await one(pool, `INSERT INTO sessions(user_id, refresh_hash, user_agent, ip_hash, admin_session, expires_at)
    VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id`, [userId, sha256(refresh), ua?.slice(0, 200) ?? null, hashIp(ip), admin, days]);
  return { sid: s.id as string, refresh };
}

async function issue(user: any, ua: string | undefined, ip: string, admin = false) {
  const { sid, refresh } = await createSession(user.id, ua, ip, admin);
  return { accessToken: await signAccess(user, sid, admin), refreshToken: refresh, user: publicUser(user) };
}

export const publicUser = (u: any) => ({
  id: u.id, email: u.email, username: u.username, role: u.role, status: u.status, locale: u.locale,
  emailVerified: !!u.email_verified_at, phoneVerified: !!u.phone_verified_at, phone: u.phone ?? null,
});

async function mintToken(userId: string, kind: 'verify_email' | 'reset_password', ttlMin: number) {
  const token = randomToken(32);
  await pool.query(`UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND kind=$2 AND used_at IS NULL`, [userId, kind]);
  await pool.query(`INSERT INTO auth_tokens(user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`, [userId, kind, sha256(token), ttlMin]);
  return token;
}

export async function register(input: z.infer<typeof registerSchema>, ctx: { ip: string; ua?: string }) {
  const { email, username, password } = input;
  const exists = await one(pool, 'SELECT email, username FROM users WHERE email=$1 OR username=$2 OR ($3::text IS NOT NULL AND phone=$3)', [email, username, input.phone ?? null]);
  if (exists) throw conflict('An account with these details already exists.', 'account_exists');
  const hash = await hashPassword(password);
  const device = input.deviceId ? sha256(`dev:${input.deviceId}`) : null;
  const user = await tx(async (c) => {
    const u = await one(c, `INSERT INTO users(email, username, password_hash, phone, locale, signup_ip_hash, device_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [email, username, hash, input.phone ?? null, input.locale, hashIp(ctx.ip), device]);
    await c.query('INSERT INTO profiles(user_id, display_name) VALUES ($1,$2)', [u.id, username]);
    await c.query('INSERT INTO credit_wallets(user_id) VALUES ($1)', [u.id]);
    if (input.referralCode) await registerReferral(c, u, input.referralCode);
    return u;
  }).catch((e) => { if (e.code === '23505') throw conflict('An account with these details already exists.', 'account_exists'); throw e; });
  const token = await mintToken(user.id, 'verify_email', 60 * 24);
  await sendMail(email, 'Verify your MADIX account', `Welcome to MADIX, from SAYRIX MATHAV.\n\nVerify your email to start your free trial:\n${config.PUBLIC_WEB_URL}/verify-email?token=${token}\n\nThis link expires in 24 hours.`);
  void track(user.id, 'register');
  return { user: publicUser(user), verificationRequired: true };
}

export async function verifyEmail(token: string) {
  const row = await one(pool, `SELECT id, user_id FROM auth_tokens WHERE token_hash=$1 AND kind='verify_email' AND used_at IS NULL AND expires_at > now()`, [sha256(token)]);
  if (!row) throw badRequest('This verification link is invalid or has expired.', 'invalid_token');
  const result = await tx(async (c) => {
    await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [row.id]);
    const u = await one(c, `UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1 RETURNING *`, [row.user_id]);
    const trial = await activateTrial(c, u.id);
    await onUserVerified(c, u.id);
    return { u, trial };
  });
  if (result.trial) await notify(result.u.id, 'subscription_activated', 'Your free trial has started', 'Enjoy your MADIX free trial — create, edit and share with AI.');
  void track(result.u.id, 'email_verified');
  return { verified: true, trialStarted: result.trial };
}

export async function resendVerification(email: string) {
  const u = await one(pool, 'SELECT id, email_verified_at FROM users WHERE email=$1', [email.toLowerCase()]);
  if (u && !u.email_verified_at) {
    const token = await mintToken(u.id, 'verify_email', 60 * 24);
    await sendMail(email, 'Verify your MADIX account', `Verify your email:\n${config.PUBLIC_WEB_URL}/verify-email?token=${token}`);
  }
}

const MAX_FAILS = 8;
export async function login(identifier: string, password: string, ctx: { ip: string; ua?: string }) {
  const u = await one(pool, 'SELECT * FROM users WHERE email=$1 OR username=$1', [identifier.toLowerCase()]);
  const generic = unauthorized('Incorrect email/username or password.');
  if (!u) { await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86)); throw generic; } // timing equalisation
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError(429, 'locked', 'Too many attempts. Try again in a few minutes.');
  if (!(await verifyPassword(password, u.password_hash))) {
    const n = (await one(pool, `UPDATE users SET failed_logins=failed_logins+1, locked_until = CASE WHEN failed_logins+1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id=$1 RETURNING failed_logins`, [u.id, MAX_FAILS])).failed_logins;
    if (n >= MAX_FAILS) await pool.query('UPDATE users SET failed_logins=0 WHERE id=$1', [u.id]);
    throw generic;
  }
  assertCanSignIn(u);
  if (u.role === 'admin') throw generic; // admins must use the 2FA admin endpoint
  await pool.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_seen_at=now() WHERE id=$1', [u.id]);
  void track(u.id, 'login');
  return issue(u, ctx.ua, ctx.ip);
}

export function assertCanSignIn(u: any) {
  if (u.status === 'blocked') throw forbidden('This account has been blocked. Contact support if you think this is a mistake.');
  if (u.status === 'suspended' && (!u.suspended_until || new Date(u.suspended_until) > new Date())) throw forbidden('This account is temporarily suspended.');
}

export async function adminLogin(email: string, password: string, totp: string, ctx: { ip: string; ua?: string }) {
  const u = await one(pool, `SELECT * FROM users WHERE email=$1 AND role='admin'`, [email.toLowerCase()]);
  const generic = unauthorized('Incorrect credentials.');
  if (!u || !u.totp_enabled || !u.totp_secret) { await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86)); throw generic; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError(429, 'locked', 'Too many attempts. Try again later.');
  const ok = (await verifyPassword(password, u.password_hash)) && verifyTotp(decrypt(u.totp_secret), totp);
  if (!ok) {
    await pool.query(`UPDATE users SET failed_logins=failed_logins+1, locked_until = CASE WHEN failed_logins+1 >= 5 THEN now() + interval '30 minutes' ELSE locked_until END WHERE id=$1`, [u.id]);
    await pool.query(`INSERT INTO audit_logs(actor_id, action, ip_hash) VALUES ($1,'admin.login_failed',$2)`, [u.id, hashIp(ctx.ip)]);
    throw generic;
  }
  await pool.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  await pool.query(`INSERT INTO audit_logs(actor_id, action, ip_hash) VALUES ($1,'admin.login',$2)`, [u.id, hashIp(ctx.ip)]);
  return issue(u, ctx.ua, ctx.ip, true);
}

export async function refresh(refreshToken: string, ctx: { ip: string; ua?: string }) {
  const s = await one(pool, `SELECT s.*, row_to_json(u.*) AS u FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_hash=$1`, [sha256(refreshToken)]);
  if (!s) throw unauthorized('Session expired. Please sign in again.');
  if (s.revoked_at || new Date(s.expires_at) < new Date()) {
    // Reuse of a rotated/revoked refresh token → kill the whole family for this user's sessions (theft signal)
    if (s.revoked_at) await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [s.user_id]);
    throw unauthorized('Session expired. Please sign in again.');
  }
  assertCanSignIn(s.u);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [s.id]); // rotate
  return issue(s.u, ctx.ua, ctx.ip, s.admin_session);
}

export async function logout(refreshToken: string | undefined, sid?: string) {
  if (refreshToken) await pool.query('UPDATE sessions SET revoked_at=now() WHERE refresh_hash=$1', [sha256(refreshToken)]);
  if (sid) await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [sid]);
}

export async function forgotPassword(email: string) {
  const u = await one(pool, `SELECT id FROM users WHERE email=$1 AND role <> 'admin'`, [email.toLowerCase()]);
  if (u) {
    const token = await mintToken(u.id, 'reset_password', 30);
    await sendMail(email, 'Reset your MADIX password', `Reset your password (valid 30 minutes):\n${config.PUBLIC_WEB_URL}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`);
  }
  // Always succeed: never reveal whether an account exists.
}

export async function resetPassword(token: string, newPassword: string) {
  const row = await one(pool, `SELECT id, user_id FROM auth_tokens WHERE token_hash=$1 AND kind='reset_password' AND used_at IS NULL AND expires_at > now()`, [sha256(token)]);
  if (!row) throw badRequest('This reset link is invalid or has expired.', 'invalid_token');
  const hash = await hashPassword(newPassword);
  await tx(async (c) => {
    await c.query('UPDATE auth_tokens SET used_at=now() WHERE id=$1', [row.id]);
    await c.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL WHERE id=$1', [row.user_id, hash]);
    await c.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]); // sign out everywhere
  });
}
