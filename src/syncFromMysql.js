/**
 * Synchronous MySQL-to-SQLite Hydration Script
 * Invoked synchronously at boot before application modules are loaded.
 * Ensures the ephemeral container disk has the persistent state from Aiven MySQL.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

function parseMySQLConfig() {
  const uri = process.env.MYSQL_URI || process.env.DATABASE_URL;
  if (uri && (uri.startsWith('mysql://') || uri.startsWith('mysql2://'))) {
    try {
      const url = new URL(uri);
      return {
        host: url.hostname,
        port: parseInt(url.port || '3306', 10),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, '') || 'defaultdb',
        ssl: { rejectUnauthorized: false }
      };
    } catch (_) {}
  }

  if (process.env.MYSQL_HOST) {
    const isAiven = (process.env.MYSQL_HOST || '').includes('aivencloud.com');
    const sslVal = (process.env.MYSQL_SSL || '').toLowerCase();
    const useSsl = isAiven || sslVal === 'true' || sslVal === 'required' || sslVal === '1';

    return {
      host: process.env.MYSQL_HOST,
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'avnadmin',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'defaultdb',
      ssl: useSsl ? { rejectUnauthorized: false } : undefined
    };
  }

  return null;
}

async function run() {
  const conf = parseMySQLConfig();
  if (!conf) {
    return;
  }

  const mysql = require('mysql2/promise');
  let conn = null;

  try {
    conn = await mysql.createConnection({
      ...conf,
      connectTimeout: 5000
    });

    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        \`key\` VARCHAR(191) PRIMARY KEY,
        \`value\` LONGTEXT NOT NULL,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    const [rows] = await conn.query('SELECT `key`, `value` FROM app_state');

    const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'exc.sqlite');
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const db = new DatabaseSync(sqlitePath);

    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const upsert = db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);

    if (rows && rows.length > 0) {
      for (const row of rows) {
        upsert.run(row.key, typeof row.value === 'string' ? row.value : JSON.stringify(row.value));
      }
      console.log(`[BOOT_SYNC] Hydrated ${rows.length} keys from MySQL to SQLite cache.`);
    } else {
      console.log('[BOOT_SYNC] MySQL app_state is empty; will seed from local files.');
    }

    db.close();
  } catch (err) {
    console.warn(`[BOOT_SYNC] Warning: Could not pre-sync from MySQL: ${err.message}`);
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) {}
    }
  }
}

run().catch(() => {}).then(() => process.exit(0));
