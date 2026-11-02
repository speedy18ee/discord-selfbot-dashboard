const fs = require('fs');
const path = require('path');

// 1. Permanently patch ClientUserSettingManager.js on disk if unpatched
try {
  const filePath = path.join(__dirname, '..', 'node_modules', 'discord.js-selfbot-v13', 'src', 'managers', 'ClientUserSettingManager.js');
  if (fs.existsSync(filePath)) {
    let code = fs.readFileSync(filePath, 'utf8');
    const buggyTarget = "if ('friend_source_flags' in data) {";
    const fixedReplacement = "if ('friend_source_flags' in data && data.friend_source_flags) {";
    
    if (code.includes(buggyTarget)) {
      code = code.replace(buggyTarget, fixedReplacement);
      fs.writeFileSync(filePath, code, 'utf8');
    }
  }
} catch (err) {}

// 2. Bypass unauthenticated GET /api/v9/gateway to prevent Discord/Cloudflare 429 rate limit
try {
  const WebSocketManager = require('discord.js-selfbot-v13/src/client/websocket/WebSocketManager');
  const { Collection } = require('@discordjs/collection');
  const WebSocketShard = require('discord.js-selfbot-v13/src/client/websocket/WebSocketShard');

  WebSocketManager.prototype.connect = async function() {
    const gatewayURL = 'wss://gateway.discord.gg';
    this.gateway = gatewayURL + '/';
    let { shards } = this.client.options;
    if (shards === 'auto') {
      this.totalShards = this.client.options.shardCount = 1;
      shards = this.client.options.shards = [0];
    }
    this.totalShards = Array.isArray(shards) ? shards.length : shards;
    this.shards = new Collection();
    this.shardQueue = new Set(shards.map(id => new WebSocketShard(this, id)));
    return this.createShards();
  };
} catch (err) {}

// 3. Ensure per-client proxy agent isolation in REST requests
try {
  const APIRequest = require('discord.js-selfbot-v13/src/rest/APIRequest');
  const { getProxyObject } = require('discord.js-selfbot-v13/src/util/Util');
  const origMake = APIRequest.prototype.make;
  APIRequest.prototype.make = function(captchaKey, captchaRqtoken) {
    if (this.client.options.proxy && typeof this.client.options.proxy === 'string' && this.client.options.proxy.length > 0) {
      this.options.agent = getProxyObject(this.client.options.proxy);
    }
    return origMake.call(this, captchaKey, captchaRqtoken);
  };
} catch (err) {}

module.exports = true;
