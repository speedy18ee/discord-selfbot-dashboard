const crypto = require('crypto');
const logger = require('./logger');

/**
 * KeyAuth API Client (v1.3)
 * Integration for Dhanushdhnu390's Application
 */
class KeyAuth {
  constructor({ name, ownerid, version }) {
    this.name = name;
    this.ownerid = ownerid;
    this.version = version;
    this.baseUrl = 'https://keyauth.win/api/1.3/';
    this.sessionId = null;
    this.sessionExpiry = 0;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const initUrl = `${this.baseUrl}?type=init&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&version=${this.version}`;
        const res = await fetch(initUrl);
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.message || 'KeyAuth initialization failed');
        }
        this.sessionId = data.sessionid;
        this.sessionExpiry = Date.now() + 30 * 60 * 1000;
        logger.info('KEYAUTH', `Session initialized successfully (ID: ${this.sessionId})`);
        return this.sessionId;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async getSession() {
    if (this.sessionId && Date.now() < this.sessionExpiry) {
      return this.sessionId;
    }
    return await this.init();
  }

  /**
   * Authenticate a user license key with HWID lock
   * @param {string} key - License key
   * @param {string} hwid - Hardware ID of device
   */
  async loginWithKey(key, hwid) {
    if (!key || typeof key !== 'string') {
      throw new Error('License key is required');
    }
    const cleanKey = key.trim();
    if (!cleanKey) {
      throw new Error('License key cannot be empty');
    }

    // KeyAuth requires HWID to be at least 20 characters
    let validHwid = (hwid && hwid.length >= 20)
      ? hwid
      : crypto.createHash('sha256').update(cleanKey + '_exc_device').digest('hex');

    let sessId = await this.getSession();
    const licenseUrl = `${this.baseUrl}?type=license&key=${encodeURIComponent(cleanKey)}&sessionid=${sessId}&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&hwid=${encodeURIComponent(validHwid)}`;

    let res = await fetch(licenseUrl);
    let data = await res.json();

    // If session expired or invalid on KeyAuth server, refresh session and retry once
    if (!data.success && (data.message?.toLowerCase().includes('session') || data.message?.includes('not valid'))) {
      this.sessionId = null;
      sessId = await this.init();
      const retryUrl = `${this.baseUrl}?type=license&key=${encodeURIComponent(cleanKey)}&sessionid=${sessId}&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&hwid=${encodeURIComponent(validHwid)}`;
      res = await fetch(retryUrl);
      data = await res.json();
    }

    if (!data.success) {
      throw new Error(data.message || 'Invalid or expired license key');
    }

    logger.success('KEYAUTH', `Key verified! Info: ${JSON.stringify(data.info || {})}`);
    return data;
  }
}

// KeyAuth application configured with Dhanushdhnu390's Application credentials
const KeyAuthApp = new KeyAuth({
  name: "Dhanushdhnu390's Application",
  ownerid: "geyPKimqwc",
  version: "1.0"
});

module.exports = KeyAuthApp;
