'use strict';

const { PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const { getClient } = require('./discordClient');
const { buildChannelName } = require('./unicodeFormatter');
const { getBatchState, setBatchState } = require('./stateStore');
const { extractMegaLinks, flattenEmbed } = require('./downloadEngine/linkExtractor');

// In-memory cache: categoryName (lowercase) → category channel ID
const categoryCache = new Map();

// ─── Dedup helpers ────────────────────────────────────────────────────────────
function normalizeName(name) {
  if (!name) return '';
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    // Mathematical Serif Bold (U+1D400 - U+1D433, U+1D7CE - U+1D7D7)
    if (cp >= 0x1D400 && cp <= 0x1D419) { out += String.fromCharCode(65 + (cp - 0x1D400)); }
    else if (cp >= 0x1D41A && cp <= 0x1D433) { out += String.fromCharCode(97 + (cp - 0x1D41A)); }
    else if (cp >= 0x1D7CE && cp <= 0x1D7D7) { out += String.fromCharCode(48 + (cp - 0x1D7CE)); }
    // Mathematical Sans-Serif Bold (U+1D5D4 - U+1D607, U+1D7EC - U+1D7F5)
    else if (cp >= 0x1D5D4 && cp <= 0x1D5ED) { out += String.fromCharCode(65 + (cp - 0x1D5D4)); }
    else if (cp >= 0x1D5EE && cp <= 0x1D607) { out += String.fromCharCode(97 + (cp - 0x1D5EE)); }
    else if (cp >= 0x1D7EC && cp <= 0x1D7F5) { out += String.fromCharCode(48 + (cp - 0x1D7EC)); }
    // Mathematical Sans-Serif Bold Italic (U+1D63C - U+1D66F)
    else if (cp >= 0x1D63C && cp <= 0x1D655) { out += String.fromCharCode(65 + (cp - 0x1D63C)); }
    else if (cp >= 0x1D656 && cp <= 0x1D66F) { out += String.fromCharCode(97 + (cp - 0x1D656)); }
    else { out += ch; }
  }
  return out.toLowerCase();
}

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD_CHANNEL_LIMIT  = 500;
const DEFAULT_BATCH_CAT    = 'Batch';
const DEFAULT_LINKS_PER_CH = 10;
const DEFAULT_MAX_DCHECKS  = 4;  // how many auto-dchecks before shrink kicks in

// ─── Extract decryption key from any MEGA URL format ──────────────────────────
/**
 * Supports both URL styles:
 *   Old:  https://mega.co.nz/#!FILE_ID!DECRYPTION_KEY
 *   New:  https://mega.nz/file/FILE_ID#DECRYPTION_KEY
 *         https://mega.nz/folder/ID#KEY
 */
function extractMegaKey(url) {
  if (!url) return '';
  // New-style: mega.nz/file/ID#KEY or mega.nz/folder/ID#KEY
  const hashIdx = url.indexOf('#');
  if (hashIdx !== -1) {
    const afterHash = url.substring(hashIdx + 1);
    // Old-style has #! so the key is the part after the last !
    if (afterHash.startsWith('!')) {
      // #!FILE_ID!KEY
      const parts = afterHash.split('!');
      return parts.length >= 3 ? parts[2] : parts[parts.length - 1] || '';
    }
    // New-style: #KEY (no !)
    return afterHash || '';
  }
  return '';
}

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
async function getChannelMegaLinks(channel) {
  const links = new Set();
  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    for (const msg of msgs.values()) {
      const texts = [msg.content || ''];
      if (msg.embeds) {
        for (const e of msg.embeds) {
          const ef = flattenEmbed(e);
          if (ef) texts.push(ef);
        }
      }
      for (const text of texts) {
        for (const link of extractMegaLinks(text)) {
          links.add(link);
        }
      }
    }
  } catch { /* skip inaccessible */ }
  return links;
}

async function findDuplicateChannels(guild, config = {}) {
  await guild.channels.fetch();
  const batchCatName = (config.batchCategoryName || DEFAULT_BATCH_CAT).toLowerCase();

  // Exclude channels in the Batch category
  const textChannels = [...guild.channels.cache.values()].filter((ch) => {
    if (ch.type !== ChannelType.GuildText) return false;
    if (!ch.parentId) return true;
    const parent = guild.channels.cache.get(ch.parentId);
    if (!parent) return true;
    return parent.name.toLowerCase() !== batchCatName;
  });

  const groups = new Map();
  for (const ch of textChannels) {
    const key = normalizeName(ch.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }

  const candidateGroups = [...groups.values()].filter((g) => g.length > 1);
  const toDelete = [];

  for (const group of candidateGroups) {
    const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1));
    const primaryChannel = sorted[0];
    const primaryLinks = await getChannelMegaLinks(primaryChannel);
    const seenLinks = new Set(primaryLinks);

    for (let i = 1; i < sorted.length; i++) {
      const ch = sorted[i];
      const chLinks = await getChannelMegaLinks(ch);

      if (chLinks.size === 0) {
        // Channel has no MEGA link -> empty/broken channel -> candidate for cleanup
        toDelete.push(ch);
      } else {
        let isDuplicate = false;
        for (const link of chLinks) {
          if (seenLinks.has(link)) {
            isDuplicate = true;
            break;
          }
        }

        if (isDuplicate) {
          toDelete.push(ch);
        } else {
          // Channel has unique link(s) -> preserve it!
          for (const link of chLinks) {
            seenLinks.add(link);
          }
        }
      }
    }
  }

  return toDelete;
}

async function runAutoDedup(guild, config = {}) {
  const toDelete = await findDuplicateChannels(guild, config);

  let deleted = 0;
  for (const ch of toDelete) {
    try {
      await ch.delete('Auto-dedup by batch manager');
      deleted++;
      await new Promise((r) => setTimeout(r, 400));
    } catch { /* skip */ }
  }

  console.log(`[discordManager] Auto-dedup: removed ${deleted} duplicate channel(s).`);
  return { deleted, toDelete };
}


// ─── Batch embed builder ──────────────────────────────────────────────────────
/**
 * Builds a Discord embed from a list of { name, link } entries.
 * Uses extractMegaKey() so both old and new MEGA URL formats work correctly.
 */
function buildBatchEmbed(entries, config, channelNumber) {
  const tpl    = config.batchEmbedTemplate || {};
  const title  = (tpl.title || `Batch Links — Page {n}`).replace('{n}', String(channelNumber));
  const fmt    = tpl.fieldformat || '**{name}**\n{link} | {key}';
  const color  = parseInt((tpl.color || '#5865F2').replace('#', ''), 16);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  // Deduplicate by link before building
  const seen = new Set();
  for (const { name, link } of entries) {
    if (!link || seen.has(link)) continue;
    seen.add(link);

    const key = extractMegaKey(link);
    const text = fmt
      .replace('{name}', name || 'unnamed')
      .replace('{link}', link)
      .replace('{key}', key)
      .replace('{password}', '');
    embed.addFields({ name: '\u200b', value: text.slice(0, 1024), inline: false });
  }

  return embed;
}

// ─── In-memory batch entry tracker ────────────────────────────────────────────
// Tracks entries per batch channel to avoid fragile embed-parsing on re-read.
// Key = channelId, Value = [{ name, link }]
const _batchEntries = new Map();

// ─── addToBatch ───────────────────────────────────────────────────────────────
let _batchMutex = Promise.resolve();

async function addToBatch(guild, config, name, link) {
  // Serialize via mutex to prevent concurrent writes
  let result;
  _batchMutex = _batchMutex
    .then(() => _addToBatchInner(guild, config, name, link))
    .then(r => { result = r; })
    .catch(err => { console.error('[discordManager] addToBatch error:', err.message); });
  await _batchMutex;
  return result;
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

    await guild.channels.fetch();
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
    // Clear in-memory entries for new channel
    _batchEntries.set(ch.id, []);
  }

  // Get entries from in-memory tracker (canonical source of truth)
  let entries = _batchEntries.get(batchChannel.id);
  if (!entries) {
    // First time seeing this channel (e.g. after restart) — rebuild from embed
    entries = [];
    try {
      const msgs = await batchChannel.messages.fetch({ limit: 5 });
      const embedMsg = [...msgs.values()].find((m) => m.embeds && m.embeds.length > 0);
      if (embedMsg && embedMsg.embeds[0]) {
        for (const field of embedMsg.embeds[0].fields || []) {
          // Extract links from field values using the robust link extractor
          const links = extractMegaLinks(field.value);
          if (links.length > 0) {
            // Try to extract name from the first line (usually **Name**)
            const firstLine = field.value.split('\n')[0] || '';
            const fieldName = firstLine.replace(/^\*\*|\*\*$/g, '').trim() || 'unnamed';
            entries.push({ name: fieldName, link: links[0] });
          }
        }
      }
    } catch { /* ignore read errors */ }
    _batchEntries.set(batchChannel.id, entries);
  }

  // Dedup: skip if this exact link is already in the batch
  if (entries.some(e => e.link === link)) {
    console.log(`[discordManager] Skipping duplicate in batch: "${name}" (${link})`);
    return;
  }

  // Add the new entry
  entries.push({ name, link });
  _batchEntries.set(batchChannel.id, entries);

  const seriesNum = bs.batchSeriesNumber || 1;
  const embed     = buildBatchEmbed(entries, config, seriesNum);

  // Find existing embed message to edit (or send fresh)
  let existingMessageId = null;
  try {
    const msgs = await batchChannel.messages.fetch({ limit: 5 });
    const embedMsg = [...msgs.values()].find((m) => m.embeds && m.embeds.length > 0);
    if (embedMsg) existingMessageId = embedMsg.id;
  } catch { /* ignore */ }

  try {
    if (existingMessageId) {
      const msg = await batchChannel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed] });
    } else {
      await batchChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error(`[discordManager] Failed to update batch embed: ${err.message}`);
    // Fallback: try sending fresh
    if (existingMessageId) {
      try { await batchChannel.send({ embeds: [embed] }); } catch { /* give up */ }
    }
  }

  const newCount = bs.currentLinkCount + 1;
  setBatchState({ currentLinkCount: newCount });
  console.log(`[discordManager] Added "${name}" to batch #${seriesNum} (${newCount}/${linksPerChannel})`);
}

// ─── Shrink (south-to-north) ──────────────────────────────────────────────────
async function shrinkMinimal(guild, config, needCount = 1) {
  await guild.channels.fetch();

  const batchCatName = (config.batchCategoryName || DEFAULT_BATCH_CAT).toLowerCase();

  const batchCat = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === batchCatName
  );
  const batchPos = batchCat ? batchCat.position : Infinity;

  // Collect candidates: text channels NOT in Batch category, with a parent category
  const candidates = [...guild.channels.cache.values()].filter((ch) => {
    if (ch.type !== ChannelType.GuildText) return false;
    if (!ch.parentId) return false;
    const parent = guild.channels.cache.get(ch.parentId);
    if (!parent) return false;
    if (parent.name.toLowerCase() === batchCatName) return false;
    return parent.position < batchPos;
  });

  // South-to-north: category position DESC (nearest to batch first),
  // then channel position ASC within each category
  candidates.sort((a, b) => {
    const catA = guild.channels.cache.get(a.parentId);
    const catB = guild.channels.cache.get(b.parentId);
    const posA = catA?.position ?? 0;
    const posB = catB?.position ?? 0;
    if (posB !== posA) return posB - posA;
    return a.position - b.position;
  });

  const targets = candidates.slice(0, needCount);
  const details = [];
  let shrunk = 0;

  for (const ch of targets) {
    try {
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
        console.warn(`[discordManager] Shrink: no MEGA link in #${ch.name} — skipping.`);
        details.push(`⚠️ #${ch.name}: no link found, skipped`);
        continue;
      }

      await addToBatch(guild, config, foundName, foundLink);
      await ch.delete('Shrunk into batch by batch manager');
      shrunk++;
      details.push(`✅ #${ch.name} → batch`);
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      details.push(`❌ #${ch.name}: ${err.message}`);
    }
  }

  console.log(`[discordManager] Shrink: ${shrunk}/${needCount} collapsed.`);
  return { shrunk, details };
}

// ─── Channel limit relief ─────────────────────────────────────────────────────
async function checkAndRelieveChannelLimit(guild, config) {
  const limit       = GUILD_CHANNEL_LIMIT;
  const maxDchecks  = config.maxAutoDchecks || DEFAULT_MAX_DCHECKS;

  let count = await getGuildChannelCount(guild);
  if (count < limit) return 'ok';

  console.log(`[discordManager] Guild at channel limit (${count}). Attempting auto-dedup...`);

  // Track dchecks for this relief cycle (not globally persisted, to avoid stale counter issues)
  for (let run = 0; run < maxDchecks; run++) {
    console.log(`[discordManager] Auto-dedup run ${run + 1}/${maxDchecks}...`);
    const { deleted } = await runAutoDedup(guild);

    count = await getGuildChannelCount(guild);
    if (count < limit) {
      console.log(`[discordManager] Auto-dedup freed space (${deleted} removed). Resuming normal.`);
      return 'ok';
    }

    // If nothing was deleted, no point repeating the same dedup
    if (deleted === 0) {
      console.log(`[discordManager] Dedup found nothing new to delete — skipping remaining runs.`);
      break;
    }

    console.log(`[discordManager] Still at limit after dedup run ${run + 1}.`);
  }

  // All dchecks exhausted — shrink exactly 1 channel
  console.log(`[discordManager] Dchecks exhausted. Shrinking 1 channel (south-to-north)...`);
  const { shrunk } = await shrinkMinimal(guild, config, 1);
  count = await getGuildChannelCount(guild);

  if (shrunk > 0 && count < limit) {
    console.log(`[discordManager] Shrink freed 1 slot. Resuming normal.`);
    return 'ok';
  }

  console.log(`[discordManager] Shrink could not free space. Falling back to batch mode.`);
  return 'batch';
}

// ─── createZipChannelOnce (inner) ─────────────────────────────────────────────
async function createZipChannelOnce(zipBaseName, config, options = {}) {
  const client = await getClient(config);
  if (!config.guildId) throw new Error('guildId missing in config.json');

  const guild       = await client.guilds.fetch(config.guildId);
  const channelName = buildChannelName(zipBaseName, config);

  const limitStatus = await checkAndRelieveChannelLimit(guild, config);
  if (limitStatus === 'batch') {
    return { channel: null, batchMode: true, guild };
  }

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

  // Duplicate channel guard
  const existing = await findExistingChannel(guild, channelName, parentId);
  if (existing) {
    console.log(`[discordManager] Reusing existing channel "${existing.name}" (${existing.id})`);
    return { channel: existing, batchMode: false, guild };
  }

  const permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
  if (config.permissionRoleId) {
    permissionOverwrites.push({
      id: config.permissionRoleId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages],
    });
  }

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

      console.warn(`[discordManager] Category full (attempt ${overflowAttempt + 1}) — overflow...`);
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

// ─── Public: createZipChannel ────────────────────────────────────────────────
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

module.exports = { createZipChannel, addToBatch, shrinkMinimal, runAutoDedup, findDuplicateChannels, buildBatchEmbed };
