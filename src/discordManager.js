const { PermissionsBitField, ChannelType } = require('discord.js');
const { getClient } = require('./discordClient');
const { buildChannelName } = require('./unicodeFormatter');

/**
 * Finds an existing category by name (case-insensitive) that has space
 * (less than 50 text channels), or creates a new category with the exact same name.
 * Multiple categories can have the same name in Discord.
 */
async function findOrCreateCategory(guild, categoryName) {
  const DISCORD_CATEGORY_LIMIT = 50;

  // Search existing categories
  await guild.channels.fetch();

  const key = categoryName.toLowerCase();
  // Filter for categories with the same name (case-insensitive)
  const matchingCats = [...guild.channels.cache.values()].filter(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === key
  );

  // Look for one that has space
  for (const cat of matchingCats) {
    const textChannelsCount = guild.channels.cache.filter(
      (ch) => ch.parentId === cat.id && ch.type === ChannelType.GuildText
    ).size;

    if (textChannelsCount < DISCORD_CATEGORY_LIMIT) {
      console.log(`[discordManager] Using category "${cat.name}" (${textChannelsCount}/${DISCORD_CATEGORY_LIMIT} channels)`);
      return cat;
    }
  }

  // If all matching categories are full or none exist, create a new one with the exact same name
  const created = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
  });
  console.log(`[discordManager] Created new category: "${created.name}" (all previous were full or none existed)`);
  return created;
}

/**
 * Returns an existing text channel inside the correct parent category that
 * matches the built channel name, or null if not found.
 */
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

/**
 * Finds a category with fewer than 50 channels starting from a base category ID.
 * If the base is full, looks for "Name (2)", "Name (3)" etc., creating if needed.
 * Returns the category ID that has space.
 */
async function resolveAvailableCategory(guild, baseCategoryId) {
  const DISCORD_CATEGORY_LIMIT = 50;

  await guild.channels.fetch();

  const baseCategory = guild.channels.cache.get(baseCategoryId);
  if (!baseCategory) return baseCategoryId; // can't resolve, use as-is

  // Count channels in base category
  const baseName = baseCategory.name;
  const countIn = (catId) =>
    guild.channels.cache.filter((ch) => ch.parentId === catId && ch.type === ChannelType.GuildText).size;

  if (countIn(baseCategoryId) < DISCORD_CATEGORY_LIMIT) return baseCategoryId;

  // Find or create overflow siblings: "Name (2)", "Name (3)", ...
  for (let n = 2; n <= 50; n++) {
    const overflowName = `${baseName} (${n})`;
    let overflow = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name === overflowName
    );

    if (!overflow) {
      // Create the overflow category
      overflow = await guild.channels.create({
        name: overflowName,
        type: ChannelType.GuildCategory,
      });
      console.log(`[discordManager] Created overflow category: ${overflowName}`);
      categoryCache.set(overflowName.toLowerCase(), overflow.id);
      return overflow.id;
    }

    if (countIn(overflow.id) < DISCORD_CATEGORY_LIMIT) return overflow.id;
  }

  // Last resort: no category (channel without parent)
  console.warn(`[discordManager] All overflow categories full — creating channel without category.`);
  return undefined;
}



async function createZipChannelOnce(zipBaseName, config, options = {}) {
  const client = await getClient(config);

  if (!config.guildId) throw new Error('guildId missing in config.json');

  const guild = await client.guilds.fetch(config.guildId);
  const channelName = buildChannelName(zipBaseName, config);

  // ── Resolve parent category ────────────────────────────────────────────────
  // For mirror engine files: use sourceCategoryName to create/find a matching
  // category on the target server (exact same name as the source category).
  // For watcher/GUI files: fall back to config.categoryId.
  let parentId = config.categoryId || undefined;
  // Track the name used for this category so overflow siblings use the same base name
  let resolvedCategoryName = null;

  if (options.sourceCategoryName) {
    try {
      const cat = await findOrCreateCategory(guild, options.sourceCategoryName);
      parentId = cat.id;
      resolvedCategoryName = options.sourceCategoryName;
    } catch (err) {
      console.warn(
        `[discordManager] Could not clone category "${options.sourceCategoryName}": ${err.message}. Using default.`
      );
    }
  }

  // If no source category name yet, derive it from the configured default category
  if (!resolvedCategoryName && parentId) {
    await guild.channels.fetch();
    const defaultCat = guild.channels.cache.get(parentId);
    resolvedCategoryName = defaultCat?.name || null;
  }

  // ── Overflow guard: pre-check if category is full ─────────────────────────
  // Handled inline during channel creation (see the overflow loop below).

  // ── Duplicate channel guard ────────────────────────────────────────────────
  const existing = await findExistingChannel(guild, channelName, parentId);
  if (existing) {
    console.log(`[discordManager] Reusing existing channel "${existing.name}" (${existing.id})`);
    return existing;
  }

  // ── Build permission overwrites ────────────────────────────────────────────
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
  ];

  if (config.permissionRoleId) {
    permissionOverwrites.push({
      id: config.permissionRoleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages,
      ],
    });
  }

  // Try creating the channel; if the category is full, auto-overflow and retry
  for (let overflowAttempt = 0; overflowAttempt < 50; overflowAttempt++) {
    try {
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentId,
        permissionOverwrites,
      });
      return channel;
    } catch (err) {
      const isFull =
        (typeof err.message === 'string' && err.message.includes('CHANNEL_PARENT_MAX_CHANNELS')) ||
        (err.rawError?.errors?.parent_id?.CHANNEL_PARENT_MAX_CHANNELS);

      if (!isFull) throw err; // bubble up non-overflow errors

      // Category is full — find or create a sibling category with the exact same name.
      console.warn(`[discordManager] Category full (attempt ${overflowAttempt + 1}) — looking for space/overflow...`);
      await guild.channels.fetch();

      const baseName = resolvedCategoryName || 'Uploads';
      try {
        const cat = await findOrCreateCategory(guild, baseName);
        parentId = cat.id;
      } catch (catErr) {
        throw new Error(`Failed to find or create category "${baseName}": ${catErr.message}`);
      }
    }
  }

  throw new Error('Could not find any available category after 50 overflow attempts.');
}


/**
 * Creates (or reuses) a Discord text channel for the given zip name.
 * Automatically retries on Discord rate limits (HTTP 429).
 *
 * @param {string} zipBaseName
 * @param {object} config
 * @param {object} [options]
 * @param {string} [options.sourceCategoryName] - Category name to clone from source server
 */
async function createZipChannel(zipBaseName, config, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await createZipChannelOnce(zipBaseName, config, options);
    } catch (err) {
      const isRateLimited =
        err.status === 429 || err.httpStatus === 429 || err.code === 429;

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

module.exports = { createZipChannel };
