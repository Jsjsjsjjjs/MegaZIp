const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const dbPath = path.join(__dirname, '..', '..', 'download-scan-state.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

db.defaults({ channels: {}, processedLinks: {} }).write();

/**
 * NOTE: array paths (['channels', id]) are used instead of dot-strings for
 * the same reason as the main stateStore — link URLs and IDs can contain
 * characters that lodash's dot-path parser would misinterpret.
 */

function getChannelScanState(channelId) {
  return (
    db.get(['channels', channelId]).value() || {
      newestProcessedMessageId: null,
      oldestScannedMessageId: null,
      backfillComplete: false,
    }
  );
}

function updateChannelScanState(channelId, updates) {
  const existing = getChannelScanState(channelId);
  const merged = { ...existing, ...updates };
  db.set(['channels', channelId], merged).write();
  return merged;
}

function isLinkProcessed(link) {
  return Boolean(db.get(['processedLinks', link]).value());
}

function markLinkProcessed(link, info = {}) {
  db.set(['processedLinks', link], { ...info, processedAt: new Date().toISOString() }).write();
}

module.exports = {
  getChannelScanState,
  updateChannelScanState,
  isLinkProcessed,
  markLinkProcessed,
};
