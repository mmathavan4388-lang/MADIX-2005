# Owner / Admin guide

**Sign in:** `https://your-domain/admin` — email, password and the 6-digit code from your authenticator app. There is exactly one admin account (enforced by a database constraint) and it cannot be created from the public app. Sessions last 1 hour; every admin action is recorded in **Audit log**.

| Section | What you can do (no rebuild, no code) |
|---|---|
| Dashboard | Users (total / DAU / MAU / new / trial / paid), revenue, payments (+failed), AI generations (image/video), credit usage, storage, retention (D1/D7), trial→paid conversion, referral conversion, popular tools, system status (DB, storage, payments, email, AI providers, queue lag). |
| Content & Branding | Upload/replace/delete **logo** (app, splash, login, favicon), app name, “from SAYRIX MATHAV” text, tagline; edit Home title/subtitle/placeholder/announcement/quick actions/sections/featured tools; theme colours (rejected if contrast is not accessible). Edits are drafts until **Save & Publish**. |
| Pricing & Plans | Create/edit/disable Monthly, Yearly, Credit-pack and Promotional plans (price, strike-through price, credits, unlocked features, badge, schedule); coupons (% or fixed, limits); **credit cost per action**; **trial** (days, free credits, per-feature caps, reminder time); per-feature **kill switches**. Plan edits are live immediately; settings go live on Publish. Example: edit Pro from ₹599 → ₹499 → the pricing page and checkout use ₹499 on the next request. |
| Referrals | Program on/off, caps, expiry, device/IP limits; reward rules (N verified referrals → unlock feature for X days, or credits); list of referrals with referrer, referred user, status and **abuse flags**; reject a referral; granted rewards. |
| Promotions | Upload banner/image/video, create offers & coupons, set start/end, enable/disable, send **push + in-app announcements**. |
| Moderation | Reported posts/reels/comments/messages/users → dismiss, remove content, suspend, block (sessions revoked); moderation log. |
| Users | Search, suspend/block/unblock, adjust credits (audited). |
| AI & System | Add/disable/re-prioritise AI providers (key is the **name** of a server env var), payments list, upload limits. |

**First-time setup order:** deploy → seed admin (save the 2FA secret) → AI & System: add providers → Pricing: review plans/costs/trial → Content: upload logo and publish → configure Razorpay webhook → create a test payment with Razorpay test keys.
