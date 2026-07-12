const { getClient } = require('../discordClient');
const { retryWithBackoff } = require('../utils/retry');
const { getChannelScanState, updateChannelScanState } = require('./scanState');

async function fetchMessagesBatch(channel, { before, after, limit = 100 } = {}) {
  const options = { limit };
  if (before) options.before = before;
  if (after) options.after = after;

  return retryWithBackoff(() => channel.messages.fetch(options), {
    retries: 3,
    delaysMs: [3000, 8000, 15000],
    onAttemptFail: (attempt, err) => {
      console.warn(`[downloadEngine] Message fetch attempt ${attempt} failed for #${channel.id}: ${err.message}`);
    },
  });
}

/**
 * Scans a single channel: first backfills full history it hasn't seen yet
 * (walking backwards with `before`, resuming from where a previous run left
 * off), then polls forward with `after` to pick up messages posted since.
 * Discord always returns messages newest-first regardless of before/after,
 * so the forward-polling batch is reversed before processing.
 *
 * @param {string} channelId
 * @param {object} config
 * @param {{ onMessage: (message: import('discord.js').Message) => Promise<void> }} handlers
 */
async function scanChannel(channelId, config, { onMessage }) {
  const client = await getClient(config);
  const channel = await client.channels.fetch(channelId);

  if (!channel || typeof channel.messages?.fetch !== 'function') {
    throw new Error(`Channel ${channelId} could not be fetched or is not a text channel.`);
  }

  let state = getChannelScanState(channelId);

  // --- Backfill: walk backwards through history we haven't scanned yet ---
  if (!state.backfillComplete) {
    let cursor = state.oldestScannedMessageId || undefined;
    let sawAnyMessage = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await fetchMessagesBatch(channel, { before: cursor, limit: 100 });
      if (!batch || batch.size === 0) {
        updateChannelScanState(channelId, { backfillComplete: true });
        break;
      }

      const messages = Array.from(batch.values()); // newest-first
      for (const message of messages) {
        await onMessage(message);
      }

      if (!sawAnyMessage) {
        // Record the newest message of the very first batch as the anchor
        // for forward-polling later, so we don't rescan what we just backfilled.
        updateChannelScanState(channelId, { newestProcessedMessageId: messages[0].id });
        sawAnyMessage = true;
      }

      const oldest = messages[messages.length - 1];
      cursor = oldest.id;
      updateChannelScanState(channelId, { oldestScannedMessageId: cursor });
    }

    state = getChannelScanState(channelId);
  }

  // --- Forward-poll: pick up anything posted since our last check ---
  let afterCursor = state.newestProcessedMessageId || undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await fetchMessagesBatch(channel, { after: afterCursor, limit: 100 });
    if (!batch || batch.size === 0) break;

    // newest-first from the API; reverse so we process oldest-to-newest
    const messages = Array.from(batch.values()).reverse();
    for (const message of messages) {
      await onMessage(message);
    }

    afterCursor = messages[messages.length - 1].id;
    updateChannelScanState(channelId, { newestProcessedMessageId: afterCursor });
  }
}

module.exports = { scanChannel };
