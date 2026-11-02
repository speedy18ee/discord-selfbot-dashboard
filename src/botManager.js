// Ensure discord.js-selfbot-v13 user settings bug is patched
require("./patch");

const { Client } = require("discord.js-selfbot-v13");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const database = require("./database");
const logger = require("./logger");
const config = require("./config");

// Rotating proxy pool for rate-limit protection & safe mass actions
let freeProxiesList = [];
let proxyRotationIndex = 0;

function loadFreeProxies() {
  try {
    const pPath = path.join(__dirname, "..", "data", "free_proxies.txt");
    if (fs.existsSync(pPath)) {
      const raw = fs.readFileSync(pPath, "utf8")
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && s.includes(":"));
      if (raw.length > 0) {
        freeProxiesList = Array.from(new Set(raw));
        logger.info("PROXY", `🛡️ Loaded ${freeProxiesList.length} proxies from free_proxies.txt for token safety & 24/7 uptime`);
        return;
      }
    }
    const wsProxiesPath = path.join(__dirname, "..", "working_ws_proxies.json");
    if (fs.existsSync(wsProxiesPath)) {
      const data = JSON.parse(fs.readFileSync(wsProxiesPath, "utf8"));
      if (Array.isArray(data) && data.length > 0) {
        freeProxiesList = data;
        logger.info("PROXY", `Loaded ${freeProxiesList.length} proxies from working_ws_proxies.json for rate-limit & token protection`);
        return;
      }
    }
  } catch (e) {
    logger.warn("PROXY", `Could not load proxies: ${e.message}`);
  }
}
loadFreeProxies();

const isOldDeadProxy = (p) => !p || p.includes('184.178.172.17') || p.includes('pldkrffl') || p.includes('198.23.243.226') || p.includes('45.38.107.97') || p.includes('nzpqvgqf');

function getNextRotatingProxy() {
  if (freeProxiesList.length === 0) return null;
  for (let tries = 0; tries < 50; tries++) {
    const p = freeProxiesList[proxyRotationIndex % freeProxiesList.length];
    proxyRotationIndex = (proxyRotationIndex + 1) % freeProxiesList.length;
    if (p && !isOldDeadProxy(p)) return p;
  }
  return null;
}

// REST request helper using proxy agent
function executeGuildLeaveRest(token, guildId, proxy = null) {
  return new Promise((resolve, reject) => {
    let agent = undefined;
    if (proxy) {
      try {
        if (proxy.startsWith("socks")) {
          agent = new SocksProxyAgent(proxy);
        } else {
          const formatted = proxy.startsWith("http") ? proxy : `http://${proxy}`;
          agent = new HttpsProxyAgent(formatted);
        }
      } catch (err) {
        agent = undefined;
      }
    }

    const options = {
      hostname: "discord.com",
      port: 443,
      path: `/api/v9/users/@me/guilds/${guildId}`,
      method: "DELETE",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
      },
      agent,
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 204 || res.statusCode === 200) {
          resolve({ ok: true, status: res.statusCode });
        } else if (res.statusCode === 404) {
          resolve({ ok: true, status: 404, message: "Not in server" });
        } else {
          resolve({ ok: false, status: res.statusCode, error: data || `Status ${res.statusCode}` });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxy request timeout"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

// Optional proxy pool (Direct connection enabled by default without proxy limits)
const WORKING_PROXIES = [];

class BotManager extends EventEmitter {
  constructor(lavalinkClient) {
    super();
    this.lavalink = lavalinkClient;
    // Map<accountId, { client, status, voiceState, reconnectTimeout, rawVoiceData }>
    this.bots = new Map();
    this.start247Watchdog();
  }

  // --- 24/7 Watchdog Keep-Alive System ---
  start247Watchdog() {
    if (this._watchdogInterval) clearInterval(this._watchdogInterval);

    logger.info("WATCHDOG", "🛡️ 24/7 Bot Keep-Alive & Token Protection Watchdog activated (Checking every 15s)");

    this._watchdogInterval = setInterval(async () => {
      try {
        const accounts = database.getAccounts();
        for (const acc of accounts) {
          if (acc.autoStart !== false) {
            const entry = this.bots.get(acc.id);
            const isOnline = entry && (entry.status === "online" || entry.status === "connecting");

            if (!isOnline && (!entry || !entry.userStopped)) {
              if (entry && entry.error && (entry.error.includes("TOKEN_INVALID") || entry.error.includes("invalid token") || entry.error.includes("4004"))) {
                continue;
              }

              const now = Date.now();
              if (!acc._lastWatchdogStart || (now - acc._lastWatchdogStart) > 18000) {
                acc._lastWatchdogStart = now;
                logger.info("WATCHDOG", `[24/7 Keep-Alive] Account ${acc.label} is offline. Auto-starting immediately...`);
                this.startAccount(acc.id).catch(err => {
                  logger.warn("WATCHDOG", `[24/7 Keep-Alive] Auto-start for ${acc.label}: ${err.message}`);
                });
              }
            } else if (entry && entry.status === "online") {
              if (acc.voice247 && acc.voice247.enabled && acc.voice247.channelId && !entry.currentVoice) {
                const now = Date.now();
                if (!acc._lastVoiceRejoin || (now - acc._lastVoiceRejoin) > 15000) {
                  acc._lastVoiceRejoin = now;
                  logger.voice("24/7", `[24/7 Voice Watchdog] Account ${acc.label} lost voice connection. Auto-rejoining VC ${acc.voice247.channelId}...`);
                  this.joinVoice(acc.id, acc.voice247.channelId, {
                    guildId: acc.voice247.guildId,
                    selfMute: acc.voice247.selfMute,
                    selfDeaf: acc.voice247.selfDeaf
                  }).catch(e => {
                    logger.warn("24/7", `Voice rejoin error: ${e.message}`);
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error("WATCHDOG", `Watchdog cycle error: ${err.message}`);
      }
    }, 15000);
  }

  // --- Start an Account with Multi-Proxy Pool & Failover ---
  async startAccount(accountId) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    if (this.bots.has(accountId)) {
      const existing = this.bots.get(accountId);
      if (existing) existing.userStopped = false;
      if (existing.status === "online" || existing.status === "connecting") {
        logger.warn("BOT", `Account ${acc.label} (${accountId}) is already ${existing.status}. Skipping duplicate connection.`);
        return;
      }
    }

    const settings = database.getSettings();
    const isOldDeadProxy = (p) => !p || p.includes('184.178.172.17') || p.includes('pldkrffl') || p.includes('198.23.243.226') || p.includes('45.38.107.97') || p.includes('nzpqvgqf');
    const candidateProxies = [];

    // Prioritize clean, ultra-stable Direct Connection so bots stay online 24/7 without drops or flapping!
    candidateProxies.push(null);

    // If account has an explicit dedicated proxy configured, allow it as backup
    if (acc.proxy && acc.proxy.trim() && !isOldDeadProxy(acc.proxy)) {
      candidateProxies.push(acc.proxy.trim());
    }

    let lastError = null;

    for (let i = 0; i < candidateProxies.length; i++) {
      const proxy = candidateProxies[i];
      const maskedProxy = proxy ? proxy.replace(/:[^:]*@/, ':****@') : 'Direct';
      logger.info("BOT", `Starting selfbot account: ${acc.label} (Attempt ${i + 1}/${candidateProxies.length}) via ${maskedProxy}...`);

      try {
        await this._startWithProxy(accountId, acc, proxy);
        return; // Success!
      } catch (err) {
        lastError = err;
        logger.warn("BOT", `[${acc.label}] Attempt ${i + 1} failed: ${err.message}`);

        // If Discord says token is invalid (4004 / TOKEN_INVALID), do not waste time retrying proxies
        if (err.message && (err.message.includes("TOKEN_INVALID") || err.message.includes("An invalid token was provided") || err.message.includes("4004"))) {
          break;
        }

        if (i < candidateProxies.length - 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }

    const botEntry = this.bots.get(accountId) || { accountId, account: acc };
    botEntry.status = "error";
    botEntry.error = lastError?.message || "Connection failed";
    this.bots.set(accountId, botEntry);
    this.emit("botStatus", { accountId, status: "error", error: botEntry.error });
    throw lastError || new Error("Failed to connect with available proxies");
  }

  async _startWithProxy(accountId, acc, proxy) {
    const clientOptions = {
      checkUpdate: false,
      restRequestTimeout: 45000,
      syncStatus: false,
      ws: {
        properties: {
          os: 'Windows',
          browser: 'Discord Client',
          release_channel: 'stable',
          client_version: '1.0.9155',
          os_version: '10.0.19045',
          os_arch: 'x64',
          system_locale: 'en-US'
        }
      }
    };

    if (proxy && typeof proxy === 'string' && proxy.trim()) {
      let formattedProxy = proxy.trim();
      if (!formattedProxy.startsWith('http://') && !formattedProxy.startsWith('https://') && !formattedProxy.startsWith('socks5://') && !formattedProxy.startsWith('socks4://')) {
        formattedProxy = `socks5://${formattedProxy}`;
      }
      clientOptions.proxy = formattedProxy;
    }

    const client = new Client(clientOptions);

    // Guard against Discord API sending null friend_source_flags or other settings
    if (client.settings && client.settings._patch) {
      const origPatch = client.settings._patch;
      client.settings._patch = function(data) {
        if (data && typeof data === 'object') {
          if (!data.friend_source_flags) {
            data.friend_source_flags = { all: false, mutual_friends: false, mutual_guilds: false };
          }
        }
        try {
          return origPatch.call(this, data);
        } catch (e) {
          return this;
        }
      };
    }

    const botEntry = {
      accountId,
      account: acc,
      client,
      status: "connecting",
      ping: 0,
      currentVoice: null,
      reconnectTimeout: null,
      rawVoiceData: {
        sessionId: null,
        token: null,
        endpoint: null
      }
    };

    this.bots.set(accountId, botEntry);
    this.emit("botStatus", { accountId, status: "connecting" });

    // --- Setup Listeners ---
    client.on("ready", async () => {
      botEntry.status = "online";
      botEntry.error = null;
      botEntry.ping = client.ws.ping;
      logger.success("BOT", `Account connected: ${client.user.tag} (ID: ${client.user.id}) [${proxy ? 'Proxy: ' + proxy.replace(/:[^:]*@/, ':****@') : 'Direct'}]`);

      // Save working proxy to account database to maintain persistent IP address and prevent token resets
      if (proxy) {
        database.updateAccount(accountId, { proxy });
      }

      // Open dedicated Lavalink audio session for this bot account
      this.lavalink.registerBotSession(client.user.id);

      // Save user details
      const userMeta = {
        id: client.user.id,
        tag: client.user.tag,
        username: client.user.username,
        avatar: client.user.displayAvatarURL({ dynamic: true, format: "png", size: 128 })
      };
      database.updateAccount(accountId, { lastKnownUser: userMeta });

      // Apply initial status & activity
      this.applyPresence(client, acc);

      // Check 24/7 Voice Auto-Join
      if (acc.voice247 && acc.voice247.enabled && acc.voice247.channelId) {
        logger.voice("24/7", `Auto-rejoining 24/7 voice channel for ${acc.label}...`);
        setTimeout(() => {
          this.joinVoice(accountId, acc.voice247.channelId, {
            guildId: acc.voice247.guildId,
            selfMute: acc.voice247.selfMute,
            selfDeaf: acc.voice247.selfDeaf
          });
        }, 2000);
      }

      this.emit("botStatus", { accountId, status: "online", user: userMeta, ping: client.ws.ping });
    });

    // Capture raw gateway events for Lavalink v4 voice handshake
    const tryDispatchLavalinkVoice = async (guildId) => {
      const { token, endpoint, sessionId } = botEntry.rawVoiceData;
      const chId = botEntry.rawVoiceData.channelId || botEntry.currentVoice?.channelId;
      if (token && endpoint && sessionId && client.user) {
        logger.voice("VOICE", `Dispatching complete voice handshake for guild ${guildId} to Lavalink...`);
        await this.lavalink.updateVoice(guildId, {
          token,
          endpoint,
          sessionId,
          channelId: chId,
          userId: client.user.id,
          accountId: botEntry.accountId,
          ownerId: botEntry.account?.ownerId || null
        });
      }
    };

    client.on("raw", async (packet) => {
      if (!packet.t || !packet.d) return;

      if (packet.t === "VOICE_SERVER_UPDATE") {
        const { token, endpoint, guild_id } = packet.d;
        botEntry.rawVoiceData.token = token;
        botEntry.rawVoiceData.endpoint = endpoint;
        botEntry.rawVoiceData.guildId = guild_id;

        if (!botEntry.rawVoiceData.channelId && botEntry.currentVoice?.channelId) {
          botEntry.rawVoiceData.channelId = botEntry.currentVoice.channelId;
        }

        await tryDispatchLavalinkVoice(guild_id);
      }

      if (packet.t === "VOICE_STATE_UPDATE") {
        const { session_id, user_id, channel_id, guild_id } = packet.d;
        if (client.user && user_id === client.user.id) {
          botEntry.rawVoiceData.sessionId = session_id;
          
          if (channel_id) {
            botEntry.rawVoiceData.channelId = channel_id;
            const ch = client.channels.cache.get(channel_id);
            botEntry.currentVoice = {
              guildId: guild_id,
              guildName: ch?.guild?.name || botEntry.currentVoice?.guildName || "Discord Server",
              channelId: channel_id,
              channelName: ch?.name || botEntry.currentVoice?.channelName || channel_id
            };
            
            await tryDispatchLavalinkVoice(guild_id);
          } else {
            // Disconnected from voice
            botEntry.currentVoice = null;
            botEntry.rawVoiceData.token = null;
            botEntry.rawVoiceData.endpoint = null;
            botEntry.rawVoiceData.channelId = null;
            const p = this.lavalink.getPlayer(guild_id, client.user?.id);
            if (p) p.voiceConnected = false;

            // Handle 24/7 keep-alive reconnection if enabled
            const currentAcc = database.getAccount(accountId);
            if (currentAcc && currentAcc.voice247 && currentAcc.voice247.enabled && currentAcc.voice247.channelId) {
              logger.warn("24/7", `Account ${currentAcc.label} disconnected from voice! Scheduling 24/7 reconnect in 5s...`);
              if (botEntry.reconnectTimeout) clearTimeout(botEntry.reconnectTimeout);
              botEntry.reconnectTimeout = setTimeout(() => {
                this.joinVoice(accountId, currentAcc.voice247.channelId, {
                  guildId: currentAcc.voice247.guildId,
                  selfMute: currentAcc.voice247.selfMute,
                  selfDeaf: currentAcc.voice247.selfDeaf
                });
              }, 5000);
            }
          }

          this.emit("botVoice", { accountId, currentVoice: botEntry.currentVoice });
        }
      }
    });

    client.on("debug", (info) => {
      if (typeof info === 'string') {
        if (info.includes("Heartbeat") || info.includes("heartbeat")) return;
        if (info.includes("WS") || info.includes("Gateway") || info.includes("Session") || info.includes("Connecting") || info.includes("Handshake") || info.includes("4004") || info.includes("4000")) {
          logger.info("BOT_DEBUG", `[${acc.label}] ${info}`);
        }
      }
    });

    client.on("shardError", (err) => {
      logger.error("BOT", `[${acc.label}] Shard Error: ${err.message}`);
      if (proxy) {
        logger.warn("BOT", `[${acc.label}] Shard proxy failure detected (${err.message}). Auto-switching to Direct Connection in 1.5s...`);
        try { client.destroy(); } catch (_) {}
        setTimeout(() => {
          this._startWithProxy(accountId, acc, null).catch(e => {
            logger.error("BOT", `[${acc.label}] Direct reconnect failed: ${e.message}`);
          });
        }, 1500);
        return;
      }
      botEntry.status = "error";
      botEntry.error = err.message;
      this.emit("botStatus", { accountId, status: "error", error: err.message });
    });

    client.on("shardDisconnect", (event) => {
      const code = event?.code || "unknown";
      const reason = event?.reason || "none";
      logger.warn("BOT", `[${acc.label}] Shard Disconnected (code: ${code}, reason: ${reason})`);
      if (code !== 4004 && code !== 4014) {
        // Auto-reconnect with proxy failover immediately so bots never stay offline
        setTimeout(() => {
          const current = this.bots.get(accountId);
          if (!current || current.status !== "online") {
            logger.info("BOT", `[${acc.label}] 24/7 Keep-Alive: Auto-reconnecting shard...`);
            this.startAccount(accountId).catch(() => {});
          }
        }, 2000);
      }
      botEntry.status = "offline";
      this.emit("botStatus", { accountId, status: "offline", error: `Code ${code}` });
    });

    client.on("invalidated", () => {
      logger.error("BOT", `[${acc.label}] Token invalidated by Discord`);
      botEntry.status = "error";
      botEntry.error = "Token invalidated";
      this.emit("botStatus", { accountId, status: "error", error: "Token invalidated" });
    });

    client.on("error", (err) => {
      logger.error("BOT", `[${acc.label}] Error: ${err.message}`);
    });

    client.on("disconnect", () => {
      botEntry.status = "offline";
      logger.warn("BOT", `[${acc.label}] Disconnected from Discord`);
      this.emit("botStatus", { accountId, status: "offline" });
    });

    // Clean and validate token
    const cleanToken = (acc.token || '').trim().replace(/^["']|["']$/g, '');
    if (!cleanToken) {
      throw new Error("Token is empty or invalid format");
    }

    // Login with account token and ensure gateway connection succeeds
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const onReady = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const onError = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        client.once('ready', onReady);
        client.once('shardError', onError);

        client.login(cleanToken).catch(onError);

        const handshakeTimeout = proxy ? 7000 : 12000;
        setTimeout(() => {
          if (!settled) {
            settled = true;
            if (client.ws?.status === 0) resolve();
            else reject(new Error(`Gateway connection handshake timed out (${proxy ? 'Proxy ' + proxy : 'Direct'})`));
          }
        }, handshakeTimeout);
      });
    } catch (err) {
      try { client.destroy(); } catch (_) {}
      throw err;
    }
  }

  // --- Stop an Account ---
  async stopAccount(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry) return;

    botEntry.userStopped = true;

    if (botEntry.reconnectTimeout) {
      clearTimeout(botEntry.reconnectTimeout);
      botEntry.reconnectTimeout = null;
    }

    try {
      // Leave voice if in one
      if (botEntry.currentVoice?.guildId) {
        await this.leaveVoice(accountId);
      }
      botEntry.client.destroy();
    } catch (e) {}

    botEntry.status = "offline";
    botEntry.currentVoice = null;
    this.bots.delete(accountId);

    logger.info("BOT", `Account ${botEntry.account.label} stopped.`);
    this.emit("botStatus", { accountId, status: "offline" });
  }

  // --- Start All Accounts ---
  async startAll(userId = null) {
    const accounts = database.getAccounts(userId);
    logger.info("BOT", `Starting ${accounts.length} account(s)${userId ? ` for user ${userId}` : ''}...`);
    // Start all accounts simultaneously at 1 time itself (instant parallel connection)
    await Promise.allSettled(accounts.map(acc => {
      if (acc.autoStart !== false) {
        return this.startAccount(acc.id).catch(err => {
          logger.error("BOT", `Failed to start account ${acc.label}: ${err.message}`);
        });
      }
      return Promise.resolve();
    }));
  }

  // --- Stop All Accounts ---
  async stopAll(userId = null) {
    const accounts = database.getAccounts(userId);
    logger.info("BOT", `Stopping ${accounts.length} account(s)...`);
    for (const acc of accounts) {
      if (this.bots.has(acc.id)) {
        await this.stopAccount(acc.id);
      }
    }
  }

  // --- Join Voice Channel ---
  async joinVoice(accountId, channelId, options = {}) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client || botEntry.status !== "online") {
      throw new Error("Bot is not online");
    }

    const client = botEntry.client;

    // Clear any previous reconnect timeout so it doesn't pull bot back to old server
    if (botEntry.reconnectTimeout) {
      clearTimeout(botEntry.reconnectTimeout);
      botEntry.reconnectTimeout = null;
    }

    // 1. Resolve channel from cache first (instant, 0ms latency)
    let channel = client.channels.cache.get(channelId);
    let guildId = options.guildId || channel?.guild?.id;
    let channelName = channel?.name || channelId;
    let guildName = channel?.guild?.name || "Discord Server";

    // 2. If not in cache, try fast fetch with 2.5s timeout
    if (!channel) {
      try {
        channel = await Promise.race([
          client.channels.fetch(channelId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 2500))
        ]);
        if (channel) {
          guildId = guildId || channel.guild?.id;
          channelName = channel.name || channelName;
          guildName = channel.guild?.name || guildName;
        }
      } catch (e) {}
    }

    // 3. Fallback guild discovery: search all guilds this bot is in
    if (!guildId) {
      for (const g of client.guilds.cache.values()) {
        if (g.channels.cache.has(channelId)) {
          guildId = g.id;
          channel = g.channels.cache.get(channelId);
          guildName = g.name;
          channelName = channel?.name || channelName;
          break;
        }
      }
    }

    if (!guildId) {
      throw new Error(`Bot is not a member of the server for channel ${channelId}`);
    }

    const selfMute = options.selfMute ?? false;
    const selfDeaf = options.selfDeaf ?? false;

    logger.voice("VOICE", `Account [${botEntry.account.label}] joining "${channelName}" in "${guildName}" (${guildId})...`);

    // Broadcast op 4 to Discord Gateway immediately
    const shard = client.ws.shards.first();
    if (!shard) {
      throw new Error("No active gateway shard available");
    }

    shard.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
        self_video: false
      }
    });

    botEntry.currentVoice = {
      guildId,
      guildName,
      channelId,
      channelName,
      selfMute,
      selfDeaf,
      selfVideo: !!options.selfVideo
    };

    // Update Lavalink player association if player exists or created
    botEntry.rawVoiceData.channelId = channelId;
    botEntry.rawVoiceData.guildId = guildId;

    this.lavalink.registerBotSession(client.user.id);
    const p = this.lavalink.createPlayer(guildId, {
      accountId,
      userId: client.user.id,
      channelId,
      ownerId: botEntry.account?.ownerId || null
    });

    if (botEntry.rawVoiceData.token && botEntry.rawVoiceData.endpoint && botEntry.rawVoiceData.sessionId) {
      this.lavalink.updateVoice(guildId, {
        token: botEntry.rawVoiceData.token,
        endpoint: botEntry.rawVoiceData.endpoint,
        sessionId: botEntry.rawVoiceData.sessionId,
        channelId,
        userId: client.user.id,
        accountId: botEntry.accountId,
        ownerId: botEntry.account?.ownerId || null
      }).catch(() => {});
    }

    this.emit("botVoice", { accountId, currentVoice: botEntry.currentVoice });
    return botEntry.currentVoice;
  }

  // --- Leave Voice Channel ---
  async leaveVoice(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client) return;

    if (botEntry.reconnectTimeout) {
      clearTimeout(botEntry.reconnectTimeout);
      botEntry.reconnectTimeout = null;
    }

    const guildId = botEntry.currentVoice?.guildId;
    if (guildId) {
      const shard = botEntry.client.ws.shards.first();
      if (shard) {
        shard.send({
          op: 4,
          d: {
            guild_id: guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false
          }
        });
      }

      // Destroy Lavalink player
      await this.lavalink.destroyPlayer(guildId, accountId, botEntry.account?.ownerId);
    }

    botEntry.currentVoice = null;
    logger.voice("VOICE", `Account [${botEntry.account.label}] left voice channel.`);
    this.emit("botVoice", { accountId, currentVoice: null });
  }

  // Camera feature disabled
  async setCamera(accountId, enabled = false) {
    return { success: true, disabled: true };
  }

  async setAllCamera(userId = null, enabled = false) {
    return { success: true, count: 0, disabled: true };
  }

  // --- Configure 24/7 Stay ---
  async set247(accountId, { enabled, guildId, channelId, selfMute = false, selfDeaf = false }) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    let guildName = "";
    let channelName = "";

    const botEntry = this.bots.get(accountId);
    if (botEntry && botEntry.client && channelId) {
      try {
        const ch = await botEntry.client.channels.fetch(channelId);
        if (ch) {
          channelName = ch.name;
          guildName = ch.guild.name;
        }
      } catch (e) {}
    }

    const voice247Config = {
      enabled: !!enabled,
      guildId: guildId || "",
      guildName,
      channelId: channelId || "",
      channelName,
      selfMute: !!selfMute,
      selfDeaf: !!selfDeaf
    };

    database.updateAccount(accountId, { voice247: voice247Config });
    logger.voice("24/7", `Updated 24/7 config for ${acc.label}: ${enabled ? "ACTIVE on " + (channelName || channelId) : "DISABLED"}`);

    if (enabled && channelId && botEntry && botEntry.status === "online") {
      await this.joinVoice(accountId, channelId, { guildId, selfMute, selfDeaf });
    } else if (!enabled && botEntry && botEntry.currentVoice) {
      await this.leaveVoice(accountId);
    }

    return voice247Config;
  }

  // --- Mass Voice: Join ALL Accounts to a Voice Channel & Enable 24/7 ---
  async joinAllToVoice(userId = null, channelId, { guildId = null, keep247 = true, selfMute = false, selfDeaf = false } = {}) {
    if (!channelId) throw new Error("Voice Channel ID is required");

    const accounts = database.getAccounts(userId);
    if (!accounts || accounts.length === 0) throw new Error("No Discord accounts found in your dashboard.");

    let detectedGuildId = guildId;
    let channelName = "";
    let guildName = "";

    // Fast cache discovery from any online bot
    for (const [id, botEntry] of this.bots) {
      if (botEntry.client && botEntry.status === "online") {
        const cached = botEntry.client.channels.cache.get(channelId);
        if (cached) {
          channelName = cached.name || channelName;
          guildName = cached.guild?.name || guildName;
          detectedGuildId = detectedGuildId || cached.guild?.id;
          break;
        }
        for (const guild of botEntry.client.guilds.cache.values()) {
          const ch = guild.channels.cache.get(channelId);
          if (ch) {
            channelName = ch.name || channelName;
            guildName = guild.name || guildName;
            detectedGuildId = detectedGuildId || guild.id;
            break;
          }
        }
        if (detectedGuildId) break;
      }
    }

    // Single-attempt fast fetch if still not detected
    if (!detectedGuildId) {
      for (const [id, botEntry] of this.bots) {
        if (botEntry.client && botEntry.status === "online") {
          try {
            const fetched = await Promise.race([
              botEntry.client.channels.fetch(channelId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            if (fetched) {
              channelName = fetched.name || channelName;
              guildName = fetched.guild?.name || guildName;
              detectedGuildId = fetched.guild?.id || detectedGuildId;
              break;
            }
          } catch (_) {}
        }
      }
    }

    // Immediately update database 24/7 settings so bots never reconnect to old servers
    for (const acc of accounts) {
      const voice247Config = {
        enabled: !!keep247,
        guildId: detectedGuildId || "",
        guildName: guildName || "",
        channelId: channelId,
        channelName: channelName || "",
        selfMute: !!selfMute,
        selfDeaf: !!selfDeaf
      };
      database.updateAccount(acc.id, { voice247: voice247Config });
    }

    let joinedCount = 0;
    const errors = [];

    // Parallel join execution for instant lockstep entry
    await Promise.allSettled(accounts.map(async (acc) => {
      const botEntry = this.bots.get(acc.id);
      if (botEntry && botEntry.status === "online") {
        try {
          await this.joinVoice(acc.id, channelId, {
            guildId: detectedGuildId,
            selfMute,
            selfDeaf
          });
          joinedCount++;
        } catch (err) {
          errors.push(`${acc.label || acc.id}: ${err.message}`);
        }
      }
    }));

    logger.voice("24/7", `Mass voice join executed: ${joinedCount}/${accounts.length} bots joined ${channelName || channelId} (24/7: ${keep247 ? 'ACTIVE' : 'OFF'})`);
    this.emit("accountsUpdated", { accounts: this.getAllBotsStatus(userId) });

    return {
      success: true,
      total: accounts.length,
      joined: joinedCount,
      channelName: channelName || channelId,
      guildName,
      keep247,
      errors
    };
  }

  // --- Mass Voice: Disconnect ALL Accounts from Voice ---
  async leaveAllVoice(userId = null, disable247 = true) {
    const accounts = database.getAccounts(userId);
    let leftCount = 0;

    for (const acc of accounts) {
      if (disable247) {
        database.updateAccount(acc.id, {
          voice247: {
            enabled: false,
            guildId: "",
            guildName: "",
            channelId: "",
            channelName: "",
            selfMute: false,
            selfDeaf: false
          }
        });
      }

      const botEntry = this.bots.get(acc.id);
      if (botEntry) {
        try {
          await this.leaveVoice(acc.id);
          leftCount++;
        } catch (e) {}
      }
    }

    logger.voice("24/7", `Mass voice disconnect: ${leftCount} bots left voice.`);
    this.emit("accountsUpdated", { accounts: this.getAllBotsStatus(userId) });

    return { success: true, leftCount };
  }

  // --- Apply Presence ---
  applyPresence(client, acc) {
    if (!client.user) return;

    try {
      // Set status: online, idle, dnd, invisible
      const status = acc.status || "online";
      client.user.setStatus(status);

      // Set activity if configured
      if (acc.activity && acc.activity.name) {
        client.user.setActivity(acc.activity.name, {
          type: acc.activity.type || "PLAYING",
          url: acc.activity.url || undefined
        });
      }
    } catch (err) {
      logger.warn("BOT", `Could not update presence: ${err.message}`);
    }
  }

  // --- Set Status & Activity ---
  setStatus(accountId, status, activity = null) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    const updates = { status };
    if (activity !== null) updates.activity = activity;

    database.updateAccount(accountId, updates);

    const botEntry = this.bots.get(accountId);
    if (botEntry && botEntry.client && botEntry.status === "online") {
      this.applyPresence(botEntry.client, { ...acc, ...updates });
    }
  }

  // --- Get Guilds & Voice Channels for an Account ---
  async getGuildsAndChannels(accountId) {
    const botEntry = this.bots.get(accountId);
    if (!botEntry || !botEntry.client || botEntry.status !== "online") {
      return [];
    }

    const client = botEntry.client;
    const guildsList = [];

    for (const [, guild] of client.guilds.cache) {
      const voiceChannels = [];
      for (const [, ch] of guild.channels.cache) {
        if (ch.isVoice()) {
          voiceChannels.push({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            userLimit: ch.userLimit,
            bitrate: ch.bitrate
          });
        }
      }

      guildsList.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ dynamic: true, format: "png", size: 64 }),
        voiceChannels
      });
    }

    return guildsList;
  }

  // --- Get Status Summary for accounts (filtered by userId if provided) ---
  // --- Permanent Guild Leave (Single Bot with Proxy & 24/7 Cleanup) ---
  async leaveGuild(accountId, guildId, options = {}) {
    const acc = database.getAccount(accountId);
    if (!acc) throw new Error("Account not found");

    const botEntry = this.bots.get(accountId);
    const client = botEntry?.client;

    let guildName = guildId;
    if (client) {
      const cachedGuild = client.guilds.cache.get(guildId);
      if (cachedGuild) guildName = cachedGuild.name;
    }

    // 1. Permanently delete/disable 24/7 Voice Stay for this server so it never auto-reconnects
    if (acc.voice247 && (acc.voice247.guildId === guildId || !guildId)) {
      database.updateVoice247(accountId, {
        enabled: false,
        guildId: "",
        guildName: "",
        channelId: "",
        channelName: "",
        selfMute: false,
        selfDeaf: false
      });
      logger.info("GUILD", `[${acc.label}] Permanently disabled 24/7 Voice Stay for guild "${guildName}" (${guildId})`);
    }

    // 2. Disconnect from voice channel if currently inside this guild
    if (botEntry?.currentVoice?.guildId === guildId) {
      try {
        await this.leaveVoice(accountId);
      } catch (e) {}
    }

    // 3. Perform leave via Rotating Proxy REST or Client
    let leaveSuccess = false;
    let usedProxy = null;

    if (options.useProxy !== false && freeProxiesList.length > 0) {
      const candidate = getNextRotatingProxy();
      usedProxy = candidate;
      try {
        const restRes = await executeGuildLeaveRest(acc.token, guildId, candidate);
        if (restRes.ok) {
          leaveSuccess = true;
          logger.success("GUILD", `[${acc.label}] Successfully left server "${guildName}" via proxy (${candidate}) [Status ${restRes.status}]`);
        }
      } catch (proxyErr) {
        logger.warn("GUILD", `[${acc.label}] Proxy leave attempt with ${candidate} failed (${proxyErr.message}), falling back to direct leave...`);
      }
    }

    // Direct fallback if proxy disabled, failed, or direct client available
    if (!leaveSuccess) {
      if (client && client.guilds.cache.has(guildId)) {
        try {
          await client.guilds.cache.get(guildId).leave();
          leaveSuccess = true;
          logger.success("GUILD", `[${acc.label}] Successfully left server "${guildName}" directly via client`);
        } catch (clientErr) {
          if (clientErr.code === 10004 || clientErr.message?.includes('Unknown Guild')) {
            leaveSuccess = true;
          } else {
            throw clientErr;
          }
        }
      } else {
        const directRes = await executeGuildLeaveRest(acc.token, guildId, null);
        if (directRes.ok) {
          leaveSuccess = true;
          logger.success("GUILD", `[${acc.label}] Successfully left server "${guildName}" directly via REST`);
        } else {
          throw new Error(directRes.error || `Failed to leave server (Status: ${directRes.status})`);
        }
      }
    }

    // 4. Remove from bot's memory cache
    if (client) {
      client.guilds.cache.delete(guildId);
    }

    this.emit("guildLeave", { accountId, guildId, guildName });

    return {
      success: true,
      accountId,
      accountLabel: acc.label,
      guildId,
      guildName,
      usedProxy: usedProxy || "Direct"
    };
  }

  // --- Permanent Guild Leave for ALL BOTS (Mass Leave with Proxy Rotation & Jitter Stagger) ---
  async leaveGuildAllBots(userId, guildId, options = {}) {
    const accounts = database.getAccounts(userId);
    const results = [];
    let leftCount = 0;
    let targetGuildName = guildId;

    const targetBots = [];
    for (const acc of accounts) {
      const b = this.bots.get(acc.id);
      if (b && b.status === "online" && b.client) {
        if (b.client.guilds.cache.has(guildId)) {
          targetGuildName = b.client.guilds.cache.get(guildId).name;
          targetBots.push(acc);
        }
      }
    }

    if (targetBots.length === 0) {
      for (const acc of accounts) {
        const b = this.bots.get(acc.id);
        if (b && b.status === "online") {
          targetBots.push(acc);
        }
      }
    }

    logger.info("GUILD", `Initiating permanent server leave for "${targetGuildName}" (${guildId}) across ${targetBots.length} bots with proxy rotation & rate limit stagger...`);

    for (let i = 0; i < targetBots.length; i++) {
      const acc = targetBots[i];
      try {
        const res = await this.leaveGuild(acc.id, guildId, options);
        results.push({ accountId: acc.id, label: acc.label, success: true, proxy: res.usedProxy });
        leftCount++;
      } catch (err) {
        logger.error("GUILD", `[${acc.label}] Failed to leave server ${guildId}: ${err.message}`);
        results.push({ accountId: acc.id, label: acc.label, success: false, error: err.message });
      }

      if (i < targetBots.length - 1) {
        const jitter = Math.floor(1200 + Math.random() * 800);
        await new Promise(r => setTimeout(r, jitter));
      }
    }

    return {
      success: true,
      guildId,
      guildName: targetGuildName,
      totalBots: targetBots.length,
      leftCount,
      results
    };
  }

  // --- Get Deduplicated Summary of All Guilds Across Online Bots ---
  getAllGuildsSummary(userId = null) {
    let accounts = database.getAccounts(userId);
    if (!accounts || accounts.length === 0) {
      accounts = database.accounts || [];
    }
    const guildsMap = new Map();

    for (const acc of accounts) {
      const botEntry = this.bots.get(acc.id);
      if (botEntry && botEntry.status === "online" && botEntry.client) {
        try {
          for (const [, guild] of botEntry.client.guilds.cache) {
            if (!guildsMap.has(guild.id)) {
              let iconUrl = null;
              try {
                iconUrl = guild.iconURL({ dynamic: true, format: "png", size: 64 });
              } catch (e) {}
              guildsMap.set(guild.id, {
                id: guild.id,
                name: guild.name || `Server ${guild.id}`,
                icon: iconUrl,
                botCount: 0,
                memberBots: []
              });
            }
            const entry = guildsMap.get(guild.id);
            entry.botCount++;
            entry.memberBots.push({
              id: acc.id,
              label: acc.label,
              username: botEntry.client.user?.username || acc.label
            });
          }
        } catch (e) {}
      }
    }

    return Array.from(guildsMap.values()).sort((a, b) => b.botCount - a.botCount);
  }

  getAllBotsStatus(userId = null) {
    const accounts = database.getAccounts(userId);
    return accounts.map(acc => {
      const live = this.bots.get(acc.id);
      return {
        id: acc.id,
        ownerId: acc.ownerId,
        label: acc.label,
        token: acc.token || "",
        tokenMasked: acc.token || "",
        autoStart: acc.autoStart,
        status: live ? live.status : "offline",
        error: live?.error || null,
        ping: live ? live.ping : 0,
        user: live?.client?.user ? {
          id: live.client.user.id,
          tag: live.client.user.tag,
          username: live.client.user.username,
          avatar: live.client.user.displayAvatarURL({ dynamic: true, format: "png", size: 128 })
        } : acc.lastKnownUser,
        currentVoice: live?.currentVoice || null,
        voice247: acc.voice247,
        presence: {
          status: acc.status || "online",
          activity: acc.activity || null
        }
      };
    });
  }
}

module.exports = BotManager;
