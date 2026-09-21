// lib/matching.js — matching engine + pricing logic.
//
// Ported from the Phase 1 prototype's lib/matching.js, now async (Postgres)
// and with two Phase 2 tightenings called out explicitly below. Everything
// else preserves the Phase 1 behavior/wording exactly.

const { query } = require('../db');

/**
 * Find musicians eligible for a given gig, based on genre, location/reach,
 * and availability.
 *
 * Phase 2 change #1 (per PROJECT_BRIEF: "tighten [reach matching] in Phase 2"):
 * the Phase 1 prototype matched every reach tier unconditionally (a bug — its
 * own comment said "match if same city" but the code just `return true`).
 * This version actually applies simple city/state matching:
 *   - nationwide: eligible for any gig regardless of location (unchanged)
 *   - regional:   eligible if same state as the venue
 *   - local:      eligible if same city AND state as the venue
 * This is still not real geo-radius matching (explicitly out of scope per
 * "Do NOT build yet" — simple city/state matching is fine for now).
 *
 * @param {object} gig - the gig row (must include genre_needed, budget)
 * @param {object} venue - the venue row the gig belongs to (city, state)
 */
async function findMatchingMusicians(gig, venue) {
  const { rows: allMusicians } = await query(
    `SELECT * FROM musicians WHERE available = TRUE`
  );

  const gigGenres = gig.genre_needed.toLowerCase().split(',').map((g) => g.trim());

  const matches = allMusicians.filter((m) => {
    const musicianGenres = (m.genres || '').toLowerCase().split(',').map((g) => g.trim());
    const genreMatch = gigGenres.some((g) => musicianGenres.includes(g));
    if (!genreMatch) return false;

    if (m.reach === 'nationwide') return true;

    if (m.reach === 'regional') {
      return (m.state || '').toLowerCase() === (venue.state || '').toLowerCase();
    }

    // local
    return (
      (m.city || '').toLowerCase() === (venue.city || '').toLowerCase() &&
      (m.state || '').toLowerCase() === (venue.state || '').toLowerCase()
    );
  });

  // Sort by rate fit (closest to gig budget) as a simple ranking signal — unchanged from Phase 1.
  matches.sort((a, b) => {
    const aFit = a.rate_min ? Math.abs((gig.budget || 0) - a.rate_min) : 9999;
    const bFit = b.rate_min ? Math.abs((gig.budget || 0) - b.rate_min) : 9999;
    return aFit - bFit;
  });

  return matches;
}

/**
 * Calculate what a venue owes for a completed gig.
 *
 * Pricing rules (from PROJECT_BRIEF — must match exactly):
 *   - Growth / Auto-Book Premium subscribers: $0, no per-gig commission ever.
 *   - A referral "free fill" credit, if the venue has one banked: $0, credit consumed.
 *   - First gig: free.
 *   - Second gig: 50% off standard commission, but ONLY if booked (claimed)
 *     within 30 days of the first gig's fill date. After 30 days, standard
 *     15% applies instead.
 *
 * Phase 2 change #2: the Phase 1 prototype checked `gigs_completed === 1`
 * for the second-gig discount but never actually checked the 30-day window
 * (there was no date comparison at all). This version adds that check.
 *
 *   - Third gig onward: standard 15% commission (unless covered above).
 *
 * @param {object} venue
 * @param {object} gig - the gig being claimed (must include budget)
 * @returns {Promise<{amountDueCents: number, reason: string, usedFreeFillCredit: boolean}>}
 */
async function calculatePricing(venue, gig) {
  const commissionCents = Math.round((gig.budget || 0) * 0.15 * 100);

  if (venue.subscription_tier === 'growth' || venue.subscription_tier === 'auto_book_premium') {
    return { amountDueCents: 0, reason: 'covered by subscription', usedFreeFillCredit: false };
  }

  if (venue.free_fill_credits > 0) {
    return {
      amountDueCents: 0,
      reason: 'covered by referral free-fill credit',
      usedFreeFillCredit: true,
    };
  }

  if (venue.gigs_completed === 0) {
    return { amountDueCents: 0, reason: 'first gig free', usedFreeFillCredit: false };
  }

  if (venue.gigs_completed === 1) {
    const { rows } = await query(
      `SELECT filled_at FROM gigs
       WHERE venue_id = $1 AND status = 'filled' AND filled_at IS NOT NULL
       ORDER BY filled_at ASC LIMIT 1`,
      [venue.id]
    );
    const firstGigFilledAt = rows[0] ? new Date(rows[0].filled_at) : null;
    const daysSinceFirstGig = firstGigFilledAt
      ? (Date.now() - firstGigFilledAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    if (daysSinceFirstGig <= 30) {
      return {
        amountDueCents: Math.round(commissionCents * 0.5),
        reason: 'second gig 50% off (within 30-day window)',
        usedFreeFillCredit: false,
      };
    }
    return {
      amountDueCents: commissionCents,
      reason: 'second gig — 30-day discount window has passed, standard rate applies',
      usedFreeFillCredit: false,
    };
  }

  return { amountDueCents: commissionCents, reason: 'standard 15% commission', usedFreeFillCredit: false };
}

module.exports = { findMatchingMusicians, calculatePricing };
