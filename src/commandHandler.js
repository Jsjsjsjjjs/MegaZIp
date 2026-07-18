const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getAllStates, getLogs } = require('./stateStore');
const { editZipMessage } = require('./webhookSender');
const { getFileSha256, getFileReport, scanUrl } = require('./virusTotal');
const { invalidateSession } = require('./megaUploader');

const configPath = path.join(__dirname, '..', 'config', 'config.json');

/**
 * Registers all slash commands for a single guild.
 */
/**
 * Registers all slash commands for a single guild and globally.
 */
async function registerCommands(config) {
  if (!config.discordClientId) {
    throw new Error('discordClientId missing in config.json (needed to register slash commands)');
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('settemplate')
      .setDescription('Update the plain-text message template (owner only)')
      .addStringOption((o) =>
        o.setName('template').setDescription('Use {name}, {link}, {password}.').setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('toggleembed')
      .setDescription('Toggle between plain-text and rich embed message mode (owner only)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('updateposts')
      .setDescription('Re-render all posted webhook messages with the current template (owner only)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Get a summary of the current pipeline state (owner only)')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Scan/check a file or channel link via VirusTotal (owner only)')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel containing the MEGA link to scan').addChannelTypes(ChannelType.GuildText)
      )
      .addStringOption((o) =>
        o.setName('link').setDescription('Direct MEGA link to check')
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('regenerate')
      .setDescription('Re-download, decrypt, re-encrypt and upload to get a new MEGA link (owner only)')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Target channel to regenerate and update').setRequired(true).addChannelTypes(ChannelType.GuildText)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('regen')
      .setDescription('Alias for /regenerate (owner only)')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Target channel to regenerate and update').setRequired(true).addChannelTypes(ChannelType.GuildText)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('mirror')
      .setDescription('Control the mirror engine (owner only)')
      .addStringOption((o) =>
        o.setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'Start Scanning & Mirroring', value: 'start' },
            { name: 'Stop Mirror Engine', value: 'stop' },
            { name: 'Get Engine Status', value: 'status' }
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('pipeline')
      .setDescription('Control the active download/upload pipeline (owner only)')
      .addStringOption((o) =>
        o.setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'Pause Queue', value: 'pause' },
            { name: 'Resume Queue', value: 'resume' },
            { name: 'Cancel Pending Jobs', value: 'cancel' }
          )
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('invalidatesession')
      .setDescription('Clear saved MEGA session — forces a fresh login on next upload (use after password change)')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  // 1. Register to the target guild (instant update)
  if (config.guildId) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.guildId), {
        body: commands,
      });
      console.log(`[commandHandler] Successfully registered guild slash commands for guild ${config.guildId}`);
    } catch (err) {
      console.error(`[commandHandler] Guild slash command registration failed: ${err.message}`);
    }
  }

  // 2. Register globally (works in all servers, but cached by Discord over time)
  try {
    await rest.put(Routes.applicationCommands(config.discordClientId), {
      body: commands,
    });
    console.log('[commandHandler] Successfully registered global slash commands');
  } catch (err) {
    console.error(`[commandHandler] Global slash command registration failed: ${err.message}`);
  }
}

/**
 * Wires up the interactionCreate listener for all slash commands.
 */
/**
 * Wires up the interactionCreate listener for all slash commands.
 */
function attachCommandHandler(client, config, actions = {}) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // All commands are owner-only
    if (config.botOwnerId && interaction.user.id !== config.botOwnerId) {
      await interaction.reply({ content: '🚫 Only the bot owner can use this command.', ephemeral: true });
      return;
    }

    // ── /settemplate ─────────────────────────────────────────────────────────
    if (interaction.commandName === 'settemplate') {
      const newTemplate = interaction.options.getString('template', true);
      config.messageTemplate = newTemplate;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const warning = !newTemplate.includes('{link}')
        ? '\n⚠️ No `{link}` placeholder — the MEGA link won\'t appear in messages.'
        : '';

      await interaction.reply({
        content: `✅ Plain-text template updated:\n\`\`\`${newTemplate}\`\`\`${warning}`,
        ephemeral: true,
      });
      return;
    }

    // ── /toggleembed ─────────────────────────────────────────────────────────
    if (interaction.commandName === 'toggleembed') {
      if (!config.advancedTemplate) config.advancedTemplate = { useEmbed: false };
      config.advancedTemplate.useEmbed = !config.advancedTemplate.useEmbed;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const mode = config.advancedTemplate.useEmbed ? '🖼️ Embed' : '📝 Plain text';
      await interaction.reply({
        content: `✅ Message mode switched to **${mode}**. New deliveries will use this format.\nRun \`/updateposts\` to update already-posted messages.`,
        ephemeral: true,
      });
      return;
    }

    // ── /status ───────────────────────────────────────────────────────────────
    if (interaction.commandName === 'status') {
      const states = getAllStates() || {};
      const entries = Object.values(states);
      const counts = { pending: 0, encrypting: 0, uploading: 0, uploaded: 0, channel_created: 0, message_sent: 0, failed: 0 };
      for (const s of entries) { if (s.status in counts) counts[s.status]++; }

      const logs = getLogs();
      const lines = [
        `📊 **Pipeline Status** (${entries.length} total files)`,
        `✅ Completed: **${counts.message_sent}**`,
        `⬆️ Uploading: **${counts.uploading + counts.uploaded + counts.channel_created + counts.encrypting}**`,
        `❌ Failed: **${counts.failed}**`,
        `📋 Total logs: **${logs.length}**`,
        `🖼️ Embed mode: **${config.advancedTemplate?.useEmbed ? 'ON' : 'OFF'}**`,
      ];

      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }

    // ── /updateposts ─────────────────────────────────────────────────────────
    if (interaction.commandName === 'updateposts') {
      await interaction.deferReply({ ephemeral: true });

      const states = getAllStates() || {};
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const [filename, state] of Object.entries(states)) {
        if (state.status !== 'message_sent' || !state.channelId || !state.messageId) {
          skipped++;
          continue;
        }

        try {
          const channel = await client.channels.fetch(state.channelId);
          if (!channel) { skipped++; continue; }

          const baseName = path.basename(filename, path.extname(filename));
          await editZipMessage(channel, state.messageId, {
            name: baseName,
            link: state.megaLink || '',
            password: state.zipPassword || '',
          }, config);
          updated++;
        } catch (err) {
          console.warn(`[commandHandler] /updateposts failed for "${filename}": ${err.message}`);
          failed++;
        }
      }

      // Also scan all channels in the bot's category for any posts not in state
      if (config.guildId && config.categoryId) {
        try {
          const guild = await client.guilds.fetch(config.guildId);
          const channels = [...guild.channels.cache.values()].filter(
            (ch) => ch.parentId === config.categoryId
          );

          for (const ch of channels) {
            try {
              const webhooks = await ch.fetchWebhooks();
              const ourWebhook = webhooks.find((wh) => wh.name === 'ZipBot Delivery');
              if (!ourWebhook) continue;

              const messages = await ch.messages.fetch({ limit: 10 });
              for (const msg of messages.values()) {
                if (msg.webhookId !== ourWebhook.id) continue;
                // Check if this message is already tracked (skip if so)
                const trackedEntry = Object.values(states).find((s) => s.messageId === msg.id);
                if (trackedEntry) continue;

                // Parse name/link/password from existing content
                const content = msg.content || (msg.embeds[0]?.title ?? '');
                // Best-effort parse from plain text
                const linkMatch = content.match(/https?:\/\/mega\.nz\/[^\s]+/);
                const pwMatch = content.match(/(?:Password|pass)[:\-\s]+([^\s\n]+)/i);
                const nameMatch = content.match(/\*\*(.+?)\*\*/);

                if (!linkMatch) continue;
                await editZipMessage(ch, msg.id, {
                  name: nameMatch ? nameMatch[1] : ch.name,
                  link: linkMatch[0],
                  password: pwMatch ? pwMatch[1] : '',
                }, config);
                updated++;
              }
            } catch { /* skip channels we can't access */ }
          }
        } catch (err) {
          console.warn(`[commandHandler] /updateposts category scan failed: ${err.message}`);
        }
      }

      await interaction.editReply({
        content: `✅ Done!\n• Updated: **${updated}** messages\n• Skipped (no messageId): **${skipped}**\n• Errors: **${failed}**`,
      });
      return;
    }

    // ── /pipeline ────────────────────────────────────────────────────────────
    if (interaction.commandName === 'pipeline') {
      const action = interaction.options.getString('action', true);
      if (action === 'pause') {
        if (typeof actions.pauseDownloads === 'function') actions.pauseDownloads();
        await interaction.reply({ content: '⏸️ Pipeline downloads paused.', ephemeral: true });
      } else if (action === 'resume') {
        if (typeof actions.resumeDownloads === 'function') actions.resumeDownloads();
        await interaction.reply({ content: '▶️ Pipeline downloads resumed.', ephemeral: true });
      } else if (action === 'cancel') {
        if (typeof actions.cancelDownloads === 'function') actions.cancelDownloads();
        await interaction.reply({ content: '⏹️ All active and pending download queue jobs cancelled.', ephemeral: true });
      }
      return;
    }

    // ── /invalidatesession ────────────────────────────────────────────────────
    if (interaction.commandName === 'invalidatesession') {
      invalidateSession();
      await interaction.reply({
        content: '🔄 **MEGA session cleared.** The bot will perform a fresh email/password login on the next upload.\n💡 Use this whenever you change your MEGA account password to avoid "EBLOCKED" or session errors.',
        ephemeral: true
      });
      return;
    }

    // ── /mirror ──────────────────────────────────────────────────────────────
    if (interaction.commandName === 'mirror') {
      const action = interaction.options.getString('action', true);
      if (action === 'start') {
        await interaction.reply({ content: '🚀 Forced Mirror Engine startup initiated. Checking channels...', ephemeral: true });
        if (typeof actions.startMirrorEngine === 'function') {
          actions.startMirrorEngine(config, true).catch(err => {
            console.error(`[commandHandler] Forced Mirror start error: ${err.message}`);
          });
        }
      } else if (action === 'stop') {
        if (typeof actions.stopMirrorEngine === 'function') actions.stopMirrorEngine();
        await interaction.reply({ content: '🛑 Mirror Engine scanning stopped.', ephemeral: true });
      } else if (action === 'status') {
        if (typeof actions.getMirrorEngineStatus === 'function') {
          const status = actions.getMirrorEngineStatus();
          const counts = status.stateCounts || {};
          const lines = [
            `⚡ **Mirror Engine Status**`,
            `• Running: **${status.started ? 'Active 🟢' : 'Idle 🔴'}**`,
            `• Pending links: **${counts.pending || 0}**`,
            `• Completed links: **${counts.done || counts.message_sent || 0}**`,
            `• Failed links: **${counts.failed || 0}**`
          ];
          await interaction.reply({ content: lines.join('\n'), ephemeral: true });
        } else {
          await interaction.reply({ content: '⚠️ Mirror engine status handler is not available.', ephemeral: true });
        }
      }
      return;
    }

    // ── /regenerate ──────────────────────────────────────────────────────────
    if (interaction.commandName === 'regenerate' || interaction.commandName === 'regen') {
      const channel = interaction.options.getChannel('channel', true);
      await interaction.deferReply({ ephemeral: true });
      try {
        if (typeof actions.regenerateChannel !== 'function') {
          throw new Error('Regeneration handler is not loaded.');
        }
        const filename = await actions.regenerateChannel(channel.id);
        await interaction.editReply({
          content: `✅ Regeneration started for <#${channel.id}> (${filename}). Re-downloading and re-encrypting. The existing channel post will be updated shortly!`
        });
      } catch (err) {
        await interaction.editReply({ content: `❌ Regeneration failed: ${err.message}` });
      }
      return;
    }

    // ── /check ────────────────────────────────────────────────────────────────
    if (interaction.commandName === 'check') {
      const apiKey = process.env.VIRUSTOTAL_API_KEY || config.virusTotalApiKey;
      if (!apiKey) {
        await interaction.reply({
          content: '❌ **VirusTotal API Key is not configured.** Set the `VIRUSTOTAL_API_KEY` environment variable in Railway to use this command.',
          ephemeral: true
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      let targetLink = interaction.options.getString('link');
      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

      // If direct link is not provided, scan the target channel
      if (!targetLink && targetChannel) {
        // Try looking in local stateStore first
        const allStates = getAllStates() || {};
        const stateEntry = Object.values(allStates).find(s => s.channelId === targetChannel.id);
        if (stateEntry && stateEntry.megaLink) {
          targetLink = stateEntry.megaLink;
        } else {
          // Scan last 20 messages in channel for any MEGA link
          try {
            const msgs = await targetChannel.messages.fetch({ limit: 20 });
            const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');
            for (const msg of msgs.values()) {
              const content = msg.content || '';
              let links = extractMegaLinks(content);
              if (links.length > 0) {
                targetLink = links[0];
                break;
              }
              if (Array.isArray(msg.embeds)) {
                for (const emb of msg.embeds) {
                  const embedText = flattenEmbed(emb);
                  const embLinks = extractMegaLinks(embedText);
                  if (embLinks.length > 0) {
                    targetLink = embLinks[0];
                    break;
                  }
                }
              }
              if (targetLink) break;
            }
          } catch (err) {
            console.warn(`[commandHandler] /check failed to fetch channel history: ${err.message}`);
          }
        }
      }

      if (!targetLink) {
        await interaction.editReply({ content: '❌ No MEGA file link could be found in the specified channel or options.' });
        return;
      }

      await interaction.editReply({ content: `🔍 **URL detected:** \`${targetLink}\`\nQuerying VirusTotal reputation database...` });

      try {
        // Phase 1: Scan URL
        const urlReport = await scanUrl(targetLink, apiKey);
        const urlStats = urlReport.attributes?.last_analysis_stats || urlReport.attributes?.stats;
        let urlResult = 'Undetected';
        if (urlStats) {
          const malicious = urlStats.malicious || 0;
          const suspicious = urlStats.suspicious || 0;
          urlResult = malicious > 0 ? `🚨 **${malicious} Engines flagged as malicious**` : '🟢 **Clean (0 flags)**';
        }

        const urlId = Buffer.from(targetLink).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        const vtUrlLink = `https://www.virustotal.com/gui/url/${urlId}/detection`;

        await interaction.editReply({
          content: `🔍 **VirusTotal Results**\n\n**1. URL Reputation:**\n• Status: ${urlResult}\n• Scan Link: [VirusTotal Report](${vtUrlLink})\n\n*⌛ Downloading the file to compute SHA-256 for a deep payload scan. Please hold on...*`
        });

        // Phase 2: Download file to compute payload SHA256
        const dlFolder = path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'vt-scan');
        if (!fs.existsSync(dlFolder)) fs.mkdirSync(dlFolder, { recursive: true });
        const tempPath = path.join(dlFolder, `${Date.now()}-vt.zip`);

        const dlManager = require('./downloadEngine/downloadManager');
        await dlManager.downloadMegaFile(targetLink, tempPath, { timeoutMs: 120000 });

        const sha256 = await getFileSha256(tempPath);
        // Delete download immediately
        try { fs.unlinkSync(tempPath); } catch {}

        // Query file report by hash
        const fileReport = await getFileReport(sha256, apiKey);
        let fileText = '';
        if (fileReport) {
          const fileStats = fileReport.attributes?.last_analysis_stats;
          const vtFileLink = `https://www.virustotal.com/gui/file/${sha256}/detection`;
          if (fileStats) {
            const mal = fileStats.malicious || 0;
            const suspicious = fileStats.suspicious || 0;
            const harmless = fileStats.harmless || 0;
            const statusStr = mal > 0 ? `🚨 **Malicious (${mal} detections)**` : '🟢 **Undetected / Clean**';
            fileText = `\n**2. File Binary Scan (SHA-256: \`${sha256.slice(0, 16)}...\`):**\n• Status: ${statusStr}\n• Stats: ${harmless} safe, ${suspicious} suspicious, ${mal} malicious\n• File Scan Link: [File Analysis Report](${vtFileLink})`;
          } else {
            fileText = `\n**2. File Binary Scan:**\n• SHA-256: \`${sha256}\`\n• Report Link: [File Report](${vtFileLink})`;
          }
        } else {
          fileText = `\n**2. File Binary Scan:**\n• SHA-256: \`${sha256}\`\n• Status: 📭 *This file hasn't been uploaded or scanned on VirusTotal yet.*`;
        }

        await interaction.editReply({
          content: `🔍 **VirusTotal Results**\n\n**1. URL Reputation:**\n• Status: ${urlResult}\n• Scan Link: [URL Reputation Report](${vtUrlLink})${fileText}`
        });

      } catch (err) {
        await interaction.editReply({
          content: `🔍 **VirusTotal Results**\n\n⚠️ Error running scan: *${err.message}*`
        });
      }
      return;
    }
  });
}

module.exports = { registerCommands, attachCommandHandler };
