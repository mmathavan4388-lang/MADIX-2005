# Architecture

```
Browser / PWA ──► nginx (static SPA, TLS, CDN origin) ──► API (Fastify, stateless, N replicas) ──► PostgreSQL
                                   │                              │  └─ LISTEN/NOTIFY fan-out (live events to every replica)
                                   │                              ├─ Object storage (S3/R2) ◄── direct signed uploads from clients; CDN for public media
                                   │                              └─ AI gateway ──► provider adapters (OpenAI-compatible · Anthropic · async video …)
                                   └────────────────────────────────  Worker(s) (same image) ◄─ jobs table (SKIP LOCKED) ─ ffmpeg · sharp · providers
```

## Principles
* **Server is the source of truth.** Prices, credits, trial state, entitlements, referral completion and payment success are computed only on the server. The client never sends an amount, balance or "paid" flag.
* **One transaction per money/credit movement.** `credit_wallets` + immutable `credit_ledger` (idempotency keys). Generation requests **hold** credits up-front (row-locked wallet → no double-spend), and the worker **refunds** on failure/cancel — idempotently (`refund:generation:<id>`).
* **Never block a request on AI.** Image/video/promo/edit are `jobs`; the API returns `202` and the UI polls/gets SSE. Video uses submit → poll steps that re-queue themselves, so a worker slot is never held while a provider renders. Stuck jobs are recovered, retries use exponential backoff.
* **Provider abstraction.** `ai_providers` rows (capability, adapter, model, base URL, **env-var name** for the key, priority, enabled) → adapters implement `TextProvider / ImageProvider / ImageEditProvider / VideoProvider / VoiceProvider / EmbeddingProvider`. Failover happens in priority order (before any token has streamed). New vendor = one adapter registered with `registerAdapter()`.
* **Config in the database, not in the build.** `app_settings` (draft → publish, versioned): branding, theme (WCAG contrast enforced), home layout, credit costs, trial, entitlements/kill-switches, referral program, upload limits. Plans, coupons, promotions, referral rules, providers are tables edited from the Admin Panel.

## Entitlements (see `services/credits.ts`)
`access to feature F` = active subscription whose plan lists F **or** an unexpired `feature_unlock` (referral/admin/purchase) **or** an active trial with remaining per-feature quota. Independently the wallet must hold enough credits. Admin kill-switches override everything.

## Referral integrity
Referral rows are created `pending` at signup with abuse screening (same device/IP, duplicate device, per-IP and daily caps, referrer cap). A referral becomes `qualified` only after the referred user verifies their email (and meets the admin-configured account-age rule). Rewards are granted by `referral_rules` in the same transaction, de-duplicated by `UNIQUE(user, rule, award_no)`.

## Feed ranking (`services/social.ts`)
`score = freshness(36h half-life) × (engagement quality + watch quality + follow boost + learned-interest affinity) × fatigue`, with interests learned from likes/saves/shares/comments/watch time. Seen/skipped posts are demoted; blocked users are excluded; slight random jitter provides exploration.

## Security summary
scrypt password hashing · short-lived JWT access + rotating refresh tokens with reuse detection and server-side session revocation · account lockout · admin: separate 2FA login, `adm` token claim, 1-hour sessions, audit log, single-admin DB constraint · rate limits (global + per-route) · zod validation everywhere · upload type allow-list + magic-byte sniffing + size limits + SVG script rejection · webhook HMAC verification + event idempotency · secrets only in environment, TOTP secrets AES-GCM encrypted at rest · generic error responses (no stack/DB details).
