'use strict';

/**
 * clearCommands.js — Standalone script to clean up previously registered Discord application commands
 * 
 * Usage:
 *   node clearCommands.js
 */

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── .env support ─────────────────────────────────────────────────────────────
const envFilePath = path.join(__dirname, '.env');
if (fs.existsSync(envFilePath)) {
  for (const line of fs.readFileSync(envFilePath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*["']?(.*?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// ── Load config ──────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {
  config = {};
}

// Override with env
const envMap = {
  DISCORD_TOKEN:     'discordToken',
  DISCORD_CLIENT_ID: 'discordClientId',
  GUILD_ID:          'guildId',
};
for (const [envKey, cfgKey] of Object.entries(envMap)) {
  if (process.env[envKey] !== undefined) config[cfgKey] = process.env[envKey];
}

const token = config.discordToken;
const clientId = config.discordClientId;
const guildId = config.guildId;

if (!token || token === 'SET_VIA_RAILWAY_ENV') {
  console.error('❌ Error: DISCORD_TOKEN is missing or not set.');
  process.exit(1);
}

if (!clientId || clientId === 'SET_VIA_RAILWAY_ENV') {
  console.error('❌ Error: DISCORD_CLIENT_ID is missing or not set.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  console.log('🧹 Starting cleanup of registered Discord application slash commands...');

  // 1 — Clear guild-specific commands
  if (guildId && guildId !== 'SET_VIA_RAILWAY_ENV') {
    try {
      console.log(`[Guild] Clearing commands for guild: ${guildId}`);
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: [] }
      );
      console.log('✅ Guild-specific commands cleared successfully.');
    } catch (err) {
      console.error(`❌ Failed to clear guild commands: ${err.message}`);
    }
  } else {
    console.log('[Guild] No GUILD_ID specified, skipping guild command cleanup.');
  }

  // 2 — Clear global commands
  try {
    console.log('[Global] Clearing global commands...');
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: [] }
    );
    console.log('✅ Global commands cleared successfully.');
  } catch (err) {
    console.error(`❌ Failed to clear global commands: ${err.message}`);
  }

  console.log('🎉 Cleanup complete. Run your bot normal to re-register the active commands.');
})();
