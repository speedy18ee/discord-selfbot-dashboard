const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

class SQLiteStore {
  constructor() {
    const databasePath = process.env.SQLITE_PATH || config.sqliteFile;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.readStatement = this.db.prepare('SELECT value FROM app_state WHERE key = ?');
    this.writeStatement = this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);
  }

  getJSON(key, fallback, legacyFile = null) {
    const row = this.readStatement.get(key);
    if (row) return JSON.parse(row.value);

    if (legacyFile && fs.existsSync(legacyFile)) {
      try {
        const value = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        this.setJSON(key, value);
        return value;
      } catch (error) {
        throw new Error(`Failed to migrate ${legacyFile} to SQLite: ${error.message}`);
      }
    }

    this.setJSON(key, fallback);
    return fallback;
  }

  setJSON(key, value) {
    this.writeStatement.run(key, JSON.stringify(value));
  }

  getStatus() {
    return { connected: true, provider: 'SQLite', database: process.env.SQLITE_PATH || config.sqliteFile };
  }

  close() {
    this.db.close();
  }
}

module.exports = new SQLiteStore();
