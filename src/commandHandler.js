const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getAllStates, getLogs } = require('./stateStore');
const { editZipMessage } = require('./webhookSender');

const configPath = path.join(__dirname, '..', 'config', 'config.json');

/**
 * Registers all slash commands for a single guild.
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
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.guildId), {
    body: commands,
  });
}

/**
 * Wires up the interactionCreate listener for all slash commands.
 */
function attachCommandHandler(client, config) {
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
  });
}

module.exports = { registerCommands, attachCommandHandler };
