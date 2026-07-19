'use strict';

/**
 * commandHandler.js — Slash command registration and dispatch
 *
 * Commands (all owner-only):
 *   /check    — Scan a MEGA link via VirusTotal (URL rep + file hash)
 *   /regen    — Regenerate a new MEGA link for a channel and edit its post
 *   /mirror   — Control the mirror engine (start / stop / status)
 *   /pipeline — Control the download queue (pause / resume / cancel)
 *   /status   — Show pipeline summary
 *   /settemplate   — Update the message template
 *   /toggleembed   — Switch between plain text and embed mode
 *   /updateposts   — Re-render all tracked posts with current template
 *   /invalidatesession — Clear saved MEGA session (use after password change)
 */

const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const { getAllStates, getLogs }   = require('./stateStore');
const { editZipMessage }          = require('./webhookSender');
const { scanUrl, getFileReport, getFileSha256 } = require('./virusTotal');
const { invalidateSession }       = require('./megaUploader');

const configPath = path.join(__dirname, '..', 'config', 'config.json');

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_DEFS = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current pipeline summary (owner only)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('settemplate')
    .setDescription('Update the message template (owner only)')
    .addStringOption((o) =>
      o.setName('template').setDescription('Template string — use {name}, {link}, {password}').setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('toggleembed')
    .setDescription('Switch between plain-text and rich embed message mode (owner only)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('updateposts')
    .setDescription('Re-render all tracked posts with the current template (owner only)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Scan a MEGA link via VirusTotal — URL reputation + file hash (owner only)')
    .addChannelOption((o) =>
      o.setName('channel')
        .setDescription('Discord channel that contains the MEGA link to scan')
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption((o) =>
      o.setName('link').setDescription('Paste a MEGA link directly instead of picking a channel')
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('regen')
    .setDescription('Generate a fresh MEGA link for a channel and update its post (owner only)')
    .addChannelOption((o) =>
      o.setName('channel')
        .setDescription('The channel whose file link should be regenerated')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('mirror')
    .setDescription('Control the mirror engine (owner only)')
    .addStringOption((o) =>
      o.setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: '▶ Start scanning', value: 'start' },
          { name: '⏹ Stop engine',    value: 'stop'  },
          { name: '📊 Show status',   value: 'status'}
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pipeline')
    .setDescription('Control the download / upload queue (owner only)')
    .addStringOption((o) =>
      o.setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: '⏸ Pause queue',   value: 'pause'  },
          { name: '▶ Resume queue',  value: 'resume' },
          { name: '⏹ Cancel all',   value: 'cancel' }
        )
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('invalidatesession')
    .setDescription('Clear the saved MEGA session — forces a fresh login next upload (use after password change)')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('dcheck')
    .setDescription('Find and delete duplicate channels — keeps the one with messages, deletes the rest (owner only)')
    .addBooleanOption((o) =>
      o.setName('dryrun')
        .setDescription('Preview what would be deleted without actually deleting (default: false)')
    )
    .toJSON(),
];

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers slash commands with Discord.
 * - Guild commands: instant update in the target guild.
 * - Global commands: propagate to every server over time (up to 1 h cache).
 */
async function registerCommands(config) {
  if (!config.discordClientId) {
    throw new Error('discordClientId is not set — cannot register slash commands.');
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  // 1 — Guild-specific (instant)
  if (config.guildId) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(config.discordClientId, config.guildId),
        { body: COMMAND_DEFS }
      );
      console.log(`[commandHandler] Guild commands registered for guild ${config.guildId}`);
    } catch (err) {
      console.error(`[commandHandler] Guild command registration failed: ${err.message}`);
    }
  }

  // 2 — Global (all servers)
  try {
    await rest.put(
      Routes.applicationCommands(config.discordClientId),
      { body: COMMAND_DEFS }
    );
    console.log('[commandHandler] Global slash commands registered');
  } catch (err) {
    console.error(`[commandHandler] Global command registration failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the first MEGA link found in a Discord channel (state store → recent messages → embeds). */
async function findMegaLinkInChannel(targetChannel) {
  const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');

  // 1. Check state store (fastest — already known link)
  const allStates = getAllStates() || {};
  const stateEntry = Object.values(allStates).find((s) => s.channelId === targetChannel.id);
  if (stateEntry?.megaLink) return stateEntry.megaLink;

  // 2. Scan last 50 messages (text content + embeds)
  let msgs;
  try {
    msgs = await targetChannel.messages.fetch({ limit: 50 });
  } catch (err) {
    console.warn(`[commandHandler] Cannot fetch messages from channel ${targetChannel.id}: ${err.message}`);
    return null;
  }

  for (const msg of msgs.values()) {
    // Plain text
    const textLinks = extractMegaLinks(msg.content || '');
    if (textLinks.length > 0) return textLinks[0];

    // Embeds
    for (const emb of (msg.embeds || [])) {
      const embedLinks = extractMegaLinks(flattenEmbed(emb));
      if (embedLinks.length > 0) return embedLinks[0];
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND HANDLERS (each is its own function for clarity)
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus(interaction, config) {
  const states  = getAllStates() || {};
  const entries = Object.values(states);
  const counts  = { pending: 0, encrypting: 0, uploading: 0, uploaded: 0,
                    channel_created: 0, message_sent: 0, failed: 0 };
  for (const s of entries) if (s.status in counts) counts[s.status]++;

  const logs = getLogs();
  await interaction.reply({
    ephemeral: true,
    content: [
      `📊 **Pipeline Status** — ${entries.length} total files`,
      `✅ Delivered:  **${counts.message_sent}**`,
      `⬆️ In progress: **${counts.encrypting + counts.uploading + counts.uploaded + counts.channel_created}**`,
      `❌ Failed:     **${counts.failed}**`,
      `📋 Log entries: **${logs.length}**`,
      `🖼️ Embed mode:  **${config.advancedTemplate?.useEmbed ? 'ON' : 'OFF'}**`,
    ].join('\n'),
  });
}

async function handleSettemplate(interaction, config) {
  const tmpl = interaction.options.getString('template', true);
  config.messageTemplate = tmpl;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const warn = !tmpl.includes('{link}')
    ? '\n⚠️ Template has no `{link}` placeholder — MEGA link will not appear in messages!'
    : '';
  await interaction.reply({
    ephemeral: true,
    content: `✅ Template updated:\n\`\`\`${tmpl}\`\`\`${warn}`,
  });
}

async function handleToggleembed(interaction, config) {
  if (!config.advancedTemplate) config.advancedTemplate = { useEmbed: false };
  config.advancedTemplate.useEmbed = !config.advancedTemplate.useEmbed;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  await interaction.reply({
    ephemeral: true,
    content: `✅ Message mode → **${config.advancedTemplate.useEmbed ? '🖼️ Embed' : '📝 Plain text'}**\nRun \`/updateposts\` to re-render already-posted messages.`,
  });
}

async function handleUpdateposts(interaction, client, config) {
  await interaction.deferReply({ ephemeral: true });

  const states = getAllStates() || {};
  let updated = 0, skipped = 0, failed = 0;

  for (const [filename, state] of Object.entries(states)) {
    if (state.status !== 'message_sent' || !state.channelId || !state.messageId) {
      skipped++;
      continue;
    }
    try {
      const ch = await client.channels.fetch(state.channelId);
      if (!ch) { skipped++; continue; }
      await editZipMessage(ch, state.messageId, {
        name:     path.basename(filename, path.extname(filename)),
        link:     state.megaLink   || '',
        password: state.zipPassword || '',
      }, config);
      updated++;
    } catch (err) {
      console.warn(`[commandHandler] /updateposts failed for "${filename}": ${err.message}`);
      failed++;
    }
  }

  await interaction.editReply({
    content: `✅ Done!\n• Updated: **${updated}**\n• Skipped (no message ID): **${skipped}**\n• Errors: **${failed}**`,
  });
}

async function handleCheck(interaction, config, actions) {
  const apiKey = process.env.VIRUSTOTAL_API_KEY || config.virusTotalApiKey;
  if (!apiKey) {
    return interaction.reply({
      ephemeral: true,
      content: [
        '❌ **VirusTotal API Key not configured.**',
        'Add `VIRUSTOTAL_API_KEY` to your Railway Variables and redeploy.',
        'Get a free key at https://www.virustotal.com/gui/join-us',
      ].join('\n'),
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // ── Resolve target MEGA link ─────────────────────────────────────────────
  let megaLink = interaction.options.getString('link') || null;
  if (!megaLink) {
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    if (targetChannel) {
      megaLink = await findMegaLinkInChannel(targetChannel);
    }
  }

  if (!megaLink) {
    return interaction.editReply({
      content: '❌ No MEGA link found. Use `link:` to paste one directly, or specify a `channel:` that has one.',
    });
  }

  await interaction.editReply({ content: `🔍 Link found: \`${megaLink}\`\n⏳ Querying VirusTotal URL reputation database…` });

  try {
    // ── Phase 1: URL reputation ──────────────────────────────────────────────
    const urlReport = await scanUrl(megaLink, apiKey);
    const urlStats  = urlReport?.attributes?.last_analysis_stats;

    let urlStatusLine = '⚠️ *No reputation data available yet on VirusTotal*';
    // Safe base64 URL-encode (works on Node 14+ without base64url flag)
    const vtUrlId   = Buffer.from(megaLink).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const vtUrlLink = `https://www.virustotal.com/gui/url/${vtUrlId}/detection`;

    if (urlStats) {
      const mal = urlStats.malicious || 0;
      urlStatusLine = mal > 0
        ? `🚨 **${mal} engine(s) flagged as malicious**`
        : `🟢 **Clean — 0 malicious flags**`;
    }

    await interaction.editReply({
      content: [
        '🔍 **VirusTotal Scan — Phase 1: URL Reputation**',
        `• Result: ${urlStatusLine}`,
        `• Full report: ${vtUrlLink}`,
        '',
        '*⏳ Downloading the file to compute SHA-256 hash for deep payload scan…*',
        '*(This may take a minute for large files)*',
      ].join('\n'),
    });

    // ── Phase 2: File hash scan (optional — skip if download fails) ──────────
    let fileSection = '**② File Payload Scan:** ⚠️ *Download skipped or failed — URL scan above is still valid.*';

    try {
      const tmpDir  = path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'vt-scan');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, `${Date.now()}-vt.zip`);

      // Use the shared downloadManager instance (already init'd by index.js)
      const dlManager = actions.downloadManager || require('./downloadEngine/downloadManager');
      await dlManager.downloadMegaFile(megaLink, tmpFile, { timeoutMs: 120_000 });

      const sha256     = await getFileSha256(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch {}

      const vtFileLink = `https://www.virustotal.com/gui/file/${sha256}/detection`;
      const fileReport = await getFileReport(sha256, apiKey);

      if (fileReport) {
        const fs2 = fileReport.attributes?.last_analysis_stats || {};
        const mal = fs2.malicious  || 0;
        const sus = fs2.suspicious || 0;
        const ok  = fs2.harmless   || 0;
        fileSection = [
          `**② File Payload Scan (SHA-256: \`${sha256.slice(0, 16)}…\`)**`,
          `• Result: ${mal > 0 ? `🚨 **${mal} malicious detections**` : '🟢 **Clean**'}`,
          `• Stats: ${ok} safe · ${sus} suspicious · ${mal} malicious`,
          `• Full report: ${vtFileLink}`,
        ].join('\n');
      } else {
        fileSection = [
          `**② File Payload Scan**`,
          `• SHA-256: \`${sha256}\``,
          `• Status: 📭 *File not found on VirusTotal — not yet submitted.*`,
          `• Submit manually: ${vtFileLink}`,
        ].join('\n');
      }
    } catch (dlErr) {
      console.warn(`[commandHandler] /check phase2 download failed: ${dlErr.message}`);
      fileSection = `**② File Payload Scan:** ⚠️ *Download failed: ${dlErr.message}*\nURL reputation above is still valid.`;
    }

    await interaction.editReply({
      content: [
        '🔍 **VirusTotal Scan Results**',
        '',
        '**① URL Reputation**',
        `• Result: ${urlStatusLine}`,
        `• Report: ${vtUrlLink}`,
        '',
        fileSection,
      ].join('\n'),
    });

  } catch (err) {
    console.error(`[commandHandler] /check error: ${err.message}`);
    try {
      await interaction.editReply({ content: `❌ VirusTotal scan failed: ${err.message}` });
    } catch { /* interaction may have expired */ }
  }
}

async function handleRegen(interaction, actions) {
  const channel = interaction.options.getChannel('channel', true);
  await interaction.deferReply({ ephemeral: true });

  try {
    if (typeof actions.regenerateChannel !== 'function') {
      throw new Error('Regeneration handler is not available — check bot startup logs.');
    }
    const filename = await actions.regenerateChannel(channel.id);
    await interaction.editReply({
      content: [
        `✅ **Regeneration started** for <#${channel.id}>`,
        `📂 File: \`${filename}\``,
        `⏳ The file is being re-downloaded and re-encrypted in the background.`,
        `The channel post will be updated automatically when done.`,
      ].join('\n'),
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Regeneration failed: ${err.message}` });
  }
}

async function handleMirror(interaction, config, actions) {
  const action = interaction.options.getString('action', true);

  if (action === 'start') {
    await interaction.reply({ ephemeral: true, content: '🚀 Mirror engine starting — scanning channels…' });
    if (typeof actions.startMirrorEngine === 'function') {
      actions.startMirrorEngine(config, true).catch((err) => {
        console.error(`[commandHandler] /mirror start error: ${err.message}`);
      });
    }
    return;
  }

  if (action === 'stop') {
    if (typeof actions.stopMirrorEngine === 'function') actions.stopMirrorEngine();
    return interaction.reply({ ephemeral: true, content: '🛑 Mirror engine stopped.' });
  }

  if (action === 'status') {
    if (typeof actions.getMirrorEngineStatus !== 'function') {
      return interaction.reply({ ephemeral: true, content: '⚠️ Mirror engine status handler not available.' });
    }
    const st     = actions.getMirrorEngineStatus();
    const counts = st.stateCounts || {};
    return interaction.reply({
      ephemeral: true,
      content: [
        '⚡ **Mirror Engine Status**',
        `• Running:    **${st.started ? 'Active 🟢' : 'Idle 🔴'}**`,
        `• Pending:    **${counts.pending  || 0}**`,
        `• Completed:  **${(counts.done || 0) + (counts.message_sent || 0)}**`,
        `• Failed:     **${counts.failed   || 0}**`,
      ].join('\n'),
    });
  }
}

async function handlePipeline(interaction, actions) {
  const action = interaction.options.getString('action', true);

  if (action === 'pause') {
    if (typeof actions.pauseDownloads === 'function') actions.pauseDownloads();
    return interaction.reply({ ephemeral: true, content: '⏸️ Download queue paused.' });
  }
  if (action === 'resume') {
    if (typeof actions.resumeDownloads === 'function') actions.resumeDownloads();
    return interaction.reply({ ephemeral: true, content: '▶️ Download queue resumed.' });
  }
  if (action === 'cancel') {
    if (typeof actions.cancelDownloads === 'function') actions.cancelDownloads();
    return interaction.reply({ ephemeral: true, content: '⏹️ All pending download jobs cancelled.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// /dcheck — Delete duplicate channels, keeping the one with messages
// ─────────────────────────────────────────────────────────────────────────────
async function handleDcheck(interaction, client, config) {
  const dryRun = interaction.options.getBoolean('dryrun') ?? false;

  await interaction.reply({ ephemeral: true, content: '🔍 Duplicate channel cleanup started. Scanning server channels…' });

  if (!config.guildId) {
    return interaction.editReply({ content: '❌ `guildId` is not set in config — cannot scan.' });
  }

  let guild;
  try {
    guild = await client.guilds.fetch(config.guildId);
    await guild.channels.fetch();
  } catch (err) {
    return interaction.editReply({ content: `❌ Could not fetch guild: ${err.message}` });
  }

  // Group text channels by lowercase name
  const byName = new Map(); // name → Channel[]
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== 0) continue; // text channels only
    const key = ch.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(ch);
  }

  // Find groups with more than 1 channel (duplicates)
  const dupGroups = [...byName.values()].filter(g => g.length > 1);

  if (dupGroups.length === 0) {
    return interaction.editReply({ content: '✅ **No duplicate channels found.** Everything looks clean!' });
  }

  const totalDups = dupGroups.reduce((sum, g) => sum + g.length - 1, 0);
  await interaction.editReply({
    content: [
      `🔎 Found **${dupGroups.length} group(s)** of duplicate channels — **${totalDups} extra** to remove.`,
      dryRun ? '\n⚠️ **DRY RUN** — nothing will actually be deleted.' : '\n🗑️ Deleting duplicates now…',
    ].join(''),
  });

  let deleted = 0;
  let failed  = 0;
  const report = [];

  for (const group of dupGroups) {
    // Sort: prefer channel with most recent message (lastMessageId is a snowflake — higher = newer)
    // Keep the one with the highest lastMessageId (most recently active); delete the rest
    group.sort((a, b) => {
      const aId = BigInt(a.lastMessageId || '0');
      const bId = BigInt(b.lastMessageId || '0');
      return bId > aId ? 1 : bId < aId ? -1 : 0;
    });

    const [keep, ...toDelete] = group;
    report.push(`• **${keep.name}** — keep <#${keep.id}>, delete ${toDelete.length} duplicate(s)`);

    if (!dryRun) {
      for (const ch of toDelete) {
        try {
          await ch.delete('Duplicate channel — removed by /dcheck');
          deleted++;
          await new Promise(r => setTimeout(r, 300)); // small delay to avoid rate limit
        } catch (err) {
          console.warn(`[commandHandler] /dcheck failed to delete #${ch.name} (${ch.id}): ${err.message}`);
          failed++;
        }
      }
    } else {
      deleted += toDelete.length; // count as if deleted (dry run)
    }
  }

  // ── Clean up empty categories ──────────────────────────────────────────────
  let deletedCats = 0;
  if (!dryRun) {
    try {
      await guild.channels.fetch(); // refresh cache
      for (const ch of guild.channels.cache.values()) {
        if (ch.type === 4) { // Category = 4
          const children = guild.channels.cache.filter((child) => child.parentId === ch.id);
          if (children.size === 0) {
            const name = ch.name;
            if (name.startsWith('◜📂 〢') || name.toLowerCase().includes('stock server') || name.toLowerCase().includes('uploads')) {
              try {
                await ch.delete('Empty category cleanup by /dcheck');
                deletedCats++;
              } catch (err) {
                console.warn(`[commandHandler] /dcheck failed to delete category "${name}" (${ch.id}): ${err.message}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[commandHandler] /dcheck category cleanup fetch failed: ${err.message}`);
    }
  }

  const lines = [
    dryRun
      ? `🔍 **DRY RUN Results** — **${deleted}** channel(s) would be deleted:`
      : `✅ **Done** — **${deleted}** duplicate channel(s) deleted${deletedCats > 0 ? ` and **${deletedCats}** empty category/categories deleted` : ''}${failed > 0 ? `, **${failed}** failed` : ''}:`,
    '',
    ...report.slice(0, 20), // cap at 20 lines to avoid Discord 2000-char limit
    report.length > 20 ? `…and ${report.length - 20} more group(s)` : '',
  ].filter(Boolean);

  await interaction.editReply({ content: lines.join('\n').slice(0, 1990) });
}

async function handleInvalidateSession(interaction) {
  invalidateSession();
  return interaction.reply({
    ephemeral: true,
    content: [
      '🔄 **MEGA session cleared.**',
      'The bot will perform a fresh email + password login on the next upload.',
      '💡 Use this whenever you change your MEGA account password.',
    ].join('\n'),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DISPATCHER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attaches the interactionCreate listener that routes all commands.
 * @param {import('discord.js').Client} client
 * @param {object} config
 * @param {object} actions  — callbacks injected from index.js
 */
function attachCommandHandler(client, config, actions = {}) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ── Owner-only guard ──────────────────────────────────────────────────────
    if (config.botOwnerId && interaction.user.id !== config.botOwnerId) {
      return interaction.reply({ ephemeral: true, content: '🚫 This command is only available to the bot owner.' });
    }

    const cmd = interaction.commandName;

    try {
      if (cmd === 'status')            return await handleStatus(interaction, config);
      if (cmd === 'settemplate')        return await handleSettemplate(interaction, config);
      if (cmd === 'toggleembed')        return await handleToggleembed(interaction, config);
      if (cmd === 'updateposts')        return await handleUpdateposts(interaction, client, config);
      if (cmd === 'check')              return await handleCheck(interaction, config, actions);
      if (cmd === 'regen')              return await handleRegen(interaction, actions);
      if (cmd === 'mirror')             return await handleMirror(interaction, config, actions);
      if (cmd === 'pipeline')           return await handlePipeline(interaction, actions);
      if (cmd === 'invalidatesession')  return await handleInvalidateSession(interaction);
      if (cmd === 'dcheck')              return await handleDcheck(interaction, client, config);
    } catch (err) {
      console.error(`[commandHandler] Unhandled error in /${cmd}: ${err.message}`);
      const payload = { ephemeral: true, content: `❌ An unexpected error occurred: ${err.message}` };
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply(payload);
      } catch { /* ignore follow-up failures */ }
    }
  });
}

module.exports = { registerCommands, attachCommandHandler };
