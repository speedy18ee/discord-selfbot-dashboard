const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('child_process');
const config = require('./config');
const logger = require('./logger');

let mysql = null;
try {
  mysql = require('mysql2/promise');
} catch (_) {}

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

class SQLiteStore {
  constructor() {
    this.dashboardId = (process.env.DASHBOARD_ID || process.env.INSTANCE_ID || '').trim();
    this.keyPrefix = this.dashboardId ? `${this.dashboardId}_` : '';
    this.mysqlConfig = parseMySQLConfig();
    this.mysqlPool = null;
    this.mysqlConnected = false;
    this.pendingWrites = new Map();
    this.isFlushing = false;

    // 1. Pre-hydrate SQLite from MySQL synchronously at boot if configured
    this.syncFromMySQLSync();

    // 2. Initialize local SQLite (isolated by dashboard ID)
    const databasePath = process.env.SQLITE_PATH || path.join(config.dataDir, this.dashboardId ? `exc_${this.dashboardId}.sqlite` : 'exc.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
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

    // 3. Initialize background MySQL connection pool
    this.initMySQL();
  }

  syncFromMySQLSync() {
    if (!this.mysqlConfig || process.env._MYSQL_BOOT_SYNCED === '1') return;
    try {
      const syncScript = path.join(__dirname, 'syncFromMysql.js');
      if (fs.existsSync(syncScript)) {
        execFileSync(process.execPath, [syncScript], {
          env: { ...process.env, _MYSQL_BOOT_SYNCED: '1' },
          timeout: 8000,
          stdio: 'ignore'
        });
        process.env._MYSQL_BOOT_SYNCED = '1';
      }
    } catch (e) {
      logger.warn('DB', `Boot MySQL sync skipped: ${e.message}`);
    }
  }

  initMySQL() {
    if (!this.mysqlConfig || !mysql) return;

    try {
      this.mysqlPool = mysql.createPool({
        ...this.mysqlConfig,
        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 5,
        idleTimeout: 60000,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
      });

      this.ensureMySQLSchema()
        .then(() => {
          this.mysqlConnected = true;
          const instInfo = this.dashboardId ? ` [Instance: ${this.dashboardId}]` : '';
          logger.success('DB', `Connected to MySQL database [${this.mysqlConfig.database}]${instInfo} at ${this.mysqlConfig.host}:${this.mysqlConfig.port}`);
          this.flushPendingWrites();
        })
        .catch(err => {
          logger.warn('DB', `MySQL initial schema verification failed: ${err.message}`);
        });

      // Keepalive ping every 25 seconds
      setInterval(() => {
        if (this.mysqlPool) {
          this.mysqlPool.query('SELECT 1').then(() => {
            this.mysqlConnected = true;
          }).catch(err => {
            this.mysqlConnected = false;
            logger.warn('DB', `MySQL keepalive ping error: ${err.message}`);
          });
        }
      }, 25000);

    } catch (err) {
      logger.error('DB', `Failed to initialize MySQL pool: ${err.message}`);
    }
  }

  async ensureMySQLSchema() {
    if (!this.mysqlPool) return;
    await this.mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        \`key\` VARCHAR(191) PRIMARY KEY,
        \`value\` LONGTEXT NOT NULL,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Ensure accounts table supports multi-dashboard isolation via dashboard_id
    await this.mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        \`id\` VARCHAR(64),
        \`dashboard_id\` VARCHAR(64) DEFAULT 'default',
        \`owner_id\` VARCHAR(64),
        \`label\` VARCHAR(255),
        \`token\` VARCHAR(255),
        \`status\` VARCHAR(32),
        \`auto_start\` BOOLEAN DEFAULT TRUE,
        \`created_at\` VARCHAR(64),
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`, \`dashboard_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  getJSON(key, fallback, legacyFile = null) {
    const row = this.readStatement.get(key);
    if (row) {
      try {
        return JSON.parse(row.value);
      } catch (err) {
        logger.error('DB', `Failed to parse JSON for key "${key}": ${err.message}`);
      }
    }

    if (legacyFile && fs.existsSync(legacyFile)) {
      try {
        const value = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        this.setJSON(key, value);
        return value;
      } catch (error) {
        logger.error('DB', `Failed to migrate ${legacyFile} to SQLite: ${error.message}`);
      }
    }

    this.setJSON(key, fallback);
    return fallback;
  }

  setJSON(key, value) {
    const jsonStr = JSON.stringify(value);
    // 1. Write immediately to local SQLite
    this.writeStatement.run(key, jsonStr);

    // 2. Persist to MySQL under dashboard-isolated key
    if (this.mysqlPool) {
      const mysqlKey = `${this.keyPrefix}${key}`;
      this.pushToMySQL(mysqlKey, jsonStr, value);
    }
  }

  async pushToMySQL(key, jsonStr, rawValue) {
    try {
      await this.mysqlPool.query(
        'INSERT INTO app_state (`key`, `value`, `updated_at`) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = NOW()',
        [key, jsonStr]
      );
      this.mysqlConnected = true;

      // Relational sync for accounts table if saving accounts
      if (key.endsWith('accounts') && Array.isArray(rawValue)) {
        await this.syncRelationalAccounts(rawValue);
      }
    } catch (err) {
      this.mysqlConnected = false;
      logger.warn('DB', `Failed to push key "${key}" to MySQL (${err.message}). Queued for retry.`);
      this.pendingWrites.set(key, { jsonStr, rawValue });
      this.scheduleRetry();
    }
  }

  async syncRelationalAccounts(accounts) {
    if (!this.mysqlPool || !Array.isArray(accounts)) return;
    const tag = this.dashboardId || 'default';
    try {
      for (const a of accounts) {
        if (!a || !a.id) continue;
        await this.mysqlPool.query(
          `INSERT INTO accounts (\`id\`, \`dashboard_id\`, \`owner_id\`, \`label\`, \`token\`, \`status\`, \`auto_start\`, \`created_at\`, \`updated_at\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             \`owner_id\` = VALUES(\`owner_id\`),
             \`label\` = VALUES(\`label\`),
             \`token\` = VALUES(\`token\`),
             \`status\` = VALUES(\`status\`),
             \`auto_start\` = VALUES(\`auto_start\`),
             \`updated_at\` = NOW()`,
          [
            a.id,
            tag,
            a.ownerId || 'default',
            a.label || 'Bot Account',
            a.token || '',
            a.status || 'offline',
            a.autoStart !== false,
            a.createdAt || new Date().toISOString()
          ]
        );
      }
    } catch (err) {
      logger.warn('DB', `Relational accounts sync: ${err.message}`);
    }
  }

  scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.flushPendingWrites();
    }, 4000);
  }

  async flushPendingWrites() {
    if (this.isFlushing || this.pendingWrites.size === 0 || !this.mysqlPool) return;
    this.isFlushing = true;
    try {
      for (const [key, item] of Array.from(this.pendingWrites.entries())) {
        await this.mysqlPool.query(
          'INSERT INTO app_state (`key`, `value`, `updated_at`) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `updated_at` = NOW()',
          [key, item.jsonStr]
        );
        if (key.endsWith('accounts') && Array.isArray(item.rawValue)) {
          await this.syncRelationalAccounts(item.rawValue);
        }
        this.pendingWrites.delete(key);
      }
      this.mysqlConnected = true;
      logger.success('DB', 'All pending database writes successfully flushed to MySQL.');
    } catch (err) {
      this.mysqlConnected = false;
      this.scheduleRetry();
    } finally {
      this.isFlushing = false;
    }
  }

  async syncFromMySQL() {
    if (!this.mysqlPool) return false;
    try {
      const [rows] = await this.mysqlPool.query('SELECT `key`, `value` FROM app_state');
      if (rows && rows.length > 0) {
        for (const row of rows) {
          if (this.keyPrefix) {
            if (row.key.startsWith(this.keyPrefix)) {
              const rawKey = row.key.substring(this.keyPrefix.length);
              const valStr = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
              this.writeStatement.run(rawKey, valStr);
            }
          } else {
            const isPrefixed = row.key.includes('_accounts') || row.key.includes('_users') || row.key.includes('_licenses') || row.key.includes('_settings');
            if (!isPrefixed) {
              const valStr = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
              this.writeStatement.run(row.key, valStr);
            }
          }
        }
        this.mysqlConnected = true;
        return true;
      }
    } catch (err) {
      this.mysqlConnected = false;
      logger.warn('DB', `syncFromMySQL failed: ${err.message}`);
    }
    return false;
  }

  getStatus() {
    return {
      connected: this.mysqlConnected,
      dashboardId: this.dashboardId || 'default',
      provider: this.mysqlPool ? 'Aiven MySQL + SQLite Cache' : 'SQLite Local',
      database: this.mysqlConfig ? this.mysqlConfig.database : this.databasePath,
      host: this.mysqlConfig ? this.mysqlConfig.host : 'local',
      port: this.mysqlConfig ? this.mysqlConfig.port : null,
      ssl: this.mysqlConfig ? !!this.mysqlConfig.ssl : false
    };
  }

  async close() {
    if (this.mysqlPool) {
      await this.flushPendingWrites();
      await this.mysqlPool.end();
    }
    this.db.close();
  }
}

module.exports = new SQLiteStore();
