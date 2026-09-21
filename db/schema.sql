-- Toe-Rilla Gig Network — Core Database Schema (Phase 2 / Postgres)
--
-- Ported from the Phase 1 SQLite schema. Column names/semantics are kept
-- identical wherever possible so the Phase 1 business logic maps over
-- directly. New columns/tables added for Phase 2 (Stripe, referral credits,
-- founding-member counters, musician add-ons) are called out in comments.

CREATE TABLE IF NOT EXISTS venues (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,               -- the venue's/business's own name (e.g. "The Sandbar")
  contact_name TEXT,                -- Phase 2: the person signing up, from the landing page's "Name" field
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  gigs_completed INTEGER NOT NULL DEFAULT 0,
  subscription_tier TEXT NOT NULL DEFAULT 'pay_per_fill'
    CHECK (subscription_tier IN ('pay_per_fill', 'growth', 'auto_book_premium')),
  founding_member BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by INTEGER,             -- id of the referring venue or musician (see referrer_type)
  referrer_type TEXT CHECK (referrer_type IN ('venue', 'musician')),
  -- Phase 2: Stripe
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  -- Phase 2: referral fulfillment credits (redeemed against pricing at claim time)
  free_fill_credits INTEGER NOT NULL DEFAULT 0,
  free_growth_month_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS musicians (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,                -- band/artist name (e.g. "The Sandbar" -> for musicians, "your band name")
  contact_name TEXT,                 -- Phase 2: the person signing up, from the landing page's "Name" field
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  genres TEXT NOT NULL,             -- comma-separated, e.g. "acoustic,covers,jazz"
  instruments TEXT,                 -- comma-separated, e.g. "guitar,vocals"
  reach TEXT NOT NULL DEFAULT 'local' CHECK (reach IN ('local', 'regional', 'nationwide')),
  travel_radius_miles INTEGER DEFAULT 25,
  rate_min INTEGER,
  rate_max INTEGER,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  musician_pro BOOLEAN NOT NULL DEFAULT FALSE,   -- Musician Pro Bundle: unlocks band-fill-in matching
  founding_member BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by INTEGER,
  referrer_type TEXT CHECK (referrer_type IN ('venue', 'musician')),
  -- Phase 2: Stripe (musician add-on subscriptions)
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  -- Phase 2: musician add-ons (see PROJECT_BRIEF "Musician-side monetization")
  addon_reminders_pro BOOLEAN NOT NULL DEFAULT FALSE,
  addon_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  addon_outreach_boost BOOLEAN NOT NULL DEFAULT FALSE,
  -- Phase 2: referral fulfillment credits
  free_pro_bundle_month_credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gigs (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  gig_date TEXT NOT NULL,
  gig_time TEXT,
  genre_needed TEXT NOT NULL,
  budget INTEGER,
  urgency TEXT NOT NULL DEFAULT 'planned' CHECK (urgency IN ('urgent', 'planned')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  matched_musician_id INTEGER REFERENCES musicians(id),
  payment_status TEXT NOT NULL DEFAULT 'n/a' CHECK (payment_status IN ('n/a', 'free', 'pending', 'paid')),
  -- Phase 2: Stripe Checkout session for the commission owed on this gig (if any)
  stripe_checkout_session_id TEXT,
  stripe_checkout_url TEXT,
  amount_due_cents INTEGER,
  pricing_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS band_openings (
  id SERIAL PRIMARY KEY,
  posting_musician_id INTEGER NOT NULL REFERENCES musicians(id),
  instrument_needed TEXT NOT NULL,
  gig_date TEXT,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled')),
  matched_musician_id INTEGER REFERENCES musicians(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id SERIAL PRIMARY KEY,
  gig_id INTEGER REFERENCES gigs(id),
  musician_id INTEGER REFERENCES musicians(id),
  message TEXT,
  -- Phase 2: did this actually go out over Twilio, or just get logged (no creds set)?
  channel TEXT NOT NULL DEFAULT 'log' CHECK (channel IN ('log', 'sms')),
  twilio_sid TEXT,
  -- Phase 2: has this specific notification already been claimed/responded to,
  -- so an inbound "YES" from this musician knows which open notification it answers.
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'claimed', 'expired')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 2: referral bonus fulfillment ledger. A row is created for each side
-- of a completed referral and marked redeemed when the credit is applied.
CREATE TABLE IF NOT EXISTS referral_credits (
  id SERIAL PRIMARY KEY,
  user_type TEXT NOT NULL CHECK (user_type IN ('venue', 'musician')),
  user_id INTEGER NOT NULL,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('free_fill', 'free_growth_month', 'free_pro_bundle_month')),
  amount INTEGER NOT NULL DEFAULT 1,
  redeemed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMPTZ
);

-- Phase 2: Stripe webhook events we've already processed, to make webhook
-- handling idempotent (Stripe retries on any non-2xx response).
CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gigs_status ON gigs(status);
CREATE INDEX IF NOT EXISTS idx_gigs_venue ON gigs(venue_id);
CREATE INDEX IF NOT EXISTS idx_musicians_available ON musicians(available);
CREATE INDEX IF NOT EXISTS idx_notifications_gig ON notifications_log(gig_id);
CREATE INDEX IF NOT EXISTS idx_notifications_musician_status ON notifications_log(musician_id, status);
