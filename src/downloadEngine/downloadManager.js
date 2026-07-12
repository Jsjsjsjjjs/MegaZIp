const fs = require('fs');
const path = require('path');
const { File } = require('megajs');
const yauzl = require('yauzl');
const { retryWithBackoff } = require('../utils/retry');
const { markLinkProcessed } = require('./scanState');

let sharedConfig = null;
let paused = false;
let cancelled = false;
const queue = [];
let activeCount = 0;

/** Must be called once before enqueueDownload — sets shared config (concurrency, folders, etc). */
function init(config) {
  sharedConfig = config;
  cancelled = false;
}

function pause() {
  paused = true;
  console.log('[downloadEngine] Downloads paused.');
}

function resume() {
  if (!paused) return;
  paused = false;
  console.log('[downloadEngine] Downloads resumed.');
  drainQueue();
}

function cancelAll() {
  cancelled = true;
  const dropped = queue.length;
  queue.length = 0;
  console.log(`[downloadEngine] Cancelled — cleared ${dropped} queued job(s). In-flight downloads will still finish.`);
}

/**
 * Adds a download job to the queue. `onComplete(err, downloadedFilePath)` is
 * called once the job finishes (successfully or not, after retries).
 */
function enqueueDownload(job, onComplete) {
  queue.push({ job, onComplete });
  drainQueue();
}

async function drainQueue() {
  if (paused || cancelled || !sharedConfig) return;
  const maxConcurrent = sharedConfig.downloadEngine?.concurrentDownloads || 2;

  while (activeCount < maxConcurrent && queue.length > 0 && !paused && !cancelled) {
    const item = queue.shift();
    activeCount += 1;

    processDownloadJob(item.job)
      .then((result) => item.onComplete(null, result))
      .catch((err) => item.onComplete(err, null))
      .finally(() => {
        activeCount -= 1;
        drainQueue();
      });
  }
}

function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Downloads a single MEGA-linked file to `destPath`, logging progress
 * roughly every 10%.
 */
async function downloadMegaFile(link, destPath, { timeoutMs } = {}) {
  let file;
  try {
    file = File.fromURL(link);
  } catch (err) {
    throw new Error(`Invalid MEGA link: ${err.message}`);
  }

  const loadedFile = await withTimeout(
    file.loadAttributes(),
    timeoutMs,
    'Timed out loading MEGA file info'
  );
  const target = loadedFile || file;

  if (target.directory || target.children) {
    throw new Error('Link points to a MEGA folder, not a single file — folder links are not supported.');
  }

  const totalSize = target.size || 0;
  let downloaded = 0;
  let lastLoggedPercent = -1;

  await withTimeout(
    new Promise((resolve, reject) => {
      const readStream = target.download();
      const writeStream = fs.createWriteStream(destPath);

      readStream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = Math.floor((downloaded / totalSize) * 100);
          if (percent >= lastLoggedPercent + 10) {
            lastLoggedPercent = percent;
            console.log(`[downloadEngine] Downloading "${target.name || link}": ${percent}%`);
          }
        }
      });

      readStream.on('error', (err) => {
        writeStream.destroy();
        reject(err);
      });
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      readStream.pipe(writeStream);
    }),
    timeoutMs,
    'Download timed out'
  );

  return { name: target.name, size: totalSize };
}

/** Confirms the file exists, is non-empty, and has an intact zip central directory. */
function validateZip(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return reject(new Error('Downloaded file is missing or zero bytes.'));
    }

    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Not a valid zip file: ${err.message}`));
      zipfile.close();
      resolve(true);
    });
  });
}

async function processDownloadJob(job) {
  const dlConfig = sharedConfig.downloadEngine || {};
  // Use /tmp/downloads as fallback if the configured path is not writable
  let downloadFolder = path.resolve(dlConfig.downloadFolder || './downloads');
  try {
    fs.mkdirSync(downloadFolder, { recursive: true });
    fs.accessSync(downloadFolder, fs.constants.W_OK);
  } catch {
    downloadFolder = path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'downloads');
    fs.mkdirSync(downloadFolder, { recursive: true });
  }

  const tempPath = path.join(downloadFolder, `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);

  console.log(`[downloadEngine] Download started: ${job.link}`);

  try {
    await retryWithBackoff(
      async () => {
        await downloadMegaFile(job.link, tempPath, { timeoutMs: dlConfig.timeoutMs || 120000 });
        await validateZip(tempPath);
      },
      {
        retries: dlConfig.retryCount ?? 3,
        delaysMs: [3000, 8000, 15000],
        onAttemptFail: (attempt, err) => {
          console.warn(`[downloadEngine] Attempt ${attempt} failed for ${job.link}: ${err.message}`);
          if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        },
      }
    );
  } catch (err) {
    console.error(`[downloadEngine] Giving up on ${job.link} after retries: ${err.message}`);
    markLinkProcessed(job.link, { status: 'failed', error: err.message });
    throw err;
  }

  markLinkProcessed(job.link, { status: 'downloaded', path: tempPath });
  console.log(`[downloadEngine] Download + validation complete: ${tempPath}`);
  return tempPath;
}

module.exports = { init, enqueueDownload, pause, resume, cancelAll, downloadMegaFile };
