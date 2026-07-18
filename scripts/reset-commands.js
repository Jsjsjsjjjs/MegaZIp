'use strict';

/**
 * reset-commands.js — Standalone script to clean and re-register slash commands
 *
 * Usage:
 *   node scripts/reset-commands.js
 */

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Load environment variables if .env exists
const envFilePath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFilePath)) {
  for (const line of fs.readFileSync(envFilePath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*["']?(.*?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Load config.json
const configPath = path.join(__dirname, '..', 'config', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {
  console.log('config/config.json not found — using environment variables only.');
}

// Apply overrides
const token = process.env.DISCORD_TOKEN || config.discordToken;
const clientId = process.env.DISCORD_CLIENT_ID || config.discordClientId;
const guildId = process.env.GUILD_ID || config.guildId;

if (!token) {
  console.error('ERROR: DISCORD_TOKEN is not configured.');
  process.exit(1);
}
if (!clientId) {
  console.error('ERROR: DISCORD_CLIENT_ID is not configured.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

async function reset() {
  console.log('🔄 Cleaning up slash commands...');

  // 1. Clear guild commands if guildId is provided
  if (guildId && guildId !== 'SET_VIA_RAILWAY_ENV') {
    try {
      console.log(`🧹 Clearing guild commands for guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
      console.log('✅ Guild commands cleared.');
    } catch (err) {
      console.error(`⚠️ Failed to clear guild commands: ${err.message}`);
    }
  }

  // 2. Clear global commands
  try {
    console.log('🧹 Clearing global commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('✅ Global commands cleared.');
  } catch (err) {
    console.error(`⚠️ Failed to clear global commands: ${err.message}`);
  }

  // 3. Register the new commands
  console.log('📝 Registering new command definitions...');
  try {
    const { registerCommands } = require('../src/commandHandler');
    
    // Inject loaded variables into config object for registerCommands
    const registerConfig = {
      discordToken: token,
      discordClientId: clientId,
      guildId: (guildId && guildId !== 'SET_VIA_RAILWAY_ENV') ? guildId : null
    };
    
    await registerCommands(registerConfig);
    console.log('🚀 Successfully re-registered all slash commands!');
  } catch (err) {
    console.error(`❌ Failed to register new commands: ${err.message}`);
  }
}

reset();
