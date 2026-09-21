# Phase 1 → Phase 2: what changed

A quick diff-level summary for review, on top of the detailed comments in
each file.

## Database
- SQLite (`node:sqlite`, file-based) → Postgres (`pg`), so it can run on a
  real host with persistent, concurrent-safe storage.
- Added: `contact_name` on venues/musicians (the landing page collects a
  contact person's name separately from the venue/band name — Phase 1's
  schema didn't have a column for it).
- Added: `referral_credits` table (ledger for referral bonus fulfillment —
  the brief flagged this as needed but unbuilt in Phase 1).
- Added: `processed_stripe_events` table (webhook idempotency).
- Added: Stripe fields on `gigs` (checkout session id/url, amount due,
  pricing reason) and on `venues`/`musicians` (customer/subscription ids).
- Added: `free_fill_credits`, `free_growth_month_credits`,
  `free_pro_bundle_month_credits`, `musician_pro`, `addon_*` columns.

## Matching engine (`lib/matching.js`)
- Now async (Postgres queries instead of synchronous SQLite calls).
- **Behavior change, on purpose:** Phase 1's reach filter had a comment
  claiming to check "same city" for local musicians, but the actual code
  just `return true` for every reach tier — meaning local/regional
  musicians could get matched to gigs anywhere in the country. Phase 2
  actually implements the city/state check the comment described:
  nationwide (any location), regional (same state), local (same city
  and state). This is the "tighten [reach matching] in Phase 2" instruction
  from the brief.
- **Behavior change, on purpose:** the 50%-off second-gig discount now
  actually checks the 30-day window against the first gig's fill date.
  Phase 1 applied the discount whenever `gigs_completed === 1`, with no
  date check at all, even though the brief requires the window.

## Claiming a gig (`lib/claim.js` — new)
- Phase 1's claim logic lived inline in `server.js` with no locking — two
  simultaneous claims on the same gig were a real race condition. Phase 2
  wraps the whole claim in a Postgres transaction with `SELECT ... FOR
  UPDATE` on the gig row, so "first to claim wins" is actually guaranteed
  under concurrent requests, not just usually true.
- Added: the "sorry, filled" follow-up to every other notified musician,
  which the brief calls for but Phase 1 didn't send anything for.
- Shared between the HTTP claim endpoint and the new SMS "YES" reply path,
  so both can't drift apart.

## Notifications (was: `notifications_log` only) → real Twilio (`lib/sms.js`)
- Outbound SMS now actually sends via Twilio when credentials are set;
  still logs to the same table either way (now with a `channel` column
  showing `sms` vs `log`, and the Twilio message SID when sent for real).
- New inbound webhook (`POST /api/sms/inbound`) lets a musician text "YES"
  to claim their most recent open gig invite — this didn't exist in Phase 1
  at all (notifications were one-way).

## Payments (new: `lib/stripe.js`)
- One-time Checkout Sessions for per-gig commission (dynamic amount, since
  the commission depends on the pricing rules — not a fixed Payment Link).
- Subscription Checkout for Growth / Auto-Book Premium.
- A webhook handler that updates `venues.subscription_tier` and marks gigs
  paid, with idempotency so Stripe's automatic retries can't double-process
  an event.
- None of this existed in Phase 1 — `payment_status` was tracked but nothing
  ever moved it to `paid`.

## Founding Member + referrals (new: `lib/referrals.js`)
- Phase 1 trusted a client-supplied `founding_member` boolean on sign-up
  with no server-side check at all — anyone could claim it. Phase 2 checks
  actual counts server-side against a limit (100 per user type — see the
  README for the exact interpretation used).
- Referral credit fulfillment (crediting both sides of a referral) is new —
  the brief noted this was needed ("a fulfillment mechanism (credit
  tracking)") but not built in Phase 1.

## Admin dashboard (new)
- `public/admin.html` + `GET /api/admin/overview` — didn't exist in Phase 1
  (API-only, no UI at all).

## Everything else
Sign-up, gig posting, and the list/health endpoints keep their Phase 1
request/response shapes as-is.
