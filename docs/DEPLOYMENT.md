# Deployment

## 1. Infrastructure checklist
| Need | Recommendation |
|---|---|
| Domain + HTTPS | `app.yourdomain` (web+API behind one origin) and `cdn.yourdomain` (media). TLS at the load balancer/Cloudflare; set `TRUST_PROXY=true`. nginx config in `deploy/nginx.conf` already sets HSTS/CSP. |
| PostgreSQL 16 | Managed (RDS / Cloud SQL / Neon / Supabase). Enable PITR backups. `DATABASE_URL=postgres://…?sslmode=require`. |
| Object storage | S3 or Cloudflare R2 bucket (private). Set `S3_*`. CORS: allow `PUT, GET, HEAD` from `PUBLIC_WEB_URL` with header `Content-Type`. |
| CDN | Put a CDN (CloudFront/Cloudflare) in front of the bucket → `CDN_BASE_URL`. Public media (posts, reels, avatars, branding, promo assets) are served from the CDN; private media (chat, AI outputs, documents) use short-lived signed URLs. |
| Email | Any SMTP provider (SES, Postmark, Resend SMTP) → `SMTP_URL`. Required in production. |
| SMS (optional) | Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. |
| Payments | Razorpay account → `RAZORPAY_KEY_ID/SECRET`; Dashboard → Webhooks → `https://app.yourdomain/api/v1/billing/webhook/razorpay`, events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`; copy the secret to `RAZORPAY_WEBHOOK_SECRET`. Enable Google Pay / UPI / cards in the dashboard. |
| AI providers | Put keys in env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) then add providers in Admin → AI & System, or `SEED_AI_PROVIDERS`. Run **at least one** each of text, image, (image_edit, video for those tools). |
| Push (optional) | `FCM_SERVER_KEY`; clients register tokens via `POST /api/v1/me/push-token`. |

## 2. Release steps
```bash
# build images (CI does this)
docker build -f deploy/Dockerfile.api -t madix-api .
docker build -f deploy/Dockerfile.web -t madix-web .

# once per release, before starting new API/worker pods:
docker run --env-file .env madix-api node dist/db/migrate.js      # forward-only, advisory-locked, idempotent
# first deployment only (creates Master Admin + starter plans/referral rules; prints the 2FA secret ONCE):
docker run --env-file .env -e ADMIN_BOOTSTRAP_EMAIL=you@example.com -e ADMIN_BOOTSTRAP_PASSWORD='…14+ chars…' madix-api node dist/db/seed.js
```
Then run N× `node dist/server.js` (API) and M× `node dist/worker.js` (workers). They share nothing but Postgres and storage, so scale each independently; add workers when `Queue lag` in the admin System status rises. `docker-compose.yml` shows a single-host layout (Postgres, MinIO, migrate job, API, worker, nginx).

Remove `ADMIN_BOOTSTRAP_PASSWORD` from the environment after the first seed.

## 3. Environments
* **Development**: `NODE_ENV=development` (auto-migrate on API start, mail/SMS printed to console, local storage allowed).
* **Production**: `NODE_ENV=production` refuses to start with placeholder secrets, non-HTTPS `PUBLIC_WEB_URL`, or missing SMTP/S3 bucket. Migrations are never run implicitly.
* **Test**: `npm test` (needs Postgres; `TEST_DATABASE_URL`, default `postgres://madix:madix@localhost:5432/madix_test`, **database is wiped**).

## 4. Logging, monitoring, backups
* Structured JSON logs (pino, auth headers redacted) → ship stdout to your log stack. `/healthz` (liveness), `/readyz` (DB readiness).
* Admin → Dashboard shows queue depth/lag, failed jobs (24h), provider/payment/storage/email status. Add uptime checks on `/readyz` and alerts on 5xx rate; Sentry/OTel can be added in `app.ts` error handler.
* Back up Postgres (PITR) and enable bucket versioning. Files rows reference object keys; never delete bucket objects manually.

## 5. Capacity notes
Postgres is the queue and the event bus (LISTEN/NOTIFY) — comfortable into the hundreds of thousands of users. Beyond that, swap `services/jobs.ts` for SQS/Redis streams and move feed ranking to a precomputed candidate store; interfaces are isolated for this.
