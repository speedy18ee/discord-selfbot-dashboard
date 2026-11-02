const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');
const sqliteStore = require('./sqliteStore');
const KeyAuthApp = require('./keyauth');
const licenseManager = require('./licenseManager');

const AUTH_SECRET = process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? null
    : 'exc_secret_keyauth_7be0a58b_' + (KeyAuthApp.ownerid || 'geyPKimqwc'));
if (!AUTH_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}

class AuthManager {
  constructor() {
    this.usersFile = path.join(config.dataDir, 'users.json');
    this.sessions = new Map(Object.entries(sqliteStore.getJSON('auth_sessions', {})));
    this.adminSessions = new Set(sqliteStore.getJSON('admin_sessions', []));
    this.init();
  }

  init() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }

    this.users = sqliteStore.getJSON('users', [], this.usersFile).map(u => ({
      ...u,
      botLimit: typeof u.botLimit === 'number' ? u.botLimit : 10
    }));

    // Pre-initialize KeyAuth session in the background
    KeyAuthApp.init().catch(err => {
      logger.warn('AUTH', `Initial KeyAuth background connect: ${err.message}`);
    });
  }

  async syncWithMySQL() {
    await sqliteStore.syncFromMySQL();
    this.users = sqliteStore.getJSON('users', [], this.usersFile).map(u => ({
      ...u,
      botLimit: typeof u.botLimit === 'number' ? u.botLimit : 10
    }));
    this.sessions = new Map(Object.entries(sqliteStore.getJSON('auth_sessions', {})));
    this.adminSessions = new Set(sqliteStore.getJSON('admin_sessions', []));
    logger.success('AUTH', `Loaded ${this.users.length} registered user(s) from persistent storage.`);
  }

  reload() {
    this.users = sqliteStore.getJSON('users', [], this.usersFile).map(u => ({
      ...u,
      botLimit: typeof u.botLimit === 'number' ? u.botLimit : 10
    }));
    this.sessions = new Map(Object.entries(sqliteStore.getJSON('auth_sessions', {})));
    this.adminSessions = new Set(sqliteStore.getJSON('admin_sessions', []));
    return this.users;
  }

  loadJSON(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (e) {
      logger.error('AUTH', `Failed to load ${filePath}: ${e.message}`);
    }
    return fallback;
  }

  saveUsers(triggerSync = true) {
    try {
      sqliteStore.setJSON('users', this.users);
    } catch (e) {
      logger.error('AUTH', `Failed to save users: ${e.message}`);
    }
  }

  saveSessions() {
    sqliteStore.setJSON('auth_sessions', Object.fromEntries(this.sessions));
  }

  /**
   * Authenticate user via KeyAuth License Key
   * @param {string} key - KeyAuth license key
   * @param {string} clientHwid - Hardware ID
   * @param {object} deviceInfo - Client browser/platform details
   */
  async loginWithKey(key, clientHwid, deviceInfo = {}) {
    if (!key || typeof key !== 'string' || !key.trim()) {
      throw new Error('Please enter your KeyAuth license key');
    }

    const cleanKey = key.trim();

    // 0. Check EXC Internal KeyAuth License Manager first
    const localLic = licenseManager.validateLicense(cleanKey, clientHwid);
    if (localLic) {
      const userId = 'usr_' + crypto.createHash('sha256').update(cleanKey.toLowerCase()).digest('hex').substring(0, 16);
      let user = this.users.find(u => u.id === userId || (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()));
      if (!user) {
        user = {
          id: userId,
          username: cleanKey.substring(0, 16),
          key: cleanKey,
          hwid: localLic.hwid,
          botLimit: localLic.botLimit || 10,
          status: localLic.status || 'active',
          subscription: `${localLic.botLimit} Bots Tier`,
          expiry: localLic.expiry || null,
          boundDevice: deviceInfo || {},
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString()
        };
        this.users.push(user);
      } else {
        user.botLimit = localLic.botLimit || user.botLimit || 10;
        user.hwid = localLic.hwid || user.hwid;
        user.status = localLic.status;
        user.expiry = localLic.expiry;
        user.lastLogin = new Date().toISOString();
      }
      this.saveUsers();

      const sessionData = {
        userId: user.id,
        username: user.username,
        key: cleanKey,
        hwid: user.hwid,
        botLimit: user.botLimit,
        subscription: user.subscription,
        expiry: user.expiry,
        status: user.status,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
      };

      const token = this.createSignedToken(sessionData);
      this.sessions.set(token, sessionData);
      this.saveSessions();
      logger.success('AUTH', `User "${user.username}" authenticated via EXC Licensing (License: ${cleanKey.substring(0, 8)}... | Limit: ${user.botLimit} bots)`);

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          key: cleanKey,
          hwid: user.hwid,
          botLimit: user.botLimit,
          subscription: user.subscription,
          expiry: user.expiry,
          status: user.status
        }
      };
    }

    // Check if we already have this user in memory or database
    let existingUser = this.users.find(u =>
      (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()) ||
      (u.username && u.username.toLowerCase() === cleanKey.toLowerCase()) ||
      (u.id && u.id.toLowerCase() === cleanKey.toLowerCase())
    );

    // Primary HWID attempt: use client HWID or fallback to registered HWID
    const primaryHwid = (clientHwid && clientHwid.length >= 20)
      ? clientHwid
      : (existingUser?.hwid || 'HWID-2EB757AB171C81CEC48072C8D035EE4A');

    // 1. Validate with KeyAuth API (with automatic HWID recovery)
    let authResult;
    try {
      authResult = await KeyAuthApp.loginWithKey(cleanKey, primaryHwid);
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('hwid')) {
        const fallbackHwid = existingUser?.hwid || 'HWID-2EB757AB171C81CEC48072C8D035EE4A';
        logger.info('AUTH', `KeyAuth reported HWID mismatch. Retrying with registered HWID ${fallbackHwid}...`);
        authResult = await KeyAuthApp.loginWithKey(cleanKey, fallbackHwid);
      } else {
        throw err;
      }
    }
    const info = authResult.info || {};

    const keyUsername = info.username || cleanKey.substring(0, 16);
    const subscriptions = info.subscriptions || [];
    const activeSub = subscriptions[0] || {};
    const subName = activeSub.subscription || 'Default';
    const expiry = activeSub.expiry || info.expiry || null;

    // 2. Determine bot quota for this key:
    let botLimit = config.defaultBotLimit || parseInt(process.env.DEFAULT_BOT_LIMIT, 10) || 10;

    // A. Check data/user_limits.json mapping
    try {
      const limitsPath = path.join(config.dataDir, 'user_limits.json');
      if (fs.existsSync(limitsPath)) {
        const limitsMap = JSON.parse(fs.readFileSync(limitsPath, 'utf8'));
        const matched = limitsMap[cleanKey] || limitsMap[cleanKey.toLowerCase()] || limitsMap[keyUsername];
        if (typeof matched === 'number') {
          botLimit = matched;
        }
      }
    } catch (_) {}

    // B. Check if key itself contains a bot limit tag (e.g. KEY-...-25B, KEY-..._50, or KEY-...-UNL)
    const keyLimitMatch = cleanKey.match(/(?:-|_|\s)(\d+)(?:b|bots?)?(?:$|-|_)/i);
    if (keyLimitMatch) {
      botLimit = parseInt(keyLimitMatch[1], 10);
    } else if (/(?:-|_)(?:unl|unlimited)/i.test(cleanKey)) {
      botLimit = 100;
    }

    // C. Check KeyAuth subscription level (if present)
    const subMatch = (subName || '').match(/(\d+)\s*bots?/i);
    if (subMatch) {
      botLimit = parseInt(subMatch[1], 10);
    } else if (/unlimited/i.test(subName)) {
      botLimit = 100;
    } else if (typeof info.botLimit === 'number') {
      botLimit = info.botLimit;
    }

    // D. Check if user already exists with an admin-assigned bot limit
    if (existingUser && typeof existingUser.botLimit === 'number' && existingUser.botLimit !== 10) {
      botLimit = existingUser.botLimit;
    }

    // 3. Deterministic user ID for this license key
    const userId = 'usr_' + crypto.createHash('sha256').update(cleanKey.toLowerCase()).digest('hex').substring(0, 16);

    const activeHwid = authResult.info?.hwid || primaryHwid;

    // 4. Update or register local user cache
    let user = this.users.find(u => u.id === userId || (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()));
    if (!user) {
      user = {
        id: userId,
        username: keyUsername,
        key: cleanKey,
        hwid: activeHwid,
        botLimit: botLimit,
        status: 'active',
        subscription: subName,
        expiry: expiry,
        boundDevice: {
          platform: deviceInfo.platform || 'Unknown',
          browser: deviceInfo.browser || 'Unknown',
          screen: deviceInfo.screen || 'Unknown',
          boundAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      this.users.push(user);
    } else {
      user.username = keyUsername;
      user.key = cleanKey;
      user.hwid = activeHwid;
      user.botLimit = botLimit;
      user.subscription = subName;
      user.expiry = expiry;
      user.lastLogin = new Date().toISOString();
      if (!user.boundDevice) {
        user.boundDevice = {
          platform: deviceInfo.platform || 'Unknown',
          browser: deviceInfo.browser || 'Unknown',
          screen: deviceInfo.screen || 'Unknown',
          boundAt: new Date().toISOString()
        };
      }
    }

    this.saveUsers();

    // 5. Issue persistent cryptographic session token (valid 7 days, works across any serverless container)
    const sessionData = {
      userId: user.id,
      username: user.username,
      key: cleanKey,
      hwid: user.hwid,
      botLimit: user.botLimit,
      subscription: user.subscription,
      expiry: user.expiry,
      status: user.status,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
    };

    const token = this.createSignedToken(sessionData);
    this.sessions.set(token, sessionData);
    this.saveSessions();

    logger.success('AUTH', `User "${user.username}" authenticated via KeyAuth (License: ${cleanKey.substring(0, 8)}... | Limit: ${botLimit} bots)`);

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        key: cleanKey,
        hwid: user.hwid,
        botLimit: user.botLimit,
        subscription: user.subscription,
        expiry: user.expiry,
        status: user.status
      }
    };
  }

  createSignedToken(sessionData) {
    const payloadStr = JSON.stringify(sessionData);
    const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');
    return `exc_usr_${payloadB64}.${sig}`;
  }

  // Legacy fallback
  async login(username, password, clientHwid, deviceInfo = {}) {
    const key = username || password;
    return this.loginWithKey(key, clientHwid, deviceInfo);
  }

  verifySession(token) {
    if (!token || typeof token !== 'string') return null;

    // 1. Check in-memory cache first
    let session = this.sessions.get(token);

    // 2. If not in memory (fresh serverless container), verify cryptographic signature
    if (!session && token.startsWith('exc_usr_')) {
      const raw = token.substring(8);
      const parts = raw.split('.');
      if (parts.length === 2) {
        const [payloadB64, sig] = parts;
        const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');
        if (sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
          try {
            const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
            if (payload && (!payload.expiresAt || Date.now() <= payload.expiresAt)) {
              session = payload;
              this.sessions.set(token, session);
              this.saveSessions();
            }
          } catch (_) {}
        }
      }
    }

    if (!session) return null;
    if (session.expiresAt && Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      this.saveSessions();
      return null;
    }

    const liveUser = this.users.find(u => u.id === session.userId);
    const licenseBotLimit = licenseManager.getBotLimit(session.key);
    if (licenseBotLimit !== null) {
      session.botLimit = licenseBotLimit;
    } else if (liveUser && typeof liveUser.botLimit === 'number' && liveUser.botLimit !== 10) {
      session.botLimit = liveUser.botLimit;
    } else {
      session.botLimit = session.botLimit || liveUser?.botLimit || 10;
    }

    if (liveUser) {
      session.status = liveUser.status || session.status || 'active';
      session.subscription = liveUser.subscription || session.subscription || 'default';
    }
    return session;
  }

  logout(token) {
    this.sessions.delete(token);
    this.saveSessions();
  }

  adminLogin(password) {
    const expectedPassword = process.env.ADMIN_PASSWORD;
    if (!expectedPassword) {
      throw new Error('Admin login is not configured. Set ADMIN_PASSWORD in the hosting environment.');
    }

    const supplied = Buffer.from(String(password || ''));
    const expected = Buffer.from(expectedPassword);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw new Error('Invalid admin password');
    }

    const token = `exc_adm_${crypto.randomBytes(32).toString('hex')}`;
    this.adminSessions.add(token);
    sqliteStore.setJSON('admin_sessions', [...this.adminSessions]);
    return { token };
  }

  verifyAdminSession(token) {
    return typeof token === 'string' && this.adminSessions.has(token);
  }

  adminLogout(token) {
    this.adminSessions.delete(token);
    sqliteStore.setJSON('admin_sessions', [...this.adminSessions]);
  }
}

module.exports = new AuthManager();
