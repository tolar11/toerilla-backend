-- Toe-Rilla Gig Network — Core Database Schema (Phase 1)

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  gigs_completed INTEGER DEFAULT 0,
  subscription_tier TEXT DEFAULT 'pay_per_fill', -- pay_per_fill | growth | auto_book_premium
  founding_member INTEGER DEFAULT 0,
  referred_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS musicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  genres TEXT NOT NULL,          -- comma-separated, e.g. "acoustic,covers,jazz"
  instruments TEXT,              -- comma-separated, e.g. "guitar,vocals"
  reach TEXT DEFAULT 'local',    -- local | regional | nationwide
  travel_radius_miles INTEGER DEFAULT 25,
  rate_min INTEGER,
  rate_max INTEGER,
  available INTEGER DEFAULT 1,
  musician_pro INTEGER DEFAULT 0, -- unlocks band-fill-in matching
  founding_member INTEGER DEFAULT 0,
  referred_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gigs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER NOT NULL,
  gig_date TEXT NOT NULL,
  gig_time TEXT,
  genre_needed TEXT NOT NULL,
  budget INTEGER,
  urgency TEXT DEFAULT 'planned', -- urgent | planned
  status TEXT DEFAULT 'open',     -- open | filled | cancelled
  matched_musician_id INTEGER,
  payment_status TEXT DEFAULT 'n/a', -- n/a | free | pending | paid
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  filled_at TEXT,
  FOREIGN KEY (venue_id) REFERENCES venues(id),
  FOREIGN KEY (matched_musician_id) REFERENCES musicians(id)
);

CREATE TABLE IF NOT EXISTS band_openings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_musician_id INTEGER NOT NULL,
  instrument_needed TEXT NOT NULL,
  gig_date TEXT,
  details TEXT,
  status TEXT DEFAULT 'open', -- open | filled
  matched_musician_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (posting_musician_id) REFERENCES musicians(id)
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gig_id INTEGER,
  musician_id INTEGER,
  message TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);
