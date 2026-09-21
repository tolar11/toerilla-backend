# Toe-Rilla Gig Network — Phase 2 Backend

Phase 2 build on top of the Phase 1 prototype: real Postgres database, real
Twilio SMS, real Stripe payments/billing, a minimal admin dashboard, and a
wiring guide for the live landing page. See `PROJECT_BRIEF.md` for the full
spec this was built against, and `PHASE1_VS_PHASE2.md` for exactly what
changed and why.

## What's here

```
server.js                 Express app — all API routes
db/schema.sql              Postgres schema (was SQLite in Phase 1)
db/index.js                Postgres connection pool + schema bootstrap
lib/matching.js             Matching engine + pricing rules (business logic)
lib/claim.js                Race-safe "claim a gig" transaction (shared by HTTP + SMS)
lib/sms.js                  Twilio wrapper (falls back to console logging without creds)
lib/stripe.js               Stripe wrapper (checkout + subscriptions + webhooks)
lib/referrals.js            Founding Member counter + referral credit ledger
public/admin.html           Minimal internal dashboard (token-protected)
test/pricing-and-matching.test.js   Dependency-free tests for the pricing/matching rules
LANDING_PAGE_WIRING.md      Exact HTML/JS changes for toerillagignetwork.com
.env.example                Every environment variable, explained
```

## Local setup

Requires Node 18+ and a Postgres database (local, Docker, or a free Railway/
Render instance — doesn't matter for local dev).

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres connection string
npm start
```

The server creates its schema automatically on startup (safe to re-run).
Health check: `curl http://localhost:3000/api/health`

### Running the tests

```bash
npm test
```

This runs `test/pricing-and-matching.test.js`, which checks the pricing math
and matching filters against the exact rules in `PROJECT_BRIEF.md` (first
gig free, second gig 50% off within 30 days, 15% commission after,
subscription overrides, local/regional/nationwide matching). It stubs the
database layer so it runs without Postgres or any npm packages beyond Node
itself — useful as a fast sanity check before deploying a change to this
logic. It is **not** a substitute for testing the full HTTP API against a
real Postgres instance (do that manually, or add integration tests, before
launch).

> Note on how this was verified while building it: the sandbox this was
> built in blocks outbound access to the npm registry, so `npm install`
> couldn't be run there to do a full end-to-end smoke test. What *was*
> verified there: every file passes `node --check` (valid syntax), the full
> `db/schema.sql` applies cleanly to a real Postgres 16 instance (including
> a from-scratch re-run to confirm idempotency), sample rows insert
> correctly, and all 12 pricing/matching unit tests pass. Run `npm install
> && npm test` yourself once, and do one manual pass through the sign-up →
> post-gig → claim flow against a real Postgres instance, before you rely on
> this in production — normal practice for any handoff, but worth being
> explicit about here since I couldn't do that last mile myself.

## Deploying to Railway (the brief's suggested default)

1. **Push this folder to a GitHub repo** (Railway deploys from Git).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. **Add a Postgres database**: in the same project, "+ New" → "Database" →
   "PostgreSQL". Railway automatically injects `DATABASE_URL` into your app
   service's environment — you don't need to copy/paste it.
4. On your app service, open **Variables** and add everything else from
   `.env.example` that isn't `DATABASE_URL`:
   - `ADMIN_TOKEN` — make up a long random string
   - `APP_BASE_URL` — Railway gives you a domain like
     `https://toerilla-backend-production.up.railway.app`; set this to that
     (Stripe redirect URLs need it)
   - `ALLOWED_ORIGIN` — `https://toerillagignetwork.com` once you're ready to
     lock it down (start with `*` while testing)
   - Twilio and Stripe vars — see the two sections below. You can deploy and
     test the core sign-up/gig/match/claim loop before setting these; the
     app runs in safe fallback mode without them.
5. Railway auto-detects `npm start` from `package.json` — no extra config
   needed. First deploy will run `npm install`, then start the server, which
   applies `db/schema.sql` automatically.
6. Once deployed, hit `https://<your-app>.up.railway.app/api/health` to
   confirm it's live, then follow `LANDING_PAGE_WIRING.md` to point the
   landing page's sign-up form at this URL.

(Render or Fly.io work the same way in spirit — provision a Postgres add-on,
set the same env vars, deploy from Git. Railway is simplest for a first
deploy, per the brief's own recommendation.)

## Setting up Twilio

1. Create a Twilio account, buy a phone number capable of SMS.
2. Copy your Account SID and Auth Token from the Twilio Console into
   `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`; set `TWILIO_FROM_NUMBER` to
   the number you bought (E.164 format, e.g. `+18505551234`).
3. In the Twilio Console, set that number's **"A message comes in"** webhook
   to `POST https://<your-app>/api/sms/inbound` — this is what lets a
   musician text "YES" to claim a gig.
4. Without any of this set, the app logs what it would have sent to the
   console instead of erroring — safe to deploy and test before you have a
   Twilio account.

## Setting up Stripe

1. Create a Stripe account (test mode is fine to start).
2. Copy your secret key into `STRIPE_SECRET_KEY`.
3. In the Stripe Dashboard, create two recurring **Products/Prices**:
   Growth ($99/month) and Auto-Book Premium ($149/month). Copy each Price
   ID into `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_AUTO_BOOK_PREMIUM`.
4. Add a webhook endpoint in the Stripe Dashboard pointing at
   `https://<your-app>/api/stripe/webhook`, listening for at least
   `checkout.session.completed` and `customer.subscription.deleted`. Copy
   its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Without `STRIPE_SECRET_KEY` set, checkout/subscribe endpoints return a
   clearly-fake placeholder URL instead of erroring, so you can deploy and
   test everything else first.

## Admin dashboard

Visit `https://<your-app>/admin.html`, enter the `ADMIN_TOKEN` you set, and
you'll see open gigs, matches, and payment status. It's a static page hitting
a token-protected API route (`/api/admin/overview`) — it isn't linked from
the public site anywhere, but isn't meant to be a substitute for real auth
if this grows past an early pilot you're personally watching.

## Business-logic decisions I made that are worth you double-checking

The brief said pricing "must match exactly," so I want to flag two spots
where the brief was slightly ambiguous and I picked a specific, documented
interpretation rather than guessing silently — both are called out in code
comments too (`lib/referrals.js`, `lib/matching.js`):

1. **Founding Member limit** — I read "first 100 venues/musicians" as 100
   slots for *each* type (100 venues + 100 musicians), not one shared pool
   of 100 total. More generous, and the brief's wording was ambiguous either
   way.
2. **Referral bonus shape** — "one extra free fill (venues) or one free
   month of Growth (either side)" doesn't fully specify which reward applies
   to which pairing. I implemented: venue referrers/referees get a free-fill
   credit; musician referrers/referees get a free month of the Musician Pro
   Bundle (their closest equivalent to Growth, since Growth itself is a
   venue-only tier). Worth 5 minutes to confirm this is what you meant
   before it's live.

## What's intentionally NOT built here (per the brief)

Concierge AI (marketing/auto-book), vibe matching, standby bench, and the
rest of the "Roadmap" section — all explicitly deferred until the core
booking loop is proven, per `PROJECT_BRIEF.md`.
