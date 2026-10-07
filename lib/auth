// lib/auth.js — account security helpers. No third-party packages: everything
// here uses Node's built-in `crypto`.
//
//   - Passwords are stored as a salted scrypt hash, never in plain text.
//   - A login is remembered with a signed session cookie (HttpOnly, so page
//     scripts can't read it). Changing a password signs that account out
//     everywhere, because the cookie carries a fingerprint of the old hash.
//   - Reset tokens are random, emailed once, and only their sha256 is stored.
//   - sendEmail() uses Resend (https://resend.com) when RESEND_API_KEY is set,
//     and otherwise just logs the message so nothing breaks without it.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE_NAME = 'tr_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const RESET_TTL_MINUTES = 60;

// ---------- passwords ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// A real hash of a throwaway value, so "no such user" takes as long as "wrong password".
let dummyHashPromise = null;
function dummyVerify(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-' + crypto.randomBytes(8).toString('hex'));
  return dummyHashPromise.then((h) => verifyPassword(password, h));
}

// ---------- input checks (return an error message, or null when fine) ----------

function checkEmail(email) {
  const e = String(email || '').trim();
  if (e.length < 5 || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Please enter a valid email address.';
  return null;
}
function checkUsername(username) {
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(String(username || ''))) {
    return 'Usernames are 3-30 characters: letters, numbers, dots, dashes or underscores.';
  }
  return null;
}
function checkPassword(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Your password needs at least 8 characters.';
  if (p.length > 200) return 'That password is too long (200 characters max).';
  return null;
}

// ---------- sessions ----------

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // No extra setup needed: derive a secret from ADMIN_TOKEN, which is already private.
  if (process.env.ADMIN_TOKEN) {
    return crypto.createHmac('sha256', 'toerilla-session-v1').update(process.env.ADMIN_TOKEN).digest('hex');
  }
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Short fingerprint of the stored password hash: changes whenever the password does. */
function passwordVersion(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 12);
}

function signSession({ accountId, passwordHash, secret, ttlSeconds = SESSION_TTL_SECONDS, now = Date.now() }) {
  const payload = b64url(JSON.stringify({ a: accountId, pv: passwordVersion(passwordHash), exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return payload + '.' + sig;
}

/** Returns { accountId, pv } for a valid, unexpired, untampered token, otherwise null. */
function readSession(token, secret, now = Date.now()) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    const given = fromB64url(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(fromB64url(payload).toString('utf8'));
    if (!data || typeof data.a !== 'number' || data.exp * 1000 < now) return null;
    return { accountId: data.a, pv: data.pv };
  } catch (_) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) {
        try {
          out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        } catch (_) {
          /* ignore a malformed cookie value */
        }
      }
    });
  return out;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---------- reset tokens ----------

function newResetToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ---------- tiny in-memory rate limiter (per server process) ----------

function makeLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return true;
  };
}

// ---------- email ----------

async function sendEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Toe-Rilla Gig Network <onboarding@resend.dev>';
  if (!key) {
    console.log(`[email:log-only] to=${to} subject="${subject}"\n${text}`);
    return { sent: false, reason: 'RESEND_API_KEY not set' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      console.error('[email] Resend rejected the message:', res.status, await res.text().catch(() => ''));
      return { sent: false, reason: 'provider error ' + res.status };
    }
    return { sent: true };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  COOKIE_NAME,
  RESET_TTL_MINUTES,
  hashPassword,
  verifyPassword,
  dummyVerify,
  checkEmail,
  checkUsername,
  checkPassword,
  sessionSecret,
  signSession,
  readSession,
  passwordVersion,
  parseCookies,
  sessionCookie,
  clearCookie,
  newResetToken,
  hashToken,
  makeLimiter,
  sendEmail,
};
