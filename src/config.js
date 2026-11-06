const path = require('path');
require('dotenv').config();

function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase().trim());
}

const lavalinkNodes = [
  {
    name: process.env.NODE_NAME || "MilloHost V4 (SSL Fast)",
    host: "lava-v4.millohost.my.id",
    port: 443,
    url: process.env.NODE_URL || "lava-v4.millohost.my.id:443",
    auth: process.env.NODE_AUTH || "https://discord.gg/mjS5J2K3ep",
    secure: parseBoolean(process.env.NODE_SECURE || "true"),
    version: 4
  }
];

module.exports = {
  port: parseInt(process.env.SERVER_PORT || process.env.PORT || '24681', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.join(__dirname, '..', 'data'),
  sqliteFile: path.join(__dirname, '..', 'data', 'exc.sqlite'),
  accountsFile: path.join(__dirname, '..', 'data', 'accounts.json'),
  settingsFile: path.join(__dirname, '..', 'data', 'settings.json'),
  uploadsFile: path.join(__dirname, '..', 'data', 'uploaded_songs.json'),
  
  // Default Discord Proxy
  defaultProxy: null,

  // Only the user's active Lavalink node
  nodes: lavalinkNodes,

  // Default active Lavalink node
  defaultNode: {
    url: process.env.NODE_URL || "lava-v4.millohost.my.id:443",
    name: process.env.NODE_NAME || "MilloHost V4 (SSL Fast)",
    auth: process.env.NODE_AUTH || "https://discord.gg/mjS5J2K3ep",
    secure: parseBoolean(process.env.NODE_SECURE || "true"),
    host: "lava-v4.millohost.my.id",
    port: 443,
    version: 4
  },
  
  parseBoolean
};
