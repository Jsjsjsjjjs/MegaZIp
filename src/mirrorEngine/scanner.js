'use strict';

/**
 * mirrorEngine/scanner.js
 *
 * Standalone scanner — starts a temporary selfbot client, scans all source
 * guild channels for MEGA links, and returns the results as an array without
 * running the full pipeline. Used by the /fetch slash command.
 */

const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { extractMegaLinks, flattenEmbed } = require('../downloadEngine/linkExtractor');

/**
 * Extracts a suggested file name from a message's text (first bold or quoted word).
 */
function extractName(text, fallback) {
  if (!text) return fallback;
  const m = text.match(/\*\*([^*]+)\*\*/) || text.match(/"([^"]+)"/) || text.match(/`([^`]+)`/);
  return (m && m[1].trim()) || fallback;
}

/**
 * Scan all source server channels for MEGA links using a temporary selfbot session.
 * @param {object} config  Full app config (mirrorEngine.userToken, mirrorEngine.sourceGuildIds, etc.)
 * @returns {Promise<Array<{link:string, name:string, categoryName:string}>>}
 */
function startScan(config) {
  return new Promise((resolve, reject) => {
    const mc = config.mirrorEngine || {};
    if (!mc.userToken) {
      return reject(new Error('mirrorEngine.userToken is not configured. Set MIRROR_USER_TOKEN in Railway.'));
    }

    const selfbot = new SelfbotClient({ checkUpdate: false });
    const results = [];

    selfbot.once('ready', async () => {
      try {
        const srcGuildIds = Array.isArray(mc.sourceGuildIds) ? mc.sourceGuildIds : [];
        const excChannels = new Set(Array.isArray(mc.excludeChannelIds) ? mc.excludeChannelIds : []);
        const chTimeout   = mc.channelTimeoutMs || 20_000;

        let guilds = srcGuildIds.length
          ? srcGuildIds.map(id => selfbot.guilds.cache.get(id)).filter(Boolean)
          : [...selfbot.guilds.cache.values()];

        console.log(`[scanner] /fetch — scanning ${guilds.length} guild(s)...`);

        for (const guild of guilds) {
          let channels;
          try { channels = [...(await guild.channels.fetch()).values()].filter(
            ch => ch && typeof ch.messages?.fetch === 'function' && !excChannels.has(ch.id)
          ); } catch (e) {
            console.warn(`[scanner] ${guild.name}: ${e.message}`);
            continue;
          }

          console.log(`[scanner] ${guild.name} — ${channels.length} channel(s)`);

          // Scan channels in batches of 4 to stay under rate limits
          for (let i = 0; i < channels.length; i += 4) {
            const batch = channels.slice(i, i + 4);
            await Promise.allSettled(batch.map(async (ch) => {
              const categoryName = ch.parent?.name || '';
              let lastId = null;
              let fetched = 0;

              while (fetched < 500) {
                let msgs;
                try {
                  msgs = await Promise.race([
                    ch.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) }),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), chTimeout)),
                  ]);
                } catch { break; }

                if (!msgs || msgs.size === 0) break;
                const arr = [...msgs.values()];
                fetched += arr.length;

                for (const msg of arr) {
                  // Plain text
                  for (const link of extractMegaLinks(msg.content || '')) {
                    results.push({ link, name: extractName(msg.content, ch.name), categoryName });
                  }
                  // Embeds
                  for (const embed of msg.embeds || []) {
                    const txt = flattenEmbed(embed);
                    for (const link of extractMegaLinks(txt)) {
                      results.push({ link, name: embed.title || extractName(txt, ch.name), categoryName });
                    }
                  }
                }

                lastId = arr[arr.length - 1].id;
              }
            }));
            // Small delay between batches
            if (i + 4 < channels.length) await new Promise(r => setTimeout(r, 1000));
          }
        }

        console.log(`[scanner] /fetch scan complete — ${results.length} link(s) found.`);
        resolve(results);
      } catch (err) {
        reject(err);
      } finally {
        selfbot.destroy();
      }
    });

    selfbot.once('error', err => {
      selfbot.destroy();
      reject(err);
    });

    selfbot.login(mc.userToken).catch(err => {
      reject(new Error(`[scanner] Selfbot login failed: ${err.message}`));
    });
  });
}

module.exports = { startScan };
