# Toe-Rilla Gig Network — Project Brief for Claude Code

## What this is
A live-music booking platform connecting venues (bars/restaurants) with musicians —
both urgent same-day fill-ins and normal advance bookings. Nationwide platform,
initial operational/marketing focus on the Western Panhandle of Florida
(Destin, 30A, Fort Walton Beach, Pensacola).

Brand name: **Toe-Rilla Gig Network**. Mascot: a laid-back gorilla in a Hawaiian
shirt playing guitar at a sunset tiki bar. Brand voice: cool, casual, laid-back —
never corporate.

## What already exists (attached/provided separately)
1. **Landing page** (`index.html`) — live on Netlify, connected to a GoDaddy domain.
   Sign-up form currently POSTs to Formspree. Has sections for: hero, how-it-works,
   musician reach settings (local/regional/nationwide), musician-to-musician band
   fill-in matching, Concierge AI preview (marked "Coming Soon"), a 3-tier pricing
   table, and a sign-up form with Founding Member + referral incentive callouts.
2. **Phase 1 backend prototype** (`toerilla-backend/` folder) — a tested, working
   Node.js API using only built-in modules (`node:http`, `node:sqlite`, no
   external packages yet). Implements: venue/musician sign-up, gig posting,
   automatic matching by genre, first-to-claim booking, and the pricing logic
   below. Read its README.md for endpoint details.

## Your job (Phase 2 build)
Take the Phase 1 prototype and turn it into a real, deployed product:

1. **Add a real database** — migrate from SQLite to Postgres (or keep SQLite if
   deploying somewhere that supports persistent file storage — your call based
   on the hosting target).
2. **Connect the landing page's sign-up form** to these backend endpoints instead
   of Formspree, so sign-ups become real venue/musician records.
3. **Add real SMS delivery via Twilio** — replace the current `notifications_log`
   table (which just logs what *would* be sent) with actual outbound texts when
   a gig is posted, and inbound reply handling so a musician can text "YES" to
   claim a gig.
4. **Add Stripe integration**:
   - One-time payment links for the commission logic (see pricing rules below)
   - Stripe Billing for the two recurring subscription tiers (Growth $99/mo,
     Auto-Book Premium $149/mo)
5. **Build a minimal admin/dashboard view** — even a simple internal page to see
   open gigs, matches, and payment status (Glenn will be manually monitoring
   this during early pilot).
6. **Deploy it** somewhere permanent — Railway, Render, or Fly.io are all
   reasonable, low-cost choices for a Node app with a database.

## Business rules (must match exactly)

### Pricing
- Musicians: **always free** for venue bookings. No commission, ever.
- Venues, pay-per-fill: **15% commission** per booking.
- Venue's **first gig is free** (no charge, no commission).
- Venue's **second gig is 50% off** the standard commission, **only if booked
  within 30 days** of their first gig. After 30 days, standard rate applies.
- Venue's **third gig onward**: standard 15% commission, UNLESS subscribed.
- **Growth Subscription ($99/month)**: unlimited fills, no per-gig commission,
  plus Concierge Marketing, priority placement in musician search, standby
  bench access, basic analytics.
- **Auto-Book Premium ($149/month, standalone plan — not stacked on Growth)**:
  everything in Growth plus hands-free AI booking, vibe matching, priority
  dispute mediation, compliance assistant, unlimited Concierge Marketing posts.
- **Founding Member status**: first 100 venues/musicians to sign up get
  locked-in pricing + a permanent profile badge. Free to grant, no extra logic
  beyond a boolean flag and a counter.
- **Referral bonus**: a referring user and the referred user each get one extra
  free fill (venues) or one free month of Growth (either side) once the
  referral completes a sign-up. Needs a `referred_by` field (already in schema)
  and a fulfillment mechanism (credit tracking).

### Musician-side monetization
- Musicians never pay for venue bookings.
- Optional paid **Musician Add-Ons** (separate from venue pricing):
  - Gig Reminders Pro: $5–9/month
  - Musician Marketing: $9–15/month or $3–5/gig
  - Outreach Boost (raises monthly cap on proactive profile sends to venues): $9–12/month
  - **Band Fill-In Matching (musician-to-musician)**: only included in the
    **Musician Pro Bundle ($19–25/month)** — this is gated behind the paid
    bundle, not available free. A musician can still find/accept venue gigs at
    no cost without subscribing; the paid tier is only required to post or
    respond to another musician's open-role listing (e.g. "need a bassist").

### Matching logic
- Two booking speeds: **urgent** (same-day/last-minute, first-to-claim wins)
  and **planned** (booked weeks/months out via calendar).
- Matching filters on: genre/instrument overlap, musician's reach setting
  (local/regional/nationwide — nationwide musicians are eligible for any gig
  regardless of location; local/regional should eventually use real geo/radius
  matching — the Phase 1 prototype simplifies this, tighten it in Phase 2).
- First musician to claim/confirm locks in the gig; all other notified
  musicians should get an automatic "sorry, filled" follow-up.

### Musician-to-Musician matching (band fill-ins)
- Separate from venue bookings — a musician posts an open role in their own
  band (e.g., "need a drummer for Saturday" or a standing permanent spot).
- Uses the same underlying matching/notification mechanism as venue gigs, but
  matches on instrument instead of venue-side genre needs.
- Gated behind Musician Pro Bundle (see pricing above).

### Concierge AI (build after the above core loop is solid — do not start here)
- An AI assistant (built on the Claude API) that proactively watches the
  calendar and reaches out before a gap becomes a problem — to venues with
  open dates, and to musicians with empty calendars.
- Voice: cool, laid-back, gorilla-flavored — casual, never corporate. Example:
  "Yo — noticed your Friday's still wide open. Got a couple solid acoustic acts
  free that night if you want me to line one up. Just say the word."
- Concierge Marketing: once a gig is booked, auto-generates a short multi-post
  promotional sequence (announcement, countdown, day-of reminder) instead of
  one static gig card, using the Claude API. Bundled into Growth subscription.
- Concierge Auto-Book (Auto-Book Premium only): venue sets criteria once
  (budget ceiling, approved genres, minimum rating, blackout dates); Concierge
  auto-selects and confirms a matching musician without manual approval, with
  guardrails — hard budget/genre caps, a short undo window, and an activity
  log of what was booked and why.
- This is a distinct, later build step — it requires calling the Anthropic API
  from a scheduled job/backend trigger, not something that runs automatically
  just because Claude is used elsewhere in the stack.

### Anti-circumvention measures (build into the messaging/contact system)
- Keep all contact info (phone numbers, emails, social handles) out of
  in-app messages and profiles until a gig is actually confirmed — filter
  attempts to share this early.
- Once a gig is confirmed, both sides' real contact info is exchanged (see the
  Phase 1 `/claim` endpoint, which already does this).

## Roadmap features (build later, after Concierge's core loop works — lower priority)
Vibe matching (match by venue atmosphere, not just genre), standby bench
(ranked list of a venue's best past musicians, tried first), weather/local-event
awareness, AI dispute mediator, auto-generated gig agreements/invoices,
fraud/trust scoring, post-gig "vibe check" follow-up (feeds matching data back
in), musician career coaching, voice-based onboarding, AI ops analyst
(monitors fill rate/churn/conversion), compliance assistant (noise ordinances,
ASCAP/BMI licensing questions).

## Do NOT build yet
- Native mobile app (web-first for now)
- Full geo-radius matching precision (simple city/state matching is fine for now)
- Any of the Roadmap features above before the core Concierge loop works

## Immediate first task for you (Claude Code)
1. Review the attached `toerilla-backend/` prototype and landing page.
2. Propose a hosting/database choice (Railway+Postgres is a reasonable default).
3. Wire the landing page form to the real backend.
4. Add Twilio SMS for the notify/claim flow.
5. Confirm the pricing logic matches the rules above exactly before moving to Stripe.
