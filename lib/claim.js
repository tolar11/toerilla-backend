// lib/claim.js — shared "musician claims a gig" logic.
//
// Used by both the HTTP POST /api/gigs/:id/claim endpoint and the inbound
// Twilio SMS webhook (a musician texting "YES"), so the two paths can never
// drift apart or double-book a gig.
//
// Runs as a single transaction with `SELECT ... FOR UPDATE` on the gig row,
// so two simultaneous claims (e.g. two musicians replying "YES" within the
// same second) can't both win — the second one to reach the lock sees the
// already-updated status and is rejected. This is the "first-to-claim wins"
// rule from PROJECT_BRIEF, made race-safe.

const { getClient } = require('../db');
const { calculatePricing } = require('./matching');
const { createCommissionCheckout } = require('./stripe');
const { sendSMS } = require('./sms');

class ClaimError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code; // 'not_found' | 'already_filled'
    this.extra = extra;
  }
}

async function claimGig({ gigId, musicianId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { rows: gigRows } = await client.query(
      `SELECT * FROM gigs WHERE id = $1 FOR UPDATE`,
      [gigId]
    );
    const gig = gigRows[0];
    if (!gig) {
      await client.query('ROLLBACK');
      throw new ClaimError('not_found', 'Gig not found');
    }
    if (gig.status !== 'open') {
      await client.query('ROLLBACK');
      throw new ClaimError('already_filled', 'This gig has already been filled', {
        filled_by: gig.matched_musician_id,
      });
    }

    await client.query(
      `UPDATE gigs SET status = 'filled', matched_musician_id = $1, filled_at = NOW() WHERE id = $2`,
      [musicianId, gigId]
    );

    const { rows: venueRows } = await client.query(`SELECT * FROM venues WHERE id = $1 FOR UPDATE`, [
      gig.venue_id,
    ]);
    const venue = venueRows[0];
    const { rows: musicianRows } = await client.query(`SELECT * FROM musicians WHERE id = $1`, [
      musicianId,
    ]);
    const musician = musicianRows[0];

    const pricing = await calculatePricing(venue, gig);

    if (pricing.usedFreeFillCredit) {
      await client.query(
        `UPDATE venues SET free_fill_credits = free_fill_credits - 1 WHERE id = $1`,
        [venue.id]
      );
    }
    await client.query(`UPDATE venues SET gigs_completed = gigs_completed + 1 WHERE id = $1`, [venue.id]);

    let paymentStatus = 'n/a';
    let checkoutUrl = null;
    if (pricing.amountDueCents > 0) {
      paymentStatus = 'pending';
      const checkout = await createCommissionCheckout({
        venue,
        gig,
        amountDueCents: pricing.amountDueCents,
      });
      checkoutUrl = checkout.url;
      await client.query(
        `UPDATE gigs SET payment_status = $1, amount_due_cents = $2, pricing_reason = $3,
                stripe_checkout_session_id = $4, stripe_checkout_url = $5
         WHERE id = $6`,
        [paymentStatus, pricing.amountDueCents, pricing.reason, checkout.id, checkoutUrl, gigId]
      );
    } else {
      paymentStatus = 'free';
      await client.query(
        `UPDATE gigs SET payment_status = $1, amount_due_cents = $2, pricing_reason = $3 WHERE id = $4`,
        [paymentStatus, 0, pricing.reason, gigId]
      );
    }

    // Mark this musician's notification for this gig as claimed.
    await client.query(
      `UPDATE notifications_log SET status = 'claimed'
       WHERE gig_id = $1 AND musician_id = $2 AND status = 'sent'`,
      [gigId, musicianId]
    );

    // Everyone else who was notified about this gig gets a "sorry, filled" follow-up.
    const { rows: otherNotified } = await client.query(
      `SELECT DISTINCT musician_id FROM notifications_log
       WHERE gig_id = $1 AND musician_id != $2 AND status = 'sent'`,
      [gigId, musicianId]
    );
    await client.query(
      `UPDATE notifications_log SET status = 'expired' WHERE gig_id = $1 AND musician_id != $2 AND status = 'sent'`,
      [gigId, musicianId]
    );

    await client.query('COMMIT');

    // Fire the "sorry, filled" SMS follow-ups after commit (best-effort, not
    // part of the DB transaction — a delivery failure shouldn't roll back a
    // confirmed booking).
    for (const row of otherNotified) {
      const { rows } = await client.query(`SELECT * FROM musicians WHERE id = $1`, [row.musician_id]);
      const other = rows[0];
      if (other) {
        sendSMS(
          other.contact_phone,
          `Toe-Rilla: Sorry — the ${gig.genre_needed} gig on ${gig.gig_date} was just filled by another musician. We'll keep matching you to new gigs!`
        ).catch(() => {});
      }
    }

    return {
      gig: { ...gig, status: 'filled', matched_musician_id: musicianId },
      venue: { name: venue.name, contact_phone: venue.contact_phone },
      musician: { name: musician.name, contact_phone: musician.contact_phone },
      pricing: { ...pricing, checkoutUrl },
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* already rolled back */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { claimGig, ClaimError };
