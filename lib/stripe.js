// lib/stripe.js — Stripe wrapper for commission payments + subscriptions.
//
// If STRIPE_SECRET_KEY isn't set, every function here returns a clearly
// fake/placeholder response instead of throwing, so the rest of the app
// (and your testing) isn't blocked on having a Stripe account yet.

const hasStripeCreds = !!process.env.STRIPE_SECRET_KEY;

let stripe = null;
if (hasStripeCreds) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn(
    '[stripe] STRIPE_SECRET_KEY not set — payment/subscription links will be ' +
    'fake placeholder URLs. Set STRIPE_SECRET_KEY (and the STRIPE_PRICE_* ' +
    'vars) to go live.'
  );
}

/**
 * Create a one-time Checkout Session for a gig's commission.
 * Used because the commission amount is dynamic (depends on the pricing
 * rules), so a static pre-made Payment Link won't work — a Checkout Session
 * with `price_data` lets us charge an arbitrary computed amount.
 */
async function createCommissionCheckout({ venue, gig, amountDueCents, successUrl, cancelUrl }) {
  if (!hasStripeCreds) {
    return {
      id: 'fake_session_no_stripe_key',
      url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/admin.html#fake-checkout-gig-${gig.id}`,
    };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: venue.contact_email || undefined,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: amountDueCents,
          product_data: {
            name: `Toe-Rilla commission — gig #${gig.id} (${gig.gig_date})`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: { gig_id: String(gig.id), venue_id: String(venue.id) },
    success_url: successUrl || `${process.env.APP_BASE_URL}/admin.html?paid=1`,
    cancel_url: cancelUrl || `${process.env.APP_BASE_URL}/admin.html?paid=0`,
  });

  return { id: session.id, url: session.url };
}

const SUBSCRIPTION_PRICE_ENV = {
  growth: 'STRIPE_PRICE_GROWTH',
  auto_book_premium: 'STRIPE_PRICE_AUTO_BOOK_PREMIUM',
};

/**
 * Create a subscription Checkout Session for Growth ($99/mo) or
 * Auto-Book Premium ($149/mo). Requires the corresponding Stripe Price ID
 * to be set as an env var (create these once in the Stripe Dashboard).
 */
async function createSubscriptionCheckout({ venue, tier, successUrl, cancelUrl }) {
  if (!['growth', 'auto_book_premium'].includes(tier)) {
    throw new Error(`Unknown subscription tier: ${tier}`);
  }

  if (!hasStripeCreds) {
    return {
      id: 'fake_session_no_stripe_key',
      url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/admin.html#fake-subscribe-${tier}`,
    };
  }

  const priceId = process.env[SUBSCRIPTION_PRICE_ENV[tier]];
  if (!priceId) {
    throw new Error(
      `${SUBSCRIPTION_PRICE_ENV[tier]} is not set — create a recurring Price in the ` +
      `Stripe Dashboard for the ${tier} plan and set its Price ID as that env var.`
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: venue.contact_email || undefined,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { venue_id: String(venue.id), tier },
    success_url: successUrl || `${process.env.APP_BASE_URL}/admin.html?sub=1`,
    cancel_url: cancelUrl || `${process.env.APP_BASE_URL}/admin.html?sub=0`,
  });

  return { id: session.id, url: session.url };
}

/** Verify + construct a webhook event from the raw request body. */
function constructWebhookEvent(rawBody, signature) {
  if (!hasStripeCreds) throw new Error('Stripe is not configured');
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  }
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  hasStripeCreds,
  createCommissionCheckout,
  createSubscriptionCheckout,
  constructWebhookEvent,
};
