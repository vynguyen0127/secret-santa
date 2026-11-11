// Database connection. Uses Turso (hosted SQLite) when TURSO_DATABASE_URL is set,
// otherwise a local file (santa.db) so you can develop offline.
const { createClient } = require('@libsql/client');
const path = require('node:path');

// Load settings from a .env file if one exists (Node 22+ built-in).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:' + path.join(__dirname, 'santa.db') }
);

// Create tables if they don't exist yet. Safe to run every startup.
async function init() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS participants (
       id           INTEGER PRIMARY KEY,
       name         TEXT NOT NULL,
       phone        TEXT NOT NULL UNIQUE,          -- digits only, e.g. 5551234567
       recipient_id INTEGER REFERENCES participants(id),
       wishlist     TEXT NOT NULL DEFAULT ''        -- old free-text wishlist, no longer used
     )`,
    `CREATE TABLE IF NOT EXISTS sessions (
       token          TEXT PRIMARY KEY,
       participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
       created_at     INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS wishlist_items (
       id             INTEGER PRIMARY KEY,
       participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
       name           TEXT NOT NULL,
       urls           TEXT NOT NULL DEFAULT '[]',   -- JSON array of links
       notes          TEXT NOT NULL DEFAULT '',
       created_at     INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS wishlist_items_owner ON wishlist_items(participant_id)`,
    // Simple key/value settings, e.g. revealed = '1' once recipients should be shown.
    `CREATE TABLE IF NOT EXISTS settings (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  ], 'write');

  // Add columns that were introduced after the table was first created.
  const { rows: cols } = await db.execute('PRAGMA table_info(wishlist_items)');
  if (!cols.some((c) => c.name === 'notes')) {
    await db.execute("ALTER TABLE wishlist_items ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
}

// Run a query and return the first row (or null).
async function one(sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows[0] ?? null;
}

// Run a query and return all rows.
async function all(sql, args = []) {
  const { rows } = await db.execute({ sql, args });
  return rows;
}

async function getSetting(key) {
  const row = await one('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.execute({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, String(value)],
  });
}

// Keep only digits; drop a leading US country code so "+1 (555) 123-4567" == "5551234567".
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

module.exports = { db, init, one, all, getSetting, setSetting, normalizePhone };
