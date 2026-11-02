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

  // 3. Ensure src/ directory and all required files
  try {
    const srcPath = path.join(__dirname, 'src');
    if (!fs.existsSync(srcPath)) fs.mkdirSync(srcPath, { recursive: true });
    const srcMap = {"patch.js":"const fs = require('fs');\nconst path = require('path');\n\n// 1. Permanently patch ClientUserSettingManager.js on disk if unpatched\ntry {\n  const filePath = path.join(__dirname, '..', 'node_modules', 'discord.js-selfbot-v13', 'src', 'managers', 'ClientUserSettingManager.js');\n  if (fs.existsSync(filePath)) {\n    let code = fs.readFileSync(filePath, 'utf8');\n    const buggyTarget = \"if ('friend_source_flags' in data) {\";\n    const fixedReplacement = \"if ('friend_source_flags' in data && data.friend_source_flags) {\";\n    \n    if (code.includes(buggyTarget)) {\n      code = code.replace(buggyTarget, fixedReplacement);\n      fs.writeFileSync(filePath, code, 'utf8');\n    }\n  }\n} catch (err) {}\n\n// 2. Bypass unauthenticated GET /api/v9/gateway to prevent Discord/Cloudflare 429 rate limit\ntry {\n  const WebSocketManager = require('discord.js-selfbot-v13/src/client/websocket/WebSocketManager');\n  const { Collection } = require('@discordjs/collection');\n  const WebSocketShard = require('discord.js-selfbot-v13/src/client/websocket/WebSocketShard');\n\n  WebSocketManager.prototype.connect = async function() {\n    const gatewayURL = 'wss://gateway.discord.gg';\n    this.gateway = gatewayURL + '/';\n    let { shards } = this.client.options;\n    if (shards === 'auto') {\n      this.totalShards = this.client.options.shardCount = 1;\n      shards = this.client.options.shards = [0];\n    }\n    this.totalShards = Array.isArray(shards) ? shards.length : shards;\n    this.shards = new Collection();\n    this.shardQueue = new Set(shards.map(id => new WebSocketShard(this, id)));\n    return this.createShards();\n  };\n} catch (err) {}\n\n// 3. Ensure per-client proxy agent isolation in REST requests\ntry {\n  const APIRequest = require('discord.js-selfbot-v13/src/rest/APIRequest');\n  const { getProxyObject } = require('discord.js-selfbot-v13/src/util/Util');\n  const origMake = APIRequest.prototype.make;\n  APIRequest.prototype.make = function(captchaKey, captchaRqtoken) {\n    if (this.client.options.proxy && typeof this.client.options.proxy === 'string' && this.client.options.proxy.length > 0) {\n      this.options.agent = getProxyObject(this.client.options.proxy);\n    }\n    return origMake.call(this, captchaKey, captchaRqtoken);\n  };\n} catch (err) {}\n\nmodule.exports = true;\n","authManager.js":"const fs = require('fs');\nconst path = require('path');\nconst crypto = require('crypto');\nconst config = require('./config');\nconst logger = require('./logger');\nconst sqliteStore = require('./sqliteStore');\nconst KeyAuthApp = require('./keyauth');\nconst licenseManager = require('./licenseManager');\n\nconst AUTH_SECRET = process.env.SESSION_SECRET ||\n  (process.env.NODE_ENV === 'production'\n    ? null\n    : 'exc_secret_keyauth_7be0a58b_' + (KeyAuthApp.ownerid || 'geyPKimqwc'));\nif (!AUTH_SECRET) {\n  throw new Error('SESSION_SECRET must be set in production.');\n}\n\nclass AuthManager {\n  constructor() {\n    this.usersFile = path.join(config.dataDir, 'users.json');\n    this.sessions = new Map(Object.entries(sqliteStore.getJSON('auth_sessions', {})));\n    this.adminSessions = new Set(sqliteStore.getJSON('admin_sessions', []));\n    this.init();\n  }\n\n  init() {\n    if (!fs.existsSync(config.dataDir)) {\n      fs.mkdirSync(config.dataDir, { recursive: true });\n    }\n\n    this.users = sqliteStore.getJSON('users', [], this.usersFile).map(u => ({\n      ...u,\n      botLimit: typeof u.botLimit === 'number' ? u.botLimit : 10\n    }));\n\n    // Pre-initialize KeyAuth session in the background\n    KeyAuthApp.init().catch(err => {\n      logger.warn('AUTH', `Initial KeyAuth background connect: ${err.message}`);\n    });\n  }\n\n  loadJSON(filePath, fallback) {\n    try {\n      if (fs.existsSync(filePath)) {\n        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));\n      }\n    } catch (e) {\n      logger.error('AUTH', `Failed to load ${filePath}: ${e.message}`);\n    }\n    return fallback;\n  }\n\n  saveUsers(triggerSync = true) {\n    try {\n      sqliteStore.setJSON('users', this.users);\n    } catch (e) {\n      logger.error('AUTH', `Failed to save users: ${e.message}`);\n    }\n  }\n\n  saveSessions() {\n    sqliteStore.setJSON('auth_sessions', Object.fromEntries(this.sessions));\n  }\n\n  /**\n   * Authenticate user via KeyAuth License Key\n   * @param {string} key - KeyAuth license key\n   * @param {string} clientHwid - Hardware ID\n   * @param {object} deviceInfo - Client browser/platform details\n   */\n  async loginWithKey(key, clientHwid, deviceInfo = {}) {\n    if (!key || typeof key !== 'string' || !key.trim()) {\n      throw new Error('Please enter your KeyAuth license key');\n    }\n\n    const cleanKey = key.trim();\n\n    // 0. Check EXC Internal KeyAuth License Manager first\n    const localLic = licenseManager.validateLicense(cleanKey, clientHwid);\n    if (localLic) {\n      const userId = 'usr_' + crypto.createHash('sha256').update(cleanKey.toLowerCase()).digest('hex').substring(0, 16);\n      let user = this.users.find(u => u.id === userId || (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()));\n      if (!user) {\n        user = {\n          id: userId,\n          username: cleanKey.substring(0, 16),\n          key: cleanKey,\n          hwid: localLic.hwid,\n          botLimit: localLic.botLimit || 10,\n          status: localLic.status || 'active',\n          subscription: `${localLic.botLimit} Bots Tier`,\n          expiry: localLic.expiry || null,\n          boundDevice: deviceInfo || {},\n          createdAt: new Date().toISOString(),\n          lastLogin: new Date().toISOString()\n        };\n        this.users.push(user);\n      } else {\n        user.botLimit = localLic.botLimit || user.botLimit || 10;\n        user.hwid = localLic.hwid || user.hwid;\n        user.status = localLic.status;\n        user.expiry = localLic.expiry;\n        user.lastLogin = new Date().toISOString();\n      }\n      this.saveUsers();\n\n      const sessionData = {\n        userId: user.id,\n        username: user.username,\n        key: cleanKey,\n        hwid: user.hwid,\n        botLimit: user.botLimit,\n        subscription: user.subscription,\n        expiry: user.expiry,\n        status: user.status,\n        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000\n      };\n\n      const token = this.createSignedToken(sessionData);\n      this.sessions.set(token, sessionData);\n      this.saveSessions();\n      logger.success('AUTH', `User \"${user.username}\" authenticated via EXC Licensing (License: ${cleanKey.substring(0, 8)}... | Limit: ${user.botLimit} bots)`);\n\n      return {\n        token,\n        user: {\n          id: user.id,\n          username: user.username,\n          key: cleanKey,\n          hwid: user.hwid,\n          botLimit: user.botLimit,\n          subscription: user.subscription,\n          expiry: user.expiry,\n          status: user.status\n        }\n      };\n    }\n\n    // Check if we already have this user in memory or database\n    let existingUser = this.users.find(u =>\n      (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()) ||\n      (u.username && u.username.toLowerCase() === cleanKey.toLowerCase()) ||\n      (u.id && u.id.toLowerCase() === cleanKey.toLowerCase())\n    );\n\n    // Primary HWID attempt: use client HWID or fallback to registered HWID\n    const primaryHwid = (clientHwid && clientHwid.length >= 20)\n      ? clientHwid\n      : (existingUser?.hwid || 'HWID-2EB757AB171C81CEC48072C8D035EE4A');\n\n    // 1. Validate with KeyAuth API (with automatic HWID recovery)\n    let authResult;\n    try {\n      authResult = await KeyAuthApp.loginWithKey(cleanKey, primaryHwid);\n    } catch (err) {\n      if (err.message && err.message.toLowerCase().includes('hwid')) {\n        const fallbackHwid = existingUser?.hwid || 'HWID-2EB757AB171C81CEC48072C8D035EE4A';\n        logger.info('AUTH', `KeyAuth reported HWID mismatch. Retrying with registered HWID ${fallbackHwid}...`);\n        authResult = await KeyAuthApp.loginWithKey(cleanKey, fallbackHwid);\n      } else {\n        throw err;\n      }\n    }\n    const info = authResult.info || {};\n\n    const keyUsername = info.username || cleanKey.substring(0, 16);\n    const subscriptions = info.subscriptions || [];\n    const activeSub = subscriptions[0] || {};\n    const subName = activeSub.subscription || 'Default';\n    const expiry = activeSub.expiry || info.expiry || null;\n\n    // 2. Determine bot quota for this key:\n    let botLimit = config.defaultBotLimit || parseInt(process.env.DEFAULT_BOT_LIMIT, 10) || 10;\n\n    // A. Check data/user_limits.json mapping\n    try {\n      const limitsPath = path.join(config.dataDir, 'user_limits.json');\n      if (fs.existsSync(limitsPath)) {\n        const limitsMap = JSON.parse(fs.readFileSync(limitsPath, 'utf8'));\n        const matched = limitsMap[cleanKey] || limitsMap[cleanKey.toLowerCase()] || limitsMap[keyUsername];\n        if (typeof matched === 'number') {\n          botLimit = matched;\n        }\n      }\n    } catch (_) {}\n\n    // B. Check if key itself contains a bot limit tag (e.g. KEY-...-25B, KEY-..._50, or KEY-...-UNL)\n    const keyLimitMatch = cleanKey.match(/(?:-|_|\\s)(\\d+)(?:b|bots?)?(?:$|-|_)/i);\n    if (keyLimitMatch) {\n      botLimit = parseInt(keyLimitMatch[1], 10);\n    } else if (/(?:-|_)(?:unl|unlimited)/i.test(cleanKey)) {\n      botLimit = 100;\n    }\n\n    // C. Check KeyAuth subscription level (if present)\n    const subMatch = (subName || '').match(/(\\d+)\\s*bots?/i);\n    if (subMatch) {\n      botLimit = parseInt(subMatch[1], 10);\n    } else if (/unlimited/i.test(subName)) {\n      botLimit = 100;\n    } else if (typeof info.botLimit === 'number') {\n      botLimit = info.botLimit;\n    }\n\n    // D. Check if user already exists with an admin-assigned bot limit\n    if (existingUser && typeof existingUser.botLimit === 'number' && existingUser.botLimit !== 10) {\n      botLimit = existingUser.botLimit;\n    }\n\n    // 3. Deterministic user ID for this license key\n    const userId = 'usr_' + crypto.createHash('sha256').update(cleanKey.toLowerCase()).digest('hex').substring(0, 16);\n\n    const activeHwid = authResult.info?.hwid || primaryHwid;\n\n    // 4. Update or register local user cache\n    let user = this.users.find(u => u.id === userId || (u.key && u.key.toLowerCase() === cleanKey.toLowerCase()));\n    if (!user) {\n      user = {\n        id: userId,\n        username: keyUsername,\n        key: cleanKey,\n        hwid: activeHwid,\n        botLimit: botLimit,\n        status: 'active',\n        subscription: subName,\n        expiry: expiry,\n        boundDevice: {\n          platform: deviceInfo.platform || 'Unknown',\n          browser: deviceInfo.browser || 'Unknown',\n          screen: deviceInfo.screen || 'Unknown',\n          boundAt: new Date().toISOString()\n        },\n        createdAt: new Date().toISOString(),\n        lastLogin: new Date().toISOString()\n      };\n      this.users.push(user);\n    } else {\n      user.username = keyUsername;\n      user.key = cleanKey;\n      user.hwid = activeHwid;\n      user.botLimit = botLimit;\n      user.subscription = subName;\n      user.expiry = expiry;\n      user.lastLogin = new Date().toISOString();\n      if (!user.boundDevice) {\n        user.boundDevice = {\n          platform: deviceInfo.platform || 'Unknown',\n          browser: deviceInfo.browser || 'Unknown',\n          screen: deviceInfo.screen || 'Unknown',\n          boundAt: new Date().toISOString()\n        };\n      }\n    }\n\n    this.saveUsers();\n\n    // 5. Issue persistent cryptographic session token (valid 7 days, works across any serverless container)\n    const sessionData = {\n      userId: user.id,\n      username: user.username,\n      key: cleanKey,\n      hwid: user.hwid,\n      botLimit: user.botLimit,\n      subscription: user.subscription,\n      expiry: user.expiry,\n      status: user.status,\n      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000\n    };\n\n    const token = this.createSignedToken(sessionData);\n    this.sessions.set(token, sessionData);\n    this.saveSessions();\n\n    logger.success('AUTH', `User \"${user.username}\" authenticated via KeyAuth (License: ${cleanKey.substring(0, 8)}... | Limit: ${botLimit} bots)`);\n\n    return {\n      token,\n      user: {\n        id: user.id,\n        username: user.username,\n        key: cleanKey,\n        hwid: user.hwid,\n        botLimit: user.botLimit,\n        subscription: user.subscription,\n        expiry: user.expiry,\n        status: user.status\n      }\n    };\n  }\n\n  createSignedToken(sessionData) {\n    const payloadStr = JSON.stringify(sessionData);\n    const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64url');\n    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');\n    return `exc_usr_${payloadB64}.${sig}`;\n  }\n\n  // Legacy fallback\n  async login(username, password, clientHwid, deviceInfo = {}) {\n    const key = username || password;\n    return this.loginWithKey(key, clientHwid, deviceInfo);\n  }\n\n  verifySession(token) {\n    if (!token || typeof token !== 'string') return null;\n\n    // 1. Check in-memory cache first\n    let session = this.sessions.get(token);\n\n    // 2. If not in memory (fresh serverless container), verify cryptographic signature\n    if (!session && token.startsWith('exc_usr_')) {\n      const raw = token.substring(8);\n      const parts = raw.split('.');\n      if (parts.length === 2) {\n        const [payloadB64, sig] = parts;\n        const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');\n        if (sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {\n          try {\n            const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));\n            if (payload && (!payload.expiresAt || Date.now() <= payload.expiresAt)) {\n              session = payload;\n              this.sessions.set(token, session);\n              this.saveSessions();\n            }\n          } catch (_) {}\n        }\n      }\n    }\n\n    if (!session) return null;\n    if (session.expiresAt && Date.now() > session.expiresAt) {\n      this.sessions.delete(token);\n      this.saveSessions();\n      return null;\n    }\n\n    const liveUser = this.users.find(u => u.id === session.userId);\n    const licenseBotLimit = licenseManager.getBotLimit(session.key);\n    if (licenseBotLimit !== null) {\n      session.botLimit = licenseBotLimit;\n    } else if (liveUser && typeof liveUser.botLimit === 'number' && liveUser.botLimit !== 10) {\n      session.botLimit = liveUser.botLimit;\n    } else {\n      session.botLimit = session.botLimit || liveUser?.botLimit || 10;\n    }\n\n    if (liveUser) {\n      session.status = liveUser.status || session.status || 'active';\n      session.subscription = liveUser.subscription || session.subscription || 'default';\n    }\n    return session;\n  }\n\n  logout(token) {\n    this.sessions.delete(token);\n    this.saveSessions();\n  }\n\n  adminLogin(password) {\n    const expectedPassword = process.env.ADMIN_PASSWORD;\n    if (!expectedPassword) {\n      throw new Error('Admin login is not configured. Set ADMIN_PASSWORD in the hosting environment.');\n    }\n\n    const supplied = Buffer.from(String(password || ''));\n    const expected = Buffer.from(expectedPassword);\n    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {\n      throw new Error('Invalid admin password');\n    }\n\n    const token = `exc_adm_${crypto.randomBytes(32).toString('hex')}`;\n    this.adminSessions.add(token);\n    sqliteStore.setJSON('admin_sessions', [...this.adminSessions]);\n    return { token };\n  }\n\n  verifyAdminSession(token) {\n    return typeof token === 'string' && this.adminSessions.has(token);\n  }\n\n  adminLogout(token) {\n    this.adminSessions.delete(token);\n    sqliteStore.setJSON('admin_sessions', [...this.adminSessions]);\n  }\n}\n\nmodule.exports = new AuthManager();\n","initialAccounts.json":"[]\n","keyauth.js":"const crypto = require('crypto');\nconst logger = require('./logger');\n\n/**\n * KeyAuth API Client (v1.3)\n * Integration for Dhanushdhnu390's Application\n */\nclass KeyAuth {\n  constructor({ name, ownerid, version }) {\n    this.name = name;\n    this.ownerid = ownerid;\n    this.version = version;\n    this.baseUrl = 'https://keyauth.win/api/1.3/';\n    this.sessionId = null;\n    this.sessionExpiry = 0;\n    this.initPromise = null;\n  }\n\n  async init() {\n    if (this.initPromise) {\n      return this.initPromise;\n    }\n\n    this.initPromise = (async () => {\n      try {\n        const initUrl = `${this.baseUrl}?type=init&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&version=${this.version}`;\n        const res = await fetch(initUrl);\n        const data = await res.json();\n        if (!data.success) {\n          throw new Error(data.message || 'KeyAuth initialization failed');\n        }\n        this.sessionId = data.sessionid;\n        this.sessionExpiry = Date.now() + 30 * 60 * 1000;\n        logger.info('KEYAUTH', `Session initialized successfully (ID: ${this.sessionId})`);\n        return this.sessionId;\n      } finally {\n        this.initPromise = null;\n      }\n    })();\n\n    return this.initPromise;\n  }\n\n  async getSession() {\n    if (this.sessionId && Date.now() < this.sessionExpiry) {\n      return this.sessionId;\n    }\n    return await this.init();\n  }\n\n  /**\n   * Authenticate a user license key with HWID lock\n   * @param {string} key - License key\n   * @param {string} hwid - Hardware ID of device\n   */\n  async loginWithKey(key, hwid) {\n    if (!key || typeof key !== 'string') {\n      throw new Error('License key is required');\n    }\n    const cleanKey = key.trim();\n    if (!cleanKey) {\n      throw new Error('License key cannot be empty');\n    }\n\n    // KeyAuth requires HWID to be at least 20 characters\n    let validHwid = (hwid && hwid.length >= 20)\n      ? hwid\n      : crypto.createHash('sha256').update(cleanKey + '_exc_device').digest('hex');\n\n    let sessId = await this.getSession();\n    const licenseUrl = `${this.baseUrl}?type=license&key=${encodeURIComponent(cleanKey)}&sessionid=${sessId}&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&hwid=${encodeURIComponent(validHwid)}`;\n\n    let res = await fetch(licenseUrl);\n    let data = await res.json();\n\n    // If session expired or invalid on KeyAuth server, refresh session and retry once\n    if (!data.success && (data.message?.toLowerCase().includes('session') || data.message?.includes('not valid'))) {\n      this.sessionId = null;\n      sessId = await this.init();\n      const retryUrl = `${this.baseUrl}?type=license&key=${encodeURIComponent(cleanKey)}&sessionid=${sessId}&name=${encodeURIComponent(this.name)}&ownerid=${this.ownerid}&hwid=${encodeURIComponent(validHwid)}`;\n      res = await fetch(retryUrl);\n      data = await res.json();\n    }\n\n    if (!data.success) {\n      throw new Error(data.message || 'Invalid or expired license key');\n    }\n\n    logger.success('KEYAUTH', `Key verified! Info: ${JSON.stringify(data.info || {})}`);\n    return data;\n  }\n}\n\n// KeyAuth application configured with Dhanushdhnu390's Application credentials\nconst KeyAuthApp = new KeyAuth({\n  name: \"Dhanushdhnu390's Application\",\n  ownerid: \"geyPKimqwc\",\n  version: \"1.0\"\n});\n\nmodule.exports = KeyAuthApp;\n","botManager.js":"// Ensure discord.js-selfbot-v13 user settings bug is patched\nrequire(\"./patch\");\n\nconst { Client } = require(\"discord.js-selfbot-v13\");\nconst EventEmitter = require(\"events\");\nconst fs = require(\"fs\");\nconst path = require(\"path\");\nconst https = require(\"https\");\nconst { HttpsProxyAgent } = require(\"https-proxy-agent\");\nconst { SocksProxyAgent } = require(\"socks-proxy-agent\");\nconst database = require(\"./database\");\nconst logger = require(\"./logger\");\nconst config = require(\"./config\");\n\n// Rotating proxy pool for rate-limit protection & safe mass actions\nlet freeProxiesList = [];\nlet proxyRotationIndex = 0;\n\nfunction loadFreeProxies() {\n  try {\n    const pPath = path.join(__dirname, \"..\", \"data\", \"free_proxies.txt\");\n    if (fs.existsSync(pPath)) {\n      const raw = fs.readFileSync(pPath, \"utf8\")\n        .split(/\\r?\\n/)\n        .map(s => s.trim())\n        .filter(s => s && s.includes(\":\"));\n      if (raw.length > 0) {\n        freeProxiesList = Array.from(new Set(raw));\n        logger.info(\"PROXY\", `🛡️ Loaded ${freeProxiesList.length} proxies from free_proxies.txt for token safety & 24/7 uptime`);\n        return;\n      }\n    }\n    const wsProxiesPath = path.join(__dirname, \"..\", \"working_ws_proxies.json\");\n    if (fs.existsSync(wsProxiesPath)) {\n      const data = JSON.parse(fs.readFileSync(wsProxiesPath, \"utf8\"));\n      if (Array.isArray(data) && data.length > 0) {\n        freeProxiesList = data;\n        logger.info(\"PROXY\", `Loaded ${freeProxiesList.length} proxies from working_ws_proxies.json for rate-limit & token protection`);\n        return;\n      }\n    }\n  } catch (e) {\n    logger.warn(\"PROXY\", `Could not load proxies: ${e.message}`);\n  }\n}\nloadFreeProxies();\n\nconst isOldDeadProxy = (p) => !p || p.includes('184.178.172.17') || p.includes('pldkrffl') || p.includes('198.23.243.226') || p.includes('45.38.107.97') || p.includes('nzpqvgqf');\n\nfunction getNextRotatingProxy() {\n  if (freeProxiesList.length === 0) return null;\n  for (let tries = 0; tries < 50; tries++) {\n    const p = freeProxiesList[proxyRotationIndex % freeProxiesList.length];\n    proxyRotationIndex = (proxyRotationIndex + 1) % freeProxiesList.length;\n    if (p && !isOldDeadProxy(p)) return p;\n  }\n  return null;\n}\n\n// REST request helper using proxy agent\nfunction executeGuildLeaveRest(token, guildId, proxy = null) {\n  return new Promise((resolve, reject) => {\n    let agent = undefined;\n    if (proxy) {\n      try {\n        if (proxy.startsWith(\"socks\")) {\n          agent = new SocksProxyAgent(proxy);\n        } else {\n          const formatted = proxy.startsWith(\"http\") ? proxy : `http://${proxy}`;\n          agent = new HttpsProxyAgent(formatted);\n        }\n      } catch (err) {\n        agent = undefined;\n      }\n    }\n\n    const options = {\n      hostname: \"discord.com\",\n      port: 443,\n      path: `/api/v9/users/@me/guilds/${guildId}`,\n      method: \"DELETE\",\n      headers: {\n        \"Authorization\": token,\n        \"Content-Type\": \"application/json\",\n        \"User-Agent\": \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36\"\n      },\n      agent,\n      timeout: 10000\n    };\n\n    const req = https.request(options, (res) => {\n      let data = \"\";\n      res.on(\"data\", chunk => { data += chunk; });\n      res.on(\"end\", () => {\n        if (res.statusCode === 204 || res.statusCode === 200) {\n          resolve({ ok: true, status: res.statusCode });\n        } else if (res.statusCode === 404) {\n          resolve({ ok: true, status: 404, message: \"Not in server\" });\n        } else {\n          resolve({ ok: false, status: res.statusCode, error: data || `Status ${res.statusCode}` });\n        }\n      });\n    });\n\n    req.on(\"timeout\", () => {\n      req.destroy();\n      reject(new Error(\"Proxy request timeout\"));\n    });\n\n    req.on(\"error\", (err) => {\n      reject(err);\n    });\n\n    req.end();\n  });\n}\n\n// Optional proxy pool (Direct connection enabled by default without proxy limits)\nconst WORKING_PROXIES = [];\n\nclass BotManager extends EventEmitter {\n  constructor(lavalinkClient) {\n    super();\n    this.lavalink = lavalinkClient;\n    // Map<accountId, { client, status, voiceState, reconnectTimeout, rawVoiceData }>\n    this.bots = new Map();\n    this.start247Watchdog();\n  }\n\n  // --- 24/7 Watchdog Keep-Alive System ---\n  start247Watchdog() {\n    if (this._watchdogInterval) clearInterval(this._watchdogInterval);\n\n    logger.info(\"WATCHDOG\", \"🛡️ 24/7 Bot Keep-Alive & Token Protection Watchdog activated (Checking every 15s)\");\n\n    this._watchdogInterval = setInterval(async () => {\n      try {\n        const accounts = database.getAccounts();\n        for (const acc of accounts) {\n          if (acc.autoStart !== false) {\n            const entry = this.bots.get(acc.id);\n            const isOnline = entry && (entry.status === \"online\" || entry.status === \"connecting\");\n\n            if (!isOnline && (!entry || !entry.userStopped)) {\n              if (entry && entry.error && (entry.error.includes(\"TOKEN_INVALID\") || entry.error.includes(\"invalid token\") || entry.error.includes(\"4004\"))) {\n                continue;\n              }\n\n              const now = Date.now();\n              if (!acc._lastWatchdogStart || (now - acc._lastWatchdogStart) > 18000) {\n                acc._lastWatchdogStart = now;\n                logger.info(\"WATCHDOG\", `[24/7 Keep-Alive] Account ${acc.label} is offline. Auto-starting immediately...`);\n                this.startAccount(acc.id).catch(err => {\n                  logger.warn(\"WATCHDOG\", `[24/7 Keep-Alive] Auto-start for ${acc.label}: ${err.message}`);\n                });\n              }\n            } else if (entry && entry.status === \"online\") {\n              if (acc.voice247 && acc.voice247.enabled && acc.voice247.channelId && !entry.currentVoice) {\n                const now = Date.now();\n                if (!acc._lastVoiceRejoin || (now - acc._lastVoiceRejoin) > 15000) {\n                  acc._lastVoiceRejoin = now;\n                  logger.voice(\"24/7\", `[24/7 Voice Watchdog] Account ${acc.label} lost voice connection. Auto-rejoining VC ${acc.voice247.channelId}...`);\n                  this.joinVoice(acc.id, acc.voice247.channelId, {\n                    guildId: acc.voice247.guildId,\n                    selfMute: acc.voice247.selfMute,\n                    selfDeaf: acc.voice247.selfDeaf\n                  }).catch(e => {\n                    logger.warn(\"24/7\", `Voice rejoin error: ${e.message}`);\n                  });\n                }\n              }\n            }\n          }\n        }\n      } catch (err) {\n        logger.error(\"WATCHDOG\", `Watchdog cycle error: ${err.message}`);\n      }\n    }, 15000);\n  }\n\n  // --- Start an Account with Multi-Proxy Pool & Failover ---\n  async startAccount(accountId) {\n    const acc = database.getAccount(accountId);\n    if (!acc) throw new Error(\"Account not found\");\n\n    if (this.bots.has(accountId)) {\n      const existing = this.bots.get(accountId);\n      if (existing) existing.userStopped = false;\n      if (existing.status === \"online\" || existing.status === \"connecting\") {\n        logger.warn(\"BOT\", `Account ${acc.label} (${accountId}) is already ${existing.status}. Skipping duplicate connection.`);\n        return;\n      }\n    }\n\n    const settings = database.getSettings();\n    const isOldDeadProxy = (p) => !p || p.includes('184.178.172.17') || p.includes('pldkrffl') || p.includes('198.23.243.226') || p.includes('45.38.107.97') || p.includes('nzpqvgqf');\n    const candidateProxies = [];\n\n    // Prioritize clean, ultra-stable Direct Connection so bots stay online 24/7 without drops or flapping!\n    candidateProxies.push(null);\n\n    // If account has an explicit dedicated proxy configured, allow it as backup\n    if (acc.proxy && acc.proxy.trim() && !isOldDeadProxy(acc.proxy)) {\n      candidateProxies.push(acc.proxy.trim());\n    }\n\n    let lastError = null;\n\n    for (let i = 0; i < candidateProxies.length; i++) {\n      const proxy = candidateProxies[i];\n      const maskedProxy = proxy ? proxy.replace(/:[^:]*@/, ':****@') : 'Direct';\n      logger.info(\"BOT\", `Starting selfbot account: ${acc.label} (Attempt ${i + 1}/${candidateProxies.length}) via ${maskedProxy}...`);\n\n      try {\n        await this._startWithProxy(accountId, acc, proxy);\n        return; // Success!\n      } catch (err) {\n        lastError = err;\n        logger.warn(\"BOT\", `[${acc.label}] Attempt ${i + 1} failed: ${err.message}`);\n\n        // If Discord says token is invalid (4004 / TOKEN_INVALID), do not waste time retrying proxies\n        if (err.message && (err.message.includes(\"TOKEN_INVALID\") || err.message.includes(\"An invalid token was provided\") || err.message.includes(\"4004\"))) {\n          break;\n        }\n\n        if (i < candidateProxies.length - 1) {\n          await new Promise(r => setTimeout(r, 800));\n        }\n      }\n    }\n\n    const botEntry = this.bots.get(accountId) || { accountId, account: acc };\n    botEntry.status = \"error\";\n    botEntry.error = lastError?.message || \"Connection failed\";\n    this.bots.set(accountId, botEntry);\n    this.emit(\"botStatus\", { accountId, status: \"error\", error: botEntry.error });\n    throw lastError || new Error(\"Failed to connect with available proxies\");\n  }\n\n  async _startWithProxy(accountId, acc, proxy) {\n    const clientOptions = {\n      checkUpdate: false,\n      restRequestTimeout: 45000,\n      syncStatus: false,\n      ws: {\n        properties: {\n          os: 'Windows',\n          browser: 'Discord Client',\n          release_channel: 'stable',\n          client_version: '1.0.9155',\n          os_version: '10.0.19045',\n          os_arch: 'x64',\n          system_locale: 'en-US'\n        }\n      }\n    };\n\n    if (proxy && typeof proxy === 'string' && proxy.trim()) {\n      let formattedProxy = proxy.trim();\n      if (!formattedProxy.startsWith('http://') && !formattedProxy.startsWith('https://') && !formattedProxy.startsWith('socks5://') && !formattedProxy.startsWith('socks4://')) {\n        formattedProxy = `socks5://${formattedProxy}`;\n      }\n      clientOptions.proxy = formattedProxy;\n    }\n\n    const client = new Client(clientOptions);\n\n    // Guard against Discord API sending null friend_source_flags or other settings\n    if (client.settings && client.settings._patch) {\n      const origPatch = client.settings._patch;\n      client.settings._patch = function(data) {\n        if (data && typeof data === 'object') {\n          if (!data.friend_source_flags) {\n            data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };\n          }\n        }\n        try {\n          return origPatch.call(this, data);\n        } catch (e) {\n          return this;\n        }\n      };\n    }\n\n    const botEntry = {\n      accountId,\n      account: acc,\n      client,\n      status: \"connecting\",\n      ping: 0,\n      currentVoice: null,\n      reconnectTimeout: null,\n      rawVoiceData: {\n        sessionId: null,\n        token: null,\n        endpoint: null\n      }\n    };\n\n    this.bots.set(accountId, botEntry);\n    this.emit(\"botStatus\", { accountId, status: \"connecting\" });\n\n    // --- Setup Listeners ---\n    client.on(\"ready\", async () => {\n      botEntry.status = \"online\";\n      botEntry.error = null;\n      botEntry.ping = client.ws.ping;\n      logger.success(\"BOT\", `Account connected: ${client.user.tag} (ID: ${client.user.id}) [${proxy ? 'Proxy: ' + proxy.replace(/:[^:]*@/, ':****@') : 'Direct'}]`);\n\n      // Save working proxy to account database to maintain persistent IP address and prevent token resets\n      if (proxy) {\n        database.updateAccount(accountId, { proxy });\n      }\n\n      // Open dedicated Lavalink audio session for this bot account\n      this.lavalink.registerBotSession(client.user.id);\n\n      // Save user details\n      const userMeta = {\n        id: client.user.id,\n        tag: client.user.tag,\n        username: client.user.username,\n        avatar: client.user.displayAvatarURL({ dynamic: true, format: \"png\", size: 128 })\n      };\n      database.updateAccount(accountId, { lastKnownUser: userMeta });\n\n      // Apply initial status & activity\n      this.applyPresence(client, acc);\n\n      // Check 24/7 Voice Auto-Join\n      if (acc.voice247 && acc.voice247.enabled && acc.voice247.channelId) {\n        logger.voice(\"24/7\", `Auto-rejoining 24/7 voice channel for ${acc.label}...`);\n        setTimeout(() => {\n          this.joinVoice(accountId, acc.voice247.channelId, {\n            guildId: acc.voice247.guildId,\n            selfMute: acc.voice247.selfMute,\n            selfDeaf: acc.voice247.selfDeaf\n          });\n        }, 2000);\n      }\n\n      this.emit(\"botStatus\", { accountId, status: \"online\", user: userMeta, ping: client.ws.ping });\n    });\n\n    // Capture raw gateway events for Lavalink v4 voice handshake\n    const tryDispatchLavalinkVoice = async (guildId) => {\n      const { token, endpoint, sessionId } = botEntry.rawVoiceData;\n      const chId = botEntry.rawVoiceData.channelId || botEntry.currentVoice?.channelId;\n      if (token && endpoint && sessionId && client.user) {\n        logger.voice(\"VOICE\", `Dispatching complete voice handshake for guild ${guildId} to Lavalink...`);\n        await this.lavalink.updateVoice(guildId, {\n          token,\n          endpoint,\n          sessionId,\n          channelId: chId,\n          userId: client.user.id,\n          accountId: botEntry.accountId,\n          ownerId: botEntry.account?.ownerId || null\n        });\n      }\n    };\n\n    client.on(\"raw\", async (packet) => {\n      if (!packet.t || !packet.d) return;\n\n      if (packet.t === \"VOICE_SERVER_UPDATE\") {\n        const { token, endpoint, guild_id } = packet.d;\n        botEntry.rawVoiceData.token = token;\n        botEntry.rawVoiceData.endpoint = endpoint;\n        botEntry.rawVoiceData.guildId = guild_id;\n\n        if (!botEntry.rawVoiceData.channelId && botEntry.currentVoice?.channelId) {\n          botEntry.rawVoiceData.channelId = botEntry.currentVoice.channelId;\n        }\n\n        await tryDispatchLavalinkVoice(guild_id);\n      }\n\n      if (packet.t === \"VOICE_STATE_UPDATE\") {\n        const { session_id, user_id, channel_id, guild_id } = packet.d;\n        if (client.user && user_id === client.user.id) {\n          botEntry.rawVoiceData.sessionId = session_id;\n          \n          if (channel_id) {\n            botEntry.rawVoiceData.channelId = channel_id;\n            const ch = client.channels.cache.get(channel_id);\n            botEntry.currentVoice = {\n              guildId: guild_id,\n              guildName: ch?.guild?.name || botEntry.currentVoice?.guildName || \"Discord Server\",\n              channelId: channel_id,\n              channelName: ch?.name || botEntry.currentVoice?.channelName || channel_id\n            };\n            \n            await tryDispatchLavalinkVoice(guild_id);\n          } else {\n            // Disconnected from voice\n            botEntry.currentVoice = null;\n            botEntry.rawVoiceData.token = null;\n            botEntry.rawVoiceData.endpoint = null;\n            botEntry.rawVoiceData.channelId = null;\n            const p = this.lavalink.getPlayer(guild_id, client.user?.id);\n            if (p) p.voiceConnected = false;\n\n            // Handle 24/7 keep-alive reconnection if enabled\n            const currentAcc = database.getAccount(accountId);\n            if (currentAcc && currentAcc.voice247 && currentAcc.voice247.enabled && currentAcc.voice247.channelId) {\n              logger.warn(\"24/7\", `Account ${currentAcc.label} disconnected from voice! Scheduling 24/7 reconnect in 5s...`);\n              if (botEntry.reconnectTimeout) clearTimeout(botEntry.reconnectTimeout);\n              botEntry.reconnectTimeout = setTimeout(() => {\n                this.joinVoice(accountId, currentAcc.voice247.channelId, {\n                  guildId: currentAcc.voice247.guildId,\n                  selfMute: currentAcc.voice247.selfMute,\n                  selfDeaf: currentAcc.voice247.selfDeaf\n                });\n              }, 5000);\n            }\n          }\n\n          this.emit(\"botVoice\", { accountId, currentVoice: botEntry.currentVoice });\n        }\n      }\n    });\n\n    client.on(\"debug\", (info) => {\n      if (typeof info === 'string') {\n        if (info.includes(\"Heartbeat\") || info.includes(\"heartbeat\")) return;\n        if (info.includes(\"WS\") || info.includes(\"Gateway\") || info.includes(\"Session\") || info.includes(\"Connecting\") || info.includes(\"Handshake\") || info.includes(\"4004\") || info.includes(\"4000\")) {\n          logger.info(\"BOT_DEBUG\", `[${acc.label}] ${info}`);\n        }\n      }\n    });\n\n    client.on(\"shardError\", (err) => {\n      logger.error(\"BOT\", `[${acc.label}] Shard Error: ${err.message}`);\n      if (proxy) {\n        logger.warn(\"BOT\", `[${acc.label}] Shard proxy failure detected (${err.message}). Auto-switching to Direct Connection in 1.5s...`);\n        try { client.destroy(); } catch (_) {}\n        setTimeout(() => {\n          this._startWithProxy(accountId, acc, null).catch(e => {\n            logger.error(\"BOT\", `[${acc.label}] Direct reconnect failed: ${e.message}`);\n          });\n        }, 1500);\n        return;\n      }\n      botEntry.status = \"error\";\n      botEntry.error = err.message;\n      this.emit(\"botStatus\", { accountId, status: \"error\", error: err.message });\n    });\n\n    client.on(\"shardDisconnect\", (event) => {\n      const code = event?.code || \"unknown\";\n      const reason = event?.reason || \"none\";\n      logger.warn(\"BOT\", `[${acc.label}] Shard Disconnected (code: ${code}, reason: ${reason})`);\n      if (code !== 4004 && code !== 4014) {\n        // Auto-reconnect with proxy failover immediately so bots never stay offline\n        setTimeout(() => {\n          const current = this.bots.get(accountId);\n          if (!current || current.status !== \"online\") {\n            logger.info(\"BOT\", `[${acc.label}] 24/7 Keep-Alive: Auto-reconnecting shard...`);\n            this.startAccount(accountId).catch(() => {});\n          }\n        }, 2000);\n      }\n      botEntry.status = \"offline\";\n      this.emit(\"botStatus\", { accountId, status: \"offline\", error: `Code ${code}` });\n    });\n\n    client.on(\"invalidated\", () => {\n      logger.error(\"BOT\", `[${acc.label}] Token invalidated by Discord`);\n      botEntry.status = \"error\";\n      botEntry.error = \"Token invalidated\";\n      this.emit(\"botStatus\", { accountId, status: \"error\", error: \"Token invalidated\" });\n    });\n\n    client.on(\"error\", (err) => {\n      logger.error(\"BOT\", `[${acc.label}] Error: ${err.message}`);\n    });\n\n    client.on(\"disconnect\", () => {\n      botEntry.status = \"offline\";\n      logger.warn(\"BOT\", `[${acc.label}] Disconnected from Discord`);\n      this.emit(\"botStatus\", { accountId, status: \"offline\" });\n    });\n\n    // Clean and validate token\n    const cleanToken = (acc.token || '').trim().replace(/^[\"']|[\"']$/g, '');\n    if (!cleanToken) {\n      throw new Error(\"Token is empty or invalid format\");\n    }\n\n    // Login with account token and ensure gateway connection succeeds\n    try {\n      await new Promise((resolve, reject) => {\n        let settled = false;\n        const onReady = () => {\n          if (!settled) {\n            settled = true;\n            resolve();\n          }\n        };\n        const onError = (err) => {\n          if (!settled) {\n            settled = true;\n            reject(err);\n          }\n        };\n        client.once('ready', onReady);\n        client.once('shardError', onError);\n\n        client.login(cleanToken).catch(onError);\n\n        const handshakeTimeout = proxy ? 7000 : 12000;\n        setTimeout(() => {\n          if (!settled) {\n            settled = true;\n            if (client.ws?.status === 0) resolve();\n            else reject(new Error(`Gateway connection handshake timed out (${proxy ? 'Proxy ' + proxy : 'Direct'})`));\n          }\n        }, handshakeTimeout);\n      });\n    } catch (err) {\n      try { client.destroy(); } catch (_) {}\n      throw err;\n    }\n  }\n\n  // --- Stop an Account ---\n  async stopAccount(accountId) {\n    const botEntry = this.bots.get(accountId);\n    if (!botEntry) return;\n\n    botEntry.userStopped = true;\n\n    if (botEntry.reconnectTimeout) {\n      clearTimeout(botEntry.reconnectTimeout);\n      botEntry.reconnectTimeout = null;\n    }\n\n    try {\n      // Leave voice if in one\n      if (botEntry.currentVoice?.guildId) {\n        await this.leaveVoice(accountId);\n      }\n      botEntry.client.destroy();\n    } catch (e) {}\n\n    botEntry.status = \"offline\";\n    botEntry.currentVoice = null;\n    this.bots.delete(accountId);\n\n    logger.info(\"BOT\", `Account ${botEntry.account.label} stopped.`);\n    this.emit(\"botStatus\", { accountId, status: \"offline\" });\n  }\n\n  // --- Start All Accounts ---\n  async startAll(userId = null) {\n    const accounts = database.getAccounts(userId);\n    logger.info(\"BOT\", `Starting ${accounts.length} account(s)${userId ? ` for user ${userId}` : ''}...`);\n    // Start all accounts simultaneously at 1 time itself (instant parallel connection)\n    await Promise.allSettled(accounts.map(acc => {\n      if (acc.autoStart !== false) {\n        return this.startAccount(acc.id).catch(err => {\n          logger.error(\"BOT\", `Failed to start account ${acc.label}: ${err.message}`);\n        });\n      }\n      return Promise.resolve();\n    }));\n  }\n\n  // --- Stop All Accounts ---\n  async stopAll(userId = null) {\n    const accounts = database.getAccounts(userId);\n    logger.info(\"BOT\", `Stopping ${accounts.length} account(s)...`);\n    for (const acc of accounts) {\n      if (this.bots.has(acc.id)) {\n        await this.stopAccount(acc.id);\n      }\n    }\n  }\n\n  // --- Join Voice Channel ---\n  async joinVoice(accountId, channelId, options = {}) {\n    const botEntry = this.bots.get(accountId);\n    if (!botEntry || !botEntry.client || botEntry.status !== \"online\") {\n      throw new Error(\"Bot is not online\");\n    }\n\n    const client = botEntry.client;\n\n    // Clear any previous reconnect timeout so it doesn't pull bot back to old server\n    if (botEntry.reconnectTimeout) {\n      clearTimeout(botEntry.reconnectTimeout);\n      botEntry.reconnectTimeout = null;\n    }\n\n    // 1. Resolve channel from cache first (instant, 0ms latency)\n    let channel = client.channels.cache.get(channelId);\n    let guildId = options.guildId || channel?.guild?.id;\n    let channelName = channel?.name || channelId;\n    let guildName = channel?.guild?.name || \"Discord Server\";\n\n    // 2. If not in cache, try fast fetch with 2.5s timeout\n    if (!channel) {\n      try {\n        channel = await Promise.race([\n          client.channels.fetch(channelId),\n          new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 2500))\n        ]);\n        if (channel) {\n          guildId = guildId || channel.guild?.id;\n          channelName = channel.name || channelName;\n          guildName = channel.guild?.name || guildName;\n        }\n      } catch (e) {}\n    }\n\n    // 3. Fallback guild discovery: search all guilds this bot is in\n    if (!guildId) {\n      for (const g of client.guilds.cache.values()) {\n        if (g.channels.cache.has(channelId)) {\n          guildId = g.id;\n          channel = g.channels.cache.get(channelId);\n          guildName = g.name;\n          channelName = channel?.name || channelName;\n          break;\n        }\n      }\n    }\n\n    if (!guildId) {\n      throw new Error(`Bot is not a member of the server for channel ${channelId}`);\n    }\n\n    const selfMute = options.selfMute ?? false;\n    const selfDeaf = options.selfDeaf ?? false;\n\n    logger.voice(\"VOICE\", `Account [${botEntry.account.label}] joining \"${channelName}\" in \"${guildName}\" (${guildId})...`);\n\n    // Broadcast op 4 to Discord Gateway immediately\n    const shard = client.ws.shards.first();\n    if (!shard) {\n      throw new Error(\"No active gateway shard available\");\n    }\n\n    shard.send({\n      op: 4,\n      d: {\n        guild_id: guildId,\n        channel_id: channelId,\n        self_mute: selfMute,\n        self_deaf: selfDeaf,\n        self_video: false\n      }\n    });\n\n    botEntry.currentVoice = {\n      guildId,\n      guildName,\n      channelId,\n      channelName,\n      selfMute,\n      selfDeaf,\n      selfVideo: !!options.selfVideo\n    };\n\n    // Update Lavalink player association if player exists or created\n    botEntry.rawVoiceData.channelId = channelId;\n    botEntry.rawVoiceData.guildId = guildId;\n\n    this.lavalink.registerBotSession(client.user.id);\n    const p = this.lavalink.createPlayer(guildId, {\n      accountId,\n      userId: client.user.id,\n      channelId,\n      ownerId: botEntry.account?.ownerId || null\n    });\n\n    if (botEntry.rawVoiceData.token && botEntry.rawVoiceData.endpoint && botEntry.rawVoiceData.sessionId) {\n      this.lavalink.updateVoice(guildId, {\n        token: botEntry.rawVoiceData.token,\n        endpoint: botEntry.rawVoiceData.endpoint,\n        sessionId: botEntry.rawVoiceData.sessionId,\n        channelId,\n        userId: client.user.id,\n        accountId: botEntry.accountId,\n        ownerId: botEntry.account?.ownerId || null\n      }).catch(() => {});\n    }\n\n    this.emit(\"botVoice\", { accountId, currentVoice: botEntry.currentVoice });\n    return botEntry.currentVoice;\n  }\n\n  // --- Leave Voice Channel ---\n  async leaveVoice(accountId) {\n    const botEntry = this.bots.get(accountId);\n    if (!botEntry || !botEntry.client) return;\n\n    if (botEntry.reconnectTimeout) {\n      clearTimeout(botEntry.reconnectTimeout);\n      botEntry.reconnectTimeout = null;\n    }\n\n    const guildId = botEntry.currentVoice?.guildId;\n    if (guildId) {\n      const shard = botEntry.client.ws.shards.first();\n      if (shard) {\n        shard.send({\n          op: 4,\n          d: {\n            guild_id: guildId,\n            channel_id: null,\n            self_mute: false,\n            self_deaf: false\n          }\n        });\n      }\n\n      // Destroy Lavalink player\n      await this.lavalink.destroyPlayer(guildId, accountId, botEntry.account?.ownerId);\n    }\n\n    botEntry.currentVoice = null;\n    logger.voice(\"VOICE\", `Account [${botEntry.account.label}] left voice channel.`);\n    this.emit(\"botVoice\", { accountId, currentVoice: null });\n  }\n\n  // Camera feature disabled\n  async setCamera(accountId, enabled = false) {\n    return { success: true, disabled: true };\n  }\n\n  async setAllCamera(userId = null, enabled = false) {\n    return { success: true, count: 0, disabled: true };\n  }\n\n  // --- Configure 24/7 Stay ---\n  async set247(accountId, { enabled, guildId, channelId, selfMute = false, selfDeaf = false }) {\n    const acc = database.getAccount(accountId);\n    if (!acc) throw new Error(\"Account not found\");\n\n    let guildName = \"\";\n    let channelName = \"\";\n\n    const botEntry = this.bots.get(accountId);\n    if (botEntry && botEntry.client && channelId) {\n      try {\n        const ch = await botEntry.client.channels.fetch(channelId);\n        if (ch) {\n          channelName = ch.name;\n          guildName = ch.guild.name;\n        }\n      } catch (e) {}\n    }\n\n    const voice247Config = {\n      enabled: !!enabled,\n      guildId: guildId || \"\",\n      guildName,\n      channelId: channelId || \"\",\n      channelName,\n      selfMute: !!selfMute,\n      selfDeaf: !!selfDeaf\n    };\n\n    database.updateAccount(accountId, { voice247: voice247Config });\n    logger.voice(\"24/7\", `Updated 24/7 config for ${acc.label}: ${enabled ? \"ACTIVE on \" + (channelName || channelId) : \"DISABLED\"}`);\n\n    if (enabled && channelId && botEntry && botEntry.status === \"online\") {\n      await this.joinVoice(accountId, channelId, { guildId, selfMute, selfDeaf });\n    } else if (!enabled && botEntry && botEntry.currentVoice) {\n      await this.leaveVoice(accountId);\n    }\n\n    return voice247Config;\n  }\n\n  // --- Mass Voice: Join ALL Accounts to a Voice Channel & Enable 24/7 ---\n  async joinAllToVoice(userId = null, channelId, { guildId = null, keep247 = true, selfMute = false, selfDeaf = false } = {}) {\n    if (!channelId) throw new Error(\"Voice Channel ID is required\");\n\n    const accounts = database.getAccounts(userId);\n    if (!accounts || accounts.length === 0) throw new Error(\"No Discord accounts found in your dashboard.\");\n\n    let detectedGuildId = guildId;\n    let channelName = \"\";\n    let guildName = \"\";\n\n    // Fast cache discovery from any online bot\n    for (const [id, botEntry] of this.bots) {\n      if (botEntry.client && botEntry.status === \"online\") {\n        const cached = botEntry.client.channels.cache.get(channelId);\n        if (cached) {\n          channelName = cached.name || channelName;\n          guildName = cached.guild?.name || guildName;\n          detectedGuildId = detectedGuildId || cached.guild?.id;\n          break;\n        }\n        for (const guild of botEntry.client.guilds.cache.values()) {\n          const ch = guild.channels.cache.get(channelId);\n          if (ch) {\n            channelName = ch.name || channelName;\n            guildName = guild.name || guildName;\n            detectedGuildId = detectedGuildId || guild.id;\n            break;\n          }\n        }\n        if (detectedGuildId) break;\n      }\n    }\n\n    // Single-attempt fast fetch if still not detected\n    if (!detectedGuildId) {\n      for (const [id, botEntry] of this.bots) {\n        if (botEntry.client && botEntry.status === \"online\") {\n          try {\n            const fetched = await Promise.race([\n              botEntry.client.channels.fetch(channelId),\n              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))\n            ]);\n            if (fetched) {\n              channelName = fetched.name || channelName;\n              guildName = fetched.guild?.name || guildName;\n              detectedGuildId = fetched.guild?.id || detectedGuildId;\n              break;\n            }\n          } catch (_) {}\n        }\n      }\n    }\n\n    // Immediately update database 24/7 settings so bots never reconnect to old servers\n    for (const acc of accounts) {\n      const voice247Config = {\n        enabled: !!keep247,\n        guildId: detectedGuildId || \"\",\n        guildName: guildName || \"\",\n        channelId: channelId,\n        channelName: channelName || \"\",\n        selfMute: !!selfMute,\n        selfDeaf: !!selfDeaf\n      };\n      database.updateAccount(acc.id, { voice247: voice247Config });\n    }\n\n    let joinedCount = 0;\n    const errors = [];\n\n    // Parallel join execution for instant lockstep entry\n    await Promise.allSettled(accounts.map(async (acc) => {\n      const botEntry = this.bots.get(acc.id);\n      if (botEntry && botEntry.status === \"online\") {\n        try {\n          await this.joinVoice(acc.id, channelId, {\n            guildId: detectedGuildId,\n            selfMute,\n            selfDeaf\n          });\n          joinedCount++;\n        } catch (err) {\n          errors.push(`${acc.label || acc.id}: ${err.message}`);\n        }\n      }\n    }));\n\n    logger.voice(\"24/7\", `Mass voice join executed: ${joinedCount}/${accounts.length} bots joined ${channelName || channelId} (24/7: ${keep247 ? 'ACTIVE' : 'OFF'})`);\n    this.emit(\"accountsUpdated\", { accounts: this.getAllBotsStatus(userId) });\n\n    return {\n      success: true,\n      total: accounts.length,\n      joined: joinedCount,\n      channelName: channelName || channelId,\n      guildName,\n      keep247,\n      errors\n    };\n  }\n\n  // --- Mass Voice: Disconnect ALL Accounts from Voice ---\n  async leaveAllVoice(userId = null, disable247 = true) {\n    const accounts = database.getAccounts(userId);\n    let leftCount = 0;\n\n    for (const acc of accounts) {\n      if (disable247) {\n        database.updateAccount(acc.id, {\n          voice247: {\n            enabled: false,\n            guildId: \"\",\n            guildName: \"\",\n            channelId: \"\",\n            channelName: \"\",\n            selfMute: false,\n            selfDeaf: false\n          }\n        });\n      }\n\n      const botEntry = this.bots.get(acc.id);\n      if (botEntry) {\n        try {\n          await this.leaveVoice(acc.id);\n          leftCount++;\n        } catch (e) {}\n      }\n    }\n\n    logger.voice(\"24/7\", `Mass voice disconnect: ${leftCount} bots left voice.`);\n    this.emit(\"accountsUpdated\", { accounts: this.getAllBotsStatus(userId) });\n\n    return { success: true, leftCount };\n  }\n\n  // --- Apply Presence ---\n  applyPresence(client, acc) {\n    if (!client.user) return;\n\n    try {\n      // Set status: online, idle, dnd, invisible\n      const status = acc.status || \"online\";\n      client.user.setStatus(status);\n\n      // Set activity if configured\n      if (acc.activity && acc.activity.name) {\n        client.user.setActivity(acc.activity.name, {\n          type: acc.activity.type || \"PLAYING\",\n          url: acc.activity.url || undefined\n        });\n      }\n    } catch (err) {\n      logger.warn(\"BOT\", `Could not update presence: ${err.message}`);\n    }\n  }\n\n  // --- Set Status & Activity ---\n  setStatus(accountId, status, activity = null) {\n    const acc = database.getAccount(accountId);\n    if (!acc) throw new Error(\"Account not found\");\n\n    const updates = { status };\n    if (activity !== null) updates.activity = activity;\n\n    database.updateAccount(accountId, updates);\n\n    const botEntry = this.bots.get(accountId);\n    if (botEntry && botEntry.client && botEntry.status === \"online\") {\n      this.applyPresence(botEntry.client, { ...acc, ...updates });\n    }\n  }\n\n  // --- Get Guilds & Voice Channels for an Account ---\n  async getGuildsAndChannels(accountId) {\n    const botEntry = this.bots.get(accountId);\n    if (!botEntry || !botEntry.client || botEntry.status !== \"online\") {\n      return [];\n    }\n\n    const client = botEntry.client;\n    const guildsList = [];\n\n    for (const [, guild] of client.guilds.cache) {\n      const voiceChannels = [];\n      for (const [, ch] of guild.channels.cache) {\n        if (ch.isVoice()) {\n          voiceChannels.push({\n            id: ch.id,\n            name: ch.name,\n            type: ch.type,\n            userLimit: ch.userLimit,\n            bitrate: ch.bitrate\n          });\n        }\n      }\n\n      guildsList.push({\n        id: guild.id,\n        name: guild.name,\n        icon: guild.iconURL({ dynamic: true, format: \"png\", size: 64 }),\n        voiceChannels\n      });\n    }\n\n    return guildsList;\n  }\n\n  // --- Get Status Summary for accounts (filtered by userId if provided) ---\n  // --- Permanent Guild Leave (Single Bot with Proxy & 24/7 Cleanup) ---\n  async leaveGuild(accountId, guildId, options = {}) {\n    const acc = database.getAccount(accountId);\n    if (!acc) throw new Error(\"Account not found\");\n\n    const botEntry = this.bots.get(accountId);\n    const client = botEntry?.client;\n\n    let guildName = guildId;\n    if (client) {\n      const cachedGuild = client.guilds.cache.get(guildId);\n      if (cachedGuild) guildName = cachedGuild.name;\n    }\n\n    // 1. Permanently delete/disable 24/7 Voice Stay for this server so it never auto-reconnects\n    if (acc.voice247 && (acc.voice247.guildId === guildId || !guildId)) {\n      database.updateVoice247(accountId, {\n        enabled: false,\n        guildId: \"\",\n        guildName: \"\",\n        channelId: \"\",\n        channelName: \"\",\n        selfMute: false,\n        selfDeaf: false\n      });\n      logger.info(\"GUILD\", `[${acc.label}] Permanently disabled 24/7 Voice Stay for guild \"${guildName}\" (${guildId})`);\n    }\n\n    // 2. Disconnect from voice channel if currently inside this guild\n    if (botEntry?.currentVoice?.guildId === guildId) {\n      try {\n        await this.leaveVoice(accountId);\n      } catch (e) {}\n    }\n\n    // 3. Perform leave via Rotating Proxy REST or Client\n    let leaveSuccess = false;\n    let usedProxy = null;\n\n    if (options.useProxy !== false && freeProxiesList.length > 0) {\n      const candidate = getNextRotatingProxy();\n      usedProxy = candidate;\n      try {\n        const restRes = await executeGuildLeaveRest(acc.token, guildId, candidate);\n        if (restRes.ok) {\n          leaveSuccess = true;\n          logger.success(\"GUILD\", `[${acc.label}] Successfully left server \"${guildName}\" via proxy (${candidate}) [Status ${restRes.status}]`);\n        }\n      } catch (proxyErr) {\n        logger.warn(\"GUILD\", `[${acc.label}] Proxy leave attempt with ${candidate} failed (${proxyErr.message}), falling back to direct leave...`);\n      }\n    }\n\n    // Direct fallback if proxy disabled, failed, or direct client available\n    if (!leaveSuccess) {\n      if (client && client.guilds.cache.has(guildId)) {\n        try {\n          await client.guilds.cache.get(guildId).leave();\n          leaveSuccess = true;\n          logger.success(\"GUILD\", `[${acc.label}] Successfully left server \"${guildName}\" directly via client`);\n        } catch (clientErr) {\n          if (clientErr.code === 10004 || clientErr.message?.includes('Unknown Guild')) {\n            leaveSuccess = true;\n          } else {\n            throw clientErr;\n          }\n        }\n      } else {\n        const directRes = await executeGuildLeaveRest(acc.token, guildId, null);\n        if (directRes.ok) {\n          leaveSuccess = true;\n          logger.success(\"GUILD\", `[${acc.label}] Successfully left server \"${guildName}\" directly via REST`);\n        } else {\n          throw new Error(directRes.error || `Failed to leave server (Status: ${directRes.status})`);\n        }\n      }\n    }\n\n    // 4. Remove from bot's memory cache\n    if (client) {\n      client.guilds.cache.delete(guildId);\n    }\n\n    this.emit(\"guildLeave\", { accountId, guildId, guildName });\n\n    return {\n      success: true,\n      accountId,\n      accountLabel: acc.label,\n      guildId,\n      guildName,\n      usedProxy: usedProxy || \"Direct\"\n    };\n  }\n\n  // --- Permanent Guild Leave for ALL BOTS (Mass Leave with Proxy Rotation & Jitter Stagger) ---\n  async leaveGuildAllBots(userId, guildId, options = {}) {\n    const accounts = database.getAccounts(userId);\n    const results = [];\n    let leftCount = 0;\n    let targetGuildName = guildId;\n\n    const targetBots = [];\n    for (const acc of accounts) {\n      const b = this.bots.get(acc.id);\n      if (b && b.status === \"online\" && b.client) {\n        if (b.client.guilds.cache.has(guildId)) {\n          targetGuildName = b.client.guilds.cache.get(guildId).name;\n          targetBots.push(acc);\n        }\n      }\n    }\n\n    if (targetBots.length === 0) {\n      for (const acc of accounts) {\n        const b = this.bots.get(acc.id);\n        if (b && b.status === \"online\") {\n          targetBots.push(acc);\n        }\n      }\n    }\n\n    logger.info(\"GUILD\", `Initiating permanent server leave for \"${targetGuildName}\" (${guildId}) across ${targetBots.length} bots with proxy rotation & rate limit stagger...`);\n\n    for (let i = 0; i < targetBots.length; i++) {\n      const acc = targetBots[i];\n      try {\n        const res = await this.leaveGuild(acc.id, guildId, options);\n        results.push({ accountId: acc.id, label: acc.label, success: true, proxy: res.usedProxy });\n        leftCount++;\n      } catch (err) {\n        logger.error(\"GUILD\", `[${acc.label}] Failed to leave server ${guildId}: ${err.message}`);\n        results.push({ accountId: acc.id, label: acc.label, success: false, error: err.message });\n      }\n\n      if (i < targetBots.length - 1) {\n        const jitter = Math.floor(1200 + Math.random() * 800);\n        await new Promise(r => setTimeout(r, jitter));\n      }\n    }\n\n    return {\n      success: true,\n      guildId,\n      guildName: targetGuildName,\n      totalBots: targetBots.length,\n      leftCount,\n      results\n    };\n  }\n\n  // --- Get Deduplicated Summary of All Guilds Across Online Bots ---\n  getAllGuildsSummary(userId = null) {\n    let accounts = database.getAccounts(userId);\n    if (!accounts || accounts.length === 0) {\n      accounts = database.accounts || [];\n    }\n    const guildsMap = new Map();\n\n    for (const acc of accounts) {\n      const botEntry = this.bots.get(acc.id);\n      if (botEntry && botEntry.status === \"online\" && botEntry.client) {\n        try {\n          for (const [, guild] of botEntry.client.guilds.cache) {\n            if (!guildsMap.has(guild.id)) {\n              let iconUrl = null;\n              try {\n                iconUrl = guild.iconURL({ dynamic: true, format: \"png\", size: 64 });\n              } catch (e) {}\n              guildsMap.set(guild.id, {\n                id: guild.id,\n                name: guild.name || `Server ${guild.id}`,\n                icon: iconUrl,\n                botCount: 0,\n                memberBots: []\n              });\n            }\n            const entry = guildsMap.get(guild.id);\n            entry.botCount++;\n            entry.memberBots.push({\n              id: acc.id,\n              label: acc.label,\n              username: botEntry.client.user?.username || acc.label\n            });\n          }\n        } catch (e) {}\n      }\n    }\n\n    return Array.from(guildsMap.values()).sort((a, b) => b.botCount - a.botCount);\n  }\n\n  getAllBotsStatus(userId = null) {\n    const accounts = database.getAccounts(userId);\n    return accounts.map(acc => {\n      const live = this.bots.get(acc.id);\n      return {\n        id: acc.id,\n        ownerId: acc.ownerId,\n        label: acc.label,\n        token: acc.token || \"\",\n        tokenMasked: acc.token || \"\",\n        autoStart: acc.autoStart,\n        status: live ? live.status : \"offline\",\n        error: live?.error || null,\n        ping: live ? live.ping : 0,\n        user: live?.client?.user ? {\n          id: live.client.user.id,\n          tag: live.client.user.tag,\n          username: live.client.user.username,\n          avatar: live.client.user.displayAvatarURL({ dynamic: true, format: \"png\", size: 128 })\n        } : acc.lastKnownUser,\n        currentVoice: live?.currentVoice || null,\n        voice247: acc.voice247,\n        presence: {\n          status: acc.status || \"online\",\n          activity: acc.activity || null\n        }\n      };\n    });\n  }\n}\n\nmodule.exports = BotManager;\n","database.js":"const fs = require('fs');\nconst path = require('path');\nconst config = require('./config');\nconst logger = require('./logger');\nconst sqliteStore = require('./sqliteStore');\n\nclass Database {\n  constructor() {\n    this.ensureDirs();\n    this.accounts = this.loadJSON(config.accountsFile, []);\n\n    this.settings = this.loadJSON(config.settingsFile, {\n      lavalink: config.defaultNode,\n      webPort: config.port,\n      autoReconnectVoice: true,\n      reconnectIntervalSec: 5\n    });\n  }\n\n  ensureDirs() {\n    if (!fs.existsSync(config.dataDir)) {\n      fs.mkdirSync(config.dataDir, { recursive: true });\n    }\n  }\n\n  loadJSON(filePath, fallback) {\n    return sqliteStore.getJSON(path.basename(filePath, '.json'), fallback, filePath);\n  }\n\n  saveJSON(filePath, data, triggerSync = true) {\n    sqliteStore.setJSON(path.basename(filePath, '.json'), data);\n    return true;\n  }\n\n  // --- Account methods (Strict Isolation: Only returns accounts owned by this key) ---\n  getAccounts(userId = null) {\n    if (!userId) return [...this.accounts];\n    return this.accounts.filter(a => a.ownerId === userId);\n  }\n\n  getAccount(id, userId = null) {\n    const acc = this.accounts.find(a => a.id === id);\n    if (!acc) return null;\n    if (userId && acc.ownerId !== userId) return null;\n    return acc;\n  }\n\n  addAccount({ token, label = 'Selfbot Account', autoStart = true, ownerId = 'default', ownerUsername = '' }) {\n    // Check if token already exists for THIS user\n    const cleanToken = token.trim().replace(/^\"|\"$/g, '');\n    const existing = this.accounts.find(a => a.token === cleanToken && a.ownerId === ownerId);\n    if (existing) {\n      throw new Error('This account token is already added to your dashboard.');\n    }\n\n    // Check if the underlying Discord user ID is already added under another token\n    const tokenPart = cleanToken.split('.')[0];\n    try {\n      const decodedUid = Buffer.from(tokenPart, 'base64').toString('utf8');\n      if (/^\\d{17,20}$/.test(decodedUid)) {\n        const dupUser = this.accounts.find(a => {\n          if (a.ownerId !== ownerId) return false;\n          if (a.lastKnownUser?.id === decodedUid) return true;\n          const aPart = (a.token || '').split('.')[0];\n          try {\n            return Buffer.from(aPart, 'base64').toString('utf8') === decodedUid;\n          } catch (_) { return false; }\n        });\n        if (dupUser) {\n          throw new Error(`This token belongs to \"${dupUser.label || dupUser.lastKnownUser?.username || decodedUid}\", which is already in your dashboard! Discord only allows one voice connection per user account.`);\n        }\n      }\n    } catch (_) {}\n\n    const newAcc = {\n      id: 'acc_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),\n      ownerId: ownerId,\n      ownerUsername: ownerUsername,\n      token: cleanToken,\n      label: label.trim() || 'Selfbot Account',\n      autoStart: autoStart !== false,\n      status: 'online',\n      activity: {\n        type: 'PLAYING',\n        name: '24/7 Music'\n      },\n      voice247: {\n        enabled: false,\n        guildId: '',\n        guildName: '',\n        channelId: '',\n        channelName: '',\n        selfMute: false,\n        selfDeaf: false\n      },\n      lastKnownUser: null,\n      createdAt: new Date().toISOString(),\n      updatedAt: new Date().toISOString()\n    };\n\n    this.accounts.push(newAcc);\n    this.saveJSON(config.accountsFile, this.accounts);\n    return newAcc;\n  }\n\n  updateAccount(id, updates, userId = null) {\n    const idx = this.accounts.findIndex(a => a.id === id && (!userId || a.ownerId === userId));\n    if (idx === -1) return null;\n\n    this.accounts[idx] = {\n      ...this.accounts[idx],\n      ...updates,\n      updatedAt: new Date().toISOString()\n    };\n\n    this.saveJSON(config.accountsFile, this.accounts);\n    return this.accounts[idx];\n  }\n\n  removeAccount(id, userId = null) {\n    const idx = this.accounts.findIndex(a => a.id === id && (!userId || a.ownerId === userId));\n    if (idx === -1) return false;\n\n    this.accounts.splice(idx, 1);\n    this.saveJSON(config.accountsFile, this.accounts);\n    return true;\n  }\n\n  // --- Settings methods ---\n  getSettings() {\n    return this.settings;\n  }\n\n  updateSettings(updates) {\n    this.settings = {\n      ...this.settings,\n      ...updates\n    };\n    this.saveJSON(config.settingsFile, this.settings);\n    return this.settings;\n  }\n\n  restoreAccounts(importedAccounts) {\n    if (!Array.isArray(importedAccounts)) return 0;\n    let count = 0;\n    for (const a of importedAccounts) {\n      if (!a || !a.token) continue;\n      const cleanToken = a.token.trim().replace(/^\"|\"$/g, '');\n      const existing = this.accounts.find(x => x.id === a.id || (x.token === cleanToken && x.ownerId === a.ownerId));\n      if (!existing) {\n        this.accounts.push({\n          id: a.id || `acc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,\n          token: cleanToken,\n          label: a.label || 'Restored Bot',\n          autoStart: a.autoStart !== false,\n          status: 'offline',\n          activity: a.activity || { type: 'PLAYING', name: '24/7 Voice' },\n          voice247: a.voice247 || { enabled: false },\n          lastKnownUser: a.lastKnownUser || null,\n          createdAt: a.createdAt || new Date().toISOString(),\n          updatedAt: new Date().toISOString(),\n          ownerId: a.ownerId || 'default',\n          ownerUsername: a.ownerUsername || ''\n        });\n        count++;\n      }\n    }\n    if (count > 0) {\n      this.saveJSON(config.accountsFile, this.accounts);\n      logger.success('DB', `Restored ${count} bot account(s) into database.`);\n    }\n    return count;\n  }\n\n  // --- Uploaded MP3 Songs methods ---\n  getUploadedSongs(userId = null) {\n    if (!this.uploadedSongs) {\n      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);\n    }\n    if (!userId) return this.uploadedSongs;\n    return this.uploadedSongs.filter(s => s.ownerId === userId);\n  }\n\n  saveUploadedSong(song) {\n    if (!this.uploadedSongs) {\n      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);\n    }\n    this.uploadedSongs.unshift(song);\n    this.saveJSON(config.uploadsFile, this.uploadedSongs, false);\n    return song;\n  }\n\n  deleteUploadedSong(id, userId = null) {\n    if (!this.uploadedSongs) {\n      this.uploadedSongs = this.loadJSON(config.uploadsFile, []);\n    }\n    const idx = this.uploadedSongs.findIndex(s => s.id === id && (!userId || s.ownerId === userId));\n    if (idx !== -1) {\n      const removed = this.uploadedSongs.splice(idx, 1)[0];\n      this.saveJSON(config.uploadsFile, this.uploadedSongs, false);\n      return removed;\n    }\n    return null;\n  }\n}\n\nmodule.exports = new Database();\n","logger.js":"const EventEmitter = require('events');\n\nclass Logger extends EventEmitter {\n  constructor(maxLogs = 500) {\n    super();\n    this.maxLogs = maxLogs;\n    this.logs = [];\n  }\n\n  log(level, tag, message, meta = {}) {\n    const timestamp = new Date().toISOString();\n    const entry = {\n      id: Date.now() + Math.random().toString(36).substring(2, 6),\n      timestamp,\n      level: level.toUpperCase(),\n      tag,\n      message,\n      meta\n    };\n\n    this.logs.push(entry);\n    if (this.logs.length > this.maxLogs) {\n      this.logs.shift();\n    }\n\n    const color = this.getLevelColor(entry.level);\n    console.log(`${color}[${entry.timestamp.substring(11, 19)}] [${entry.level}] [${tag}] \\x1b[0m${message}`);\n\n    this.emit('log', entry);\n    return entry;\n  }\n\n  getLevelColor(level) {\n    switch (level) {\n      case 'ERROR': return '\\x1b[31m'; // Red\n      case 'WARN':  return '\\x1b[33m'; // Yellow\n      case 'VOICE': return '\\x1b[35m'; // Magenta\n      case 'MUSIC': return '\\x1b[36m'; // Cyan\n      case 'SUCCESS': return '\\x1b[32m'; // Green\n      default: return '\\x1b[34m'; // Blue\n    }\n  }\n\n  info(tag, message, meta) { return this.log('INFO', tag, message, meta); }\n  warn(tag, message, meta) { return this.log('WARN', tag, message, meta); }\n  error(tag, message, meta) { return this.log('ERROR', tag, message, meta); }\n  voice(tag, message, meta) { return this.log('VOICE', tag, message, meta); }\n  music(tag, message, meta) { return this.log('MUSIC', tag, message, meta); }\n  success(tag, message, meta) { return this.log('SUCCESS', tag, message, meta); }\n\n  getRecentLogs(limit = 100) {\n    return this.logs.slice(-limit);\n  }\n\n  clear() {\n    this.logs = [];\n    this.emit('cleared');\n  }\n}\n\nmodule.exports = new Logger();\n","sqliteStore.js":"const fs = require('fs');\r\nconst path = require('path');\r\nconst { DatabaseSync } = require('node:sqlite');\r\nconst config = require('./config');\r\n\r\nclass SQLiteStore {\r\n  constructor() {\r\n    const databasePath = process.env.SQLITE_PATH || config.sqliteFile;\r\n    fs.mkdirSync(path.dirname(databasePath), { recursive: true });\r\n    this.db = new DatabaseSync(databasePath);\r\n    this.db.exec(`\r\n      PRAGMA journal_mode = WAL;\r\n      PRAGMA busy_timeout = 5000;\r\n      CREATE TABLE IF NOT EXISTS app_state (\r\n        key TEXT PRIMARY KEY,\r\n        value TEXT NOT NULL,\r\n        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\r\n      );\r\n    `);\r\n    this.readStatement = this.db.prepare('SELECT value FROM app_state WHERE key = ?');\r\n    this.writeStatement = this.db.prepare(`\r\n      INSERT INTO app_state (key, value, updated_at)\r\n      VALUES (?, ?, CURRENT_TIMESTAMP)\r\n      ON CONFLICT(key) DO UPDATE SET\r\n        value = excluded.value,\r\n        updated_at = CURRENT_TIMESTAMP\r\n    `);\r\n  }\r\n\r\n  getJSON(key, fallback, legacyFile = null) {\r\n    const row = this.readStatement.get(key);\r\n    if (row) return JSON.parse(row.value);\r\n\r\n    if (legacyFile && fs.existsSync(legacyFile)) {\r\n      try {\r\n        const value = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));\r\n        this.setJSON(key, value);\r\n        return value;\r\n      } catch (error) {\r\n        throw new Error(`Failed to migrate ${legacyFile} to SQLite: ${error.message}`);\r\n      }\r\n    }\r\n\r\n    this.setJSON(key, fallback);\r\n    return fallback;\r\n  }\r\n\r\n  setJSON(key, value) {\r\n    this.writeStatement.run(key, JSON.stringify(value));\r\n  }\r\n\r\n  getStatus() {\r\n    return { connected: true, provider: 'SQLite', database: process.env.SQLITE_PATH || config.sqliteFile };\r\n  }\r\n\r\n  close() {\r\n    this.db.close();\r\n  }\r\n}\r\n\r\nmodule.exports = new SQLiteStore();\r\n","config.js":"const path = require('path');\nrequire('dotenv').config();\n\nfunction parseBoolean(val) {\n  if (typeof val === 'boolean') return val;\n  if (!val) return false;\n  return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase().trim());\n}\n\nconst lavalinkNodes = [\n  {\n    name: process.env.NODE_NAME || \"Lava Lenin\",\n    host: \"noi6.visihost.in\",\n    port: 25591,\n    url: process.env.NODE_URL || \"noi6.visihost.in:25591\",\n    auth: process.env.NODE_AUTH || \"ganahubkl\",\n    secure: parseBoolean(process.env.NODE_SECURE || \"false\"),\n    version: 4\n  }\n];\n\nmodule.exports = {\n  port: parseInt(process.env.SERVER_PORT || process.env.PORT || '24681', 10),\n  host: process.env.HOST || '0.0.0.0',\n  dataDir: path.join(__dirname, '..', 'data'),\n  sqliteFile: path.join(__dirname, '..', 'data', 'exc.sqlite'),\n  accountsFile: path.join(__dirname, '..', 'data', 'accounts.json'),\n  settingsFile: path.join(__dirname, '..', 'data', 'settings.json'),\n  uploadsFile: path.join(__dirname, '..', 'data', 'uploaded_songs.json'),\n  \n  // Default Discord Proxy\n  defaultProxy: null,\n\n  // Only the user's active Lavalink node\n  nodes: lavalinkNodes,\n\n  // Default active Lavalink node\n  defaultNode: {\n    url: process.env.NODE_URL || \"noi6.visihost.in:25591\",\n    name: process.env.NODE_NAME || \"Lava Lenin\",\n    auth: process.env.NODE_AUTH || \"ganahubkl\",\n    secure: parseBoolean(process.env.NODE_SECURE || \"false\"),\n    host: \"noi6.visihost.in\",\n    port: 25591,\n    version: 4\n  },\n  \n  parseBoolean\n};\n","licenseManager.js":"const fs = require('fs');\nconst path = require('path');\nconst crypto = require('crypto');\nconst config = require('./config');\nconst logger = require('./logger');\nconst sqliteStore = require('./sqliteStore');\n\nclass LicenseManager {\n  constructor() {\n    this.licensesFile = path.join(config.dataDir, 'licenses.json');\n    this.licenses = [];\n    this.init();\n  }\n\n  init() {\n    this.licenses = sqliteStore.getJSON('licenses', [], this.licensesFile);\n\n    // Ensure default demo/admin key exists if empty\n    if (this.licenses.length === 0) {\n      this.licenses.push({\n        id: 'lic_' + crypto.randomBytes(8).toString('hex'),\n        key: 'EXC-PREMIUM-ADMIN-LIFETIME',\n        status: 'active',\n        botLimit: 100,\n        days: 9999,\n        expiry: null, // lifetime\n        hwid: null,\n        usedBy: 'admin',\n        note: 'Default Master License',\n        createdAt: new Date().toISOString(),\n        usedAt: new Date().toISOString()\n      });\n      this.saveLicenses(false);\n    }\n  }\n\n  loadJSON(file, fallback) {\n    try {\n      if (fs.existsSync(file)) {\n        return JSON.parse(fs.readFileSync(file, 'utf8'));\n      }\n    } catch (e) {\n      logger.error('LICENSE', `Failed to load ${file}: ${e.message}`);\n    }\n    return fallback;\n  }\n\n  saveLicenses(triggerSync = true) {\n    try {\n      sqliteStore.setJSON('licenses', this.licenses);\n    } catch (e) {\n      logger.error('LICENSE', `Failed to save licenses: ${e.message}`);\n    }\n  }\n\n  /**\n   * Generate a random license key matching a pattern e.g. EXC-XXXX-XXXX-XXXX\n   */\n  generateKeyString(mask = 'EXC-XXXX-XXXX-XXXX') {\n    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';\n    return mask.replace(/X/g, () => chars[Math.floor(Math.random() * chars.length)]);\n  }\n\n  /**\n   * Create 1 or bulk licenses\n   */\n  createLicenses({ amount = 1, mask = 'EXC-XXXX-XXXX-XXXX', days = 30, botLimit = 10, note = '', createdBy = 'Admin' }) {\n    const count = Math.min(Math.max(parseInt(amount, 10) || 1, 1), 100);\n    const quota = Math.max(parseInt(botLimit, 10) || 10, 1);\n    const duration = parseInt(days, 10) || 30;\n    const createdKeys = [];\n\n    for (let i = 0; i < count; i++) {\n      let key = this.generateKeyString(mask);\n      // Ensure unique\n      while (this.licenses.some(l => l.key === key)) {\n        key = this.generateKeyString(mask);\n      }\n\n      const lic = {\n        id: 'lic_' + crypto.randomBytes(8).toString('hex'),\n        key,\n        status: 'unused', // 'unused' | 'active' | 'banned' | 'expired'\n        botLimit: quota,\n        days: duration,\n        expiry: null, // set when first activated\n        hwid: null,\n        usedBy: null,\n        note: note ? `${note} (Created by ${createdBy})` : `Created by ${createdBy}`,\n        createdAt: new Date().toISOString(),\n        usedAt: null\n      };\n\n      this.licenses.unshift(lic);\n      createdKeys.push(lic);\n    }\n\n    this.saveLicenses();\n    logger.success('LICENSE', `Generated ${createdKeys.length} new license(s) with ${quota} bots quota each.`);\n    return createdKeys;\n  }\n\n  /**\n   * Validate and authenticate with a license key\n   */\n  validateLicense(key, clientHwid = null) {\n    if (!key || typeof key !== 'string') {\n      throw new Error('Please enter a license key');\n    }\n    const cleanKey = key.trim().toUpperCase();\n    const lic = this.licenses.find(l => l.key.toUpperCase() === cleanKey);\n\n    if (!lic) {\n      return null; // not found in local system (can fallback to external KeyAuth)\n    }\n\n    if (lic.status === 'banned') {\n      throw new Error('This license key has been banned by an administrator.');\n    }\n\n    // Check expiry if already activated\n    if (lic.expiry) {\n      const expDate = new Date(lic.expiry);\n      if (Date.now() > expDate.getTime()) {\n        lic.status = 'expired';\n        this.saveLicenses(false);\n        throw new Error(`This license key expired on ${expDate.toLocaleDateString()}. Contact admin for renewal.`);\n      }\n    }\n\n    // If unused, activate on first login\n    if (lic.status === 'unused') {\n      lic.status = 'active';\n      lic.hwid = clientHwid || `HWID-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;\n      lic.usedBy = cleanKey.substring(0, 16);\n      lic.usedAt = new Date().toISOString();\n      if (lic.days > 0 && lic.days < 9999) {\n        const exp = new Date();\n        exp.setDate(exp.getDate() + lic.days);\n        lic.expiry = exp.toISOString();\n      } else {\n        lic.expiry = null; // lifetime\n      }\n      this.saveLicenses();\n      logger.success('LICENSE', `License \"${lic.key}\" activated with HWID \"${lic.hwid}\" (Quota: ${lic.botLimit} bots).`);\n    } else {\n      // License is already active: verify HWID\n      if (lic.hwid && clientHwid) {\n        if (lic.hwid.toUpperCase() !== clientHwid.toUpperCase()) {\n          throw new Error(\"HWID doesn't match! This key is locked to another device. Ask admin for a HWID reset.\");\n        }\n      } else if (!lic.hwid && clientHwid) {\n        // HWID was reset, bind to new device\n        lic.hwid = clientHwid;\n        this.saveLicenses();\n      }\n    }\n\n    return lic;\n  }\n\n  /**\n   * Reset HWID for a license\n   */\n  resetHwid(keyOrId) {\n    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());\n    if (!lic) return false;\n    lic.hwid = null;\n    this.saveLicenses();\n    logger.info('LICENSE', `HWID reset for license \"${lic.key}\".`);\n    return true;\n  }\n\n  /**\n   * Update bot quota limit for a license\n   */\n  updateBotLimit(keyOrId, newLimit) {\n    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());\n    if (!lic) return false;\n    lic.botLimit = Math.max(parseInt(newLimit, 10) || 10, 1);\n    this.saveLicenses();\n    logger.info('LICENSE', `Bot limit updated to ${lic.botLimit} for license \"${lic.key}\".`);\n    return true;\n  }\n\n  getBotLimit(key) {\n    if (!key || typeof key !== 'string') return null;\n    const cleanKey = key.trim().toUpperCase();\n    const lic = this.licenses.find(l => l.key.toUpperCase() === cleanKey || l.id === key);\n    return lic && typeof lic.botLimit === 'number' ? lic.botLimit : null;\n  }\n\n  /**\n   * Toggle Ban status\n   */\n  toggleBan(keyOrId) {\n    const lic = this.licenses.find(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());\n    if (!lic) return false;\n    lic.status = lic.status === 'banned' ? (lic.usedAt ? 'active' : 'unused') : 'banned';\n    this.saveLicenses();\n    return lic.status;\n  }\n\n  /**\n   * Delete a license\n   */\n  deleteLicense(keyOrId) {\n    const idx = this.licenses.findIndex(l => l.id === keyOrId || l.key.toUpperCase() === keyOrId.toUpperCase());\n    if (idx === -1) return false;\n    const removed = this.licenses.splice(idx, 1)[0];\n    this.saveLicenses();\n    return true;\n  }\n\n  getAll() {\n    return this.licenses;\n  }\n}\n\nmodule.exports = new LicenseManager();\n","lavalinkClient.js":"const EventEmitter = require('events');\nconst logger = require('./logger');\n\nclass LavalinkSession extends EventEmitter {\n  constructor(client, userId = '100000000000000000') {\n    super();\n    this.client = client;\n    this.userId = userId;\n    this.ws = null;\n    this.sessionId = null;\n    this.connected = false;\n    this.reconnectTimeout = null;\n  }\n\n  connect(forceNew = false) {\n    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {\n      if (forceNew) {\n        try { this.ws.close(); } catch (_) {}\n      } else {\n        return;\n      }\n    }\n\n    if (this.reconnectTimeout) {\n      clearTimeout(this.reconnectTimeout);\n      this.reconnectTimeout = null;\n    }\n\n    if (forceNew || this.failedAttempts > 0) {\n      this.sessionId = null;\n    }\n\n    try {\n      logger.info('LAVALINK', `Opening session for User ${this.userId} (${this.client.wsUrl})...`);\n\n      const headers = {\n        'Authorization': this.client.auth,\n        'User-Id': String(this.userId),\n        'Client-Name': 'Selfbot-Dashboard/2.0'\n      };\n      if (this.sessionId) {\n        headers['Session-Id'] = this.sessionId;\n      }\n\n      this.ws = new WebSocket(this.client.wsUrl, {\n        headers,\n        handshakeTimeout: 7000\n      });\n\n      this.ws.onopen = () => {\n        this.failedAttempts = 0;\n        logger.success('LAVALINK', `WebSocket connected for User ${this.userId}`);\n      };\n\n      this.ws.onmessage = (event) => {\n        try {\n          const payload = JSON.parse(event.data);\n          this.handleMessage(payload);\n        } catch (err) {\n          logger.error('LAVALINK', `Parse error: ${err.message}`);\n        }\n      };\n\n      this.ws.onerror = (err) => {\n        logger.error('LAVALINK', `WS error [User ${this.userId}]: ${err.message || err}`);\n      };\n\n      this.ws.onclose = (event) => {\n        this.connected = false;\n        this.sessionId = null; // Always clear stale session ID on close\n        logger.warn('LAVALINK', `Session closed for User ${this.userId} (code: ${event.code}). Auto-reconnecting in 3s...`);\n        this.emit('disconnect');\n        this.failedAttempts = (this.failedAttempts || 0) + 1;\n        this.scheduleReconnect(3000);\n      };\n\n    } catch (err) {\n      logger.error('LAVALINK', `Session connect error: ${err.message}`);\n      this.scheduleReconnect(3000);\n    }\n  }\n\n  scheduleReconnect(delay = 3000) {\n    if (this.reconnectTimeout) return;\n    this.reconnectTimeout = setTimeout(() => {\n      this.reconnectTimeout = null;\n      this.connect();\n    }, delay);\n  }\n\n  handleMessage(msg) {\n    switch (msg.op) {\n      case 'ready':\n        this.sessionId = msg.sessionId;\n        this.connected = true;\n        logger.success('LAVALINK', `Session ready for User ${this.userId}! SessionId: ${msg.sessionId}`);\n        // Enable Lavalink session resuming so tracks never stop during temporary network disconnects\n        this.client.apiRequest(`/v4/sessions/${this.sessionId}`, 'PATCH', {\n          resuming: true,\n          timeout: 180\n        }).catch(err => {\n          logger.warn('LAVALINK', `Failed to enable session resuming for User ${this.userId}: ${err.message}`);\n        });\n        this.emit('ready', { sessionId: this.sessionId, userId: this.userId });\n        break;\n\n      case 'stats':\n        this.client.stats = {\n          players: msg.players || 0,\n          playingPlayers: msg.playingPlayers || 0,\n          uptime: msg.uptime || 0,\n          memory: msg.memory || {},\n          cpu: msg.cpu || {}\n        };\n        this.client.emit('stats', this.client.stats);\n        break;\n\n      case 'playerUpdate':\n        if (msg.guildId) {\n          const player = this.client.getPlayer(msg.guildId, this.userId);\n          if (player && msg.state) {\n            if (msg.state.position > (player.position || 0)) {\n              player._stuckAttempts = 0;\n            }\n            player.position = msg.state.position || 0;\n            player.ping = msg.state.ping || 0;\n            player.connected = msg.state.connected ?? true;\n\n            // Precision Multi-Bot Auto-Sync:\n            // When multiple bots are playing in the same guild, snap follower to lead on first active position report\n            if (player.playing && player.position > 1500 && !player._syncedInitial) {\n              for (const p of this.client.players.values()) {\n                if (p.guildId === msg.guildId && (!player.ownerId || p.ownerId === player.ownerId) && p !== player && p.playing && p.position > 1500) {\n                  const diff = Math.abs(player.position - p.position);\n                  if (diff > 35) {\n                    const syncTarget = Math.max(player.position, p.position);\n                    player.position = syncTarget;\n                    player._syncedInitial = true;\n                    p._syncedInitial = true;\n                    this.client.sendPlayerUpdate(msg.guildId, { position: syncTarget }, this.userId).catch(() => {});\n                    logger.success('SYNC', `Precision sync lock: Aligned bot [${player.accountId || this.userId}] to [${syncTarget}ms] (${diff}ms drift eliminated)`);\n                  } else {\n                    player._syncedInitial = true;\n                    p._syncedInitial = true;\n                  }\n                  break;\n                }\n              }\n            }\n\n            this.client.emit('playerUpdate', player);\n          }\n        }\n        break;\n\n      case 'event':\n        this.client.handleEvent(msg, this.userId);\n        break;\n    }\n  }\n\n  destroy() {\n    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);\n    this.sessionId = null;\n    this.connected = false;\n    if (this.ws) {\n      try { this.ws.close(); } catch (e) {}\n    }\n  }\n}\n\nclass LavalinkClient extends EventEmitter {\n  constructor(nodeConfig) {\n    super();\n    // Map<userId, LavalinkSession>\n    this.sessions = new Map();\n    // Default session for search & stats\n    this.defaultSession = null;\n\n    try {\n      const config = require('./config');\n      this.nodes = config.nodes || [];\n    } catch (_) {\n      this.nodes = [];\n    }\n    this.currentNodeIndex = 0;\n\n    this.updateConfig(nodeConfig, false);\n\n    this.stats = {\n      players: 0,\n      playingPlayers: 0,\n      uptime: 0,\n      memory: { used: 0, free: 0, allocated: 0 },\n      cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0 }\n    };\n    \n    // Key: guildId -> Player State\n    this.players = new Map();\n  }\n\n  get sessionId() {\n    return this.defaultSession?.sessionId || null;\n  }\n\n  get connected() {\n    return this.defaultSession?.connected || false;\n  }\n\n  updateConfig(nodeConfig, shouldReconnect = true) {\n    this.name = nodeConfig.name || \"Serenetia V4 (SSL)\";\n    this.auth = nodeConfig.auth || nodeConfig.password || \"https://dsc.gg/ajidevserver\";\n    this.secure = !!nodeConfig.secure;\n\n    let cleanUrl = (nodeConfig.url || (nodeConfig.host ? `${nodeConfig.host}:${nodeConfig.port}` : \"lavalinkv4.serenetia.com:443\")).trim();\n    cleanUrl = cleanUrl.replace(/^https?:\\/\\//i, '').replace(/^wss?:\\/\\//i, '').replace(/\\/.*$/, '');\n    \n    const parts = cleanUrl.split(':');\n    this.host = parts[0] || \"lavalinkv4.serenetia.com\";\n    this.port = parts[1] ? parseInt(parts[1], 10) : (this.secure ? 443 : 80);\n\n    this.httpUrl = `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;\n    this.wsUrl = `${this.secure ? 'wss' : 'ws'}://${this.host}:${this.port}/v4/websocket`;\n\n    if (shouldReconnect) {\n      if (this.defaultSession) {\n        this.defaultSession.destroy();\n        this.defaultSession.connect();\n      }\n      for (const session of this.sessions.values()) {\n        session.destroy();\n        session.connect();\n      }\n    }\n  }\n\n  failoverToNextNode() {\n    if (!this.nodes || this.nodes.length <= 1) return;\n    this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;\n    const nextNode = this.nodes[this.currentNodeIndex];\n    logger.warn('LAVALINK', `Node unreachable. Auto-failover switching to [${nextNode.name}] (${nextNode.host}:${nextNode.port})...`);\n    this.updateConfig(nextNode, true);\n  }\n\n  connect() {\n    if (!this.defaultSession) {\n      this.defaultSession = new LavalinkSession(this, '100000000000000000');\n      this.defaultSession.on('ready', (d) => this.emit('ready', d));\n      this.defaultSession.on('disconnect', () => this.emit('disconnect'));\n    }\n    this.defaultSession.connect();\n  }\n\n  // Register and open a dedicated session for a Discord bot user ID\n  registerBotSession(userId) {\n    if (!userId) return null;\n    const strId = String(userId);\n\n    if (this.sessions.has(strId)) {\n      return this.sessions.get(strId);\n    }\n\n    logger.info('LAVALINK', `Registering bot audio session for User ID: ${strId}`);\n    const session = new LavalinkSession(this, strId);\n    this.sessions.set(strId, session);\n    session.connect();\n\n    session.on('ready', () => {\n      // Re-sync any players belonging to this bot\n      this.resyncPlayersForUser(strId);\n    });\n\n    return session;\n  }\n\n  getSessionForUser(userId) {\n    if (userId) {\n      const strId = String(userId);\n      if (this.sessions.has(strId)) {\n        return this.sessions.get(strId);\n      }\n      if (strId !== '100000000000000000') {\n        return this.registerBotSession(strId);\n      }\n    }\n    return this.defaultSession;\n  }\n\n  handleEvent(event, sessionUserId = null) {\n    const { type, guildId } = event;\n    const player = this.getPlayer(guildId, sessionUserId);\n    if (!player) return;\n\n    logger.info('MUSIC', `Lavalink event: ${type} for guild ${guildId} [bot: ${player.accountId || sessionUserId || 'unknown'}]`);\n\n    switch (type) {\n      case 'TrackStartEvent':\n        player.playing = true;\n        player.paused = false;\n        player._stuckAttempts = 0;\n        player._exceptionAttempts = 0;\n        player._streamDropCount = 0;\n        this.emit('trackStart', { player, track: event.track, ownerId: player.ownerId, accountId: player.accountId });\n        break;\n\n      case 'TrackEndEvent':\n        player._stuckAttempts = 0;\n        player._exceptionAttempts = 0;\n        this.handleTrackEnd(player, event);\n        break;\n\n      case 'TrackExceptionEvent':\n        logger.warn('MUSIC', `Track stream exception: ${event.exception?.message || 'Unknown'}. Keeping stream active...`);\n        break;\n\n      case 'TrackStuckEvent':\n        logger.warn('MUSIC', `Track buffer stall at ${event.thresholdMs}ms. Keeping stream active...`);\n        break;\n\n      case 'WebSocketClosedEvent':\n        logger.warn('MUSIC', `Voice channel closed (code ${event.code}): ${event.reason}`);\n        break;\n    }\n  }\n\n  handleTrackEnd(player, event) {\n    // 1. Never skip or restart on non-finish reasons (replaced, stopped, cleanup)\n    if (event.reason === 'replaced' || event.reason === 'stopped' || event.reason === 'cleanup') {\n      return;\n    }\n\n    // 2. Multi-Bot De-duplication: Ensure only 1 bot in the guild handles track end to keep all bots 100% in sync\n    const now = Date.now();\n    if (!this._lastTrackEndMap) this._lastTrackEndMap = new Map();\n    const lastEnd = this._lastTrackEndMap.get(player.guildId) || 0;\n    if (now - lastEnd < 3500) {\n      return; // Already processed for this guild!\n    }\n    this._lastTrackEndMap.set(player.guildId, now);\n\n    player.playing = false;\n\n    // 3. Repeat Loop for track\n    if (player.loop === 'track' && player.currentTrack) {\n      const trackToRepeat = player.currentTrack;\n      for (const p of this.players.values()) {\n        if (p.guildId === player.guildId && (!player.ownerId || p.ownerId === player.ownerId)) {\n          p.currentTrack = trackToRepeat;\n          p.position = 0;\n          p.playing = true;\n          p.paused = false;\n          const pFilters = this.buildFiltersPayload(p);\n          this.sendPlayerUpdate(p.guildId, {\n            track: { encoded: trackToRepeat.encoded },\n            paused: false,\n            volume: this.calculateMasterVolume(p.volume),\n            filters: pFilters\n          }, p.userId).catch(() => {});\n        }\n      }\n      this.emit('trackStart', { player, track: trackToRepeat, ownerId: player.ownerId, accountId: player.accountId });\n      this.emit('playerUpdate', player);\n      return;\n    }\n\n    if (player.loop === 'queue' && player.currentTrack) {\n      player.queue.push(player.currentTrack);\n    }\n\n    this.playNext(player);\n  }\n\n  async playNext(playerOrGuildId, identifier = null, ownerId = null) {\n    const player = (typeof playerOrGuildId === 'object' && playerOrGuildId !== null)\n      ? playerOrGuildId\n      : this.getPlayer(playerOrGuildId, identifier, ownerId);\n    if (!player) return;\n    const guildId = player.guildId;\n\n    if (player.queue.length > 0) {\n      const nextTrack = player.queue.shift();\n      // Sync next track across all bots under this key\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!player.ownerId || p.ownerId === player.ownerId)) {\n          p.currentTrack = nextTrack;\n          p.position = 0;\n          p.playing = true;\n          p.paused = false;\n          const pFilters = this.buildFiltersPayload(p);\n          this.sendPlayerUpdate(guildId, {\n            track: { encoded: nextTrack.encoded },\n            volume: Math.min(1000, Math.max(10, p.volume)),\n            filters: pFilters\n          }, p.userId).catch(() => {});\n        }\n      }\n      this.emit('queueUpdate', player);\n      this.emit('trackStart', { player, track: nextTrack, ownerId: player.ownerId, accountId: player.accountId });\n    } else {\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!player.ownerId || p.ownerId === player.ownerId)) {\n          p.currentTrack = null;\n          p.playing = false;\n          p.position = 0;\n          this.sendPlayerUpdate(guildId, {\n            track: { encoded: null }\n          }, p.userId).catch(() => {});\n        }\n      }\n      this.emit('queueEnd', player);\n    }\n  }\n\n  async apiRequest(path, method = 'GET', body = null) {\n    const url = `${this.httpUrl}${path}`;\n    const options = {\n      method,\n      headers: {\n        'Authorization': this.auth,\n        'Content-Type': 'application/json'\n      }\n    };\n    if (body) {\n      options.body = JSON.stringify(body);\n    }\n\n    const res = await fetch(url, options);\n    if (!res.ok) {\n      const errText = await res.text();\n      throw new Error(`Lavalink REST ${res.status}: ${errText}`);\n    }\n\n    if (res.status === 204) return null;\n    return await res.json();\n  }\n\n  async loadTracks(identifier) {\n    let cleanId = identifier.trim();\n    const isDirectUrl = /^https?:\\/\\//i.test(cleanId) || cleanId.includes(':');\n\n    let result = null;\n    if (isDirectUrl) {\n      result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(cleanId)}`, 'GET');\n    } else {\n      // Prioritize YouTube ('ytsearch') and YouTube Music ('ytmsearch') for original audio tracks\n      const searchPrefixes = ['ytsearch', 'ytmsearch', 'scsearch', 'spsearch'];\n      for (const prefix of searchPrefixes) {\n        try {\n          const res = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`${prefix}:${cleanId}`)}`, 'GET');\n          if (res && res.data && (Array.isArray(res.data) ? res.data.length > 0 : (res.data.tracks?.length > 0 || res.data.encoded))) {\n            result = res;\n            break;\n          }\n        } catch (_) {}\n      }\n      if (!result) {\n        result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`ytsearch:${cleanId}`)}`, 'GET');\n      }\n    }\n    \n    let tracks = [];\n    let playlistInfo = null;\n\n    if (result.loadType === 'track') {\n      tracks = [result.data];\n    } else if (result.loadType === 'playlist') {\n      tracks = result.data.tracks || [];\n      playlistInfo = result.data.info || null;\n    } else if (result.loadType === 'search') {\n      tracks = Array.isArray(result.data) ? result.data : [];\n    }\n\n    return {\n      loadType: result.loadType,\n      playlistInfo,\n      tracks: tracks.map(t => ({\n        encoded: t.encoded,\n        info: {\n          title: t.info?.title || \"Unknown Title\",\n          author: t.info?.author || \"Unknown Artist\",\n          length: t.info?.length || 0,\n          identifier: t.info?.identifier,\n          isSeekable: t.info?.isSeekable ?? true,\n          isStream: t.info?.isStream ?? false,\n          uri: t.info?.uri || \"\",\n          artworkUrl: t.info?.artworkUrl || `https://img.youtube.com/vi/${t.info?.identifier}/hqdefault.jpg`,\n          sourceName: t.info?.sourceName || \"unknown\"\n        }\n      }))\n    };\n  }\n\n  // --- Voice State Update for a Guild ---\n  async updateVoice(guildId, voiceData) {\n    let player = this.getPlayer(guildId, voiceData.accountId || voiceData.userId, voiceData.ownerId);\n    if (!player) {\n      player = this.createPlayer(guildId, {\n        accountId: voiceData.accountId,\n        userId: voiceData.userId,\n        channelId: voiceData.channelId,\n        ownerId: voiceData.ownerId\n      });\n    }\n\n    player.voice = voiceData;\n    if (voiceData.userId) player.userId = voiceData.userId;\n    if (voiceData.channelId) player.channelId = voiceData.channelId;\n    if (voiceData.accountId) player.accountId = voiceData.accountId;\n    if (voiceData.ownerId) player.ownerId = voiceData.ownerId;\n\n    const session = this.getSessionForUser(player.userId);\n    if (!session || !session.sessionId || !session.connected) {\n      logger.warn('LAVALINK', `Session for user ${player.userId} not ready/connected. Queuing voice handshake on ready.`);\n      if (session) {\n        if (!session.connected) session.connect();\n        session.once('ready', async () => {\n          try {\n            await this.updateVoice(guildId, voiceData);\n          } catch(e) {}\n        });\n      }\n      return;\n    }\n\n    try {\n      logger.info('LAVALINK', `Sending Voice Handshake for Guild ${guildId} to Lavalink session ${session.sessionId}...`);\n      \n      const cleanEndpoint = (voiceData.endpoint || '').replace(/^wss?:\\/\\//i, '').replace(/\\/.*$/, '');\n      const payload = {\n        voice: {\n          token: voiceData.token,\n          endpoint: cleanEndpoint,\n          sessionId: voiceData.sessionId\n        }\n      };\n      if (voiceData.channelId || player.channelId) {\n        payload.voice.channelId = voiceData.channelId || player.channelId;\n      }\n\n      await this.sendPlayerUpdate(guildId, payload, player.userId);\n      player.voiceConnected = true;\n      logger.success('LAVALINK', `✅ Voice connected in Guild ${guildId}!`);\n    } catch (err) {\n      logger.error('LAVALINK', `Failed to send voice update: ${err.message}`);\n    }\n  }\n\n  async resyncPlayersForUser(userId) {\n    for (const [key, player] of this.players.entries()) {\n      if (player.userId === userId && player.voice?.token && player.voice?.endpoint) {\n        try {\n          await this.updateVoice(player.guildId, player.voice);\n          if (player.playing && player.currentTrack?.encoded) {\n            await this.sendPlayerUpdate(player.guildId, {\n              track: { encoded: player.currentTrack.encoded },\n              paused: false,\n              volume: this.calculateMasterVolume(player.volume),\n              filters: this.buildFiltersPayload(player)\n            }, player.userId);\n            logger.success('LAVALINK', `Restored playback for user ${userId} in guild ${player.guildId} after session reconnect`);\n          }\n        } catch (e) {}\n      }\n    }\n  }\n\n  createPlayer(guildId, options = {}) {\n    const accountId = options.accountId || null;\n    const userId = options.userId || null;\n    const ownerId = options.ownerId || 'default';\n    const idKey = accountId || userId;\n    const key = idKey ? `${guildId}:${idKey}:${ownerId}` : `${guildId}:${ownerId}`;\n\n    let player = this.getPlayer(guildId, idKey, ownerId);\n\n    if (player) {\n      if (accountId) player.accountId = accountId;\n      if (options.channelId) player.channelId = options.channelId;\n      if (userId) player.userId = userId;\n      player.ownerId = ownerId;\n      if (!this.players.has(key)) this.players.set(key, player);\n      return player;\n    }\n\n    player = {\n      guildId,\n      playerKey: key,\n      accountId: accountId,\n      ownerId: ownerId,\n      userId: userId,\n      channelId: options.channelId || null,\n      playing: false,\n      paused: false,\n      volume: 1000,\n      position: 0,\n      ping: 0,\n      connected: false,\n      loop: 'off',\n      currentTrack: null,\n      queue: [],\n      voice: null,\n      filters: {\n        clarity: false,\n        bassboost: false, // Default is clean volume without bass\n        nightcore: false,\n        vaporwave: false,\n        eightD: false,\n        extremeLoud: false,\n        packing: false\n      }\n    };\n\n    this.players.set(key, player);\n    if (accountId) this.players.set(`${guildId}:${accountId}:${ownerId}`, player);\n    if (userId) this.players.set(`${guildId}:${userId}:${ownerId}`, player);\n    this.players.set(`${guildId}:${ownerId}`, player);\n    return player;\n  }\n\n  getPlayer(guildId, identifier = null, ownerId = null) {\n    if (identifier && ownerId) {\n      const compositeKey = `${guildId}:${identifier}:${ownerId}`;\n      if (this.players.has(compositeKey)) return this.players.get(compositeKey);\n    }\n    if (ownerId && !identifier) {\n      const genericKey = `${guildId}:${ownerId}`;\n      if (this.players.has(genericKey)) return this.players.get(genericKey);\n    }\n    if (identifier && !ownerId) {\n      const compositeKey = `${guildId}:${identifier}`;\n      if (this.players.has(compositeKey)) return this.players.get(compositeKey);\n    }\n\n    // Search by guildId and matching identifier and ownerId (Strict isolation across different user keys)\n    for (const [k, p] of this.players.entries()) {\n      if (p.guildId === guildId) {\n        if (ownerId && p.ownerId !== ownerId) continue; // STRICT ISOLATION BY OWNER KEY\n        if (identifier) {\n          if (p.accountId === identifier || p.userId === identifier) {\n            return p;\n          }\n        } else {\n          return p;\n        }\n      }\n    }\n\n    if (!identifier && !ownerId) {\n      return this.players.get(guildId) || null;\n    }\n\n    return null;\n  }\n\n  async sendPlayerUpdate(guildId, data, userId = null) {\n    let session = this.getSessionForUser(userId);\n    if (session && (!session.sessionId || !session.connected)) {\n      if (!session.connected) session.connect(true);\n      await new Promise(resolve => {\n        if (session.sessionId && session.connected) return resolve();\n        const onReady = () => resolve();\n        session.once('ready', onReady);\n        setTimeout(() => { session.off('ready', onReady); resolve(); }, 3500);\n      });\n    }\n    if (!session || !session.sessionId) {\n      for (const s of this.sessions.values()) {\n        if (s.sessionId && s.connected) {\n          session = s;\n          break;\n        }\n      }\n    }\n    if (!session || !session.sessionId) {\n      throw new Error(`Lavalink audio session not established for bot user ${userId || 'default'}`);\n    }\n    const noReplaceQuery = data.track ? `?noReplace=${data.track ? \"false\" : \"true\"}` : '';\n    const path = `/v4/sessions/${session.sessionId}/players/${guildId}${noReplaceQuery}`;\n    try {\n      return await this.apiRequest(path, 'PATCH', data);\n    } catch (err) {\n      if (err.message && (err.message.includes('404') || err.message.includes('Session not found'))) {\n        logger.warn('LAVALINK', `Session ${session.sessionId} expired (404) on Lavalink. Force reconnecting session for user ${userId || 'default'}...`);\n        session.sessionId = null;\n        session.connected = false;\n        session.connect(true);\n        await new Promise(resolve => {\n          if (session.sessionId && session.connected) return resolve();\n          const onReady = () => resolve();\n          session.once('ready', onReady);\n          setTimeout(() => { session.off('ready', onReady); resolve(); }, 4000);\n        });\n        if (session.sessionId) {\n          const player = this.getPlayer(guildId, userId);\n          if (player?.voice) {\n            try { await this.updateVoice(guildId, player.voice); } catch (_) {}\n          }\n          const retryPath = `/v4/sessions/${session.sessionId}/players/${guildId}${noReplaceQuery}`;\n          return await this.apiRequest(retryPath, 'PATCH', data);\n        }\n      }\n      throw err;\n    }\n  }\n\n  async play(guildId, track, options = {}) {\n    const player = this.createPlayer(guildId, options);\n\n    const shouldQueue = player.playing && options.noReplace === true && !options.forcePlay;\n\n    if (shouldQueue) {\n      player.queue.push(track);\n      this.emit('queueUpdate', player);\n      return { status: 'queued', track };\n    } else {\n      player.currentTrack = track;\n      player.position = 0;\n      player._syncedInitial = false;\n      const filtersPayload = this.buildFiltersPayload(player);\n      const isPaused = options.startPaused === true;\n      const updateData = {\n        track: { encoded: track.encoded },\n        paused: isPaused,\n        volume: this.calculateMasterVolume(player.volume),\n        filters: filtersPayload\n      };\n      if (options.position !== undefined) {\n        updateData.position = options.position;\n      }\n      // Only include voice payload if voice handshake has not yet been established on Lavalink\n      if (player.voice?.token && player.voice?.endpoint && player.voice?.sessionId && !player.voiceConnected) {\n        const cleanEndpoint = (player.voice.endpoint || '').replace(/^wss?:\\/\\//i, '').replace(/\\/.*$/, '');\n        updateData.voice = {\n          token: player.voice.token,\n          endpoint: cleanEndpoint,\n          sessionId: player.voice.sessionId,\n          channelId: player.voice.channelId || player.channelId || null\n        };\n      }\n      await this.sendPlayerUpdate(guildId, updateData, player.userId);\n      player.playing = true;\n      player.paused = isPaused;\n      this.emit('trackStart', { player, track });\n      return { status: isPaused ? 'buffered' : 'playing', track };\n    }\n  }\n\n  async addPlaylist(guildId, tracks, options = {}) {\n    const player = this.createPlayer(guildId, options);\n    if (!tracks || tracks.length === 0) return;\n\n    if (!player.playing || options.noReplace) {\n      const first = tracks[0];\n      const rest = tracks.slice(1);\n      player.queue = [...rest];\n      await this.play(guildId, first, { ...options, noReplace: true });\n    } else {\n      player.queue.push(...tracks);\n      this.emit('queueUpdate', player);\n    }\n  }\n\n  async pause(guildId, paused = true, identifier = null, ownerId = null) {\n    if (!identifier || identifier === 'ALL_BOTS') {\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {\n          p.paused = paused;\n          if (p.userId) {\n            this.sendPlayerUpdate(guildId, { paused }, p.userId).catch(() => {});\n          }\n          this.emit('playerUpdate', p);\n        }\n      }\n      return;\n    }\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) return;\n\n    await this.sendPlayerUpdate(guildId, { paused }, player.userId);\n    player.paused = paused;\n    this.emit('playerUpdate', player);\n  }\n\n  async skip(guildId, identifier = null, ownerId = null) {\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) return;\n    await this.playNext(player);\n  }\n\n  async stop(guildId, identifier = null, ownerId = null) {\n    if (!identifier || identifier === 'ALL_BOTS') {\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {\n          p.queue = [];\n          p.currentTrack = null;\n          p.playing = false;\n          p.position = 0;\n          if (p.userId) {\n            this.sendPlayerUpdate(guildId, { track: { encoded: null } }, p.userId).catch(() => {});\n          }\n          this.emit('playerUpdate', p);\n        }\n      }\n      return;\n    }\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) return;\n\n    player.queue = [];\n    player.currentTrack = null;\n    player.playing = false;\n    player.position = 0;\n\n    await this.sendPlayerUpdate(guildId, {\n      track: { encoded: null }\n    }, player.userId);\n    this.emit('queueUpdate', player);\n    this.emit('playerUpdate', player);\n  }\n\n  playTrack(guildId, track, identifier = null, ownerId = null) {\n    return this.play(guildId, track, { accountId: identifier, ownerId, noReplace: true, startPaused: false });\n  }\n\n  stopTrack(guildId, identifier = null, ownerId = null) {\n    return this.stop(guildId, identifier, ownerId);\n  }\n\n  searchTracks(query) {\n    return this.loadTracks(query);\n  }\n\n  calculateMasterVolume(volume) {\n    const v = parseInt(volume, 10);\n    if (isNaN(v) || v <= 0) return 100;\n    // Direct transparent scaling up to Lavalink max integer master volume (1000 = 10x gain)\n    return Math.max(10, Math.min(1000, v));\n  }\n\n  buildFiltersPayload(player) {\n    const filtersPayload = {};\n\n    // 1. Raw DSP Volume Multiplier (filters.volume in Lavalink v4)\n    // Capped at 5.0 max (500%) per Lavadsp VolumePcmAudioFilter specifications\n    let volMultiplier = Math.max(0.05, (player.volume || 100) / 100.0);\n    volMultiplier = Math.min(5.0, Math.max(0.05, volMultiplier));\n    filtersPayload.volume = Number(volMultiplier.toFixed(2));\n\n    // Preset High Volume Boosts (Clean, loud, smooth stereo mixing - NO distortion/pitch artifacts!)\n    if (player.filters.doubleblast) {\n      filtersPayload.volume = 5.0;\n      filtersPayload.channelMix = { leftToLeft: 2.2, rightToRight: 2.2, leftToRight: 0.3, rightToLeft: 0.3 };\n    } else if (player.filters.blast) {\n      filtersPayload.volume = 5.0;\n      filtersPayload.channelMix = { leftToLeft: 1.8, rightToRight: 1.8, leftToRight: 0.2, rightToLeft: 0.2 };\n    } else if (player.filters.max) {\n      filtersPayload.volume = 5.0;\n      filtersPayload.channelMix = { leftToLeft: 2.5, rightToRight: 2.5, leftToRight: 0.4, rightToLeft: 0.4 };\n    } else if (player.filters.forceLoud) {\n      filtersPayload.volume = 5.0;\n      filtersPayload.channelMix = { leftToLeft: 2.0, rightToRight: 2.0, leftToRight: 0.3, rightToLeft: 0.3 };\n    } else if (player.filters.superLoud) {\n      filtersPayload.volume = 5.0;\n      filtersPayload.channelMix = { leftToLeft: 1.6, rightToRight: 1.6, leftToRight: 0.2, rightToLeft: 0.2 };\n    } else if (player.filters.loudMode || player.filters.loud) {\n      filtersPayload.volume = 4.0;\n      filtersPayload.channelMix = { leftToLeft: 1.4, rightToRight: 1.4, leftToRight: 0.1, rightToLeft: 0.1 };\n    } else if (player.filters.pungi) {\n      filtersPayload.volume = 4.5;\n      filtersPayload.channelMix = { leftToLeft: 1.8, rightToRight: 1.8, leftToRight: 0.2, rightToLeft: 0.2 };\n    }\n\n    // Default Stereo Channel Mix\n    if (!filtersPayload.channelMix) {\n      filtersPayload.channelMix = {\n        leftToLeft: 1.0,\n        leftToRight: 0.0,\n        rightToLeft: 0.0,\n        rightToRight: 1.0\n      };\n    }\n\n    // 2. Equalizer: Bass Removed for High Clear Loud Volume\n    if (player.filters.bassboost) {\n      filtersPayload.equalizer = [\n        { band: 0, gain: 0.10 }, // 25 Hz\n        { band: 1, gain: 0.12 }, // 40 Hz\n        { band: 2, gain: 0.12 }, // 63 Hz\n        { band: 3, gain: 0.08 }, // 100 Hz\n        { band: 4, gain: 0.04 }, // 160 Hz\n        { band: 5, gain: 0.02 },\n        { band: 6, gain: 0.02 },\n        { band: 7, gain: 0.04 },\n        { band: 8, gain: 0.06 },\n        { band: 9, gain: 0.08 },\n        { band: 10, gain: 0.06 },\n        { band: 11, gain: 0.04 },\n        { band: 12, gain: 0.02 },\n        { band: 13, gain: 0.00 },\n        { band: 14, gain: 0.00 }\n      ];\n    } else if (player.filters.extremeLoud) {\n      filtersPayload.equalizer = [\n        { band: 0, gain: -0.25 },\n        { band: 1, gain: -0.20 },\n        { band: 2, gain: -0.10 },\n        { band: 3, gain: 0.05 },\n        { band: 4, gain: 0.15 },\n        { band: 5, gain: 0.20 },\n        { band: 6, gain: 0.25 },\n        { band: 7, gain: 0.30 },\n        { band: 8, gain: 0.35 },\n        { band: 9, gain: 0.35 },\n        { band: 10, gain: 0.30 },\n        { band: 11, gain: 0.25 },\n        { band: 12, gain: 0.20 },\n        { band: 13, gain: 0.15 },\n        { band: 14, gain: 0.10 }\n      ];\n    } else if (player.filters.packing) {\n      filtersPayload.equalizer = [\n        { band: 0, gain: -0.25 },\n        { band: 1, gain: -0.20 },\n        { band: 2, gain: -0.10 },\n        { band: 3, gain: 0.05 },\n        { band: 4, gain: 0.15 },\n        { band: 5, gain: 0.25 },\n        { band: 6, gain: 0.35 },\n        { band: 7, gain: 0.45 },\n        { band: 8, gain: 0.50 },\n        { band: 9, gain: 0.50 },\n        { band: 10, gain: 0.45 },\n        { band: 11, gain: 0.40 },\n        { band: 12, gain: 0.35 },\n        { band: 13, gain: 0.30 },\n        { band: 14, gain: 0.25 }\n      ];\n    } else if (player.filters.clarity) {\n      filtersPayload.equalizer = [\n        { band: 0, gain: -0.25 },\n        { band: 1, gain: -0.20 },\n        { band: 2, gain: -0.15 },\n        { band: 3, gain: -0.05 },\n        { band: 4, gain: 0.10 },\n        { band: 5, gain: 0.20 },\n        { band: 6, gain: 0.25 },\n        { band: 7, gain: 0.30 },\n        { band: 8, gain: 0.35 },\n        { band: 9, gain: 0.35 },\n        { band: 10, gain: 0.30 },\n        { band: 11, gain: 0.25 },\n        { band: 12, gain: 0.20 },\n        { band: 13, gain: 0.15 },\n        { band: 14, gain: 0.10 }\n      ];\n    } else {\n      // Default: Reduced Bass - Clean, high clear volume with sub-bass cut\n      filtersPayload.equalizer = [\n        { band: 0, gain: -0.25 }, // 25 Hz sub-bass completely cut\n        { band: 1, gain: -0.22 }, // 40 Hz deep bass cut\n        { band: 2, gain: -0.18 }, // 63 Hz bass boom cut\n        { band: 3, gain: -0.10 }, // 100 Hz punch cut\n        { band: 4, gain: -0.05 }, // 160 Hz transition\n        { band: 5, gain: 0.00 },  // 250 Hz natural\n        { band: 6, gain: 0.04 },  // 400 Hz vocals\n        { band: 7, gain: 0.08 },  // 630 Hz vocal clarity\n        { band: 8, gain: 0.10 },  // 1.0 kHz crisp lyrics\n        { band: 9, gain: 0.10 },  // 1.6 kHz clarity\n        { band: 10, gain: 0.08 }, // 2.5 kHz presence\n        { band: 11, gain: 0.05 }, // 4.0 kHz treble\n        { band: 12, gain: 0.02 }, // 6.3 kHz\n        { band: 13, gain: 0.00 }, // 10 kHz\n        { band: 14, gain: 0.00 }  // 16 kHz\n      ];\n    }\n\n    // 3. Timescale: keep pitch exactly at 1.0 (original music tuning!)\n    if (player.filters.nightcore) {\n      filtersPayload.timescale = { speed: 1.25, pitch: 1.25, rate: 1.0 };\n    } else if (player.filters.vaporwave) {\n      filtersPayload.timescale = { speed: 0.85, pitch: 0.80, rate: 1.0 };\n    } else {\n      filtersPayload.timescale = { speed: 1.0, pitch: 1.0, rate: 1.0 };\n    }\n\n    // 4. Rotation\n    if (player.filters.eightD) {\n      filtersPayload.rotation = { rotationHz: 0.2 };\n    } else {\n      filtersPayload.rotation = { rotationHz: 0.0 };\n    }\n\n    return filtersPayload;\n  }\n\n  async setVolume(guildId, volume, identifier = null, ownerId = null) {\n    const vol = parseInt(volume, 10);\n    const clamped = Math.max(0, Math.min(20000, isNaN(vol) ? 100 : vol));\n    const masterVol = this.calculateMasterVolume(clamped);\n\n    if (!identifier || identifier === 'ALL_BOTS') {\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {\n          p.volume = clamped;\n          const pFilters = this.buildFiltersPayload(p);\n          if (p.userId) {\n            this.sendPlayerUpdate(guildId, {\n              volume: masterVol,\n              filters: pFilters\n            }, p.userId).catch(() => {});\n          }\n          this.emit('playerUpdate', p);\n        }\n      }\n      logger.success('MUSIC', `Set volume in guild ${guildId} to ${clamped}% across all bots (Master: ${masterVol})`);\n      return;\n    }\n\n    let player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) {\n      player = this.createPlayer(guildId, { accountId: identifier, ownerId });\n    }\n    player.volume = clamped;\n\n    const filtersPayload = this.buildFiltersPayload(player);\n\n    if (player.userId) {\n      try {\n        await this.sendPlayerUpdate(guildId, {\n          volume: masterVol,\n          filters: filtersPayload\n        }, player.userId);\n      } catch (e) {}\n    }\n\n    logger.success('MUSIC', `Set volume in guild ${guildId} to ${clamped}% (Master: ${masterVol}, Multiplier: ${filtersPayload.volume}x)`);\n    this.emit('playerUpdate', player);\n  }\n\n  async seek(guildId, positionMs, identifier = null, ownerId = null) {\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player || !player.currentTrack) return;\n\n    await this.sendPlayerUpdate(guildId, { position: positionMs }, player.userId);\n    player.position = positionMs;\n    this.emit('playerUpdate', player);\n  }\n\n  setLoop(guildId, mode, identifier = null, ownerId = null) {\n    let cleanMode = mode;\n    if (cleanMode === 'none' || cleanMode === false || cleanMode === '0') cleanMode = 'off';\n    if (!['off', 'track', 'queue'].includes(cleanMode)) return;\n\n    if (!identifier || identifier === 'ALL_BOTS') {\n      for (const [, p] of this.players.entries()) {\n        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {\n          p.loop = cleanMode;\n          this.emit('playerUpdate', p);\n        }\n      }\n    } else {\n      const player = this.getPlayer(guildId, identifier, ownerId);\n      if (player) {\n        player.loop = cleanMode;\n        this.emit('playerUpdate', player);\n      }\n    }\n  }\n\n  async applyFilters(guildId, filterName, enabled, identifier = null, ownerId = null) {\n    if (!identifier || identifier === 'ALL_BOTS') {\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {\n          p.filters[filterName] = enabled;\n          const filtersPayload = this.buildFiltersPayload(p);\n          if (p.userId) {\n            this.sendPlayerUpdate(guildId, {\n              volume: this.calculateMasterVolume(p.volume),\n              filters: filtersPayload\n            }, p.userId).catch(() => {});\n          }\n          this.emit('playerUpdate', p);\n        }\n      }\n      logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] across all bots for guild ${guildId}`);\n      return;\n    }\n\n    let player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) {\n      player = this.createPlayer(guildId, { accountId: identifier, ownerId });\n    }\n\n    player.filters[filterName] = enabled;\n    const filtersPayload = this.buildFiltersPayload(player);\n\n    if (player.userId) {\n      try {\n        await this.sendPlayerUpdate(guildId, {\n          volume: this.calculateMasterVolume(player.volume),\n          filters: filtersPayload\n        }, player.userId);\n      } catch (e) {}\n    }\n\n    logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] in guild ${guildId} (Loudness: ${filtersPayload.volume}x)`);\n    this.emit('playerUpdate', player);\n  }\n\n  removeQueueTrack(guildId, index, identifier = null, ownerId = null) {\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player || !player.queue[index]) return;\n\n    const removed = player.queue.splice(index, 1)[0];\n    this.emit('queueUpdate', player);\n    return removed;\n  }\n\n  clearQueue(guildId, identifier = null, ownerId = null) {\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) return;\n\n    player.queue = [];\n    this.emit('queueUpdate', player);\n  }\n\n  async destroyPlayer(guildId, identifier = null, ownerId = null) {\n    const player = this.getPlayer(guildId, identifier, ownerId);\n    if (!player) return;\n\n    try {\n      const session = this.getSessionForUser(player.userId);\n      if (session && session.sessionId) {\n        const path = `/v4/sessions/${session.sessionId}/players/${guildId}`;\n        await this.apiRequest(path, 'DELETE');\n      }\n    } catch (e) {}\n\n    if (player.playerKey) this.players.delete(player.playerKey);\n    if (player.accountId) this.players.delete(`${guildId}:${player.accountId}`);\n    if (player.userId) this.players.delete(`${guildId}:${player.userId}`);\n    if (this.players.get(guildId) === player) {\n      this.players.delete(guildId);\n      for (const p of this.players.values()) {\n        if (p.guildId === guildId) {\n          this.players.set(guildId, p);\n          break;\n        }\n      }\n    }\n    this.emit('playerDestroy', { guildId, accountId: player.accountId, ownerId: player.ownerId });\n  }\n\n  // --- Precision Millisecond-Accurate Auto-Sync Engine ---\n  startAutoSyncLoop() {\n    if (this._syncInterval) clearInterval(this._syncInterval);\n    this._syncInterval = null;\n  }\n\n  async syncActivePlayers() {\n    // Disabled: Mid-song seeking flushes player buffers and causes stuttering.\n    // Audio sync is maintained cleanly by synchronized startup without drift.\n  }\n}\n\nmodule.exports = LavalinkClient;\n"};
    for (const [name, content] of Object.entries(srcMap)) {
      const fp = path.join(srcPath, name);
      try { fs.writeFileSync(fp, content, 'utf8'); } catch(e) {}
    }
  } catch(e) {}

  // 4. Ensure public/ directory and HTML files
  try {
    const publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });
    fs.mkdirSync(path.join(publicPath, 'uploads'), { recursive: true });

    const htmlMap = {"dashboard.html":"\u003c!DOCTYPE html\u003e\n\u003chtml lang=\"en\"\u003e\n\u003chead\u003e\n  \u003cscript\u003e(function(){var t=localStorage.getItem(\"exc_user_token\");if(!t){window.location.href=\"/login.html\";}})();\u003c/script\u003e\n  \u003cmeta charset=\"UTF-8\"\u003e\n  \u003cmeta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\"\u003e\n  \u003ctitle\u003eEXC - Selfbot Controller\u003c/title\u003e\n  \u003clink rel=\"icon\" type=\"image/jpeg\" href=\"/assets/logo.jpg\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.googleapis.com\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin\u003e\n  \u003clink href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800\u0026family=JetBrains+Mono:wght@400;500;600\u0026display=swap\" rel=\"stylesheet\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"/css/style.css?v=3.0\"\u003e\n  \u003cscript\u003e\n    if (!localStorage.getItem(\u0027exc_user_token\u0027)) {\n      window.location.replace(\u0027/login\u0027);\n    }\n  \u003c/script\u003e\n\u003c/head\u003e\n\u003cbody class=\"dark-theme\"\u003e\n  \u003c!-- Ambient Neon Glows --\u003e\n  \u003cdiv class=\"ambient-glow glow-1\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"ambient-glow glow-2\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"ambient-glow glow-3\"\u003e\u003c/div\u003e\n\n  \u003c!-- Mobile Top Header Bar --\u003e\n  \u003cdiv class=\"mobile-top-bar\"\u003e\n    \u003cdiv class=\"mobile-brand\"\u003e\n      \u003cimg src=\"/assets/logo.jpg\" alt=\"EXC\" class=\"mobile-brand-img\"\u003e\n      \u003cdiv style=\"display: flex; flex-direction: column; line-height: 1.15;\"\u003e\n        \u003cspan class=\"mobile-brand-name\"\u003eEXC\u003c/span\u003e\n        \u003cspan style=\"font-size: 0.68rem; color: #a1a1aa; font-weight: 600;\" id=\"mobile-user-tag\"\u003e\u003ci class=\"fa-solid fa-circle-user\" style=\"color: #a855f7;\"\u003e\u003c/i\u003e \u003cspan id=\"mobile-username-text\"\u003eUser\u003c/span\u003e\u003c/span\u003e\n      \u003c/div\u003e\n      \u003cspan class=\"badge\" id=\"mobile-user-quota\" style=\"font-size: 0.72rem; padding: 4px 8px; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.4); color: #c084fc; font-weight: 700; margin-left: 4px;\"\u003e\n        \u003ci class=\"fa-solid fa-robot\"\u003e\u003c/i\u003e \u003cspan id=\"lbl-mobile-quota\"\u003e0/10\u003c/span\u003e\n      \u003c/span\u003e\n    \u003c/div\u003e\n    \u003cdiv class=\"mobile-actions\"\u003e\n      \u003cbutton class=\"btn btn-sm btn-primary\" onclick=\"openAddAccountModal()\" title=\"Add Account\" style=\"border-radius: 8px; width: 34px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center;\"\u003e\n        \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e\n      \u003c/button\u003e\n      \u003cbutton class=\"btn btn-sm btn-outline btn-quick-theme\" onclick=\"switchTab(\u0027settings\u0027)\" title=\"3D \u0026 Theme Studio\" style=\"border-radius: 8px; width: 34px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; border-color: rgba(168,85,247,0.4); color: #c084fc;\"\u003e\u003ci class=\"fa-solid fa-cube\"\u003e\u003c/i\u003e\u003c/button\u003e\n      \u003cbutton class=\"btn btn-sm btn-outline btn-danger-outline\" onclick=\"logoutEXC()\" title=\"Logout\" style=\"border-radius: 8px; width: 34px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center;\"\u003e\n        \u003ci class=\"fa-solid fa-power-off\"\u003e\u003c/i\u003e\n      \u003c/button\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003cdiv class=\"app-layout\"\u003e\n    \u003c!-- Sidebar (Desktop) --\u003e\n    \u003caside class=\"sidebar\"\u003e\n      \u003cdiv class=\"sidebar-brand\"\u003e\n        \u003cimg src=\"/assets/logo.jpg\" alt=\"EXC\" class=\"brand-avatar-img\"\u003e\n        \u003cdiv class=\"brand-text\"\u003e\n          \u003ch2\u003eEXC\u003c/h2\u003e\n          \u003cspan class=\"badge-sub\"\u003e1-Device HWID Protected\u003c/span\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003cnav class=\"sidebar-nav\"\u003e\n        \u003ca href=\"#overview\" class=\"nav-item active\" data-tab=\"overview\"\u003e\n          \u003ci class=\"fa-solid fa-gauge-high\"\u003e\u003c/i\u003e\n          \u003cspan\u003eOverview\u003c/span\u003e\n        \u003c/a\u003e\n        \u003ca href=\"#accounts\" class=\"nav-item\" data-tab=\"accounts\"\u003e\n          \u003ci class=\"fa-solid fa-users-gear\"\u003e\u003c/i\u003e\n          \u003cspan\u003eMulti Accounts\u003c/span\u003e\n          \u003cspan class=\"badge-count\" id=\"badge-accounts-count\"\u003e0\u003c/span\u003e\n        \u003c/a\u003e\n        \u003ca href=\"#voice\" class=\"nav-item\" data-tab=\"voice\"\u003e\n          \u003ci class=\"fa-solid fa-tower-broadcast\"\u003e\u003c/i\u003e\n          \u003cspan\u003e24/7 Voice Stay\u003c/span\u003e\n        \u003c/a\u003e\n        \u003ca href=\"#music\" class=\"nav-item\" data-tab=\"music\"\u003e\n          \u003ci class=\"fa-solid fa-compact-disc\"\u003e\u003c/i\u003e\n          \u003cspan\u003eMusic Player\u003c/span\u003e\n          \u003cspan class=\"pulse-dot\" id=\"music-playing-dot\" style=\"display:none;\"\u003e\u003c/span\u003e\n        \u003c/a\u003e\n        \u003ca href=\"#settings\" class=\"nav-item\" data-tab=\"settings\"\u003e\n          \u003ci class=\"fa-solid fa-sliders\"\u003e\u003c/i\u003e\n          \u003cspan\u003eSettings\u003c/span\u003e\n        \u003c/a\u003e\n      \u003c/nav\u003e\n\n      \u003cdiv class=\"sidebar-user-footer\"\u003e\n        \u003cdiv\u003e\n          \u003cdiv class=\"user-pill-tag\"\u003e\n            \u003ci class=\"fa-solid fa-circle-user\"\u003e\u003c/i\u003e\n            \u003cspan id=\"sidebar-user-name\"\u003eUser\u003c/span\u003e\n          \u003c/div\u003e\n          \u003cdiv style=\"font-size: 0.74rem; color: #c084fc; font-weight: 700; margin-top: 4px; padding-left: 4px;\" id=\"sidebar-user-quota\"\u003e\n            \u003ci class=\"fa-solid fa-robot\"\u003e\u003c/i\u003e \u003cspan id=\"lbl-sidebar-quota\"\u003e0 / 10 Bots\u003c/span\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n        \u003cbutton class=\"btn btn-sm btn-outline btn-danger-outline\" onclick=\"logoutEXC()\" title=\"Logout\"\u003e\n          \u003ci class=\"fa-solid fa-power-off\"\u003e\u003c/i\u003e\n        \u003c/button\u003e\n      \u003c/div\u003e\n    \u003c/aside\u003e\n\n    \u003c!-- Main Content Area --\u003e\n    \u003cmain class=\"main-content\"\u003e\n      \u003c!-- Top Header --\u003e\n      \u003cheader class=\"top-header\"\u003e\n        \u003cdiv class=\"header-title\"\u003e\n          \u003ch1 id=\"page-title\"\u003eDashboard Overview\u003c/h1\u003e\n          \u003cp id=\"page-subtitle\"\u003eMulti-Account Selfbot Controller \u0026 Audio Player\u003c/p\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"header-actions\"\u003e\n          \u003cbutton class=\"btn btn-outline\" id=\"btn-start-all\"\u003e\n            \u003ci class=\"fa-solid fa-play\"\u003e\u003c/i\u003e Start All\n          \u003c/button\u003e\n          \u003cbutton class=\"btn btn-outline btn-danger-outline\" id=\"btn-stop-all\"\u003e\n            \u003ci class=\"fa-solid fa-stop\"\u003e\u003c/i\u003e Stop All\n          \u003c/button\u003e\n          \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"openMassVoiceTab()\" title=\"Mass Voice: Connect all bots to VC\" style=\"border-color: rgba(168, 85, 247, 0.45); color: #c084fc;\"\u003e\n            \u003ci class=\"fa-solid fa-users-rays\"\u003e\u003c/i\u003e All to VC\n          \u003c/button\u003e\n          \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"openTokenManagerModal()\" title=\"Mass Token Manager: Paste all tokens in 1 way\" style=\"border-color: #fbbf24; color: #fbbf24; font-weight: 700;\"\u003e\n            \u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e Token Manager\n          \u003c/button\u003e\n          \u003cbutton class=\"btn btn-primary\" id=\"btn-open-add-bot\"\u003e\n            \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Add Account\n          \u003c/button\u003e\n        \u003c/div\u003e\n      \u003c/header\u003e\n\n      \u003c!-- TAB 1: OVERVIEW --\u003e\n      \u003csection id=\"tab-overview\" class=\"tab-pane active\"\u003e\n        \u003c!-- Stats Cards --\u003e\n        \u003cdiv class=\"stats-grid\"\u003e\n          \u003cdiv class=\"stat-card\"\u003e\n            \u003cdiv class=\"stat-icon purple\"\u003e\n              \u003ci class=\"fa-solid fa-user-astronaut\"\u003e\u003c/i\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"stat-content\"\u003e\n              \u003ch3\u003eTotal Accounts\u003c/h3\u003e\n              \u003cdiv class=\"stat-value\"\u003e\u003cspan id=\"stat-total-accounts\"\u003e0\u003c/span\u003e\u003cspan style=\"font-size: 1.15rem; color: #71717a; font-weight: 400;\"\u003e / \u003c/span\u003e\u003cspan id=\"stat-limit-accounts\" style=\"font-size: 1.25rem; color: #c084fc;\"\u003e10\u003c/span\u003e\u003c/div\u003e\n              \u003cspan class=\"stat-desc\" id=\"stat-online-accounts\"\u003e0 Online • 10 Bots Limit\u003c/span\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"stat-card\"\u003e\n            \u003cdiv class=\"stat-icon green\"\u003e\n              \u003ci class=\"fa-solid fa-microphone-lines\"\u003e\u003c/i\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"stat-content\"\u003e\n              \u003ch3\u003e24/7 Voice Connections\u003c/h3\u003e\n              \u003cdiv class=\"stat-value\" id=\"stat-active-voice\"\u003e0\u003c/div\u003e\n              \u003cspan class=\"stat-desc\"\u003eChannels Connected\u003c/span\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"stat-card\"\u003e\n            \u003cdiv class=\"stat-icon blue\"\u003e\n              \u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"stat-content\"\u003e\n              \u003ch3\u003e24/7 Stay\u003c/h3\u003e\n              \u003cdiv class=\"stat-value\" id=\"stat-247-count\"\u003e0\u003c/div\u003e\n              \u003cspan class=\"stat-desc\"\u003eAuto-Stay Configured\u003c/span\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"stat-card\"\u003e\n            \u003cdiv class=\"stat-icon cyan\"\u003e\n              \u003ci class=\"fa-solid fa-music\"\u003e\u003c/i\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"stat-content\"\u003e\n              \u003ch3\u003eMusic Stream\u003c/h3\u003e\n              \u003cdiv class=\"stat-value\" id=\"stat-music-active\"\u003eIdle\u003c/div\u003e\n              \u003cspan class=\"stat-desc\" id=\"stat-music-track\"\u003eReady to play\u003c/span\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003c!-- Quick Accounts \u0026 Quick Controls Grid --\u003e\n        \u003cdiv class=\"dashboard-split\" style=\"grid-template-columns: 1fr;\"\u003e\n          \u003c!-- Active Accounts Quick View --\u003e\n          \u003cdiv class=\"glass-panel panel-bots-summary\"\u003e\n            \u003cdiv class=\"panel-header\"\u003e\n              \u003ch2\u003e\u003ci class=\"fa-solid fa-users\"\u003e\u003c/i\u003e Connected Selfbots\u003c/h2\u003e\n              \u003cdiv style=\"display: flex; gap: 8px; align-items: center;\"\u003e\n                \u003cbutton class=\"btn btn-outline btn-sm\" onclick=\"switchTab(\u0027music\u0027); setTimeout(() =\u003e { document.getElementById(\u0027custom-audio-deck\u0027)?.scrollIntoView({ behavior: \u0027smooth\u0027 }); }, 150);\" style=\"padding: 6px 12px; font-size: 0.8rem;\"\u003e\n                  \u003ci class=\"fa-solid fa-microphone\"\u003e\u003c/i\u003e Record / Play MP3\n                \u003c/button\u003e\n                \u003cbutton class=\"btn-link\" onclick=\"switchTab(\u0027accounts\u0027)\"\u003eManage All \u0026rarr;\u003c/button\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"accounts-mini-list\" id=\"overview-accounts-list\"\u003e\n              \u003cdiv class=\"empty-state\"\u003e\n                \u003ci class=\"fa-solid fa-ghost\"\u003e\u003c/i\u003e\n                \u003cp\u003eNo accounts configured. Click \u003cb\u003e\"Add Account\"\u003c/b\u003e to get started!\u003c/p\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n      \u003c/section\u003e\n\n      \u003c!-- TAB 2: MULTI ACCOUNTS --\u003e\n      \u003csection id=\"tab-accounts\" class=\"tab-pane\"\u003e\n        \u003cdiv class=\"pane-action-bar\"\u003e\n          \u003cdiv class=\"search-input-wrapper\"\u003e\n            \u003ci class=\"fa-solid fa-magnifying-glass\"\u003e\u003c/i\u003e\n            \u003cinput type=\"text\" id=\"filter-accounts-input\" placeholder=\"Search accounts by label, tag, or ID...\"\u003e\n          \u003c/div\u003e\n          \u003cdiv style=\"display: flex; gap: 10px; align-items: center; flex-wrap: wrap;\"\u003e\n            \u003cdiv class=\"badge\" id=\"badge-accounts-quota\" style=\"padding: 9px 14px; font-size: 0.85rem; background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); color: #c084fc; font-weight: 700; white-space: nowrap;\"\u003e\n              \u003ci class=\"fa-solid fa-robot\"\u003e\u003c/i\u003e Plan Quota: \u003cspan id=\"lbl-quota-counter\"\u003e0 / 10 Bots\u003c/span\u003e\n            \u003c/div\u003e\n            \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"openTokenManagerModal()\" title=\"Mass Token Manager: Paste all tokens in 1 way\" style=\"border-color: #fbbf24; color: #fbbf24; font-weight: 700;\"\u003e\n              \u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e Mass Token Manager\n            \u003c/button\u003e\n            \u003cbutton class=\"btn btn-primary\" id=\"btn-add-account-tab\" onclick=\"openAddAccountModal()\"\u003e\n              \u003ci class=\"fa-solid fa-user-plus\"\u003e\u003c/i\u003e Add Account with Token\n            \u003c/button\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003c!-- Accounts Grid --\u003e\n        \u003cdiv class=\"accounts-grid\" id=\"accounts-grid-container\"\u003e\n          \u003c!-- Dynamically populated --\u003e\n        \u003c/div\u003e\n      \u003c/section\u003e\n\n      \u003c!-- TAB 3: 24/7 VOICE STAY --\u003e\n      \u003csection id=\"tab-voice\" class=\"tab-pane\"\u003e\n        \u003c!-- Mass 24/7 Voice Control Card --\u003e\n        \u003cdiv class=\"card\" id=\"mass-voice-card\" style=\"margin-bottom: 22px; border: 1px solid rgba(168, 85, 247, 0.4); background: linear-gradient(180deg, rgba(22, 14, 38, 0.75) 0%, rgba(10, 10, 16, 0.85) 100%); box-shadow: 0 10px 30px rgba(0,0,0,0.6), 0 0 25px rgba(168, 85, 247, 0.15); border-radius: 20px;\"\u003e\n          \u003cdiv class=\"card-header\" style=\"display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid rgba(255,255,255,0.07); padding: 16px 20px;\"\u003e\n            \u003cdiv style=\"display:flex; align-items:center; gap:12px;\"\u003e\n              \u003cdiv style=\"width:38px; height:38px; border-radius:12px; background:rgba(168, 85, 247, 0.2); display:flex; align-items:center; justify-content:center; border: 1px solid rgba(168, 85, 247, 0.4);\"\u003e\n                \u003ci class=\"fa-solid fa-users-rays\" style=\"color: #c084fc; font-size:1.15rem;\"\u003e\u003c/i\u003e\n              \u003c/div\u003e\n              \u003cdiv\u003e\n                \u003ch3 style=\"margin:0; font-size:1.05rem; font-weight:800; color:#ffffff;\"\u003eMass Voice \u0026 24/7 Stay\u003c/h3\u003e\n                \u003cspan style=\"font-size:0.75rem; color:#94a3b8;\"\u003eConnect ALL your bots to the same Voice Channel at once\u003c/span\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n            \u003cspan class=\"badge badge-primary\" style=\"padding: 6px 12px; font-weight:700;\"\u003e\u003ci class=\"fa-solid fa-bolt\"\u003e\u003c/i\u003e All Bots\u003c/span\u003e\n          \u003c/div\u003e\n          \u003cdiv class=\"card-body\" style=\"padding: 18px 20px;\"\u003e\n            \u003cdiv style=\"display:grid; grid-template-columns: 1fr; gap: 14px; margin-bottom: 16px;\"\u003e\n              \u003cdiv\u003e\n                \u003clabel style=\"font-size:0.82rem; font-weight:700; color:#e2e8f0; display:block; margin-bottom:6px;\"\u003e\n                  \u003ci class=\"fa-solid fa-hashtag\" style=\"color:#c084fc;\"\u003e\u003c/i\u003e Voice Channel ID:\n                \u003c/label\u003e\n                \u003cdiv style=\"display:flex; gap:8px;\"\u003e\n                  \u003cinput type=\"text\" id=\"mass-vc-id\" class=\"input-text\" placeholder=\"Paste Voice Channel ID (e.g. 1546123281734696980)...\" style=\"flex:1;\"\u003e\n                  \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"loadMassChannelSelector()\" title=\"Pick from server list\"\u003e\n                    \u003ci class=\"fa-solid fa-list\"\u003e\u003c/i\u003e Select\n                  \u003c/button\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n\n              \u003c!-- Channel Selector Dropdown (optional) --\u003e\n              \u003cdiv id=\"mass-channel-dropdown-box\" style=\"display:none; background: rgba(0,0,0,0.45); border-radius:12px; padding:12px; border:1px solid rgba(255,255,255,0.08);\"\u003e\n                \u003clabel style=\"font-size:0.75rem; color:#94a3b8; display:block; margin-bottom:6px;\"\u003eOr Pick from Discord Server List:\u003c/label\u003e\n                \u003cdiv style=\"display:grid; grid-template-columns: 1fr 1fr; gap:8px;\"\u003e\n                  \u003cselect id=\"mass-guild-select\" class=\"input-select\" onchange=\"onMassGuildChange()\"\u003e\n                    \u003coption value=\"\"\u003e-- Choose Server --\u003c/option\u003e\n                  \u003c/select\u003e\n                  \u003cselect id=\"mass-channel-select\" class=\"input-select\" onchange=\"onMassChannelChange()\"\u003e\n                    \u003coption value=\"\"\u003e-- Choose Channel --\u003c/option\u003e\n                  \u003c/select\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n\n              \u003cdiv style=\"display:flex; flex-wrap:wrap; gap:16px; align-items:center; padding: 4px 0;\"\u003e\n                \u003clabel style=\"display:flex; align-items:center; gap:8px; font-size:0.84rem; cursor:pointer; color:#e2e8f0;\"\u003e\n                  \u003cinput type=\"checkbox\" id=\"mass-247-enabled\" checked style=\"accent-color:#a855f7; width:17px; height:17px;\"\u003e\n                  \u003cspan\u003e\u003cb\u003eKeep 24/7 Connected\u003c/b\u003e (Auto-reconnect indefinitely)\u003c/span\u003e\n                \u003c/label\u003e\n                \u003clabel style=\"display:flex; align-items:center; gap:8px; font-size:0.84rem; cursor:pointer; color:#94a3b8;\"\u003e\n                  \u003cinput type=\"checkbox\" id=\"mass-self-mute\" style=\"accent-color:#a855f7; width:15px; height:15px;\"\u003e\n                  \u003cspan\u003eSelf-Mute\u003c/span\u003e\n                \u003c/label\u003e\n                \u003clabel style=\"display:flex; align-items:center; gap:8px; font-size:0.84rem; cursor:pointer; color:#94a3b8;\"\u003e\n                  \u003cinput type=\"checkbox\" id=\"mass-self-deaf\" style=\"accent-color:#a855f7; width:15px; height:15px;\"\u003e\n                  \u003cspan\u003eSelf-Deafen\u003c/span\u003e\n                \u003c/label\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n\n            \u003cdiv style=\"display:flex; gap:10px; flex-wrap:wrap;\"\u003e\n              \u003cbutton class=\"btn btn-primary\" id=\"btn-mass-join\" onclick=\"executeMassJoinVoice()\" style=\"flex:1; min-width:200px; padding:12px 18px; font-weight:800; font-size:0.92rem; box-shadow: 0 4px 20px rgba(168, 85, 247, 0.4);\"\u003e\n                \u003ci class=\"fa-solid fa-tower-broadcast\"\u003e\u003c/i\u003e Join All Bots to VC (24/7)\n              \u003c/button\u003e\n              \u003cbutton class=\"btn btn-outline btn-danger-outline\" id=\"btn-mass-leave\" onclick=\"executeMassLeaveVoice()\" style=\"padding:12px 18px; font-weight:700;\"\u003e\n                \u003ci class=\"fa-solid fa-phone-slash\"\u003e\u003c/i\u003e Leave All\n              \u003c/button\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003c!-- Permanent Server Leave \u0026 Mass Guild Cleaner --\u003e\n        \u003cdiv class=\"card\" id=\"permanent-leave-card\" style=\"margin-bottom: 22px; border: 1px solid rgba(239, 68, 68, 0.4); background: linear-gradient(180deg, rgba(32, 14, 18, 0.85) 0%, rgba(12, 8, 10, 0.95) 100%); box-shadow: 0 10px 30px rgba(0,0,0,0.6), 0 0 25px rgba(239, 68, 68, 0.15); border-radius: 20px;\"\u003e\n          \u003cdiv class=\"card-header\" style=\"display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid rgba(255,255,255,0.07); padding: 16px 20px;\"\u003e\n            \u003cdiv style=\"display:flex; align-items:center; gap:12px;\"\u003e\n              \u003cdiv style=\"width:38px; height:38px; border-radius:12px; background:rgba(239, 68, 68, 0.2); display:flex; align-items:center; justify-content:center; border: 1px solid rgba(239, 68, 68, 0.4);\"\u003e\n                \u003ci class=\"fa-solid fa-arrow-right-from-bracket\" style=\"color: #ef4444; font-size:1.15rem;\"\u003e\u003c/i\u003e\n              \u003c/div\u003e\n              \u003cdiv\u003e\n                \u003ch3 style=\"margin:0; font-size:1.05rem; font-weight:800; color:#ffffff;\"\u003ePermanent Server Leave \u0026 Cleaner\u003c/h3\u003e\n                \u003cspan style=\"font-size:0.75rem; color:#94a3b8;\"\u003eSafely leave any Discord server permanently across single or all bots\u003c/span\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n            \u003cspan class=\"badge badge-danger\" style=\"padding: 6px 12px; font-weight:700;\"\u003e\u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e Proxy Protected\u003c/span\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"card-body\" style=\"padding: 18px 20px;\"\u003e\n            \u003cp style=\"font-size: 0.82rem; color: #cbd5e1; margin-bottom: 14px; line-height: 1.45;\"\u003e\n              Leaves the selected Discord server permanently. Disconnects bots from voice, completely removes 24/7 reconnect rules, and routes API requests through proxy rotation with jitter delays to prevent account rate-limits or Discord flags.\n            \u003c/p\u003e\n\n            \u003cdiv style=\"display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; margin-bottom: 16px;\"\u003e\n              \u003cdiv\u003e\n                \u003clabel style=\"font-size:0.82rem; font-weight:700; color:#e2e8f0; display:block; margin-bottom:6px;\"\u003e\n                  \u003ci class=\"fa-solid fa-server\" style=\"color:#ef4444;\"\u003e\u003c/i\u003e Select Server to Leave:\n                \u003c/label\u003e\n                \u003cdiv style=\"display:flex; gap:8px;\"\u003e\n                  \u003cselect id=\"leave-guild-select\" class=\"form-select\" style=\"flex:1;\"\u003e\n                    \u003coption value=\"\"\u003e-- Click \"Refresh Servers\" to load --\u003c/option\u003e\n                  \u003c/select\u003e\n                  \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"loadGuildsForLeave()\" title=\"Refresh joined servers\"\u003e\n                    \u003ci class=\"fa-solid fa-arrows-rotate\"\u003e\u003c/i\u003e\n                  \u003c/button\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n\n              \u003cdiv\u003e\n                \u003clabel style=\"font-size:0.82rem; font-weight:700; color:#e2e8f0; display:block; margin-bottom:6px;\"\u003e\n                  \u003ci class=\"fa-solid fa-robot\" style=\"color:#c084fc;\"\u003e\u003c/i\u003e Target Bots:\n                \u003c/label\u003e\n                \u003cselect id=\"leave-bot-select\" class=\"form-select\"\u003e\n                  \u003coption value=\"ALL_BOTS\"\u003e👑 ALL BOTS (Mass Server Leave)\u003c/option\u003e\n                \u003c/select\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n\n            \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06);\"\u003e\n              \u003clabel class=\"toggle-checkbox\" style=\"font-size: 0.82rem; color: #cbd5e1; display: flex; align-items: center; gap: 8px;\"\u003e\n                \u003cinput type=\"checkbox\" id=\"leave-use-proxy-checkbox\" checked\u003e\n                \u003cspan\u003e\u003cb\u003eRoute through Proxy Pool\u003c/b\u003e (1,938 proxies loaded for IP \u0026 token protection)\u003c/span\u003e\n              \u003c/label\u003e\n\n              \u003cbutton class=\"btn btn-outline btn-danger-outline\" id=\"btn-submit-leave-guild\" onclick=\"submitPermanentServerLeave()\" style=\"padding: 12px 20px; font-weight: 700;\"\u003e\n                \u003ci class=\"fa-solid fa-arrow-right-from-bracket\"\u003e\u003c/i\u003e Leave Server Permanently\n              \u003c/button\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"info-banner\"\u003e\n          \u003ci class=\"fa-solid fa-circle-info\"\u003e\u003c/i\u003e\n          \u003cdiv\u003e\n            \u003ch4\u003ePer-Bot 24/7 Voice Stay\u003c/h4\u003e\n            \u003cp\u003eYou can also configure individual bots below. When \u003cb\u003e24/7 Stay\u003c/b\u003e is active, bots automatically reconnect if kicked, moved, or disconnected.\u003c/p\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"voice-manager-container\" id=\"voice-manager-cards\"\u003e\n          \u003c!-- Dynamically populated per account --\u003e\n        \u003c/div\u003e\n      \u003c/section\u003e\n\n      \u003c!-- TAB 5: MUSIC PLAYER --\u003e\n      \u003csection id=\"tab-music\" class=\"tab-pane\"\u003e\n        \u003c!-- Bot \u0026 Guild Selector Bar --\u003e\n        \u003cdiv class=\"music-selector-bar\"\u003e\n          \u003cdiv class=\"selector-group\"\u003e\n            \u003clabel for=\"music-bot-select\"\u003e\u003ci class=\"fa-solid fa-robot\"\u003e\u003c/i\u003e Select Playing Bot:\u003c/label\u003e\n            \u003cselect id=\"music-bot-select\" class=\"form-select\"\u003e\n              \u003coption value=\"\"\u003e-- Choose Account --\u003c/option\u003e\n            \u003c/select\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"selector-group\"\u003e\n            \u003clabel for=\"music-guild-select\"\u003e\u003ci class=\"fa-solid fa-server\"\u003e\u003c/i\u003e Target Guild:\u003c/label\u003e\n            \u003cselect id=\"music-guild-select\" class=\"form-select\"\u003e\n              \u003coption value=\"\"\u003e-- Choose Server --\u003c/option\u003e\n            \u003c/select\u003e\n          \u003c/div\u003e\n\n          \u003cdiv class=\"selector-group\"\u003e\n            \u003clabel for=\"music-voice-select\"\u003e\u003ci class=\"fa-solid fa-microphone\"\u003e\u003c/i\u003e Voice Channel:\u003c/label\u003e\n            \u003cselect id=\"music-voice-select\" class=\"form-select\"\u003e\n              \u003coption value=\"\"\u003e-- Choose Voice Channel --\u003c/option\u003e\n            \u003c/select\u003e\n          \u003c/div\u003e\n\n          \u003cdiv style=\"display: flex; gap: 8px; align-items: flex-end;\"\u003e\n            \u003cbutton class=\"btn btn-primary\" id=\"btn-connect-music-voice\" title=\"Connect selected bot to this voice channel\"\u003e\n              \u003ci class=\"fa-solid fa-plug\"\u003e\u003c/i\u003e Join Voice\n            \u003c/button\u003e\n            \u003cbutton class=\"btn btn-secondary\" id=\"btn-connect-all-music-voice\" style=\"background: linear-gradient(135deg, rgba(168,85,247,0.35), rgba(99,102,241,0.35)); border: 1px solid rgba(168,85,247,0.6); font-weight: 600;\" title=\"Connect all your online bots to this voice channel\"\u003e\n              \u003ci class=\"fa-solid fa-users\"\u003e\u003c/i\u003e All Bots to VC\n            \u003c/button\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"music-deck-grid\"\u003e\n          \u003c!-- Player Core Deck --\u003e\n          \u003cdiv class=\"glass-panel player-core-panel\"\u003e\n            \u003c!-- Search \u0026 Play Bar --\u003e\n            \u003cdiv class=\"music-search-bar\"\u003e\n              \u003cdiv class=\"search-box\"\u003e\n                \u003ci class=\"fa-solid fa-magnifying-glass\"\u003e\u003c/i\u003e\n                \u003cinput type=\"text\" id=\"music-search-input\" placeholder=\"Search track name, YouTube URL, Spotify URL, SoundCloud...\"\u003e\n              \u003c/div\u003e\n              \u003cbutton class=\"btn btn-primary\" id=\"btn-music-search\"\u003e\n                \u003ci class=\"fa-solid fa-play\"\u003e\u003c/i\u003e Search \u0026 Play\n              \u003c/button\u003e\n              \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"document.getElementById(\u0027custom-audio-deck\u0027).scrollIntoView({behavior:\u0027smooth\u0027}); if(window.customAudioStudio) customAudioStudio.switchTab(\u0027record\u0027);\" title=\"Record Voice Audio\"\u003e\n                \u003ci class=\"fa-solid fa-microphone\"\u003e\u003c/i\u003e Record\n              \u003c/button\u003e\n              \u003cbutton class=\"btn btn-outline\" type=\"button\" onclick=\"document.getElementById(\u0027custom-audio-deck\u0027).scrollIntoView({behavior:\u0027smooth\u0027}); if(window.customAudioStudio) customAudioStudio.switchTab(\u0027upload\u0027);\" title=\"Upload MP3 Audio File\"\u003e\n                \u003ci class=\"fa-solid fa-file-audio\"\u003e\u003c/i\u003e Upload MP3\n              \u003c/button\u003e\n            \u003c/div\u003e\n\n            \u003c!-- Search Results Dropdown/Box --\u003e\n            \u003cdiv class=\"search-results-box\" id=\"search-results-box\" style=\"display:none;\"\u003e\n              \u003cdiv class=\"results-header\"\u003e\n                \u003cspan\u003eTop Results\u003c/span\u003e\n                \u003cbutton class=\"btn-close\" onclick=\"closeSearchResults()\"\u003e\u0026times;\u003c/button\u003e\n              \u003c/div\u003e\n              \u003cdiv class=\"results-list\" id=\"search-results-list\"\u003e\u003c/div\u003e\n            \u003c/div\u003e\n\n            \u003c!-- Hero Now Playing Display --\u003e\n            \u003cdiv class=\"now-playing-hero\"\u003e\n              \u003cdiv class=\"artwork-wrapper\"\u003e\n                \u003cimg id=\"now-playing-art\" src=\"https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=400\" alt=\"Artwork\"\u003e\n                \u003cdiv class=\"art-overlay\" id=\"playing-visualizer\"\u003e\n                  \u003cdiv class=\"wave-bar\"\u003e\u003c/div\u003e\n                  \u003cdiv class=\"wave-bar\"\u003e\u003c/div\u003e\n                  \u003cdiv class=\"wave-bar\"\u003e\u003c/div\u003e\n                  \u003cdiv class=\"wave-bar\"\u003e\u003c/div\u003e\n                  \u003cdiv class=\"wave-bar\"\u003e\u003c/div\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n\n              \u003cdiv class=\"track-meta\"\u003e\n                \u003cspan class=\"source-tag\" id=\"track-source-tag\"\u003eYouTube\u003c/span\u003e\n                \u003ch2 class=\"track-title\" id=\"now-playing-title\"\u003eNo Track Playing\u003c/h2\u003e\n                \u003ch3 class=\"track-author\" id=\"now-playing-author\"\u003eSelect a track or search above\u003c/h3\u003e\n\n                \u003c!-- Seekbar --\u003e\n                \u003cdiv class=\"seekbar-container\"\u003e\n                  \u003cspan class=\"time-label\" id=\"time-current\"\u003e0:00\u003c/span\u003e\n                  \u003cdiv class=\"seekbar-track\" id=\"seekbar-track\"\u003e\n                    \u003cdiv class=\"seekbar-fill\" id=\"seekbar-fill\"\u003e\u003c/div\u003e\n                  \u003c/div\u003e\n                  \u003cspan class=\"time-label\" id=\"time-total\"\u003e0:00\u003c/span\u003e\n                \u003c/div\u003e\n\n                \u003c!-- Playback Controls --\u003e\n                \u003cdiv class=\"player-controls\"\u003e\n                  \u003cbutton class=\"control-btn\" id=\"btn-loop-mode\" title=\"Click to toggle Loop (OFF / TRACK / QUEUE)\" style=\"min-width: 72px; padding: 6px 10px; border-radius: 12px; border: 1px solid rgba(168, 85, 247, 0.5); background: rgba(168, 85, 247, 0.15);\"\u003e\n                    \u003ci class=\"fa-solid fa-repeat\" style=\"color: #c084fc;\"\u003e\u003c/i\u003e\n                    \u003cspan class=\"loop-indicator\" id=\"loop-mode-text\" style=\"font-size: 0.72rem; font-weight: 800; color: #ffffff;\"\u003eLOOP: OFF\u003c/span\u003e\n                  \u003c/button\u003e\n                  \u003cbutton class=\"control-btn play-main\" id=\"btn-play-pause\"\u003e\n                    \u003ci class=\"fa-solid fa-play\" id=\"icon-play-pause\"\u003e\u003c/i\u003e\n                  \u003c/button\u003e\n                  \u003cbutton class=\"control-btn\" id=\"btn-skip\" title=\"Skip Track\"\u003e\n                    \u003ci class=\"fa-solid fa-forward-step\"\u003e\u003c/i\u003e\n                  \u003c/button\u003e\n                  \u003cbutton class=\"control-btn\" id=\"btn-sync-bots\" title=\"Snap all bots to exact same track and millisecond\"\u003e\n                    \u003ci class=\"fa-solid fa-arrows-rotate\"\u003e\u003c/i\u003e\n                  \u003c/button\u003e\n                  \u003cbutton class=\"control-btn btn-danger-icon\" id=\"btn-stop-track\" title=\"Stop \u0026 Clear\"\u003e\n                    \u003ci class=\"fa-solid fa-stop\"\u003e\u003c/i\u003e\n                  \u003c/button\u003e\n                \u003c/div\u003e\n\n                \n                \u003c!-- ═══ VOLUME \u0026 BASS COMMAND CONTROLLER (from dashboard \u0026 dashboard sb html) ═══ --\u003e\n                \u003cdiv class=\"audio-tweak-row\" style=\"flex-direction: column; gap: 14px; width: 100%; padding: 12px; background: rgba(15, 10, 28, 0.75); border: 1px solid rgba(168, 85, 247, 0.28); border-radius: 16px;\"\u003e\n                  \u003c!-- Status \u0026 Live Volume Row --\u003e\n                  \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 10px;\"\u003e\n                    \u003cdiv style=\"display: flex; align-items: center; gap: 8px;\"\u003e\n                      \u003cspan class=\"status-dot online-dot\" id=\"music-status-dot\" style=\"width: 10px; height: 10px; border-radius: 50%; background: #00e676; box-shadow: 0 0 10px #00e676; display: inline-block;\"\u003e\u003c/span\u003e\n                      \u003cspan style=\"font-family: var(--font-mono); font-size: 0.85rem; font-weight: 700; color: #cbd5e1;\" id=\"music-status-text\"\u003eCONNECTED\u003c/span\u003e\n                      \u003cdiv class=\"pill\" style=\"background: rgba(168, 85, 247, 0.15); border: 1px solid rgba(168, 85, 247, 0.35); padding: 4px 10px; border-radius: 20px; font-size: 0.76rem; font-weight: 700; color: #c084fc;\"\u003e\n                        🔊 \u003cspan class=\"val\" id=\"vol-display\" style=\"color: #fbbf24; font-weight: 800;\"\u003e10000%\u003c/span\u003e\n                      \u003c/div\u003e\n                    \u003c/div\u003e\n\n                    \u003c!-- Quick Volume Presets --\u003e\n                    \u003cdiv style=\"display: flex; gap: 6px; align-items: center; flex-wrap: wrap;\"\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-outline\" onclick=\"sendCmd(\u0027volume 100\u0027)\" style=\"padding: 3px 8px; font-size: 0.72rem;\"\u003e100%\u003c/button\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-outline\" onclick=\"sendCmd(\u0027volume 500\u0027)\" style=\"padding: 3px 8px; font-size: 0.72rem;\"\u003e500%\u003c/button\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-outline\" onclick=\"sendCmd(\u0027volume 1000\u0027)\" style=\"padding: 3px 8px; font-size: 0.72rem;\"\u003e1000%\u003c/button\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-outline\" onclick=\"sendCmd(\u0027volume 5000\u0027)\" style=\"padding: 3px 8px; font-size: 0.72rem; color: #fbbf24; border-color: rgba(251,191,36,0.4);\"\u003e5000%\u003c/button\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-primary\" onclick=\"sendCmd(\u0027max\u0027)\" style=\"padding: 3px 10px; font-size: 0.72rem; background: linear-gradient(135deg, #ef4444, #dc2626); border-color: #ef4444; font-weight: 800;\"\u003e💀 10000% MAX\u003c/button\u003e\n                      \u003cbutton type=\"button\" class=\"btn btn-sm btn-primary\" onclick=\"sendCmd(\u0027volume 20000\u0027)\" style=\"padding: 3px 10px; font-size: 0.72rem; background: linear-gradient(135deg, #a855f7, #ec4899); border-color: #ec4899; font-weight: 800;\"\u003e💥 20000%\u003c/button\u003e\n                    \u003c/div\u003e\n                  \u003c/div\u003e\n\n                  \u003c!-- Volume Slider Range (1% to 20,000%) --\u003e\n                  \u003cdiv class=\"volume-control\" style=\"width: 100%; display: flex; align-items: center; gap: 10px;\"\u003e\n                    \u003ci class=\"fa-solid fa-volume-high\" id=\"volume-icon\" style=\"color: #fbbf24; font-size: 1.1rem;\"\u003e\u003c/i\u003e\n                    \u003cinput type=\"range\" id=\"volume-slider\" min=\"1\" max=\"20000\" step=\"100\" value=\"10000\" title=\"Adjust Volume (1% - 20000%)\" style=\"flex: 1; accent-color: #fbbf24;\" oninput=\"onVolumeSliderChange(this.value)\"\u003e\n                  \u003c/div\u003e\n\n                  \u003c!-- ═══ 14 QUICK COMMANDS GRID (from dashboard sb html) ═══ --\u003e\n                  \u003cdiv style=\"width: 100%; margin-top: 6px;\"\u003e\n                    \u003cdiv style=\"font-family: var(--font-mono); font-size: 0.76rem; letter-spacing: 2px; color: #a688e0; font-weight: 700; text-transform: uppercase; margin-bottom: 8px;\"\u003e\n                      ⚡ Quick Commands\n                    \u003c/div\u003e\n                    \u003cdiv class=\"cmd-grid\" style=\"display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;\"\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027stop\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e⏹️\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eStop\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027pause\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e⏸️\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003ePause\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027resume\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e▶️\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eResume\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027blast\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e🔥\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eBlast\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027doubleblast\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e💥\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eDouble\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027superloud\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e🔊\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eSuper\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027forceloud\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e⚡\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eForce\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn active\" id=\"cmd-btn-bass\" onclick=\"sendCmd(\u0027bassboost\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e🎵\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eBass\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027pungi\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e🐍\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003ePungi\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027loudmode\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e📢\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eLoud\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027loop\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e🔄\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eLoop\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027leave\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e👋\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eLeave\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027max\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e💀\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eMax\u003c/span\u003e\u003c/div\u003e\n                      \u003cdiv class=\"cmd-btn\" onclick=\"sendCmd(\u0027status\u0027)\"\u003e\u003cspan class=\"cmd-icon\"\u003e📊\u003c/span\u003e\u003cspan class=\"cmd-label\"\u003eStatus\u003c/span\u003e\u003c/div\u003e\n                    \u003c/div\u003e\n                  \u003c/div\u003e\n\n                  \u003c!-- ═══ CUSTOM COMMAND BAR (from dashboard sb html) ═══ --\u003e\n                  \u003cdiv style=\"width: 100%; margin-top: 8px; background: rgba(10, 5, 20, 0.6); border: 1px solid rgba(168, 85, 247, 0.25); border-radius: 12px; padding: 12px;\"\u003e\n                    \u003cdiv style=\"font-family: var(--font-mono); font-size: 0.76rem; letter-spacing: 2px; color: #a688e0; font-weight: 700; text-transform: uppercase; margin-bottom: 8px;\"\u003e\n                      ⌨️ Custom Command\n                    \u003c/div\u003e\n                    \u003cdiv style=\"display: flex; gap: 8px;\"\u003e\n                      \u003cinput type=\"text\" id=\"cmd-input\" placeholder=\"play https://youtube.com/... or volume 15000 or channelId or help\" onkeydown=\"if(event.key===\u0027Enter\u0027) sendCustom()\" style=\"flex: 1; background: #0a0514; color: #cbb8ff; border: 1px solid #2d1f4a; border-radius: 10px; padding: 10px 14px; font-family: var(--font-mono); font-size: 0.85rem;\"\u003e\n                      \u003cbutton class=\"btn btn-primary\" onclick=\"sendCustom()\" style=\"background: linear-gradient(135deg, #b57cff, #7c4dff); font-weight: 700; padding: 0 18px; letter-spacing: 1px;\"\u003e\n                        Send ✦\n                      \u003c/button\u003e\n                    \u003c/div\u003e\n                    \u003cdiv id=\"cmd-live-response\" style=\"display: none; margin-top: 8px; font-family: var(--font-mono); font-size: 0.8rem; padding: 8px 12px; border-radius: 8px; background: rgba(0, 230, 118, 0.1); border: 1px solid rgba(0, 230, 118, 0.3); color: #00e676; white-space: pre-wrap;\"\u003e\u003c/div\u003e\n                  \u003c/div\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003c!-- Queue Panel --\u003e\n          \u003cdiv class=\"glass-panel queue-panel\"\u003e\n            \u003cdiv class=\"panel-header\"\u003e\n              \u003ch2\u003e\u003ci class=\"fa-solid fa-list-ol\"\u003e\u003c/i\u003e Up Next (\u003cspan id=\"queue-count\"\u003e0\u003c/span\u003e)\u003c/h2\u003e\n              \u003cbutton class=\"btn btn-sm btn-outline btn-danger-outline\" id=\"btn-clear-queue\"\u003e\n                \u003ci class=\"fa-solid fa-trash\"\u003e\u003c/i\u003e Clear\n              \u003c/button\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"queue-list\" id=\"queue-items-container\"\u003e\n              \u003cdiv class=\"empty-state\"\u003e\n                \u003ci class=\"fa-solid fa-music\"\u003e\u003c/i\u003e\n                \u003cp\u003eQueue is currently empty\u003c/p\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003c!-- Custom Audio Studio: Voice Recording \u0026 MP3 Player Deck --\u003e\n        \u003cdiv class=\"glass-panel custom-audio-deck\" id=\"custom-audio-deck\"\u003e\n          \u003cdiv class=\"panel-header\" style=\"margin-bottom: 16px;\"\u003e\n            \u003cdiv style=\"display: flex; align-items: center; gap: 10px;\"\u003e\n              \u003cdiv style=\"width: 38px; height: 38px; border-radius: 10px; background: rgba(168, 85, 247, 0.2); border: 1px solid #a855f7; display: flex; align-items: center; justify-content: center; color: #c084fc; font-size: 1.1rem;\"\u003e\n                \u003ci class=\"fa-solid fa-microphone-lines\"\u003e\u003c/i\u003e\n              \u003c/div\u003e\n              \u003cdiv\u003e\n                \u003ch2 style=\"font-size: 1.15rem; margin: 0; color: #ffffff;\"\u003ePlay Songs via Voice Recording or MP3 Audios\u003c/h2\u003e\n                \u003cp style=\"margin: 2px 0 0; font-size: 0.8rem; color: #a1a1aa;\"\u003eRecord speech/audio directly or upload any local MP3 file to stream through your bot\u003c/p\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n            \u003cspan class=\"badge badge-success\" style=\"background: rgba(34, 197, 94, 0.15); border: 1px solid #22c55e; color: #4ade80;\"\u003eLavalink HQ Stream\u003c/span\u003e\n          \u003c/div\u003e\n\n          \u003c!-- Studio Navigation Tabs --\u003e\n          \u003cdiv class=\"audio-studio-tabs\"\u003e\n            \u003cbutton class=\"audio-tab-btn active\" data-audio-tab=\"record\" type=\"button\"\u003e\n              \u003ci class=\"fa-solid fa-microphone\"\u003e\u003c/i\u003e Record Voice Audio\n            \u003c/button\u003e\n            \u003cbutton class=\"audio-tab-btn\" data-audio-tab=\"upload\" type=\"button\"\u003e\n              \u003ci class=\"fa-solid fa-file-audio\"\u003e\u003c/i\u003e Upload MP3 / Audio File\n            \u003c/button\u003e\n            \u003cbutton class=\"audio-tab-btn\" data-audio-tab=\"url\" type=\"button\"\u003e\n              \u003ci class=\"fa-solid fa-link\"\u003e\u003c/i\u003e Direct Audio URL\n            \u003c/button\u003e\n          \u003c/div\u003e\n\n          \u003c!-- SUB-TAB 1: RECORD VOICE AUDIO --\u003e\n          \u003cdiv class=\"audio-tab-content\" data-tab-content=\"record\" style=\"display: block;\"\u003e\n            \u003cdiv style=\"display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; background: #0c0c10; border: 1px solid #1c1c24; border-radius: 12px; gap: 14px;\"\u003e\n              \u003cdiv style=\"display: flex; align-items: center; gap: 12px;\"\u003e\n                \u003cspan class=\"badge badge-warning\" id=\"rec-status-badge\"\u003eSTANDBY\u003c/span\u003e\n                \u003cspan id=\"rec-timer\" style=\"font-family: monospace; font-size: 1.4rem; font-weight: 700; color: #ffffff; letter-spacing: 1px;\"\u003e00:00\u003c/span\u003e\n              \u003c/div\u003e\n\n              \u003c!-- Live VU Audio Level Meter --\u003e\n              \u003cdiv style=\"width: 100%; max-width: 400px; height: 8px; background: #16161c; border-radius: 4px; overflow: hidden; border: 1px solid #262630;\"\u003e\n                \u003cdiv id=\"rec-vu-bar\" style=\"width: 0%; height: 100%; background: linear-gradient(90deg, #22c55e, #a855f7, #ef4444); transition: width 0.05s ease;\"\u003e\u003c/div\u003e\n              \u003c/div\u003e\n\n              \u003cbutton class=\"btn btn-primary\" id=\"btn-rec-toggle\" type=\"button\" style=\"padding: 12px 28px; font-size: 0.95rem; font-weight: 700; border-radius: 30px;\"\u003e\n                \u003ci class=\"fa-solid fa-microphone\"\u003e\u003c/i\u003e Start Recording Voice\n              \u003c/button\u003e\n\n              \u003c!-- Recording Preview \u0026 Controls --\u003e\n              \u003cdiv id=\"rec-preview-container\" class=\"audio-preview-box\" style=\"display: none; width: 100%; max-width: 520px;\"\u003e\n                \u003cdiv style=\"font-size: 0.82rem; font-weight: 600; color: #c084fc; margin-bottom: 6px;\"\u003e\n                  \u003ci class=\"fa-solid fa-circle-play\"\u003e\u003c/i\u003e Recorded Audio Preview:\n                \u003c/div\u003e\n                \u003caudio id=\"rec-audio-elem\" controls style=\"width: 100%; border-radius: 8px;\"\u003e\u003c/audio\u003e\n                \n                \u003cdiv class=\"form-group\" style=\"margin-top: 12px;\"\u003e\n                  \u003clabel style=\"font-size: 0.8rem; color: #a1a1aa;\"\u003eCustom Audio Title:\u003c/label\u003e\n                  \u003cinput type=\"text\" class=\"form-input\" id=\"rec-custom-title\" placeholder=\"e.g. My Voice Message, Freestyle Voice Note...\"\u003e\n                \u003c/div\u003e\n\n                \u003cdiv id=\"rec-action-row\" style=\"display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap;\"\u003e\n                  \u003cbutton class=\"btn btn-primary\" id=\"btn-rec-play-now\" type=\"button\" style=\"flex: 1;\"\u003e\n                    \u003ci class=\"fa-solid fa-play\"\u003e\u003c/i\u003e Play Now to Bot\n                  \u003c/button\u003e\n                  \u003cbutton class=\"btn btn-outline\" id=\"btn-rec-queue\" type=\"button\" style=\"flex: 1;\"\u003e\n                    \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Add to Queue\n                  \u003c/button\u003e\n                  \u003cbutton class=\"btn btn-outline btn-danger-outline\" id=\"btn-rec-reset\" type=\"button\"\u003e\n                    \u003ci class=\"fa-solid fa-trash\"\u003e\u003c/i\u003e Reset\n                  \u003c/button\u003e\n                \u003c/div\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003c!-- SUB-TAB 2: UPLOAD MP3 FILE --\u003e\n          \u003cdiv class=\"audio-tab-content\" data-tab-content=\"upload\" style=\"display: none;\"\u003e\n            \u003cdiv class=\"file-dropzone\" id=\"mp3-dropzone\" onclick=\"document.getElementById(\u0027mp3-file-input\u0027).click()\"\u003e\n              \u003cinput type=\"file\" id=\"mp3-file-input\" accept=\"audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac\" style=\"display: none;\"\u003e\n              \u003cdiv class=\"file-dropzone-icon\"\u003e\n                \u003ci class=\"fa-solid fa-cloud-arrow-up\"\u003e\u003c/i\u003e\n              \u003c/div\u003e\n              \u003ch3 style=\"font-size: 1.05rem; margin: 0 0 4px; color: #ffffff;\"\u003eClick to Select or Drag \u0026 Drop MP3 / Audio File\u003c/h3\u003e\n              \u003cp style=\"font-size: 0.82rem; color: #a1a1aa; margin: 0;\"\u003eSupports MP3, WAV, OGG, M4A, AAC, FLAC (Up to 50MB)\u003c/p\u003e\n            \u003c/div\u003e\n\n            \u003c!-- Upload Preview Card --\u003e\n            \u003cdiv id=\"upload-preview-container\" class=\"audio-preview-box\" style=\"display: none;\"\u003e\n              \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;\"\u003e\n                \u003cdiv style=\"display: flex; align-items: center; gap: 8px;\"\u003e\n                  \u003ci class=\"fa-solid fa-file-audio\" style=\"color: #a855f7; font-size: 1.2rem;\"\u003e\u003c/i\u003e\n                  \u003cspan id=\"upload-file-name\" style=\"font-weight: 700; color: #ffffff; font-size: 0.9rem;\"\u003eaudio.mp3\u003c/span\u003e\n                \u003c/div\u003e\n                \u003cspan id=\"upload-file-size\" class=\"badge\" style=\"background: #181820; border: 1px solid #333; color: #e2e8f0;\"\u003e0.00 MB\u003c/span\u003e\n              \u003c/div\u003e\n\n              \u003caudio id=\"upload-audio-elem\" controls style=\"width: 100%; border-radius: 8px; margin-bottom: 12px;\"\u003e\u003c/audio\u003e\n\n              \u003cdiv class=\"form-group\"\u003e\n                \u003clabel style=\"font-size: 0.8rem; color: #a1a1aa;\"\u003eCustom Song / Track Title:\u003c/label\u003e\n                \u003cinput type=\"text\" class=\"form-input\" id=\"upload-custom-title\" placeholder=\"Track title (defaults to filename)...\"\u003e\n              \u003c/div\u003e\n\n              \u003cdiv style=\"margin-top: 10px; margin-bottom: 6px;\"\u003e\n                \u003clabel class=\"toggle-checkbox\" style=\"font-size: 0.82rem; color: #c084fc; display: flex; align-items: center; gap: 8px;\"\u003e\n                  \u003cinput type=\"checkbox\" id=\"custom-audio-loop-checkbox\"\u003e\n                  \u003cspan\u003e\u003ci class=\"fa-solid fa-repeat\"\u003e\u003c/i\u003e \u003cb\u003eEnable Continuous Loop\u003c/b\u003e (Repeat this song forever)\u003c/span\u003e\n                \u003c/label\u003e\n              \u003c/div\u003e\n\n              \u003cdiv id=\"upload-action-row\" style=\"display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap;\"\u003e\n                \u003cbutton class=\"btn btn-primary\" id=\"btn-upload-play-now\" type=\"button\" style=\"flex: 1;\"\u003e\n                  \u003ci class=\"fa-solid fa-play\"\u003e\u003c/i\u003e Play Now to Bot\n                \u003c/button\u003e\n                \u003cbutton class=\"btn btn-outline\" id=\"btn-upload-queue\" type=\"button\" style=\"flex: 1;\"\u003e\n                  \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Add to Queue\n                \u003c/button\u003e\n                \u003cbutton class=\"btn btn-outline btn-danger-outline\" id=\"btn-upload-reset\" type=\"button\"\u003e\n                  \u003ci class=\"fa-solid fa-trash\"\u003e\u003c/i\u003e Discard\n                \u003c/button\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003c!-- SUB-TAB 3: DIRECT AUDIO URL --\u003e\n          \u003cdiv class=\"audio-tab-content\" data-tab-content=\"url\" style=\"display: none;\"\u003e\n            \u003cdiv style=\"padding: 20px; background: #0c0c10; border: 1px solid #1c1c24; border-radius: 12px;\"\u003e\n              \u003cdiv class=\"form-group\" style=\"margin-bottom: 14px;\"\u003e\n                \u003clabel style=\"font-size: 0.82rem; color: #a1a1aa;\"\u003e\u003ci class=\"fa-solid fa-link\"\u003e\u003c/i\u003e Direct MP3 / Audio Stream URL:\u003c/label\u003e\n                \u003cinput type=\"url\" class=\"form-input\" id=\"direct-audio-url\" placeholder=\"https://example.com/song.mp3, Discord CDN attachment, or Raw audio link...\"\u003e\n              \u003c/div\u003e\n\n              \u003cdiv class=\"form-group\" style=\"margin-bottom: 16px;\"\u003e\n                \u003clabel style=\"font-size: 0.82rem; color: #a1a1aa;\"\u003eTrack Name / Label:\u003c/label\u003e\n                \u003cinput type=\"text\" class=\"form-input\" id=\"url-custom-title\" placeholder=\"e.g. My Audio Stream, Discord Attachment...\"\u003e\n              \u003c/div\u003e\n\n              \u003cdiv style=\"display: flex; gap: 10px; flex-wrap: wrap;\"\u003e\n                \u003cbutton class=\"btn btn-primary\" id=\"btn-url-play-now\" type=\"button\" style=\"flex: 1;\"\u003e\n                  \u003ci class=\"fa-solid fa-play\"\u003e\u003c/i\u003e Play Stream Now\n                \u003c/button\u003e\n                \u003cbutton class=\"btn btn-outline\" id=\"btn-url-queue\" type=\"button\" style=\"flex: 1;\"\u003e\n                  \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Add to Queue\n                \u003c/button\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n\n          \u003c!-- SAVED MP3 SONGS LIBRARY --\u003e\n          \u003cdiv style=\"margin-top: 24px; padding-top: 16px; border-top: 1px solid #1c1c24;\"\u003e\n            \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;\"\u003e\n              \u003cdiv style=\"display: flex; align-items: center; gap: 8px;\"\u003e\n                \u003ci class=\"fa-solid fa-folder-music\" style=\"color: #a855f7;\"\u003e\u003c/i\u003e\n                \u003ch3 style=\"font-size: 0.95rem; font-weight: 700; color: #ffffff; margin: 0;\"\u003eSaved MP3 Songs Library\u003c/h3\u003e\n              \u003c/div\u003e\n              \u003cbutton class=\"btn btn-outline btn-sm\" type=\"button\" onclick=\"if(window.customAudioStudio) window.customAudioStudio.loadSavedSongs();\" title=\"Refresh library\" style=\"padding: 4px 10px; font-size: 0.75rem;\"\u003e\n                \u003ci class=\"fa-solid fa-rotate\"\u003e\u003c/i\u003e Refresh\n              \u003c/button\u003e\n            \u003c/div\u003e\n            \u003cdiv id=\"saved-mp3-list\" style=\"display: flex; flex-direction: column; gap: 8px;\"\u003e\n              \u003cdiv style=\"color: #71717a; font-size: 0.85rem; text-align: center; padding: 16px;\"\u003eLoading saved songs...\u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n      \u003c/section\u003e\n\n      \u003c!-- TAB 5: SETTINGS --\u003e\n      \u003csection id=\"tab-settings\" class=\"tab-pane\"\u003e\n        \u003cdiv class=\"settings-grid\" style=\"grid-template-columns: 1fr; max-width: 700px;\"\u003e\n          \u003c!-- General System Settings --\u003e\n          \u003cdiv class=\"glass-panel\"\u003e\n            \u003cdiv class=\"panel-header\"\u003e\n              \u003ch2\u003e\u003ci class=\"fa-solid fa-sliders\"\u003e\u003c/i\u003e General \u0026 Voice Settings\u003c/h2\u003e\n            \u003c/div\u003e\n            \u003cdiv class=\"settings-form\"\u003e\n              \u003cdiv class=\"form-group\"\u003e\n                \u003clabel class=\"toggle-checkbox\"\u003e\n                  \u003cinput type=\"checkbox\" id=\"cfg-auto-reconnect\" checked\u003e\n                  \u003cspan\u003eAuto-reconnect bots on Voice Disconnect\u003c/span\u003e\n                \u003c/label\u003e\n              \u003c/div\u003e\n\n              \u003cdiv class=\"form-group\"\u003e\n                \u003clabel\u003eReconnect Retry Delay (seconds)\u003c/label\u003e\n                \u003cinput type=\"number\" id=\"cfg-reconnect-delay\" class=\"form-input\" value=\"5\" min=\"1\" max=\"60\"\u003e\n              \u003c/div\u003e\n\n              \u003cdiv class=\"form-group\"\u003e\n                \u003clabel\u003eWeb Dashboard Port\u003c/label\u003e\n                \u003cinput type=\"number\" id=\"cfg-web-port\" class=\"form-input\" value=\"3000\" disabled\u003e\n                \u003csmall class=\"form-hint\"\u003eConfigured via environment or default 3000\u003c/small\u003e\n              \u003c/div\u003e\n            \u003c/div\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n      \u003c/section\u003e\n    \u003c/main\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MODAL: ADD ACCOUNT --\u003e\n  \u003cdiv class=\"modal-overlay\" id=\"modal-add-account\"\u003e\n    \u003cdiv class=\"modal-box glass-panel\"\u003e\n      \u003cdiv class=\"modal-header\"\u003e\n        \u003ch3\u003e\u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e Add Discord Selfbot Account\u003c/h3\u003e\n        \u003cbutton class=\"modal-close\" onclick=\"closeAddAccountModal()\"\u003e\u0026times;\u003c/button\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"modal-body\"\u003e\n        \u003cp class=\"modal-desc\"\u003ePaste your Discord account user token below. The token will be safely stored locally on your machine and logged in directly without .env!\u003c/p\u003e\n\n        \u003c!-- Quick Switch to Mass Token Manager Banner --\u003e\n        \u003cdiv style=\"margin-bottom: 14px; padding: 10px 14px; border-radius: 10px; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.35); display: flex; justify-content: space-between; align-items: center; gap: 8px;\"\u003e\n          \u003cspan style=\"font-size: 0.8rem; color: #fde68a;\"\u003e\u003ci class=\"fa-solid fa-layer-group\" style=\"color: #fbbf24;\"\u003e\u003c/i\u003e Have multiple tokens? Add all at once in 1 click:\u003c/span\u003e\n          \u003cbutton type=\"button\" class=\"btn btn-sm\" onclick=\"closeAddAccountModal(); openTokenManagerModal();\" style=\"padding: 4px 10px; font-size: 0.78rem; background: #fbbf24; color: #000; font-weight: 800; border-radius: 8px; border: none; cursor: pointer; white-space: nowrap;\"\u003e\n            🔑 Token Manager\n          \u003c/button\u003e\n        \u003c/div\u003e\n\n        \u003c!-- Account Quota Warning \u0026 Status Banner --\u003e\n        \u003cdiv id=\"modal-quota-banner\" style=\"margin-bottom: 16px; padding: 10px 14px; border-radius: 8px; background: rgba(168, 85, 247, 0.12); border: 1px solid rgba(168, 85, 247, 0.35); display: flex; justify-content: space-between; align-items: center;\"\u003e\n          \u003cspan style=\"font-size: 0.85rem; color: #e4e4e7;\"\u003e\u003ci class=\"fa-solid fa-robot\" style=\"color: #a855f7;\"\u003e\u003c/i\u003e Allowed Account Quota:\u003c/span\u003e\n          \u003cstrong id=\"modal-quota-text\" style=\"font-size: 0.9rem; color: #c084fc;\"\u003e0 / 10 Bots Used\u003c/strong\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eAccount Label / Nickname\u003c/label\u003e\n          \u003cinput type=\"text\" id=\"add-bot-label\" class=\"form-input\" placeholder=\"e.g. My Main Selfbot, Alt 24/7\"\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eDiscord Account Token\u003c/label\u003e\n          \u003cdiv class=\"token-input-wrapper\"\u003e\n            \u003cinput type=\"password\" id=\"add-bot-token\" class=\"form-input font-mono\" placeholder=\"Paste Discord token here...\"\u003e\n            \u003cbutton type=\"button\" class=\"btn-toggle-eye\" id=\"btn-toggle-token-eye\" onclick=\"toggleTokenVisibility()\"\u003e\n              \u003ci class=\"fa-solid fa-eye\" id=\"eye-icon\"\u003e\u003c/i\u003e\n            \u003c/button\u003e\n          \u003c/div\u003e\n          \u003csmall class=\"form-hint\"\u003eSupports standard Discord user tokens.\u003c/small\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel class=\"toggle-checkbox\"\u003e\n            \u003cinput type=\"checkbox\" id=\"add-bot-autostart\" checked\u003e\n            \u003cspan\u003eAuto-connect on application start\u003c/span\u003e\n          \u003c/label\u003e\n        \u003c/div\u003e\n\n        \u003cdiv id=\"add-account-error\" class=\"error-msg-box\" style=\"display:none;\"\u003e\u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"modal-footer\"\u003e\n        \u003cbutton class=\"btn btn-outline\" onclick=\"closeAddAccountModal()\"\u003eCancel\u003c/button\u003e\n        \u003cbutton class=\"btn btn-primary\" id=\"btn-submit-add-account\" onclick=\"submitAddAccount()\"\u003e\n          \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Connect Account\n        \u003c/button\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MODAL: TOKEN MANAGER (MASS TOKEN IMPORTER MATCHING SCREENSHOT) --\u003e\n  \u003cdiv class=\"modal-overlay\" id=\"modal-token-manager\" style=\"display: none; align-items: center; justify-content: center; z-index: 10000;\"\u003e\n    \u003cdiv class=\"modal-box token-manager-card\" style=\"width: 100%; max-width: 520px; background: rgba(18, 19, 31, 0.96); border: 1px solid rgba(168, 85, 247, 0.35); box-shadow: 0 0 50px rgba(168, 85, 247, 0.25); border-radius: 24px; padding: 24px; position: relative; backdrop-filter: blur(20px);\"\u003e\n      \n      \u003c!-- Top Glowing Star Accent --\u003e\n      \u003cdiv style=\"text-align: center; margin-top: -6px; margin-bottom: 6px;\"\u003e\n        \u003cspan style=\"color: #c084fc; font-size: 1.1rem; filter: drop-shadow(0 0 8px #a855f7);\"\u003e✦\u003c/span\u003e\n        \u003cdiv style=\"width: 80px; height: 2px; background: linear-gradient(90deg, transparent, #a855f7, transparent); margin: 4px auto 14px;\"\u003e\u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;\"\u003e\n        \u003cdiv style=\"display: flex; align-items: center; gap: 8px;\"\u003e\n          \u003ci class=\"fa-solid fa-key\" style=\"color: #fbbf24; font-size: 1.1rem;\"\u003e\u003c/i\u003e\n          \u003ch3 style=\"font-size: 0.95rem; font-weight: 800; letter-spacing: 2.5px; color: #94a3b8; text-transform: uppercase; margin: 0;\"\u003eTOKEN MANAGER\u003c/h3\u003e\n        \u003c/div\u003e\n        \u003cbutton class=\"modal-close\" onclick=\"closeTokenManagerModal()\" style=\"background: none; border: none; color: #94a3b8; font-size: 1.4rem; cursor: pointer; line-height: 1;\"\u003e\u0026times;\u003c/button\u003e\n      \u003c/div\u003e\n\n      \u003c!-- Cloud Persistence Status Badge --\u003e\n      \u003cdiv style=\"margin-bottom: 12px; padding: 6px 12px; border-radius: 8px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); display: flex; align-items: center; justify-content: space-between; font-size: 0.74rem;\"\u003e\n        \u003cspan style=\"color: #6ee7b7; font-weight: 600; display: flex; align-items: center; gap: 6px;\"\u003e\n          \u003ci class=\"fa-solid fa-cloud-arrow-up\" style=\"color: #10b981;\"\u003e\u003c/i\u003e MongoDB Atlas Cloud Persistence\n        \u003c/span\u003e\n        \u003cspan class=\"badge\" style=\"background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 0.68rem; padding: 2px 6px; border-radius: 4px; font-weight: 700;\"\u003ePERMANENT STORAGE\u003c/span\u003e\n      \u003c/div\u003e\n\n      \u003cdiv style=\"margin-bottom: 14px;\"\u003e\n        \u003ctextarea id=\"token-manager-textarea\" \n                  class=\"font-mono\" \n                  placeholder=\"Paste all your Discord tokens here...\u0026#10;One token per line:\u0026#10;\u0026#10;MTUyMjkx...\u0026#10;MTUyMjk0...\u0026#10;MTUwMTMx...\" \n                  rows=\"7\"\n                  oninput=\"updateTokenManagerCounters()\"\n                  style=\"width: 100%; padding: 14px; background: #0c0d16; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 14px; color: #ffffff; font-size: 0.82rem; line-height: 1.5; resize: vertical; outline: none; font-family: var(--font-mono); word-break: break-all;\"\u003e\u003c/textarea\u003e\n      \u003c/div\u003e\n\n      \u003c!-- Live Counters Row --\u003e\n      \u003cdiv style=\"display: flex; gap: 10px; margin-bottom: 18px; align-items: center; flex-wrap: wrap;\"\u003e\n        \u003cdiv style=\"display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 10px; font-size: 0.82rem; color: #cbd5e1; font-weight: 600;\"\u003e\n          \u003cspan\u003e📊\u003c/span\u003e Tokens: \u003cspan id=\"tm-tokens-count\" style=\"color: #c084fc; font-weight: 800; margin-left: 2px;\"\u003e0\u003c/span\u003e\n        \u003c/div\u003e\n        \u003cdiv style=\"display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 10px; font-size: 0.82rem; color: #cbd5e1; font-weight: 600;\"\u003e\n          \u003cspan\u003e✅\u003c/span\u003e Valid: \u003cspan id=\"tm-valid-count\" style=\"color: #22c55e; font-weight: 800; margin-left: 2px;\"\u003e0\u003c/span\u003e\n        \u003c/div\u003e\n        \u003cdiv style=\"margin-left: auto; font-size: 0.78rem; color: #a1a1aa;\" id=\"tm-quota-hint\"\u003e\n          Plan Quota: \u003cspan id=\"tm-quota-text\" style=\"color: #c084fc; font-weight: 700;\"\u003e0/10\u003c/span\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003c!-- Action Buttons Matching User Screenshot --\u003e\n      \u003cdiv style=\"display: flex; flex-direction: column; gap: 10px;\"\u003e\n        \u003cbutton type=\"button\" id=\"btn-tm-save\" onclick=\"submitMassTokens()\" style=\"width: 100%; padding: 13px; font-weight: 800; font-size: 0.95rem; border-radius: 14px; background: #fbbf24; color: #0f172a; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(251, 191, 36, 0.3); transition: transform 0.1s ease, filter 0.2s ease;\"\u003e\n          \u003cspan style=\"font-size: 1.1rem;\"\u003e💾\u003c/span\u003e Save Tokens\n        \u003c/button\u003e\n\n        \u003cbutton type=\"button\" id=\"btn-tm-load\" onclick=\"loadSavedTokensIntoManager()\" style=\"width: 100%; padding: 13px; font-weight: 700; font-size: 0.95rem; border-radius: 14px; background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color: #ffffff; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(168, 85, 247, 0.3); transition: transform 0.1s ease, filter 0.2s ease;\"\u003e\n          \u003cspan style=\"font-size: 1.1rem;\"\u003e📁\u003c/span\u003e Load Saved\n        \u003c/button\u003e\n      \u003c/div\u003e\n\n      \u003cdiv id=\"tm-status-msg\" style=\"display: none; margin-top: 14px; padding: 10px 14px; border-radius: 10px; font-size: 0.82rem; line-height: 1.4;\"\u003e\u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MODAL: EDIT PRESENCE / STATUS --\u003e\n  \u003cdiv class=\"modal-overlay\" id=\"modal-edit-presence\"\u003e\n    \u003cdiv class=\"modal-box glass-panel\"\u003e\n      \u003cdiv class=\"modal-header\"\u003e\n        \u003ch3\u003e\u003ci class=\"fa-solid fa-user-pen\"\u003e\u003c/i\u003e Customize Status \u0026 Rich Presence\u003c/h3\u003e\n        \u003cbutton class=\"modal-close\" onclick=\"closePresenceModal()\"\u003e\u0026times;\u003c/button\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"modal-body\"\u003e\n        \u003cinput type=\"hidden\" id=\"presence-account-id\"\u003e\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eOnline Status\u003c/label\u003e\n          \u003cselect id=\"presence-status-select\" class=\"form-select\"\u003e\n            \u003coption value=\"online\"\u003e🟢 Online\u003c/option\u003e\n            \u003coption value=\"idle\"\u003e🟡 Idle\u003c/option\u003e\n            \u003coption value=\"dnd\"\u003e🔴 Do Not Disturb\u003c/option\u003e\n            \u003coption value=\"invisible\"\u003e⚪ Invisible\u003c/option\u003e\n          \u003c/select\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eActivity Type\u003c/label\u003e\n          \u003cselect id=\"presence-activity-type\" class=\"form-select\"\u003e\n            \u003coption value=\"PLAYING\"\u003ePlaying\u003c/option\u003e\n            \u003coption value=\"STREAMING\"\u003eStreaming\u003c/option\u003e\n            \u003coption value=\"LISTENING\"\u003eListening to\u003c/option\u003e\n            \u003coption value=\"WATCHING\"\u003eWatching\u003c/option\u003e\n            \u003coption value=\"COMPETING\"\u003eCompeting in\u003c/option\u003e\n          \u003c/select\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eActivity Text / Name\u003c/label\u003e\n          \u003cinput type=\"text\" id=\"presence-activity-name\" class=\"form-input\" placeholder=\"e.g. 24/7 Lo-Fi Beats\"\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\" id=\"group-streaming-url\" style=\"display:none;\"\u003e\n          \u003clabel\u003eTwitch / Stream URL\u003c/label\u003e\n          \u003cinput type=\"text\" id=\"presence-streaming-url\" class=\"form-input\" placeholder=\"https://twitch.tv/discord\"\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"modal-footer\"\u003e\n        \u003cbutton class=\"btn btn-outline\" onclick=\"closePresenceModal()\"\u003eCancel\u003c/button\u003e\n        \u003cbutton class=\"btn btn-primary\" onclick=\"submitPresence()\"\u003e\n          \u003ci class=\"fa-solid fa-check\"\u003e\u003c/i\u003e Save Presence\n        \u003c/button\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- Mobile Bottom Navigation Bar --\u003e\n  \u003cnav class=\"mobile-bottom-nav\"\u003e\n    \u003ca href=\"#overview\" class=\"mob-nav-item active\" data-tab=\"overview\"\u003e\n      \u003ci class=\"fa-solid fa-gauge-high\"\u003e\u003c/i\u003e\n      \u003cspan\u003eHome\u003c/span\u003e\n    \u003c/a\u003e\n    \u003ca href=\"#accounts\" class=\"mob-nav-item\" data-tab=\"accounts\"\u003e\n      \u003ci class=\"fa-solid fa-users\"\u003e\u003c/i\u003e\n      \u003cspan\u003eBots\u003c/span\u003e\n    \u003c/a\u003e\n    \u003ca href=\"#voice\" class=\"mob-nav-item\" data-tab=\"voice\"\u003e\n      \u003ci class=\"fa-solid fa-tower-broadcast\"\u003e\u003c/i\u003e\n      \u003cspan\u003e24/7\u003c/span\u003e\n    \u003c/a\u003e\n    \u003ca href=\"#music\" class=\"mob-nav-item\" data-tab=\"music\"\u003e\n      \u003ci class=\"fa-solid fa-compact-disc\"\u003e\u003c/i\u003e\n      \u003cspan\u003eMusic\u003c/span\u003e\n    \u003c/a\u003e\n    \u003ca href=\"#settings\" class=\"mob-nav-item\" data-tab=\"settings\"\u003e\n      \u003ci class=\"fa-solid fa-sliders\"\u003e\u003c/i\u003e\n      \u003cspan\u003eConfig\u003c/span\u003e\n    \u003c/a\u003e\n  \u003c/nav\u003e\n\n  \u003c!-- EXC 1-DEVICE HWID LOGIN OVERLAY SCREEN --\u003e\n  \u003cdiv id=\"exc-login-overlay\" style=\"display: none; position: fixed; inset: 0; z-index: 99999; background: rgba(8, 9, 14, 0.96); backdrop-filter: blur(25px); align-items: center; justify-content: center; padding: 20px;\"\u003e\n    \u003cdiv class=\"glass-panel login-card\" style=\"width: 100%; max-width: 420px; padding: 36px 28px; text-align: center; border: 1px solid rgba(168, 85, 247, 0.4); box-shadow: 0 0 60px rgba(168, 85, 247, 0.25); border-radius: 20px;\"\u003e\n      \u003cdiv style=\"position: relative; display: inline-block; margin-bottom: 18px;\"\u003e\n        \u003cimg src=\"/assets/logo.jpg\" alt=\"EXC Logo\" style=\"width: 90px; height: 90px; border-radius: 24px; object-fit: cover; border: 2px solid #a855f7; box-shadow: 0 0 35px rgba(168, 85, 247, 0.6);\"\u003e\n        \u003cdiv style=\"position: absolute; bottom: -4px; right: -4px; background: #22c55e; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #0f1016;\"\u003e\u003c/div\u003e\n      \u003c/div\u003e\n      \n      \u003ch1 style=\"font-size: 2rem; font-weight: 800; color: #fff; letter-spacing: 1px; margin-bottom: 4px;\"\u003eEXC\u003c/h1\u003e\n      \u003cp style=\"font-size: 0.84rem; color: var(--text-muted); margin-bottom: 22px;\"\u003eHWID Protected 1-Device Selfbot Dashboard\u003c/p\u003e\n\n      \u003cform id=\"form-exc-login\" onsubmit=\"handleKeyAuthLogin(event)\"\u003e\n        \u003cdiv class=\"form-group\" style=\"text-align: left; margin-bottom: 18px;\"\u003e\n          \u003clabel style=\"font-size: 0.85rem; color: #c084fc; font-weight: 600;\"\u003e\u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e KeyAuth License Key\u003c/label\u003e\n          \u003cdiv class=\"token-input-wrapper\"\u003e\n            \u003cinput type=\"text\" id=\"input-license-key\" class=\"form-input\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" required autofocus autocomplete=\"off\" style=\"letter-spacing: 1.5px; font-family: var(--font-mono); font-weight: 600; text-align: center; text-transform: uppercase; background: rgba(0,0,0,0.5); border: 1px solid rgba(168,85,247,0.4); padding: 12px; font-size: 1rem; color: #fff; width: 100%; border-radius: 10px;\"\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n        \u003cbutton type=\"submit\" class=\"btn btn-primary btn-block\" id=\"btn-login-submit\" style=\"padding: 13px; font-weight: 700; font-size: 0.95rem; width: 100%; border-radius: 10px; background: #7c3aed; color: #fff; border: none; cursor: pointer;\"\u003e\n          \u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e Activate Key \u0026 Access Dashboard\n        \u003c/button\u003e\n      \u003c/form\u003e\n      \u003cdiv style=\"margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 14px;\"\u003e\n        \u003cdiv style=\"font-size: 0.78rem; color: var(--text-muted, #94a3b8); margin-bottom: 8px;\"\u003eNeed a License Key?\u003c/div\u003e\n        \u003ca href=\"https://discord.gg/mWdS7Hswuw\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px; background: rgba(88, 101, 242, 0.15); border: 1px solid rgba(88, 101, 242, 0.4); border-radius: 10px; color: #818cf8; font-weight: 600; text-decoration: none; font-size: 0.88rem;\"\u003e\n          \u003ci class=\"fa-brands fa-discord\"\u003e\u003c/i\u003e Get Key on Discord\n        \u003c/a\u003e\n      \u003c/div\u003e\n\n      \u003cdiv id=\"login-error-msg\" style=\"display: none; margin-top: 16px; padding: 12px; border-radius: 10px; background: rgba(239, 68, 68, 0.18); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5; font-size: 0.84rem; line-height: 1.4; text-align: left;\"\u003e\u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- Toast Notification Container --\u003e\n  \u003cdiv class=\"toast-container\" id=\"toast-container\"\u003e\u003c/div\u003e\n\n  \u003cscript src=\"/js/hwid.js?v=4.2\"\u003e\u003c/script\u003e\n  \u003cscript src=\"/js/app.js?v=4.4\"\u003e\u003c/script\u003e\n  \u003cscript src=\"/js/customAudio.js?v=4.2\"\u003e\u003c/script\u003e\n\u003c/body\u003e\n\u003c/html\u003e\n","login.html":"\u003c!DOCTYPE html\u003e\n\u003chtml lang=\"en\"\u003e\n\u003chead\u003e\n  \u003cmeta charset=\"UTF-8\"\u003e\n  \u003cmeta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\"\u003e\n  \u003ctitle\u003eEXC - Selfbot Dashboard Login\u003c/title\u003e\n  \u003clink rel=\"icon\" type=\"image/jpeg\" href=\"/assets/logo.jpg\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.googleapis.com\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin\u003e\n  \u003clink href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800\u0026family=JetBrains+Mono:wght@400;500;600\u0026family=Orbitron:wght@600;800;900\u0026display=swap\" rel=\"stylesheet\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"/css/style.css?v=6.0\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"/css/theme-assets.css?v=2.0\"\u003e\n  \u003cscript src=\"/js/assets-fallback.js\"\u003e\u003c/script\u003e\n  \u003cstyle\u003e\n    /* =========================================================\n       ULTRA-PREMIUM AMOLED FROSTED GLASS SLIDE LOGIN UI\n       ========================================================= */\n    * {\n      box-sizing: border-box;\n      margin: 0;\n      padding: 0;\n    }\n\n    body, body.login-page {\n      background: #000000 url(\u0027/assets/background.jpg\u0027) no-repeat center center fixed !important;\n      background-size: cover !important;\n      color: #ffffff !important;\n      min-height: 100vh !important;\n      width: 100% !important;\n      display: flex !important;\n      align-items: center !important;\n      justify-content: center !important;\n      padding: 24px 16px !important;\n      position: relative !important;\n      overflow-x: hidden;\n      font-family: \u0027Plus Jakarta Sans\u0027, -apple-system, BlinkMacSystemFont, sans-serif;\n      margin: 0 !important;\n    }\n\n    /* Ambient animated neon glows */\n    .ambient-glow {\n      position: fixed;\n      border-radius: 50%;\n      filter: blur(140px);\n      pointer-events: none;\n      z-index: 0;\n    }\n\n    .glow-orb-1 {\n      width: 480px;\n      height: 480px;\n      background: radial-gradient(circle, rgba(168, 85, 247, 0.45) 0%, transparent 70%);\n      top: -120px;\n      left: 15%;\n      animation: floatOrb 12s ease-in-out infinite alternate;\n    }\n\n    .glow-orb-2 {\n      width: 520px;\n      height: 520px;\n      background: radial-gradient(circle, rgba(59, 130, 246, 0.35) 0%, transparent 70%);\n      bottom: -140px;\n      right: 10%;\n      animation: floatOrb 14s ease-in-out infinite alternate-reverse;\n    }\n\n    .glow-orb-3 {\n      width: 320px;\n      height: 320px;\n      background: radial-gradient(circle, rgba(236, 72, 153, 0.25) 0%, transparent 70%);\n      top: 45%;\n      left: 50%;\n      transform: translate(-50%, -50%);\n      animation: pulseOrb 8s ease-in-out infinite;\n    }\n\n    @keyframes floatOrb {\n      0% { transform: translateY(0px) scale(1); }\n      100% { transform: translateY(40px) scale(1.1); }\n    }\n\n    @keyframes pulseOrb {\n      0%, 100% { opacity: 0.2; transform: translate(-50%, -50%) scale(0.9); }\n      50% { opacity: 0.38; transform: translate(-50%, -50%) scale(1.15); }\n    }\n\n    /* Subtle futuristic grid overlay */\n    .cyber-grid {\n      position: fixed;\n      inset: 0;\n      background-image: \n        linear-gradient(to right, rgba(255, 255, 255, 0.02) 1px, transparent 1px),\n        linear-gradient(to bottom, rgba(255, 255, 255, 0.02) 1px, transparent 1px);\n      background-size: 36px 36px;\n      pointer-events: none;\n      z-index: 1;\n    }\n\n    /* Glass Slide Container - Centered Vertically \u0026 Horizontally */\n    .login-container {\n      width: 100%;\n      max-width: 440px;\n      margin: auto !important;\n      position: relative;\n      z-index: 10;\n    }\n\n    /* Frosted Glass Slide Card */\n    .login-box {\n      position: relative;\n      background: rgba(10, 10, 14, 0.72) !important;\n      backdrop-filter: blur(36px) saturate(190%) contrast(110%);\n      -webkit-backdrop-filter: blur(36px) saturate(190%) contrast(110%);\n      border: 1px solid rgba(255, 255, 255, 0.12) !important;\n      border-radius: 28px;\n      padding: 42px 32px;\n      box-shadow: \n        0 30px 80px rgba(0, 0, 0, 0.95),\n        0 0 50px rgba(168, 85, 247, 0.18),\n        inset 0 1px 1px rgba(255, 255, 255, 0.25);\n      text-align: center;\n      animation: glassSlideUp 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;\n      overflow: hidden;\n    }\n\n    /* Glass slide-up entrance animation */\n    @keyframes glassSlideUp {\n      0% {\n        opacity: 0;\n        transform: translateY(50px) scale(0.95);\n        filter: blur(12px);\n      }\n      100% {\n        opacity: 1;\n        transform: translateY(0) scale(1);\n        filter: blur(0px);\n      }\n    }\n\n    /* Animated gradient border reflection */\n    .login-box::before {\n      content: \u0027\u0027;\n      position: absolute;\n      top: 0;\n      left: -100%;\n      width: 200%;\n      height: 2px;\n      background: linear-gradient(90deg, transparent, rgba(168, 85, 247, 0.8), rgba(255, 255, 255, 0.9), rgba(99, 102, 241, 0.8), transparent);\n      animation: glassLightSweep 4s ease-in-out infinite;\n    }\n\n    @keyframes glassLightSweep {\n      0% { transform: translateX(0%); }\n      100% { transform: translateX(100%); }\n    }\n\n    /* Floating Glowing Logo */\n    .logo-wrapper {\n      position: relative;\n      display: inline-block;\n      margin-bottom: 18px;\n    }\n\n    .login-logo {\n      width: 84px;\n      height: 84px;\n      border-radius: 50% !important;\n      object-fit: cover !important;\n      aspect-ratio: 1 / 1 !important;\n      display: block;\n      border: 2.5px solid rgba(168, 85, 247, 0.85) !important;\n      box-shadow: 0 0 35px rgba(168, 85, 247, 0.65) !important;\n      animation: floatLogo 6s ease-in-out infinite alternate;\n    }\n\n    @keyframes floatLogo {\n      0% {\n        transform: translateY(0px);\n        box-shadow: 0 0 30px rgba(168, 85, 247, 0.55);\n      }\n      100% {\n        transform: translateY(-8px);\n        box-shadow: 0 14px 45px rgba(168, 85, 247, 0.85);\n      }\n    }\n\n    .status-dot-active {\n      position: absolute;\n      bottom: -3px;\n      right: -3px;\n      width: 18px;\n      height: 18px;\n      border-radius: 50%;\n      background: #22c55e;\n      border: 3px solid #09090c;\n      box-shadow: 0 0 12px #22c55e;\n    }\n\n    /* Typography */\n    .brand-title {\n      font-family: \u0027Orbitron\u0027, \u0027Plus Jakarta Sans\u0027, sans-serif;\n      font-size: 1.85rem;\n      font-weight: 900;\n      letter-spacing: 2.5px;\n      background: linear-gradient(180deg, #ffffff 40%, #c084fc 100%);\n      -webkit-background-clip: text;\n      -webkit-text-fill-color: transparent;\n      margin-bottom: 6px;\n    }\n\n    .brand-subtitle {\n      font-size: 0.84rem;\n      color: #94a3b8;\n      margin-bottom: 22px;\n      line-height: 1.4;\n    }\n\n    /* Hardware ID Badge */\n    .hwid-chip {\n      font-family: \u0027JetBrains Mono\u0027, monospace;\n      font-size: 0.76rem;\n      background: rgba(168, 85, 247, 0.08);\n      border: 1px solid rgba(168, 85, 247, 0.28);\n      padding: 7px 16px;\n      border-radius: 30px;\n      display: inline-flex;\n      align-items: center;\n      gap: 8px;\n      color: #e9d5ff;\n      margin-bottom: 22px;\n      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1);\n      transition: all 0.2s ease;\n    }\n\n    .hwid-chip i {\n      color: #c084fc;\n      animation: pulseChip 2s infinite ease-in-out;\n    }\n\n    @keyframes pulseChip {\n      0%, 100% { opacity: 0.8; transform: scale(1); }\n      50% { opacity: 1; transform: scale(1.15); filter: drop-shadow(0 0 6px #c084fc); }\n    }\n\n    /* Already Logged In Session Card */\n    .already-logged-card {\n      background: rgba(34, 197, 94, 0.08) !important;\n      border: 1px solid rgba(34, 197, 94, 0.35) !important;\n      backdrop-filter: blur(20px);\n      -webkit-backdrop-filter: blur(20px);\n      border-radius: 18px;\n      padding: 18px;\n      margin-bottom: 22px;\n      text-align: left;\n      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);\n      animation: glassSlideUp 0.5s ease-out both;\n    }\n\n    /* Form Fields \u0026 Glass Inputs */\n    .form-group {\n      text-align: left;\n      margin-bottom: 18px;\n    }\n\n    .form-group label {\n      display: block;\n      font-size: 0.82rem;\n      font-weight: 600;\n      color: #cbd5e1;\n      margin-bottom: 8px;\n      letter-spacing: 0.2px;\n    }\n\n    .token-input-wrapper {\n      position: relative;\n    }\n\n    .glass-input {\n      width: 100%;\n      background: rgba(255, 255, 255, 0.04) !important;\n      border: 1px solid rgba(255, 255, 255, 0.12) !important;\n      border-radius: 14px !important;\n      padding: 14px 16px !important;\n      color: #ffffff !important;\n      font-size: 0.95rem;\n      font-family: inherit;\n      outline: none;\n      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5);\n    }\n\n    .glass-input::placeholder {\n      color: #64748b;\n    }\n\n    .glass-input:focus {\n      background: rgba(255, 255, 255, 0.07) !important;\n      border-color: #a855f7 !important;\n      box-shadow: 0 0 25px rgba(168, 85, 247, 0.35), inset 0 1px 2px rgba(255, 255, 255, 0.15) !important;\n      transform: translateY(-2px);\n    }\n\n    .btn-toggle-eye {\n      position: absolute;\n      right: 14px;\n      top: 50%;\n      transform: translateY(-50%);\n      background: none;\n      border: none;\n      color: #94a3b8;\n      cursor: pointer;\n      font-size: 1rem;\n      padding: 6px;\n      transition: all 0.2s ease;\n    }\n\n    .btn-toggle-eye:hover {\n      color: #ffffff;\n      transform: translateY(-50%) scale(1.1);\n    }\n\n    /* Error Alert */\n    .alert-error {\n      background: rgba(239, 68, 68, 0.15);\n      border: 1px solid rgba(239, 68, 68, 0.4);\n      color: #fca5a5;\n      padding: 12px 14px;\n      border-radius: 12px;\n      font-size: 0.82rem;\n      margin-bottom: 18px;\n      text-align: left;\n      line-height: 1.4;\n      animation: shakeErr 0.3s ease-in-out;\n    }\n\n    @keyframes shakeErr {\n      0%, 100% { transform: translateX(0); }\n      20%, 60% { transform: translateX(-6px); }\n      40%, 80% { transform: translateX(6px); }\n    }\n\n    /* Premium Shimmer Login Button */\n    .btn-glass-primary {\n      width: 100%;\n      background: linear-gradient(135deg, #9333ea, #7c3aed, #4f46e5);\n      border: 1px solid rgba(255, 255, 255, 0.25);\n      border-radius: 14px;\n      padding: 14px 20px;\n      font-weight: 800;\n      font-size: 0.96rem;\n      letter-spacing: 0.6px;\n      color: #ffffff;\n      cursor: pointer;\n      box-shadow: 0 10px 30px rgba(147, 51, 234, 0.45);\n      overflow: hidden;\n      position: relative;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      gap: 10px;\n      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n    }\n\n    .btn-glass-primary::after {\n      content: \u0027\u0027;\n      position: absolute;\n      top: -50%;\n      left: -60%;\n      width: 40%;\n      height: 200%;\n      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);\n      transform: rotate(25deg);\n      transition: none;\n    }\n\n    .btn-glass-primary:hover {\n      transform: translateY(-2px);\n      box-shadow: 0 14px 40px rgba(147, 51, 234, 0.65);\n      border-color: rgba(255, 255, 255, 0.45);\n    }\n\n    .btn-glass-primary:hover::after {\n      left: 120%;\n      transition: left 0.8s ease-in-out;\n    }\n\n    /* Discord Buy Access Section */\n    .buy-section {\n      margin-top: 22px;\n      padding-top: 18px;\n      border-top: 1px solid rgba(255, 255, 255, 0.08);\n      text-align: center;\n    }\n\n    .divider-text {\n      font-size: 0.74rem;\n      font-weight: 700;\n      color: #94a3b8;\n      margin-bottom: 12px;\n      text-transform: uppercase;\n      letter-spacing: 1.2px;\n    }\n\n    .btn-discord-buy {\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      gap: 10px;\n      width: 100%;\n      background: linear-gradient(135deg, rgba(88, 101, 242, 0.22) 0%, rgba(147, 51, 234, 0.22) 100%);\n      border: 1px solid rgba(88, 101, 242, 0.5);\n      border-radius: 14px;\n      padding: 13px 20px;\n      color: #ffffff !important;\n      font-weight: 700;\n      font-size: 0.92rem;\n      text-decoration: none;\n      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n      box-shadow: 0 6px 22px rgba(88, 101, 242, 0.25);\n      cursor: pointer;\n    }\n\n    .btn-discord-buy i {\n      font-size: 1.2rem;\n      color: #818cf8;\n      transition: transform 0.25s ease;\n    }\n\n    .btn-discord-buy:hover {\n      background: linear-gradient(135deg, #5865f2 0%, #7c3aed 100%);\n      border-color: rgba(255, 255, 255, 0.45);\n      transform: translateY(-2px);\n      box-shadow: 0 12px 35px rgba(88, 101, 242, 0.6);\n      color: #ffffff !important;\n    }\n\n    .btn-discord-buy:hover i {\n      color: #ffffff;\n      transform: scale(1.15) rotate(-5deg);\n    }\n\n    .buy-subtext {\n      font-size: 0.75rem;\n      color: #64748b;\n      margin-top: 10px;\n      line-height: 1.35;\n    }\n\n    .btn-glass-primary:active {\n      transform: scale(0.97);\n    }\n  \u003c/style\u003e\n\u003c/head\u003e\n\u003cbody class=\"dark-theme login-page\"\u003e\n  \u003c!-- Dynamic Ambient Glowing Orbs --\u003e\n  \u003cdiv class=\"ambient-glow glow-orb-1\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"ambient-glow glow-orb-2\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"ambient-glow glow-orb-3\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"cyber-grid\"\u003e\u003c/div\u003e\n\n  \u003cdiv class=\"login-container\"\u003e\n    \u003cdiv class=\"login-box\"\u003e\n      \u003c!-- Animated Brand Logo --\u003e\n      \u003cdiv class=\"logo-wrapper\"\u003e\n        \u003cimg src=\"/assets/logo.jpg\" alt=\"EXC Logo\" class=\"login-logo\"\u003e\n        \u003cdiv class=\"status-dot-active\" title=\"System Online\"\u003e\u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003ch1 class=\"brand-title\"\u003eEXC SELFBOT\u003c/h1\u003e\n      \u003cp class=\"brand-subtitle\"\u003eEnter your KeyAuth license key to access your selfbots\u003c/p\u003e\n\n\n\n      \u003c!-- Active Session Card (shown if already logged in) --\u003e\n      \u003cdiv id=\"already-logged-box\" class=\"already-logged-card\" style=\"display: none;\"\u003e\n        \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;\"\u003e\n          \u003cspan style=\"font-weight: 700; color: #4ade80;\"\u003e\u003ci class=\"fa-solid fa-circle-check\"\u003e\u003c/i\u003e Already Logged In\u003c/span\u003e\n          \u003cspan class=\"badge badge-primary\" id=\"logged-quota-badge\" style=\"font-size: 0.72rem; padding: 4px 8px; border-radius: 8px;\"\u003e10 Bots Limit\u003c/span\u003e\n        \u003c/div\u003e\n        \u003cdiv style=\"font-size: 0.88rem; color: #fff; margin-bottom: 4px;\"\u003e\n          User: \u003cstrong id=\"logged-username\" style=\"color: #c084fc;\"\u003e-\u003c/strong\u003e\n        \u003c/div\u003e\n        \u003cdiv style=\"font-size: 0.78rem; color: #94a3b8; margin-bottom: 14px;\"\u003e\n          Your credentials and bot quota are active on this device.\n        \u003c/div\u003e\n        \u003cdiv style=\"display: flex; gap: 8px;\"\u003e\n          \u003ca href=\"/dashboard\" class=\"btn btn-primary btn-block\" style=\"text-decoration: none; text-align: center; padding: 10px; border-radius: 10px; font-weight: 700;\"\u003e\n            \u003ci class=\"fa-solid fa-gauge-high\"\u003e\u003c/i\u003e Go to Dashboard\n          \u003c/a\u003e\n          \u003cbutton type=\"button\" class=\"btn btn-outline btn-danger-outline\" onclick=\"logoutHere()\" title=\"Switch Account\" style=\"border-radius: 10px; padding: 0 14px;\"\u003e\n            \u003ci class=\"fa-solid fa-power-off\"\u003e\u003c/i\u003e\n          \u003c/button\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003c!-- KeyAuth License Login Form --\u003e\n      \u003cform id=\"form-login\" onsubmit=\"submitLogin(event)\"\u003e\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003e\u003ci class=\"fa-solid fa-key\" style=\"color: #a855f7;\"\u003e\u003c/i\u003e KeyAuth License Key\u003c/label\u003e\n          \u003cdiv class=\"token-input-wrapper\"\u003e\n            \u003cinput type=\"text\" id=\"input-license-key\" class=\"glass-input\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" required autofocus autocomplete=\"off\" style=\"letter-spacing: 1.5px; font-family: \u0027JetBrains Mono\u0027, monospace; font-weight: 600; text-align: center; text-transform: uppercase;\"\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv id=\"login-error\" class=\"alert-error\" style=\"display: none;\"\u003e\u003c/div\u003e\n\n        \u003cbutton type=\"submit\" class=\"btn-glass-primary\" id=\"btn-login-submit\"\u003e\n          \u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e Activate Key \u0026 Access Dashboard\n        \u003c/button\u003e\n      \u003c/form\u003e\n\n      \u003cdiv class=\"buy-section\"\u003e\n        \u003cdiv class=\"divider-text\"\u003eNeed a License Key?\u003c/div\u003e\n        \u003ca href=\"https://discord.gg/mWdS7Hswuw\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"btn-discord-buy\"\u003e\n          \u003ci class=\"fa-brands fa-discord\"\u003e\u003c/i\u003e Get Key on Discord\n        \u003c/a\u003e\n        \u003cp class=\"buy-subtext\"\u003ePurchase or renew your KeyAuth license key in our official Discord server.\u003c/p\u003e\n        \u003cdiv style=\"margin-top: 18px; text-align: center;\"\u003e\n          \u003ca href=\"/admin\" style=\"font-size: 0.76rem; color: #64748b; text-decoration: none; transition: color 0.2s;\" onmouseover=\"this.style.color=\u0027#c084fc\u0027\" onmouseout=\"this.style.color=\u0027#64748b\u0027\"\u003e\n            \u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e EXC Admin \u0026 KeyAuth System\n          \u003c/a\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003cscript src=\"/js/hwid.js?v=5.0\"\u003e\u003c/script\u003e\n  \u003cscript\u003e\n    let deviceHwid = null;\n    let deviceInfo = null;\n\n    window.addEventListener(\u0027DOMContentLoaded\u0027, async () =\u003e {\n      const urlParams = new URLSearchParams(window.location.search);\n      if (urlParams.get(\u0027logout\u0027) === \u00271\u0027) {\n        localStorage.removeItem(\u0027exc_user_token\u0027);\n      }\n\n      // 1. Calculate HWID with bulletproof HTTP/HTTPS fallback\n      try {\n        if (typeof window.getDeviceHwid === \u0027function\u0027) {\n          deviceHwid = await window.getDeviceHwid();\n        }\n      } catch (e) {}\n      if (!deviceHwid || deviceHwid.length \u003c 20) {\n        let stored = localStorage.getItem(\u0027exc_hwid_fallback\u0027);\n        if (!stored) {\n          stored = \u0027HWID-\u0027 + Array.from({length: 32}, () =\u003e Math.floor(Math.random() * 16).toString(16)).join(\u0027\u0027).toUpperCase();\n          try { localStorage.setItem(\u0027exc_hwid_fallback\u0027, stored); } catch(e){}\n        }\n        deviceHwid = stored;\n      }\n      try { deviceInfo = typeof window.getDeviceInfo === \u0027function\u0027 ? window.getDeviceInfo() : {}; } catch(e){ deviceInfo = {}; }\n\n      // 2. Check if already logged in (only if not explicit logout)\n      if (urlParams.get(\u0027logout\u0027) !== \u00271\u0027) {\n        const existingToken = localStorage.getItem(\u0027exc_user_token\u0027);\n        if (existingToken) {\n          checkExistingAuth(existingToken);\n        }\n      }\n    });\n\n    async function checkExistingAuth(token) {\n      try {\n        const res = await fetch(\u0027/api/auth/me/\u0027, {\n          headers: { \u0027Authorization\u0027: `Bearer ${token}` }\n        });\n        const data = await res.json();\n        if (data.success \u0026\u0026 data.user) {\n          document.getElementById(\u0027already-logged-box\u0027).style.display = \u0027block\u0027;\n          document.getElementById(\u0027logged-username\u0027).textContent = data.user.username;\n          const limit = data.user.botLimit || 10;\n          document.getElementById(\u0027logged-quota-badge\u0027).textContent = `${limit} Bots Limit`;\n        }\n      } catch (e) {}\n    }\n\n    // Password visibility toggle removed - KeyAuth Key system active\n\n    async function submitLogin(e) {\n      e.preventDefault();\n      const keyInput = document.getElementById(\u0027input-license-key\u0027);\n      const licenseKey = keyInput ? keyInput.value.trim().toUpperCase() : \u0027\u0027;\n      const btn = document.getElementById(\u0027btn-login-submit\u0027);\n      const errBox = document.getElementById(\u0027login-error\u0027);\n\n      errBox.style.display = \u0027none\u0027;\n      btn.disabled = true;\n      btn.innerHTML = \u0027\u003ci class=\"fa-solid fa-spinner fa-spin\"\u003e\u003c/i\u003e Validating Key...\u0027;\n\n      try {\n        if (!deviceHwid || deviceHwid.length \u003c 20) {\n          try {\n            if (typeof window.getDeviceHwid === \u0027function\u0027) {\n              deviceHwid = await window.getDeviceHwid();\n            }\n          } catch(e) {}\n          if (!deviceHwid || deviceHwid.length \u003c 20) {\n            let stored = localStorage.getItem(\u0027exc_hwid_fallback\u0027);\n            if (!stored) {\n              stored = \u0027HWID-\u0027 + Array.from({length: 32}, () =\u003e Math.floor(Math.random() * 16).toString(16)).join(\u0027\u0027).toUpperCase();\n              try { localStorage.setItem(\u0027exc_hwid_fallback\u0027, stored); } catch(e){}\n            }\n            deviceHwid = stored;\n          }\n          try { deviceInfo = typeof window.getDeviceInfo === \u0027function\u0027 ? window.getDeviceInfo() : {}; } catch(e){ deviceInfo = {}; }\n        }\n\n        const res = await fetch(\u0027/api/auth/login/\u0027, {\n          method: \u0027POST\u0027,\n          headers: { \u0027Content-Type\u0027: \u0027application/json\u0027 },\n          body: JSON.stringify({\n            key: licenseKey,\n            hwid: deviceHwid,\n            deviceInfo\n          })\n        });\n\n        const data = await res.json();\n        if (data.success \u0026\u0026 data.token) {\n          localStorage.setItem(\u0027exc_user_token\u0027, data.token);\n          window.location.href = \u0027/dashboard\u0027;\n        } else {\n          errBox.textContent = data.error || \u0027Invalid or expired KeyAuth license key.\u0027;\n          errBox.style.display = \u0027block\u0027;\n        }\n      } catch (err) {\n        errBox.textContent = \u0027Connection error: \u0027 + err.message;\n        errBox.style.display = \u0027block\u0027;\n      } finally {\n        btn.disabled = false;\n        btn.innerHTML = \u0027\u003ci class=\"fa-solid fa-shield-halved\"\u003e\u003c/i\u003e Activate Key \u0026 Access Dashboard\u0027;\n      }\n    }\n\n    function logoutHere() {\n      const token = localStorage.getItem(\u0027exc_user_token\u0027);\n      if (token) {\n        fetch(\u0027/api/auth/logout/\u0027, {\n          method: \u0027POST\u0027,\n          headers: { \u0027Authorization\u0027: `Bearer ${token}` }\n        }).catch(() =\u003e {});\n      }\n      localStorage.removeItem(\u0027exc_user_token\u0027);\n      document.getElementById(\u0027already-logged-box\u0027).style.display = \u0027none\u0027;\n      const keyInput = document.getElementById(\u0027input-license-key\u0027);\n      if (keyInput) keyInput.value = \u0027\u0027;\n    }\n  \u003c/script\u003e\n\u003c/body\u003e\n\u003c/html\u003e\n","admin.html":"\u003c!DOCTYPE html\u003e\n\u003chtml lang=\"en\"\u003e\n\u003chead\u003e\n  \u003cmeta charset=\"UTF-8\"\u003e\n  \u003cmeta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"\u003e\n  \u003ctitle\u003eEXC - KeyAuth Licensing System \u0026 Admin Portal\u003c/title\u003e\n  \u003clink rel=\"icon\" type=\"image/jpeg\" href=\"/assets/logo.jpg\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.googleapis.com\"\u003e\n  \u003clink rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin\u003e\n  \u003clink href=\"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800\u0026family=JetBrains+Mono:wght@400;500;600\u0026family=Orbitron:wght@700;900\u0026display=swap\" rel=\"stylesheet\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css\"\u003e\n  \u003clink rel=\"stylesheet\" href=\"/css/theme-assets.css?v=2.0\"\u003e\n  \u003cscript src=\"/js/assets-fallback.js\"\u003e\u003c/script\u003e\n  \u003clink rel=\"stylesheet\" href=\"/css/style.css?v=6.0\"\u003e\n  \u003cstyle\u003e\n    body {\n      background-color: #000000 !important;\n      color: #ffffff !important;\n      font-family: \u0027Plus Jakarta Sans\u0027, sans-serif;\n      margin: 0;\n      padding: 0;\n      overflow-x: hidden;\n      min-height: 100vh;\n    }\n\n    /* Fixed 4K Background */\n    .admin-bg-layer {\n      position: fixed;\n      inset: 0;\n      width: 100vw;\n      height: 100vh;\n      background: #000 url(\u0027/assets/background.jpg\u0027) no-repeat center center fixed;\n      background-size: cover;\n      z-index: 0;\n      pointer-events: none;\n    }\n\n    .admin-overlay-dim {\n      position: fixed;\n      inset: 0;\n      background: rgba(8, 8, 12, 0.78);\n      backdrop-filter: blur(8px);\n      z-index: 1;\n      pointer-events: none;\n    }\n\n    /* Admin Container */\n    .admin-wrapper {\n      position: relative;\n      z-index: 10;\n      max-width: 1300px;\n      margin: 0 auto;\n      padding: 24px 20px 80px 20px;\n    }\n\n    /* Top Navigation Banner */\n    .admin-navbar {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      padding: 16px 24px;\n      background: rgba(15, 15, 22, 0.75);\n      border: 1px solid rgba(168, 85, 247, 0.25);\n      border-radius: 20px;\n      backdrop-filter: blur(25px);\n      margin-bottom: 24px;\n      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);\n    }\n\n    .admin-brand {\n      display: flex;\n      align-items: center;\n      gap: 14px;\n    }\n\n    .admin-brand-logo {\n      width: 46px;\n      height: 46px;\n      border-radius: 50% !important;\n      object-fit: cover !important;\n      aspect-ratio: 1 / 1 !important;\n      border: 2px solid #a855f7;\n      box-shadow: 0 0 18px rgba(168, 85, 247, 0.6);\n    }\n\n    .admin-brand-title {\n      font-family: \u0027Orbitron\u0027, sans-serif;\n      font-size: 1.35rem;\n      font-weight: 900;\n      letter-spacing: 1.5px;\n      background: linear-gradient(180deg, #ffffff 40%, #c084fc 100%);\n      -webkit-background-clip: text;\n      -webkit-text-fill-color: transparent;\n      display: flex;\n      align-items: center;\n      gap: 10px;\n    }\n\n    .keyauth-pill {\n      font-family: \u0027JetBrains Mono\u0027, monospace;\n      font-size: 0.7rem;\n      font-weight: 700;\n      padding: 3px 8px;\n      border-radius: 8px;\n      background: rgba(168, 85, 247, 0.2);\n      border: 1px solid rgba(168, 85, 247, 0.5);\n      color: #c084fc;\n      -webkit-text-fill-color: #c084fc;\n    }\n\n    /* Top Stats Grid */\n    .stats-row {\n      display: grid;\n      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));\n      gap: 16px;\n      margin-bottom: 24px;\n    }\n\n    .stat-card-box {\n      background: rgba(15, 15, 24, 0.72);\n      border: 1px solid rgba(255, 255, 255, 0.08);\n      border-radius: 18px;\n      padding: 20px 22px;\n      backdrop-filter: blur(20px);\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      transition: transform 0.2s ease, border-color 0.2s ease;\n    }\n\n    .stat-card-box:hover {\n      transform: translateY(-3px);\n      border-color: rgba(168, 85, 247, 0.4);\n    }\n\n    .stat-card-info h4 {\n      font-size: 0.8rem;\n      text-transform: uppercase;\n      letter-spacing: 1px;\n      color: #94a3b8;\n      margin-bottom: 6px;\n      font-weight: 600;\n    }\n\n    .stat-card-info .stat-num {\n      font-size: 1.75rem;\n      font-weight: 800;\n      color: #ffffff;\n      font-family: \u0027JetBrains Mono\u0027, monospace;\n    }\n\n    .stat-icon-wrapper {\n      width: 50px;\n      height: 50px;\n      border-radius: 14px;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-size: 1.4rem;\n    }\n\n    .icon-purple { background: rgba(168, 85, 247, 0.18); color: #c084fc; }\n    .icon-blue { background: rgba(59, 130, 246, 0.18); color: #60a5fa; }\n    .icon-green { background: rgba(34, 197, 94, 0.18); color: #4ade80; }\n    .icon-yellow { background: rgba(234, 179, 8, 0.18); color: #facc15; }\n\n    /* Action \u0026 Search Bar */\n    .controls-bar {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 16px;\n      margin-bottom: 20px;\n      flex-wrap: wrap;\n    }\n\n    .search-box {\n      flex: 1;\n      max-width: 450px;\n      position: relative;\n    }\n\n    .search-box input {\n      width: 100%;\n      background: rgba(255, 255, 255, 0.05);\n      border: 1px solid rgba(255, 255, 255, 0.12);\n      border-radius: 12px;\n      padding: 12px 16px 12px 42px;\n      color: #ffffff;\n      font-size: 0.9rem;\n      outline: none;\n      transition: all 0.2s ease;\n    }\n\n    .search-box input:focus {\n      border-color: #a855f7;\n      box-shadow: 0 0 15px rgba(168, 85, 247, 0.3);\n      background: rgba(255, 255, 255, 0.08);\n    }\n\n    .search-box i {\n      position: absolute;\n      left: 16px;\n      top: 50%;\n      transform: translateY(-50%);\n      color: #64748b;\n    }\n\n    /* Tab Switcher */\n    .tab-pills {\n      display: flex;\n      gap: 8px;\n      background: rgba(255, 255, 255, 0.04);\n      padding: 6px;\n      border-radius: 14px;\n      border: 1px solid rgba(255, 255, 255, 0.08);\n    }\n\n    .tab-pill {\n      background: none;\n      border: none;\n      padding: 8px 18px;\n      border-radius: 10px;\n      color: #94a3b8;\n      font-weight: 700;\n      font-size: 0.88rem;\n      cursor: pointer;\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      transition: all 0.2s ease;\n    }\n\n    .tab-pill.active {\n      background: linear-gradient(135deg, #9333ea, #7c3aed);\n      color: #ffffff;\n      box-shadow: 0 4px 15px rgba(147, 51, 234, 0.4);\n    }\n\n    /* Primary Action Buttons */\n    .btn-create-key {\n      background: linear-gradient(135deg, #9333ea, #7c3aed);\n      color: #ffffff;\n      border: 1px solid rgba(255, 255, 255, 0.2);\n      padding: 12px 22px;\n      border-radius: 12px;\n      font-weight: 800;\n      font-size: 0.92rem;\n      cursor: pointer;\n      display: flex;\n      align-items: center;\n      gap: 10px;\n      box-shadow: 0 6px 20px rgba(147, 51, 234, 0.45);\n      transition: all 0.2s ease;\n    }\n\n    .btn-create-key:hover {\n      transform: translateY(-2px);\n      box-shadow: 0 8px 25px rgba(147, 51, 234, 0.65);\n    }\n\n    /* Modern Data Table */\n    .table-container {\n      background: rgba(14, 14, 22, 0.85);\n      border: 1px solid rgba(255, 255, 255, 0.1);\n      border-radius: 20px;\n      overflow: hidden;\n      backdrop-filter: blur(25px);\n      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);\n    }\n\n    table {\n      width: 100%;\n      border-collapse: collapse;\n      text-align: left;\n    }\n\n    thead {\n      background: rgba(255, 255, 255, 0.03);\n      border-bottom: 1px solid rgba(255, 255, 255, 0.08);\n    }\n\n    th {\n      padding: 16px 20px;\n      font-size: 0.78rem;\n      text-transform: uppercase;\n      letter-spacing: 1px;\n      color: #94a3b8;\n      font-weight: 700;\n    }\n\n    td {\n      padding: 16px 20px;\n      border-bottom: 1px solid rgba(255, 255, 255, 0.04);\n      font-size: 0.88rem;\n      vertical-align: middle;\n    }\n\n    tr:hover td {\n      background: rgba(255, 255, 255, 0.02);\n    }\n\n    .key-badge {\n      font-family: \u0027JetBrains Mono\u0027, monospace;\n      font-size: 0.85rem;\n      font-weight: 600;\n      color: #e2e8f0;\n      background: rgba(0, 0, 0, 0.4);\n      padding: 6px 12px;\n      border-radius: 8px;\n      border: 1px solid rgba(255, 255, 255, 0.1);\n      display: inline-flex;\n      align-items: center;\n      gap: 8px;\n    }\n\n    .btn-copy-sm {\n      background: none;\n      border: none;\n      color: #a855f7;\n      cursor: pointer;\n      font-size: 0.9rem;\n      padding: 4px;\n      transition: transform 0.15s ease, color 0.15s ease;\n    }\n\n    .btn-copy-sm:hover {\n      color: #c084fc;\n      transform: scale(1.2);\n    }\n\n    .status-pill {\n      font-size: 0.72rem;\n      font-weight: 800;\n      text-transform: uppercase;\n      padding: 4px 10px;\n      border-radius: 20px;\n      display: inline-flex;\n      align-items: center;\n      gap: 5px;\n    }\n\n    .status-active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4); }\n    .status-unused { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }\n    .status-banned { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }\n    .status-expired { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); }\n\n    .limit-badge {\n      font-family: \u0027JetBrains Mono\u0027, monospace;\n      font-weight: 700;\n      color: #fbbf24;\n      background: rgba(251, 191, 36, 0.12);\n      border: 1px solid rgba(251, 191, 36, 0.4);\n      padding: 4px 10px;\n      border-radius: 8px;\n      font-size: 0.8rem;\n    }\n\n    /* Action Buttons */\n    .action-btn-group {\n      display: flex;\n      gap: 8px;\n    }\n\n    .btn-action-icon {\n      width: 32px;\n      height: 32px;\n      border-radius: 8px;\n      border: 1px solid rgba(255, 255, 255, 0.1);\n      background: rgba(255, 255, 255, 0.04);\n      color: #cbd5e1;\n      cursor: pointer;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-size: 0.82rem;\n      transition: all 0.2s ease;\n    }\n\n    .btn-action-icon:hover {\n      background: rgba(255, 255, 255, 0.12);\n      color: #ffffff;\n      transform: translateY(-2px);\n    }\n\n    .btn-action-icon.hwid:hover { color: #38bdf8; border-color: #38bdf8; }\n    .btn-action-icon.limit:hover { color: #fbbf24; border-color: #fbbf24; }\n    .btn-action-icon.ban:hover { color: #f87171; border-color: #f87171; }\n    .btn-action-icon.del:hover { color: #ef4444; border-color: #ef4444; }\n\n    /* Admin Password Overlay */\n    .admin-auth-overlay {\n      position: fixed;\n      inset: 0;\n      background: rgba(0, 0, 0, 0.88);\n      backdrop-filter: blur(25px);\n      z-index: 9999;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      padding: 20px;\n    }\n\n    .admin-login-card {\n      background: rgba(15, 15, 24, 0.95);\n      border: 1px solid rgba(168, 85, 247, 0.35);\n      border-radius: 24px;\n      padding: 40px 32px;\n      max-width: 420px;\n      width: 100%;\n      text-align: center;\n      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.9), 0 0 35px rgba(168, 85, 247, 0.2);\n    }\n\n    /* Modal Styles */\n    .modal-overlay {\n      position: fixed;\n      inset: 0;\n      background: rgba(0, 0, 0, 0.85);\n      backdrop-filter: blur(15px);\n      z-index: 1000;\n      display: none;\n      align-items: center;\n      justify-content: center;\n      padding: 20px;\n    }\n\n    .modal-box {\n      background: rgba(18, 18, 28, 0.95);\n      border: 1px solid rgba(168, 85, 247, 0.4);\n      border-radius: 20px;\n      padding: 30px;\n      max-width: 500px;\n      width: 100%;\n      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.9);\n    }\n\n    .form-group {\n      margin-bottom: 18px;\n      text-align: left;\n    }\n\n    .form-group label {\n      display: block;\n      font-size: 0.82rem;\n      font-weight: 700;\n      color: #94a3b8;\n      margin-bottom: 6px;\n      text-transform: uppercase;\n      letter-spacing: 0.5px;\n    }\n\n    .form-control {\n      width: 100%;\n      background: rgba(255, 255, 255, 0.05);\n      border: 1px solid rgba(255, 255, 255, 0.12);\n      border-radius: 10px;\n      padding: 12px 14px;\n      color: #fff;\n      font-family: inherit;\n      outline: none;\n      box-sizing: border-box;\n      transition: border-color 0.2s ease;\n    }\n\n    .form-control:focus {\n      border-color: #a855f7;\n    }\n\n    /* Toast Notification */\n    .toast-pill {\n      position: fixed;\n      bottom: 24px;\n      right: 24px;\n      background: #181824;\n      border: 1px solid #a855f7;\n      color: #fff;\n      padding: 14px 22px;\n      border-radius: 12px;\n      font-weight: 600;\n      font-size: 0.9rem;\n      z-index: 99999;\n      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);\n      display: none;\n      animation: slideUp 0.3s ease;\n    }\n\n    @keyframes slideUp {\n      from { transform: translateY(30px); opacity: 0; }\n      to { transform: translateY(0); opacity: 1; }\n    }\n  \u003c/style\u003e\n\u003c/head\u003e\n\u003cbody\u003e\n  \u003cdiv class=\"admin-bg-layer\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"admin-overlay-dim\"\u003e\u003c/div\u003e\n\n  \u003c!-- ADMIN AUTHENTICATION MODAL --\u003e\n  \u003cdiv id=\"admin-auth-overlay\" class=\"admin-auth-overlay\"\u003e\n    \u003cdiv class=\"admin-login-card\"\u003e\n      \u003cimg src=\"/assets/logo.jpg\" alt=\"Logo\" class=\"admin-brand-logo\" style=\"width: 72px; height: 72px; margin-bottom: 16px;\"\u003e\n      \u003ch2 style=\"font-family: \u0027Orbitron\u0027, sans-serif; font-size: 1.5rem; margin-bottom: 6px; color: #fff;\"\u003eEXC ADMIN PORTAL\u003c/h2\u003e\n      \u003cp style=\"font-size: 0.84rem; color: #94a3b8; margin-bottom: 24px;\"\u003eEnter Master Admin Password to manage KeyAuth licenses\u003c/p\u003e\n      \n      \u003cform onsubmit=\"handleAdminLogin(event)\"\u003e\n        \u003cdiv class=\"form-group\"\u003e\n          \u003cinput type=\"password\" id=\"input-admin-pass\" class=\"form-control\" placeholder=\"Enter Admin Password\" required autofocus style=\"text-align: center; letter-spacing: 2px;\"\u003e\n        \u003c/div\u003e\n        \u003cdiv id=\"admin-login-err\" style=\"color: #f87171; font-size: 0.82rem; margin-bottom: 16px; display: none;\"\u003e\u003c/div\u003e\n        \u003cbutton type=\"submit\" class=\"btn-create-key\" style=\"width: 100%; justify-content: center; padding: 14px;\"\u003e\n          \u003ci class=\"fa-solid fa-lock-open\"\u003e\u003c/i\u003e Unlock Admin Portal\n        \u003c/button\u003e\n      \u003c/form\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MAIN ADMIN DASHBOARD --\u003e\n  \u003cdiv class=\"admin-wrapper\" id=\"admin-main-panel\" style=\"display: none;\"\u003e\n    \u003c!-- Top Nav Banner --\u003e\n    \u003cdiv class=\"admin-navbar\"\u003e\n      \u003cdiv class=\"admin-brand\"\u003e\n        \u003cimg src=\"/assets/logo.jpg\" alt=\"Logo\" class=\"admin-brand-logo\"\u003e\n        \u003cdiv\u003e\n          \u003cdiv class=\"admin-brand-title\"\u003e\n            EXC LICENSING\n            \u003cspan class=\"keyauth-pill\"\u003e\u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e KEYAUTH SYSTEM\u003c/span\u003e\n          \u003c/div\u003e\n          \u003cdiv style=\"font-size: 0.75rem; color: #94a3b8; margin-top: 2px;\"\u003e\n            Self-Hosted KeyAuth License \u0026 Bot Quota Management System\n          \u003c/div\u003e\n        \u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv style=\"display: flex; gap: 10px; align-items: center;\"\u003e\n        \u003ca href=\"/dashboard\" class=\"btn-action-icon\" title=\"Go to Bot Dashboard\" style=\"width: auto; padding: 0 14px; gap: 6px; text-decoration: none;\"\u003e\n          \u003ci class=\"fa-solid fa-gauge\"\u003e\u003c/i\u003e Bot Dashboard\n        \u003c/a\u003e\n        \u003cbutton class=\"btn-action-icon del\" onclick=\"adminLogout()\" title=\"Logout Admin\"\u003e\n          \u003ci class=\"fa-solid fa-power-off\"\u003e\u003c/i\u003e\n        \u003c/button\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n\n    \u003c!-- Stats Row --\u003e\n    \u003cdiv class=\"stats-row\"\u003e\n      \u003cdiv class=\"stat-card-box\"\u003e\n        \u003cdiv class=\"stat-card-info\"\u003e\n          \u003ch4\u003eTotal Licenses\u003c/h4\u003e\n          \u003cdiv class=\"stat-num\" id=\"stat-total-keys\"\u003e0\u003c/div\u003e\n        \u003c/div\u003e\n        \u003cdiv class=\"stat-icon-wrapper icon-purple\"\u003e\u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e\u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"stat-card-box\"\u003e\n        \u003cdiv class=\"stat-card-info\"\u003e\n          \u003ch4\u003eActive Users\u003c/h4\u003e\n          \u003cdiv class=\"stat-num\" id=\"stat-active-users\"\u003e0\u003c/div\u003e\n        \u003c/div\u003e\n        \u003cdiv class=\"stat-icon-wrapper icon-blue\"\u003e\u003ci class=\"fa-solid fa-users\"\u003e\u003c/i\u003e\u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"stat-card-box\"\u003e\n        \u003cdiv class=\"stat-card-info\"\u003e\n          \u003ch4\u003eUnused Keys\u003c/h4\u003e\n          \u003cdiv class=\"stat-num\" id=\"stat-unused-keys\"\u003e0\u003c/div\u003e\n        \u003c/div\u003e\n        \u003cdiv class=\"stat-icon-wrapper icon-yellow\"\u003e\u003ci class=\"fa-solid fa-ticket\"\u003e\u003c/i\u003e\u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"stat-card-box\"\u003e\n        \u003cdiv class=\"stat-card-info\"\u003e\n          \u003ch4\u003eLive Selfbots\u003c/h4\u003e\n          \u003cdiv class=\"stat-num\" id=\"stat-online-bots\"\u003e0\u003c/div\u003e\n        \u003c/div\u003e\n        \u003cdiv class=\"stat-icon-wrapper icon-green\"\u003e\u003ci class=\"fa-solid fa-robot\"\u003e\u003c/i\u003e\u003c/div\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n\n    \u003c!-- Controls Bar --\u003e\n    \u003cdiv class=\"controls-bar\"\u003e\n      \u003cdiv class=\"tab-pills\"\u003e\n        \u003cbutton class=\"tab-pill active\" id=\"tab-btn-keys\" onclick=\"switchAdminTab(\u0027keys\u0027)\"\u003e\n          \u003ci class=\"fa-solid fa-key\"\u003e\u003c/i\u003e Licenses\n        \u003c/button\u003e\n        \u003cbutton class=\"tab-pill\" id=\"tab-btn-users\" onclick=\"switchAdminTab(\u0027users\u0027)\"\u003e\n          \u003ci class=\"fa-solid fa-users\"\u003e\u003c/i\u003e Customers / Users\n        \u003c/button\u003e\n      \u003c/div\u003e\n\n      \u003cdiv class=\"search-box\"\u003e\n        \u003ci class=\"fa-solid fa-magnifying-glass\"\u003e\u003c/i\u003e\n        \u003cinput type=\"text\" id=\"admin-search-input\" placeholder=\"Search license key, user, or HWID...\" oninput=\"filterTable()\"\u003e\n      \u003c/div\u003e\n\n      \u003cbutton class=\"btn-create-key\" onclick=\"openCreateKeyModal()\"\u003e\n        \u003ci class=\"fa-solid fa-plus\"\u003e\u003c/i\u003e Generate License Keys\n      \u003c/button\u003e\n    \u003c/div\u003e\n\n    \u003c!-- LICENSES TABLE --\u003e\n    \u003cdiv class=\"table-container\" id=\"panel-keys\"\u003e\n      \u003ctable\u003e\n        \u003cthead\u003e\n          \u003ctr\u003e\n            \u003cth\u003eLicense Key\u003c/th\u003e\n            \u003cth\u003eStatus\u003c/th\u003e\n            \u003cth\u003eBot Quota Limit\u003c/th\u003e\n            \u003cth\u003eDuration\u003c/th\u003e\n            \u003cth\u003eBound HWID\u003c/th\u003e\n            \u003cth\u003eNote\u003c/th\u003e\n            \u003cth style=\"text-align: right;\"\u003eActions\u003c/th\u003e\n          \u003c/tr\u003e\n        \u003c/thead\u003e\n        \u003ctbody id=\"tbody-licenses\"\u003e\n          \u003ctr\u003e\u003ctd colspan=\"7\" style=\"text-align: center; color: #64748b; padding: 40px;\"\u003eLoading licenses...\u003c/td\u003e\u003c/tr\u003e\n        \u003c/tbody\u003e\n      \u003c/table\u003e\n    \u003c/div\u003e\n\n    \u003c!-- USERS TABLE --\u003e\n    \u003cdiv class=\"table-container\" id=\"panel-users\" style=\"display: none;\"\u003e\n      \u003ctable\u003e\n        \u003cthead\u003e\n          \u003ctr\u003e\n            \u003cth\u003eUser / Key\u003c/th\u003e\n            \u003cth\u003eStatus\u003c/th\u003e\n            \u003cth\u003eBots In Use / Quota\u003c/th\u003e\n            \u003cth\u003eBound HWID\u003c/th\u003e\n            \u003cth\u003eDevice\u003c/th\u003e\n            \u003cth\u003eLast Active\u003c/th\u003e\n            \u003cth style=\"text-align: right;\"\u003eActions\u003c/th\u003e\n          \u003c/tr\u003e\n        \u003c/thead\u003e\n        \u003ctbody id=\"tbody-users\"\u003e\n          \u003ctr\u003e\u003ctd colspan=\"7\" style=\"text-align: center; color: #64748b; padding: 40px;\"\u003eLoading customers...\u003c/td\u003e\u003c/tr\u003e\n        \u003c/tbody\u003e\n      \u003c/table\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MODAL: GENERATE LICENSE KEYS --\u003e\n  \u003cdiv class=\"modal-overlay\" id=\"modal-create-key\"\u003e\n    \u003cdiv class=\"modal-box\"\u003e\n      \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;\"\u003e\n        \u003ch3 style=\"margin: 0; font-family: \u0027Orbitron\u0027, sans-serif; font-size: 1.15rem; color: #fff;\"\u003e\n          \u003ci class=\"fa-solid fa-key\" style=\"color: #a855f7;\"\u003e\u003c/i\u003e Generate License Keys\n        \u003c/h3\u003e\n        \u003cbutton onclick=\"closeModal(\u0027modal-create-key\u0027)\" style=\"background: none; border: none; color: #94a3b8; font-size: 1.2rem; cursor: pointer;\"\u003e\u0026times;\u003c/button\u003e\n      \u003c/div\u003e\n\n      \u003cform onsubmit=\"handleCreateLicenses(event)\"\u003e\n        \u003cdiv style=\"display: grid; grid-template-columns: 1fr 1fr; gap: 14px;\"\u003e\n          \u003cdiv class=\"form-group\"\u003e\n            \u003clabel\u003eAmount of Keys\u003c/label\u003e\n            \u003cinput type=\"number\" id=\"gen-amount\" class=\"form-control\" value=\"1\" min=\"1\" max=\"50\" required\u003e\n          \u003c/div\u003e\n          \u003cdiv class=\"form-group\"\u003e\n            \u003clabel\u003eBot Quota Limit\u003c/label\u003e\n            \u003cinput type=\"number\" id=\"gen-limit\" class=\"form-control\" value=\"10\" min=\"1\" max=\"1000\" placeholder=\"e.g. 10, 25, 50\" required\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv style=\"display: grid; grid-template-columns: 1fr 1fr; gap: 14px;\"\u003e\n          \u003cdiv class=\"form-group\"\u003e\n            \u003clabel\u003eDuration (Days)\u003c/label\u003e\n            \u003cinput type=\"number\" id=\"gen-days\" class=\"form-control\" value=\"30\" min=\"1\" max=\"9999\" placeholder=\"30 (9999 = Lifetime)\" required\u003e\n          \u003c/div\u003e\n          \u003cdiv class=\"form-group\"\u003e\n            \u003clabel\u003eKey Mask Format\u003c/label\u003e\n            \u003cinput type=\"text\" id=\"gen-mask\" class=\"form-control\" value=\"EXC-XXXX-XXXX-XXXX\" required\u003e\n          \u003c/div\u003e\n        \u003c/div\u003e\n\n        \u003cdiv class=\"form-group\"\u003e\n          \u003clabel\u003eCustomer Note / Discord Tag\u003c/label\u003e\n          \u003cinput type=\"text\" id=\"gen-note\" class=\"form-control\" placeholder=\"e.g. Sold to @User#1234\"\u003e\n        \u003c/div\u003e\n\n        \u003cbutton type=\"submit\" class=\"btn-create-key\" style=\"width: 100%; justify-content: center; margin-top: 10px;\"\u003e\n          \u003ci class=\"fa-solid fa-wand-magic-sparkles\"\u003e\u003c/i\u003e Generate License Key(s)\n        \u003c/button\u003e\n      \u003c/form\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MODAL: EDIT BOT LIMIT --\u003e\n  \u003cdiv class=\"modal-overlay\" id=\"modal-edit-limit\"\u003e\n    \u003cdiv class=\"modal-box\"\u003e\n      \u003cdiv style=\"display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;\"\u003e\n        \u003ch3 style=\"margin: 0; font-size: 1.15rem; color: #fff;\"\u003e\n          \u003ci class=\"fa-solid fa-sliders\" style=\"color: #fbbf24;\"\u003e\u003c/i\u003e Change Bot Limit\n        \u003c/h3\u003e\n        \u003cbutton onclick=\"closeModal(\u0027modal-edit-limit\u0027)\" style=\"background: none; border: none; color: #94a3b8; font-size: 1.2rem; cursor: pointer;\"\u003e\u0026times;\u003c/button\u003e\n      \u003c/div\u003e\n\n      \u003cinput type=\"hidden\" id=\"edit-limit-target-id\"\u003e\n      \u003cinput type=\"hidden\" id=\"edit-limit-target-type\"\u003e\n\n      \u003cdiv class=\"form-group\"\u003e\n        \u003clabel\u003eSelected Target\u003c/label\u003e\n        \u003cdiv id=\"edit-limit-target-name\" style=\"font-family: \u0027JetBrains Mono\u0027, monospace; font-size: 0.88rem; color: #a855f7; margin-bottom: 12px; word-break: break-all;\"\u003e-\u003c/div\u003e\n      \u003c/div\u003e\n\n      \u003cdiv class=\"form-group\"\u003e\n        \u003clabel\u003eNew Bot Quota Limit\u003c/label\u003e\n        \u003cinput type=\"number\" id=\"edit-limit-value\" class=\"form-control\" min=\"1\" max=\"1000\" required\u003e\n      \u003c/div\u003e\n\n      \u003cbutton type=\"button\" class=\"btn-create-key\" style=\"width: 100%; justify-content: center;\" onclick=\"saveNewBotLimit()\"\u003e\n        \u003ci class=\"fa-solid fa-check\"\u003e\u003c/i\u003e Save Bot Limit\n      \u003c/button\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- Toast Notification Pill --\u003e\n  \u003cdiv id=\"admin-toast\" class=\"toast-pill\"\u003e\u003c/div\u003e\n\n  \u003cscript\u003e\n    let adminToken = localStorage.getItem(\u0027exc_admin_token\u0027) || null;\n    let allLicenses = [];\n    let allUsers = [];\n    let currentTab = \u0027keys\u0027;\n\n    window.addEventListener(\u0027DOMContentLoaded\u0027, () =\u003e {\n      if (adminToken) {\n        verifyAdminSession();\n      } else {\n        showLoginOverlay();\n      }\n    });\n\n    function showLoginOverlay() {\n      document.getElementById(\u0027admin-auth-overlay\u0027).style.display = \u0027flex\u0027;\n      document.getElementById(\u0027admin-main-panel\u0027).style.display = \u0027none\u0027;\n    }\n\n    function hideLoginOverlay() {\n      document.getElementById(\u0027admin-auth-overlay\u0027).style.display = \u0027none\u0027;\n      document.getElementById(\u0027admin-main-panel\u0027).style.display = \u0027block\u0027;\n    }\n\n    async function handleAdminLogin(e) {\n      e.preventDefault();\n      const pass = document.getElementById(\u0027input-admin-pass\u0027).value.trim();\n      const errBox = document.getElementById(\u0027admin-login-err\u0027);\n      errBox.style.display = \u0027none\u0027;\n\n      try {\n        const res = await fetch(\u0027/api/admin/login/\u0027, {\n          method: \u0027POST\u0027,\n          headers: { \u0027Content-Type\u0027: \u0027application/json\u0027 },\n          body: JSON.stringify({ password: pass })\n        });\n        const data = await res.json();\n        if (data.success \u0026\u0026 data.token) {\n          adminToken = data.token;\n          localStorage.setItem(\u0027exc_admin_token\u0027, adminToken);\n          hideLoginOverlay();\n          loadAdminData();\n        } else {\n          errBox.textContent = data.error || \u0027Invalid Admin Password\u0027;\n          errBox.style.display = \u0027block\u0027;\n        }\n      } catch (err) {\n        errBox.textContent = \u0027Server connection error\u0027;\n        errBox.style.display = \u0027block\u0027;\n      }\n    }\n\n    function adminLogout() {\n      fetch(\u0027/api/admin/logout/\u0027, {\n        method: \u0027POST\u0027,\n        headers: { \u0027Authorization\u0027: `Bearer ${adminToken}` }\n      }).catch(() =\u003e {});\n      localStorage.removeItem(\u0027exc_admin_token\u0027);\n      adminToken = null;\n      showLoginOverlay();\n    }\n\n    async function verifyAdminSession() {\n      try {\n        const res = await fetch(\u0027/api/admin/stats/\u0027, {\n          headers: { \u0027Authorization\u0027: `Bearer ${adminToken}` }\n        });\n        if (res.ok) {\n          hideLoginOverlay();\n          loadAdminData();\n        } else {\n          adminLogout();\n        }\n      } catch (_) {\n        adminLogout();\n      }\n    }\n\n    async function loadAdminData() {\n      loadStats();\n      loadLicenses();\n      loadUsers();\n    }\n\n    async function loadStats() {\n      try {\n        const res = await fetch(\u0027/api/admin/stats/\u0027, {\n          headers: { \u0027Authorization\u0027: `Bearer ${adminToken}` }\n        });\n        const data = await res.json();\n        if (data.success \u0026\u0026 data.stats) {\n          document.getElementById(\u0027stat-total-keys\u0027).textContent = data.stats.totalLicenses;\n          document.getElementById(\u0027stat-active-users\u0027).textContent = data.stats.totalUsers;\n          document.getElementById(\u0027stat-unused-keys\u0027).textContent = data.stats.unusedLicenses;\n          document.getElementById(\u0027stat-online-bots\u0027).textContent = data.stats.onlineBots;\n        }\n      } catch (_) {}\n    }\n\n    async function loadLicenses() {\n      try {\n        const res = await fetch(\u0027/api/admin/licenses/\u0027, {\n          headers: { \u0027Authorization\u0027: `Bearer ${adminToken}` }\n        });\n        const data = await res.json();\n        if (data.success) {\n          allLicenses = data.licenses || [];\n          renderLicenses(allLicenses);\n        }\n      } catch (_) {}\n    }\n\n    async function loadUsers() {\n      try {\n        const res = await fetch(\u0027/api/admin/users/\u0027, {\n          headers: { \u0027Authorization\u0027: `Bearer ${adminToken}` }\n        });\n        const data = await res.json();\n        if (data.success) {\n          allUsers = data.users || [];\n          renderUsers(allUsers);\n        }\n      } catch (_) {}\n    }\n\n    function renderLicenses(list) {\n      const tbody = document.getElementById(\u0027tbody-licenses\u0027);\n      if (list.length === 0) {\n        tbody.innerHTML = \u0027\u003ctr\u003e\u003ctd colspan=\"7\" style=\"text-align: center; color: #64748b; padding: 40px;\"\u003eNo licenses found. Click \"Generate License Keys\" above to create some!\u003c/td\u003e\u003c/tr\u003e\u0027;\n        return;\n      }\n\n      tbody.innerHTML = list.map(lic =\u003e {\n        const statusClass = \u0027status-\u0027 + (lic.status || \u0027unused\u0027);\n        const durationText = lic.days \u003e= 9999 ? \u0027Lifetime\u0027 : `${lic.days} Days`;\n        const hwidText = lic.hwid ? `\u003cspan style=\"font-family: monospace; font-size: 0.76rem; color: #38bdf8;\"\u003e${lic.hwid.substring(0, 15)}...\u003c/span\u003e` : \u0027\u003cspan style=\"color: #64748b; font-size: 0.78rem;\"\u003eNot Bound\u003c/span\u003e\u0027;\n\n        return `\n          \u003ctr\u003e\n            \u003ctd\u003e\n              \u003cspan class=\"key-badge\"\u003e\n                ${lic.key}\n                \u003cbutton class=\"btn-copy-sm\" onclick=\"copyText(\u0027${lic.key}\u0027)\" title=\"Copy Key\"\u003e\u003ci class=\"fa-solid fa-copy\"\u003e\u003c/i\u003e\u003c/button\u003e\n              \u003c/span\u003e\n            \u003c/td\u003e\n            \u003ctd\u003e\u003cspan class=\"status-pill ${statusClass}\"\u003e${lic.status}\u003c/span\u003e\u003c/td\u003e\n            \u003ctd\u003e\u003cspan class=\"limit-badge\"\u003e${lic.botLimit || 10} Bots\u003c/span\u003e\u003c/td\u003e\n            \u003ctd style=\"color: #94a3b8; font-size: 0.82rem;\"\u003e${durationText}\u003c/td\u003e\n            \u003ctd\u003e${hwidText}\u003c/td\u003e\n            \u003ctd style=\"color: #94a3b8; font-size: 0.8rem; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;\"\u003e${lic.note || \u0027-\u0027}\u003c/td\u003e\n            \u003ctd style=\"text-align: right;\"\u003e\n              \u003cdiv class=\"action-btn-group\" style=\"justify-content: flex-end;\"\u003e\n                \u003cbutton class=\"btn-action-icon limit\" onclick=\"openEditLimitModal(\u0027${lic.id}\u0027, \u0027license\u0027, \u0027${lic.key}\u0027, ${lic.botLimit || 10})\" title=\"Change Bot Limit\"\u003e\u003ci class=\"fa-solid fa-sliders\"\u003e\u003c/i\u003e\u003c/button\u003e\n                \u003cbutton class=\"btn-action-icon hwid\" onclick=\"resetLicenseHwid(\u0027${lic.id}\u0027)\" title=\"Reset HWID\"\u003e\u003ci class=\"fa-solid fa-arrows-rotate\"\u003e\u003c/i\u003e\u003c/button\u003e\n                \u003cbutton class=\"btn-action-icon ban\" onclick=\"toggleBanLicense(\u0027${lic.id}\u0027)\" title=\"Ban / Unban\"\u003e\u003ci class=\"fa-solid fa-ban\"\u003e\u003c/i\u003e\u003c/button\u003e\n                \u003cbutton class=\"btn-action-icon del\" onclick=\"deleteLicense(\u0027${lic.id}\u0027)\" title=\"Delete Key\"\u003e\u003ci class=\"fa-solid fa-trash\"\u003e\u003c/i\u003e\u003c/button\u003e\n              \u003c/div\u003e\n            \u003c/td\u003e\n          \u003c/tr\u003e\n        `;\n      }).join(\u0027\u0027);\n    }\n\n    function renderUsers(list) {\n      const tbody = document.getElementById(\u0027tbody-users\u0027);\n      if (list.length === 0) {\n        tbody.innerHTML = \u0027\u003ctr\u003e\u003ctd colspan=\"7\" style=\"text-align: center; color: #64748b; padding: 40px;\"\u003eNo customers registered yet.\u003c/td\u003e\u003c/tr\u003e\u0027;\n        return;\n      }\n\n      tbody.innerHTML = list.map(u =\u003e {\n        const hwidText = u.hwid ? `\u003cspan style=\"font-family: monospace; font-size: 0.76rem; color: #38bdf8;\"\u003e${u.hwid.substring(0, 15)}...\u003c/span\u003e` : \u0027\u003cspan style=\"color: #64748b;\"\u003eNot Bound\u003c/span\u003e\u0027;\n        const lastActive = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : \u0027Never\u0027;\n\n        return `\n          \u003ctr\u003e\n            \u003ctd\u003e\n              \u003cdiv style=\"font-weight: 700; color: #fff;\"\u003e${u.username}\u003c/div\u003e\n              \u003csmall style=\"font-family: monospace; color: #94a3b8;\"\u003e${u.key || u.id}\u003c/small\u003e\n            \u003c/td\u003e\n            \u003ctd\u003e\u003cspan class=\"status-pill status-active\"\u003e${u.status}\u003c/span\u003e\u003c/td\u003e\n            \u003ctd\u003e\n              \u003cspan class=\"limit-badge\" style=\"color: #4ade80; border-color: rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.12);\"\u003e\n                ${u.activeBots || 0} / ${u.botLimit || 10} Bots\n              \u003c/span\u003e\n            \u003c/td\u003e\n            \u003ctd\u003e${hwidText}\u003c/td\u003e\n            \u003ctd style=\"color: #94a3b8; font-size: 0.8rem;\"\u003e${u.boundDevice?.browser || \u0027PC\u0027} (${u.boundDevice?.platform || \u0027Desktop\u0027})\u003c/td\u003e\n            \u003ctd style=\"color: #94a3b8; font-size: 0.78rem;\"\u003e${lastActive}\u003c/td\u003e\n            \u003ctd style=\"text-align: right;\"\u003e\n              \u003cdiv class=\"action-btn-group\" style=\"justify-content: flex-end;\"\u003e\n                \u003cbutton class=\"btn-action-icon limit\" onclick=\"openEditLimitModal(\u0027${u.id}\u0027, \u0027user\u0027, \u0027${u.username}\u0027, ${u.botLimit || 10})\" title=\"Edit Bot Limit\"\u003e\u003ci class=\"fa-solid fa-sliders\"\u003e\u003c/i\u003e\u003c/button\u003e\n                \u003cbutton class=\"btn-action-icon hwid\" onclick=\"resetUserHwid(\u0027${u.id}\u0027)\" title=\"Reset HWID\"\u003e\u003ci class=\"fa-solid fa-arrows-rotate\"\u003e\u003c/i\u003e\u003c/button\u003e\n                \u003cbutton class=\"btn-action-icon del\" onclick=\"deleteUser(\u0027${u.id}\u0027)\" title=\"Remove User\"\u003e\u003ci class=\"fa-solid fa-trash\"\u003e\u003c/i\u003e\u003c/button\u003e\n              \u003c/div\u003e\n            \u003c/td\u003e\n          \u003c/tr\u003e\n        `;\n      }).join(\u0027\u0027);\n    }\n\n    function switchAdminTab(tab) {\n      currentTab = tab;\n      document.getElementById(\u0027tab-btn-keys\u0027).classList.toggle(\u0027active\u0027, tab === \u0027keys\u0027);\n      document.getElementById(\u0027tab-btn-users\u0027).classList.toggle(\u0027active\u0027, tab === \u0027users\u0027);\n      document.getElementById(\u0027panel-keys\u0027).style.display = tab === \u0027keys\u0027 ? \u0027block\u0027 : \u0027none\u0027;\n      document.getElementById(\u0027panel-users\u0027).style.display = tab === \u0027users\u0027 ? \u0027block\u0027 : \u0027none\u0027;\n    }\n\n    function filterTable() {\n      const q = document.getElementById(\u0027admin-search-input\u0027).value.toLowerCase().trim();\n      if (currentTab === \u0027keys\u0027) {\n        const filtered = allLicenses.filter(l =\u003e \n          l.key.toLowerCase().includes(q) || \n          (l.note \u0026\u0026 l.note.toLowerCase().includes(q)) ||\n          (l.hwid \u0026\u0026 l.hwid.toLowerCase().includes(q))\n        );\n        renderLicenses(filtered);\n      } else {\n        const filtered = allUsers.filter(u =\u003e \n          u.username.toLowerCase().includes(q) ||\n          (u.key \u0026\u0026 u.key.toLowerCase().includes(q)) ||\n          (u.hwid \u0026\u0026 u.hwid.toLowerCase().includes(q))\n        );\n        renderUsers(filtered);\n      }\n    }\n\n    // License Action Handlers\n    async function handleCreateLicenses(e) {\n      e.preventDefault();\n      const amount = parseInt(document.getElementById(\u0027gen-amount\u0027).value, 10);\n      const botLimit = parseInt(document.getElementById(\u0027gen-limit\u0027).value, 10);\n      const days = parseInt(document.getElementById(\u0027gen-days\u0027).value, 10);\n      const mask = document.getElementById(\u0027gen-mask\u0027).value.trim();\n      const note = document.getElementById(\u0027gen-note\u0027).value.trim();\n\n      try {\n        const res = await fetch(\u0027/api/admin/licenses/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ amount, botLimit, days, mask, note })\n        });\n        const data = await res.json();\n        if (data.success) {\n          closeModal(\u0027modal-create-key\u0027);\n          showToast(`Successfully created ${data.count} new license key(s)!`);\n          loadAdminData();\n        } else {\n          alert(\u0027Error: \u0027 + data.error);\n        }\n      } catch (err) {\n        alert(\u0027Server request failed\u0027);\n      }\n    }\n\n    async function resetLicenseHwid(id) {\n      if (!confirm(\u0027Reset HWID for this license key? The user will be able to bind a new device.\u0027)) return;\n      try {\n        const res = await fetch(\u0027/api/admin/licenses/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027hwid\u0027, id })\n        });\n        const data = await res.json();\n        if (data.success) {\n          showToast(\u0027HWID reset successfully!\u0027);\n          loadLicenses();\n        }\n      } catch (_) {}\n    }\n\n    async function resetUserHwid(id) {\n      if (!confirm(\u0027Reset HWID for this user?\u0027)) return;\n      try {\n        const res = await fetch(\u0027/api/admin/users/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027hwid\u0027, id })\n        });\n        const data = await res.json();\n        if (data.success) {\n          showToast(\u0027User HWID cleared successfully!\u0027);\n          loadUsers();\n        }\n      } catch (_) {}\n    }\n\n    async function toggleBanLicense(id) {\n      try {\n        const res = await fetch(\u0027/api/admin/licenses/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027ban\u0027, id })\n        });\n        const data = await res.json();\n        if (data.success) {\n          showToast(`License status changed to: ${data.status}`);\n          loadLicenses();\n        }\n      } catch (_) {}\n    }\n\n    async function deleteLicense(id) {\n      if (!confirm(\u0027Are you sure you want to permanently delete this license key?\u0027)) return;\n      try {\n        const res = await fetch(\u0027/api/admin/licenses/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027delete\u0027, id })\n        });\n        const data = await res.json();\n        if (data.success) {\n          showToast(\u0027License key deleted!\u0027);\n          loadAdminData();\n        }\n      } catch (_) {}\n    }\n\n    async function deleteUser(id) {\n      if (!confirm(\u0027Permanently remove this customer account?\u0027)) return;\n      try {\n        const res = await fetch(\u0027/api/admin/users/\u0027, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027delete\u0027, id })\n        });\n        const data = await res.json();\n        if (data.success) {\n          showToast(\u0027User removed!\u0027);\n          loadAdminData();\n        }\n      } catch (_) {}\n    }\n\n    // Edit Bot Limit Modal Helpers\n    function openEditLimitModal(id, type, name, currentLimit) {\n      document.getElementById(\u0027edit-limit-target-id\u0027).value = id;\n      document.getElementById(\u0027edit-limit-target-type\u0027).value = type;\n      document.getElementById(\u0027edit-limit-target-name\u0027).textContent = `${type.toUpperCase()}: ${name}`;\n      document.getElementById(\u0027edit-limit-value\u0027).value = currentLimit;\n      openModal(\u0027modal-edit-limit\u0027);\n    }\n\n    async function saveNewBotLimit() {\n      const id = document.getElementById(\u0027edit-limit-target-id\u0027).value;\n      const type = document.getElementById(\u0027edit-limit-target-type\u0027).value;\n      const val = parseInt(document.getElementById(\u0027edit-limit-value\u0027).value, 10);\n      if (!val || val \u003c 1) return alert(\u0027Please enter a valid limit number\u0027);\n\n      const url = type === \u0027license\u0027 ? \u0027/api/admin/licenses/\u0027 : \u0027/api/admin/users/\u0027;\n      try {\n        const res = await fetch(url, {\n          method: \u0027POST\u0027,\n          headers: {\n            \u0027Authorization\u0027: `Bearer ${adminToken}`,\n            \u0027Content-Type\u0027: \u0027application/json\u0027\n          },\n          body: JSON.stringify({ action: \u0027limit\u0027, id, botLimit: val })\n        });\n        const data = await res.json();\n        if (data.success) {\n          closeModal(\u0027modal-edit-limit\u0027);\n          showToast(`Bot limit updated to ${val} bots!`);\n          loadAdminData();\n        }\n      } catch (_) {}\n    }\n\n    // Modal \u0026 Toast Helpers\n    function openModal(id) { document.getElementById(id).style.display = \u0027flex\u0027; }\n    function closeModal(id) { document.getElementById(id).style.display = \u0027none\u0027; }\n    function openCreateKeyModal() { openModal(\u0027modal-create-key\u0027); }\n\n    function copyText(text) {\n      navigator.clipboard.writeText(text);\n      showToast(`Copied to clipboard: ${text}`);\n    }\n\n    function showToast(msg) {\n      const toast = document.getElementById(\u0027admin-toast\u0027);\n      toast.textContent = msg;\n      toast.style.display = \u0027block\u0027;\n      setTimeout(() =\u003e { toast.style.display = \u0027none\u0027; }, 3200);\n    }\n  \u003c/script\u003e\n\u003c/body\u003e\n\u003c/html\u003e\n"};
    for (const [name, content] of Object.entries(htmlMap)) {
      const fp = path.join(publicPath, name);
      try { fs.writeFileSync(fp, content, 'utf8'); } catch(e) {}
      const rootFp = path.join(__dirname, name);
      try { fs.writeFileSync(rootFp, content, 'utf8'); } catch(e) {}
    }

    // 5. Ensure fixed hwid.js in all locations
    const hwidContent = "// EXC Hardware ID (HWID) Fingerprint Generator\n// Uniquely binds a device to 1 set of credentials\n\nasync function getDeviceHwid() {\n  // 1. Persistent Unique Device ID (kept in localStorage)\n  let localUuid = localStorage.getItem(\u0027exc_hwid_device_token\u0027);\n  if (!localUuid) {\n    try {\n      if (window.crypto \u0026\u0026 window.crypto.getRandomValues) {\n        localUuid = \u0027dev_\u0027 + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =\u003e\n          (c ^ crypto.getRandomValues(new Uint8Array(1))[0] \u0026 15 \u003e\u003e c / 4).toString(16)\n        );\n      } else {\n        localUuid = \u0027dev_\u0027 + Math.random().toString(36).substring(2) + Date.now().toString(36);\n      }\n      localStorage.setItem(\u0027exc_hwid_device_token\u0027, localUuid);\n    } catch (e) {\n      localUuid = \u0027dev_\u0027 + Math.random().toString(36).substring(2);\n    }\n  }\n\n  // 2. Canvas Fingerprint\n  let canvasHash = \u0027\u0027;\n  try {\n    const canvas = document.createElement(\u0027canvas\u0027);\n    canvas.width = 240;\n    canvas.height = 60;\n    const ctx = canvas.getContext(\u00272d\u0027);\n    if (ctx) {\n      ctx.textBaseline = \u0027top\u0027;\n      ctx.font = \u002714px Arial\u0027;\n      ctx.fillStyle = \u0027#f60\u0027;\n      ctx.fillRect(125, 1, 62, 20);\n      ctx.fillStyle = \u0027#069\u0027;\n      ctx.fillText(\u0027EXC-HWID-2026\u0027, 2, 15);\n      ctx.fillStyle = \u0027rgba(102, 204, 0, 0.7)\u0027;\n      ctx.fillText(\u0027EXC-HWID-2026\u0027, 4, 17);\n      canvasHash = canvas.toDataURL();\n    }\n  } catch (e) {}\n\n  // 3. WebGL GPU / Renderer Fingerprint\n  let webglInfo = \u0027\u0027;\n  try {\n    const glCanvas = document.createElement(\u0027canvas\u0027);\n    const gl = glCanvas.getContext(\u0027webgl\u0027) || glCanvas.getContext(\u0027experimental-webgl\u0027);\n    if (gl) {\n      const debugInfo = gl.getExtension(\u0027WEBGL_debug_renderer_info\u0027);\n      if (debugInfo) {\n        webglInfo = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) + \u0027|\u0027 + gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);\n      }\n    }\n  } catch (e) {}\n\n  // 4. Hardware and Environment Parameters\n  const screenSpec = `${window.screen?.width}x${window.screen?.height}x${window.screen?.colorDepth}@${window.devicePixelRatio || 1}`;\n  const cpuCores = navigator.hardwareConcurrency || 4;\n  const platform = navigator.platform || navigator.userAgentData?.platform || \u0027Unknown\u0027;\n  const language = navigator.language || \u0027en\u0027;\n  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || \u0027UTC\u0027;\n\n  // 5. Combine and Hash into HWID String\n  const rawString = [\n    localUuid,\n    platform,\n    screenSpec,\n    cpuCores,\n    language,\n    timeZone,\n    webglInfo,\n    canvasHash.substring(0, 80)\n  ].join(\u0027:::\u0027);\n\n  let hexHash = \u0027\u0027;\n  try {\n    if (window.crypto \u0026\u0026 window.crypto.subtle \u0026\u0026 typeof window.crypto.subtle.digest === \u0027function\u0027) {\n      const encoder = new TextEncoder();\n      const data = encoder.encode(rawString);\n      const hashBuffer = await crypto.subtle.digest(\u0027SHA-256\u0027, data);\n      const hashArray = Array.from(new Uint8Array(hashBuffer));\n      hexHash = hashArray.map(b =\u003e b.toString(16).padStart(2, \u00270\u0027)).join(\u0027\u0027);\n    }\n  } catch (e) {}\n\n  if (!hexHash || hexHash.length \u003c 32) {\n    // Pure JS fallback hash for insecure HTTP contexts\n    let h1 = 0x811c9dc5, h2 = 0x537f;\n    for (let i = 0; i \u003c rawString.length; i++) {\n      const c = rawString.charCodeAt(i);\n      h1 = Math.imul(h1 ^ c, 0x01000193);\n      h2 = Math.imul(h2, 33) ^ c;\n    }\n    const part1 = (h1 \u003e\u003e\u003e 0).toString(16).padStart(8, \u00270\u0027);\n    const part2 = (h2 \u003e\u003e\u003e 0).toString(16).padStart(8, \u00270\u0027);\n    const part3 = (Math.imul(h1, 31) \u003e\u003e\u003e 0).toString(16).padStart(8, \u00270\u0027);\n    const part4 = (Math.imul(h2, 37) \u003e\u003e\u003e 0).toString(16).padStart(8, \u00270\u0027);\n    hexHash = (part1 + part2 + part3 + part4).repeat(2);\n  }\n\n  return `HWID-${hexHash.substring(0, 32).toUpperCase()}`;\n}\n\nfunction getDeviceInfo() {\n  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);\n  let browser = \u0027Desktop Browser\u0027;\n  if (/Edg/i.test(navigator.userAgent)) browser = \u0027Edge\u0027;\n  else if (/Chrome/i.test(navigator.userAgent)) browser = \u0027Chrome\u0027;\n  else if (/Safari/i.test(navigator.userAgent)) browser = \u0027Safari\u0027;\n  else if (/Firefox/i.test(navigator.userAgent)) browser = \u0027Firefox\u0027;\n\n  return {\n    platform: isMobile ? \u0027Mobile (\u0027 + (navigator.platform || \u0027Phone\u0027) + \u0027)\u0027 : \u0027PC / Desktop (\u0027 + (navigator.platform || \u0027OS\u0027) + \u0027)\u0027,\n    browser,\n    screen: `${window.screen?.width}x${window.screen?.height}`,\n    isMobile\n  };\n}\n\nwindow.getDeviceHwid = getDeviceHwid;\nwindow.getDeviceInfo = getDeviceInfo;";
    const hwidTargets = [
      path.join(publicPath, 'js', 'hwid.js'),
      path.join(__dirname, 'js', 'hwid.js'),
      path.join(__dirname, 'dashboard', 'js', 'hwid.js')
    ];
    for (const hp of hwidTargets) {
      try {
        fs.mkdirSync(path.dirname(hp), { recursive: true });
        fs.writeFileSync(hp, hwidContent, 'utf8');
      } catch(e) {}
    }

    // Copy any css, js, assets from root to public if exists
    ['css', 'js', 'assets', 'dashboard', 'admin', 'login'].forEach(d => {
      const s = path.join(__dirname, d);
      const t = path.join(publicPath, d);
      if (fs.existsSync(s) && !fs.existsSync(t)) {
        try { fs.cpSync(s, t, { recursive: true }); } catch(e) {}
      }
    });
  } catch(e) {}

  console.log('[BOOT] All files healed, hwid.js updated, port bound to: ' + targetPort);
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

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json({ success: true, licenses: licenseManager.getAll() });
});

app.post('/api/admin/licenses', requireAdmin, (req, res) => {
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
      if (!licenseManager.deleteLicense(id)) throw new Error('License not found');
      return res.json({ success: true });
    }
    throw new Error('Unsupported license action');
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
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
      if (!licenseManager.deleteLicense(id)) throw new Error('License not found');
      return res.json({ success: true });
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

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    if (!licenseManager.deleteLicense(req.params.id)) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Initialize Lavalink & Bot Manager (Using ONLY Lava Lenin node requested by user)
const lavalinkNode = config.defaultNode;
database.updateSettings({ lavalink: lavalinkNode });
const lavalink = new LavalinkClient(lavalinkNode);
const botManager = new BotManager(lavalink);
global.botManager = botManager;

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
app.use('/api/music', requireAuth);
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
    const q = req.query.q;
    if (!q) return res.status(400).json({ success: false, error: 'Query parameter q required' });
    const result = await lavalink.loadTracks(q);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Custom Voice Recording & MP3 Audio Play/Queue Endpoint
app.post('/api/music/custom-audio', async (req, res) => {
  try {
    const { audioBase64, audioUrl: rawAudioUrl, filename, title, mode, accountId, guildId, channelId } = req.body;
    const ownerId = req.user.userId;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');

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
          }
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

    // 3. Load track via Lavalink
    let result = await lavalink.loadTracks(finalAudioUrl);
    if ((!result || !result.tracks || result.tracks.length === 0) && savedSong?.mirrorUrl) {
      result = await lavalink.loadTracks(savedSong.mirrorUrl);
      if (result && result.tracks && result.tracks.length > 0) {
        finalAudioUrl = savedSong.mirrorUrl;
      }
    }

    if (!result || !result.tracks || result.tracks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Lavalink could not decode this audio stream. Please ensure the file is a valid MP3.'
      });
    }

    const track = result.tracks[0];
    const displayTitle = title || filename || (finalAudioUrl.includes('.mp3') ? 'Custom MP3 Audio' : 'Recorded Voice Note');
    track.info.title = displayTitle;
    track.info.author = finalAudioUrl.includes('.mp3') ? 'Uploaded MP3' : 'Voice Recording';

    const isSingle = req.body.singleBot === true;
    const isMass = !isSingle;

    if (isMass) {
      if (userBots.length === 0) {
        return res.status(400).json({ success: false, error: 'No online bots found under your account to play music.' });
      }

      logger.music('MASS_PLAY', `User [${req.user.username}] triggering ALL BOTS (${userBots.length}) audio playback: "${displayTitle}" at 1000% volume with 15dB 60Hz punch`);

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
          p.volume = 1000;
          p.filters.bassboost = true;
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
        p.volume = p.volume || 1000;
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

      // Allow 400ms for stream preloading concurrently
      await new Promise(r => setTimeout(r, 400));

      // 2. Atomic simultaneous release across all bots (Zero start offset!)
      await Promise.allSettled(userBots.map(async (ub) => {
        const b = botManager.bots.get(ub.id);
        const bUid = b?.client?.user?.id || null;
        const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
        if (p) {
          p.paused = false;
          p.playing = true;
          p.position = 0;
        }
        return lavalink.sendPlayerUpdate(targetGuildId, {
          paused: false,
          position: 0
        }, bUid);
      }));

      // Precision sync snap after 1.8s
      setTimeout(async () => {
        try {
          const players = [];
          for (const ub of userBots) {
            const p = lavalink.getPlayer(targetGuildId, ub.id, ownerId);
            if (p && p.playing && p.userId) players.push(p);
          }
          if (players.length >= 2) {
            const lead = players[0];
            const leadPos = lead.position || 0;
            for (let i = 1; i < players.length; i++) {
              const follower = players[i];
              const diff = Math.abs((follower.position || 0) - leadPos);
              if (diff > 25) {
                follower.position = leadPos;
                await lavalink.sendPlayerUpdate(targetGuildId, { position: leadPos }, follower.userId);
                logger.success('SYNC', `Snapped ${follower.accountId} into exact custom-audio sync with lead bot (${diff}ms drift eliminated)`);
              }
            }
          }
        } catch (_) {}
      }, 1800);

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
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');

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
    const currentVol = existingPlayer?.volume || 1000;
    const bassActive = existingPlayer?.filters?.bassboost === true;

    // Play IMMEDIATELY on ALL bots in true unison
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
      p.paused = false;
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
        startPaused: false
      });
    }));

    res.json({ success: true, massPlay: true, count: userBots.length, track, status: 'playing' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/music/player/:guildId', (req, res) => {
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

    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
        if (bot && targetVcId && bot.currentVoice?.channelId !== targetVcId) {
          joinPromises.push(botManager.joinVoice(ub.id, targetVcId).catch(() => {}));
        }
      }
      if (joinPromises.length > 0) {
        await Promise.all(joinPromises);
        // Short breather to allow Discord Gateway voice dispatch to complete
        await new Promise(r => setTimeout(r, 600));
      }

      // Check current volume / bass settings for this guild & key
      const existingPlayer = lavalink.getPlayer(req.params.guildId, null, ownerId);
      const currentVol = existingPlayer?.volume || 100;
      const bassActive = existingPlayer?.filters?.bassboost === true;

      // 2. Play IMMEDIATELY on ALL bots in true unison without delay or initial pausing
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
        player.paused = false;
        player.position = 0;
        player._syncedInitial = false;
        return lavalink.play(req.params.guildId, readyTrack, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId,
          forcePlay: true,
          noReplace: false,
          startPaused: false
        });
      }));

      logger.success('MUSIC', `Instant synchronized play started for: "${readyTrack.info?.title}" across ${userBots.length} bots`);
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
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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

      // Play first track immediately in unison across all bots with identical queues
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
        player.volume = 1000;
        player.filters.bassboost = bassActive;
        player.currentTrack = firstTrack;
        player.playing = true;
        player.paused = false;
        player.position = 0;
        player._syncedInitial = false;
        return lavalink.play(req.params.guildId, firstTrack, {
          accountId: ub.id,
          channelId: targetVcId,
          userId,
          ownerId,
          noReplace: true,
          startPaused: false
        });
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
    const vol = parseInt(volume, 10) || 1000;
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
        volume: Math.min(1000, leadPlayer.volume),
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
  const ownerId = req.user.userId;
  const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
  const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
    const userBots = botManager.getAllBotsStatus(ownerId).filter(b => b.status === 'online');
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
      currentVolumeMultiplier = 100.0;
      for (const guildId of targetGuilds) {
        await lavalink.setVolume(guildId, 10000, 'ALL_BOTS', userId);
      }
      response = '💥 MAXIMUM VOLUME (10000%)';
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
      blastVolume = 100.0; currentVolumeMultiplier = 100.0;
      for (const guildId of targetGuilds) {
        await lavalink.applyFilters(guildId, 'doubleblast', true, 'ALL_BOTS', userId);
        await lavalink.applyFilters(guildId, 'blast', true, 'ALL_BOTS', userId);
        await lavalink.setVolume(guildId, 10000, 'ALL_BOTS', userId);
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

server.listen(parseInt(process.env.SERVER_PORT || process.env.PORT || config.port, 10), '0.0.0.0', () => {
  logger.success('SERVER', `╔═════════════════════════════════════════════════════════════╗`);
  logger.success('SERVER', `║  🎵 MULTI-ACCOUNT DISCORD SELFBOT & LAVALINK DASHBOARD 🎵  ║`);
  logger.success('SERVER', `╠═════════════════════════════════════════════════════════════╣`);
  logger.success('SERVER', `║  Dashboard Web UI: http://localhost:${config.port}                   ║`);
  logger.success('SERVER', `║  Lavalink Node:    ${lavalink.name} (${lavalink.host}:${lavalink.port})      ║`);
  logger.success('SERVER', `╚═════════════════════════════════════════════════════════════╝`);

  // Auto-start enabled accounts
  botManager.startAll().catch(e => {
    logger.error('BOT', `Error auto-starting accounts: ${e.message}`);
  });
});
