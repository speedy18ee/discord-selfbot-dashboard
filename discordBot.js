const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'botConfig.json');
const LICENSES_PATH = path.join(__dirname, 'licenses.json');
const OWNER_ID = '1527609131043917874';

let config = {
  botToken: "",
  discordServer: "https://discord.gg/5Tzs2ny4u5",
  noPrefix: true
};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  }
} catch (e) {}

const token = process.env.DISCORD_BOT_TOKEN || config.botToken;

function generateLicenseKey(tier = 'standard') {
  const segment1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const segment2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  if (tier === 'premium') {
    return `SPY-PREM-${segment1}-${segment2}`;
  }
  const segment3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SPY-${segment1}-${segment2}-${segment3}`;
}

function saveNewKey(key, userId = 'manual', tag = '', tier = 'standard', maxAccounts = 4) {
  let list = [];
  try {
    if (fs.existsSync(LICENSES_PATH)) {
      list = JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
    }
  } catch (e) {
    list = [];
  }
  const entry = {
    key,
    createdAt: new Date().toISOString(),
    used: false,
    usedBy: userId,
    userTag: tag,
    tier,
    maxAccounts,
    hwid: null,
    hwidBoundAt: null
  };
  list.push(entry);
  fs.writeFileSync(LICENSES_PATH, JSON.stringify(list, null, 2));
  return entry;
}

let client = null;

function startBot() {
  if (!token) {
    console.error('[SPY WEB Bot] Error: Missing bot token in botConfig.json');
    return null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  client.on('clientReady', () => {
    console.log('====================================================');
    console.log(`  SPY WEB DISCORD BOT ONLINE: ${client.user.tag}`);
    console.log('  Mode: NO PREFIX FOR EVERYONE');
    console.log('  Trigger commands: "key", "getkey", "license"');
    console.log(`  Official Discord Server: ${config.discordServer}`);
    console.log('====================================================');

    try {
      client.user.setActivity('for "key" | SPY WEB', { type: ActivityType.Watching });
    } catch (e) {}
  });

  client.on('error', err => {
    console.warn('[SPY WEB Bot] Client error:', err?.message || err);
  });

  client.on('shardError', err => {
    console.warn('[SPY WEB Bot] Shard error:', err?.message || err);
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const raw = message.content.trim().toLowerCase();
    const clean = raw.replace(/^[!/.?#$]+/, '').trim();

    // 1. FREE KEY TRIGGERS (Available to everyone, 4 accounts limit)
    const isFreeTrigger = (
      clean === 'key' ||
      clean === 'getkey' ||
      clean === 'get key' ||
      clean === 'license' ||
      clean === 'get license' ||
      clean === 'genkey' ||
      clean === 'freekey' ||
      clean === 'free key' ||
      clean === 'free' ||
      raw === 'key' ||
      raw === 'getkey' ||
      raw === 'license'
    );

    // 2. PREMIUM KEY TRIGGERS (Reserved exclusively for Owner ID 1527609131043917874, 30 accounts limit)
    const isPremiumTrigger = (
      clean === 'premium' ||
      clean === 'premkey' ||
      clean === 'prem key' ||
      clean === 'premiumkey' ||
      clean === 'premium key' ||
      clean === 'vipkey' ||
      clean === 'vip key' ||
      clean === 'vip' ||
      clean === 'prem' ||
      raw === 'premium' ||
      raw === 'prem'
    );

    const serverLink = config.discordServer || 'https://discord.gg/5Tzs2ny4u5';
    const isOwner = String(message.author.id).trim() === OWNER_ID;

    // Tokenized Arguments
    const parts = message.content.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/^[!/.?#$]+/, '');
    const args = parts.slice(1);

    // ========================================================
    // OWNER COMMAND 1: Reset HWID (1-Device Lock Reset)
    // Commands: resethwid <key>, reset-hwid <key>, !resethwid <key>
    // ========================================================
    const isResetHwidCmd = (cmd === 'resethwid' || cmd === 'reset-hwid' || cmd === 'resethw');
    if (isResetHwidCmd) {
      if (!isOwner) {
        console.warn(`[SPY WEB Bot] Non-owner @${message.author.username} (${message.author.id}) attempted to run resethwid - STRICTLY BLOCKED.`);
        const deniedEmbed = new EmbedBuilder()
          .setColor(0xEF4444)
          .setTitle('⛔ Access Denied — Owner Only')
          .setDescription(`Only the authorized Bot Owner (<@${OWNER_ID}>) can reset HWID device locks.\n\nYour User ID: \`${message.author.id}\`\nAuthorized Owner: \`${OWNER_ID}\``)
          .setFooter({ text: 'SPY WEB • Security Protocol • Unauthorized Attempt Logged' })
          .setTimestamp();
        return message.reply({ embeds: [deniedEmbed] });
      }

      const targetKey = (args[0] || '').trim().toUpperCase();
      if (!targetKey) {
        return message.reply('⚠️ **Usage:** `resethwid <license_key>`\nExample: `resethwid SPY-PREM-2A68-5041`');
      }

      let list = [];
      try {
        if (fs.existsSync(LICENSES_PATH)) {
          list = JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
        }
      } catch (e) { list = []; }

      const found = list.find(l => l.key.toUpperCase() === targetKey);
      if (!found) {
        return message.reply(`❌ **License Key Not Found:** \`${targetKey}\` does not exist in the database.`);
      }

      const prevHwid = found.hwid || 'None (Was already unlocked)';
      found.hwid = null;
      found.hwidBoundAt = null;
      found.hwidResetAt = new Date().toISOString();
      found.hwidResetBy = message.author.id;
      fs.writeFileSync(LICENSES_PATH, JSON.stringify(list, null, 2));

      const resetEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle('🔓 HWID Reset Successful')
        .setDescription(`Device lock for key **\`${found.key}\`** has been cleared! The key can now be activated on a new device.`)
        .addFields(
          { name: '🔑 License Key', value: `\`${found.key}\``, inline: true },
          { name: '📱 Cleared HWID', value: `\`${prevHwid}\``, inline: true },
          { name: '👥 Account Limit', value: `**${found.maxAccounts || 4} Accounts**`, inline: true },
          { name: '⚡ Lock Status', value: '🟢 **UNLOCKED** — Will automatically bind to the next device upon login.', inline: false }
        )
        .setFooter({ text: `SPY WEB • HWID Management • Authorized by Owner (${OWNER_ID})` })
        .setTimestamp();

      console.log(`[SPY WEB Bot] Owner @${message.author.username} reset HWID for key ${found.key}`);
      return message.reply({ embeds: [resetEmbed] });
    }

    // ========================================================
    // OWNER COMMAND 2: Set Account Limit (Any custom limit!)
    // Commands: setlimit <key> <limit>, !setlimit <key> <limit>, limit <key> <limit>
    // ========================================================
    const isSetLimitCmd = (cmd === 'setlimit' || cmd === 'set-limit' || cmd === 'limit' || cmd === 'setaccs' || cmd === 'setaccounts');
    if (isSetLimitCmd) {
      if (!isOwner) {
        console.warn(`[SPY WEB Bot] Non-owner @${message.author.username} (${message.author.id}) attempted to run setlimit - STRICTLY BLOCKED.`);
        const deniedEmbed = new EmbedBuilder()
          .setColor(0xEF4444)
          .setTitle('⛔ Access Denied — Owner Only')
          .setDescription(`Only the authorized Bot Owner (<@${OWNER_ID}>) can modify account limits.\n\nYour User ID: \`${message.author.id}\`\nAuthorized Owner: \`${OWNER_ID}\``)
          .setFooter({ text: 'SPY WEB • Security Protocol • Unauthorized Attempt Logged' })
          .setTimestamp();
        return message.reply({ embeds: [deniedEmbed] });
      }

      let targetKey = '';
      let targetLimit = 0;

      if (args.length >= 2) {
        if (/^\d+$/.test(args[0])) {
          targetLimit = parseInt(args[0], 10);
          targetKey = args[1].trim().toUpperCase();
        } else if (/^\d+$/.test(args[1])) {
          targetLimit = parseInt(args[1], 10);
          targetKey = args[0].trim().toUpperCase();
        }
      }

      if (!targetKey || !targetLimit || targetLimit < 1) {
        return message.reply('⚠️ **Usage:** `setlimit <license_key> <account_limit>`\nExample: `setlimit SPY-PREM-2A68-5041 50`\n(Allows setting any number of accounts: 10, 50, 100, etc.)');
      }

      let list = [];
      try {
        if (fs.existsSync(LICENSES_PATH)) {
          list = JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
        }
      } catch (e) { list = []; }

      const found = list.find(l => l.key.toUpperCase() === targetKey);
      if (!found) {
        return message.reply(`❌ **License Key Not Found:** \`${targetKey}\` does not exist in the database.`);
      }

      const prevLimit = found.maxAccounts || 4;
      found.maxAccounts = targetLimit;
      if (targetLimit > 4) {
        found.tier = 'premium';
      }
      found.limitUpdatedAt = new Date().toISOString();
      found.limitUpdatedBy = message.author.id;
      fs.writeFileSync(LICENSES_PATH, JSON.stringify(list, null, 2));

      const limitEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle('⚙️ Account Limit Updated')
        .setDescription(`Account capacity for license **\`${found.key}\`** has been successfully updated!`)
        .addFields(
          { name: '🔑 License Key', value: `\`${found.key}\``, inline: true },
          { name: '👥 Previous Capacity', value: `${prevLimit} accounts`, inline: true },
          { name: '🚀 New Capacity', value: `**${targetLimit} Simultaneous Accounts**`, inline: true },
          { name: '⭐ Clearance Tier', value: `\`${(found.tier || 'standard').toUpperCase()}\``, inline: true },
          { name: '📱 HWID Device', value: found.hwid ? `\`${found.hwid}\`` : '🟢 Unlocked (Unbound)', inline: true }
        )
        .setFooter({ text: `SPY WEB • Capacity Control • Authorized by Owner (${OWNER_ID})` })
        .setTimestamp();

      console.log(`[SPY WEB Bot] Owner @${message.author.username} updated limit for ${found.key}: ${prevLimit} -> ${targetLimit}`);
      return message.reply({ embeds: [limitEmbed] });
    }

    // ========================================================
    // OWNER COMMAND 3: Generate Custom Key with Any Limit
    // Commands: createkey <limit>, customkey <limit>
    // ========================================================
    const isCreateKeyCmd = (cmd === 'createkey' || cmd === 'customkey' || cmd === 'makekey' || (cmd === 'genkey' && args.length > 0 && /^\d+$/.test(args[0])));
    if (isCreateKeyCmd) {
      if (!isOwner) {
        const deniedEmbed = new EmbedBuilder()
          .setColor(0xEF4444)
          .setTitle('⛔ Access Denied — Owner Only')
          .setDescription(`Only the authorized Bot Owner (<@${OWNER_ID}>) can generate custom capacity keys.`)
          .setFooter({ text: 'SPY WEB • Security Protocol' })
          .setTimestamp();
        return message.reply({ embeds: [deniedEmbed] });
      }

      const customLimit = parseInt(args[0] || '10', 10);
      if (!customLimit || customLimit < 1) {
        return message.reply('⚠️ **Usage:** `createkey <limit>`\nExample: `createkey 50` or `customkey 100`');
      }

      const tier = customLimit > 4 ? 'premium' : 'standard';
      const newKey = generateLicenseKey(tier);
      saveNewKey(newKey, message.author.id, message.author.tag || message.author.username, tier, customLimit);

      const customEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle('👑 Custom License Key Generated')
        .setDescription(`Created a custom **${customLimit}-Account** license key:`)
        .addFields(
          { name: '🔑 License Key', value: `\`\`\`${newKey}\`\`\`` },
          { name: '👥 Account Limit', value: `**${customLimit} Simultaneous Accounts**`, inline: true },
          { name: '⭐ Clearance Tier', value: `\`${tier.toUpperCase()}\``, inline: true },
          { name: '🔒 HWID Device Lock', value: '🟢 **Unbound** (will lock to the first device on login)', inline: false }
        )
        .setFooter({ text: `SPY WEB • Custom Generator • Authorized by Owner (${OWNER_ID})` })
        .setTimestamp();

      console.log(`[SPY WEB Bot] Owner generated custom key "${newKey}" with ${customLimit} accounts`);
      return message.reply({ embeds: [customEmbed] });
    }

    // ========================================================
    // OWNER COMMAND 4: Check Key Info & HWID Telemetry
    // Commands: keyinfo <key>, checkkey <key>, hwid <key>
    // ========================================================
    const isKeyInfoCmd = (cmd === 'keyinfo' || cmd === 'checkkey' || cmd === 'key-info' || cmd === 'hwidinfo' || cmd === 'hwid');
    if (isKeyInfoCmd) {
      if (!isOwner) {
        return message.reply(`⛔ Only the bot owner (<@${OWNER_ID}>) can check key telemetry.`);
      }
      const targetKey = (args[0] || '').trim().toUpperCase();
      if (!targetKey) {
        return message.reply('⚠️ **Usage:** `keyinfo <license_key>`\nExample: `keyinfo SPY-PREM-2A68-5041`');
      }

      let list = [];
      try {
        if (fs.existsSync(LICENSES_PATH)) {
          list = JSON.parse(fs.readFileSync(LICENSES_PATH, 'utf8'));
        }
      } catch (e) { list = []; }

      const found = list.find(l => l.key.toUpperCase() === targetKey);
      if (!found) {
        return message.reply(`❌ **License Key Not Found:** \`${targetKey}\``);
      }

      const infoEmbed = new EmbedBuilder()
        .setColor(found.hwid ? 0x3B82F6 : 0x10B981)
        .setTitle(`🔍 License Key Info: ${found.key}`)
        .addFields(
          { name: '🔑 Key', value: `\`${found.key}\``, inline: true },
          { name: '👥 Max Accounts', value: `**${found.maxAccounts || 4} Accounts**`, inline: true },
          { name: '⭐ Tier', value: `\`${(found.tier || 'standard').toUpperCase()}\``, inline: true },
          { name: '📱 HWID Device Lock', value: found.hwid ? `🔒 Locked to \`${found.hwid}\`` : '🟢 Unlocked (No device bound)', inline: false },
          { name: '⏱️ Bound At', value: found.hwidBoundAt ? `<t:${Math.floor(new Date(found.hwidBoundAt).getTime()/1000)}:R>` : 'Never', inline: true },
          { name: '👤 Issued To', value: found.usedBy ? `<@${found.usedBy}>` : 'Unassigned', inline: true }
        )
        .setFooter({ text: 'SPY WEB • Telemetry • Owner Authorized' })
        .setTimestamp();

      return message.reply({ embeds: [infoEmbed] });
    }

    // 1. Check if user is requesting a Premium Key
    if (isPremiumTrigger) {
      // STRICT CHECK: ONLY OWNER ID 1527609131043917874 CAN GET PREMIUM KEYS
      if (!isOwner) {
        console.log(`[SPY WEB Bot] Non-owner @${message.author.username} (${message.author.id}) attempted to get a premium key - STRICTLY BLOCKED.`);
        const deniedEmbed = new EmbedBuilder()
          .setColor(0xEF4444) // Red rejection
          .setTitle('⛔ Access Denied — Premium Key Restricted')
          .setDescription(`Premium **30-account** keys are strictly reserved for the authorized Owner (**${OWNER_ID}**).\n\nYou can claim your **Standard Free Key (4 accounts)** anytime by typing **\`key\`**!`)
          .addFields(
            {
              name: '🔑 Get Free Key',
              value: 'Type `key` or `getkey` right here in chat to receive your free license key (4 accounts).'
            },
            {
              name: '🌐 Official Discord Server',
              value: serverLink
            }
          )
          .setFooter({ text: 'SPY WEB • Owner 1527609131043917874 Authorization Required' })
          .setTimestamp();

        try {
          await message.reply({ embeds: [deniedEmbed] });
        } catch (e) {
          message.reply(`⛔ **Access Denied:** Premium 30-account keys are strictly reserved for Owner ID ${OWNER_ID}. Type \`key\` for a free 4-account key!`);
        }
        return;
      }

      // Owner Authorized! Generate Premium 30-account key
      const newPremKey = generateLicenseKey('premium');
      saveNewKey(newPremKey, message.author.id, message.author.tag || message.author.username, 'premium', 30);

      const premEmbed = new EmbedBuilder()
        .setColor(0x22C55E) // Radiant Emerald
        .setTitle('👑 SPY WEB — VIP Premium Key Granted')
        .setDescription(`Welcome back, Owner **${message.author.username}** (\`${OWNER_ID}\`)!\nHere is your exclusive **30-Account VIP License Key**:`)
        .addFields(
          {
            name: '🔑 Premium License Key',
            value: `\`\`\`${newPremKey}\`\`\``
          },
          {
            name: '⚡ Account Capacity',
            value: '**30 Simultaneous Accounts** (Full multi-voice broadcast, DSP audio amplifier)'
          },
          {
            name: '🛡️ Clearance Level',
            value: `\`OWNER EXCLUSIVE (${OWNER_ID})\``
          },
          {
            name: '🚀 Web Dashboard',
            value: `Open **http://localhost:3000** and paste your key to activate!`
          }
        )
        .setFooter({ text: 'SPY WEB • Premium 30-Account Clearance • Owner Only' })
        .setTimestamp();

      try {
        await message.reply({ embeds: [premEmbed] });
        console.log(`[SPY WEB Bot] Generated & issued PREMIUM 30-account key "${newPremKey}" to Owner @${message.author.username} (${message.author.id})`);
      } catch (err) {
        message.reply(`👑 **SPY WEB PREMIUM 30-ACCOUNT KEY:** \`${newPremKey}\`\nEnter at http://localhost:3000 to activate up to 30 accounts!`);
      }
      return;
    }

    // 2. Free / Standard Key Request
    if (isFreeTrigger) {
      // If the Owner types "key", give them a Premium 30-account key automatically!
      if (isOwner) {
        const newPremKey = generateLicenseKey('premium');
        saveNewKey(newPremKey, message.author.id, message.author.tag || message.author.username, 'premium', 30);

        const ownerAutoEmbed = new EmbedBuilder()
          .setColor(0x22C55E)
          .setTitle('👑 SPY WEB — Owner VIP Key Activated')
          .setDescription(`Owner recognized (**${message.author.username}**)! You have been automatically issued an exclusive **30-Account Premium Key**:`)
          .addFields(
            {
              name: '🔑 Your VIP Premium License Key',
              value: `\`\`\`${newPremKey}\`\`\``
            },
            {
              name: '⚡ Account Capacity',
              value: '**30 Simultaneous Accounts** (Owner clearance applied)'
            },
            {
              name: '🌐 Web Dashboard',
              value: `**http://localhost:3000**`
            }
          )
          .setFooter({ text: 'SPY WEB • Owner 30-Account Clearance' })
          .setTimestamp();

        try {
          await message.reply({ embeds: [ownerAutoEmbed] });
          console.log(`[SPY WEB Bot] Auto-issued PREMIUM 30-account key "${newPremKey}" to Owner @${message.author.username} (${message.author.id})`);
        } catch (e) {
          message.reply(`👑 **SPY WEB OWNER VIP KEY (30 ACCOUNTS):** \`${newPremKey}\``);
        }
        return;
      }

      // Standard user: Issue Free 4-account key
      const newFreeKey = generateLicenseKey('standard');
      saveNewKey(newFreeKey, message.author.id, message.author.tag || message.author.username, 'standard', 4);

      const replyEmbed = new EmbedBuilder()
        .setColor(0x10B981) // Clean Emerald / Mint
        .setTitle('⚡ SPY WEB — Free License Key Generated')
        .setDescription(`Hey **${message.author.username}**, here is your standard free license key to activate **SPY WEB**!`)
        .addFields(
          {
            name: '🔑 Your Free License Key',
            value: `\`\`\`${newFreeKey}\`\`\``
          },
          {
            name: '⚡ Account Capacity',
            value: '**4 Simultaneous Accounts** (Included with Free Standard Tier)'
          },
          {
            name: '🌐 Official Discord Server',
            value: `Join our server for updates & access:\n${serverLink}`
          },
          {
            name: '🚀 How to Activate',
            value: `1. Open SPY WEB: **http://localhost:3000**\n2. Paste your License Key: \`${newFreeKey}\`\n3. Click **Verify** to activate your 4 accounts!`
          }
        )
        .setFooter({ text: 'SPY WEB • Free Standard License • 4 Accounts Max' })
        .setTimestamp();

      try {
        await message.reply({ embeds: [replyEmbed] });
        console.log(`[SPY WEB Bot] Generated & issued free standard key "${newFreeKey}" to @${message.author.username} (${message.author.id})`);
      } catch (err) {
        message.reply(`⚡ **SPY WEB FREE LICENSE KEY:** \`${newFreeKey}\`\nJoin Server: ${serverLink}\nEnter this key on the website to activate up to 4 accounts!`);
      }
      return;
    }

    if (clean === 'help') {
      if (isOwner) {
        const ownerHelpEmbed = new EmbedBuilder()
          .setColor(0x22C55E)
          .setTitle('👑 SPY WEB Bot — Owner Control Center')
          .setDescription(`Welcome, Owner **${message.author.username}** (\`${OWNER_ID}\`)!\nHere are your administrative and management commands:`)
          .addFields(
            {
              name: '🔓 HWID 1-Device Lock Management',
              value: '• `resethwid <key>` — Clear device lock on a key so it can login on a new device.\n*Example:* `resethwid SPY-PREM-2A68-5041`'
            },
            {
              name: '👥 Custom Account Capacity Control',
              value: '• `setlimit <key> <number>` — Set any custom account limit for a key.\n*Example:* `setlimit SPY-PREM-2A68-5041 50`\n• `createkey <limit>` — Generate a new key with any account capacity.\n*Example:* `createkey 100`'
            },
            {
              name: '🔍 Key Telemetry & Info',
              value: '• `keyinfo <key>` — Inspect key capacity, HWID lock status, and issued details.\n*Example:* `keyinfo SPY-PREM-2A68-5041`'
            },
            {
              name: '👑 VIP Premium Key',
              value: '• `premium` — Generate an exclusive 30-account VIP key.'
            },
            {
              name: '⚡ Standard Free Key',
              value: '• `key` or `getkey` — Standard 4-account key.'
            }
          )
          .setFooter({ text: 'SPY WEB • Owner Authorized Controls' })
          .setTimestamp();

        try {
          await message.reply({ embeds: [ownerHelpEmbed] });
        } catch (e) {
          message.reply(`👑 **SPY WEB Owner Commands:**\n• \`resethwid <key>\` - Reset HWID lock\n• \`setlimit <key> <limit>\` - Change account capacity\n• \`createkey <limit>\` - Create custom key\n• \`keyinfo <key>\` - Key details\n• \`premium\` - VIP 30 key`);
        }
      } else {
        const userHelpEmbed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('⚡ SPY WEB Bot — Commands')
          .setDescription(`Welcome to **SPY WEB**!\n\n• Type **\`key\`** or **\`getkey\`** to receive your **Free License Key (4 Accounts)**\n• Type **\`help\`** to display this command menu\n\nOfficial Discord Server: ${config.discordServer}`)
          .setFooter({ text: 'SPY WEB • Discord Voice Operative Suite' })
          .setTimestamp();

        try {
          await message.reply({ embeds: [userHelpEmbed] });
        } catch (e) {
          message.reply(`⚡ **SPY WEB Commands:** Type **\`key\`** for a free license key.\nServer: ${config.discordServer}`);
        }
      }
      return;
    }
  });

  client.login(token).catch(err => {
    console.error('[SPY WEB Bot] Login error:', err.message);
  });

  return client;
}

if (require.main === module) {
  startBot();
}

module.exports = { startBot, generateLicenseKey, saveNewKey, getBotClient: () => client };
