const { scanChannel } = require('./messageScanner');
const { extractJobsFromMessage } = require('./linkExtractor');
const { isLinkProcessed } = require('./scanState');
const downloadManager = require('./downloadManager');

let scanTimer = null;
let scanning = false;

function sanitizeFilenamePart(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim();
}

/**
 * Starts the download engine. Scans every channel in
 * config.downloadEngine.sourceChannelIds for MEGA links, downloads +
 * validates each new one, then calls `onDownloaded(downloadedPath,
 * suggestedFilename, password)` so the caller can feed it into the existing
 * upload pipeline exactly like a freshly-dropped zip.
 *
 * Scoped entirely to config.downloadEngine.sourceGuildId /
 * sourceChannelIds — this is meant for archiving/migrating a server you
 * already own and manage, not for monitoring channels you don't control.
 *
 * @param {object} config
 * @param {(downloadedPath: string, suggestedFilename: string, password: string|null) => void} onDownloaded
 */
function startDownloadEngine(config, onDownloaded) {
  const dlConfig = config.downloadEngine;

  if (!dlConfig || !dlConfig.enabled) {
    console.log('[downloadEngine] Disabled in config (downloadEngine.enabled = false) — skipping.');
    return;
  }

  if (!dlConfig.sourceGuildId || !Array.isArray(dlConfig.sourceChannelIds) || dlConfig.sourceChannelIds.length === 0) {
    console.warn('[downloadEngine] No sourceGuildId/sourceChannelIds configured — nothing to scan.');
    return;
  }

  // Reset scan states so that the bot starts scanning channels from the beginning of history in every run
  const { resetScanState } = require('./scanState');
  resetScanState();

  downloadManager.init(config);

  const runScan = async () => {
    if (scanning) {
      console.log('[downloadEngine] Previous scan still running, skipping this interval.');
      return;
    }
    scanning = true;
    console.log(`[downloadEngine] Scan started (${dlConfig.sourceChannelIds.length} channel(s)).`);

    for (const channelId of dlConfig.sourceChannelIds) {
      try {
        await scanChannel(channelId, config, {
          onMessage: async (message) => {
            const jobs = extractJobsFromMessage(message);
            for (const job of jobs) {
              if (isLinkProcessed(job.link)) continue;

              console.log(`[downloadEngine] Link detected in #${job.sourceChannelId} (message ${job.sourceMessageId}): ${job.link}`);

              downloadManager.enqueueDownload(job, (err, downloadedPath) => {
                if (err) {
                  console.error(`[downloadEngine] Failed to download ${job.link}: ${err.message}`);
                  return;
                }
                if (!downloadedPath) return;

                const baseName = sanitizeFilenamePart(job.suggestedName || `recovered-${job.sourceMessageId}`);
                onDownloaded(downloadedPath, `${baseName}.zip`, job.password);
              });
            }
          },
        });
      } catch (err) {
        console.error(`[downloadEngine] Error scanning channel ${channelId}: ${err.message}`);
      }
    }

    console.log('[downloadEngine] Scan finished.');
    scanning = false;
  };

  runScan(); // scan immediately on startup, then on an interval

  const intervalMs = (dlConfig.scanIntervalMinutes || 30) * 60 * 1000;
  scanTimer = setInterval(runScan, intervalMs);
  console.log(`[downloadEngine] Started — rescanning every ${dlConfig.scanIntervalMinutes || 30} minute(s).`);
}

function stopDownloadEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  downloadManager.cancelAll();
}

module.exports = {
  startDownloadEngine,
  stopDownloadEngine,
  pauseDownloads: downloadManager.pause,
  resumeDownloads: downloadManager.resume,
  cancelDownloads: downloadManager.cancelAll,
};
