const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');

// Configure ffmpeg for Discord audio streaming
try {
  const ffmpeg = require('ffmpeg-static');
  if (ffmpeg) {
    process.env.FFMPEG_PATH = ffmpeg;
  }
} catch (e) {
  logger.warn('VOICE_ENGINE', `ffmpeg-static require note: ${e.message}`);
}

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior
} = require('@discordjs/voice');

class VoiceMusicEngine extends EventEmitter {
  constructor() {
    super();
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.currentResource = null;
    this.currentTrack = null;
    this.currentLoop = false;
    this.volumePercent = 10000;
    this.volumeMultiplier = 5.0;
    this.connections = new Map(); // accountId -> VoiceConnection
    this.startTime = null;
    this.pausedAt = null;
    this.isPaused = false;
    this.isPlaying = false;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      if (this.currentLoop && this.currentTrack && this.currentTrack.source) {
        logger.info('VOICE_ENGINE', `Looping track: ${this.currentTrack.title}`);
        this.play(this.currentTrack.source, {
          title: this.currentTrack.title,
          volume: this.volumePercent,
          loop: true,
          guildId: this.currentTrack.guildId,
          channelId: this.currentTrack.channelId
        });
      } else {
        this.emit('trackEnd', { track: this.currentTrack });
      }
    });

    this.player.on('error', err => {
      logger.error('VOICE_ENGINE', `Audio player error: ${err.message}`);
      this.emit('error', err);
    });
  }

  get connectedCount() {
    return this.connections.size;
  }

  // Connect a bot account to Discord voice
  async connectBot(accountId, client, guildId, channelId) {
    if (!client || !client.user) {
      logger.warn('VOICE_ENGINE', `Client not ready for bot ${accountId}`);
      return null;
    }

    try {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild || !guild.voiceAdapterCreator) {
        logger.warn('VOICE_ENGINE', `Bot [${client.user.tag || accountId}] cannot access guild ${guildId} or voice adapter creator missing`);
        return null;
      }

      // Explicitly tell Discord Gateway to enter VC unmuted
      try {
        if (client.ws && client.ws.shards) {
          client.ws.shards.first()?.send({
            op: 4,
            d: {
              guild_id: guildId,
              channel_id: channelId,
              self_mute: false,
              self_deaf: false
            }
          });
        }
      } catch (e) {}

      // Destroy existing connection for this account if any
      const existing = this.connections.get(accountId);
      if (existing) {
        try { existing.destroy(); } catch (e) {}
      }

      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      this.connections.set(accountId, connection);
      connection.subscribe(this.player);

      connection.on(VoiceConnectionStatus.Ready, () => {
        logger.success('VOICE_ENGINE', `✓ Bot [${client.user.tag || accountId}] VOICE READY in VC ${channelId}! Audio player synced.`);
        try { connection.subscribe(this.player); } catch (e) {}
      });

      connection.on('error', err => {
        logger.warn('VOICE_ENGINE', `Bot [${client.user.tag || accountId}] voice error: ${err.message}`);
      });

      return connection;
    } catch (err) {
      logger.error('VOICE_ENGINE', `Voice join error for [${accountId}]: ${err.message}`);
      return null;
    }
  }

  // Disconnect a bot from voice
  disconnectBot(accountId) {
    const conn = this.connections.get(accountId);
    if (conn) {
      try { conn.destroy(); } catch (e) {}
      this.connections.delete(accountId);
      logger.info('VOICE_ENGINE', `Bot [${accountId}] disconnected from voice.`);
    }
  }

  // Disconnect all bots from voice
  disconnectAll() {
    for (const [id, conn] of this.connections.entries()) {
      try { conn.destroy(); } catch (e) {}
    }
    this.connections.clear();
    this.stop();
  }

  // Play audio track (local file path or remote stream URL) through FFmpeg
  async play(source, options = {}) {
    try {
      // Re-subscribe all active connections
      for (const [id, conn] of this.connections.entries()) {
        try { conn.subscribe(this.player); } catch (e) {}
      }

      const volumePercent = options.volume !== undefined ? options.volume : this.volumePercent;
      this.volumePercent = volumePercent;
      
      // Clean non-distorting volume multiplier (100% = 1.0, 10000% = 5.0, 20000% = 10.0)
      this.volumeMultiplier = Math.max(0.1, Math.min(volumePercent / 2000, 12.0));

      const resource = createAudioResource(source, {
        inlineVolume: true
      });

      if (resource.volume) {
        resource.volume.setVolume(this.volumeMultiplier);
      }

      this.currentResource = resource;
      this.currentTrack = {
        title: options.title || (typeof source === 'string' ? path.basename(source) : 'Audio Track'),
        source,
        guildId: options.guildId || null,
        channelId: options.channelId || null,
        startedAt: Date.now()
      };
      this.currentLoop = !!options.loop;
      this.startTime = Date.now();
      this.isPaused = false;
      this.isPlaying = true;

      this.player.play(resource);
      logger.success('VOICE_ENGINE', `🎵 Playing audio: "${this.currentTrack.title}" through ALL ${this.connections.size} bot(s) simultaneously! (Volume: ${this.volumePercent}% / ${this.volumeMultiplier.toFixed(2)}x)`);
      this.emit('trackStart', { track: this.currentTrack });
      return { success: true, track: this.currentTrack };
    } catch (err) {
      logger.error('VOICE_ENGINE', `Play failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // Set playback volume on the fly without digital clipping
  setVolume(volumePercent) {
    this.volumePercent = Math.max(1, Math.min(Number(volumePercent) || 100, 20000));
    this.volumeMultiplier = Math.max(0.1, Math.min(this.volumePercent / 2000, 12.0));
    
    if (this.currentResource && this.currentResource.volume) {
      this.currentResource.volume.setVolume(this.volumeMultiplier);
      logger.info('VOICE_ENGINE', `Live volume updated: ${this.volumePercent}% (${this.volumeMultiplier.toFixed(2)}x)`);
    }
    return this.volumePercent;
  }

  // Pause playback
  pause() {
    if (this.player) {
      this.player.pause();
      this.isPaused = true;
      logger.info('VOICE_ENGINE', 'Playback paused.');
      return true;
    }
    return false;
  }

  // Resume playback
  resume() {
    if (this.player) {
      this.player.unpause();
      this.isPaused = false;
      this.isPlaying = true;
      logger.info('VOICE_ENGINE', 'Playback resumed.');
      return true;
    }
    return false;
  }

  // Stop playback
  stop() {
    this.currentLoop = false;
    this.currentTrack = null;
    this.currentResource = null;
    this.isPlaying = false;
    this.isPaused = false;
    if (this.player) {
      this.player.stop();
      logger.info('VOICE_ENGINE', 'Playback stopped.');
    }
    return true;
  }

  // Set loop mode
  setLoop(enabled) {
    this.currentLoop = !!enabled;
    logger.info('VOICE_ENGINE', `Loop mode: ${this.currentLoop ? 'ENABLED' : 'DISABLED'}`);
    return this.currentLoop;
  }

  // Get status for dashboard
  getStatus(guildId = null) {
    const elapsed = (this.isPlaying && this.startTime && !this.isPaused) ? (Date.now() - this.startTime) : 0;
    return {
      guildId,
      playing: this.isPlaying,
      paused: this.isPaused,
      volume: this.volumePercent,
      volumeMultiplier: this.volumeMultiplier,
      position: elapsed,
      loop: this.currentLoop ? 'track' : 'off',
      connected: this.connections.size > 0,
      connectedCount: this.connections.size,
      currentTrack: this.currentTrack ? {
        encoded: null,
        info: {
          title: this.currentTrack.title,
          author: 'FFmpeg Audio System',
          length: 0,
          identifier: this.currentTrack.title,
          isSeekable: false,
          isStream: true,
          uri: typeof this.currentTrack.source === 'string' ? this.currentTrack.source : ''
        }
      } : null
    };
  }
}

// Singleton export
module.exports = new VoiceMusicEngine();
