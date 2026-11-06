// === SELF-BOOTSTRAP & SELF-HEALING ===
;(function() {
  const fs = require('fs');
  const path = require('path');

  // 1. Enforce correct Pterodactyl port
  const targetPort = String(process.env.SERVER_PORT || process.env.PORT || '24681');
  process.env.PORT = targetPort;
  process.env.SERVER_PORT = targetPort;

  // 2. Self-heal any Windows backslash files created during unzip on Linux
  try {
    const rootItems = fs.readdirSync(__dirname);
    for (const item of rootItems) {
      if (item.includes('\\')) {
        const parts = item.split('\\');
        const targetDir = path.join(__dirname, ...parts.slice(0, -1));
        const targetPath = path.join(__dirname, ...parts);
        try {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(path.join(__dirname, item), targetPath);
        } catch(e) {}
      }
    }
  } catch(e) {}

  // 3. Ensure required directories
  try {
    fs.mkdirSync(path.join(__dirname, 'src'), { recursive: true });
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
    fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });

    // Copy any css, js, assets from root to public if exists
    ['css', 'js', 'assets', 'dashboard', 'admin', 'login'].forEach(d => {
      const s = path.join(__dirname, d);
      const t = path.join(__dirname, 'public', d);
      if (fs.existsSync(s) && !fs.existsSync(t)) {
        try { fs.cpSync(s, t, { recursive: true }); } catch(e) {}
      }
    });
  } catch(e) {}

  console.log('[BOOT] Directories verified, port bound to: ' + targetPort);
})();
// === END BOOTSTRAP ===
function resolveWebFile(filename) {
  const p1 = path.join(__dirname, 'public', filename);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(__dirname, filename);
  if (fs.existsSync(p2)) return p2;
  return p1;
}
require('./src/patch');
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('./src/config');
const database = require('./src/database');
const sqliteStore = require('./src/sqliteStore');
const logger = require('./src/logger');
const authManager = require('./src/authManager');
const licenseManager = require('./src/licenseManager');
const LavalinkClient = require('./src/lavalinkClient');
const BotManager = require('./src/botManager');

function migrateLicenseOwnedAccounts() {
  let migrated = 0;
  for (const account of database.accounts) {
    const license = licenseManager.getAll().find(entry =>
      entry.id === account.ownerId ||
      entry.key.toUpperCase() === String(account.ownerId || '').toUpperCase()
    );
    if (!license) continue;

    account.ownerId = 'usr_' + crypto.createHash('sha256')
      .update(license.key.toLowerCase())
      .digest('hex')
      .substring(0, 16);
    account.ownerUsername = license.key;
    migrated++;
  }

  if (migrated > 0) {
    database.saveJSON(config.accountsFile, database.accounts, false);
    logger.info('DB', `Migrated ${migrated} CloudWave account owner record(s) to license user IDs.`);
  }
}

migrateLicenseOwnedAccounts();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const fs = require('fs');
fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.static(__dirname, { index: false }));

// Main Pages: Login, Dashboard & Credentials
app.get('/', (req, res) => {
  res.sendFile(resolveWebFile('login.html'));
});

app.get('/login', (req, res) => res.sendFile(resolveWebFile('login.html')));
app.get('/login.html', (req, res) => res.sendFile(resolveWebFile('login.html')));

app.get('/dashboard', (req, res) => res.sendFile(resolveWebFile('dashboard.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(resolveWebFile('dashboard.html')));
app.get('/index.html', (req, res) => res.sendFile(resolveWebFile('dashboard.html')));

app.get('/credentials', (req, res) => res.sendFile(resolveWebFile('admin.html')));
app.get('/credentials.html', (req, res) => res.sendFile(resolveWebFile('admin.html')));
app.get('/admin', (req, res) => res.sendFile(resolveWebFile('admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(resolveWebFile('admin.html')));

// --- AUTH MIDDLEWARE ---
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token || req.headers['x-access-token']);
  const session = authManager.verifySession(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please login to EXC.' });
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.adminToken || req.headers['x-admin-token']);
  if (!authManager.verifyAdminSession(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized admin access' });
  }
  next();
}

function getAdminUsers() {
  const accounts = database.accounts || [];
  return licenseManager.getAll().map(license => {
    const userId = 'usr_' + crypto.createHash('sha256')
      .update(license.key.toLowerCase())
      .digest('hex')
      .substring(0, 16);
    return {
      id: license.id,
      username: license.key,
      key: license.key,
      hwid: license.hwid || null,
      boundDevice: license.boundDevice || null,
      botLimit: license.botLimit || 10,
      status: license.status || 'unused',
      note: license.note || '',
      isBound: Boolean(license.hwid),
      activeBots: accounts.filter(account => account.ownerId === userId || account.ownerId === license.id).length,
      createdAt: license.createdAt,
      lastLogin: license.usedAt
    };
  });
}

// --- PUBLIC AUTH ENDPOINTS ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { key, licenseKey, username, password, hwid, deviceInfo } = req.body;
    const result = await authManager.login(key || licenseKey || username, password, hwid, deviceInfo);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token) authManager.logout(token);
  res.json({ success: true });
});

// Health check endpoints
app.get(['/api/ping', '/healthz'], (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// --- ADMIN MANAGEMENT ENDPOINTS ---
app.post('/api/admin/login', (req, res) => {
  try {
    const { adminKey, password } = req.body;
    const result = authManager.adminLogin(adminKey || password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token) authManager.adminLogout(token);
  res.json({ success: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ success: true, users: getAdminUsers() });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const licenses = licenseManager.getAll();
  res.json({
    success: true, stats: {
      totalLicenses: licenses.length,
      totalUsers: licenses.filter(license => license.status === 'active').length,
      unusedLicenses: licenses.filter(license => license.status === 'unused').length,
      onlineBots: (database.accounts || []).filter(account => account.status === 'online').length
    }
  });
});

// Unified permanent key/user deletion with immediate logout & bot cleanup
async function handlePermanentDeleteKeyOrUser(keyOrId) {
  if (!keyOrId) throw new Error('Target ID or key required');

  // 1. Delete license from LicenseManager (checks by id or key)
  const removedLic = licenseManager.deleteLicense(keyOrId);
  const targetKey = removedLic ? removedLic.key : keyOrId;

  // 2. Invalidate sessions and delete matching users in AuthManager
  const authPurge = authManager.invalidateKey(targetKey);
  if (removedLic && removedLic.id !== targetKey) {
    authManager.invalidateKey(removedLic.id);
  }
  if (keyOrId !== targetKey) {
    authManager.invalidateKey(keyOrId);
  }

  const affectedUserIds = new Set(authPurge.affectedUserIds || []);
  const affectedKeys = new Set(authPurge.affectedKeys || []);
  if (targetKey) affectedKeys.add(String(targetKey).toUpperCase());
  if (removedLic && removedLic.key) affectedKeys.add(removedLic.key.toUpperCase());

  // 3. Immediately kick out any connected WebSocket client matching this key or user
  wss.clients.forEach(client => {
    const matchUser = client.userId && (affectedUserIds.has(client.userId) || client.userId === keyOrId);
    const matchKey = client.key && (affectedKeys.has(client.key.toUpperCase()) || client.key.toUpperCase() === String(keyOrId).toUpperCase());
    if (matchUser || matchKey) {
      try {
        client.send(JSON.stringify({
          type: 'logout',
          data: { reason: 'Your license key was permanently deleted by an administrator.' }
        }));
        client.close(4001, 'License key deleted');
      } catch (_) {}
    }
  });

  // 4. Stop all running bots and clean up accounts belonging to affected user(s)
  for (const uid of affectedUserIds) {
    try {
      if (global.botManager) {
        await global.botManager.stopAll(uid);
      }
      database.deleteAccountsByOwner(uid);
    } catch (e) {
      logger.warn('BOT', `Error cleaning accounts for deleted user ${uid}: ${e.message}`);
    }
  }

  // 5. Broadcast to admin sockets so admin dashboard updates live
  broadcast('adminKeyDeleted', { key: targetKey, userIds: Array.from(affectedUserIds) });

  return { success: true, removedLicense: removedLic, purged: authPurge };
}

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json({ success: true, licenses: licenseManager.getAll() });
});

app.post('/api/admin/licenses', requireAdmin, async (req, res) => {
  try {
    const { action = 'create', id, amount, mask, days, botLimit, note } = req.body;
    if (action === 'create') {
      const licenses = licenseManager.createLicenses({ amount, mask, days, botLimit, note });
      return res.json({ success: true, count: licenses.length, licenses });
    }

    if (action === 'limit') {
      if (!licenseManager.updateBotLimit(id, botLimit)) throw new Error('License not found');
      return res.json({ success: true, botLimit: licenseManager.getBotLimit(id) });
    }
    if (action === 'hwid') {
      if (!licenseManager.resetHwid(id)) throw new Error('License not found');
      return res.json({ success: true });
    }
    if (action === 'ban') {
      const status = licenseManager.toggleBan(id);
      if (!status) throw new Error('License not found');
      return res.json({ success: true, status });
    }
    if (action === 'delete') {
      await handlePermanentDeleteKeyOrUser(id);
      return res.json({ success: true, message: 'License key permanently deleted and active sessions logged out.' });
    }
    throw new Error('Unsupported license action');
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { action, id, botLimit } = req.body;
    if (action === 'limit') {
      if (!licenseManager.updateBotLimit(id, botLimit)) throw new Error('License not found');
      return res.json({ success: true, botLimit: licenseManager.getBotLimit(id) });
    }
    if (action === 'hwid') {
      if (!licenseManager.resetHwid(id)) throw new Error('License not found');
      return res.json({ success: true });
    }
    if (action === 'delete') {
      await handlePermanentDeleteKeyOrUser(id);
      return res.json({ success: true, message: 'User account and license permanently deleted and active sessions logged out.' });
    }
    throw new Error('Unsupported user action');
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/limit', requireAdmin, (req, res) => {
  try {
    const { limit } = req.body;
    if (!licenseManager.updateBotLimit(req.params.id, limit)) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    const user = licenseManager.getAll().find(license => license.id === req.params.id);
    broadcast('userLimitUpdated', { userId: req.params.id, username: user.key, botLimit: user.botLimit });
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/reset-hwid', requireAdmin, (req, res) => {
  try {
    if (!licenseManager.resetHwid(req.params.id)) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users/:id/toggle', requireAdmin, (req, res) => {
  try {
    const status = licenseManager.toggleBan(req.params.id);
    if (!status) return res.status(404).json({ success: false, error: 'License not found' });
    res.json({ success: true, status });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await handlePermanentDeleteKeyOrUser(req.params.id);
    res.json({ success: true, message: 'User permanently deleted and sessions terminated.' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Initialize Lavalink & Bot Manager
const currentSavedSettings = database.getSettings();
let lavalinkNode = currentSavedSettings?.lavalink;
if (!lavalinkNode || !lavalinkNode.url || lavalinkNode.url === 'lavalink.server.url' || lavalinkNode.auth === 'youshallnotpass' || String(lavalinkNode.url).includes('visihost.in')) {
  lavalinkNode = { ...config.defaultNode };
  database.updateSettings({ lavalink: lavalinkNode });
}
const lavalink = new LavalinkClient(lavalinkNode);
const botManager = new BotManager(lavalink);
global.botManager = botManager;
const voiceMusicEngine = require('./src/voiceMusicEngine');
global.voiceMusicEngine = voiceMusicEngine;

// Start Lavalink connection
lavalink.connect();

// Broadcast to connected WebSocket clients (respects user isolation)
function broadcast(type, data, targetOwnerId = null) {
  const payload = JSON.stringify({ type, data });
  const ownerId = targetOwnerId || data?.ownerId || data?.player?.ownerId || null;

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      // If message is targeted to a specific owner, only send to matching authenticated client
      if (ownerId && (!client.userId || client.userId !== ownerId)) {
        return;
      }
      client.send(payload);
    }
  });
}

// Wire up events to WebSocket broadcast with owner isolation
logger.on('log', entry => broadcast('log', entry));
logger.on('cleared', () => broadcast('logsCleared', {}));

lavalink.on('stats', stats => broadcast('lavalinkStats', stats));
lavalink.on('ready', session => broadcast('lavalinkReady', session));
lavalink.on('disconnect', () => broadcast('lavalinkDisconnect', {}));
lavalink.on('playerUpdate', player => broadcast('playerUpdate', player, player.ownerId));
lavalink.on('trackStart', data => broadcast('trackStart', data, data.ownerId || data.player?.ownerId));
lavalink.on('queueUpdate', player => broadcast('queueUpdate', player, player.ownerId));
lavalink.on('queueEnd', player => broadcast('queueEnd', player, player.ownerId));

botManager.on('botStatus', data => {
  const acc = database.getAccount(data.accountId);
  broadcast('botStatus', { ...data, ownerId: acc?.ownerId });
});
botManager.on('botVoice', data => {
  const acc = database.getAccount(data.accountId);
  broadcast('botVoice', { ...data, ownerId: acc?.ownerId });
});

// --- REST API ENDPOINTS ---
app.use('/api/accounts', requireAuth);
app.use('/api/music', (req, res, next) => {
  // Allow searching music freely without 401 blocking
  if (req.path === '/search' || req.path === '/search/') return next();
  return requireAuth(req, res, next);
});
app.use('/api/actions', requireAuth);
app.use('/api/guilds', requireAuth);

// 1. Accounts API (Strictly Partitioned by User Credentials)
// MongoDB Atlas Status Endpoint
app.get('/api/database/status', (req, res) => {
  res.json({ success: true, ...sqliteStore.getStatus() });
});

app.post('/api/system/restart', (req, res) => {
  res.json({ success: true, message: 'Server process restarting...' });
  setTimeout(() => {
    process.exit(0);
  }, 400);
});

app.get('/api/accounts', async (req, res) => {
  const accounts = botManager.getAllBotsStatus(req.user.userId);
  res.json({
    success: true,
    accounts,
    accountCount: accounts.length,
    botLimit: req.user.botLimit
  });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { token, label, autoStart, proxy } = req.body;
    if (!token || !token.trim()) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    // Enforce bot limit per credentials (e.g. 10 bots limit) for this specific user
    const maxLimit = (req.user && typeof req.user.botLimit === 'number') ? req.user.botLimit : 10;
    const userAccounts = database.getAccounts(req.user.userId);
    if (userAccounts.length >= maxLimit) {
      return res.status(400).json({
        success: false,
        code: 'BOT_LIMIT_REACHED',
        currentCount: userAccounts.length,
        botLimit: maxLimit,
        error: `Bot limit reached! Your login credentials allow a maximum of ${maxLimit} bots (Currently using: ${userAccounts.length}/${maxLimit}).`
      });
    }

    const newAcc = database.addAccount({
      token,
      label,
      proxy: proxy ? proxy.trim() : null,
      autoStart,
      ownerId: req.user.userId,
      ownerUsername: req.user.username
    });
    logger.success('DASHBOARD', `User [${req.user.username}] added account: ${newAcc.label} (${userAccounts.length + 1}/${maxLimit})`);

    // Auto-start if requested
    if (newAcc.autoStart !== false) {
      botManager.startAccount(newAcc.id).catch(e => {
        logger.error('BOT', `Initial start failed: ${e.message}`);
      });
    }

    res.json({ success: true, account: newAcc });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Mass Token Import / Token Manager (Paste all tokens at once)
app.post('/api/accounts/mass', async (req, res) => {
  try {
    const { tokens, autoStart = true } = req.body;
    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ success: false, error: 'Tokens array is required' });
    }

    const maxLimit = (req.user && typeof req.user.botLimit === 'number') ? req.user.botLimit : 10;
    const currentAccounts = database.getAccounts(req.user.userId);
    const availableSlots = Math.max(0, maxLimit - currentAccounts.length);

    if (availableSlots <= 0) {
      return res.status(400).json({
        success: false,
        code: 'BOT_LIMIT_REACHED',
        currentCount: currentAccounts.length,
        botLimit: maxLimit,
        error: `Bot limit reached! Your credentials allow a maximum of ${maxLimit} bots (Currently using: ${currentAccounts.length}/${maxLimit}).`
      });
    }

    const added = [];
    const skipped = [];
    const errors = [];

    const existingTokens = new Set(currentAccounts.map(a => a.token.trim()));
    const existingUserIds = new Set();
    currentAccounts.forEach(a => {
      try {
        const payload = a.token.split('.')[0];
        const uid = Buffer.from(payload, 'base64').toString('utf8');
        if (/^\d{17,20}$/.test(uid)) existingUserIds.add(uid);
      } catch (e) {}
    });

    const seenInBatch = new Set();

    for (let i = 0; i < tokens.length; i++) {
      if (added.length >= availableSlots) {
        skipped.push({ token: tokens[i], reason: `Quota limit (${maxLimit}) reached` });
        continue;
      }

      const rawToken = typeof tokens[i] === 'string' ? tokens[i].trim() : (tokens[i]?.token || '').trim();
      if (!rawToken || rawToken.length < 25) continue;

      const tokenParts = rawToken.split('.');
      if (tokenParts.length < 3) {
        errors.push({ token: rawToken, reason: 'Invalid token format (must have 3 parts separated by dots)' });
        continue;
      }

      let tokenUid = null;
      try {
        const decoded = Buffer.from(tokenParts[0], 'base64').toString('utf8');
        if (/^\d{17,20}$/.test(decoded)) tokenUid = decoded;
      } catch (e) {}

      if (tokenUid && (existingUserIds.has(tokenUid) || seenInBatch.has(tokenUid))) {
        skipped.push({ token: rawToken, reason: `Account already added (Discord User ID: ${tokenUid})` });
        continue;
      }

      if (existingTokens.has(rawToken) || seenInBatch.has(rawToken)) {
        skipped.push({ token: rawToken, reason: 'Duplicate token' });
        continue;
      }

      if (tokenUid) seenInBatch.add(tokenUid);
      seenInBatch.add(rawToken);

      try {
        const defaultLabel = `Bot ${currentAccounts.length + added.length + 1}`;
        const label = (typeof tokens[i] === 'object' && tokens[i]?.label) ? tokens[i].label : defaultLabel;
        const newAcc = database.addAccount({
          token: rawToken,
          label,
          proxy: null,
          autoStart: autoStart !== false,
          ownerId: req.user.userId,
          ownerUsername: req.user.username
        });

        existingTokens.add(rawToken);
        if (tokenUid) existingUserIds.add(tokenUid);
        added.push(newAcc);

        if (newAcc.autoStart !== false) {
          // Start all tokens at 1 time itself
          botManager.startAccount(newAcc.id).catch(e => {
            logger.error('BOT', `Mass initial start failed: ${e.message}`);
          });
        }
      } catch (err) {
        errors.push({ token: rawToken, reason: err.message });
      }
    }

    logger.success('DASHBOARD', `User [${req.user.username}] mass-added ${added.length} accounts (${skipped.length} skipped, ${errors.length} errors)`);

    res.json({
      success: true,
      addedCount: added.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
      added,
      skipped,
      errors
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all saved tokens for this user (for Token Manager Load)
app.get('/api/accounts/tokens', (req, res) => {
  try {
    const accounts = database.getAccounts(req.user.userId);
    const tokens = accounts.map(a => a.token).filter(Boolean);
    res.json({ success: true, count: tokens.length, tokens });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const acc = database.getAccount(id, req.user.userId);
    if (!acc) {
      return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    }
    await botManager.stopAccount(id);
    database.removeAccount(id, req.user.userId);
    logger.info('DASHBOARD', `User [${req.user.username}] removed account: ${id}`);
    broadcast('accountRemoved', { id, ownerId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/start', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.startAccount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/stop', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.stopAccount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/start-all', async (req, res) => {
  await botManager.startAll(req.user.userId);
  res.json({ success: true });
});

app.post('/api/accounts/stop-all', async (req, res) => {
  await botManager.stopAll(req.user.userId);
  res.json({ success: true });
});

// Mass Voice: Join ALL accounts to a Voice Channel & Enable 24/7
app.post('/api/accounts/voice/join-all', async (req, res) => {
  try {
    const { channelId, guildId, keep247, selfMute, selfDeaf } = req.body;
    if (!channelId || !channelId.trim()) {
      return res.status(400).json({ success: false, error: 'Voice Channel ID is required' });
    }
    const result = await botManager.joinAllToVoice(req.user.userId, channelId.trim(), {
      guildId,
      keep247: keep247 !== false,
      selfMute: !!selfMute,
      selfDeaf: !!selfDeaf
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mass Voice: Leave ALL accounts from Voice
app.post('/api/accounts/voice/leave-all', async (req, res) => {
  try {
    const { disable247 = true } = req.body;
    const result = await botManager.leaveAllVoice(req.user.userId, disable247);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Camera feature removed per request
app.post('/api/accounts/:id/camera', (req, res) => res.json({ success: true, message: 'WebCam feature disabled' }));
app.post('/api/accounts/camera/all', (req, res) => res.json({ success: true, message: 'WebCam feature disabled' }));

app.post('/api/accounts/:id/presence', (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { status, activity } = req.body;
    botManager.setStatus(req.params.id, status, activity);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/accounts/:id/guilds', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const guilds = await botManager.getGuildsAndChannels(req.params.id);
    res.json({ success: true, guilds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get deduplicated summary of all joined servers across online bots
app.get('/api/guilds/all', requireAuth, (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const guilds = botManager.getAllGuildsSummary(userId);
    res.json({ success: true, guilds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Permanent Server Leave for a Single Bot (with proxy rotation & 24/7 cleanup)
app.post('/api/accounts/:id/guilds/:guildId/leave', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const acc = database.getAccount(req.params.id, userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const useProxy = req.body.useProxy !== false;
    const result = await botManager.leaveGuild(req.params.id, req.params.guildId, { useProxy });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Permanent Server Leave for ALL BOTS (Mass Leave with proxy rotation & jitter stagger)
app.post('/api/guilds/:guildId/leave-all', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.userId || null;
    const useProxy = req.body.useProxy !== false;
    const result = await botManager.leaveGuildAllBots(userId, req.params.guildId, { useProxy });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Voice & 24/7 API
app.post('/api/accounts/:id/voice/join', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { channelId, selfMute, selfDeaf } = req.body;
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'Voice channel ID is required' });
    }
    const voiceState = await botManager.joinVoice(req.params.id, channelId, { selfMute, selfDeaf });
    res.json({ success: true, voiceState });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/voice/leave', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    await botManager.leaveVoice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/:id/voice/247', async (req, res) => {
  try {
    const acc = database.getAccount(req.params.id, req.user.userId);
    if (!acc) return res.status(404).json({ success: false, error: 'Account not found or access denied.' });
    const { enabled, guildId, channelId, selfMute, selfDeaf } = req.body;
    const config = await botManager.set247(req.params.id, {
      enabled,
      guildId,
      channelId,
      selfMute,
      selfDeaf
    });
    res.json({ success: true, voice247: config });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Lavalink & Music API
app.get('/api/lavalink/status', (req, res) => {
  res.json({
    success: true,
    node: {
      name: lavalink.name,
      host: lavalink.host,
      port: lavalink.port,
      secure: lavalink.secure,
      connected: lavalink.connected,
      sessionId: lavalink.sessionId,
      stats: lavalink.stats
    }
  });
});

app.post('/api/lavalink/config', async (req, res) => {
  try {
    const { url, name, auth, password, secure, host, port } = req.body;
    const finalAuth = auth || password || lavalink.auth;
    const finalUrl = url || (host ? `${host}:${port || 443}` : `${lavalink.host}:${lavalink.port}`);
    const newConfig = {
      url: finalUrl,
      name: name || lavalink.name,
      auth: finalAuth,
      secure: !!secure
    };

    database.updateSettings({ lavalink: newConfig });
    lavalink.updateConfig(newConfig, true);

    logger.success('LAVALINK', `Node settings updated: ${newConfig.name} (${newConfig.url})`);
    res.json({ success: true, config: newConfig });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/music/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, error: 'Query parameter q required' });

    // 1. Primary: Load via connected Lavalink node
    try {
      const result = await lavalink.loadTracks(q);
      if (result && result.tracks && result.tracks.length > 0) {
        return res.json({ success: true, result });
      }
    } catch (_) {}

    // 2. Fallback 1: Direct Lavalink node queries (Serenetia & Millohost)
    const https = require('https');
    const directSearch = (nodeUrl, auth) => new Promise((resolve) => {
      const isDirectUrl = /^https?:\/\//i.test(q);
      const identifier = isDirectUrl ? q : `ytsearch:${q}`;
      const req = https.get(`${nodeUrl}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`, {
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
        timeout: 4000
      }, resp => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try {
            const data = JSON.parse(body);
            let tracks = [];
            if (data.loadType === 'track') tracks = [data.data];
            else if (data.loadType === 'search') tracks = Array.isArray(data.data) ? data.data : [];
            else if (data.loadType === 'playlist') tracks = data.data?.tracks || [];
            resolve(tracks.map(t => ({
              encoded: t.encoded,
              info: {
                title: t.info?.title || 'Unknown Title',
                author: t.info?.author || 'Unknown Artist',
                length: t.info?.length || 0,
                identifier: t.info?.identifier || identifier,
                isSeekable: true,
                isStream: false,
                uri: t.info?.uri || identifier,
                artworkUrl: t.info?.artworkUrl || null
              }
            })));
          } catch (_) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });

    let tracks = await directSearch('https://lavalinkv4.serenetia.com', 'https://dsc.gg/ajidevserver');
    if (!tracks || tracks.length === 0) {
      tracks = await directSearch('https://lava-v4.millohost.my.id', 'https://discord.gg/mjS5J2K3ep');
    }

    if (tracks && tracks.length > 0) {
      return res.json({ success: true, result: { loadType: 'search', tracks } });
    }

    // 3. Fallback 2: iTunes API Search (guaranteed reliable music database)
    const itunesTracks = await new Promise((resolve) => {
      const itunesReq = https.get(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=10`, { timeout: 4000 }, resp => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try {
            const data = JSON.parse(body);
            const list = (data.results || []).map(r => ({
              encoded: 'itunes_' + Buffer.from(r.previewUrl || '').toString('base64'),
              info: {
                title: r.trackName || 'Song',
                author: r.artistName || 'Artist',
                length: r.trackTimeMillis || 30000,
                identifier: r.previewUrl,
                isSeekable: true,
                isStream: false,
                uri: r.previewUrl,
                artworkUrl: r.artworkUrl100 || r.artworkUrl60
              }
            }));
            resolve(list);
          } catch (_) { resolve([]); }
        });
      });
      itunesReq.on('error', () => resolve([]));
      itunesReq.on('timeout', () => { itunesReq.destroy(); resolve([]); });
    });

    if (itunesTracks && itunesTracks.length > 0) {
      return res.json({ success: true, result: { loadType: 'search', tracks: itunesTracks } });
    }

    // Direct fallback item if user entered a custom query or url
    res.json({
      success: true,
      result: {
        loadType: 'search',
        tracks: [{
          encoded: 'custom_audio',
          info: {
            title: q,
            author: 'Custom Audio Stream',
            length: 0,
            identifier: q,
            isSeekable: false,
            isStream: true,
            uri: q
          }
        }]
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Custom Voice Recording & MP3 Audio Play/Queue Endpoint
app.post('/api/music/custom-audio', async (req, res) => {
  try {
    const { audioBase64, audioUrl: rawAudioUrl, filename, title, mode, accountId, guildId, channelId } = req.body;
    const ownerId = req.user.userId;
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');

    // 1. Resolve target guild and voice channel automatically
    let targetGuildId = guildId;
    let targetChannelId = channelId;
    let targetBot = null;

    if (accountId && accountId !== 'ALL_BOTS') {
      targetBot = botManager.bots.get(accountId);
      if (targetBot?.currentVoice?.guildId) {
        targetGuildId = targetGuildId || targetBot.currentVoice.guildId;
        targetChannelId = targetChannelId || targetBot.currentVoice.channelId;
      }
    }

    // Auto-detect from currently connected voice bots
    if (!targetGuildId || !targetChannelId) {
      for (const ub of userBots) {
        const liveBot = botManager.bots.get(ub.id);
        if (liveBot?.currentVoice?.guildId && liveBot?.currentVoice?.channelId) {
          targetGuildId = targetGuildId || liveBot.currentVoice.guildId;
          targetChannelId = targetChannelId || liveBot.currentVoice.channelId;
          targetBot = targetBot || liveBot;
          break;
        }
      }
    }

    // Fallback: Auto-detect from 24/7 configuration in database
    if (!targetGuildId || !targetChannelId) {
      const accounts = database.getAccounts(ownerId);
      for (const acc of accounts) {
        if (acc.voice247 && acc.voice247.guildId && acc.voice247.channelId) {
          targetGuildId = targetGuildId || acc.voice247.guildId;
          targetChannelId = targetChannelId || acc.voice247.channelId;
          break;
        }
      }
    }

    if (!targetGuildId || !targetChannelId) {
      return res.status(400).json({
        success: false,
        error: 'No target voice channel found. Please connect your bots to a voice channel or enable 24/7 on a channel first.'
      });
    }

    let finalAudioUrl = rawAudioUrl;
    let savedSong = null;

    // 2. Handle uploaded MP3 or recorded audio
    if (!finalAudioUrl && audioBase64) {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const isMp3 = !filename || filename.toLowerCase().endsWith('.mp3');
      const ext = isMp3 ? '.mp3' : '.wav';
      const cleanName = (filename ? path.parse(filename).name : 'audio').replace(/[^a-zA-Z0-9_-]/g, '_');
      const storedFileName = `${Date.now()}_${cleanName}${ext}`;
      const localFilePath = path.join(__dirname, 'public', 'uploads', storedFileName);

      fs.writeFileSync(localFilePath, audioBuffer);
      logger.success('AUDIO', `Saved uploaded audio: ${storedFileName} (${(audioBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

      const host = req.get('host');
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const localDirectUrl = `${protocol}://${host}/uploads/${storedFileName}`;

      // Upload to Catbox as CDN mirror
      let externalUrl = null;
      try {
        const mimeType = isMp3 ? 'audio/mpeg' : 'audio/wav';
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', new Blob([audioBuffer], { type: mimeType }), `${cleanName}${ext}`);
        const catRes = await fetch('https://catbox.moe/user/api.php', {
          method: 'POST',
          body: form,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(5000)
        });
        const urlText = await catRes.text();
        if (urlText && urlText.trim().startsWith('http')) {
          externalUrl = urlText.trim();
          logger.success('AUDIO', `Audio mirrored to Catbox: ${externalUrl}`);
        }
      } catch (catErr) {
        logger.warn('AUDIO', `Catbox mirror warning: ${catErr.message}`);
      }

      finalAudioUrl = externalUrl || localDirectUrl;

      // Save to persistent Uploaded Songs Library
      savedSong = database.saveUploadedSong({
        id: 'song_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        ownerId,
        ownerUsername: req.user.username,
        title: title || cleanName.replace(/_/g, ' '),
        filename: filename || storedFileName,
        url: finalAudioUrl,
        mirrorUrl: externalUrl || null,
        localPath: `/uploads/${storedFileName}`,
        size: audioBuffer.length,
        sizeFormatted: `${(audioBuffer.length / (1024 * 1024)).toFixed(2)} MB`,
        isMp3,
        uploadedAt: new Date().toISOString()
      });
    }

    if (!finalAudioUrl) {
      return res.status(400).json({
        success: false,
        error: 'Could not process audio. Please provide a valid MP3 file or audio recording.'
      });
    }

    // 3. Load track via Lavalink (with local FFmpeg Voice Engine support)
    let result = null;
    try {
      result = await lavalink.loadTracks(finalAudioUrl);
      if ((!result || !result.tracks || result.tracks.length === 0) && savedSong?.mirrorUrl) {
        result = await lavalink.loadTracks(savedSong.mirrorUrl);
        if (result && result.tracks && result.tracks.length > 0) {
          finalAudioUrl = savedSong.mirrorUrl;
        }
      }
    } catch (_) {}

    const displayTitle = title || filename || (finalAudioUrl.includes('.mp3') ? 'Custom MP3 Audio' : 'Recorded Voice Note');
    const track = (result && result.tracks && result.tracks.length > 0) ? result.tracks[0] : {
      encoded: null,
      info: {
        title: displayTitle,
        author: finalAudioUrl.includes('.mp3') ? 'Uploaded MP3' : 'Voice Recording',
        length: 0,
        identifier: displayTitle,
        isSeekable: false,
        isStream: true,
        uri: finalAudioUrl
      }
    };
    track.info.title = displayTitle;
    track.info.author = finalAudioUrl.includes('.mp3') ? 'Uploaded MP3' : 'Voice Recording';

    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your account to play music.' });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] triggering ALL BOTS (${userBots.length}) audio playback: "${displayTitle}" at clean 100% volume`);

      // Ensure all online bots join target voice channel
      let joinedAny = false;
      for (const ub of userBots) {
        const b = botManager.bots.get(ub.id);
        const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
        const needsVoiceJoin = !b?.currentVoice?.channelId || b.currentVoice.channelId !== targetChannelId || !p || !p.voiceConnected || !p.voice?.token;
        if (b && targetChannelId && needsVoiceJoin) {
          try {
            await botManager.joinVoice(ub.id, targetChannelId);
            joinedAny = true;
          } catch (e) {}
        }
      }

      if (joinedAny) {
        await new Promise(r => setTimeout(r, 1200));
      }

      if (mode === 'queue') {
        userBots.forEach(ub => {
          const b = botManager.bots.get(ub.id);
          const p = lavalink.createPlayer(targetGuildId, {
            accountId: ub.id,
            channelId: targetChannelId,
            userId: b?.client?.user?.id || null,
            ownerId
          });
          p.volume = 100;
          p.filters.bassboost = false;
          p.queue.push(track);
          lavalink.emit('queueUpdate', p);
          broadcast('playerUpdate', { guildId: targetGuildId, player: p, accountId: ub.id, ownerId }, ownerId);
        });

        return res.json({
          success: true,
          status: 'queued',
          track,
          savedSong,
          url: finalAudioUrl,
          massPlay: true,
          botCount: userBots.length
        });
      }

      // Play through local FFmpeg Voice Engine directly (exact system from 2nd dashboard)
      const directSource = (typeof localFilePath === 'string' && fs.existsSync(localFilePath)) ? localFilePath : finalAudioUrl;
      voiceMusicEngine.play(directSource, {
        title: displayTitle,
        volume: req.body.volume || 10000,
        loop: req.body.loop === true || req.body.loop === 'track',
        guildId: targetGuildId,
        channelId: targetChannelId
      }).catch(e => logger.warn('VOICE_ENGINE', `FFmpeg play note: ${e.message}`));

      // 1. Pre-buffer track across all online bots in PAUSED state at 0:00
      await Promise.allSettled(userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        if (bUid) lavalink.registerBotSession(bUid);
        const p = lavalink.createPlayer(targetGuildId, {
          accountId: ub.id,
          channelId: targetChannelId,
          userId: bUid,
          ownerId
        });
        p.queue = [];
        p.volume = p.volume || 100;
        p.filters.bassboost = req.body.bass === true;
        p.currentTrack = track;
        if (req.body.loop === true || req.body.loop === 'track') {
          p.loop = 'track';
        } else if (req.body.loop === 'queue') {
          p.loop = 'queue';
        }
        return lavalink.play(targetGuildId, track, {
          accountId: ub.id,
          channelId: targetChannelId,
          userId: bUid,
          ownerId,
          forcePlay: true,
          noReplace: false,
          startPaused: true
        });
      }));

      // 2. Short 600ms buffer synchronization gate
      await new Promise(r => setTimeout(r, 600));

      // 3. Simultaneous barrier release: Unpause ALL bots at the EXACT same millisecond
      await Promise.allSettled(userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
        if (p) {
          p.paused = false;
          p.playing = true;
        }
        return lavalink.sendPlayerUpdate(targetGuildId, {
          paused: false
        }, bUid);
      }));

      return res.json({
        success: true,
        status: 'playing',
        track,
        savedSong,
        url: finalAudioUrl,
        massPlay: true,
        botCount: userBots.length
      });
    }

    // Single bot playback fallback
    const targetUserId = targetBot?.client?.user?.id || null;
    const player = lavalink.createPlayer(targetGuildId, {
      accountId: targetBot?.account?.id,
      channelId: targetChannelId,
      userId: targetUserId,
      ownerId
    });
    player.volume = player.volume || 100;
    player.filters.bassboost = req.body.bass === true;
    if (req.body.loop === true || req.body.loop === 'track') {
      player.loop = 'track';
    } else if (req.body.loop === 'queue') {
      player.loop = 'queue';
    }

    if (mode === 'queue') {
      player.queue.push(track);
      lavalink.emit('queueUpdate', player);
      broadcast('playerUpdate', { guildId: targetGuildId, player, accountId: targetBot?.account?.id, ownerId }, ownerId);
      res.json({ success: true, status: 'queued', track, savedSong, url: finalAudioUrl });
    } else {
      await lavalink.play(targetGuildId, track, {
        noReplace: false,
        accountId: targetBot?.account?.id,
        channelId: targetChannelId,
        userId: targetUserId,
        ownerId
      });
      const updatedPlayer = lavalink.getPlayer(targetGuildId, targetBot?.account?.id, ownerId) || player;
      broadcast('playerUpdate', { guildId: targetGuildId, player: updatedPlayer, accountId: targetBot?.account?.id, ownerId }, ownerId);
      res.json({ success: true, status: 'playing', track, savedSong, url: finalAudioUrl });
    }
  } catch (err) {
    logger.error('AUDIO', `Custom audio error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Saved MP3 Library Endpoints
app.get('/api/music/uploads', (req, res) => {
  const songs = database.getUploadedSongs(req.user.userId);
  res.json({ success: true, songs });
});

app.delete('/api/music/uploads/:id', (req, res) => {
  const removed = database.deleteUploadedSong(req.params.id, req.user.userId);
  if (removed) {
    if (removed.localPath) {
      const p = path.join(__dirname, 'public', removed.localPath);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) {}
      }
    }
    return res.json({ success: true, removed });
  }
  res.status(404).json({ success: false, error: 'Song not found' });
});

app.post('/api/music/uploads/:id/play', async (req, res) => {
  try {
    const song = database.getUploadedSongs(req.user.userId).find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ success: false, error: 'Song not found in your library' });

    // Delegate to custom-audio endpoint with song's URL
    req.body = {
      audioUrl: song.url,
      title: song.title,
      mode: req.body.mode || 'playNow',
      loop: req.body.loop === true || req.body.loop === 'track',
      accountId: 'ALL_BOTS'
    };
    // Re-run handler logic
    const { audioUrl, title, mode, loop } = req.body;
    const ownerId = req.user.userId;
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');

    let targetGuildId = null;
    let targetChannelId = null;

    for (const ub of userBots) {
      const b = botManager.bots.get(ub.id);
      if (b?.currentVoice?.guildId && b?.currentVoice?.channelId) {
        targetGuildId = b.currentVoice.guildId;
        targetChannelId = b.currentVoice.channelId;
        break;
      }
    }

    if (!targetGuildId || !targetChannelId) {
      const accounts = database.getAccounts(ownerId);
      for (const acc of accounts) {
        if (acc.voice247 && acc.voice247.guildId && acc.voice247.channelId) {
          targetGuildId = acc.voice247.guildId;
          targetChannelId = acc.voice247.channelId;
          break;
        }
      }
    }

    if (!targetGuildId || !targetChannelId) {
      return res.status(400).json({ success: false, error: 'No active voice channel found. Join bots or enable 24/7 first.' });
    }

    let result = await lavalink.loadTracks(audioUrl);
    if ((!result || !result.tracks || result.tracks.length === 0) && song.mirrorUrl) {
      result = await lavalink.loadTracks(song.mirrorUrl);
    }

    if (!result || !result.tracks || result.tracks.length === 0) {
      return res.status(400).json({ success: false, error: 'Could not load audio track from saved URL.' });
    }

    const track = result.tracks[0];
    track.info.title = title || song.title;

    // Ensure all online bots join target voice channel
    let joinedAny = false;
    for (const ub of userBots) {
      const b = botManager.bots.get(ub.id);
      if (b && targetChannelId && b.currentVoice?.channelId !== targetChannelId) {
        try {
          await botManager.joinVoice(ub.id, targetChannelId);
          joinedAny = true;
        } catch (e) {}
      }
    }
    if (joinedAny) {
      await new Promise(r => setTimeout(r, 1000));
    }

    const existingPlayer = lavalink.getPlayer(targetGuildId, null, ownerId);
    const currentVol = existingPlayer?.volume || 100;
    const bassActive = existingPlayer?.filters?.bassboost === true;

    // 1. Pre-buffer on ALL bots in PAUSED state first
    await Promise.allSettled(userBots.map(async (ub) => {
      const b = botManager.bots.get(ub.id);
      const bUid = b?.client?.user?.id || null;
      if (bUid) lavalink.registerBotSession(bUid);
      const p = lavalink.createPlayer(targetGuildId, {
        accountId: ub.id,
        channelId: targetChannelId,
        userId: bUid,
        ownerId
      });
      p.queue = [];
      p.volume = currentVol;
      p.filters.bassboost = bassActive;
      p.currentTrack = track;
      p.playing = true;
      p.paused = true;
      p.position = 0;
      p._syncedInitial = false;
      if (loop) {
        p.loop = 'track';
      }
      return lavalink.play(targetGuildId, track, {
        accountId: ub.id,
        channelId: targetChannelId,
        userId: bUid,
        ownerId,
        forcePlay: true,
        noReplace: false,
        startPaused: true
      });
    }));

    // 2. Short 600ms buffer synchronization gate
    await new Promise(r => setTimeout(r, 600));

    // 3. Simultaneous barrier release: Unpause ALL bots at the EXACT same millisecond
    await Promise.allSettled(userBots.map(async (ub) => {
      const b = botManager.bots.get(ub.id);
      const bUid = b?.client?.user?.id || null;
      const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
      if (p) {
        p.paused = false;
        p.playing = true;
      }
      return lavalink.sendPlayerUpdate(targetGuildId, { paused: false }, bUid);
    }));

    res.json({ success: true, massPlay: true, count: userBots.length, track, status: 'playing' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/music/player/:guildId', (req, res) => {
  if (voiceMusicEngine.isPlaying || voiceMusicEngine.isPaused) {
    return res.json({ success: true, player: voiceMusicEngine.getStatus(req.params.guildId) });
  }

  const accountId = req.query.accountId || null;
  const ownerId = req.user.userId;

  let player = null;
  if (accountId && accountId !== 'ALL_BOTS') {
    player = lavalink.getPlayer(req.params.guildId, accountId, ownerId);
  } else {
    for (const p of lavalink.players.values()) {
      if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
        player = p;
        if (p.playing) break;
      }
    }
  }

  if (player && player.ownerId && player.ownerId !== ownerId) {
    return res.json({ success: true, player: null });
  }
  res.json({ success: true, player: player || null });
});

app.post('/api/music/player/:guildId/play', async (req, res) => {
  try {
    const { track, accountId, channelId } = req.body;
    if (!track) return res.status(400).json({ success: false, error: 'Track payload required' });
    const ownerId = req.user.userId;

    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    const isSingle = req.body.forceSingle === true;
    const isMass = !isSingle && userBots.length > 0;

    let readyTrack = track;
    if (!readyTrack.encoded || readyTrack.encoded.startsWith('yt_') || readyTrack.encoded.length < 30) {
      const q = readyTrack.info?.uri || readyTrack.info?.title || readyTrack.info?.identifier || (typeof readyTrack === 'string' ? readyTrack : null);
      if (q) {
        try {
          const res = await lavalink.loadTracks(q);
          if (res && res.tracks && res.tracks.length > 0) {
            readyTrack = res.tracks[0];
          }
        } catch (_) {}
      }
    }

    if (isMass) {
      // Auto-detect target voice channel if not passed explicitly
      let targetVcId = channelId;
      if (!targetVcId) {
        for (const ub of userBots) {
          const b = botManager.bots.get(ub.id);
          if (b && b.currentVoice?.guildId === req.params.guildId && b.currentVoice?.channelId) {
            targetVcId = b.currentVoice.channelId;
            break;
          }
        }
      }

      // Check if ANY bot in this guild is ALREADY playing music
      let activePlaying = false;
      for (const ub of userBots) {
        const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (p && p.playing && p.currentTrack && !req.body.forcePlay) {
          activePlaying = true;
          p.queue.push(readyTrack);
          lavalink.emit('queueUpdate', p);
        }
      }

      if (activePlaying) {
        logger.music('QUEUE', `Queued "${readyTrack.info?.title}" for guild ${req.params.guildId}`);
        return res.json({
          success: true,
          massPlay: true,
          count: userBots.length,
          result: { status: 'queued', track: readyTrack }
        });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] instant synced mass play: "${readyTrack.info?.title}" across ${userBots.length} bots in channel ${targetVcId || 'current'}`);

      // 1. Ensure ALL bots under this key join the target voice channel (only wait if needed)
      const joinPromises = [];
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        const needsVoiceJoin = !bot?.currentVoice?.channelId || bot.currentVoice.channelId !== targetVcId || !p || !p.voiceConnected || !p.voice?.token;
        if (bot && targetVcId && needsVoiceJoin) {
          joinPromises.push(botManager.joinVoice(ub.id, targetVcId).catch(() => {}));
        }
      }
      if (joinPromises.length > 0) {
        await Promise.all(joinPromises);
        // Short breather to allow Discord Gateway voice dispatch to complete
        await new Promise(r => setTimeout(r, 800));
      }

      // Check current volume / bass settings for this guild & key
      const existingPlayer = lavalink.getPlayer(req.params.guildId, null, ownerId);
      const currentVol = existingPlayer?.volume || 100;
      const bassActive = existingPlayer?.filters?.bassboost === true;

      // 2. Pre-buffer on ALL bots in PAUSED state first so each bot loads audio frames into Lavalink memory
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        if (userId) lavalink.registerBotSession(userId);
        const player = lavalink.createPlayer(req.params.guildId, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId
        });
        player.volume = currentVol;
        player.filters.bassboost = bassActive;
        player.currentTrack = readyTrack;
        player.playing = true;
        player.paused = true;
        player.position = 0;
        player._syncedInitial = false;
        return lavalink.play(req.params.guildId, readyTrack, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId,
          forcePlay: true,
          noReplace: false,
          startPaused: true
        });
      }));

      // 3. Short 600ms buffer synchronization gate (allows both bots to finish resolving YouTube stream)
      await new Promise(r => setTimeout(r, 600));

      // 4. Simultaneous barrier release: Unpause ALL bots at the EXACT same millisecond!
      // (WITHOUT position parameter so it unpauses existing frames instantly with 0ms offset!)
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) {
          player.paused = false;
          player.playing = true;
        }
        return lavalink.sendPlayerUpdate(req.params.guildId, {
          paused: false
        }, userId);
      }));

      // Direct FFmpeg Audio Engine (from 2nd dashboard) stream to all connected bots
      const directAudio = readyTrack.info?.uri || readyTrack.info?.identifier;
      if (directAudio) {
        voiceMusicEngine.play(directAudio, {
          title: readyTrack.info?.title || 'Track',
          volume: currentVol || 10000,
          guildId: req.params.guildId,
          channelId: targetVcId
        }).catch(e => logger.warn('VOICE_ENGINE', `FFmpeg play note: ${e.message}`));
      }

      logger.success('MUSIC', `Synced mass play active: "${readyTrack.info?.title}" across ${userBots.length} bots in exact unison`);
      return res.json({ success: true, massPlay: true, count: userBots.length, result: { status: 'playing', track: readyTrack } });
    }

    let userId = null;
    if (accountId) {
      const bot = botManager.bots.get(accountId);
      if (bot && bot.account && bot.account.ownerId && bot.account.ownerId !== ownerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized bot access' });
      }
      if (bot?.client?.user) userId = bot.client.user.id;
      if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
        try {
          await botManager.joinVoice(accountId, channelId);
          await new Promise(r => setTimeout(r, 900));
        } catch (vErr) {
          logger.warn('BOT', `Auto-join voice warning: ${vErr.message}`);
        }
      }
    }
    const result = await lavalink.play(req.params.guildId, track, {
      accountId,
      channelId,
      userId,
      ownerId,
      noReplace: true
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/playlist', async (req, res) => {
  try {
    const { tracks, accountId, channelId } = req.body;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ success: false, error: 'Tracks array required' });
    }
    const ownerId = req.user.userId;
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      let targetVcId = channelId;
      if (!targetVcId) {
        for (const ub of userBots) {
          const b = botManager.bots.get(ub.id);
          if (b && b.currentVoice?.guildId === req.params.guildId && b.currentVoice?.channelId) {
            targetVcId = b.currentVoice.channelId;
            break;
          }
        }
      }

      let joinedAny = false;
      for (const ub of userBots) {
        const bot = botManager.bots.get(ub.id);
        if (bot && targetVcId && bot.currentVoice?.channelId !== targetVcId) {
          try {
            await botManager.joinVoice(ub.id, targetVcId);
            joinedAny = true;
          } catch (e) {}
        }
      }

      if (joinedAny) {
        await new Promise(r => setTimeout(r, 1200));
      }

      const firstTrack = tracks[0];
      const restTracks = tracks.slice(1);

      const existingPlayer = lavalink.getPlayer(req.params.guildId, null, ownerId);
      const bassActive = existingPlayer?.filters?.bassboost === true;
      const currentVol = existingPlayer?.volume || 100;

      // 2. Pre-buffer first track in PAUSED state across all bots with identical queues
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        if (userId) lavalink.registerBotSession(userId);
        const player = lavalink.createPlayer(req.params.guildId, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId
        });
        player.queue = [...restTracks];
        player.volume = currentVol || 100;
        player.filters.bassboost = bassActive;
        player.currentTrack = firstTrack;
        player.playing = true;
        player.paused = true;
        player.position = 0;
        player._syncedInitial = false;
        return lavalink.play(req.params.guildId, firstTrack, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId,
          noReplace: true,
          startPaused: true
        });
      }));

      // 3. Short 600ms buffer synchronization gate
      await new Promise(r => setTimeout(r, 600));

      // 4. Simultaneous barrier release: Unpause ALL bots at the EXACT same millisecond
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) {
          player.paused = false;
          player.playing = true;
        }
        return lavalink.sendPlayerUpdate(req.params.guildId, {
          paused: false
        }, userId);
      }));

      return res.json({ success: true, count: tracks.length, massPlay: true, botCount: userBots.length });
    }

    let userId = null;
    if (accountId) {
      const bot = botManager.bots.get(accountId);
      if (bot && bot.account && bot.account.ownerId && bot.account.ownerId !== ownerId) {
        return res.status(403).json({ success: false, error: 'Unauthorized bot access' });
      }
      if (bot?.client?.user) userId = bot.client.user.id;
      if (bot && channelId && bot.currentVoice?.channelId !== channelId) {
        try {
          await botManager.joinVoice(accountId, channelId);
          await new Promise(r => setTimeout(r, 900));
        } catch (vErr) {
          logger.warn('BOT', `Auto-join voice warning: ${vErr.message}`);
        }
      }
    }
    await lavalink.addPlaylist(req.params.guildId, tracks, { accountId, channelId, userId, ownerId, noReplace: true });
    res.json({ success: true, count: tracks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/pause', async (req, res) => {
  try {
    const { paused, accountId } = req.body;
    const ownerId = req.user.userId;
    if (paused === false) voiceMusicEngine.resume();
    else voiceMusicEngine.pause();
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.pause(req.params.guildId, paused !== false, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.pause(req.params.guildId, paused !== false, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/skip', async (req, res) => {
  try {
    const { accountId } = req.body;
    const ownerId = req.user.userId;
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.skip(req.params.guildId, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.skip(req.params.guildId, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/stop', async (req, res) => {
  try {
    const { accountId } = req.body;
    const ownerId = req.user.userId;
    voiceMusicEngine.stop();
    if (accountId === 'ALL_BOTS' || !accountId) {
      for (const p of lavalink.players.values()) {
        if (p.guildId === req.params.guildId && p.ownerId === ownerId) {
          await lavalink.stop(req.params.guildId, p.accountId, ownerId);
        }
      }
    } else {
      await lavalink.stop(req.params.guildId, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/volume', async (req, res) => {
  try {
    const { volume, accountId } = req.body;
    const ownerId = req.user.userId;
    const vol = parseInt(volume, 10) || 100;
    voiceMusicEngine.setVolume(vol);
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        return lavalink.setVolume(req.params.guildId, vol, ub.id, ownerId);
      }));
    } else {
      await lavalink.setVolume(req.params.guildId, vol, accountId, ownerId);
    }
    res.json({ success: true, volume: vol });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/seek', async (req, res) => {
  try {
    const { position, accountId } = req.body;
    const ownerId = req.user.userId;
    const pos = Math.max(0, parseInt(position, 10) || 0);
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        const bot = botManager.bots.get(ub.id);
        const userId = bot?.client?.user?.id || null;
        const player = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
        if (player) player.position = pos;
        return lavalink.sendPlayerUpdate(req.params.guildId, { position: pos }, userId);
      }));
    } else {
      await lavalink.seek(req.params.guildId, pos, accountId, ownerId);
    }
    res.json({ success: true, position: pos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/sync', async (req, res) => {
  try {
    const ownerId = req.user.userId;
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    if (userBots.length === 0) return res.status(400).json({ success: false, error: 'No online bots' });

    let leadPlayer = null;
    for (const ub of userBots) {
      const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
      if (p && p.currentTrack && p.playing) {
        leadPlayer = p;
        break;
      }
    }

    if (!leadPlayer || !leadPlayer.currentTrack) {
      return res.status(400).json({ success: false, error: 'No bot is currently playing a track to sync from' });
    }

    const track = leadPlayer.currentTrack;
    const pos = Math.max(0, leadPlayer.position || 0);
    const filtersPayload = lavalink.buildFiltersPayload(leadPlayer);

    // Atomically snap all bots to exact same track, position, volume, and EQ
    await Promise.allSettled(userBots.map(async (ub) => {
      const bot = botManager.bots.get(ub.id);
      const userId = bot?.client?.user?.id || null;
      const p = lavalink.getPlayer(req.params.guildId, ub.id, ownerId);
      if (p) {
        p.currentTrack = track;
        p.position = pos;
        p.playing = true;
        p.paused = false;
        p.volume = leadPlayer.volume;
      }
      return lavalink.sendPlayerUpdate(req.params.guildId, {
        track: { encoded: track.encoded },
        position: pos,
        paused: false,
        volume: Math.min(200, leadPlayer.volume),
        filters: filtersPayload
      }, userId);
    }));

    res.json({ success: true, syncedBots: userBots.length, position: pos, track: track.info?.title });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/music/player/:guildId/loop', (req, res) => {
  const { mode, accountId } = req.body; // 'off', 'track', 'queue'
  voiceMusicEngine.setLoop(mode === 'track' || mode === true);
  const ownerId = req.user.userId;
  let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
  if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
  if (accountId === 'ALL_BOTS' || !accountId) {
    for (const ub of userBots) {
      lavalink.setLoop(req.params.guildId, mode, ub.id, ownerId);
    }
  } else {
    lavalink.setLoop(req.params.guildId, mode, accountId, ownerId);
  }
  res.json({ success: true, mode });
});

// Global loop toggle across all active voice bots & guilds
app.post('/api/music/loop/all', (req, res) => {
  const { mode } = req.body; // 'off', 'track', 'queue'
  const ownerId = req.user.userId;
  let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
  if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
  const targetGuilds = new Set();
  for (const ub of userBots) {
    if (ub.currentVoice?.guildId) targetGuilds.add(ub.currentVoice.guildId);
  }
  for (const guildId of targetGuilds) {
    lavalink.setLoop(guildId, mode || 'track', 'ALL_BOTS', ownerId);
  }
  res.json({ success: true, mode: mode || 'track', updatedGuilds: Array.from(targetGuilds) });
});

app.post('/api/music/player/:guildId/filter', async (req, res) => {
  try {
    const { filterName, enabled, accountId } = req.body;
    const ownerId = req.user.userId;
    let userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
    if (userBots.length === 0) userBots = botManager.getAllBotsStatus(null).filter(b => b.status === 'online');
    if (accountId === 'ALL_BOTS' || !accountId || req.body.allBots === true) {
      await Promise.allSettled(userBots.map(async (ub) => {
        return lavalink.applyFilters(req.params.guildId, filterName, !!enabled, ub.id, ownerId);
      }));
    } else {
      await lavalink.applyFilters(req.params.guildId, filterName, !!enabled, accountId, ownerId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/music/player/:guildId/queue/:index', (req, res) => {
  const accountId = req.query.accountId || req.body?.accountId || null;
  const removed = lavalink.removeQueueTrack(req.params.guildId, parseInt(req.params.index, 10), accountId, req.user.userId);
  res.json({ success: true, removed });
});

app.delete('/api/music/player/:guildId/queue', (req, res) => {
  const accountId = req.query.accountId || req.body?.accountId || null;
  lavalink.clearQueue(req.params.guildId, accountId, req.user.userId);
  res.json({ success: true });
});

// 4. Logs API
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: logger.getRecentLogs(200) });
});

app.post('/api/logs/clear', (req, res) => {
  logger.clear();
  res.json({ success: true });
});

// 5. Settings API
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: database.getSettings() });
});

app.post('/api/settings', (req, res) => {
  const updated = database.updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

// WebSocket Connection Handling with User Isolation
wss.on('connection', (ws) => {
  logger.info('WS', 'New dashboard client connected');

  ws.on('message', (message, isBinary) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'auth' && parsed.token) {
        const session = authManager.verifySession(parsed.token);
        if (session) {
          ws.userId = session.userId;
          ws.username = session.username;
          ws.key = session.key;
          ws.token = parsed.token;
          // Send user-isolated initial data
          ws.send(JSON.stringify({
            type: 'init',
            data: {
              accounts: botManager.getAllBotsStatus(session.userId),
              lavalink: {
                name: lavalink.name,
                host: lavalink.host,
                port: lavalink.port,
                secure: lavalink.secure,
                connected: lavalink.connected,
                stats: lavalink.stats
              },
              settings: database.getSettings()
            }
          }));
        } else {
          // Token is invalid or the license key was deleted
          ws.send(JSON.stringify({
            type: 'logout',
            data: { reason: 'Your session has expired or license key was deleted. Please log in again.' }
          }));
          setTimeout(() => {
            try { ws.close(4001, 'Invalid session'); } catch (_) {}
          }, 300);
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    // Client disconnected
  });
});

// Handle process and server errors gracefully
process.on('uncaughtException', (err) => {
  logger.error('CRASH', `Uncaught Exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRASH', `Unhandled Rejection: ${reason}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('SERVER', `Port ${config.port} is already in use by another program!`);
    console.log(`\n\x1b[31m[ERROR] Port ${config.port} is already in use!\x1b[0m`);
    console.log(`Make sure no other instance of the bot dashboard is currently running.\n`);
  } else {
    logger.error('SERVER', `Server error: ${err.message}`);
  }
});

// Start Web Server

// ══════════════════════════════════════════════════════════════════
// EXACT COMMAND & VOLUME/BASS CONTROLLER (from dashboard & dashboard sb html)
// ══════════════════════════════════════════════════════════════════
let currentVolumeMultiplier = 1.0; // 100% clean standard default
let isBassboosted = false; // Bass starts OFF by default
let blastMode = false;
let blastVolume = 50.0;
let superLoudMode = false;
let forceLoudMode = false;
let pungiMode = false;
let pungiIntensity = 50.0;
let loudMode = false;
let loopMode = false;
let isPaused = false;
let currentTitle = "Nothing playing";

app.get('/api/status', (req, res) => {
  const userId = req.user?.userId || null;
  const onlineBots = botManager.getAllBotsStatus(userId).filter(b => b.status === 'online');
  res.json({
    isRunning: onlineBots.length > 0,
    botCount: onlineBots.length,
    currentTitle: currentTitle,
    volume: Math.round(currentVolumeMultiplier * 100),
    isPaused, loopMode, isBassboosted, blastMode, pungiMode, loudMode, superLoudMode, forceLoudMode,
    connected: onlineBots.some(b => b.currentVoice?.channelId)
  });
});

app.post('/api/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.json({ error: 'No command' });

  const userId = req.user?.userId || null;
  const userBots = botManager.getAllBotsStatus(userId).filter(b => b.status === 'online');
  const targetGuilds = new Set();
  userBots.forEach(b => {
    if (b.currentVoice?.guildId) targetGuilds.add(b.currentVoice.guildId);
  });
  if (targetGuilds.size === 0 && lavalink.players.size > 0) {
    for (const [k, p] of lavalink.players.entries()) {
      if (p.guildId && (!userId || p.ownerId === userId)) targetGuilds.add(p.guildId);
    }
  }

  const lowerCmd = command.toLowerCase().trim();
  let response = '';

  try {
    if (lowerCmd === 'help') {
      response = 'Commands: play <url>, volume <1-20000>, max, blast, doubleblast, superloud, forceloud, bassboost, pungi, pungiset, loudmode, loop, pause, resume, stop, leave, status';
    }
    else if (lowerCmd.startsWith('play ')) {
      const query = command.slice(5).trim();
      if (userBots.length === 0) {
        response = '❌ No bots online!';
      } else {
        const results = await lavalink.searchTracks(query);
        if (!results.tracks || results.tracks.length === 0) {
          response = '❌ No audio tracks found for query.';
        } else {
          const track = results.tracks[0];
          currentTitle = track.info.title || query;
          isPaused = false;
          let played = 0;
          for (const guildId of targetGuilds) {
            await lavalink.playTrack(guildId, track, 'ALL_BOTS', userId);
            played++;
          }
          response = `▶️ Now Playing: ${currentTitle} across ${played || userBots.length} bots`;
        }
      }
    }
    else if (lowerCmd === 'stop') {
      for (const guildId of targetGuilds) {
        await lavalink.stopTrack(guildId, 'ALL_BOTS', userId);
      }
      currentTitle = "Nothing playing";
      isPaused = false;
      response = '⏹️ Playback stopped';
    }
    else if (lowerCmd === 'pause') {
      for (const guildId of targetGuilds) {
        await lavalink.pause(guildId, true, 'ALL_BOTS', userId);
      }
      isPaused = true;
      response = '⏸️ Paused';
    }
    else if (lowerCmd === 'resume') {
      for (const guildId of targetGuilds) {
        await lavalink.pause(guildId, false, 'ALL_BOTS', userId);
      }
      isPaused = false;
      response = '▶️ Resumed';
    }
    else if (lowerCmd === 'leave') {
      await botManager.leaveAllVoice(userId, false);
      for (const guildId of targetGuilds) {
        await lavalink.stopTrack(guildId, 'ALL_BOTS', userId);
      }
      currentTitle = "Nothing playing";
      response = '👋 Disconnected all bots';
    }
    else if (lowerCmd.startsWith('volume ')) {
      const vol = parseInt(command.slice(7).trim(), 10);
      if (isNaN(vol) || vol < 1 || vol > 20000) {
        response = '❌ Volume must be 1-20000%';
      } else {
        currentVolumeMultiplier = vol / 100;
        for (const guildId of targetGuilds) {
          await lavalink.setVolume(guildId, vol, 'ALL_BOTS', userId);
        }
        response = `🔊 Volume set to ${vol}%`;
      }
    }
    else if (lowerCmd === 'max') {
      currentVolumeMultiplier = 2.0;
      for (const guildId of targetGuilds) {
        await lavalink.setVolume(guildId, 200, 'ALL_BOTS', userId);
      }
      response = '💥 Maximum Volume (200%)';
    }
    else if (lowerCmd === 'blast') {
      blastMode = !blastMode;
      pungiMode = false; superLoudMode = false; forceLoudMode = false;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'blast', blastMode, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'pungi', false, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'superLoud', false, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'forceLoud', false, 'ALL_BOTS', userId);
      }
      response = `🔥 Blast Mode ${blastMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'doubleblast') {
      blastMode = true; pungiMode = false; superLoudMode = false; forceLoudMode = false;
      blastVolume = 2.0; currentVolumeMultiplier = 2.0;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'doubleblast', true, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'blast', true, 'ALL_BOTS', userId);
        await lavalink.setVolume(guildId, 200, 'ALL_BOTS', userId);
      }
      response = '💥💥 DOUBLE BLAST ACTIVATED!';
    }
    else if (lowerCmd === 'superloud') {
      superLoudMode = !superLoudMode;
      if (superLoudMode) { blastMode = false; pungiMode = false; forceLoudMode = false; }
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'superLoud', superLoudMode, 'ALL_BOTS', userId);
      }
      response = `🔊 Super Loud ${superLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'forceloud') {
      forceLoudMode = !forceLoudMode;
      if (forceLoudMode) { blastMode = false; pungiMode = false; superLoudMode = false; }
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'forceLoud', forceLoudMode, 'ALL_BOTS', userId);
      }
      response = `🔥 Force Loud ${forceLoudMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd === 'bassboost') {
      isBassboosted = !isBassboosted;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'bassboost', isBassboosted, 'ALL_BOTS', userId);
      }
      response = `🎵 Bassboost ${isBassboosted ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'pungi') {
      pungiMode = !pungiMode;
      blastMode = false; superLoudMode = false; forceLoudMode = false;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'pungi', pungiMode, 'ALL_BOTS', userId);
      }
      response = `🐍 Pungi Mode ${pungiMode ? 'ACTIVATED' : 'DEACTIVATED'}`;
    }
    else if (lowerCmd.startsWith('pungiset ')) {
      const val = parseFloat(command.slice(9).trim());
      if (isNaN(val) || val < 1 || val > 200) {
        response = '❌ Intensity must be 1-200';
      } else {
        pungiIntensity = val;
        pungiMode = true;
        for (const guildId of targetGuilds) {
          await lavalink.applyFilters(guildId, 'pungi', true, 'ALL_BOTS', userId);
        }
        response = `🐍 Pungi intensity set to ${val}x`;
      }
    }
    else if (lowerCmd === 'loudmode') {
      loudMode = !loudMode;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'loudMode', loudMode, 'ALL_BOTS', userId);
      }
      response = `🔊 Loud Mode ${loudMode ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'loop') {
      loopMode = !loopMode;
      const modeStr = loopMode ? 'track' : 'off';
      for (const guildId of targetGuilds) {
        lavalink.setLoop(guildId, modeStr, 'ALL_BOTS', userId);
      }
      response = `🔄 Loop ${loopMode ? 'ENABLED' : 'DISABLED'}`;
    }
    else if (lowerCmd === 'status') {
      response = `🎵 ${currentTitle}\n📊 ${userBots.length} bots online\n🔊 ${Math.round(currentVolumeMultiplier * 100)}%\n🔄 Loop: ${loopMode ? 'ON' : 'OFF'}`;
    }
    else if (!isNaN(lowerCmd) && lowerCmd.length >= 10) {
      const channelId = lowerCmd;
      const resJoin = await botManager.joinAllToVoice(userId, channelId, { selfMute: false, selfDeaf: false });
      response = `✅ Connected ${resJoin.count || userBots.length} bots to channel ${channelId}`;
    }
    else {
      response = '❌ Unknown command. Type "help" for list.';
    }
  } catch (err) {
    response = `❌ Error: ${err.message}`;
  }

  res.json({ response, currentVolume: Math.round(currentVolumeMultiplier * 100), isBassboosted, blastMode, superLoudMode, forceLoudMode, pungiMode, loudMode, loopMode });
});

async function startServer() {
  try {
    await database.syncWithMySQL();
    await authManager.syncWithMySQL();
    await licenseManager.syncWithMySQL();
    migrateLicenseOwnedAccounts();
  } catch (err) {
    logger.warn('SERVER', `Initial storage sync: ${err.message}`);
  }

  const port = parseInt(process.env.SERVER_PORT || process.env.PORT || config.port, 10);
  server.listen(port, '0.0.0.0', () => {
    const dbStatus = require('./src/sqliteStore').getStatus();
    logger.success('SERVER', `╔═════════════════════════════════════════════════════════════╗`);
    logger.success('SERVER', `║  🎵 MULTI-ACCOUNT DISCORD SELFBOT & LAVALINK DASHBOARD 🎵  ║`);
    logger.success('SERVER', `╠═════════════════════════════════════════════════════════════╣`);
    logger.success('SERVER', `║  Dashboard Web UI: http://localhost:${port}                   ║`);
    logger.success('SERVER', `║  Database Store:   ${dbStatus.provider} (${dbStatus.database}) ║`);
    logger.success('SERVER', `║  Lavalink Node:    ${lavalink.name} (${lavalink.host}:${lavalink.port})      ║`);
    logger.success('SERVER', `╚═════════════════════════════════════════════════════════════╝`);

    // Auto-start enabled accounts
    botManager.startAll().catch(e => {
      logger.error('BOT', `Error auto-starting accounts: ${e.message}`);
    });
  });
}

startServer();
