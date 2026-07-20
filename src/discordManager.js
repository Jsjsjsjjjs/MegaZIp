'use strict';

const { PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const { getClient } = require('./discordClient');
const { buildChannelName } = require('./unicodeFormatter');
const { getBatchState, setBatchState } = require('./stateStore');
const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');

// In-memory cache: categoryName (lowercase) → category channel ID
const categoryCache = new Map();

// ─── Dedup helpers ────────────────────────────────────────────────────────────
const BOLD_UNICODE_MAP = {
  '𝗔':'A','𝗕':'B','𝗖':'C','𝗗':'D','𝗘':'E','𝗙':'F','𝗚':'G','𝗛':'H','𝗜':'I','𝗝':'J',
  '𝗞':'K','𝗟':'L','𝗠':'M','𝗡':'N','𝗢':'O','𝗣':'P','𝗤':'Q','𝗥':'R','𝗦':'S','𝗧':'T',
  '𝗨':'U','𝗩':'V','𝗪':'W','𝗫':'X','𝗬':'Y','𝗭':'Z',
  '𝗮':'a','𝗯':'b','𝗰':'c','𝗱':'d','𝗲':'e','𝗳':'f','𝗴':'g','𝗵':'h','𝗶':'i','𝗷':'j',
  '𝗸':'k','𝗹':'l','𝗺':'m','𝗻':'n','𝗼':'o','𝗽':'p','𝗾':'q','𝗿':'r','𝘀':'s','𝘁':'t',
  '𝘂':'u','𝘃':'v','𝘄':'w','𝘅':'x','𝘆':'y','𝘇':'z',
  '𝟬':'0','𝟭':'1','𝟮':'2','𝟯':'3','𝟰':'4','𝟱':'5','𝟲':'6','𝟳':'7','𝟴':'8','𝟵':'9',
  '𝘼':'A','𝘽':'B','𝘾':'C','𝘿':'D','𝙀':'E','𝙁':'F','𝙂':'G','𝙃':'H','𝙄':'I','𝙅':'J',
  '𝙆':'K','𝙇':'L','𝙈':'M','𝙉':'N','𝙊':'O','𝙋':'P','𝙌':'Q','𝙍':'R','𝙎':'S','𝙏':'T',
  '𝙐':'U','𝙑':'V','𝙒':'W','𝙓':'X','𝙔':'Y','𝙕':'Z',
};

function normalizeName(name) {
  if (!name) return '';
  let out = '';
  for (const ch of name) out += BOLD_UNICODE_MAP[ch] || ch;
  return out.toLowerCase();
}

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD_CHANNEL_LIMIT  = 500;
const DEFAULT_BATCH_CAT    = 'Batch';
const DEFAULT_LINKS_PER_CH = 10;
const DEFAULT_MAX_DCHECKS  = 4;  // how many auto-dchecks before shrink kicks in

// ─── Category helpers ─────────────────────────────────────────────────────────
async function findOrCreateCategory(guild, categoryName) {
  const key = categoryName.toLowerCase();
  if (categoryCache.has(key)) {
    try {
      const cached = await guild.channels.fetch(categoryCache.get(key));
      if (cached) return cached;
    } catch {
      categoryCache.delete(key);
    }
  }

  await guild.channels.fetch();
  const existing = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === key
  );

  if (existing) {
    categoryCache.set(key, existing.id);
    console.log(`[discordManager] Using existing category: ${existing.name}`);
    return existing;
  }

  const created = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  });
  categoryCache.set(key, created.id);
  console.log(`[discordManager] Created new category: ${created.name}`);
  return created;
}

async function findExistingChannel(guild, channelName, parentId) {
  try {
    await guild.channels.fetch();
    return (
      guild.channels.cache.find(
        (ch) =>
          ch.type === ChannelType.GuildText &&
          ch.name.toLowerCase() === channelName.toLowerCase() &&
          (parentId ? ch.parentId === parentId : true)
      ) || null
    );
  } catch {
    return null;
  }
}

// ─── Guild channel count ──────────────────────────────────────────────────────
async function getGuildChannelCount(guild) {
  await guild.channels.fetch();
  return guild.channels.cache.size;
}

// ─── Auto-dedup ───────────────────────────────────────────────────────────────
/**
 * Runs a deduplication pass on the guild (same logic as /dcheck).
 * Returns { deleted } — number of channels removed.
 * Resets batchState.dchecksRun to 0 if any were deleted.
 */
async function runAutoDedup(guild) {
  await guild.channels.fetch();
  const textChannels = [...guild.channels.cache.values()].filter(
    (ch) => ch.type === ChannelType.GuildText
  );

  const groups = new Map();
  for (const ch of textChannels) {
    const key = normalizeName(ch.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);
  const toDelete = [];
  for (const group of duplicateGroups) {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1)); // oldest first
    toDelete.push(...sorted.slice(1)); // keep oldest, delete duplicates
  }

  let deleted = 0;
  for (const ch of toDelete) {
    try {
      await ch.delete('Auto-dedup by batch manager');
      deleted++;
      await new Promise((r) => setTimeout(r, 400));
    } catch { /* skip */ }
  }

  console.log(`[discordManager] Auto-dedup: removed ${deleted} duplicate channel(s).`);
  if (deleted > 0) {
    // Reset dcheck counter — the server freed space, start fresh
    setBatchState({ dchecksRun: 0 });
  }

  return { deleted };
}

// ─── Batch embed builder ──────────────────────────────────────────────────────
/**
 * Builds a Discord embed for a batch channel from the stored entries.
 * Template variables: {name} {link} {key} {password}
 */
function buildBatchEmbed(entries, config, channelNumber) {
  const tpl    = config.batchEmbedTemplate || {};
  const title  = tpl.title       || `Batch Links — Page ${channelNumber}`;
  const fmt    = tpl.fieldformat || '**{name}**\n{link} | {key}';
  const color  = parseInt((tpl.color || '#5865F2').replace('#', ''), 16);

  const embed = new EmbedBuilder()
    .setTitle(title.replace('{n}', String(channelNumber)))
    .setColor(color);

  for (const { name, link } of entries) {
    // Extract just the key from mega link (part after the last !)
    const key = link.split('!').pop() || '';
    const text = fmt
      .replace('{name}', name || 'unnamed')
      .replace('{link}', link)
      .replace('{key}', key)
      .replace('{password}', entries.password || '');
    embed.addFields({ name: '\u200b', value: text.slice(0, 1024), inline: false });
  }

  return embed;
}

// ─── addToBatch ───────────────────────────────────────────────────────────────
// Mutex to prevent concurrent writes to the same batch channel
let _batchMutex = Promise.resolve();

/**
 * Appends a name+link entry to the current open batch channel.
 * Creates a new batch channel (#N+1) when the current one is full.
 */
async function addToBatch(guild, config, name, link) {
  // Serialize calls via mutex
  _batchMutex = _batchMutex.then(() => _addToBatchInner(guild, config, name, link));
  return _batchMutex;
}

async function _addToBatchInner(guild, config, name, link) {
  const linksPerChannel = config.linksPerBatchChannel || DEFAULT_LINKS_PER_CH;
  const batchCatName    = config.batchCategoryName    || DEFAULT_BATCH_CAT;

  let bs = getBatchState();

  // Find or create the Batch category
  const batchCat = await findOrCreateCategory(guild, batchCatName);

  // Try to use the current open batch channel
  let batchChannel = null;
  if (bs.currentBatchChannelId) {
    try {
      batchChannel = await guild.channels.fetch(bs.currentBatchChannelId);
    } catch {
      batchChannel = null;
    }
  }

  // If channel is full or missing, create a new one
  if (!batchChannel || bs.currentLinkCount >= linksPerChannel) {
    const newNum  = (bs.batchSeriesNumber || 0) + 1;
    const chName  = String(newNum);

    // Check if channel already exists (idempotency)
    let ch = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === chName && c.parentId === batchCat.id
    );

    if (!ch) {
      const permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
      if (config.permissionRoleId) {
        permissionOverwrites.push({
          id: config.permissionRoleId,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
        });
      }
      ch = await guild.channels.create({
        name: chName,
        type: ChannelType.GuildText,
        parent: batchCat.id,
        permissionOverwrites,
      });
      console.log(`[discordManager] Created batch channel #${newNum}`);
    }

    batchChannel = ch;
    bs = { ...bs, batchSeriesNumber: newNum, currentBatchChannelId: ch.id, currentLinkCount: 0 };
    setBatchState(bs);
  }

  // Read existing entries from the channel's last embed message (if any)
  const existingEntries = [];
  let existingMessageId = null;

  try {
    const msgs = await batchChannel.messages.fetch({ limit: 5 });
    const embedMsg = msgs.find((m) => m.embeds && m.embeds.length > 0);
    if (embedMsg) {
      existingMessageId = embedMsg.id;
      // Reconstruct entries from embed fields
      for (const field of embedMsg.embeds[0].fields || []) {
        // Each field value looks like "**Name**\nLink | Key"
        const lines = field.value.split('\n');
        if (lines.length >= 2) {
          const rawName = lines[0].replace(/^\*\*|\*\*$/g, '');
          const rawLink = lines[1].split(' | ')[0];
          if (rawLink && rawLink.startsWith('http')) existingEntries.push({ name: rawName, link: rawLink });
        }
      }
    }
  } catch { /* ignore */ }

  const allEntries = [...existingEntries, { name, link }];
  const seriesNum  = bs.batchSeriesNumber || 1;
  const embed      = buildBatchEmbed(allEntries, config, seriesNum);

  try {
    if (existingMessageId) {
      const msg = await batchChannel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed] });
    } else {
      await batchChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    // If edit fails (e.g. message deleted), post fresh
    if (existingMessageId) {
      try { await batchChannel.send({ embeds: [embed] }); } catch { /* give up */ }
    }
  }

  const newCount = bs.currentLinkCount + 1;
  setBatchState({ currentLinkCount: newCount });
  console.log(`[discordManager] Added "${name}" to batch channel #${seriesNum} (${newCount}/${linksPerChannel})`);
}

// ─── Shrink (south-to-north) ──────────────────────────────────────────────────
/**
 * Collapses exactly `needCount` individual-link channels into batch embeds.
 *
 * "South-to-north" = picks channels from the category that sits just above
 * the Batch category in Discord's sidebar (highest position number below Batch's
 * position), then works upward through categories.
 *
 * @returns {{ shrunk: number, details: string[] }}
 */
async function shrinkMinimal(guild, config, needCount = 1) {
  await guild.channels.fetch();

  const batchCatName = (config.batchCategoryName || DEFAULT_BATCH_CAT).toLowerCase();

  // Find the Batch category position
  const batchCat = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === batchCatName
  );
  const batchPos = batchCat ? batchCat.position : Infinity;

  // Collect all text channels NOT inside the Batch category, with a known parent
  const candidates = [...guild.channels.cache.values()].filter((ch) => {
    if (ch.type !== ChannelType.GuildText) return false;
    if (!ch.parentId) return false;
    const parent = guild.channels.cache.get(ch.parentId);
    if (!parent) return false;
    if (parent.name.toLowerCase() === batchCatName) return false; // skip batch channels
    // Only consider channels whose category is above (lower position number than) Batch
    return parent.position < batchPos;
  });

  // Sort: category position DESCENDING (nearest to Batch first),
  //       then channel position ASCENDING within each category
  candidates.sort((a, b) => {
    const catA = guild.channels.cache.get(a.parentId);
    const catB = guild.channels.cache.get(b.parentId);
    const posA = catA?.position ?? 0;
    const posB = catB?.position ?? 0;
    if (posB !== posA) return posB - posA; // higher position = closer to Batch (south) = first
    return a.position - b.position;
  });

  const targets = candidates.slice(0, needCount);
  const details = [];
  let shrunk = 0;

  for (const ch of targets) {
    try {
      // Read the MEGA link from the channel's messages
      const msgs = await ch.messages.fetch({ limit: 10 });
      let foundLink = null;
      let foundName = ch.name;

      for (const msg of msgs.values()) {
        const texts = [msg.content || ''];
        for (const e of msg.embeds || []) {
          const ef = flattenEmbed(e);
          if (ef) texts.push(ef);
        }
        for (const text of texts) {
          const links = extractMegaLinks(text);
          if (links.length > 0) { foundLink = links[0]; break; }
        }
        if (foundLink) break;
      }

      if (!foundLink) {
        console.warn(`[discordManager] Shrink: no MEGA link found in #${ch.name} — skipping.`);
        details.push(`⚠️ #${ch.name}: no link found, skipped`);
        continue;
      }

      // Append to batch first, then delete the channel
      await addToBatch(guild, config, foundName, foundLink);
      await ch.delete('Shrunk into batch embed by batch manager');
      shrunk++;
      details.push(`✅ #${ch.name} → batch`);
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      details.push(`❌ #${ch.name}: ${err.message}`);
    }
  }

  console.log(`[discordManager] Shrink complete: ${shrunk}/${needCount} channel(s) collapsed.`);
  return { shrunk, details };
}

// ─── Channel limit relief ─────────────────────────────────────────────────────
/**
 * Called before every channel creation.
 * Returns 'ok' if the guild has room, 'batch' if not even after all attempts.
 *
 * Strategy:
 *   1. Check guild channel count
 *   2. If < limit → 'ok'
 *   3. Run auto-dedup up to config.maxAutoDchecks (default 4) times
 *   4. If after all dchecks we're still full → shrink exactly 1 channel
 *   5. If shrink also can't help → return 'batch'
 */
async function checkAndRelieveChannelLimit(guild, config) {
  const limit       = GUILD_CHANNEL_LIMIT;
  const maxDchecks  = config.maxAutoDchecks || DEFAULT_MAX_DCHECKS;

  let count = await getGuildChannelCount(guild);
  if (count < limit) return 'ok';

  console.log(`[discordManager] Guild at channel limit (${count}). Attempting auto-dedup...`);

  let bs = getBatchState();
  while (bs.dchecksRun < maxDchecks) {
    const newRun = bs.dchecksRun + 1;
    setBatchState({ dchecksRun: newRun });
    bs = getBatchState();
    console.log(`[discordManager] Auto-dedup run ${newRun}/${maxDchecks}...`);

    const { deleted } = await runAutoDedup(guild);
    count = await getGuildChannelCount(guild);
    if (count < limit) {
      console.log(`[discordManager] Auto-dedup freed space (${deleted} removed). Resuming normal mode.`);
      return 'ok';
    }

    console.log(`[discordManager] Still at limit after dedup run ${newRun}.`);
  }

  // All dchecks exhausted — time to shrink
  console.log(`[discordManager] All ${maxDchecks} auto-dchecks exhausted. Shrinking 1 channel (south-to-north)...`);
  const { shrunk } = await shrinkMinimal(guild, config, 1);
  count = await getGuildChannelCount(guild);

  if (shrunk > 0 && count < limit) {
    // Reset dcheck counter after successful shrink
    setBatchState({ dchecksRun: 0 });
    console.log(`[discordManager] Shrink freed 1 slot. Resuming normal mode.`);
    return 'ok';
  }

  console.log(`[discordManager] Shrink could not free enough space. Falling back to batch mode.`);
  return 'batch';
}

// ─── createZipChannelOnce (inner) ─────────────────────────────────────────────
async function createZipChannelOnce(zipBaseName, config, options = {}) {
  const client = await getClient(config);
  if (!config.guildId) throw new Error('guildId missing in config.json');

  const guild       = await client.guilds.fetch(config.guildId);
  const channelName = buildChannelName(zipBaseName, config);

  // ── Relieve channel limit before doing anything ──────────────────────────
  const limitStatus = await checkAndRelieveChannelLimit(guild, config);
  if (limitStatus === 'batch') {
    // Absolute fallback — return sentinel for batch mode
    return { channel: null, batchMode: true, guild };
  }

  // ── Resolve parent category ───────────────────────────────────────────────
  let parentId = config.categoryId || undefined;
  let resolvedCategoryName = null;

  if (options.sourceCategoryName) {
    try {
      const cat = await findOrCreateCategory(guild, options.sourceCategoryName);
      parentId = cat.id;
      resolvedCategoryName = options.sourceCategoryName;
    } catch (err) {
      console.warn(`[discordManager] Could not clone category "${options.sourceCategoryName}": ${err.message}.`);
    }
  }

  if (!resolvedCategoryName && parentId) {
    await guild.channels.fetch();
    const defaultCat = guild.channels.cache.get(parentId);
    resolvedCategoryName = defaultCat?.name || null;
  }

  // ── Duplicate channel guard ───────────────────────────────────────────────
  const existing = await findExistingChannel(guild, channelName, parentId);
  if (existing) {
    console.log(`[discordManager] Reusing existing channel "${existing.name}" (${existing.id})`);
    return { channel: existing, batchMode: false, guild };
  }

  // ── Build permission overwrites ───────────────────────────────────────────
  const permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
  if (config.permissionRoleId) {
    permissionOverwrites.push({
      id: config.permissionRoleId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages],
    });
  }

  // Try creating; if category is full, auto-overflow to sibling category
  for (let overflowAttempt = 0; overflowAttempt < 50; overflowAttempt++) {
    try {
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites,
      });
      return { channel, batchMode: false, guild };
    } catch (err) {
      const isFull =
        (typeof err.message === 'string' && err.message.includes('CHANNEL_PARENT_MAX_CHANNELS')) ||
        err.rawError?.errors?.parent_id?.CHANNEL_PARENT_MAX_CHANNELS;

      if (!isFull) throw err;

      console.warn(`[discordManager] Category full (attempt ${overflowAttempt + 1}) — looking for overflow...`);
      await guild.channels.fetch();
      const baseName     = resolvedCategoryName || 'Uploads';
      const overflowName = `${baseName} (${overflowAttempt + 2})`;

      let overflowCat = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildCategory && ch.name === overflowName
      );
      if (!overflowCat) {
        overflowCat = await guild.channels.create({ name: overflowName, type: ChannelType.GuildCategory });
        console.log(`[discordManager] Created overflow category: ${overflowName}`);
        categoryCache.set(overflowName.toLowerCase(), overflowCat.id);
      }
      parentId = overflowCat.id;
    }
  }

  throw new Error('Could not find any available category after 50 overflow attempts.');
}

// ─── Public: createZipChannel (with rate-limit retry) ────────────────────────
/**
 * Creates (or reuses) a Discord text channel for the given zip name.
 * Always returns { channel, batchMode, guild }.
 * batchMode=true means the guild was full even after all relief attempts.
 */
async function createZipChannel(zipBaseName, config, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createZipChannelOnce(zipBaseName, config, options);
    } catch (err) {
      const isRateLimited = err.status === 429 || err.httpStatus === 429 || err.code === 429;
      if (isRateLimited && attempt < maxRetries) {
        const retryAfterMs = Math.ceil((err.retry_after || err.retryAfter || 1) * 1000);
        console.warn(`[discordManager] Rate limited — retrying after ${retryAfterMs}ms...`);
        await new Promise((r) => setTimeout(r, retryAfterMs));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { createZipChannel, addToBatch, shrinkMinimal, runAutoDedup, buildBatchEmbed };
