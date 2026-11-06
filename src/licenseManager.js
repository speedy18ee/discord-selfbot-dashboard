const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const sqliteStore = require('./sqliteStore');

const SEED_LICENSES = [
  {
    id: 'lic_euc2stc_05d0',
    key: 'EUC-2STC-MRLJ-MP3G',
    status: 'active',
    botLimit: 10,
    days: 30,
    expiry: '2026-12-03T11:00:00.000Z',
    hwid: 'HWID-05D0D4DDFBB5575F',
    usedBy: 'EUC-2STC-MRLJ-MP',
    note: 'Buyer (5 Bots)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_egclife_4c40',
    key: 'EGC-LIFETIME-PREMIUM',
    status: 'active',
    botLimit: 100,
    days: 9999,
    expiry: null,
    hwid: 'HWID-4C401374545BA480',
    usedBy: 'EGC-LIFETIME-PRE',
    note: 'Lifetime Premium (12 Bots)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_e7cdejc_895b',
    key: 'E7C-DEJC-3FTN-YV6N',
    status: 'active',
    botLimit: 25,
    days: 30,
    expiry: '2026-12-03T11:00:00.000Z',
    hwid: 'HWID-895B41DEBDF74BB3',
    usedBy: 'E7C-DEJC-3FTN-YV',
    note: 'Buyer (14 Bots)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_e4cunqw_269b',
    key: 'E4C-UNQW-DYTG-BLXW',
    status: 'active',
    botLimit: 10,
    days: 30,
    expiry: '2026-12-03T11:00:00.000Z',
    hwid: 'HWID-269BE23DF11BEB52',
    usedBy: 'Sushanth',
    note: 'Sushanth (1 Bot)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_ehc7xmt_3f1f',
    key: 'EHC-7XMT-VGRB-9A34',
    status: 'active',
    botLimit: 10,
    days: 30,
    expiry: '2026-12-03T11:00:00.000Z',
    hwid: 'HWID-3F1F9E6F520C58CF',
    usedBy: 'Susanth',
    note: 'Susanth (1 Bot)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_ezcluffy_8070',
    key: 'EZC-LUFFY-PREMIUM',
    status: 'active',
    botLimit: 25,
    days: 9999,
    expiry: null,
    hwid: 'HWID-807086727033DE1C',
    usedBy: 'LUFFY',
    note: 'LUFFY ON TOP (2 Bots)',
    createdAt: '2026-11-01T12:00:00.000Z',
    usedAt: '2026-11-01T12:00:00.000Z'
  },
  {
    id: 'lic_bf51c6c9607deb30',
    key: 'EUC-YVAZ-6JUT-66WG',
    status: 'active',
    botLimit: 10,
    days: 30,
    expiry: '2026-12-03T11:00:16.905Z',
    hwid: 'HWID-F5A1618F496D220356970A6F6AEBFC46',
    usedBy: 'EUC-YVAZ-6JUT-66',
    note: 'Created by Admin',
    createdAt: '2026-11-03T11:00:16.541Z',
    usedAt: '2026-11-03T11:00:16.905Z'
  },
  {
    id: 'lic_9e49da1ee2d35e33',
    key: 'EKC-8P62-DTMV-SZ25',
    status: 'active',
    botLimit: 10,
    days: 30,
    expiry: '2026-12-03T11:02:02.126Z',
    hwid: 'HWID-973F17AD8AE9ABE3F8DB16339932036B',
    usedBy: 'EKC-8P62-DTMV-SZ',
    note: 'Created by Admin',
    createdAt: '2026-11-03T10:58:32.838Z',
    usedAt: '2026-11-03T11:02:02.126Z'
  },
  {
    id: 'lic_079aaf1ff754caf0',
    key: 'EXC-PREMIUM-ADMIN-LIFETIME',
    status: 'active',
    botLimit: 100,
    days: 9999,
    expiry: null,
    hwid: 'HWID-973F17AD8AE9ABE3F8DB16339932036B',
    usedBy: 'admin',
    note: 'Default Master License',
    createdAt: '2026-11-02T21:32:46.886Z',
    usedAt: '2026-11-02T21:32:46.886Z'
  },
  {
    id: 'lic_8aedba99bc660725',
    key: 'EVC-TEST-XVBY-25B',
    status: 'active',
    botLimit: 25,
    days: 30,
    expiry: '2026-11-28T17:04:42.744Z',
    hwid: null,
    usedBy: 'VIP Buyer',
    note: 'VIP Buyer (Created by Admin)',
    createdAt: '2026-10-29T16:04:42.729Z',
    usedAt: '2026-10-31T12:49:12+00:00'
  },
  {
    id: 'lic_6774dee652d2ff69',
    key: 'ECC-8ATA-Q9EJ-J3LD',
    status: 'active',
    botLimit: 25,
    days: 9999,
    expiry: null,
    hwid: null,
    usedBy: 'Buyer',
    note: 'Egalaontop',
    createdAt: '2026-10-30T21:17:24+00:00',
    usedAt: '2026-10-30T21:17:48+00:00'
  },
  {
    id: 'lic_20cbce99c08ecfc3',
    key: 'E5C-TKXS-276Z-8LAR',
    status: 'active',
    botLimit: 4,
    days: 25,
    expiry: '2026-11-25T02:56:38+00:00',
    hwid: null,
    usedBy: 'Buyer',
    note: 'Friend Key',
    createdAt: '2026-10-31T02:56:38+00:00',
    usedAt: '2026-10-31T09:59:24+00:00'
  },
  {
    id: 'lic_0e9f0151dd8b4ded',
    key: 'EQC-U353-62YE-NETY',
    status: 'active',
    botLimit: 50,
    days: 30,
    expiry: '2026-11-30T11:39:57+00:00',
    hwid: 'HWID-4E1F9A7A17ECE3C9F347B06DF7EEDA9D',
    usedBy: 'Buyer',
    note: '',
    createdAt: '2026-10-31T11:39:57+00:00',
    usedAt: '2026-10-31T12:53:47+00:00'
  },
  {
    id: 'lic_a5a08df03f4eabdb',
    key: 'E4C-HSKW-FR4W-X4KJ',
    status: 'active',
    botLimit: 30,
    days: 100,
    expiry: '2027-02-08T12:32:44+00:00',
    hwid: 'HWID-3366C70B6AE1DA3D20B8DF31372FD7AC',
    usedBy: 'Buyer',
    note: 'vedanth',
    createdAt: '2026-10-31T12:32:44+00:00',
    usedAt: '2026-10-31T12:54:52+00:00'
  },
  {
    id: 'lic_bf3ce8e311ac2bb5',
    key: 'E6C-VRL3-YFFZ-JBAU',
    status: 'active',
    botLimit: 100,
    days: 9999,
    expiry: null,
    hwid: 'HWID-CD2C7C9544EF53193EF8A7C70D572B27',
    usedBy: 'Buyer',
    note: 'Rin',
    createdAt: '2026-10-31T13:32:31+00:00',
    usedAt: '2026-10-31T13:32:45+00:00'
  }
];

class LicenseManager {
  constructor() {
    this.licensesFile = path.join(config.dataDir, 'licenses.json');
    this.licenses = [];
    this.deletedKeys = new Set();
    this.init();
  }

  init() {
    this.deletedKeys = new Set(sqliteStore.getJSON('deleted_licenses', []).map(k => String(k).toUpperCase()));
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);

    // Merge in valid seeds that haven't been deleted by admin
    let changed = false;
    for (const seed of SEED_LICENSES) {
      const upKey = seed.key.toUpperCase();
      if (this.deletedKeys.has(upKey)) continue; // permanently deleted

      if (!this.licenses.some(l => l.key && l.key.toUpperCase() === upKey)) {
        this.licenses.push(seed);
        changed = true;
      }
    }

    if (changed || this.licenses.length === 0) {
      this.saveLicenses(false);
    }
  }

  async syncWithMySQL() {
    await sqliteStore.syncFromMySQL();
    this.deletedKeys = new Set(sqliteStore.getJSON('deleted_licenses', []).map(k => String(k).toUpperCase()));
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);

    let changed = false;
    for (const seed of SEED_LICENSES) {
      const upKey = seed.key.toUpperCase();
      if (this.deletedKeys.has(upKey)) continue;
      if (!this.licenses.some(l => l.key && l.key.toUpperCase() === upKey)) {
        this.licenses.push(seed);
        changed = true;
      }
    }
    if (changed) {
      this.saveLicenses(true);
    }

    logger.success('LICENSE', `Loaded ${this.licenses.length} license(s) from persistent storage.`);
    return this.licenses;
  }

  reload() {
    this.deletedKeys = new Set(sqliteStore.getJSON('deleted_licenses', []).map(k => String(k).toUpperCase()));
    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);
    return this.licenses;
  }

  loadJSON(file, fallback) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      }
    } catch (e) {
      logger.error('LICENSE', `Failed to load ${file}: ${e.message}`);
    }
    return fallback;
  }

  saveLicenses(triggerSync = true) {
    try {
      sqliteStore.setJSON('licenses', this.licenses);
      sqliteStore.setJSON('deleted_licenses', Array.from(this.deletedKeys));
    } catch (e) {
      logger.error('LICENSE', `Failed to save licenses: ${e.message}`);
    }
  }

  generateKeyString(mask = 'EXC-XXXX-XXXX-XXXX') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return mask.replace(/X/g, () => chars[Math.floor(Math.random() * chars.length)]);
  }

  createLicenses({ amount = 1, mask = 'EXC-XXXX-XXXX-XXXX', days = 30, botLimit = 10, note = '', createdBy = 'Admin' }) {
    const count = Math.min(Math.max(parseInt(amount, 10) || 1, 1), 100);
    const quota = Math.max(parseInt(botLimit, 10) || 10, 1);
    const duration = parseInt(days, 10) || 30;
    const createdKeys = [];

    for (let i = 0; i < count; i++) {
      let key = this.generateKeyString(mask);
      while (this.licenses.some(l => l.key === key)) {
        key = this.generateKeyString(mask);
      }

      const lic = {
        id: 'lic_' + crypto.randomBytes(8).toString('hex'),
        key,
        status: 'unused',
        botLimit: quota,
        days: duration,
        expiry: null,
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
    logger.success('LICENSE', `Generated ${createdKeys.length} new license(s) with ${quota} bot limit.`);
    return createdKeys;
  }

  validateLicense(key, clientHwid = null) {
    if (!key || typeof key !== 'string') {
      return null;
    }

    const cleanKey = key.trim().toUpperCase();
    const lic = this.licenses.find(l => l.key.toUpperCase() === cleanKey);
    if (!lic) {
      return null;
    }

    if (lic.status === 'banned') {
      throw new Error('This license key has been suspended/banned by an administrator.');
    }

    if (lic.expiry) {
      const expDate = new Date(lic.expiry);
      if (Date.now() > expDate.getTime()) {
        lic.status = 'expired';
        this.saveLicenses();
        throw new Error('This license key has expired.');
      }
    }

    if (lic.status === 'unused') {
      lic.status = 'active';
      lic.usedAt = new Date().toISOString();
      if (!lic.usedBy) {
        lic.usedBy = cleanKey.substring(0, 16);
      }
      if (lic.days > 0 && lic.days < 9999) {
        const exp = new Date();
        exp.setDate(exp.getDate() + lic.days);
        lic.expiry = exp.toISOString();
      }
      if (clientHwid) {
        lic.hwid = clientHwid;
      }
      this.saveLicenses();
      return lic;
    }

    if (lic.hwid && clientHwid) {
      if (lic.hwid.toUpperCase() !== clientHwid.toUpperCase()) {
        throw new Error(`HWID mismatch! This license key is locked to another device.`);
      }
    } else if (!lic.hwid && clientHwid) {
      lic.hwid = clientHwid;
      this.saveLicenses();
    }

    return lic;
  }

  resetHwid(keyOrId) {
    const lic = this.getLicense(keyOrId);
    if (!lic) return false;
    lic.hwid = null;
    lic.boundDevice = null;
    this.saveLicenses();
    logger.info('LICENSE', `Reset HWID binding for license: ${lic.key}`);
    return true;
  }

  updateBotLimit(keyOrId, newLimit) {
    const lic = this.getLicense(keyOrId);
    if (!lic) return false;
    lic.botLimit = Math.max(1, parseInt(newLimit, 10) || 10);
    this.saveLicenses();
    return true;
  }

  getBotLimit(key) {
    if (!key || typeof key !== 'string') return null;
    const lic = this.licenses.find(l => l.key.toUpperCase() === key.trim().toUpperCase());
    return lic ? lic.botLimit : null;
  }

  toggleBan(keyOrId) {
    const lic = this.getLicense(keyOrId);
    if (!lic) return false;
    lic.status = lic.status === 'banned' ? 'active' : 'banned';
    this.saveLicenses();
    return lic.status;
  }

  hasKey(key) {
    if (!key || typeof key !== 'string') return false;
    return this.licenses.some(l => l.key && l.key.toUpperCase() === key.trim().toUpperCase());
  }

  deleteLicense(keyOrId) {
    if (!keyOrId) return null;
    const search = String(keyOrId).toUpperCase();
    const idx = this.licenses.findIndex(l => l.id.toUpperCase() === search || l.key.toUpperCase() === search);
    if (idx === -1) return null;

    const removed = this.licenses.splice(idx, 1)[0];
    // Record permanently deleted key so it can never be resurrected
    if (removed && removed.key) {
      this.deletedKeys.add(removed.key.toUpperCase());
    }
    this.saveLicenses();
    logger.warn('LICENSE', `Permanently deleted license key: ${removed.key} (ID: ${removed.id})`);
    return removed;
  }

  getAll() {
    return this.licenses;
  }

  getLicense(keyOrId) {
    if (!keyOrId) return null;
    const search = String(keyOrId).toUpperCase();
    return this.licenses.find(l => l.id.toUpperCase() === search || l.key.toUpperCase() === search) || null;
  }
}

module.exports = new LicenseManager();
