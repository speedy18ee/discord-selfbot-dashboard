const path = require('path');
require('dotenv').config();

function parseBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (!val) return false;
  return ['true', '1', 'yes', 'on'].includes(String(val).toLowerCase().trim());
}

const lavalinkNodes = [
  {
    name: process.env.NODE_NAME || "Lava Lenin",
    host: "noi6.visihost.in",
    port: 25591,
    url: process.env.NODE_URL || "noi6.visihost.in:25591",
    auth: process.env.NODE_AUTH || "ganahubkl",
    secure: parseBoolean(process.env.NODE_SECURE || "false"),
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
    url: process.env.NODE_URL || "noi6.visihost.in:25591",
    name: process.env.NODE_NAME || "Lava Lenin",
    auth: process.env.NODE_AUTH || "ganahubkl",
    secure: parseBoolean(process.env.NODE_SECURE || "false"),
    host: "noi6.visihost.in",
    port: 25591,
    version: 4
  },
  
  parseBoolean
};
