// lib/referrals.js — Founding Member eligibility + referral credit fulfillment.
//
// Founding Member: "first 100 venues/musicians to sign up" — interpreted here
// as the first 100 of EACH type (100 venue slots + 100 musician slots),
// since that's more generous and unambiguous than splitting one pool of 100
// across both types. Flag this interpretation to Glenn before launch if a
// single combined pool of 100 was intended instead.
const FOUNDING_MEMBER_LIMIT = 100;

const { query, getClient } = require('../db');

/** Is there still a Founding Member slot open for this user type? */
async function hasFoundingMemberSlot(userType) {
  const table = userType === 'venue' ? 'venues' : 'musicians';
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE founding_member = TRUE`
  );
  return rows[0].n < FOUNDING_MEMBER_LIMIT;
}

/**
 * Grant referral credits to both sides of a completed referral, once the
 * referred user successfully signs up. Runs as a single transaction on one
 * dedicated client so the ledger insert and the balance update never drift
 * apart, and a failure on one side rolls back the other.
 *
 * Reward (per PROJECT_BRIEF): "a referring user and the referred user each
 * get one extra free fill (venues) or one free month of Growth (either
 * side)". Read literally this is a little ambiguous about which reward
 * applies to which pairing, so this implementation uses the simplest
 * consistent rule — confirm with Glenn before relying on it:
 *   - Venue referrer     -> free_fill credit (their next commission is waived)
 *   - Musician referrer  -> free_pro_bundle_month credit (their equivalent paid tier)
 * The referred (new) user gets the same credit type as their own account
 * type, mirroring the referrer's reward shape.
 */
async function grantReferralCredits({ referrerType, referrerId, newUserType, newUserId }) {
  const creditFor = (userType) => (userType === 'venue' ? 'free_fill' : 'free_pro_bundle_month');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const credit = async (userType, userId) => {
      await client.query(
        `INSERT INTO referral_credits (user_type, user_id, credit_type, amount) VALUES ($1, $2, $3, 1)`,
        [userType, userId, creditFor(userType)]
      );
      if (userType === 'venue') {
        await client.query(`UPDATE venues SET free_fill_credits = free_fill_credits + 1 WHERE id = $1`, [userId]);
      } else {
        await client.query(
          `UPDATE musicians SET free_pro_bundle_month_credits = free_pro_bundle_month_credits + 1 WHERE id = $1`,
          [userId]
        );
      }
    };

    await credit(referrerType, referrerId);
    await credit(newUserType, newUserId);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { FOUNDING_MEMBER_LIMIT, hasFoundingMemberSlot, grantReferralCredits };
