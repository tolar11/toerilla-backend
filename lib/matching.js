const db = require('../db');

/**
 * Find musicians eligible for a given gig, based on genre, location/reach,
 * and availability. This is the core Phase 1 "automatic matching" logic —
 * no AI needed yet, just structured filtering.
 */
function findMatchingMusicians(gig) {
  const allMusicians = db.prepare(`
    SELECT * FROM musicians WHERE available = 1
  `).all();

  const gigGenres = gig.genre_needed.toLowerCase().split(',').map(g => g.trim());

  const matches = allMusicians.filter((m) => {
    const musicianGenres = (m.genres || '').toLowerCase().split(',').map(g => g.trim());
    const genreMatch = gigGenres.some(g => musicianGenres.includes(g));
    if (!genreMatch) return false;

    // Reach/location filtering — simplistic same-state check for local/regional,
    // nationwide musicians are always eligible regardless of location.
    if (m.reach === 'nationwide') return true;
    if (m.reach === 'regional') return true; // regional radius handled by travel_radius_miles in a real geo system
    // local: for this MVP, match if same city (case-insensitive)
    return true; // location scoring left simple for Phase 1 — refine with real geo lookup later
  });

  // Sort by rate fit (closest to gig budget) as a simple ranking signal
  matches.sort((a, b) => {
    const aFit = a.rate_min ? Math.abs((gig.budget || 0) - a.rate_min) : 9999;
    const bFit = b.rate_min ? Math.abs((gig.budget || 0) - b.rate_min) : 9999;
    return aFit - bFit;
  });

  return matches;
}

/**
 * Calculate what a venue owes for a completed gig, based on their
 * gigs_completed count and the finalized pricing rules:
 * gig 1 = free, gig 2 = 50% off (within 30 days), gig 3+ = standard 15% commission
 * (unless subscribed to Growth/Auto-Book Premium, which waives per-gig commission).
 */
function calculatePricing(venue, gig) {
  if (venue.subscription_tier === 'growth' || venue.subscription_tier === 'auto_book_premium') {
    return { amountDue: 0, reason: 'covered by subscription' };
  }

  const commissionRate = 0.15;
  const commission = Math.round((gig.budget || 0) * commissionRate);

  if (venue.gigs_completed === 0) {
    return { amountDue: 0, reason: 'first gig free' };
  }
  if (venue.gigs_completed === 1) {
    return { amountDue: Math.round(commission * 0.5), reason: 'second gig 50% off (30-day window)' };
  }
  return { amountDue: commission, reason: 'standard 15% commission' };
}

module.exports = { findMatchingMusicians, calculatePricing };
