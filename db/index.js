const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// DB_PATH lets Railway point this at a mounted volume (e.g. /data/toerilla.db)
// so the database survives redeploys. Defaults to a local file for dev.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'toerilla.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// Run schema on startup (idempotent — CREATE TABLE IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;
