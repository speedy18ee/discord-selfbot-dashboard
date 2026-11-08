const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'cw1048_speedy18ee',
  password: process.env.DB_PASSWORD || 'cHsPQsCV5Dpn2EaKDs3daaV2',
  database: process.env.DB_NAME || 'cw1048_speedy18ee',
  waitForConnections: true,
  connectionLimit: 10
};

let pool = null;
let isConnected = false;

async function initDb() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    const conn = await pool.getConnection();
    console.log('[DB] Connected to MariaDB database: ' + DB_CONFIG.database);
    conn.release();
    isConnected = true;
    await syncInitialData();
  } catch (err) {
    console.error('[DB] MariaDB connection failed:', err.message);
    isConnected = false;
  }
}

async function syncInitialData() {
  if (!isConnected) return;
  const licensesFile = path.join(__dirname, 'licenses.json');
  if (fs.existsSync(licensesFile)) {
    try {
      const keys = JSON.parse(fs.readFileSync(licensesFile, 'utf8'));
      for (const item of keys) {
        await pool.execute(`
          INSERT INTO licenses (key_code, tier, max_accounts, created_at, is_active, hwid, hwid_bound_at, owner_discord_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            tier = VALUES(tier),
            max_accounts = VALUES(max_accounts),
            hwid = COALESCE(VALUES(hwid), hwid)
        `, [
          item.key,
          item.tier || 'standard',
          item.maxAccounts || 4,
          item.createdAt ? new Date(item.createdAt) : new Date(),
          item.used ? 1 : 0,
          item.hwid || null,
          item.hwidBoundAt ? new Date(item.hwidBoundAt) : null,
          item.usedBy || null
        ]);
      }
      console.log(`[DB] Successfully synced ${keys.length} licenses into MariaDB table.`);
    } catch (e) {
      console.error('[DB] Migration error:', e.message);
    }
  }
}

async function getAllLicenses() {
  if (isConnected) {
    try {
      const [rows] = await pool.query('SELECT * FROM licenses');
      return rows.map(r => ({
        key: r.key_code,
        tier: r.tier,
        maxAccounts: r.max_accounts,
        createdAt: r.created_at,
        used: Boolean(r.is_active),
        hwid: r.hwid,
        hwidBoundAt: r.hwid_bound_at,
        usedBy: r.owner_discord_id
      }));
    } catch (e) {
      console.error('[DB] Query error in getAllLicenses:', e.message);
    }
  }
  // Fallback to local file
  const fallback = path.join(__dirname, 'licenses.json');
  return fs.existsSync(fallback) ? JSON.parse(fs.readFileSync(fallback, 'utf8')) : [];
}

async function getLicense(keyCode) {
  if (isConnected) {
    try {
      const [rows] = await pool.execute('SELECT * FROM licenses WHERE key_code = ?', [keyCode.trim().toUpperCase()]);
      if (rows.length > 0) {
        const r = rows[0];
        return {
          key: r.key_code,
          tier: r.tier,
          maxAccounts: r.max_accounts,
          createdAt: r.created_at,
          used: Boolean(r.is_active),
          hwid: r.hwid,
          hwidBoundAt: r.hwid_bound_at,
          usedBy: r.owner_discord_id
        };
      }
      return null;
    } catch (e) {
      console.error('[DB] Query error in getLicense:', e.message);
    }
  }
  const all = await getAllLicenses();
  return all.find(l => l.key.toUpperCase() === keyCode.trim().toUpperCase()) || null;
}

async function saveNewKey(key, userId = 'manual', tag = '', tier = 'standard', maxAccounts = 4) {
  const cleanKey = key.trim().toUpperCase();
  if (isConnected) {
    try {
      await pool.execute(`
        INSERT INTO licenses (key_code, tier, max_accounts, created_at, is_active, hwid, hwid_bound_at, owner_discord_id)
        VALUES (?, ?, ?, NOW(), 0, NULL, NULL, ?)
        ON DUPLICATE KEY UPDATE
          tier = VALUES(tier),
          max_accounts = VALUES(max_accounts),
          owner_discord_id = VALUES(owner_discord_id)
      `, [cleanKey, tier, maxAccounts, userId]);
      console.log(`[DB] Saved license key ${cleanKey} to MariaDB.`);
    } catch (e) {
      console.error('[DB] Error saving license:', e.message);
    }
  }

  // Also sync to local JSON backup
  try {
    const licensesFile = path.join(__dirname, 'licenses.json');
    let list = fs.existsSync(licensesFile) ? JSON.parse(fs.readFileSync(licensesFile, 'utf8')) : [];
    const existingIdx = list.findIndex(k => k.key.toUpperCase() === cleanKey);
    const item = {
      key: cleanKey,
      createdAt: new Date().toISOString(),
      used: false,
      usedBy: userId,
      userTag: tag,
      tier: tier,
      maxAccounts: maxAccounts,
      hwid: null,
      hwidBoundAt: null
    };
    if (existingIdx !== -1) {
      list[existingIdx] = { ...list[existingIdx], ...item };
    } else {
      list.push(item);
    }
    fs.writeFileSync(licensesFile, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('[DB] Backup to licenses.json failed:', err.message);
  }
}

async function resetHwid(keyCode, requestedBy = '') {
  const cleanKey = keyCode.trim().toUpperCase();
  if (isConnected) {
    try {
      await pool.execute(`
        UPDATE licenses 
        SET hwid = NULL, hwid_bound_at = NULL 
        WHERE key_code = ?
      `, [cleanKey]);
      console.log(`[DB] HWID reset for key ${cleanKey} by ${requestedBy}`);
    } catch (e) {
      console.error('[DB] Error resetting HWID:', e.message);
    }
  }

  // Sync to local file
  try {
    const licensesFile = path.join(__dirname, 'licenses.json');
    if (fs.existsSync(licensesFile)) {
      let list = JSON.parse(fs.readFileSync(licensesFile, 'utf8'));
      const found = list.find(k => k.key.toUpperCase() === cleanKey);
      if (found) {
        found.hwid = null;
        found.hwidBoundAt = null;
        fs.writeFileSync(licensesFile, JSON.stringify(list, null, 2));
      }
    }
  } catch (err) {
    console.error('[DB] Backup sync failed:', err.message);
  }
}

async function setLimit(keyCode, newLimit, requestedBy = '') {
  const cleanKey = keyCode.trim().toUpperCase();
  const limitNum = parseInt(newLimit, 10);
  const tier = limitNum > 4 ? 'premium' : 'standard';

  if (isConnected) {
    try {
      await pool.execute(`
        UPDATE licenses 
        SET max_accounts = ?, tier = ? 
        WHERE key_code = ?
      `, [limitNum, tier, cleanKey]);
      console.log(`[DB] Limit updated for ${cleanKey} to ${limitNum} accounts by ${requestedBy}`);
    } catch (e) {
      console.error('[DB] Error setting limit:', e.message);
    }
  }

  // Sync to local file
  try {
    const licensesFile = path.join(__dirname, 'licenses.json');
    if (fs.existsSync(licensesFile)) {
      let list = JSON.parse(fs.readFileSync(licensesFile, 'utf8'));
      const found = list.find(k => k.key.toUpperCase() === cleanKey);
      if (found) {
        found.maxAccounts = limitNum;
        found.tier = tier;
        fs.writeFileSync(licensesFile, JSON.stringify(list, null, 2));
      }
    }
  } catch (err) {
    console.error('[DB] Backup sync failed:', err.message);
  }
}

async function updateHwidLock(keyCode, hwid) {
  const cleanKey = keyCode.trim().toUpperCase();
  if (isConnected) {
    try {
      await pool.execute(`
        UPDATE licenses 
        SET hwid = ?, hwid_bound_at = NOW(), is_active = 1 
        WHERE key_code = ?
      `, [hwid, cleanKey]);
      console.log(`[DB] HWID locked for ${cleanKey} -> ${hwid}`);
    } catch (e) {
      console.error('[DB] Error updating HWID lock:', e.message);
    }
  }

  // Sync to local file
  try {
    const licensesFile = path.join(__dirname, 'licenses.json');
    if (fs.existsSync(licensesFile)) {
      let list = JSON.parse(fs.readFileSync(licensesFile, 'utf8'));
      const found = list.find(k => k.key.toUpperCase() === cleanKey);
      if (found) {
        found.hwid = hwid;
        found.hwidBoundAt = new Date().toISOString();
        found.used = true;
        fs.writeFileSync(licensesFile, JSON.stringify(list, null, 2));
      }
    }
  } catch (err) {
    console.error('[DB] Backup sync failed:', err.message);
  }
}

module.exports = {
  initDb,
  getLicense,
  getAllLicenses,
  saveNewKey,
  resetHwid,
  setLimit,
  updateHwidLock,
  isDbConnected: () => isConnected,
  getPool: () => pool
};
