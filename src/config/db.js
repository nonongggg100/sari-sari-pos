const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Return NUMERIC columns (money, quantities stored as NUMERIC) as JS numbers
// instead of node-postgres's default string representation.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const connectionString =
  process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;

if (!connectionString) {
  throw new Error(
    'No Postgres connection string found. Set POSTGRES_URL (or DATABASE_URL) in your environment — ' +
      'e.g. via `vercel env pull` for a Vercel Postgres database, or a local Postgres instance for development.'
  );
}

const pool = new Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
});

let schemaReady = null;

// If ADMIN_PASSWORD is set (e.g. as a Vercel environment variable), make the
// "admin" account use it, creating that account if it doesn't exist yet. This
// keeps the real admin password out of the code. Note: while the variable is
// set it wins over a password changed in the app, on the next server start.
async function syncAdminPassword() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return;
  const { rows } = await pool.query("SELECT id, password_hash FROM users WHERE username = 'admin'");
  if (rows.length && bcrypt.compareSync(password, rows[0].password_hash)) return;
  const hash = bcrypt.hashSync(password, 10);
  if (rows.length) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rows[0].id]);
  } else {
    await pool.query(
      "INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin', $1, 'Store Owner', 'admin')",
      [hash]
    );
  }
  console.log('Admin password synced from ADMIN_PASSWORD.');
}

function ensureSchema() {
  if (!schemaReady) {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    schemaReady = pool.query(schema).then(syncAdminPassword).catch((err) => {
      schemaReady = null; // allow a retry on the next call if it failed
      throw err;
    });
  }
  return schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return pool.query(text, params);
}

// For multi-statement transactions (checkout, inventory adjustments) where
// several writes must succeed or fail together. Caller is responsible for
// BEGIN/COMMIT/ROLLBACK and must always release the client.
async function getClient() {
  await ensureSchema();
  return pool.connect();
}

module.exports = { query, getClient, pool, ensureSchema };
