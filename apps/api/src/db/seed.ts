import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { pool, one } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword, newTotpSecret, encrypt, totpUri } from '../lib/crypto.js';
import { passwordSchema } from '../services/auth.js';

/**
 * Idempotent production-safe seed:
 *  - the single Master Admin (from ADMIN_BOOTSTRAP_* env; a TOTP secret is generated and printed ONCE)
 *  - starter plans / referral rules (all editable in the Admin panel afterwards; never overwritten once present)
 *  - optional AI providers from SEED_AI_PROVIDERS (JSON). Secrets are referenced by env-var NAME only.
 */
export async function seed(log = console.log) {
  await migrate(log);

  if (config.ADMIN_BOOTSTRAP_EMAIL && config.ADMIN_BOOTSTRAP_PASSWORD) {
    const existing = await one(pool, `SELECT id FROM users WHERE role='admin'`);
    if (!existing) {
      passwordSchema.parse(config.ADMIN_BOOTSTRAP_PASSWORD);
      if (config.ADMIN_BOOTSTRAP_PASSWORD.length < 14) throw new Error('Admin password must be at least 14 characters.');
      const secret = newTotpSecret();
      const u = await one(pool, `INSERT INTO users(email, username, password_hash, role, email_verified_at, totp_secret, totp_enabled) VALUES ($1,'sayrix_admin',$2,'admin',now(),$3,true) RETURNING id`,
        [config.ADMIN_BOOTSTRAP_EMAIL.toLowerCase(), await hashPassword(config.ADMIN_BOOTSTRAP_PASSWORD), encrypt(secret)]);
      await pool.query('INSERT INTO profiles(user_id, display_name) VALUES ($1,$2)', [u.id, 'MADIX Admin']);
      await pool.query('INSERT INTO credit_wallets(user_id) VALUES ($1)', [u.id]);
      log('\n================ MASTER ADMIN CREATED ================');
      log(`Email: ${config.ADMIN_BOOTSTRAP_EMAIL}`);
      log('Add this to your authenticator app NOW (shown only once):');
      log(`TOTP secret: ${secret}`);
      log(`URI: ${totpUri(secret, config.ADMIN_BOOTSTRAP_EMAIL)}`);
      log('Then remove ADMIN_BOOTSTRAP_PASSWORD from the environment.');
      log('======================================================\n');
    } else log('master admin already exists — skipping');
  }

  if (!(await one(pool, 'SELECT 1 FROM plans LIMIT 1'))) {
    const plans: any[] = [
      ['basic_monthly', 'MADIX Basic', 'subscription', 'month', 29900, null, 300, ['chat', 'image'], 'AI chat and image creation', null, 10],
      ['pro_monthly', 'MADIX Pro', 'subscription', 'month', 59900, null, 1000, ['chat', 'image', 'video', 'edit'], 'Everything in Basic plus video and AI editing', 'Popular', 20],
      ['premium_monthly', 'MADIX Premium', 'subscription', 'month', 99900, null, 2500, ['chat', 'image', 'video', 'promo', 'edit'], 'All AI tools with the most credits', null, 30],
      ['pro_yearly', 'MADIX Pro (Yearly)', 'subscription', 'year', 599000, 718800, 12000, ['chat', 'image', 'video', 'edit'], 'Two months free', 'Best value', 40],
      ['credits_200', '200 Credits', 'credit_pack', null, 19900, null, 200, [], 'Top up your balance', null, 100],
      ['credits_600', '600 Credits', 'credit_pack', null, 49900, null, 600, [], 'Top up your balance', 'Save 17%', 110],
    ];
    for (const p of plans) await pool.query(`INSERT INTO plans(code,name,kind,interval,price_minor,compare_at_minor,credits,features,description,badge,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, p.slice(0, 1).concat(p.slice(1)));
    log('seeded starter plans');
  }
  if (!(await one(pool, 'SELECT 1 FROM referral_rules LIMIT 1'))) {
    await pool.query(`INSERT INTO referral_rules(required_count, reward_type, feature_key, credits, unlock_days, label) VALUES
      (1,'feature','image',NULL,7,'1 friend: 7 days of AI Image'),
      (3,'feature','video',NULL,7,'3 friends: 7 days of AI Video'),
      (5,'feature','promo',NULL,7,'5 friends: 7 days of Promo Creator'),
      (10,'credits',NULL,200,NULL,'10 friends: 200 bonus credits')`);
    log('seeded referral rules');
  }
  if (process.env.SEED_AI_PROVIDERS) {
    const list = JSON.parse(process.env.SEED_AI_PROVIDERS) as any[];
    for (const p of list) {
      await pool.query(`INSERT INTO ai_providers(capability,name,adapter,model,base_url,api_key_env,config,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (capability,name) DO NOTHING`,
        [p.capability, p.name, p.adapter, p.model, p.baseUrl ?? null, p.apiKeyEnv ?? null, p.config ?? {}, p.priority ?? 100]);
    }
    log(`ensured ${list.length} AI provider(s)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
