'use strict';

const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { getAllStates }                   = require('./stateStore');
const { editZipMessage }                 = require('./webhookSender');
const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');

const configPath = path.join(__dirname, '..', 'config', 'config.json');

// ── Unicode bold → ASCII normaliser (for /dcheck) ────────────────────────────
/**
 * Convert any unicode styling variants (bold, italic, fullwidth, etc.) → standard ASCII, then lowercase.
 */
function normalizeChannelName(name) {
  if (!name) return '';
  return name.normalize('NFKD').toLowerCase().trim();
}

function getCategoryBaseKey(guild, parentId) {
  if (!parentId) return 'root';
  const parent = guild.channels.cache.get(parentId);
  if (!parent) return parentId;
  return parent.name.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function isOwner(interaction, config) {
  return !config.botOwnerId || interaction.user.id === config.botOwnerId;
}

async function ownerOnly(interaction, config) {
  if (!(await isOwner(interaction, config))) {
    await interaction.reply({ content: '🚫 Only the bot owner can use this command.', ephemeral: true });
    return false;
  }
  return true;
}

// ── Command definitions ───────────────────────────────────────────────────────
async function registerCommands(config) {
  if (!config.discordClientId) {
    throw new Error('discordClientId missing in config (needed for slash commands)');
  }

  const commands = [
    // ── Status ────────────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Pipeline + mirror engine status (owner only)')
      .toJSON(),

    // ── Set template ──────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('settemplate')
      .setDescription('Update the plain-text message template (owner only)')
      .addStringOption(o => o.setName('template').setDescription('Use {name},{link},{password}').setRequired(true))
      .toJSON(),

    // ── Toggle embed ──────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('toggleembed')
      .setDescription('Toggle plain-text ↔ rich embed mode (owner only)')
      .toJSON(),

    // ── Update posts ──────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('updateposts')
      .setDescription('Re-render all posted messages with current template (owner only)')
      .toJSON(),

    // ── /check — VirusTotal scan (whole server or specific channel) ─────────────
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Scan MEGA links via VirusTotal — whole server or a specific channel (owner only)')
      .addStringOption(o =>
        o.setName('channel')
          .setDescription('Channel name, ID, or Discord link (leave blank for whole server)')
          .setRequired(false)
      )
      .toJSON(),

    // ── /regenerate ───────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('regenerate')
      .setDescription('Re-upload a file to MEGA and update its channel message (owner only)')
      .addStringOption(o =>
        o.setName('channel')
          .setDescription('Channel name or ID')
          .setRequired(true)
      )
      .toJSON(),

    // ── /dcheck — Deduplication across whole server ───────────────────────────
    new SlashCommandBuilder()
      .setName('dcheck')
      .setDescription('Find & delete duplicate channels across the server (owner only)')
      .addBooleanOption(o =>
        o.setName('dryrun')
          .setDescription('true = only list duplicates, do not delete')
          .setRequired(false)
      )
      .toJSON(),

    // ── /mirror — Mirror engine control ──────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('mirror')
      .setDescription('Mirror engine controls (owner only)')
      .addStringOption(o =>
        o.setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'status', value: 'status' },
            { name: 'start',  value: 'start'  },
            { name: 'stop',   value: 'stop'   },
            { name: 'reset',  value: 'reset'  },
          )
      )
      .toJSON(),

    // ── /pipeline — Pipeline control ──────────────────────────────────────────
    new SlashCommandBuilder()
      .setName('pipeline')
      .setDescription('Upload pipeline controls (owner only)')
      .addStringOption(o =>
        o.setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'status', value: 'status' },
            { name: 'pause',  value: 'pause'  },
            { name: 'resume', value: 'resume' },
          )
      )
      .toJSON(),

    // ── /fetch — Scan source server → .txt → pipeline ─────────────────────────
    new SlashCommandBuilder()
      .setName('fetch')
      .setDescription('Scan source server for MEGA links, export as .txt attachment (owner only)')
      .toJSON(),

    // ── /mg — List MEGA account files → .txt → pipeline ───────────────────────
    new SlashCommandBuilder()
      .setName('mg')
      .setDescription('List all files in your MEGA account and export as .txt (owner only)')
      .toJSON(),

    // ── /shrink — Manually collapse individual channels into batch embeds ──────
    new SlashCommandBuilder()
      .setName('shrink')
      .setDescription('Collapse individual link channels into batch embeds (owner only)')
      .addIntegerOption(o =>
        o.setName('count')
          .setDescription('How many channels to shrink (default: 1)')
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(false)
      )
      .toJSON(),

    // ── /editembed — Edit batch embed template ────────────────────────────────
    new SlashCommandBuilder()
      .setName('editembed')
      .setDescription('Customize the batch embed format (owner only)')
      .addStringOption(o =>
        o.setName('title')
          .setDescription('Embed title. Use {n} for batch channel number (e.g. "Batch Links — Page {n}")')
          .setRequired(false)
      )
      .addStringOption(o =>
        o.setName('fieldformat')
          .setDescription('Per-entry format. Variables: {name} {link} {key} {password}')
          .setRequired(false)
      )
      .addStringOption(o =>
        o.setName('color')
          .setDescription('Embed side-bar color as hex (e.g. #5865F2)')
          .setRequired(false)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.guildId),
    { body: commands }
  );
}

// ── Command handler ───────────────────────────────────────────────────────────
function attachCommandHandler(client, config, {
  mirrorControls = {},   // { getStatus, start, stop }
  pipelineControls = {}, // { pause, resume, getStatus }
  onIngestLink,
  shrinkControls = {},   // { shrink(n) }
} = {}) {

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // All commands are owner-only
    if (!(await ownerOnly(interaction, config))) return;

    const cmd = interaction.commandName;

    // ── /status ───────────────────────────────────────────────────────────────
    if (cmd === 'status') {
      const states  = getAllStates() || {};
      const entries = Object.values(states);
      const counts  = { pending:0, encrypting:0, uploading:0, uploaded:0, channel_created:0, message_sent:0, failed:0 };
      for (const s of entries) { if (s.status in counts) counts[s.status]++; }

      const mirrorStatus = mirrorControls.getStatus?.() || { running: false };

      const lines = [
        '📊 **Pipeline Status**',
        `✅ Completed : **${counts.message_sent}**`,
        `⬆️  In-flight : **${counts.uploading + counts.uploaded + counts.channel_created + counts.encrypting}**`,
        `❌ Failed    : **${counts.failed}**`,
        `📋 Total     : **${entries.length}**`,
        `🖼️ Embed mode: **${config.advancedTemplate?.useEmbed ? 'ON' : 'OFF'}**`,
        '',
        '🔁 **Mirror Engine**',
        `Status : **${mirrorStatus.running ? '🟢 Running' : '⚫ Idle'}**`,
        mirrorStatus.phase  ? `Phase  : **${mirrorStatus.phase}**` : '',
        mirrorStatus.done   != null ? `Done   : **${mirrorStatus.done}** / **${mirrorStatus.total}**` : '',
        mirrorStatus.lastRunAt ? `Last run: ${mirrorStatus.lastRunAt}` : '',
      ].filter(Boolean);

      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    // ── /settemplate ──────────────────────────────────────────────────────────
    if (cmd === 'settemplate') {
      const tpl = interaction.options.getString('template', true);
      config.messageTemplate = tpl;
      try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
      const warn = !tpl.includes('{link}') ? '\n⚠️ No `{link}` — the MEGA link won\'t appear in messages.' : '';
      await interaction.reply({ content: `✅ Template updated:\n\`\`\`${tpl}\`\`\`${warn}`, ephemeral: true });
      return;
    }

    // ── /toggleembed ──────────────────────────────────────────────────────────
    if (cmd === 'toggleembed') {
      if (!config.advancedTemplate) config.advancedTemplate = { useEmbed: false };
      config.advancedTemplate.useEmbed = !config.advancedTemplate.useEmbed;
      try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
      const mode = config.advancedTemplate.useEmbed ? '🖼️ Embed' : '📝 Plain text';
      await interaction.reply({ content: `✅ Switched to **${mode}** mode.`, ephemeral: true });
      return;
    }

    // ── /updateposts ──────────────────────────────────────────────────────────
    if (cmd === 'updateposts') {
      await interaction.deferReply({ ephemeral: true });
      const states = getAllStates() || {};
      let updated = 0, skipped = 0, failed = 0;

      for (const [filename, state] of Object.entries(states)) {
        if (state.status !== 'message_sent' || !state.channelId || !state.messageId) { skipped++; continue; }
        try {
          const ch = await client.channels.fetch(state.channelId);
          if (!ch) { skipped++; continue; }
          const baseName = path.basename(filename, path.extname(filename));
          await editZipMessage(ch, state.messageId, { name: baseName, link: state.megaLink || '', password: state.zipPassword || '' }, config);
          updated++;
        } catch { failed++; }
      }
      await interaction.editReply({ content: `✅ Done! Updated: **${updated}** | Skipped: **${skipped}** | Errors: **${failed}**` });
      return;
    }

    // ── /mirror ───────────────────────────────────────────────────────────────
    if (cmd === 'mirror') {
      const action = interaction.options.getString('action', true);
      if (action === 'status') {
        const s = mirrorControls.getStatus?.() || { running: false };
        const lines = [
          `🔁 **Mirror Engine**`,
          `Status: **${s.running ? '🟢 Running' : '⚫ Idle'}**`,
          s.phase ? `Phase : **${s.phase}**` : '',
          s.done  != null ? `Progress: **${s.done}/${s.total}**` : '',
          s.lastRunAt ? `Last run: ${s.lastRunAt}` : '',
        ].filter(Boolean);
        await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      } else if (action === 'start') {
        if (mirrorControls.start) { mirrorControls.start(); await interaction.reply({ content: '▶️ Mirror engine starting...', ephemeral: true }); }
        else await interaction.reply({ content: '⚠️ Mirror engine controls not available.', ephemeral: true });
      } else if (action === 'stop') {
        if (mirrorControls.stop) { mirrorControls.stop(); await interaction.reply({ content: '⏹️ Mirror engine stopping...', ephemeral: true }); }
        else await interaction.reply({ content: '⚠️ Mirror engine controls not available.', ephemeral: true });
      } else if (action === 'reset') {
        // Clears mirror state so the engine re-scans from channel #1 on the next start.
        // Use this for recovery after accidental channel deletion.
        if (mirrorControls.reset) {
          const cleared = mirrorControls.reset();
          await interaction.reply({
            content: `🔄 **Mirror state reset!** Cleared **${cleared}** tracked link(s).\nThe engine will re-scan everything from scratch on the next \`/mirror start\`.`,
            ephemeral: true,
          });
        } else {
          await interaction.reply({ content: '⚠️ Mirror reset not available.', ephemeral: true });
        }
      }
      return;
    }

    // ── /pipeline ─────────────────────────────────────────────────────────────
    if (cmd === 'pipeline') {
      const action = interaction.options.getString('action', true);
      if (action === 'pause')  { pipelineControls.pause?.();  await interaction.reply({ content: '⏸️ Pipeline paused.', ephemeral: true }); }
      else if (action === 'resume') { pipelineControls.resume?.(); await interaction.reply({ content: '▶️ Pipeline resumed.', ephemeral: true }); }
      else {
        const s = pipelineControls.getStatus?.() || {};
        await interaction.reply({ content: `📋 **Pipeline**\nActive: **${s.active || 0}** | Queued: **${s.queued || 0}**`, ephemeral: true });
      }
      return;
    }

    // ── /dcheck — Deduplication of whole server ───────────────────────────────
    if (cmd === 'dcheck') {
      await interaction.deferReply(); // PUBLIC — survives refresh
      const dryRun = interaction.options.getBoolean('dryrun') ?? false;

      try {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.channels.fetch();
        const textChannels = [...guild.channels.cache.values()].filter(
          ch => ch.type === ChannelType.GuildText
        );

        // Group by category base key + normalized channel name
        const groups = new Map();
        for (const ch of textChannels) {
          const key = `${getCategoryBaseKey(guild, ch.parentId)}:${normalizeChannelName(ch.name)}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(ch);
        }

        // Find groups with duplicates
        const duplicateGroups = [...groups.values()].filter(g => g.length > 1);
        const toDelete = [];
        for (const group of duplicateGroups) {
          const sorted = [...group].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // oldest first
          toDelete.push(...sorted.slice(1)); // keep first (oldest), delete rest
        }

        if (toDelete.length === 0) {
          await interaction.editReply({ content: '✅ No duplicate channels found.' });
          return;
        }

        if (dryRun) {
          const lines = toDelete.slice(0, 40).map(ch => `• <#${ch.id}> \`${ch.name}\``);
          if (toDelete.length > 40) lines.push(`…and ${toDelete.length - 40} more`);
          await interaction.editReply({
            content: `🔍 **Dry Run — ${toDelete.length} duplicate(s) would be deleted:**\n${lines.join('\n')}`,
          });
          return;
        }

        // Delete duplicates
        let deleted = 0, errors = 0;
        for (const ch of toDelete) {
          try {
            await ch.delete('Duplicate channel removed by /dcheck');
            deleted++;
            await new Promise(r => setTimeout(r, 600)); // rate-limit guard
          } catch { errors++; }
        }

        await interaction.editReply({
          content: `🗑️ **Deduplication complete!**\n✅ Deleted: **${deleted}** | ❌ Errors: **${errors}**`,
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // ── /check — VirusTotal scan ────────────────────────────────────────────────────
    if (cmd === 'check') {
      await interaction.deferReply(); // PUBLIC — survives refresh
      // channel option accepts: channel name, raw ID, or Discord URL like discord.com/channels/.../channelId
      const channelRaw = (interaction.options.getString('channel') || '').trim();

      if (!process.env.VIRUSTOTAL_API_KEY) {
        await interaction.editReply({ content: '❌ `VIRUSTOTAL_API_KEY` is not set. Add it to Railway environment variables.' });
        return;
      }

      // Lazy-load: these modules may not exist (vtScanner is optional)
      let downloadMegaFile, scanFile;
      try { downloadMegaFile = require('./downloadEngine/downloadManager').downloadMegaFile; } catch {
        await interaction.editReply({ content: '❌ downloadManager module not found.' }); return;
      }
      try { scanFile = require('./vtScanner').scanFile; } catch {
        await interaction.editReply({ content: '❌ vtScanner module not found. Create `src/vtScanner.js` with a `scanFile` export.' }); return;
      }

      try {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.channels.fetch();

        // Resolve target channels
        let channels;
        if (!channelRaw) {
          // Whole server
          channels = [...guild.channels.cache.values()].filter(ch => ch.type === ChannelType.GuildText);
        } else {
          // Extract a channel ID if a Discord URL was pasted
          const urlIdMatch = channelRaw.match(/channels\/\d+\/(\d+)/);
          const resolvedId = urlIdMatch ? urlIdMatch[1] : channelRaw.replace(/^<#|>$/g, '');

          // Try exact ID first, then name search
          const found = guild.channels.cache.get(resolvedId) ||
            guild.channels.cache.find(
              c => c.type === ChannelType.GuildText &&
                   c.name.toLowerCase().includes(resolvedId.toLowerCase())
            );

          if (!found) {
            await interaction.editReply({ content: `❌ Channel \"${channelRaw}\" not found.` });
            return;
          }
          channels = [found];
        }

        // Collect all unique MEGA links
        const linkMap = new Map(); // link → { channelName, messageId }
        const scopeLabel = channels.length === 1 ? `<#${channels[0].id}>` : `**${channels.length}** channels`;
        await interaction.editReply({ content: `🔍 Scanning ${scopeLabel} for MEGA links...` });

        for (const ch of channels) {
          try {
            const msgs = await ch.messages.fetch({ limit: 50 });
            for (const msg of msgs.values()) {
              const texts = [msg.content || ''];
              for (const e of msg.embeds || []) texts.push(flattenEmbed(e));
              for (const text of texts) {
                for (const link of extractMegaLinks(text)) {
                  if (!linkMap.has(link)) linkMap.set(link, { channelName: ch.name, messageId: msg.id });
                }
              }
            }
          } catch { /* skip inaccessible */ }
        }

        if (linkMap.size === 0) {
          await interaction.editReply({ content: `⚠️ No MEGA links found in ${scopeLabel}.` });
          return;
        }

        await interaction.editReply({ content: `🦠 Found **${linkMap.size}** unique MEGA link(s). Scanning via VirusTotal...` });

        const results = [];
        let processed = 0;

        for (const [link, meta] of linkMap) {
          try {
            const tmpFile = path.join(os.tmpdir(), `vt-${Date.now()}-${processed}.bin`);
            try {
              await downloadMegaFile(link, tmpFile, { timeoutMs: 120_000 });
            } catch (dlErr) {
              results.push({ link, channel: meta.channelName, error: `Download: ${dlErr.message}` });
              processed++;
              continue;
            }

            let vtResult = null;
            try {
              vtResult = await scanFile(tmpFile);
            } catch (vtErr) {
              results.push({ link, channel: meta.channelName, error: `VT: ${vtErr.message}` });
            } finally {
              try { fs.unlinkSync(tmpFile); } catch {}
            }

            if (vtResult) results.push({ link, channel: meta.channelName, ...vtResult });
            processed++;

            if (processed % 3 === 0) {
              await interaction.editReply({ content: `🦠 Scanned **${processed}/${linkMap.size}**...` }).catch(() => {});
            }
          } catch (err) {
            results.push({ link, channel: meta.channelName, error: err.message });
            processed++;
          }
        }

        // Format results
        const clean   = results.filter(r => !r.error && r.malicious === 0 && r.suspicious === 0);
        const flagged = results.filter(r => !r.error && (r.malicious > 0 || r.suspicious > 0));
        const errored = results.filter(r => r.error);

        const summary = [
          `✅ **${clean.length}** clean`,
          `🚨 **${flagged.length}** flagged`,
          `⚠️ **${errored.length}** errors`,
        ].join(' | ');

        const lines = [`🦠 **VirusTotal Scan Complete** — ${summary}\n`];

        for (const r of flagged) {
          lines.push(`🚨 **#${r.channel}** — ${r.malicious} malicious, ${r.suspicious} suspicious / ${r.total}`);
          lines.push(`   🔗 [View Report](${r.analysisUrl})`);
        }
        for (const r of errored.slice(0, 5)) {
          lines.push(`⚠️ **#${r.channel}**: ${r.error}`);
        }
        if (flagged.length === 0 && clean.length > 0) lines.push('\n✅ All scanned files are clean!');

        await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // ── /regenerate ───────────────────────────────────────────────────────────
    if (cmd === 'regenerate') {
      await interaction.deferReply({ ephemeral: true });
      const channelQuery = interaction.options.getString('channel', true);

      try {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.channels.fetch();

        // Find the channel
        const ch = guild.channels.cache.find(
          c => c.type === ChannelType.GuildText &&
               (c.id === channelQuery || c.name.toLowerCase().includes(channelQuery.toLowerCase()))
        );
        if (!ch) {
          await interaction.editReply({ content: `❌ Channel "${channelQuery}" not found.` });
          return;
        }

        // Find a MEGA link in the channel
        const msgs = await ch.messages.fetch({ limit: 20 });
        let foundLink = null, foundMessage = null;
        for (const msg of msgs.values()) {
          const texts = [msg.content || ''];
          for (const e of msg.embeds || []) texts.push(flattenEmbed(e));
          for (const text of texts) {
            const links = extractMegaLinks(text);
            if (links.length > 0) { foundLink = links[0]; foundMessage = msg; break; }
          }
          if (foundLink) break;
        }

        if (!foundLink) {
          await interaction.editReply({ content: `❌ No MEGA link found in <#${ch.id}>.` });
          return;
        }

        await interaction.editReply({ content: `⬇️ Downloading file from MEGA to regenerate link...` });

        // Download
        const tmpFile = path.join(os.tmpdir(), `regen-${Date.now()}.bin`);
        const dlResult = await downloadMegaFile(foundLink, tmpFile, { timeoutMs: 300_000 });
        const remoteName = dlResult?.name || path.basename(ch.name);

        // Re-queue via the pipeline (onIngestLink triggers download → encrypt → upload)
        if (typeof onIngestLink === 'function') {
          // Don't delete tmpFile here — the async pipeline needs it
          // Use foundLink (the original MEGA URL) to re-download+re-encrypt+reupload
          onIngestLink(remoteName || ch.name, foundLink, null);
          await interaction.editReply({
            content: `🔄 **Regenerating** link for <#${ch.id}>...\nQueued in pipeline — the channel message will update when done.`,
          });
        } else {
          await interaction.editReply({ content: `⚠️ Pipeline not available.` });
        }
        try { fs.unlinkSync(tmpFile); } catch {}
      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // Initialize buffer maps if they don't exist
    client._fetchBuffers = client._fetchBuffers || new Map();
    client._mgBuffers    = client._mgBuffers || new Map();

    // ── /fetch — Scan source server, export MEGA links as .txt ─────────────
    if (cmd === 'fetch') {
      // Conflict guard: do not fetch if mirror engine is currently running
      const mirrorStatus = mirrorControls.getStatus?.() || { running: false };
      if (mirrorStatus.running) {
        await interaction.reply({
          content: '⚠️ The mirror engine is currently running. Please stop it or wait for it to finish before fetching.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        let startScan;
        try { startScan = require('./mirrorEngine/scanner').startScan; } catch {
          await interaction.editReply({ content: '❌ Scanner module (`mirrorEngine/scanner.js`) not found.' }); return;
        }
        await interaction.editReply({ content: '🔍 Scanning source server for MEGA links…' });

        const found = await startScan(config); // returns [{link, name, categoryName}]
        if (!found || found.length === 0) {
          await interaction.editReply({ content: '⚠️ No MEGA links found in source server.' });
          return;
        }

        const ts = Date.now().toString();

        // Write .txt (format: name | link | category)
        const lines = found.map(f => `${f.name || 'unnamed'} | ${f.link} | ${f.categoryName || ''}`);
        const txtPath = path.join(os.tmpdir(), `fetch-${ts}.txt`);
        fs.writeFileSync(txtPath, lines.join('\n'), 'utf-8');

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`fetch_pipeline_${ts}`)
            .setLabel(`🚀 Hand ${found.length} links to Pipeline`)
            .setStyle(ButtonStyle.Success)
        );

        await interaction.editReply({
          content: `✅ Found **${found.length}** MEGA link(s). See attachment.\nClick the button to process all links.`,
          files: [new AttachmentBuilder(txtPath, { name: 'mega-links.txt' })],
          components: [row],
        });

        // Store in buffer map with unique timestamp key
        client._fetchBuffers.set(ts, { links: found, txtPath });

      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // ── /mg — List MEGA account files, export as .txt ──────────────────────────
    if (cmd === 'mg') {
      await interaction.deferReply({ ephemeral: true });

      try {
        await interaction.editReply({ content: '🔐 Connecting to your MEGA account…' });

        const { getStorageForConfig } = require('./megaUploader');
        const storage = await getStorageForConfig(config);
        const files   = Object.values(storage.files || {}).filter(f => f && !f.directory && f.name);

        if (files.length === 0) {
          await interaction.editReply({ content: '⚠️ No files found in your MEGA account.' });
          return;
        }

        await interaction.editReply({ content: `📂 Found **${files.length}** file(s). Generating links…` });

        const lines = [];
        for (const file of files) {
          try {
            const link = await file.link(false); // false = no expiry
            lines.push(`${file.name} | ${link}`);
          } catch { lines.push(`${file.name} | (link error)`); }
        }

        const ts = Date.now().toString();
        const txtPath = path.join(os.tmpdir(), `mega-files-${ts}.txt`);
        fs.writeFileSync(txtPath, lines.join('\n'), 'utf-8');

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`mg_pipeline_${ts}`)
            .setLabel(`🚀 Process all ${files.length} in Pipeline`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`mg_download_${ts}`)
            .setLabel('📄 Just download .txt')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({
          content: `✅ **${files.length}** files in your MEGA account.\nClick a button below:`,
          files: [new AttachmentBuilder(txtPath, { name: 'my-mega-files.txt' })],
          components: [row],
        });

        // Store in buffer map with unique timestamp key
        client._mgBuffers.set(ts, { lines, txtPath });

      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // ── /shrink — Manually collapse channels south-to-north into batch embeds ──
    if (cmd === 'shrink') {
      const count = interaction.options.getInteger('count') ?? 1;
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!shrinkControls.shrink) {
          await interaction.editReply({ content: '⚠️ Shrink control not available.' });
          return;
        }
        await interaction.editReply({ content: `🔃 Shrinking **${count}** channel(s) (south-to-north)...` });
        const { shrunk, details } = await shrinkControls.shrink(count);
        const summary = details.slice(0, 20).join('\n');
        const extra   = details.length > 20 ? `\n…and ${details.length - 20} more` : '';
        await interaction.editReply({
          content: `🗜️ **Shrink complete!** Collapsed: **${shrunk}/${count}** channel(s)\n${summary}${extra}`,
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    // ── /editembed — Edit batch embed template ────────────────────────────────
    if (cmd === 'editembed') {
      const newTitle  = interaction.options.getString('title');
      const newFormat = interaction.options.getString('fieldformat');
      const newColor  = interaction.options.getString('color');

      if (!newTitle && !newFormat && !newColor) {
        // Show current settings
        const tpl = config.batchEmbedTemplate || {};
        await interaction.reply({
          content: [
            '📄 **Current batch embed template:**',
            `\`title\` : ${tpl.title || '*(default)*'}`,
            `\`fieldformat\` : ${tpl.fieldformat || '*(default)*'}`,
            `\`color\` : ${tpl.color || '#5865F2 (default)'}`,
            '',
            '**Default format:**',
            '```',
            '**{name}**',
            '{link} | {key}',
            '```',
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      // Apply updates
      if (!config.batchEmbedTemplate) config.batchEmbedTemplate = {};
      if (newTitle)  config.batchEmbedTemplate.title       = newTitle;
      if (newFormat) config.batchEmbedTemplate.fieldformat = newFormat;
      if (newColor)  config.batchEmbedTemplate.color       = newColor;

      try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}

      // Show a live preview embed
      const { EmbedBuilder } = require('discord.js');
      const tpl    = config.batchEmbedTemplate;
      const title  = (tpl.title || 'Batch Links — Page {n}').replace('{n}', '1');
      const fmt    = tpl.fieldformat || '**{name}**\n{link} | {key}';
      const color  = parseInt((tpl.color || '#5865F2').replace('#', ''), 16);
      const demoLink = 'https://mega.co.nz/#!ExAmPlE!demoKey123';
      const demoKey  = 'demoKey123';
      const preview  = fmt
        .replace('{name}',     'Example Tool Name')
        .replace('{link}',     demoLink)
        .replace('{key}',      demoKey)
        .replace('{password}', 'pass123');

      const previewEmbed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields({ name: '\u200b', value: preview.slice(0, 1024), inline: false })
        .setFooter({ text: 'Preview — real entries will look like this' });

      await interaction.reply({
        content: '✅ **Batch embed template updated!** Preview:',
        embeds: [previewEmbed],
        ephemeral: true,
      });
      return;
    }
  });

  // ── Button interaction handler (for /fetch and /mg buttons) ──────────────────
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const id = interaction.customId;

    // Initialize buffer maps if they don't exist
    client._fetchBuffers = client._fetchBuffers || new Map();
    client._mgBuffers    = client._mgBuffers || new Map();

    // /fetch pipeline button
    if (id.startsWith('fetch_pipeline_')) {
      await interaction.deferUpdate();
      const ts = id.replace('fetch_pipeline_', '');
      const buf = client._fetchBuffers.get(ts);

      if (!buf || !buf.links) {
        await interaction.editReply({ content: '⚠️ Link data expired. Run /fetch again.', components: [] });
        return;
      }
      let queued = 0;
      for (const { link, name } of buf.links) {
        if (typeof onIngestLink === 'function') {
          try { onIngestLink(name || link, link, null); queued++; } catch {}
        }
      }
      try { fs.unlinkSync(buf.txtPath); } catch {}
      client._fetchBuffers.delete(ts);
      await interaction.editReply({
        content: `🚀 **${queued}** links handed to pipeline! Monitor progress with \`/status\`.`,
        components: [],
      });
      return;
    }

    // /mg pipeline button
    if (id.startsWith('mg_pipeline_')) {
      await interaction.deferUpdate();
      const ts = id.replace('mg_pipeline_', '');
      const buf = client._mgBuffers.get(ts);

      if (!buf || !buf.lines) {
        await interaction.editReply({ content: '⚠️ Data expired. Run /mg again.', components: [] });
        return;
      }
      let queued = 0;
      for (const line of buf.lines) {
        const parts = line.split(' | ');
        const name = parts[0];
        const link = parts[1];
        if (link && link.startsWith('http') && typeof onIngestLink === 'function') {
          try { onIngestLink(name, link, null); queued++; } catch {}
        }
      }
      try { fs.unlinkSync(buf.txtPath); } catch {}
      client._mgBuffers.delete(ts);
      await interaction.editReply({
        content: `🚀 **${queued}** MEGA links handed to pipeline! Monitor with \`/status\`.`,
        components: [],
      });
      return;
    }

    // /mg download-only button (just dismiss the buttons)
    if (id.startsWith('mg_download_')) {
      await interaction.deferUpdate();
      const ts = id.replace('mg_download_', '');
      const buf = client._mgBuffers.get(ts);
      if (buf) {
        try { fs.unlinkSync(buf.txtPath); } catch {}
        client._mgBuffers.delete(ts);
      }
      await interaction.editReply({ content: '✅ .txt file sent above. Buttons dismissed.', components: [] });
      return;
    }
  });
}

module.exports = { registerCommands, attachCommandHandler };
