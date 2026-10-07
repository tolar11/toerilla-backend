// server.js — Toe-Rilla Gig Network API (Phase 2)
//
// Ported from the Phase 1 prototype (node:http + node:sqlite, zero
// dependencies) to Express + Postgres, with Twilio SMS, Stripe payments/
// billing, and a minimal admin dashboard layered on top. Every Phase 1
// endpoint below preserves its original request/response shape unless a
// comment says otherwise.

require('dotenv').config();

const express = require('express');
const path = require('path');
const { query, getClient, runSchema } = require('./db');
const auth = require('./lib/auth');
const { findMatchingMusicians, calculatePricing } = require('./lib/matching');
const { sendSMS } = require('./lib/sms');
const { claimGig, ClaimError } = require('./lib/claim');
const { hasFoundingMemberSlot, grantReferralCredits } = require('./lib/referrals');
const stripeLib = require('./lib/stripe');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1); // Railway sits in front of us; this makes req.ip the real visitor address

// Stripe webhooks need the raw body for signature verification, so that
// route is registered BEFORE the global json() body parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded bodies

// Basic hardening headers; account/API responses are never cached.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// --- CORS: allow the landing page (a different origin) to call this API ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// The genre list used everywhere (sign-up form, gig posting, matching). Matching
// compares these exact lowercase words, so everyone has to pick from the same list.
const GENRES = ['acoustic', 'blues', 'country', 'covers', 'funk', 'jazz', 'latin', 'originals', 'pop', 'r&b', 'reggae', 'rock'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** Accepts an array or a comma-separated string; keeps only known genres, de-duplicated. */
function cleanGenres(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((g) => String(g).trim().toLowerCase()).filter((g) => GENRES.includes(g)))];
}

/** Turns the travel setting from the forms into the stored reach tier + miles. */
function cleanTravel(body) {
  if (body.reach === 'nationwide') return { reach: 'nationwide', miles: 3000 };
  const miles = Number(body.travel_radius_miles);
  const m = Number.isInteger(miles) && miles > 0 && miles <= 5000 ? miles : 25;
  // Today's matching is city/state based: 25 miles or less = same city, anything wider = same state.
  return { reach: m <= 25 ? 'local' : 'regional', miles: m };
}

function cleanMoney(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, 'Please enter a dollar amount between 0 and 100,000.');
  return Math.round(n);
}

/**
 * Create a venue or musician together with its login, in one transaction.
 * Everything is validated here (the web form is not trusted).
 */
async function registerAccount(role, body) {
  const email = text(body.email, 254);
  const username = text(body.username, 30);
  const password = String(body.password || '');
  const problem = auth.checkEmail(email) || auth.checkUsername(username) || auth.checkPassword(password);
  if (problem) throw new HttpError(400, problem);

  const name = text(body.name, 120);
  const phone = text(body.contact_phone, 60);
  const city = text(body.city, 80);
  const state = text(body.state, 80);
  if (!name || !phone || !city || !state) {
    throw new HttpError(400, 'Please fill in your name, phone or Instagram, and city and state.');
  }
  const contactName = text(body.contact_name, 120) || null;

  let genres = '';
  let travel = null;
  if (role === 'musician') {
    const list = cleanGenres(body.genres);
    if (!list.length) throw new HttpError(400, 'Please pick at least one genre so we can match you to gigs.');
    genres = list.join(',');
    travel = cleanTravel(body);
  }

  const referredBy = Number.isInteger(Number(body.referred_by)) && Number(body.referred_by) > 0 ? Number(body.referred_by) : null;
  const referrerType = referredBy ? (body.referrer_type === 'venue' ? 'venue' : 'musician') : null;
  const foundingMember = (await hasFoundingMemberSlot(role)) && !!body.claim_founding_member;
  const passwordHash = await auth.hashPassword(password);

  const client = await getClient();
  let id;
  try {
    await client.query('BEGIN');
    if (role === 'venue') {
      const r = await client.query(
        `INSERT INTO venues (name, contact_name, contact_phone, contact_email, city, state, founding_member, referred_by, referrer_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [name, contactName, phone, email, city, state, foundingMember, referredBy, referrerType]
      );
      id = r.rows[0].id;
    } else {
      const r = await client.query(
        `INSERT INTO musicians
           (name, contact_name, contact_phone, contact_email, city, state, genres, instruments, reach, rate_min, rate_max, founding_member, referred_by, referrer_type, travel_radius_miles)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          name, contactName, phone, email, city, state, genres,
          text(body.instruments, 200).toLowerCase(), travel.reach, null, null,
          foundingMember, referredBy, referrerType, travel.miles,
        ]
      );
      id = r.rows[0].id;
    }
    await client.query(
      `INSERT INTO accounts (role, venue_id, musician_id, email, username, password_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      [role, role === 'venue' ? id : null, role === 'musician' ? id : null, email, username, passwordHash]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    if (err.code === '23505') {
      if (String(err.constraint).includes('email')) throw new HttpError(409, 'An account with that email already exists. Try logging in instead.');
      if (String(err.constraint).includes('username')) throw new HttpError(409, 'That username is taken. Please pick another.');
    }
    throw err;
  } finally {
    client.release();
  }

  if (referredBy) {
    await grantReferralCredits({ referrerType, referrerId: referredBy, newUserType: role, newUserId: id }).catch((err) =>
      console.error('[referral] failed to grant credits:', err.message)
    );
  }
  return { id, founding_member: foundingMember };
}

/** Insert a gig, find matching musicians and text them. Used by the admin page and by venue logins. */
async function createGigAndNotify(venue, input) {
  const { rows } = await query(
    `INSERT INTO gigs (venue_id, gig_date, gig_time, genre_needed, budget, urgency)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [venue.id, input.gig_date, input.gig_time || null, input.genre_needed, input.budget || null, input.urgency || 'planned']
  );
  const gig = rows[0];
  const matches = await findMatchingMusicians(gig, venue);

  for (const m of matches) {
    const msg = `Toe-Rilla: New ${gig.urgency} gig — ${gig.genre_needed} needed on ${gig.gig_date}${
      gig.gig_time ? ' at ' + gig.gig_time : ''
    } for ${venue.name} (${venue.city}, ${venue.state}). Budget: $${gig.budget || 'TBD'}. Reply YES to claim.`;
    const smsResult = await sendSMS(m.contact_phone, msg);
    await query(
      `INSERT INTO notifications_log (gig_id, musician_id, message, channel, twilio_sid) VALUES ($1,$2,$3,$4,$5)`,
      [gig.id, m.id, msg, smsResult.channel, smsResult.sid]
    );
  }
  return { gig, matches };
}

// --- Sign up a venue / a musician (creates the profile and the login together) ---
app.post(
  '/api/venues',
  asyncRoute(async (req, res) => {
    const out = await registerAccount('venue', req.body || {});
    res.status(201).json({ id: out.id, message: 'Venue created', founding_member: out.founding_member });
  })
);
app.post(
  '/api/musicians',
  asyncRoute(async (req, res) => {
    const out = await registerAccount('musician', req.body || {});
    res.status(201).json({ id: out.id, message: 'Musician created', founding_member: out.founding_member });
  })
);

// --- Admin posts an open gig for any venue (triggers matching + notifications) ---
app.post(
  '/api/gigs',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const body = req.body;
    const { rows: venueRows } = await query('SELECT * FROM venues WHERE id = $1', [body.venue_id]);
    const venue = venueRows[0];
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const { gig, matches } = await createGigAndNotify(venue, body);
    res.status(201).json({
      gig,
      matched_musicians_notified: matches.length,
      matches: matches.map((m) => ({ id: m.id, name: m.name, genres: m.genres })),
    });
  })
);

// --- Musician claims a gig (first to claim wins) ---
app.post(
  '/api/gigs/:id/claim',
  requireAdmin, // real claims arrive by SMS (/api/sms/inbound); this HTTP route is for admin testing
  asyncRoute(async (req, res) => {
    const gigId = Number(req.params.id);
    const musicianId = req.body.musician_id;
    try {
      const result = await claimGig({ gigId, musicianId });
      res.status(200).json({
        message: 'Gig confirmed!',
        gig_id: gigId,
        venue: result.venue,
        musician: result.musician,
        pricing: result.pricing,
      });
    } catch (err) {
      if (err instanceof ClaimError) {
        if (err.code === 'not_found') return res.status(404).json({ error: err.message });
        if (err.code === 'already_filled') {
          return res.status(409).json({ error: err.message, filled_by: err.extra.filled_by });
        }
      }
      throw err;
    }
  })
);

// --- List / health (unchanged from Phase 1) ---
app.get(
  '/api/gigs',
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT * FROM gigs ORDER BY created_at DESC');
    res.status(200).json(rows);
  })
);
app.get(
  '/api/venues',
  requireAdmin, // these contain phone numbers, so they are not public
  asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT * FROM venues ORDER BY created_at DESC');
    res.status(200).json(rows);
  })
);
app.get(
  '/api/musicians',
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT * FROM musicians ORDER BY created_at DESC');
    res.status(200).json(rows);
  })
);
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'Toe-Rilla Gig Network API' });
});

// --- Stripe: start a subscription (Growth or Auto-Book Premium) ---
app.post(
  '/api/venues/:id/subscribe',
  asyncRoute(async (req, res) => {
    const { rows } = await query('SELECT * FROM venues WHERE id = $1', [req.params.id]);
    const venue = rows[0];
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const checkout = await stripeLib.createSubscriptionCheckout({ venue, tier: req.body.tier });
    res.status(200).json({ checkout_url: checkout.url });
  })
);

// --- Twilio inbound SMS webhook: musician texts "YES" to claim a gig ---
app.post(
  '/api/sms/inbound',
  asyncRoute(async (req, res) => {
    const from = (req.body.From || '').trim();
    const bodyText = (req.body.Body || '').trim().toUpperCase();

    const { rows: musicianRows } = await query(
      `SELECT * FROM musicians WHERE contact_phone = $1 OR RIGHT(contact_phone, 10) = RIGHT($1, 10)`,
      [from]
    );
    const musician = musicianRows[0];

    const twiml = (msg) =>
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`;

    res.set('Content-Type', 'text/xml');

    if (!musician) {
      return res.status(200).send(twiml('Toe-Rilla: We couldn\'t find a musician profile for this number.'));
    }
    if (bodyText !== 'YES') {
      return res.status(200).send(twiml('Toe-Rilla: Reply YES to an open gig text to claim it.'));
    }

    const { rows: pending } = await query(
      `SELECT * FROM notifications_log WHERE musician_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
      [musician.id]
    );
    if (!pending[0]) {
      return res.status(200).send(twiml("Toe-Rilla: You don't have an open gig invite to claim right now."));
    }

    try {
      const result = await claimGig({ gigId: pending[0].gig_id, musicianId: musician.id });
      return res
        .status(200)
        .send(
          twiml(
            `You're confirmed for the ${result.gig.genre_needed} gig on ${result.gig.gig_date}! Venue contact: ${result.venue.contact_phone}.`
          )
        );
    } catch (err) {
      if (err instanceof ClaimError && err.code === 'already_filled') {
        return res.status(200).send(twiml('Toe-Rilla: Sorry, that gig was just filled by someone else.'));
      }
      throw err;
    }
  })
);

// --- Minimal admin API (protected by a shared bearer token) ---
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN is not configured on the server' });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get(
  '/api/admin/overview',
  requireAdmin,
  asyncRoute(async (_req, res) => {
    const { rows: gigs } = await query(`
      SELECT g.*, v.name AS venue_name, m.name AS musician_name
      FROM gigs g
      JOIN venues v ON v.id = g.venue_id
      LEFT JOIN musicians m ON m.id = g.matched_musician_id
      ORDER BY g.created_at DESC
      LIMIT 200
    `);
    const { rows: counts } = await query(`
      SELECT
        (SELECT COUNT(*) FROM venues) AS venue_count,
        (SELECT COUNT(*) FROM musicians) AS musician_count,
        (SELECT COUNT(*) FROM gigs WHERE status = 'open') AS open_gigs,
        (SELECT COUNT(*) FROM gigs WHERE status = 'filled') AS filled_gigs,
        (SELECT COUNT(*) FROM gigs WHERE payment_status = 'pending') AS pending_payments
    `);
    const { rows: venues } = await query(`
      SELECT v.id, v.name, v.contact_name, v.contact_phone, v.city, v.state, v.founding_member, v.gigs_completed, v.subscription_tier, v.created_at,
             a.id AS account_id, a.username, a.email
      FROM venues v LEFT JOIN accounts a ON a.venue_id = v.id
      ORDER BY v.created_at DESC LIMIT 500
    `);
    const { rows: musicians } = await query(`
      SELECT m.id, m.name, m.contact_name, m.contact_phone, m.city, m.state, m.genres, m.instruments, m.reach, m.travel_radius_miles, m.available, m.founding_member, m.created_at,
             a.id AS account_id, a.username, a.email
      FROM musicians m LEFT JOIN accounts a ON a.musician_id = m.id
      ORDER BY m.created_at DESC LIMIT 500
    `);
    const { rows: notifications } = await query(`
      SELECT n.id, n.gig_id, n.message, n.channel, n.status, n.sent_at, m.name AS musician_name
      FROM notifications_log n
      LEFT JOIN musicians m ON m.id = n.musician_id
      ORDER BY n.sent_at DESC LIMIT 25
    `);
    res.status(200).json({ counts: counts[0], gigs, venues, musicians, notifications });
  })
);

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripeLib.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: Stripe retries webhooks, so skip anything we've already handled.
  const already = await query('SELECT 1 FROM processed_stripe_events WHERE event_id = $1', [event.id]);
  if (already.rows.length > 0) return res.status(200).json({ received: true, duplicate: true });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (session.mode === 'payment' && session.metadata?.gig_id) {
        await query(`UPDATE gigs SET payment_status = 'paid' WHERE id = $1`, [session.metadata.gig_id]);
      }

      if (session.mode === 'subscription' && session.metadata?.venue_id) {
        await query(
          `UPDATE venues SET subscription_tier = $1, stripe_customer_id = $2, stripe_subscription_id = $3 WHERE id = $4`,
          [session.metadata.tier, session.customer, session.subscription, session.metadata.venue_id]
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await query(
        `UPDATE venues SET subscription_tier = 'pay_per_fill' WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
    }

    await query('INSERT INTO processed_stripe_events (event_id) VALUES ($1)', [event.id]);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe webhook] handler error:', err);
    res.status(500).json({ error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Accounts: login, logout, password reset
// ---------------------------------------------------------------------------

const loginLimiter = auth.makeLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const loginIpLimiter = auth.makeLimiter({ max: 40, windowMs: 15 * 60 * 1000 });
const forgotLimiter = auth.makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const resetLimiter = auth.makeLimiter({ max: 20, windowMs: 60 * 60 * 1000 });
const gigPostLimiter = auth.makeLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

function baseUrl(req) {
  return (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function requireSession(req, res, next) {
  const secret = auth.sessionSecret();
  if (!secret) return res.status(500).json({ error: 'Accounts are not configured on the server (ADMIN_TOKEN is missing).' });
  const cookies = auth.parseCookies(req.headers.cookie);
  const session = auth.readSession(cookies[auth.COOKIE_NAME], secret);
  if (!session) return res.status(401).json({ error: 'Please log in.' });
  query('SELECT * FROM accounts WHERE id = $1', [session.accountId])
    .then(({ rows }) => {
      const account = rows[0];
      // Changing the password changes passwordVersion, which signs out old sessions.
      if (!account || auth.passwordVersion(account.password_hash) !== session.pv) {
        return res.status(401).json({ error: 'Please log in again.' });
      }
      req.account = account;
      next();
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
    });
}
const requireRole = (role) => (req, res, next) =>
  req.account.role === role ? next() : res.status(403).json({ error: `This is only available to ${role} accounts.` });

async function loadProfile(account) {
  if (account.role === 'venue') {
    const { rows } = await query(
      `SELECT id, name, contact_name, contact_phone, city, state, gigs_completed, subscription_tier, free_fill_credits, founding_member
       FROM venues WHERE id = $1`,
      [account.venue_id]
    );
    return rows[0];
  }
  const { rows } = await query(
    `SELECT id, name, contact_name, contact_phone, city, state, genres, instruments, reach, travel_radius_miles, available, founding_member
     FROM musicians WHERE id = $1`,
    [account.musician_id]
  );
  return rows[0];
}

/** One plain-English line about what the venue's next filled gig will cost. */
async function pricingNote(venue) {
  if (venue.subscription_tier === 'growth' || venue.subscription_tier === 'auto_book_premium') {
    return 'Your plan covers every fill: $0 per gig.';
  }
  if (venue.free_fill_credits > 0) {
    return `You have ${venue.free_fill_credits} free fill credit${venue.free_fill_credits === 1 ? '' : 's'} banked.`;
  }
  if (venue.gigs_completed === 0) return 'Your first filled gig is free.';
  if (venue.gigs_completed === 1) {
    const { rows } = await query(
      `SELECT filled_at FROM gigs WHERE venue_id = $1 AND status = 'filled' AND filled_at IS NOT NULL ORDER BY filled_at ASC LIMIT 1`,
      [venue.id]
    );
    if (rows[0]) {
      const deadline = new Date(new Date(rows[0].filled_at).getTime() + 30 * 24 * 3600 * 1000);
      if (deadline > new Date()) {
        return `Your second filled gig is 50% off the 15% commission if it fills by ${deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`;
      }
    }
    return 'Standard 15% commission applies to your next filled gig.';
  }
  return 'Standard 15% commission applies to each filled gig (free on a Growth or Auto-Book plan).';
}

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const secret = auth.sessionSecret();
    if (!secret) return res.status(500).json({ error: 'Accounts are not configured on the server.' });
    const identifier = text(req.body && req.body.identifier, 254).toLowerCase();
    const password = String((req.body && req.body.password) || '').slice(0, 200);
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your username (or email) and password.' });

    if (!loginIpLimiter(req.ip) || !loginLimiter(req.ip + '|' + identifier)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }

    const { rows } = await query(
      `SELECT * FROM accounts WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1`,
      [identifier]
    );
    const account = rows[0];
    const ok = account ? await auth.verifyPassword(password, account.password_hash) : (await auth.dummyVerify(password), false);
    if (!ok) return res.status(401).json({ error: 'That username or password is not right.' });

    const token = auth.signSession({ accountId: account.id, passwordHash: account.password_hash, secret });
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    res.status(200).json({ ok: true, role: account.role });
  })
);

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie());
  res.status(200).json({ ok: true });
});

app.get(
  '/api/auth/me',
  requireSession,
  asyncRoute(async (req, res) => {
    const profile = await loadProfile(req.account);
    const out = { role: req.account.role, username: req.account.username, email: req.account.email, profile, genres: GENRES };
    if (req.account.role === 'venue') out.pricing_note = await pricingNote(profile);
    res.status(200).json(out);
  })
);

app.post(
  '/api/auth/forgot',
  asyncRoute(async (req, res) => {
    const email = text(req.body && req.body.email, 254).toLowerCase();
    // Same answer whether or not the email exists, so this can't be used to find out who has an account.
    const reply = () => res.status(200).json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
    if (auth.checkEmail(email) || !forgotLimiter(req.ip) || !forgotLimiter('e|' + email)) return reply();

    const { rows } = await query('SELECT * FROM accounts WHERE LOWER(email) = $1 LIMIT 1', [email]);
    const account = rows[0];
    if (account) {
      const token = auth.newResetToken();
      await query(
        `UPDATE accounts SET reset_token_hash = $1, reset_expires = NOW() + ($2 || ' minutes')::interval WHERE id = $3`,
        [auth.hashToken(token), String(auth.RESET_TTL_MINUTES), account.id]
      );
      const link = `${baseUrl(req)}/account.html#reset=${token}`;
      await auth.sendEmail({
        to: account.email,
        subject: 'Reset your Toe-Rilla password',
        text:
          `Someone asked to reset the password for your Toe-Rilla Gig Network account (username: ${account.username}).\n\n` +
          `Choose a new password here (the link works for ${auth.RESET_TTL_MINUTES} minutes):\n${link}\n\n` +
          `If you didn't ask for this, you can ignore this email and your password stays the same.`,
      });
    }
    reply();
  })
);

app.post(
  '/api/auth/reset',
  asyncRoute(async (req, res) => {
    if (!resetLimiter(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    const token = String((req.body && req.body.token) || '');
    const problem = auth.checkPassword(req.body && req.body.password);
    if (problem) return res.status(400).json({ error: problem });
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'That reset link is not valid. Please request a new one.' });

    const newHash = await auth.hashPassword(String(req.body.password));
    const { rows } = await query(
      `UPDATE accounts SET password_hash = $1, reset_token_hash = NULL, reset_expires = NULL
       WHERE reset_token_hash = $2 AND reset_expires > NOW() RETURNING id`,
      [newHash, auth.hashToken(token)]
    );
    if (!rows[0]) return res.status(400).json({ error: 'That reset link has expired or was already used. Please request a new one.' });
    res.status(200).json({ ok: true });
  })
);

app.post(
  '/api/me/password',
  requireSession,
  asyncRoute(async (req, res) => {
    const problem = auth.checkPassword(req.body && req.body.new_password);
    if (problem) return res.status(400).json({ error: problem });
    if (!(await auth.verifyPassword(String(req.body.current_password || ''), req.account.password_hash))) {
      return res.status(400).json({ error: 'Your current password is not right.' });
    }
    const newHash = await auth.hashPassword(String(req.body.new_password));
    await query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newHash, req.account.id]);
    // The old session is now invalid; hand back a fresh one so this browser stays signed in.
    const token = auth.signSession({ accountId: req.account.id, passwordHash: newHash, secret: auth.sessionSecret() });
    res.setHeader('Set-Cookie', auth.sessionCookie(token));
    res.status(200).json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Signed-in venue / musician actions
// ---------------------------------------------------------------------------

app.post(
  '/api/me/profile',
  requireSession,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const name = text(b.name, 120);
    const phone = text(b.contact_phone, 60);
    const city = text(b.city, 80);
    const state = text(b.state, 80);
    if (!name || !phone || !city || !state) throw new HttpError(400, 'Name, phone or Instagram, city and state can\'t be empty.');
    const contactName = text(b.contact_name, 120) || null;

    if (req.account.role === 'venue') {
      await query(
        `UPDATE venues SET name=$1, contact_name=$2, contact_phone=$3, city=$4, state=$5 WHERE id=$6`,
        [name, contactName, phone, city, state, req.account.venue_id]
      );
    } else {
      const genres = cleanGenres(b.genres);
      if (!genres.length) throw new HttpError(400, 'Pick at least one genre.');
      const travel = cleanTravel(b);
      await query(
        `UPDATE musicians SET name=$1, contact_name=$2, contact_phone=$3, city=$4, state=$5, genres=$6, instruments=$7,
                reach=$8, travel_radius_miles=$9, rate_min=$10, rate_max=$11, available=$12 WHERE id=$13`,
        [
          name, contactName, phone, city, state, genres.join(','), text(b.instruments, 200).toLowerCase(),
          travel.reach, travel.miles, cleanMoney(b.rate_min), cleanMoney(b.rate_max), b.available !== false, req.account.musician_id,
        ]
      );
    }
    res.status(200).json({ ok: true, profile: await loadProfile(req.account) });
  })
);

app.get(
  '/api/me/gigs',
  requireSession,
  asyncRoute(async (req, res) => {
    if (req.account.role === 'venue') {
      const { rows } = await query(
        `SELECT g.id, g.gig_date, g.gig_time, g.genre_needed, g.budget, g.urgency, g.status, g.payment_status,
                g.amount_due_cents, g.pricing_reason, g.stripe_checkout_url, g.created_at, g.filled_at,
                m.name AS musician_name, m.contact_phone AS musician_phone
         FROM gigs g LEFT JOIN musicians m ON m.id = g.matched_musician_id
         WHERE g.venue_id = $1 ORDER BY g.created_at DESC LIMIT 100`,
        [req.account.venue_id]
      );
      return res.status(200).json({ gigs: rows });
    }
    const invitations = await query(
      `SELECT * FROM (
         SELECT DISTINCT ON (g.id) g.id, g.gig_date, g.gig_time, g.genre_needed, g.budget, g.urgency,
                v.name AS venue_name, v.city, v.state, n.sent_at
         FROM notifications_log n
         JOIN gigs g ON g.id = n.gig_id
         JOIN venues v ON v.id = g.venue_id
         WHERE n.musician_id = $1 AND n.status = 'sent' AND g.status = 'open'
         ORDER BY g.id, n.sent_at DESC
       ) t ORDER BY sent_at DESC`,
      [req.account.musician_id]
    );
    const booked = await query(
      `SELECT g.id, g.gig_date, g.gig_time, g.genre_needed, g.budget, g.filled_at,
              v.name AS venue_name, v.city, v.state, v.contact_phone AS venue_phone
       FROM gigs g JOIN venues v ON v.id = g.venue_id
       WHERE g.matched_musician_id = $1 ORDER BY g.gig_date DESC LIMIT 100`,
      [req.account.musician_id]
    );
    res.status(200).json({ invitations: invitations.rows, booked: booked.rows });
  })
);

app.post(
  '/api/me/gigs',
  requireSession,
  requireRole('venue'),
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const date = String(b.gig_date || '');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T12:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new HttpError(400, 'Please pick a date.');
    if (parsed.getTime() < Date.now() - 36 * 3600 * 1000) throw new HttpError(400, 'That date has already passed.');
    const time = b.gig_time ? String(b.gig_time) : null;
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw new HttpError(400, 'That time doesn\'t look right.');
    const genres = cleanGenres(b.genres);
    if (!genres.length) throw new HttpError(400, 'Pick at least one genre.');
    const urgency = b.urgency === 'urgent' ? 'urgent' : 'planned';
    const budget = cleanMoney(b.budget);

    const { rows: open } = await query(`SELECT COUNT(*)::int AS n FROM gigs WHERE venue_id = $1 AND status = 'open'`, [req.account.venue_id]);
    if (open[0].n >= 10) throw new HttpError(400, 'You have 10 open gigs already. Fill or cancel one before posting more.');
    if (!gigPostLimiter('v' + req.account.venue_id)) throw new HttpError(429, 'You\'re posting gigs very quickly. Please wait a bit.');

    const { rows: venueRows } = await query('SELECT * FROM venues WHERE id = $1', [req.account.venue_id]);
    const { gig, matches } = await createGigAndNotify(venueRows[0], {
      gig_date: date, gig_time: time, genre_needed: genres.join(','), budget, urgency,
    });
    res.status(201).json({ gig_id: gig.id, musicians_notified: matches.length });
  })
);

app.post(
  '/api/me/gigs/:id/cancel',
  requireSession,
  requireRole('venue'),
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `UPDATE gigs SET status = 'cancelled' WHERE id = $1 AND venue_id = $2 AND status = 'open' RETURNING id`,
      [Number(req.params.id), req.account.venue_id]
    );
    if (!rows[0]) throw new HttpError(404, 'That gig isn\'t open anymore.');
    await query(`UPDATE notifications_log SET status = 'expired' WHERE gig_id = $1 AND status = 'sent'`, [rows[0].id]);
    res.status(200).json({ ok: true });
  })
);

app.post(
  '/api/me/gigs/:id/claim',
  requireSession,
  requireRole('musician'),
  asyncRoute(async (req, res) => {
    const gigId = Number(req.params.id);
    const { rows } = await query(
      `SELECT 1 FROM notifications_log WHERE gig_id = $1 AND musician_id = $2 AND status = 'sent' LIMIT 1`,
      [gigId, req.account.musician_id]
    );
    if (!rows[0]) throw new HttpError(403, 'That gig isn\'t one of your open invitations.');
    try {
      const result = await claimGig({ gigId, musicianId: req.account.musician_id });
      res.status(200).json({
        message: 'You\'re confirmed!',
        gig: { id: gigId, gig_date: result.gig.gig_date, gig_time: result.gig.gig_time, genre_needed: result.gig.genre_needed },
        venue: result.venue,
      });
    } catch (err) {
      if (err instanceof ClaimError) {
        if (err.code === 'already_filled') throw new HttpError(409, 'Sorry, that gig was just filled by someone else.');
        if (err.code === 'not_found') throw new HttpError(404, 'Gig not found.');
      }
      throw err;
    }
  })
);

// Admin: make a one-time password reset link by hand (handy until email sending is set up).
app.post(
  '/api/admin/accounts/:id/reset-link',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const token = auth.newResetToken();
    const { rows } = await query(
      `UPDATE accounts SET reset_token_hash = $1, reset_expires = NOW() + ($2 || ' minutes')::interval WHERE id = $3 RETURNING username`,
      [auth.hashToken(token), String(auth.RESET_TTL_MINUTES), Number(req.params.id)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.status(200).json({ username: rows[0].username, link: `${baseUrl(req)}/account.html#reset=${token}`, expires_minutes: auth.RESET_TTL_MINUTES });
  })
);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  await runSchema();
  app.listen(PORT, () => {
    console.log(`Toe-Rilla API running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
