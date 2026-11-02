const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const sqliteStore = require('./sqliteStore');

class LicenseManager {
  constructor() {
    this.licensesFile = path.join(config.dataDir, 'licenses.json');
    this.licenses = [];
    this.init();
  }

  init() {
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);

    // Ensure default demo/admin key exists if empty
    if (this.licenses.length === 0) {
      this.licenses.push({
        id: 'lic_' + crypto.randomBytes(8).toString('hex'),
        key: 'EXC-PREMIUM-ADMIN-LIFETIME',
        status: 'active',
        botLimit: 100,
        days: 9999,
        expiry: null, // lifetime
        hwid: null,
        usedBy: 'admin',
        note: 'Default Master License',
        createdAt: new Date().toISOString(),
        usedAt: new Date().toISOString()
      });
      this.saveLicenses(false);
    }
  }

  async syncWithMySQL() {
    await sqliteStore.syncFromMySQL();
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);
    logger.success('LICENSE', `Loaded ${this.licenses.length} license(s) from persistent storage.`);
    return this.licenses;
  }

  reload() {
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);
    return this.licenses;
  }

  loadJSON(file, fallback) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (e) {
      logger.error('LICENSE', `Failed to load ${file}: ${e.message}`);
    }
    return fallback;
  }

  saveLicenses(triggerSync = true) {
    try {
      sqliteStore.setJSON('licenses', this.licenses);
    } catch (e) {
      logger.error('LICENSE', `Failed to save licenses: ${e.message}`);
    }
  }

  /**
   * Generate a random license key matching a pattern e.g. EXC-XXXX-XXXX-XXXX
   */
  generateKeyString(mask = 'EXC-XXXX-XXXX-XXXX') {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return mask.replace(/X/g, () => chars[Math.floor(Math.random() * chars.length)]);
  }

  /**
   * Create 1 or bulk licenses
   */
  createLicenses({ amount = 1, mask = 'EXC-XXXX-XXXX-XXXX', days = 30, botLimit = 10, note = '', createdBy = 'Admin' }) {
    const count = Math.min(Math.max(parseInt(amount, 10) || 1, 1), 100);
    const quota = Math.max(parseInt(botLimit, 10) || 10, 1);
    const duration = parseInt(days, 10) || 30;
    const createdKeys = [];

    for (let i = 0; i < count; i++) {
      let key = this.generateKeyString(mask);
      // Ensure unique
      while (this.licenses.some(l => l.key === key)) {
        key = this.generateKeyString(mask);
      }

      const lic = {
        id: 'lic_' + crypto.randomBytes(8).toString('hex'),
        key,
        status: 'unused', // 'unused' | 'active' | 'banned' | 'expired'
        botLimit: quota,
        days: duration,
        expiry: null, // set when first activated
        hwid: null,
        usedBy: null,
        note: note ? `${note} (Created by ${createdBy})` : `Created by ${createdBy}`,
        createdAt: new Date().toISOString(),
        usedAt: null
      };

      this.licenses.unshift(lic);
      createdKeys.push(lic);
    }

    this.saveLicenses();
    logger.success('LICENSE', `Generated ${createdKeys.length} new license(s) with ${quota} bots quota each.`);
    return createdKeys;
  }

  /**
   * Validate and authenticate with a license key
   */
  validateLicense(key, clientHwid = null) {
    if (!key || typeof key !== 'string') {
      throw new Error('Please enter a license key');
    }
    const cleanKey = key.trim().toUpperCase();
    const lic = this.licenses.find(l => l.key.toUpperCase() === cleanKey);

    if (!lic) {
      return null; // not found in local system (can fallback to external KeyAuth)
    }

    if (lic.status === 'banned') {
      throw new Error('This license key has been banned by an administrator.');
    }

    // Check expiry if already activated
    if (lic.expiry) {
      const expDate = new Date(lic.expiry);
      if (Date.now() > expDate.getTime()) {
        lic.status = 'expired';
        this.saveLicenses(false);
        throw new Error(`This license key expired on ${expDate.toLocaleDateString()}. Contact admin for renewal.`);
      }
    }

    // If unused, activate on first login
    if (lic.status === 'unused') {
      lic.status = 'active';
      lic.hwid = clientHwid || `HWID-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
      lic.usedBy = cleanKey.substring(0, 16);
      lic.usedAt = new Date().toISOString();
      if (lic.days > 0 && lic.days < 9999) {
        const exp = new Date();
        exp.setDate(exp.getDate() + lic.days);
        lic.expiry = exp.toISOString();
      } else {
        lic.expiry = null; // lifetime
      }
      this.saveLicenses();
      logger.success('LICENSE', `License "${lic.key}" activated with HWID "${lic.hwid}" (Quota: ${lic.botLimit} bots).`);
    } else {
      // License is already active: verify HWID
      if (lic.hwid && clientHwid) {
        if (lic.hwid.toUpperCase() !== clientHwid.toUpperCase()) {
          throw new Error("HWID doesn't match! This key is locked to another device. Ask admin for a HWID reset.");
        }
      } else if (!lic.hwid && clientHwid) {
        // HWID was reset, bind to new device
        lic.hwid = clientHwid;
        this.saveLicenses();
      }
    }

    return lic;
  }

  /**
   * Reset HWID for a license
   */
  resetHwid(keyOrId) {
    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());
    if (!lic) return false;
    lic.hwid = null;
    this.saveLicenses();
    logger.info('LICENSE', `HWID reset for license "${lic.key}".`);
    return true;
  }

  /**
   * Update bot quota limit for a license
   */
  updateBotLimit(keyOrId, newLimit) {
    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());
    if (!lic) return false;
    lic.botLimit = Math.max(parseInt(newLimit, 10) || 10, 1);
    this.saveLicenses();
    logger.info('LICENSE', `Bot limit updated to ${lic.botLimit} for license "${lic.key}".`);
    return true;
  }

  getBotLimit(key) {
    if (!key || typeof key !== 'string') return null;
    const cleanKey = key.trim().toUpperCase();
    const lic = this.licenses.find(l => l.key.toUpperCase() === cleanKey || l.id === key);
    return lic && typeof lic.botLimit === 'number' ? lic.botLimit : null;
  }

  /**
   * Toggle Ban status
   */
  toggleBan(keyOrId) {
    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());
    if (!lic) return false;
    lic.status = lic.status === 'banned' ? (lic.usedAt ? 'active' : 'unused') : 'banned';
    this.saveLicenses();
    return lic.status;
  }

  /**
   * Check if a license key exists and is valid
   */
  hasKey(key) {
    if (!key || typeof key !== 'string') return false;
    const cleanKey = key.trim().toUpperCase();
    return this.licenses.some(l => l.key.toUpperCase() === cleanKey);
  }

  /**
   * Permanently delete a license
   */
  deleteLicense(keyOrId) {
    if (!keyOrId) return null;
    const clean = String(keyOrId).trim().toUpperCase();
    const idx = this.licenses.findIndex(l => l.id === keyOrId || l.key.toUpperCase() === clean);
    if (idx === -1) return null;
    const removed = this.licenses.splice(idx, 1)[0];
    this.saveLicenses(true);
    logger.info('LICENSE', `Permanently deleted license key "${removed.key}" (ID: ${removed.id}).`);
    return removed;
  }

  getAll() {
    return this.licenses;
  }
}

module.exports = new LicenseManager();
