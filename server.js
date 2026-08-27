try { require('dotenv').config(); } catch (e) { /* dotenv is optional outside dev */ }

const http = require('node:http');
const { URL } = require('node:url');
const db = require('./db');
const { findMatchingMusicians, calculatePricing, claimGig } = require('./lib/matching');
const { sendSMS, normalizePhone, validateTwilioRequest } = require('./lib/sms');

const PORT = process.env.PORT || 3000;

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function sendTwiML(res, message) {
  const escaped = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/x-www-form-urlencoded')) {
          resolve(Object.fromEntries(new URLSearchParams(body)));
        } else {
          resolve(body ? JSON.parse(body) : {});
        }
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    // --- Sign up a venue ---
    if (pathname === '/api/venues' && req.method === 'POST') {
      const body = await readBody(req);
      const stmt = db.prepare(`
        INSERT INTO venues (name, contact_phone, contact_email, city, state, founding_member)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(body.name, body.contact_phone, body.contact_email || null, body.city, body.state, body.founding_member ? 1 : 0);
      return sendJSON(res, 201, { id: Number(result.lastInsertRowid), message: 'Venue created' });
    }

    // --- Sign up a musician ---
    if (pathname === '/api/musicians' && req.method === 'POST') {
      const body = await readBody(req);
      const stmt = db.prepare(`
        INSERT INTO musicians (name, contact_phone, contact_email, city, state, genres, instruments, reach, rate_min, rate_max, founding_member)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        body.name, body.contact_phone, body.contact_email || null, body.city, body.state,
        body.genres || '', body.instruments || '', body.reach || 'local',
        body.rate_min || null, body.rate_max || null, body.founding_member ? 1 : 0
      );
      return sendJSON(res, 201, { id: Number(result.lastInsertRowid), message: 'Musician created' });
    }

    // --- Venue posts an open gig (this triggers matching) ---
    if (pathname === '/api/gigs' && req.method === 'POST') {
      const body = await readBody(req);
      const stmt = db.prepare(`
        INSERT INTO gigs (venue_id, gig_date, gig_time, genre_needed, budget, urgency)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        body.venue_id, body.gig_date, body.gig_time || null,
        body.genre_needed, body.budget || null, body.urgency || 'planned'
      );
      const gigId = Number(result.lastInsertRowid);
      const gig = db.prepare('SELECT * FROM gigs WHERE id = ?').get(gigId);

      // Run the matching engine immediately
      const matches = findMatchingMusicians(gig);

      // Log notifications and fire the actual SMS via Twilio
      const logStmt = db.prepare(`
        INSERT INTO notifications_log (gig_id, musician_id, message) VALUES (?, ?, ?)
      `);
      for (const m of matches) {
        const msg = `Toe-Rilla: New ${gig.urgency} gig — ${gig.genre_needed} needed on ${gig.gig_date}. Budget: $${gig.budget || 'TBD'}. Reply YES to claim.`;
        logStmt.run(gigId, m.id, msg);
        await sendSMS(m.contact_phone, msg);
      }

      return sendJSON(res, 201, {
        gig,
        matched_musicians_notified: matches.length,
        matches: matches.map(m => ({ id: m.id, name: m.name, genres: m.genres }))
      });
    }

    // --- Musician claims a gig (first to claim wins) ---
    if (pathname.match(/^\/api\/gigs\/\d+\/claim$/) && req.method === 'POST') {
      const gigId = Number(pathname.split('/')[3]);
      const body = await readBody(req);
      const result = claimGig(gigId, body.musician_id);

      if (result.error === 'not_found') return sendJSON(res, 404, { error: 'Gig not found' });
      if (result.error === 'already_filled') {
        return sendJSON(res, 409, { error: 'This gig has already been filled', filled_by: result.gig.matched_musician_id });
      }

      const { venue, musician, pricing } = result;
      await sendSMS(venue.contact_phone, `Toe-Rilla: Your gig on ${result.gig.gig_date} has been filled by ${musician.name}!`);

      return sendJSON(res, 200, {
        message: 'Gig confirmed!',
        gig_id: gigId,
        venue: { name: venue.name, contact_phone: venue.contact_phone },
        musician: { name: musician.name, contact_phone: musician.contact_phone },
        pricing
      });
    }

    // --- Twilio inbound SMS webhook: musicians reply "YES" to claim ---
    if (pathname === '/api/sms/inbound' && req.method === 'POST') {
      const params = await readBody(req);
      const signature = req.headers['x-twilio-signature'];
      const fullUrl = `${process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`}${pathname}`;

      if (!validateTwilioRequest(signature, fullUrl, params)) {
        return sendJSON(res, 403, { error: 'Invalid Twilio signature' });
      }

      const from = params.From || '';
      const text = (params.Body || '').trim().toLowerCase();
      const digits = normalizePhone(from);

      const musician = db.prepare('SELECT * FROM musicians').all()
        .find(m => normalizePhone(m.contact_phone) === digits);

      if (!musician) {
        return sendTwiML(res, "We couldn't find a Toe-Rilla profile for this number.");
      }
      if (text !== 'yes') {
        return sendTwiML(res, 'Reply YES to claim your most recent gig notification.');
      }

      const pending = db.prepare(`
        SELECT n.gig_id FROM notifications_log n
        JOIN gigs g ON g.id = n.gig_id
        WHERE n.musician_id = ? AND g.status = 'open'
        ORDER BY n.sent_at DESC LIMIT 1
      `).get(musician.id);

      if (!pending) {
        return sendTwiML(res, 'No open gig to claim right now — it may already be filled.');
      }

      const result = claimGig(pending.gig_id, musician.id);
      if (result.error === 'already_filled') {
        return sendTwiML(res, 'Sorry, that gig was just claimed by someone else.');
      }

      const { gig, venue } = result;
      await sendSMS(venue.contact_phone, `Toe-Rilla: Your gig on ${gig.gig_date} has been filled by ${musician.name}!`);
      return sendTwiML(res, `You're confirmed for the ${gig.genre_needed} gig on ${gig.gig_date} at ${venue.name}!`);
    }

    // --- List open gigs (for testing / dashboard) ---
    if (pathname === '/api/gigs' && req.method === 'GET') {
      const gigs = db.prepare('SELECT * FROM gigs ORDER BY created_at DESC').all();
      return sendJSON(res, 200, gigs);
    }

    // --- List venues / musicians (for testing) ---
    if (pathname === '/api/venues' && req.method === 'GET') {
      return sendJSON(res, 200, db.prepare('SELECT * FROM venues').all());
    }
    if (pathname === '/api/musicians' && req.method === 'GET') {
      return sendJSON(res, 200, db.prepare('SELECT * FROM musicians').all());
    }

    // --- Health check ---
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { status: 'ok', service: 'Toe-Rilla Gig Network API' });
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Toe-Rilla API running on http://localhost:${PORT}`);
});
