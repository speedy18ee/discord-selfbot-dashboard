const EventEmitter = require('events');
const WebSocket = require('ws');
const logger = require('./logger');

class LavalinkSession extends EventEmitter {
  constructor(client, userId = '100000000000000000') {
    super();
    this.client = client;
    this.userId = userId;
    this.ws = null;
    this.sessionId = null;
    this.connected = false;
    this.reconnectTimeout = null;
  }

  connect(forceNew = false) {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      if (forceNew) {
        try { this.ws.close(); } catch (_) {}
      } else {
        return;
      }
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (forceNew || this.failedAttempts > 0) {
      this.sessionId = null;
    }

    try {
      logger.info('LAVALINK', `Opening session for User ${this.userId} (${this.client.wsUrl})...`);

      const headers = {
        'Authorization': this.client.auth,
        'User-Id': String(this.userId),
        'Client-Name': 'Selfbot-Dashboard/2.0'
      };
      if (this.sessionId) {
        headers['Session-Id'] = this.sessionId;
      }

      this.ws = new WebSocket(this.client.wsUrl, {
        headers,
        handshakeTimeout: 7000
      });

      this.ws.onopen = () => {
        this.failedAttempts = 0;
        logger.success('LAVALINK', `WebSocket connected for User ${this.userId}`);
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          this.handleMessage(payload);
        } catch (err) {
          logger.error('LAVALINK', `Parse error: ${err.message}`);
        }
      };

      this.ws.onerror = (err) => {
        logger.error('LAVALINK', `WS error [User ${this.userId}]: ${err.message || err}`);
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.sessionId = null; // Always clear stale session ID on close
        logger.warn('LAVALINK', `Session closed for User ${this.userId} (code: ${event.code}). Auto-reconnecting in 3s...`);
        this.emit('disconnect');
        this.failedAttempts = (this.failedAttempts || 0) + 1;
        this.scheduleReconnect(3000);
      };

    } catch (err) {
      logger.error('LAVALINK', `Session connect error: ${err.message}`);
      this.scheduleReconnect(3000);
    }
  }

  scheduleReconnect(delay = 3000) {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  handleMessage(msg) {
    switch (msg.op) {
      case 'ready':
        this.sessionId = msg.sessionId;
        this.connected = true;
        logger.success('LAVALINK', `Session ready for User ${this.userId}! SessionId: ${msg.sessionId}`);
        // Enable Lavalink session resuming so tracks never stop during temporary network disconnects
        this.client.apiRequest(`/v4/sessions/${this.sessionId}`, 'PATCH', {
          resuming: true,
          timeout: 180
        }).catch(err => {
          logger.warn('LAVALINK', `Failed to enable session resuming for User ${this.userId}: ${err.message}`);
        });
        this.emit('ready', { sessionId: this.sessionId, userId: this.userId });
        break;

      case 'stats':
        this.client.stats = {
          players: msg.players || 0,
          playingPlayers: msg.playingPlayers || 0,
          uptime: msg.uptime || 0,
          memory: msg.memory || {},
          cpu: msg.cpu || {}
        };
        this.client.emit('stats', this.client.stats);
        break;

      case 'playerUpdate':
        if (msg.guildId) {
          const player = this.client.getPlayer(msg.guildId, this.userId);
          if (player && msg.state) {
            if (msg.state.position > (player.position || 0)) {
              player._stuckAttempts = 0;
            }
            player.position = msg.state.position || 0;
            player.ping = msg.state.ping || 0;
            player.connected = msg.state.connected ?? true;

            // Precision Multi-Bot Lockstep Sync:
            // Eliminates reverb/echo between bots playing in the same guild
            if (player.playing && player.position > 500 && (!player._lastSyncTime || Date.now() - player._lastSyncTime > 4000)) {
              const uniquePlayers = new Set(this.client.players.values());
              for (const p of uniquePlayers) {
                if (p.guildId === msg.guildId && (!player.ownerId || p.ownerId === player.ownerId) && p !== player && p.playing && p.position > 500) {
                  const diff = (player.position || 0) - (p.position || 0);
                  if (Math.abs(diff) >= 25 && Math.abs(diff) <= 1200) {
                    player._lastSyncTime = Date.now();
                    p._lastSyncTime = Date.now();
                    const aheadPlayer = diff > 0 ? player : p;
                    const gap = Math.abs(diff);
                    aheadPlayer.paused = true;
                    this.client.sendPlayerUpdate(msg.guildId, { paused: true }, aheadPlayer.userId).catch(() => {});
                    setTimeout(() => {
                      aheadPlayer.paused = false;
                      this.client.sendPlayerUpdate(msg.guildId, { paused: false }, aheadPlayer.userId).catch(() => {});
                      logger.success('SYNC', `Locked bots into lockstep unison! Paused front bot for ${gap}ms (reverb eliminated)`);
                    }, gap);
                  } else if (Math.abs(diff) > 1200) {
                    // Large drift: snap trailing player position directly
                    player._lastSyncTime = Date.now();
                    p._lastSyncTime = Date.now();
                    const aheadPos = Math.max(player.position || 0, p.position || 0);
                    const trailingPlayer = (player.position || 0) < (p.position || 0) ? player : p;
                    this.client.sendPlayerUpdate(msg.guildId, { position: aheadPos }, trailingPlayer.userId).catch(() => {});
                    logger.success('SYNC', `Snapped trailing bot to ${aheadPos}ms to eliminate echo`);
                  }
                  break;
                }
              }
            }

            this.client.emit('playerUpdate', player);
          }
        }
        break;

      case 'event':
        this.client.handleEvent(msg, this.userId);
        break;
    }
  }

  destroy() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.sessionId = null;
    this.connected = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
  }
}

class LavalinkClient extends EventEmitter {
  constructor(nodeConfig) {
    super();
    // Map<userId, LavalinkSession>
    this.sessions = new Map();
    // Default session for search & stats
    this.defaultSession = null;

    try {
      const config = require('./config');
      this.nodes = config.nodes || [];
    } catch (_) {
      this.nodes = [];
    }
    this.currentNodeIndex = 0;

    this.updateConfig(nodeConfig, false);

    this.stats = {
      players: 0,
      playingPlayers: 0,
      uptime: 0,
      memory: { used: 0, free: 0, allocated: 0 },
      cpu: { cores: 0, systemLoad: 0, lavalinkLoad: 0 }
    };
    
    // Key: guildId -> Player State
    this.players = new Map();
  }

  get sessionId() {
    return this.defaultSession?.sessionId || null;
  }

  get connected() {
    return this.defaultSession?.connected || false;
  }

  updateConfig(nodeConfig, shouldReconnect = true) {
    this.name = nodeConfig.name || "Serenetia V4 (SSL)";
    this.auth = nodeConfig.auth || nodeConfig.password || "https://dsc.gg/ajidevserver";
    this.secure = !!nodeConfig.secure;

    let cleanUrl = (nodeConfig.url || (nodeConfig.host ? `${nodeConfig.host}:${nodeConfig.port}` : "lavalinkv4.serenetia.com:443")).trim();
    cleanUrl = cleanUrl.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
    
    const parts = cleanUrl.split(':');
    this.host = parts[0] || "lavalinkv4.serenetia.com";
    this.port = parts[1] ? parseInt(parts[1], 10) : (this.secure ? 443 : 80);

    this.httpUrl = `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.wsUrl = `${this.secure ? 'wss' : 'ws'}://${this.host}:${this.port}/v4/websocket`;

    if (shouldReconnect) {
      if (this.defaultSession) {
        this.defaultSession.destroy();
        this.defaultSession.connect();
      }
      for (const session of this.sessions.values()) {
        session.destroy();
        session.connect();
      }
    }
  }

  failoverToNextNode() {
    if (!this.nodes || this.nodes.length <= 1) return;
    this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;
    const nextNode = this.nodes[this.currentNodeIndex];
    logger.warn('LAVALINK', `Node unreachable. Auto-failover switching to [${nextNode.name}] (${nextNode.host}:${nextNode.port})...`);
    this.updateConfig(nextNode, true);
  }

  connect() {
    if (!this.defaultSession) {
      this.defaultSession = new LavalinkSession(this, '100000000000000000');
      this.defaultSession.on('ready', (d) => this.emit('ready', d));
      this.defaultSession.on('disconnect', () => this.emit('disconnect'));
    }
    this.defaultSession.connect();
  }

  // Register and open a dedicated session for a Discord bot user ID
  registerBotSession(userId) {
    if (!userId) return null;
    const strId = String(userId);

    if (this.sessions.has(strId)) {
      return this.sessions.get(strId);
    }

    logger.info('LAVALINK', `Registering bot audio session for User ID: ${strId}`);
    const session = new LavalinkSession(this, strId);
    this.sessions.set(strId, session);
    session.connect();

    session.on('ready', () => {
      // Re-sync any players belonging to this bot
      this.resyncPlayersForUser(strId);
    });

    return session;
  }

  getSessionForUser(userId) {
    if (userId) {
      const strId = String(userId);
      if (this.sessions.has(strId)) {
        return this.sessions.get(strId);
      }
      if (strId !== '100000000000000000') {
        return this.registerBotSession(strId);
      }
    }
    return this.defaultSession;
  }

  handleEvent(event, sessionUserId = null) {
    const { type, guildId } = event;
    const player = this.getPlayer(guildId, sessionUserId);
    if (!player) return;

    logger.info('MUSIC', `Lavalink event: ${type} for guild ${guildId} [bot: ${player.accountId || sessionUserId || 'unknown'}]`);

    switch (type) {
      case 'TrackStartEvent':
        player.playing = true;
        player.paused = false;
        player._stuckAttempts = 0;
        player._exceptionAttempts = 0;
        player._streamDropCount = 0;
        this.emit('trackStart', { player, track: event.track, ownerId: player.ownerId, accountId: player.accountId });
        break;

      case 'TrackEndEvent':
        player._stuckAttempts = 0;
        player._exceptionAttempts = 0;
        this.handleTrackEnd(player, event);
        break;

      case 'TrackExceptionEvent':
        logger.warn('MUSIC', `Track stream exception: ${event.exception?.message || 'Unknown'}. Keeping stream active...`);
        break;

      case 'TrackStuckEvent':
        logger.warn('MUSIC', `Track buffer stall at ${event.thresholdMs}ms. Keeping stream active...`);
        break;

      case 'WebSocketClosedEvent':
        logger.warn('MUSIC', `Voice channel closed (code ${event.code}): ${event.reason}`);
        break;
    }
  }

  handleTrackEnd(player, event) {
    // 1. Never skip or restart on non-finish reasons (replaced, stopped, cleanup)
    if (event.reason === 'replaced' || event.reason === 'stopped' || event.reason === 'cleanup') {
      return;
    }

    // Mark THIS bot's player as finished
    player.playing = false;

    // 2. Repeat Loop for track
    if (player.loop === 'track' && player.currentTrack) {
      const now = Date.now();
      if (!this._lastLoopMap) this._lastLoopMap = new Map();
      const lastLoop = this._lastLoopMap.get(player.guildId) || 0;
      if (now - lastLoop > 2500) {
        this._lastLoopMap.set(player.guildId, now);
        const trackToRepeat = player.currentTrack;
        const uniquePlayers = new Set(this.players.values());
        for (const p of uniquePlayers) {
          if (p.guildId === player.guildId && (!player.ownerId || p.ownerId === player.ownerId)) {
            p.currentTrack = trackToRepeat;
            p.position = 0;
            p.playing = true;
            p.paused = false;
            p._syncedInitial = false;
            const pFilters = this.buildFiltersPayload(p);
            this.sendPlayerUpdate(p.guildId, {
              track: { encoded: trackToRepeat.encoded },
              paused: false,
              volume: this.calculateMasterVolume(p.volume),
              filters: pFilters
            }, p.userId).catch(() => {});
          }
        }
        this.emit('trackStart', { player, track: trackToRepeat, ownerId: player.ownerId, accountId: player.accountId });
        this.emit('playerUpdate', player);
      }
      return;
    }

    // 3. Multi-Bot Queue De-duplication: Only 1 trigger advances the queue for the guild
    const now = Date.now();
    if (!this._lastTrackEndMap) this._lastTrackEndMap = new Map();
    const lastEnd = this._lastTrackEndMap.get(player.guildId) || 0;
    if (now - lastEnd < 3000) {
      return; // Already processed queue advance for this guild
    }
    this._lastTrackEndMap.set(player.guildId, now);

    if (player.loop === 'queue' && player.currentTrack) {
      player.queue.push(player.currentTrack);
    }

    this.playNext(player);
  }

  async playNext(playerOrGuildId, identifier = null, ownerId = null) {
    const player = (typeof playerOrGuildId === 'object' && playerOrGuildId !== null)
      ? playerOrGuildId
      : this.getPlayer(playerOrGuildId, identifier, ownerId);
    if (!player) return;
    const guildId = player.guildId;

    if (player.queue.length > 0) {
      const nextTrack = player.queue.shift();
      const uniquePlayers = new Set(this.players.values());
      // Advance to next track across all bots in unison
      for (const p of uniquePlayers) {
        if (p.guildId === guildId && (!player.ownerId || p.ownerId === player.ownerId)) {
          p.currentTrack = nextTrack;
          p.position = 0;
          p.playing = true;
          p.paused = false;
          p._syncedInitial = false;
          const pFilters = this.buildFiltersPayload(p);
          this.sendPlayerUpdate(guildId, {
            track: { encoded: nextTrack.encoded },
            paused: false,
            volume: this.calculateMasterVolume(p.volume),
            filters: pFilters
          }, p.userId).catch(() => {});
        }
      }
      this.emit('queueUpdate', player);
      this.emit('trackStart', { player, track: nextTrack, ownerId: player.ownerId, accountId: player.accountId });
    } else {
      // Queue is finished: DO NOT abruptly cut off follower bots that are still finishing their stream!
      // Let each bot naturally stream until the song finishes.
      player.currentTrack = null;
      player.playing = false;
      player.position = 0;

      const uniquePlayers = new Set(this.players.values());
      const anyStillPlaying = Array.from(uniquePlayers).some(
        p => p.guildId === guildId && (!player.ownerId || p.ownerId === player.ownerId) && p.playing
      );
      if (!anyStillPlaying) {
        for (const p of uniquePlayers) {
          if (p.guildId === guildId && (!player.ownerId || p.ownerId === player.ownerId)) {
            p.currentTrack = null;
            p.playing = false;
            p.position = 0;
          }
        }
        this.emit('queueEnd', player);
      }
    }
  }

  async apiRequest(path, method = 'GET', body = null) {
    const url = `${this.httpUrl}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': this.auth,
        'Content-Type': 'application/json'
      }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Lavalink REST ${res.status}: ${errText}`);
    }

    if (res.status === 204) return null;
    return await res.json();
  }

  async loadTracks(identifier) {
    let cleanId = identifier.trim();
    const isDirectUrl = /^https?:\/\//i.test(cleanId) || cleanId.includes(':');

    let result = null;
    if (isDirectUrl) {
      result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(cleanId)}`, 'GET');
    } else {
      // Prioritize YouTube ('ytsearch') and YouTube Music ('ytmsearch') for original audio tracks
      const searchPrefixes = ['ytsearch', 'ytmsearch', 'scsearch', 'spsearch'];
      for (const prefix of searchPrefixes) {
        try {
          const res = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`${prefix}:${cleanId}`)}`, 'GET');
          if (res && res.data && (Array.isArray(res.data) ? res.data.length > 0 : (res.data.tracks?.length > 0 || res.data.encoded))) {
            result = res;
            break;
          }
        } catch (_) {}
      }
      if (!result) {
        result = await this.apiRequest(`/v4/loadtracks?identifier=${encodeURIComponent(`ytsearch:${cleanId}`)}`, 'GET');
      }
    }
    
    let tracks = [];
    let playlistInfo = null;

    if (result.loadType === 'track') {
      tracks = [result.data];
    } else if (result.loadType === 'playlist') {
      tracks = result.data.tracks || [];
      playlistInfo = result.data.info || null;
    } else if (result.loadType === 'search') {
      tracks = Array.isArray(result.data) ? result.data : [];
    }

    return {
      loadType: result.loadType,
      playlistInfo,
      tracks: tracks.map(t => ({
        encoded: t.encoded,
        info: {
          title: t.info?.title || "Unknown Title",
          author: t.info?.author || "Unknown Artist",
          length: t.info?.length || 0,
          identifier: t.info?.identifier,
          isSeekable: t.info?.isSeekable ?? true,
          isStream: t.info?.isStream ?? false,
          uri: t.info?.uri || "",
          artworkUrl: t.info?.artworkUrl || `https://img.youtube.com/vi/${t.info?.identifier}/hqdefault.jpg`,
          sourceName: t.info?.sourceName || "unknown"
        }
      }))
    };
  }

  // --- Voice State Update for a Guild ---
  async updateVoice(guildId, voiceData) {
    let player = this.getPlayer(guildId, voiceData.accountId || voiceData.userId, voiceData.ownerId);
    if (!player) {
      player = this.createPlayer(guildId, {
        accountId: voiceData.accountId,
        userId: voiceData.userId,
        channelId: voiceData.channelId,
        ownerId: voiceData.ownerId
      });
    }

    player.voice = voiceData;
    if (voiceData.userId) player.userId = voiceData.userId;
    if (voiceData.channelId) player.channelId = voiceData.channelId;
    if (voiceData.accountId) player.accountId = voiceData.accountId;
    if (voiceData.ownerId) player.ownerId = voiceData.ownerId;

    const session = this.getSessionForUser(player.userId);
    if (!session || !session.sessionId || !session.connected) {
      logger.warn('LAVALINK', `Session for user ${player.userId} not ready/connected. Queuing voice handshake on ready.`);
      if (session) {
        if (!session.connected) session.connect();
        session.once('ready', async () => {
          try {
            await this.updateVoice(guildId, voiceData);
          } catch(e) {}
        });
      }
      return;
    }

    try {
      logger.info('LAVALINK', `Sending Voice Handshake for Guild ${guildId} to Lavalink session ${session.sessionId}...`);
      
      const cleanEndpoint = (voiceData.endpoint || '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
      const payload = {
        voice: {
          token: voiceData.token,
          endpoint: cleanEndpoint,
          sessionId: voiceData.sessionId
        }
      };
      if (voiceData.channelId || player.channelId) {
        payload.voice.channelId = voiceData.channelId || player.channelId;
      }

      await this.sendPlayerUpdate(guildId, payload, player.userId);
      player.voiceConnected = true;
      logger.success('LAVALINK', `✅ Voice connected in Guild ${guildId}!`);
    } catch (err) {
      logger.error('LAVALINK', `Failed to send voice update: ${err.message}`);
    }
  }

  async resyncPlayersForUser(userId) {
    for (const [key, player] of this.players.entries()) {
      if (player.userId === userId && player.voice?.token && player.voice?.endpoint) {
        try {
          await this.updateVoice(player.guildId, player.voice);
          if (player.playing && player.currentTrack?.encoded) {
            await this.sendPlayerUpdate(player.guildId, {
              track: { encoded: player.currentTrack.encoded },
              paused: false,
              volume: this.calculateMasterVolume(player.volume),
              filters: this.buildFiltersPayload(player)
            }, player.userId);
            logger.success('LAVALINK', `Restored playback for user ${userId} in guild ${player.guildId} after session reconnect`);
          }
        } catch (e) {}
      }
    }
  }

  createPlayer(guildId, options = {}) {
    const accountId = options.accountId || null;
    const userId = options.userId || null;
    const ownerId = options.ownerId || 'default';
    const idKey = accountId || userId;
    const key = idKey ? `${guildId}:${idKey}:${ownerId}` : `${guildId}:${ownerId}`;

    let player = this.getPlayer(guildId, idKey, ownerId);

    if (player) {
      if (accountId) player.accountId = accountId;
      if (options.channelId) player.channelId = options.channelId;
      if (userId) player.userId = userId;
      player.ownerId = ownerId;
      if (!this.players.has(key)) this.players.set(key, player);
      return player;
    }

    player = {
      guildId,
      playerKey: key,
      accountId: accountId,
      ownerId: ownerId,
      userId: userId,
      channelId: options.channelId || null,
      playing: false,
      paused: false,
      volume: 100,
      position: 0,
      ping: 0,
      connected: false,
      loop: 'off',
      currentTrack: null,
      queue: [],
      voice: null,
      filters: {
        clarity: false,
        bassboost: false, // Default is clean volume without bass
        nightcore: false,
        vaporwave: false,
        eightD: false,
        extremeLoud: false,
        packing: false
      }
    };

    this.players.set(key, player);
    if (accountId) this.players.set(`${guildId}:${accountId}:${ownerId}`, player);
    if (userId) this.players.set(`${guildId}:${userId}:${ownerId}`, player);
    this.players.set(`${guildId}:${ownerId}`, player);
    return player;
  }

  getPlayer(guildId, identifier = null, ownerId = null) {
    if (identifier && ownerId) {
      const compositeKey = `${guildId}:${identifier}:${ownerId}`;
      if (this.players.has(compositeKey)) return this.players.get(compositeKey);
    }
    if (ownerId && !identifier) {
      const genericKey = `${guildId}:${ownerId}`;
      if (this.players.has(genericKey)) return this.players.get(genericKey);
    }
    if (identifier && !ownerId) {
      const compositeKey = `${guildId}:${identifier}`;
      if (this.players.has(compositeKey)) return this.players.get(compositeKey);
    }

    // Search by guildId and matching identifier and ownerId (Strict isolation across different user keys)
    for (const [k, p] of this.players.entries()) {
      if (p.guildId === guildId) {
        if (ownerId && p.ownerId !== ownerId) continue; // STRICT ISOLATION BY OWNER KEY
        if (identifier) {
          if (p.accountId === identifier || p.userId === identifier) {
            return p;
          }
        } else {
          return p;
        }
      }
    }

    if (!identifier && !ownerId) {
      return this.players.get(guildId) || null;
    }

    return null;
  }

  async sendPlayerUpdate(guildId, data, userId = null) {
    let session = this.getSessionForUser(userId);
    if (session && (!session.sessionId || !session.connected)) {
      if (!session.connected) session.connect(true);
      await new Promise(resolve => {
        if (session.sessionId && session.connected) return resolve();
        const onReady = () => resolve();
        session.once('ready', onReady);
        setTimeout(() => { session.off('ready', onReady); resolve(); }, 3500);
      });
    }
    if (!session || !session.sessionId) {
      if (!userId) {
        for (const s of this.sessions.values()) {
          if (s.sessionId && s.connected) {
            session = s;
            break;
          }
        }
      }
    }
    if (!session || !session.sessionId) {
      throw new Error(`Lavalink audio session not established for bot user ${userId || 'default'}`);
    }
    const noReplaceQuery = data.track ? `?noReplace=${data.track ? "false" : "true"}` : '';
    const path = `/v4/sessions/${session.sessionId}/players/${guildId}${noReplaceQuery}`;
    try {
      return await this.apiRequest(path, 'PATCH', data);
    } catch (err) {
      if (err.message && (err.message.includes('404') || err.message.includes('Session not found'))) {
        logger.warn('LAVALINK', `Session ${session.sessionId} expired (404) on Lavalink. Force reconnecting session for user ${userId || 'default'}...`);
        session.sessionId = null;
        session.connected = false;
        session.connect(true);
        await new Promise(resolve => {
          if (session.sessionId && session.connected) return resolve();
          const onReady = () => resolve();
          session.once('ready', onReady);
          setTimeout(() => { session.off('ready', onReady); resolve(); }, 3000);
        });
        if (session.sessionId) {
          const player = this.getPlayer(guildId, userId);
          if (player?.voice) {
            try { await this.updateVoice(guildId, player.voice); } catch (_) {}
          }
          const retryPath = `/v4/sessions/${session.sessionId}/players/${guildId}${noReplaceQuery}`;
          return await this.apiRequest(retryPath, 'PATCH', data);
        }
      }
      throw err;
    }
  }

  async play(guildId, track, options = {}) {
    const player = this.createPlayer(guildId, options);

    const shouldQueue = player.playing && options.noReplace === true && !options.forcePlay;

    if (shouldQueue) {
      player.queue.push(track);
      this.emit('queueUpdate', player);
      return { status: 'queued', track };
    } else {
      player.currentTrack = track;
      player.position = 0;
      player._syncedInitial = false;
      const filtersPayload = this.buildFiltersPayload(player);
      const isPaused = options.startPaused === true;
      const updateData = {
        track: { encoded: track.encoded },
        paused: isPaused,
        volume: this.calculateMasterVolume(player.volume),
        filters: filtersPayload
      };
      if (options.position !== undefined) {
        updateData.position = options.position;
      }
      // Include voice credentials if available to ensure instant Discord voice connectivity
      if (player.voice?.token && player.voice?.endpoint && player.voice?.sessionId) {
        const cleanEndpoint = (player.voice.endpoint || '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
        updateData.voice = {
          token: player.voice.token,
          endpoint: cleanEndpoint,
          sessionId: player.voice.sessionId,
          channelId: player.voice.channelId || player.channelId || null
        };
      }
      await this.sendPlayerUpdate(guildId, updateData, player.userId);
      player.playing = true;
      player.paused = isPaused;
      this.emit('trackStart', { player, track });
      return { status: isPaused ? 'buffered' : 'playing', track };
    }
  }

  async addPlaylist(guildId, tracks, options = {}) {
    const player = this.createPlayer(guildId, options);
    if (!tracks || tracks.length === 0) return;

    if (!player.playing || options.noReplace) {
      const first = tracks[0];
      const rest = tracks.slice(1);
      player.queue = [...rest];
      await this.play(guildId, first, { ...options, noReplace: true });
    } else {
      player.queue.push(...tracks);
      this.emit('queueUpdate', player);
    }
  }

  async pause(guildId, paused = true, identifier = null, ownerId = null) {
    if (!identifier || identifier === 'ALL_BOTS') {
      for (const p of this.players.values()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.paused = paused;
          if (p.userId) {
            this.sendPlayerUpdate(guildId, { paused }, p.userId).catch(() => {});
          }
          this.emit('playerUpdate', p);
        }
      }
      return;
    }
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    await this.sendPlayerUpdate(guildId, { paused }, player.userId);
    player.paused = paused;
    this.emit('playerUpdate', player);
  }

  async skip(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;
    await this.playNext(player);
  }

  async stop(guildId, identifier = null, ownerId = null) {
    if (!identifier || identifier === 'ALL_BOTS') {
      for (const p of this.players.values()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.queue = [];
          p.currentTrack = null;
          p.playing = false;
          p.position = 0;
          if (p.userId) {
            this.sendPlayerUpdate(guildId, { track: { encoded: null } }, p.userId).catch(() => {});
          }
          this.emit('playerUpdate', p);
        }
      }
      return;
    }
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    player.queue = [];
    player.currentTrack = null;
    player.playing = false;
    player.position = 0;

    await this.sendPlayerUpdate(guildId, {
      track: { encoded: null }
    }, player.userId);
    this.emit('queueUpdate', player);
    this.emit('playerUpdate', player);
  }

  playTrack(guildId, track, identifier = null, ownerId = null) {
    return this.play(guildId, track, { accountId: identifier, ownerId, noReplace: true, startPaused: false });
  }

  stopTrack(guildId, identifier = null, ownerId = null) {
    return this.stop(guildId, identifier, ownerId);
  }

  searchTracks(query) {
    return this.loadTracks(query);
  }

  calculateMasterVolume(volume) {
    const v = parseInt(volume, 10);
    if (isNaN(v) || v <= 0) return 100;
    // Direct transparent scaling up to Lavalink max integer master volume (1000 = 10x gain)
    return Math.max(10, Math.min(1000, v));
  }

  buildFiltersPayload(player) {
    const filtersPayload = {};

    // 1. Raw DSP Volume Multiplier (filters.volume in Lavalink v4)
    // Cap at 1.0 (100%) to prevent distortion. Master volume (calculateMasterVolume) handles gain.
    let volMultiplier = Math.max(0.05, Math.min(1.0, (player.volume || 100) / 100.0));
    filtersPayload.volume = Number(volMultiplier.toFixed(2));

    // Preset Boosts — channelMix values capped at 1.0 to prevent BSSSSS clipping/distortion
    if (player.filters.doubleblast) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.15, rightToLeft: 0.15 };
    } else if (player.filters.blast) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.1, rightToLeft: 0.1 };
    } else if (player.filters.max) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.2, rightToLeft: 0.2 };
    } else if (player.filters.forceLoud) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.15, rightToLeft: 0.15 };
    } else if (player.filters.superLoud) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.1, rightToLeft: 0.1 };
    } else if (player.filters.loudMode || player.filters.loud) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.05, rightToLeft: 0.05 };
    } else if (player.filters.pungi) {
      filtersPayload.volume = 1.0;
      filtersPayload.channelMix = { leftToLeft: 1.0, rightToRight: 1.0, leftToRight: 0.1, rightToLeft: 0.1 };
    }

    // Default Stereo Channel Mix
    if (!filtersPayload.channelMix) {
      filtersPayload.channelMix = {
        leftToLeft: 1.0,
        leftToRight: 0.0,
        rightToLeft: 0.0,
        rightToRight: 1.0
      };
    }

    // 2. Equalizer: Strong Low-End Bass Cut for Crisp, Crystal Clear Volume
    if (player.filters.bassboost) {
      // Mild clean punch (sub-bass still controlled so it never distorts)
      filtersPayload.equalizer = [
        { band: 0, gain: -0.15 }, // 25 Hz sub-bass controlled
        { band: 1, gain: -0.10 }, // 40 Hz
        { band: 2, gain: -0.05 }, // 63 Hz
        { band: 3, gain: 0.02 },  // 100 Hz tight punch
        { band: 4, gain: 0.04 },  // 160 Hz
        { band: 5, gain: 0.06 },
        { band: 6, gain: 0.08 },
        { band: 7, gain: 0.10 },
        { band: 8, gain: 0.12 },
        { band: 9, gain: 0.12 },
        { band: 10, gain: 0.10 },
        { band: 11, gain: 0.06 },
        { band: 12, gain: 0.02 },
        { band: 13, gain: 0.00 },
        { band: 14, gain: 0.00 }
      ];
    } else if (player.filters.extremeLoud) {
      filtersPayload.equalizer = [
        { band: 0, gain: -0.35 },
        { band: 1, gain: -0.30 },
        { band: 2, gain: -0.20 },
        { band: 3, gain: -0.10 },
        { band: 4, gain: 0.10 },
        { band: 5, gain: 0.20 },
        { band: 6, gain: 0.25 },
        { band: 7, gain: 0.30 },
        { band: 8, gain: 0.35 },
        { band: 9, gain: 0.35 },
        { band: 10, gain: 0.30 },
        { band: 11, gain: 0.25 },
        { band: 12, gain: 0.20 },
        { band: 13, gain: 0.15 },
        { band: 14, gain: 0.10 }
      ];
    } else if (player.filters.packing) {
      filtersPayload.equalizer = [
        { band: 0, gain: -0.35 },
        { band: 1, gain: -0.30 },
        { band: 2, gain: -0.20 },
        { band: 3, gain: -0.10 },
        { band: 4, gain: 0.10 },
        { band: 5, gain: 0.25 },
        { band: 6, gain: 0.35 },
        { band: 7, gain: 0.45 },
        { band: 8, gain: 0.50 },
        { band: 9, gain: 0.50 },
        { band: 10, gain: 0.45 },
        { band: 11, gain: 0.40 },
        { band: 12, gain: 0.35 },
        { band: 13, gain: 0.30 },
        { band: 14, gain: 0.25 }
      ];
    } else if (player.filters.clarity) {
      filtersPayload.equalizer = [
        { band: 0, gain: -0.35 },
        { band: 1, gain: -0.30 },
        { band: 2, gain: -0.22 },
        { band: 3, gain: -0.12 },
        { band: 4, gain: 0.05 },
        { band: 5, gain: 0.18 },
        { band: 6, gain: 0.25 },
        { band: 7, gain: 0.30 },
        { band: 8, gain: 0.35 },
        { band: 9, gain: 0.35 },
        { band: 10, gain: 0.30 },
        { band: 11, gain: 0.25 },
        { band: 12, gain: 0.20 },
        { band: 13, gain: 0.15 },
        { band: 14, gain: 0.10 }
      ];
    } else {
      // Default: High-Pass / Low-Bass Reduction (Loud, crystal clear volume with NO bass mud)
      filtersPayload.equalizer = [
        { band: 0, gain: -0.35 }, // 25 Hz: deep sub-bass mud cut
        { band: 1, gain: -0.30 }, // 40 Hz: low bass rumble cut
        { band: 2, gain: -0.22 }, // 63 Hz: bass boom cut
        { band: 3, gain: -0.12 }, // 100 Hz: punch mud cut
        { band: 4, gain: -0.04 }, // 160 Hz: clean natural transition
        { band: 5, gain: 0.04 },  // 250 Hz: warmth
        { band: 6, gain: 0.08 },  // 400 Hz: vocals
        { band: 7, gain: 0.14 },  // 630 Hz: vocal clarity & presence
        { band: 8, gain: 0.18 },  // 1.0 kHz: crisp lyrics
        { band: 9, gain: 0.18 },  // 1.6 kHz: high definition
        { band: 10, gain: 0.14 }, // 2.5 kHz: brightness
        { band: 11, gain: 0.08 }, // 4.0 kHz: treble air
        { band: 12, gain: 0.04 }, // 6.3 kHz
        { band: 13, gain: 0.00 }, // 10 kHz
        { band: 14, gain: 0.00 }  // 16 kHz
      ];
    }

    // 3. Timescale: keep pitch exactly at 1.0 (original music tuning!)
    if (player.filters.nightcore) {
      filtersPayload.timescale = { speed: 1.25, pitch: 1.25, rate: 1.0 };
    } else if (player.filters.vaporwave) {
      filtersPayload.timescale = { speed: 0.85, pitch: 0.80, rate: 1.0 };
    } else {
      filtersPayload.timescale = { speed: 1.0, pitch: 1.0, rate: 1.0 };
    }

    // 4. Rotation
    if (player.filters.eightD) {
      filtersPayload.rotation = { rotationHz: 0.2 };
    } else {
      filtersPayload.rotation = { rotationHz: 0.0 };
    }

    return filtersPayload;
  }

  async setVolume(guildId, volume, identifier = null, ownerId = null) {
    const vol = parseInt(volume, 10);
    const clamped = Math.max(0, Math.min(20000, isNaN(vol) ? 100 : vol));
    const masterVol = this.calculateMasterVolume(clamped);

    if (!identifier || identifier === 'ALL_BOTS') {
      for (const p of this.players.values()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.volume = clamped;
          const pFilters = this.buildFiltersPayload(p);
          if (p.userId) {
            this.sendPlayerUpdate(guildId, {
              volume: masterVol,
              filters: pFilters
            }, p.userId).catch(() => {});
          }
          this.emit('playerUpdate', p);
        }
      }
      logger.success('MUSIC', `Set volume in guild ${guildId} to ${clamped}% across all bots (Master: ${masterVol})`);
      return;
    }

    let player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) {
      player = this.createPlayer(guildId, { accountId: identifier, ownerId });
    }
    player.volume = clamped;

    const filtersPayload = this.buildFiltersPayload(player);

    if (player.userId) {
      try {
        await this.sendPlayerUpdate(guildId, {
          volume: masterVol,
          filters: filtersPayload
        }, player.userId);
      } catch (e) {}
    }

    logger.success('MUSIC', `Set volume in guild ${guildId} to ${clamped}% (Master: ${masterVol}, Multiplier: ${filtersPayload.volume}x)`);
    this.emit('playerUpdate', player);
  }

  async seek(guildId, positionMs, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player || !player.currentTrack) return;

    await this.sendPlayerUpdate(guildId, { position: positionMs }, player.userId);
    player.position = positionMs;
    this.emit('playerUpdate', player);
  }

  setLoop(guildId, mode, identifier = null, ownerId = null) {
    let cleanMode = mode;
    if (cleanMode === 'none' || cleanMode === false || cleanMode === '0') cleanMode = 'off';
    if (!['off', 'track', 'queue'].includes(cleanMode)) return;

    if (!identifier || identifier === 'ALL_BOTS') {
      for (const [, p] of this.players.entries()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.loop = cleanMode;
          this.emit('playerUpdate', p);
        }
      }
    } else {
      const player = this.getPlayer(guildId, identifier, ownerId);
      if (player) {
        player.loop = cleanMode;
        this.emit('playerUpdate', player);
      }
    }
  }

  async applyFilters(guildId, filterName, enabled, identifier = null, ownerId = null) {
    if (!identifier || identifier === 'ALL_BOTS') {
      for (const p of this.players.values()) {
        if (p.guildId === guildId && (!ownerId || p.ownerId === ownerId)) {
          p.filters[filterName] = enabled;
          const filtersPayload = this.buildFiltersPayload(p);
          if (p.userId) {
            this.sendPlayerUpdate(guildId, {
              volume: this.calculateMasterVolume(p.volume),
              filters: filtersPayload
            }, p.userId).catch(() => {});
          }
          this.emit('playerUpdate', p);
        }
      }
      logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] across all bots for guild ${guildId}`);
      return;
    }

    let player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) {
      player = this.createPlayer(guildId, { accountId: identifier, ownerId });
    }

    player.filters[filterName] = enabled;
    const filtersPayload = this.buildFiltersPayload(player);

    if (player.userId) {
      try {
        await this.sendPlayerUpdate(guildId, {
          volume: this.calculateMasterVolume(player.volume),
          filters: filtersPayload
        }, player.userId);
      } catch (e) {}
    }

    logger.success('MUSIC', `Updated filter [${filterName}=${enabled}] in guild ${guildId} (Loudness: ${filtersPayload.volume}x)`);
    this.emit('playerUpdate', player);
  }

  removeQueueTrack(guildId, index, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player || !player.queue[index]) return;

    const removed = player.queue.splice(index, 1)[0];
    this.emit('queueUpdate', player);
    return removed;
  }

  clearQueue(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    player.queue = [];
    this.emit('queueUpdate', player);
  }

  async destroyPlayer(guildId, identifier = null, ownerId = null) {
    const player = this.getPlayer(guildId, identifier, ownerId);
    if (!player) return;

    try {
      const session = this.getSessionForUser(player.userId);
      if (session && session.sessionId) {
        const path = `/v4/sessions/${session.sessionId}/players/${guildId}`;
        await this.apiRequest(path, 'DELETE');
      }
    } catch (e) {}

    if (player.playerKey) this.players.delete(player.playerKey);
    if (player.accountId) this.players.delete(`${guildId}:${player.accountId}`);
    if (player.userId) this.players.delete(`${guildId}:${player.userId}`);
    if (this.players.get(guildId) === player) {
      this.players.delete(guildId);
      for (const p of this.players.values()) {
        if (p.guildId === guildId) {
          this.players.set(guildId, p);
          break;
        }
      }
    }
    this.emit('playerDestroy', { guildId, accountId: player.accountId, ownerId: player.ownerId });
  }

  // --- Precision Millisecond-Accurate Auto-Sync Engine ---
  startAutoSyncLoop() {
    if (this._syncInterval) clearInterval(this._syncInterval);
    this._syncInterval = null;
  }

  async syncActivePlayers() {
    // Disabled: Mid-song seeking flushes player buffers and causes stuttering.
    // Audio sync is maintained cleanly by synchronized startup without drift.
  }
}

module.exports = LavalinkClient;
