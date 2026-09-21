// db/index.js — Postgres connection pool + schema bootstrap.
//
// Phase 1 used node:sqlite with a synchronous DatabaseSync. Phase 2 moves to
// Postgres (via `pg`) so the app can run on a real hosted database (Railway,
// Render, Fly.io, etc.) instead of a local file. All query helpers below are
// async now — every route in server.js awaits them.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn(
    '[db] WARNING: DATABASE_URL is not set. Set it to a Postgres connection ' +
    'string, e.g. postgres://user:pass@host:5432/toerilla — see .env.example.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/Render-hosted Postgres requires SSL; local dev Postgres usually
  // doesn't. PGSSLMODE=disable in your local .env turns this off.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the whole server.
  console.error('[db] Unexpected error on idle client', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Get a dedicated client for a multi-statement transaction (BEGIN/COMMIT/
 * ROLLBACK). Plain `query()` above goes through the pool and can silently
 * hand different statements to different connections, which breaks
 * transactions — always use this instead when you need BEGIN/COMMIT.
 * Caller MUST call client.release() when done (in a finally block).
 */
async function getClient() {
  return pool.connect();
}

/** Run schema.sql on startup. Idempotent — every statement is CREATE ... IF NOT EXISTS. */
async function runSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[db] Schema applied (or already up to date).');
}

module.exports = { pool, query, getClient, runSchema };
