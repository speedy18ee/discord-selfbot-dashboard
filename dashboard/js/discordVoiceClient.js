/**
 * EXC Real Discord Gateway Voice Client
 * Connects Discord bots directly to Discord Gateway & joins Voice Channels (Opcode 4)
 * Keeps bots in Voice Channels 24/7 with automatic heartbeat and reconnection loops.
 */
(function() {
  window.activeDiscordVoiceSockets = window.activeDiscordVoiceSockets || new Map();

  function updateCardBadge(accountId, text, isConnected) {
    const card = document.getElementById(`voice-card-${accountId}`);
    if (!card) return;
    const badge = card.querySelector('.voice-card-profile .badge');
    if (badge) {
      badge.className = `badge ${isConnected ? 'badge-success' : 'badge-warning'}`;
      badge.textContent = text;
    }
    const connectBtn = card.querySelector('button[onclick*="connectVoiceDirect"]');
    const leaveBtn = card.querySelector('button[onclick*="disconnectVoiceDirect"]');
    if (connectBtn) connectBtn.disabled = isConnected;
    if (leaveBtn) leaveBtn.disabled = !isConnected;
  }

  window.connectBotToVoiceGateway = function(account, guildId, channelId, options = {}) {
    if (!account || !account.token) {
      console.warn('[VoiceGateway] Missing account or token for voice connect');
      return;
    }

    const accountId = account.id;
    const selfMute = !!options.selfMute;
    const selfDeaf = !!options.selfDeaf;
    const keep247 = options.keep247 !== false;
    const channelName = options.channelName || 'Voice Channel';

    // Disconnect existing socket for this account if any
    if (window.activeDiscordVoiceSockets.has(accountId)) {
      try {
        const old = window.activeDiscordVoiceSockets.get(accountId);
        if (old.heartbeatTimer) clearInterval(old.heartbeatTimer);
        if (old.reconnectTimer) clearTimeout(old.reconnectTimer);
        if (old.ws && old.ws.readyState === WebSocket.OPEN) old.ws.close();
      } catch (_) {}
      window.activeDiscordVoiceSockets.delete(accountId);
    }

    console.log(`[VoiceGateway] Connecting bot "${account.label}" to Discord Gateway for VC (${channelId})...`);
    updateCardBadge(accountId, 'Connecting to VC...', false);

    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    const sessionObj = {
      ws,
      accountId,
      account,
      guildId,
      channelId,
      channelName,
      options,
      heartbeatTimer: null,
      reconnectTimer: null,
      lastSeq: null,
      isJoined: false,
      intentionalClose: false
    };

    window.activeDiscordVoiceSockets.set(accountId, sessionObj);

    ws.onopen = () => {
      console.log(`[VoiceGateway] Connected to Discord Gateway WebSocket for ${account.label}`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.s) sessionObj.lastSeq = msg.s;

        // Opcode 10: Hello -> start heartbeat & identify
        if (msg.op === 10) {
          const interval = msg.d.heartbeat_interval || 41250;
          sessionObj.heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: sessionObj.lastSeq }));
            }
          }, interval);

          // Send immediate first heartbeat
          ws.send(JSON.stringify({ op: 1, d: null }));

          // Send Opcode 2: Identify
          const cleanToken = account.token.trim().replace(/^"|"$/g, '');
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: cleanToken,
              capabilities: 30717,
              properties: {
                os: 'Windows',
                browser: 'Chrome',
                device: ''
              },
              presence: {
                status: 'online',
                since: 0,
                activities: [{ name: '24/7 Voice', type: 0 }],
                afk: false
              }
            }
          }));
        }

        // Opcode 0: Dispatch Events
        if (msg.op === 0) {
          if (msg.t === 'READY') {
            console.log(`[VoiceGateway] ${account.label} is READY on Discord! Sending Opcode 4 (Voice State Update)...`);
            // Send Voice State Update
            ws.send(JSON.stringify({
              op: 4,
              d: {
                guild_id: guildId,
                channel_id: channelId,
                self_mute: selfMute,
                self_deaf: selfDeaf
              }
            }));
          }

          if (msg.t === 'VOICE_STATE_UPDATE') {
            const currentUserId = account.user?.id || (sessionObj.wsUser && sessionObj.wsUser.id);
            if (!currentUserId || msg.d.user_id === currentUserId) {
              if (msg.d.channel_id) {
                sessionObj.isJoined = true;
                console.log(`[VoiceGateway] 🎉 ${account.label} successfully sitting in VC (${msg.d.channel_id})!`);
                updateCardBadge(accountId, `In Channel: ${channelName}`, true);
                if (window.showToast) {
                  window.showToast(`🔊 [${account.label}] Real Voice Active in "${channelName}"!`, 'success');
                }
              } else {
                // Disconnected or moved to null
                sessionObj.isJoined = false;
                console.log(`[VoiceGateway] ${account.label} disconnected from voice on Discord.`);
                if (keep247 && !sessionObj.intentionalClose) {
                  updateCardBadge(accountId, 'Reconnecting (24/7)...', false);
                  sessionObj.reconnectTimer = setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                      console.log(`[VoiceGateway] 24/7 Auto-Rejoining VC for ${account.label}...`);
                      ws.send(JSON.stringify({
                        op: 4,
                        d: {
                          guild_id: guildId,
                          channel_id: channelId,
                          self_mute: selfMute,
                          self_deaf: selfDeaf
                        }
                      }));
                    }
                  }, 2500);
                } else {
                  updateCardBadge(accountId, 'Not Connected', false);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[VoiceGateway] Message parse error:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn(`[VoiceGateway] Socket error for ${account.label}:`, err);
    };

    ws.onclose = () => {
      if (sessionObj.heartbeatTimer) clearInterval(sessionObj.heartbeatTimer);
      if (!sessionObj.intentionalClose && keep247) {
        console.log(`[VoiceGateway] Socket closed for ${account.label}, auto-reconnecting in 3s (24/7 active)...`);
        updateCardBadge(accountId, 'Reconnecting (24/7)...', false);
        sessionObj.reconnectTimer = setTimeout(() => {
          window.connectBotToVoiceGateway(account, guildId, channelId, options);
        }, 3000);
      } else {
        updateCardBadge(accountId, 'Not Connected', false);
      }
    };
  };

  window.disconnectBotFromVoiceGateway = function(accountId) {
    if (!window.activeDiscordVoiceSockets.has(accountId)) {
      updateCardBadge(accountId, 'Not Connected', false);
      return;
    }

    const session = window.activeDiscordVoiceSockets.get(accountId);
    session.intentionalClose = true;
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.send(JSON.stringify({
          op: 4,
          d: {
            guild_id: session.guildId,
            channel_id: null,
            self_mute: false,
            self_deaf: false
          }
        }));
      } catch (_) {}
      setTimeout(() => {
        try { session.ws.close(); } catch (_) {}
      }, 500);
    }

    window.activeDiscordVoiceSockets.delete(accountId);
    updateCardBadge(accountId, 'Not Connected', false);
    console.log(`[VoiceGateway] Cleanly disconnected bot ${accountId} from Discord voice.`);
  };

  window.connectAllBotsToVoiceGateway = function(guildId, channelId, options = {}) {
    if (!window.state || !Array.isArray(window.state.accounts)) return;
    console.log(`[VoiceGateway] Connecting ALL ${window.state.accounts.length} bots to voice channel ${channelId}...`);
    window.state.accounts.forEach((acc, idx) => {
      setTimeout(() => {
        window.connectBotToVoiceGateway(acc, guildId, channelId, options);
      }, idx * 600); // 600ms stagger between bots for Discord safety
    });
  };

  window.disconnectAllBotsFromVoiceGateway = function() {
    if (!window.state || !Array.isArray(window.state.accounts)) return;
    window.state.accounts.forEach(acc => {
      window.disconnectBotFromVoiceGateway(acc.id);
    });
  };

  // Resume any active 24/7 connections on page load
  window.resumeActiveVoiceConnections = function() {
    if (!window.state || !Array.isArray(window.state.accounts)) return;
    window.state.accounts.forEach(acc => {
      const v = acc.voice247 || acc.currentVoice;
      if (v && v.enabled !== false && v.channelId && v.guildId) {
        console.log(`[VoiceGateway] Resuming saved 24/7 voice for ${acc.label}...`);
        window.connectBotToVoiceGateway(acc, v.guildId, v.channelId, {
          selfMute: !!v.selfMute,
          selfDeaf: !!v.selfDeaf,
          keep247: true,
          channelName: v.channelName || 'Voice Channel'
        });
      }
    });
  };
})();
