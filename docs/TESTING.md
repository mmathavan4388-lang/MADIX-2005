# Testing

```bash
# needs PostgreSQL + ffmpeg locally; the test database is DROPPED and recreated on every run
createdb madix_test        # or set TEST_DATABASE_URL
npm test                   # 93 tests, ~40 s
npm run typecheck -w apps/api && npm run typecheck -w apps/web && npm run build
```

Tests drive the real Fastify app (`app.inject`) against a real Postgres, run the real worker loop, real `ffmpeg`/`sharp`, and the real AI adapters against a local protocol fake. They use a `test` AI adapter only inside the test process.

| Requirement (spec §46) | Test file → what is asserted |
|---|---|
| Registration, verification, login, logout | `auth.test.ts` – weak/duplicate input, generic errors, single-use verify link, refresh rotation + reuse revokes, lockout, blocked/suspended users |
| Password reset | `auth.test.ts` – no account enumeration, single-use link, sessions revoked, new password works |
| Trial activation / expiry | `auth.test.ts`, `misc.test.ts` – 3-day trial + 60 credits only after verification; expiry is automatic; ending/expired notifications once |
| AI chat | `ai.test.ts` – SSE streaming, history, rename/search/delete, regenerate, isolation between users, refund on provider failure, document analysis |
| Image / video / promo / photo & video editing | `ai.test.ts` – async 202 → worker → stored files; video submit→poll→complete with progress; cancel (queued) refund; provider failure refund; promo copy+poster; AI photo ops; **real ffmpeg render** (trim, speed, text, captions, filter, transition, music, auto-enhance) verified by probing output size/duration |
| Credit deduction, insufficient credits | `ai.test.ts` – exact costs, admin-changed costs apply instantly, concurrent requests cannot overspend (5 racers, balance 10, cost 5 → exactly 2 succeed), trial caps, `402 insufficient_credits/feature_locked` with upgrade/buy action |
| Payment, GPay/UPI flow, server verification, auto-activation, auto-unlock | `billing.test.ts` – server-computed price (client amount ignored), coupon rules, HMAC + gateway confirmation, forged signature, “success screen but unpaid”, amount mismatch, other user's order, webhook signature/idempotency/browser-closed case, failed payment, renewal, 100 % coupon, features unlock immediately, notifications + email |
| Referral registration / reward / abuse | `referral.test.ts` – pending until verified; 1/3/5/10 reward ladder; same-device, duplicate-device, IP-farming rejection; admin rule editing, flags visible, program kill-switch |
| Admin login / authorization | `auth.test.ts` – password **and** TOTP required, regular login refuses admin, single-admin DB constraint, every admin route 401/403 for others |
| Admin price / logo / Home content / promotions | `admin.test.ts` – ₹599→₹499 reflected in `/plans` and the Razorpay order amount; logo upload→preview→publish→delete; Home draft invisible until publish; quick action hiding; theme contrast rejection; trial/cost settings; promotion windows; announcements |
| User blocking, reporting, moderation | `admin.test.ts`, `social.test.ts` – block/unblock/suspend revoke sessions, owner cannot be blocked, report dedupe, remove content, moderation logs |
| Notifications | `social.test.ts`, `misc.test.ts` – like/comment/follow/AI/payment/referral/trial events, read state, chat unread |
| File upload, cloud storage | `social.test.ts` – signed upload, magic-byte sniffing (disguised PHP rejected), size/type limits, SVG script rejection, unverified users blocked, expired links, thumbnails, 720p rendition + range requests |
| Provider abstraction | `adapters.test.ts` – OpenAI-compatible + Anthropic streaming, key read from env at call time, image generation, async video polling config, **failover** to the next provider |
| Security hygiene | `misc.test.ts` – rate limiting (429), security headers, oversized body 413, unauthenticated 401s, media path traversal |

## Verified manually in a browser (Playwright/Chromium against the running stack)
Register → email verify → trial → Home → AI chat streaming with Markdown/code block → image generation → pricing → profile → photo editor → desktop layouts → admin login with TOTP → dashboard/charts → admin edits Home title and plan price and the user app reflects them → referral link signup → feed post/reel upload → chat unread badge.

## Not verified / known gaps (please read)
* **Real third-party calls were not made**: no Razorpay test transaction, no real LLM/image/video provider, SMTP, Twilio, FCM or S3 bucket. Those paths are covered by protocol fakes/mocks and need a smoke test with your credentials (Razorpay *test mode* first).
* Docker images and `docker-compose.yml` were written but **not built here** (no Docker daemon in the build sandbox).
* The sandbox Chromium has no H.264 decoder, so reel *playback* could not be watched in-browser; upload, transcoding (ffprobe-validated), signed delivery and range requests are tested.
* Not implemented: web/mobile push token registration UI (server side is ready), voice AI & embeddings (adapters exist, no product feature uses them yet), adaptive-bitrate HLS (a single 720p faststart rendition + thumbnail is produced), automatic recurring billing (subscriptions are prepaid periods; users renew by paying again), automated image/nudity moderation (human moderation workflow only), light theme in the client UI (the setting exists, the client is dark-only), group-chat member management after creation, complete Tamil/Hindi translations (core UI strings are translated; the rest falls back to English).
* “AI enhancement” for video is a deterministic denoise/sharpen/loudness pipeline in ffmpeg, not a generative model; wire a provider in `worker/handlers.ts` if you want one.
