'use strict';

const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { getAllStates }                   = require('./stateStore');
const { editZipMessage }                 = require('./webhookSender');
const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');
const { downloadMegaFile }               = require('./downloadEngine/downloadManager');
const { scanFile }                       = require('./vtScanner');

const configPath = path.join(__dirname, '..', 'config', 'config.json');

// ── Unicode bold → ASCII normaliser (for /dcheck) ────────────────────────────
const BOLD_UNICODE_MAP = {
  '𝗔':'A','𝗕':'B','𝗖':'C','𝗗':'D','𝗘':'E','𝗙':'F','𝗚':'G','𝗛':'H','𝗜':'I','𝗝':'J',
  '𝗞':'K','𝗟':'L','𝗠':'M','𝗡':'N','𝗢':'O','𝗣':'P','𝗤':'Q','𝗥':'R','𝗦':'S','𝗧':'T',
  '𝗨':'U','𝗩':'V','𝗪':'W','𝗫':'X','𝗬':'Y','𝗭':'Z',
  '𝗮':'a','𝗯':'b','𝗰':'c','𝗱':'d','𝗲':'e','𝗳':'f','𝗴':'g','𝗵':'h','𝗶':'i','𝗷':'j',
  '𝗸':'k','𝗹':'l','𝗺':'m','𝗻':'n','𝗼':'o','𝗽':'p','𝗾':'q','𝗿':'r','𝘀':'s','𝘁':'t',
  '𝘂':'u','𝘃':'v','𝘄':'w','𝘅':'x','𝘆':'y','𝘇':'z',
  '𝟬':'0','𝟭':'1','𝟮':'2','𝟯':'3','𝟰':'4','𝟱':'5','𝟲':'6','𝟳':'7','𝟴':'8','𝟵':'9',
  // Italic bold
  '𝘼':'A','𝘽':'B','𝘾':'C','𝘿':'D','𝙀':'E','𝙁':'F','𝙂':'G','𝙃':'H','𝙄':'I','𝙅':'J',
  '𝙆':'K','𝙇':'L','𝙈':'M','𝙉':'N','𝙊':'O','𝙋':'P','𝙌':'Q','𝙍':'R','𝙎':'S','𝙏':'T',
  '𝙐':'U','𝙑':'V','𝙒':'W','𝙓':'X','𝙔':'Y','𝙕':'Z',
};

function normalizeChannelName(name) {
  if (!name) return '';
  // Replace bold unicode chars
  let out = '';
  for (const ch of name) out += BOLD_UNICODE_MAP[ch] || ch;
  // Strip Discord-illegal chars, collapse whitespace, lowercase
  return out.replace(/[^\w\s\-\.]/g, '').replace(/\s+/g, '-').toLowerCase().trim();
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

    // ── /mirror — Mirror engine control ───────────────────────────────────────
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
      await interaction.deferReply({ ephemeral: true });
      const dryRun = interaction.options.getBoolean('dryrun') ?? false;

      try {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.channels.fetch();
        const textChannels = [...guild.channels.cache.values()].filter(
          ch => ch.type === ChannelType.GuildText
        );

        // Group by normalized name
        const groups = new Map();
        for (const ch of textChannels) {
          const key = normalizeChannelName(ch.name);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(ch);
        }

        // Find groups with duplicates
        // Sort by snowflake ID (string compare works because IDs are fixed-length)
        const duplicateGroups = [...groups.values()].filter(g => g.length > 1);
        const toDelete = [];
        for (const group of duplicateGroups) {
          const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1)); // oldest first
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

    // ── /check — VirusTotal scan ──────────────────────────────────────────────
    if (cmd === 'check') {
      await interaction.deferReply({ ephemeral: true });
      // channel option accepts: channel name, raw ID, or Discord URL like discord.com/channels/.../channelId
      const channelRaw = (interaction.options.getString('channel') || '').trim();

      if (!process.env.VIRUSTOTAL_API_KEY) {
        await interaction.editReply({ content: '❌ `VIRUSTOTAL_API_KEY` is not set. Add it to Railway environment variables.' });
        return;
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
  });
}

module.exports = { registerCommands, attachCommandHandler };
