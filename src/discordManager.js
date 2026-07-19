'use strict';

const { PermissionsBitField, ChannelType } = require('discord.js');
const { getClient } = require('./discordClient');
const { buildChannelName } = require('./unicodeFormatter');

// ── Constants ─────────────────────────────────────────────────────────────────
const GUILD_CHANNEL_LIMIT = 490;   // trigger batch mode at this total count
const BATCH_LINKS_PER_EMBED = 10;  // max links per batch embed (1 embed per channel)

// ── In-memory caches ──────────────────────────────────────────────────────────
// categoryName (lowercase) → category channel ID
const categoryCache = new Map();

// Batch state: { channelId, messageId, entries:[{name,link}], batchNum }
// Shared across all concurrent pipeline workers — protected by _batchMutex.
let _batchState = null;

// ── Mutex for batch operations (prevents concurrent embed edits) ───────────────
// All batch writes are serialised through this async queue.
const _batchMutexQueue = [];
let _batchMutexLocked  = false;

async function _withBatchMutex(fn) {
  // If locked, queue and wait
  if (_batchMutexLocked) {
    await new Promise(resolve => _batchMutexQueue.push(resolve));
  }
  _batchMutexLocked = true;
  try {
    return await fn();
  } finally {
    // Release: wake next waiter, or unlock
    if (_batchMutexQueue.length > 0) {
      const next = _batchMutexQueue.shift();
      next(); // next holder will run, _batchMutexLocked stays true
    } else {
      _batchMutexLocked = false;
    }
  }
}

// ── Permission helper ─────────────────────────────────────────────────────────
function buildPermOverwrites(guild, config) {
  const ow = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
  if (config.permissionRoleId) {
    ow.push({
      id: config.permissionRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }
  return ow;
}

// ── Category helpers ──────────────────────────────────────────────────────────
async function findOrCreateCategory(guild, categoryName) {
  const key = categoryName.toLowerCase();
  if (categoryCache.has(key)) {
    try {
      const cached = await guild.channels.fetch(categoryCache.get(key));
      if (cached) return cached;
    } catch { categoryCache.delete(key); }
  }

  await guild.channels.fetch();
  const existing = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === key
  );
  if (existing) { categoryCache.set(key, existing.id); return existing; }

  const created = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
  categoryCache.set(key, created.id);
  console.log(`[discordManager] Created category: ${created.name}`);
  return created;
}

async function findExistingChannel(guild, channelName, parentId) {
  try {
    await guild.channels.fetch();
    return guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildText &&
            ch.name.toLowerCase() === channelName.toLowerCase() &&
            (parentId ? ch.parentId === parentId : true)
    ) || null;
  } catch { return null; }
}

// ── Guild limit check ─────────────────────────────────────────────────────────
async function isGuildNearChannelLimit(guild) {
  await guild.channels.fetch();
  return guild.channels.cache.size >= GUILD_CHANNEL_LIMIT;
}

// ── Batch embed builder ───────────────────────────────────────────────────────
function buildBatchEmbed(batchNum, entries) {
  const lines = entries.map((e, i) =>
    `\`${String(i + 1).padStart(2, '0')}\` **${e.name}**\n    🔗 ${e.link}`
  );
  return {
    color: 0x5865F2,
    title: `📦 Batch #${batchNum}  (${entries.length}/${BATCH_LINKS_PER_EMBED})`,
    description: lines.join('\n\n'),
    footer: { text: entries.length < BATCH_LINKS_PER_EMBED ? `${BATCH_LINKS_PER_EMBED - entries.length} slot(s) remaining` : 'Full' },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Adds a {name, link} entry to a batch channel.
 * - Finds the current batch channel (most recent with < 10 links in its embed).
 * - Creates a new batch channel when needed.
 * - All writes are serialised through a mutex to prevent concurrent corruption.
 *
 * @param {object} guild   Discord guild object (Bot client)
 * @param {object} config  App config
 * @param {string} name    File / entry name
 * @param {string} link    Public MEGA link
 */
async function addToBatch(guild, config, name, link) {
  return _withBatchMutex(async () => {
    const parentId = config.categoryId || undefined;

    // ── Try to use the in-memory batch state first ────────────────────────────
    if (_batchState) {
      try {
        const ch  = await guild.channels.fetch(_batchState.channelId);
        const msg = await ch.messages.fetch(_batchState.messageId);

        _batchState.entries.push({ name, link });
        const embed = buildBatchEmbed(_batchState.batchNum, _batchState.entries);
        await msg.edit({ embeds: [embed] });

        console.log(`[discordManager] Batch #${_batchState.batchNum}: ${_batchState.entries.length}/${BATCH_LINKS_PER_EMBED} — added "${name}"`);

        // If the embed is now full, clear state so the next entry gets a new channel
        if (_batchState.entries.length >= BATCH_LINKS_PER_EMBED) {
          console.log(`[discordManager] Batch #${_batchState.batchNum} full — next entry will create a new batch channel.`);
          _batchState = null;
        }
        return;
      } catch (err) {
        // Channel or message no longer exists — fall through to create a new one
        console.warn(`[discordManager] Batch state stale (${err.message}) — creating new batch channel.`);
        _batchState = null;
      }
    }

    // ── Recover batch state from Discord (e.g. after bot restart) ────────────
    await guild.channels.fetch();
    const existingBatchChannels = [...guild.channels.cache.values()]
      .filter(ch =>
        ch.type === ChannelType.GuildText &&
        /^batch-\d+$/.test(ch.name) &&
        (parentId ? ch.parentId === parentId : true)
      )
      .sort((a, b) => parseInt(b.name.split('-')[1]) - parseInt(a.name.split('-')[1])); // newest first

    for (const ch of existingBatchChannels) {
      try {
        const msgs = await ch.messages.fetch({ limit: 5 });
        const latest = msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp).last();
        if (!latest || !latest.embeds.length) continue;

        // Parse how many entries are already in this embed
        const desc  = latest.embeds[0].description || '';
        const count = (desc.match(/^`\d+`/gm) || []).length;

        if (count < BATCH_LINKS_PER_EMBED) {
          // Re-hydrate the entry list from the embed description
          const entries = [];
          const lineRe  = /^`(\d+)`\s+\*\*(.+?)\*\*\n\s+🔗\s+(\S+)/gm;
          let m;
          while ((m = lineRe.exec(desc)) !== null) {
            entries.push({ name: m[2], link: m[3] });
          }

          const batchNum = parseInt(ch.name.split('-')[1]);
          _batchState = { channelId: ch.id, messageId: latest.id, entries, batchNum };

          // Add the new entry and edit the embed
          _batchState.entries.push({ name, link });
          const embed = buildBatchEmbed(batchNum, _batchState.entries);
          await latest.edit({ embeds: [embed] });
          console.log(`[discordManager] Recovered batch #${batchNum}: ${_batchState.entries.length}/${BATCH_LINKS_PER_EMBED} — added "${name}"`);

          if (_batchState.entries.length >= BATCH_LINKS_PER_EMBED) _batchState = null;
          return;
        }
      } catch { continue; }
    }

    // ── Create a brand-new batch channel ─────────────────────────────────────
    const nextNum   = existingBatchChannels.length + 1;
    const batchName = `batch-${nextNum}`;
    console.log(`[discordManager] Creating new batch channel: ${batchName}`);

    const permissionOverwrites = buildPermOverwrites(guild, config);
    const newCh = await guild.channels.create({
      name: batchName, type: ChannelType.GuildText,
      parent: parentId, permissionOverwrites,
    });

    const entries = [{ name, link }];
    const embed   = buildBatchEmbed(nextNum, entries);
    const msg     = await newCh.send({ embeds: [embed] });

    _batchState = { channelId: newCh.id, messageId: msg.id, entries, batchNum: nextNum };
    console.log(`[discordManager] Batch #${nextNum}: 1/${BATCH_LINKS_PER_EMBED} — added "${name}"`);
  });
}

// ── Main channel creation ─────────────────────────────────────────────────────
async function createZipChannelOnce(zipBaseName, config, options = {}) {
  const client = await getClient(config);
  if (!config.guildId) throw new Error('guildId missing in config.json');

  const guild       = await client.guilds.fetch(config.guildId);
  const channelName = buildChannelName(zipBaseName, config);

  // ── Guild-wide channel limit → batch mode ─────────────────────────────────
  if (await isGuildNearChannelLimit(guild)) {
    // Return a sentinel — index.js will call addToBatch directly
    return { channel: null, batchMode: true, guild };
  }

  // ── Resolve parent category ────────────────────────────────────────────────
  let parentId = config.categoryId || undefined;
  let resolvedCategoryName = null;

  if (options.sourceCategoryName) {
    try {
      const cat = await findOrCreateCategory(guild, options.sourceCategoryName);
      parentId = cat.id;
      resolvedCategoryName = options.sourceCategoryName;
    } catch (err) {
      console.warn(`[discordManager] Category "${options.sourceCategoryName}" failed: ${err.message}. Using default.`);
    }
  }
  if (!resolvedCategoryName && parentId) {
    await guild.channels.fetch();
    resolvedCategoryName = guild.channels.cache.get(parentId)?.name || null;
  }

  // ── Duplicate guard ────────────────────────────────────────────────────────
  const existing = await findExistingChannel(guild, channelName, parentId);
  if (existing) {
    console.log(`[discordManager] Reusing channel "${existing.name}" (${existing.id})`);
    return { channel: existing, batchMode: false };
  }

  // ── Create channel (with per-category overflow loop) ──────────────────────
  const permissionOverwrites = buildPermOverwrites(guild, config);

  for (let overflow = 0; overflow < 50; overflow++) {
    try {
      const channel = await guild.channels.create({
        name: channelName, type: ChannelType.GuildText,
        parent: parentId, permissionOverwrites,
      });
      return { channel, batchMode: false };
    } catch (err) {
      const isFull =
        (typeof err.message === 'string' && err.message.includes('CHANNEL_PARENT_MAX_CHANNELS')) ||
        err.rawError?.errors?.parent_id?.CHANNEL_PARENT_MAX_CHANNELS;

      if (!isFull) throw err;

      console.warn(`[discordManager] Category full — creating overflow category (attempt ${overflow + 1})…`);
      await guild.channels.fetch();

      const baseName     = resolvedCategoryName || 'Uploads';
      const overflowName = `${baseName} (${overflow + 2})`;
      let overflowCat    = guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildCategory && ch.name === overflowName
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

/**
 * Public entry — wraps createZipChannelOnce with rate-limit retry.
 * Returns { channel, batchMode, guild? }
 *   batchMode=false → use channel + send webhook message normally
 *   batchMode=true  → call addToBatch(guild, config, name, link) instead
 */
async function createZipChannel(zipBaseName, config, options = {}) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      return await createZipChannelOnce(zipBaseName, config, options);
    } catch (err) {
      const isRateLimited = err.status === 429 || err.httpStatus === 429 || err.code === 429;
      if (isRateLimited && attempt < 3) {
        const delay = Math.ceil((err.retry_after || err.retryAfter || 1) * 1000);
        console.warn(`[discordManager] Rate-limited — retrying after ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { createZipChannel, addToBatch, findOrCreateCategory, isGuildNearChannelLimit };
