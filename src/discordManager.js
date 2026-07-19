'use strict';

const { PermissionsBitField, ChannelType } = require('discord.js');
const { getClient } = require('./discordClient');
const { buildChannelName } = require('./unicodeFormatter');

// In-memory cache: categoryName (lowercase) → category channel ID
const categoryCache = new Map();

// Guild-wide channel limit (Discord max is 500, we trigger batch mode at 490)
const GUILD_CHANNEL_LIMIT = 490;
// Max file-embed messages per batch channel before creating a new one
const BATCH_CHANNEL_MAX   = 25;

// ── Internal helpers ──────────────────────────────────────────────────────────

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
  if (existing) {
    categoryCache.set(key, existing.id);
    console.log(`[discordManager] Using existing category: ${existing.name}`);
    return existing;
  }

  const created = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
  categoryCache.set(key, created.id);
  console.log(`[discordManager] Created new category: ${created.name}`);
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

/**
 * Returns true when the guild has >= GUILD_CHANNEL_LIMIT total channels.
 */
async function isGuildNearChannelLimit(guild) {
  await guild.channels.fetch();
  return guild.channels.cache.size >= GUILD_CHANNEL_LIMIT;
}

/**
 * Finds or creates a batch-embed channel (named batch-1, batch-2, …).
 * Each batch channel holds up to BATCH_CHANNEL_MAX file-embed messages.
 * Used automatically when the guild channel limit is reached.
 */
async function findOrCreateBatchChannel(guild, config) {
  await guild.channels.fetch();
  const parentId = config.categoryId || undefined;

  const batchChannels = [...guild.channels.cache.values()]
    .filter(ch =>
      ch.type === ChannelType.GuildText &&
      /^batch-\d+$/.test(ch.name) &&
      (parentId ? ch.parentId === parentId : true)
    )
    .sort((a, b) => parseInt(a.name.split('-')[1]) - parseInt(b.name.split('-')[1]));

  // Find a batch channel with room
  for (const ch of batchChannels) {
    try {
      const msgs = await ch.messages.fetch({ limit: BATCH_CHANNEL_MAX + 5 });
      if (msgs.size < BATCH_CHANNEL_MAX) return ch;
    } catch { continue; }
  }

  // All full — create the next batch channel
  const nextNum   = batchChannels.length + 1;
  const batchName = `batch-${nextNum}`;
  console.log(`[discordManager] Guild at channel limit — creating batch channel: ${batchName}`);

  const permissionOverwrites = buildPermOverwrites(guild, config);
  return guild.channels.create({
    name: batchName, type: ChannelType.GuildText,
    parent: parentId, permissionOverwrites,
  });
}

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

// ── Main public API ───────────────────────────────────────────────────────────

async function createZipChannelOnce(zipBaseName, config, options = {}) {
  const client = await getClient(config);
  if (!config.guildId) throw new Error('guildId missing in config.json');

  const guild       = await client.guilds.fetch(config.guildId);
  const channelName = buildChannelName(zipBaseName, config);

  // ── Guild-wide channel limit check ────────────────────────────────────────
  if (await isGuildNearChannelLimit(guild)) {
    console.warn('[discordManager] Guild at channel limit — switching to batch embed mode.');
    const batchCh = await findOrCreateBatchChannel(guild, config);
    // { channel, batchMode:true } tells the pipeline to post an embed, not create a new channel
    return { channel: batchCh, batchMode: true };
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
      console.warn(`[discordManager] Could not clone category "${options.sourceCategoryName}": ${err.message}. Falling back.`);
    }
  }
  if (!resolvedCategoryName && parentId) {
    await guild.channels.fetch();
    resolvedCategoryName = guild.channels.cache.get(parentId)?.name || null;
  }

  // ── Duplicate guard ────────────────────────────────────────────────────────
  const existing = await findExistingChannel(guild, channelName, parentId);
  if (existing) {
    console.log(`[discordManager] Reusing existing channel "${existing.name}" (${existing.id})`);
    return { channel: existing, batchMode: false };
  }

  // ── Create channel with category-overflow loop ─────────────────────────────
  const permissionOverwrites = buildPermOverwrites(guild, config);

  for (let overflowAttempt = 0; overflowAttempt < 50; overflowAttempt++) {
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

      console.warn(`[discordManager] Category full (attempt ${overflowAttempt + 1}) — creating overflow category…`);
      await guild.channels.fetch();

      const baseName     = resolvedCategoryName || 'Uploads';
      const overflowName = `${baseName} (${overflowAttempt + 2})`;
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
 * Public entry point — wraps createZipChannelOnce with rate-limit retry.
 * Returns { channel, batchMode }.
 *   batchMode=false → post via webhook as normal
 *   batchMode=true  → post a plain embed message to the batch channel
 */
async function createZipChannel(zipBaseName, config, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createZipChannelOnce(zipBaseName, config, options);
    } catch (err) {
      const isRateLimited = err.status === 429 || err.httpStatus === 429 || err.code === 429;
      if (isRateLimited && attempt < maxRetries) {
        const delay = Math.ceil((err.retry_after || err.retryAfter || 1) * 1000);
        console.warn(`[discordManager] Rate limited — retrying after ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { createZipChannel, findOrCreateCategory, isGuildNearChannelLimit };
