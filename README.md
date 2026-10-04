# MADIX — from SAYRIX MATHAV

**Create. Chat. Edit. Share. — All in MADIX.**
An all-in-one AI + social + creative platform: AI assistant, AI image & video, photo & video editors, AI promo creator, social feed, reels and chat — with a real credit system, Razorpay (Google Pay / UPI / cards) payments, referral rewards and an owner-only Admin Panel that controls content, branding, prices and AI providers without redeploying.

```
apps/
  api/   Node 22 · TypeScript · Fastify · PostgreSQL   — REST API, auth, billing, AI gateway, job queue worker
  web/   React 18 · Vite · TypeScript                  — responsive PWA-ready client + Admin Panel (/admin)
deploy/  Dockerfiles, nginx config
docs/    ARCHITECTURE · DEPLOYMENT · ADMIN_GUIDE · TESTING
```

## Quick start (development)

```bash
cp .env.example .env              # fill JWT_SECRET / DATA_ENCRYPTION_KEY at minimum (openssl rand -base64 48)
npm install
# PostgreSQL 16 running locally, then:
export $(grep -v '^#' .env | xargs)
npm run migrate && npm run seed   # seed prints the Master Admin 2FA secret ONCE if ADMIN_BOOTSTRAP_* is set
npm run dev:api & npm run dev:worker & npm run dev:web
# app: http://localhost:5173      admin: http://localhost:5173/admin
```

No paid AI keys yet? `node apps/api/scripts/dev-ai-mock.mjs` starts a local OpenAI-compatible stand-in (development only). Real providers are added in **Admin → AI & System** (or `SEED_AI_PROVIDERS`); keys stay in server environment variables.

## What is real vs. what you must configure

| Area | State |
|---|---|
| Auth (register, login, refresh rotation + reuse detection, reset, email verification, phone OTP) | Implemented and tested. Needs `SMTP_URL` (and Twilio vars for SMS) in production. |
| 3-day trial, credits, per-feature caps, ledger | Implemented and tested; all numbers editable in Admin. |
| Payments | Razorpay server-side order creation, signature **and** gateway verification, signed webhooks, idempotent fulfilment. Tested against a protocol fake; **needs your Razorpay keys + webhook URL** to take real money. |
| AI chat / image / video / edit / promo | Provider abstraction + async job worker implemented; adapters for OpenAI-compatible APIs, Anthropic, and generic async video APIs. **No AI works until you register real providers + keys.** |
| Storage | S3-compatible (S3 / R2 / MinIO) with signed uploads, content sniffing, thumbnails, 720p renditions. `local` driver is dev-only. |
| Admin Panel | Owner-only, password + TOTP 2FA, audit-logged; content/branding/theme/pricing/costs/trial/referral/promotions/moderation/users/providers. |
| Push notifications | Server sender (FCM) and token registration endpoint exist; **web/mobile client token registration is not wired** (needs your Firebase project). In-app + live (SSE) notifications work. |

See `docs/TESTING.md` for the exact test matrix and the known gaps.
