-- MADIX core schema. All money in minor units (paise). All credit changes go through credit_ledger.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── Identity ─────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  phone text UNIQUE,
  username citext NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_.]{3,30}$'),
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','blocked')),
  suspended_until timestamptz,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  locale text NOT NULL DEFAULT 'en',
  totp_secret text,               -- AES-GCM encrypted
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  signup_ip_hash text,
  device_hash text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_created_idx ON users (created_at);
CREATE INDEX users_device_idx ON users (device_hash) WHERE device_hash IS NOT NULL;
CREATE INDEX users_ip_idx ON users (signup_ip_hash) WHERE signup_ip_hash IS NOT NULL;
-- Exactly one primary admin may exist.
CREATE UNIQUE INDEX one_primary_admin ON users ((role)) WHERE role = 'admin';

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  avatar_file_id uuid,
  interests text[] NOT NULL DEFAULT '{}',
  followers_count int NOT NULL DEFAULT 0,
  following_count int NOT NULL DEFAULT 0,
  posts_count int NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash text NOT NULL UNIQUE,
  user_agent text,
  ip_hash text,
  admin_session boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify_email','reset_password','verify_phone')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Files (binary data lives in object storage) ─────────────
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('avatar','post','reel','ai_image','ai_video','document','chat','branding','promo','edit_source','edit_output')),
  storage_key text NOT NULL UNIQUE,
  thumb_key text,
  mime text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  width int, height int, duration_ms int,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','deleted')),
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_owner_idx ON files (owner_id, created_at DESC);
ALTER TABLE profiles ADD FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;

-- ───────────── Social ─────────────
CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text','image','video','reel')),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2200),
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  audio_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  captions text,
  hashtags text[] NOT NULL DEFAULT '{}',
  ai_generated boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  likes_count int NOT NULL DEFAULT 0,
  comments_count int NOT NULL DEFAULT 0,
  shares_count int NOT NULL DEFAULT 0,
  saves_count int NOT NULL DEFAULT 0,
  views_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC) WHERE status='published';
CREATE INDEX posts_kind_idx ON posts (kind, created_at DESC) WHERE status='published';
CREATE INDEX posts_hashtags_idx ON posts USING gin (hashtags);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);

CREATE TABLE likes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX likes_post_idx ON likes (post_id);
CREATE TABLE saves (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE shares (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);
-- Watch time signal for recommendations.
CREATE TABLE post_views (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  watch_ms int NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
-- Per-user interest weights learned from behaviour (hashtag -> score).
CREATE TABLE user_interests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag text NOT NULL,
  score real NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tag)
);
CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ───────────── Chat ─────────────
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  title text,
  direct_key text UNIQUE,         -- sorted "uidA:uidB" to dedupe direct chats
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX cm_user_idx ON conversation_members (user_id);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  reply_to uuid REFERENCES messages(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at DESC);
CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) <= 16),
  PRIMARY KEY (message_id, user_id)
);

-- ───────────── AI ─────────────
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX aic_user_idx ON ai_conversations (user_id, updated_at DESC);
CREATE INDEX aic_title_idx ON ai_conversations USING gin (to_tsvector('simple', title));
CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  provider text, model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX aim_conv_idx ON ai_messages (conversation_id, created_at);
CREATE INDEX aim_search_idx ON ai_messages USING gin (to_tsvector('simple', content));

-- Provider registry. Secrets are NEVER stored here: api_key_env names an environment variable.
CREATE TABLE ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability text NOT NULL CHECK (capability IN ('text','image','image_edit','video','voice','embedding')),
  name text NOT NULL,
  adapter text NOT NULL,           -- openai-compatible | anthropic | http-async-video
  model text NOT NULL,
  base_url text,
  api_key_env text,
  config jsonb NOT NULL DEFAULT '{}',
  priority int NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability, name)
);

-- Durable queue (Postgres SKIP LOCKED): no job is lost on restart, retries with backoff.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  progress int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  external_id text,
  result jsonb,
  error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_pick_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_user_idx ON jobs (user_id, created_at DESC);

CREATE TABLE generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('image','video','promo','photo_edit','video_edit')),
  prompt text NOT NULL DEFAULT '',
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  credits_charged int NOT NULL DEFAULT 0,
  result_file_ids uuid[] NOT NULL DEFAULT '{}',
  result_meta jsonb,
  error text,
  trial_counted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX gen_user_idx ON generations (user_id, created_at DESC);
CREATE INDEX gen_kind_idx ON generations (kind, created_at);

-- ───────────── Billing ─────────────
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('subscription','credit_pack','promo')),
  interval text CHECK (interval IN ('month','year')),
  price_minor int NOT NULL CHECK (price_minor >= 0),
  compare_at_minor int,
  currency text NOT NULL DEFAULT 'INR',
  credits int NOT NULL DEFAULT 0,            -- credits granted per purchase / per period
  features text[] NOT NULL DEFAULT '{}',     -- unlocked feature keys
  description text NOT NULL DEFAULT '',
  badge text,
  sort int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'subscription') = (interval IS NOT NULL))
);
CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code citext NOT NULL UNIQUE,
  percent_off int CHECK (percent_off BETWEEN 1 AND 100),
  amount_off_minor int CHECK (amount_off_minor > 0),
  max_redemptions int,
  redeemed int NOT NULL DEFAULT 0,
  plan_codes text[],
  starts_at timestamptz, ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent_off IS NOT NULL) <> (amount_off_minor IS NOT NULL))
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  coupon_id uuid REFERENCES coupons(id),
  provider text NOT NULL,
  provider_order_id text NOT NULL UNIQUE,
  provider_payment_id text UNIQUE,
  amount_minor int NOT NULL,          -- price computed on the server at order time
  currency text NOT NULL,
  method text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
  fulfilled_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
CREATE TABLE webhook_events (
  id text PRIMARY KEY,                -- provider event id: idempotency
  provider text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  payment_id uuid REFERENCES payments(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subs_user_idx ON subscriptions (user_id, current_period_end DESC);
CREATE TABLE trials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  credits_granted int NOT NULL,
  limits jsonb NOT NULL,              -- snapshot of per-feature caps at activation
  expiry_notified boolean NOT NULL DEFAULT false,
  ending_notified boolean NOT NULL DEFAULT false
);
-- Credits: balance row + immutable ledger; mutations only via SQL in one transaction.
CREATE TABLE credit_wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance int NOT NULL DEFAULT 0 CHECK (balance >= 0)
);
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta int NOT NULL,
  balance_after int NOT NULL,
  reason text NOT NULL,
  ref_type text, ref_id text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON credit_ledger (user_id, id DESC);
CREATE TABLE feature_unlocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  source text NOT NULL,               -- referral | admin | purchase
  source_ref text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, feature_key, source, source_ref)
);

-- ───────────── Referrals ─────────────
CREATE TABLE referral_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE
);
CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','qualified','rejected')),
  abuse_flags text[] NOT NULL DEFAULT '{}',
  qualified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referred_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_id, status);
CREATE TABLE referral_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  required_count int NOT NULL CHECK (required_count > 0),
  reward_type text NOT NULL CHECK (reward_type IN ('feature','credits')),
  feature_key text,
  credits int,
  unlock_days int,                    -- null = permanent
  max_awards_per_user int NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  label text NOT NULL DEFAULT '',
  CHECK ((reward_type = 'feature' AND feature_key IS NOT NULL) OR (reward_type = 'credits' AND credits > 0))
);
CREATE TABLE referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES referral_rules(id),
  award_no int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'granted' CHECK (status IN ('granted','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, rule_id, award_no)
);

-- ───────────── Notifications, moderation, config, audit ─────────────
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_user_idx ON notifications (user_id, created_at DESC);
CREATE TABLE push_tokens (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('web','android','ios')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','user','message')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  details text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  handled_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
CREATE TABLE moderation_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL, target_id text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Admin-controlled config with draft → publish workflow (branding, home, pricing knobs, trial, costs, theme…)
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  draft jsonb,
  published jsonb,
  version int NOT NULL DEFAULT 0,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('banner','offer','announcement')),
  asset_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  cta_label text, cta_url text,
  coupon_id uuid REFERENCES coupons(id) ON DELETE SET NULL,
  discount_percent int,
  starts_at timestamptz, ends_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  push_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}',
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);
-- Privacy-conscious analytics: no IPs, no content; user id only for DAU/retention.
CREATE TABLE analytics_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  props jsonb NOT NULL DEFAULT '{}',
  day date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_day_idx ON analytics_events (day, name);
CREATE INDEX analytics_user_day_idx ON analytics_events (user_id, day);
