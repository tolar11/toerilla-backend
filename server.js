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
const { query, runSchema } = require('./db');
const { findMatchingMusicians, calculatePricing } = require('./lib/matching');
const { sendSMS } = require('./lib/sms');
const { claimGig, ClaimError } = require('./lib/claim');
const { hasFoundingMemberSlot, grantReferralCredits } = require('./lib/referrals');
const stripeLib = require('./lib/stripe');

const PORT = process.env.PORT || 3000;
const app = express();

// Stripe webhooks need the raw body for signature verification, so that
// route is registered BEFORE the global json() body parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded bodies
app.use(express.static(path.join(__dirname, 'public')));

// --- CORS: allow the landing page (a different origin) to call this API ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
}

// --- Sign up a venue ---
app.post(
  '/api/venues',
  asyncRoute(async (req, res) => {
    const body = req.body;
    // Founding Member status is decided server-side, not trusted from the client.
    const foundingMember = (await hasFoundingMemberSlot('venue')) && !!body.claim_founding_member;

    const { rows } = await query(
      `INSERT INTO venues (name, contact_name, contact_phone, contact_email, city, state, founding_member, referred_by, referrer_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        body.name,
        body.contact_name || null,
        body.contact_phone,
        body.contact_email || null,
        body.city,
        body.state,
        foundingMember,
        body.referred_by || null,
        body.referred_by ? body.referrer_type || 'venue' : null,
      ]
    );
    const id = rows[0].id;

    if (body.referred_by) {
      await grantReferralCredits({
        referrerType: body.referrer_type || 'venue',
        referrerId: body.referred_by,
        newUserType: 'venue',
        newUserId: id,
      }).catch((err) => console.error('[referral] failed to grant credits:', err.message));
    }

    res.status(201).json({ id, message: 'Venue created', founding_member: foundingMember });
  })
);

// --- Sign up a musician ---
app.post(
  '/api/musicians',
  asyncRoute(async (req, res) => {
    const body = req.body;
    const foundingMember = (await hasFoundingMemberSlot('musician')) && !!body.claim_founding_member;

    const { rows } = await query(
      `INSERT INTO musicians
         (name, contact_name, contact_phone, contact_email, city, state, genres, instruments, reach, rate_min, rate_max, founding_member, referred_by, referrer_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        body.name,
        body.contact_name || null,
        body.contact_phone,
        body.contact_email || null,
        body.city,
        body.state,
        body.genres || '',
        body.instruments || '',
        body.reach || 'local',
        body.rate_min || null,
        body.rate_max || null,
        foundingMember,
        body.referred_by || null,
        body.referred_by ? body.referrer_type || 'musician' : null,
      ]
    );
    const id = rows[0].id;

    if (body.referred_by) {
      await grantReferralCredits({
        referrerType: body.referrer_type || 'musician',
        referrerId: body.referred_by,
        newUserType: 'musician',
        newUserId: id,
      }).catch((err) => console.error('[referral] failed to grant credits:', err.message));
    }

    res.status(201).json({ id, message: 'Musician created', founding_member: foundingMember });
  })
);

// --- Venue posts an open gig (triggers matching + notifications) ---
app.post(
  '/api/gigs',
  asyncRoute(async (req, res) => {
    const body = req.body;
    const { rows: venueRows } = await query('SELECT * FROM venues WHERE id = $1', [body.venue_id]);
    const venue = venueRows[0];
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const { rows } = await query(
      `INSERT INTO gigs (venue_id, gig_date, gig_time, genre_needed, budget, urgency)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [body.venue_id, body.gig_date, body.gig_time || null, body.genre_needed, body.budget || null, body.urgency || 'planned']
    );
    const gig = rows[0];

    const matches = await findMatchingMusicians(gig, venue);

    for (const m of matches) {
      const msg = `Toe-Rilla: New ${gig.urgency} gig — ${gig.genre_needed} needed on ${gig.gig_date}${
        gig.gig_time ? ' at ' + gig.gig_time : ''
      } for ${venue.name} (${venue.city}, ${venue.state}). Budget: $${gig.budget || 'TBD'}. Reply YES to claim.`;

      const smsResult = await sendSMS(m.contact_phone, msg);
      await query(
        `INSERT INTO notifications_log (gig_id, musician_id, message, channel, twilio_sid)
         VALUES ($1,$2,$3,$4,$5)`,
        [gig.id, m.id, msg, smsResult.channel, smsResult.sid]
      );
    }

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
  asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT * FROM gigs ORDER BY created_at DESC');
    res.status(200).json(rows);
  })
);
app.get(
  '/api/venues',
  asyncRoute(async (_req, res) => {
    const { rows } = await query('SELECT * FROM venues ORDER BY created_at DESC');
    res.status(200).json(rows);
  })
);
app.get(
  '/api/musicians',
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
    res.status(200).json({ counts: counts[0], gigs });
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
