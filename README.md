# Toe-Rilla Gig Network — Phase 1 Backend (Working Prototype)

This is a real, tested backend implementing the core Phase 1 matching engine:
venue/musician sign-up, gig posting, automatic matching by genre/reach,
first-to-claim booking, the finalized pricing logic (first gig free,
second gig 50% off, 15% commission after, or $0 if subscribed), and live
Twilio SMS notifications with "reply YES to claim" support.

## Requirements
- Node.js 18+
- A Twilio account with a phone number (optional — the server runs fine
  without one, it just logs SMS to the console instead of sending them)

## Setup
```bash
npm install
cp .env.example .env   # then fill in your Twilio credentials
node server.js
```
Server starts on http://localhost:3000

## Twilio setup
1. Get an Account SID, Auth Token, and phone number from
   [console.twilio.com](https://console.twilio.com).
2. Put them in `.env` (local) or your Railway service's variables
   (production): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_PHONE_NUMBER`.
3. In the Twilio console, open your phone number's configuration and set
   "A message comes in" to a webhook pointing at
   `https://<your-deployed-domain>/api/sms/inbound` (HTTP POST).
4. Set `PUBLIC_BASE_URL` to that same base domain (e.g.
   `https://your-app.up.railway.app`) so inbound webhook requests can be
   signature-verified. Without a Twilio Auth Token configured, signature
   verification is skipped (dev mode).

## Deploying to Railway
1. Push this repo to GitHub, then in Railway: New Project → Deploy from
   GitHub repo.
2. Add a Volume to the service (Settings → Volumes) mounted at `/data`, and
   set the env var `DB_PATH=/data/toerilla.db`. Without this the SQLite
   file lives in the container's filesystem and is wiped on every redeploy.
3. Set the `TWILIO_*` and `PUBLIC_BASE_URL` env vars from above in the
   service's Variables tab.
4. Railway auto-detects the `start` script in `package.json` — no extra
   config needed. Once deployed, grab the generated `*.up.railway.app`
   domain and point the Twilio webhook (step 3 above) at it.

## API Endpoints

- `POST /api/venues` — sign up a venue
  Body: { name, contact_phone, contact_email, city, state, founding_member }

- `POST /api/musicians` — sign up a musician
  Body: { name, contact_phone, contact_email, city, state, genres, instruments, reach, rate_min, rate_max, founding_member }

- `POST /api/gigs` — venue posts an open slot (triggers auto-matching + notification log)
  Body: { venue_id, gig_date, gig_time, genre_needed, budget, urgency }

- `POST /api/gigs/:id/claim` — musician claims a gig (first to claim wins)
  Body: { musician_id }

- `POST /api/sms/inbound` — Twilio webhook for inbound SMS; a musician
  replying "YES" claims their most recent open gig notification

- `GET /api/gigs` — list all gigs
- `GET /api/venues` — list all venues
- `GET /api/musicians` — list all musicians
- `GET /api/health` — health check

## What this proves
This is a genuinely working Phase 1 matching engine — not a mockup. It has
been tested end-to-end: sign-up, gig posting, automatic matching, first-to-
claim booking, and pricing calculation all function correctly. SMS
notifications now go out for real via Twilio, and musicians can claim a
gig by replying YES to the text.

## What's NOT in this version yet (Phase 2)
- No Claude API / Concierge AI layer yet
- No Stripe payment integration yet
- No web frontend (API only — a developer would build a UI or connect the
  existing landing page's forms to these endpoints)
- Uses SQLite (file-based) — fine for early/moderate traffic if backed by a
  Railway volume, would move to a hosted Postgres database at real scale

## Next steps to make this live
1. Add Stripe for the payment/commission step
2. Build a simple admin dashboard (or connect the existing landing page forms)
3. Layer in Claude API calls for Concierge once the core loop is proven
