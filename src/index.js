'use strict';

/**
 * src/index.js — Main orchestrator
 *
 * Pipeline: raw zip → decrypt → re-encrypt → upload to MEGA → Discord channel + message
 *
 * Entry points:
 *   1. Folder watcher (watched-folder/*.zip)
 *   2. GUI drag-and-drop upload
 *   3. GUI MEGA link ingest form
 *   4. TXT file drop (one channel per link)
 *   5. Mirror engine (external server scanner — standalone, self-contained)
 *   6. Download engine (configured source channels)
 *
 * Hosting: All secrets come from environment variables (see .env.example).
 *          State/temp files are written to /tmp on read-only filesystems.
 */

// ── Node.js < 20 compatibility ──────────────────────────────────────────────
// discord.js-selfbot-v13 bundles undici which needs the `File` Web API global.
// It became stable in Node 20. Polyfill it before any require() runs.
if (typeof File === 'undefined') {
  const bufFile = (() => { try { return require('buffer').File; } catch { return null; } })();
  if (bufFile) {
    global.File = bufFile;
  } else {
    global.File = class File extends (require('buffer').Blob || class Blob {}) {
      constructor(parts, name, opts) { super(parts, opts); this.name = name || ''; }
    };
  }
}

const path = require('path');
const fs   = require('fs');

// ── .env support (local dev) ─────────────────────────────────────────────────
// On Railway/hosting, set variables via the dashboard; .env is for local use.
const envFilePath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFilePath)) {
  for (const line of fs.readFileSync(envFilePath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*["']?(.*?)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; // don't overwrite real env vars
  }
}

const { watchFolder }    = require('./folderWatcher');
const { encryptZip }     = require('./zipEncryptor');
const { uploadToMega }   = require('./megaUploader');
const { createZipChannel } = require('./discordManager');
const { sendZipMessage } = require('./webhookSender');
const { getClient }      = require('./discordClient');
const { registerCommands, attachCommandHandler } = require('./commandHandler');
const { updateState, getState, getAllStates, appendLog, removeState } = require('./stateStore');
const { startGuiServer } = require('./gui/server');
const { startDownloadEngine, pauseDownloads, resumeDownloads, cancelDownloads } = require('./downloadEngine');
const downloadManager    = require('./downloadEngine/downloadManager');
const { startMirrorEngine, stopMirrorEngine } = require('./mirrorEngine');
const { parseTxtFile }   = require('./txtLinkIngester');
const { retryWithBackoff } = require('./utils/retry');

// ── Config ─────────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'config', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {
  console.log('[index] config/config.json not found — using defaults (env vars will override).');
  config = {
    watchFolder: './watched-folder',
    channelNameTemplate: '{name}',
    channelNameBoldStyle: false,
    messageTemplate: '**{name}**\n🔗 Link: {link}\n🔑 Password: {password}',
    zipPasswordMode: 'auto-random',
    zipInputPassword: '',
    uploadDelaySeconds: 8,
    processingConcurrency: 2,
    deleteEncryptedAfterUpload: true,
    guiPort: 3737,
    advancedTemplate: { useEmbed: false },
    downloadEngine: { enabled: false, downloadFolder: './downloads', concurrentDownloads: 2, retryCount: 3, timeoutMs: 180000 },
    mirrorEngine: { enabled: false, concurrency: 2, channelTimeoutMs: 30000, downloadTimeoutMs: 300000 },
  };
}

// Apply environment variable overrides.
// Environment variables always win over config.json values.
const envMap = {
  DISCORD_TOKEN:     'discordToken',
  DISCORD_CLIENT_ID: 'discordClientId',
  BOT_OWNER_ID:      'botOwnerId',
  GUILD_ID:          'guildId',
  CATEGORY_ID:       'categoryId',
  PERMISSION_ROLE_ID:'permissionRoleId',
  MEGA_EMAIL:        'megaEmail',
  MEGA_PASSWORD:     'megaPassword',
  GUI_PORT:          'guiPort',
};
for (const [envKey, cfgKey] of Object.entries(envMap)) {
  if (process.env[envKey] !== undefined) config[cfgKey] = process.env[envKey];
}

// Railway injects PORT; use it as the GUI port so the service gets traffic
if (process.env.PORT) config.guiPort = parseInt(process.env.PORT, 10) || config.guiPort;

// Mirror engine env var overrides
if (!config.mirrorEngine) config.mirrorEngine = {};
if (process.env.MIRROR_ENABLED !== undefined)
  config.mirrorEngine.enabled = process.env.MIRROR_ENABLED === 'true';
if (process.env.MIRROR_USER_TOKEN)
  config.mirrorEngine.userToken = process.env.MIRROR_USER_TOKEN;
if (process.env.MIRROR_SOURCE_PASSWORD)
  config.mirrorEngine.sourcePassword = process.env.MIRROR_SOURCE_PASSWORD;
if (process.env.MIRROR_SOURCE_GUILD_IDS)
  config.mirrorEngine.sourceGuildIds = process.env.MIRROR_SOURCE_GUILD_IDS.split(',').map(s => s.trim()).filter(Boolean);
if (process.env.MIRROR_CONCURRENCY)
  config.mirrorEngine.concurrency = parseInt(process.env.MIRROR_CONCURRENCY, 10) || 2;
if (process.env.ZIP_INPUT_PASSWORD)
  config.zipInputPassword = process.env.ZIP_INPUT_PASSWORD;
if (process.env.ZIP_PASSWORD_MODE)
  config.zipPasswordMode = process.env.ZIP_PASSWORD_MODE;

// ── Folder paths ──────────────────────────────────────────────────────────────
// Railway's /app is read-only after deploy. Detect this and use /tmp instead.
function resolveWritableDir(...segments) {
  const preferred = path.resolve(...segments);
  // Test if parent is writable
  try { fs.accessSync(path.parse(preferred).root === preferred ? preferred : path.dirname(preferred), fs.constants.W_OK); return preferred; }
  catch { /* read-only */ }
  // Fall back: replace the /app prefix with /tmp
  const relative = path.relative(path.join(__dirname, '..'), preferred);
  return path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', relative);
}

const watchFolderPath    = resolveWritableDir(__dirname, '..', config.watchFolder   || './watched-folder');
const stagingFolderPath  = path.join(watchFolderPath, 'staging');
const downloadFolderPath = resolveWritableDir(__dirname, '..', config.downloadEngine?.downloadFolder || './downloads');

console.log(`[index] Watch folder: ${watchFolderPath}`);
console.log(`[index] Download folder: ${downloadFolderPath}`);

for (const dir of [watchFolderPath, stagingFolderPath, downloadFolderPath]) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.warn(`[index] Could not create dir ${dir}: ${e.message}`); }
}

// ── Concurrent queue ──────────────────────────────────────────────────────────
const MAX_CONCURRENT = Math.max(1, parseInt(config.processingConcurrency || 2));
let activeCount = 0;
const queue       = [];
const queuedFiles = new Set();

function enqueue(filename, rawZipPath, meta = {}) {
  if (queuedFiles.has(filename)) return;
  queuedFiles.add(filename);
  queue.push({ filename, rawZipPath, meta });
  drainQueue();
}

function drainQueue() {
  while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
    const { filename, rawZipPath, meta } = queue.shift();
    activeCount++;

    processZip(filename, rawZipPath, meta)
      .catch((err) => {
        console.error(`[index] Unexpected error processing "${filename}": ${err.message}`);
        updateState(filename, { status: 'failed', error: err.message });
      })
      .finally(() => {
        queuedFiles.delete(filename);
        activeCount--;
        drainQueue();
      });
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
async function processZip(filename, rawZipPath, meta = {}) {
  const baseName = path.basename(filename, path.extname(filename));
  let state = getState(filename) || {};

  // Size-based deduplication
  if (state.status === 'message_sent') {
    const currentSize = rawZipPath && fs.existsSync(rawZipPath) ? fs.statSync(rawZipPath).size : null;
    const savedSize   = state.fileSize || null;
    if (currentSize !== null && savedSize !== null && currentSize !== savedSize) {
      console.log(`[index] "${filename}" size changed — re-processing.`);
      removeState(filename);
      state = {};
    } else {
      console.log(`[index] Skipping "${filename}" — already processed.`);
      if (rawZipPath) safeDelete(rawZipPath);
      return;
    }
  }

  console.log(`[index] Processing "${filename}" (status: ${state.status || 'new'})`);

  // ── Step 1: Encrypt ──────────────────────────────────────────────────────
  let encryptedPath = state.encryptedPath;
  let password      = state.zipPassword;
  const alreadyEncrypted = encryptedPath && fs.existsSync(encryptedPath);

  if (!alreadyEncrypted) {
    if (!rawZipPath || !fs.existsSync(rawZipPath)) {
      console.error(`[index] Cannot process "${filename}" — source file missing.`);
      updateState(filename, { status: 'failed', error: 'Source file missing.' });
      return;
    }

    const fileSize = fs.statSync(rawZipPath).size;
    updateState(filename, { status: 'encrypting', error: null, fileSize });

    try {
      const outputPassword = config.zipPasswordMode === 'auto-random' ? null : config.zipInputPassword;
      const inputPassword  = state.sourcePassword || config.zipInputPassword || null;
      const result         = await encryptZip(rawZipPath, outputPassword, inputPassword);
      encryptedPath = result.encryptedPath;
      password      = result.password;
      updateState(filename, { status: 'uploading', zipPassword: password, encryptedPath, error: null });
      safeDelete(rawZipPath);
    } catch (err) {
      // Retry without source password if it was wrong
      if (state.sourcePassword && /Wrong password/i.test(err.message)) {
        console.warn(`[index] sourcePassword failed for "${filename}", retrying without it...`);
        try {
          const outputPassword = config.zipPasswordMode === 'auto-random' ? null : config.zipInputPassword;
          const result         = await encryptZip(rawZipPath, outputPassword, config.zipInputPassword || null);
          encryptedPath = result.encryptedPath;
          password      = result.password;
          updateState(filename, { status: 'uploading', zipPassword: password, encryptedPath, error: null });
          safeDelete(rawZipPath);
        } catch (err2) {
          console.error(`[index] Encryption failed for "${filename}": ${err2.message}`);
          updateState(filename, { status: 'failed', error: `Encryption: ${err2.message}` });
          safeDelete(rawZipPath);
          return;
        }
      } else {
        console.error(`[index] Encryption failed for "${filename}": ${err.message}`);
        updateState(filename, { status: 'failed', error: `Encryption: ${err.message}` });
        safeDelete(rawZipPath);
        return;
      }
    }
  }

  // ── Step 2: Upload to MEGA ───────────────────────────────────────────────
  let megaLink = state.megaLink;

  if (!megaLink) {
    try {
      megaLink = await retryWithBackoff(
        () => uploadToMega(encryptedPath, config),
        {
          retries: 3,
          delaysMs: [2000, 5000, 10000],
          onAttemptFail: (attempt, err) =>
            console.warn(`[index] MEGA upload attempt ${attempt} failed for "${filename}": ${err.message}`),
        }
      );
      updateState(filename, { status: 'uploaded', megaLink, error: null });
      console.log(`[index] Uploaded "${filename}" → ${megaLink}`);
      // Delete the entire temp encrypted dir (created by mkdtempSync in zipEncryptor)
      try { fs.rmSync(path.dirname(encryptedPath), { recursive: true, force: true }); } catch {}
    } catch (err) {
      console.error(`[index] MEGA upload failed for "${filename}": ${err.message}`);
      updateState(filename, { status: 'failed', error: `MEGA upload: ${err.message}` });
      safeDelete(encryptedPath);
      return;
    }
  }

  // ── Step 3: Discord channel ──────────────────────────────────────────────
  let channel = null;

  if (state.channelId) {
    try {
      const client = await getClient(config);
      channel = await client.channels.fetch(state.channelId);
    } catch { channel = null; }
  }

  if (!channel) {
    try {
      const channelOptions = {
        sourceCategoryName: state.sourceCategoryName || meta.sourceCategoryName || null,
      };
      channel = await retryWithBackoff(
        () => createZipChannel(baseName, config, channelOptions),
        {
          retries: 3,
          delaysMs: [2000, 5000, 10000],
          onAttemptFail: (attempt, err) =>
            console.warn(`[index] Channel creation attempt ${attempt} failed for "${filename}": ${err.message}`),
        }
      );
      updateState(filename, { status: 'channel_created', channelId: channel.id, error: null });
    } catch (err) {
      console.error(`[index] Channel creation failed for "${filename}": ${err.message}`);
      updateState(filename, { status: 'failed', error: `Channel: ${err.message}` });
      return;
    }
  }

  // ── Step 4: Send or Edit message ─────────────────────────────────────────
  try {
    let messageId = state.messageId;
    if (messageId) {
      await retryWithBackoff(
        () => require('./webhookSender').editZipMessage(channel, messageId, { name: baseName, link: megaLink, password }, config),
        {
          retries: 3,
          delaysMs: [2000, 5000, 10000],
          onAttemptFail: (attempt, err) =>
            console.warn(`[index] Message edit attempt ${attempt} failed for "${filename}": ${err.message}`),
        }
      );
      console.log(`[index] Edited existing message: ${messageId}`);
    } else {
      const sentMessage = await retryWithBackoff(
        () => sendZipMessage(channel, { name: baseName, link: megaLink, password }, config),
        {
          retries: 3,
          delaysMs: [2000, 5000, 10000],
          onAttemptFail: (attempt, err) =>
            console.warn(`[index] Message send attempt ${attempt} failed for "${filename}": ${err.message}`),
        }
      );
      messageId = sentMessage?.id || null;
    }

    updateState(filename, { status: 'message_sent', messageId, error: null });

    appendLog({ filename, megaLink, zipPassword: password, channelId: channel.id, channelName: channel.name, messageId });
    console.log(`[index] ✅ Done: "${filename}"`);
  } catch (err) {
    console.error(`[index] Message failed for "${filename}": ${err.message}`);
    updateState(filename, { status: 'failed', error: `Message: ${err.message}` });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeDelete(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function retryFile(filename) {
  const state = getState(filename);
  if (state) updateState(filename, { status: 'pending', error: null });

  if (state?.encryptedPath && fs.existsSync(state.encryptedPath)) {
    enqueue(filename, null);
    return;
  }

  for (const folder of [watchFolderPath, stagingFolderPath]) {
    const zipPath = path.join(folder, filename);
    if (fs.existsSync(zipPath)) { enqueue(filename, zipPath); return; }
  }

  console.error(`[index] Cannot retry "${filename}" — source file missing.`);
  updateState(filename, { status: 'failed', error: 'Source file missing, cannot retry.' });
}

// ── Ingest entry points ───────────────────────────────────────────────────────
function ingestDownloadedFile(downloadedPath, suggestedFilename, sourcePassword, meta = {}) {
  try {
    const baseName = path.basename(suggestedFilename, path.extname(suggestedFilename)) || 'recovered-file';

    let finalFilename = `${baseName}.zip`;
    let counter = 2;
    while (getState(finalFilename)?.status === 'message_sent') {
      finalFilename = `${baseName}-${counter}.zip`;
      counter++;
    }

    const stagedPath = path.join(stagingFolderPath, finalFilename);
    fs.copyFileSync(downloadedPath, stagedPath);
    safeDelete(downloadedPath);

    updateState(finalFilename, {
      status: 'new', megaLink: null, zipPassword: null, encryptedPath: null,
      sourcePassword: sourcePassword || null,
      sourceCategoryName: meta.sourceCategoryName || null,
      error: null,
    });

    console.log(`[index] Staged "${finalFilename}" → pipeline.`);
    enqueue(finalFilename, stagedPath, meta);
  } catch (err) {
    console.error(`[index] Failed to ingest "${downloadedPath}": ${err.message}`);
    safeDelete(downloadedPath);
  }
}

async function downloadAndIngest(name, link, password, meta = {}) {
  try { if (!fs.existsSync(downloadFolderPath)) fs.mkdirSync(downloadFolderPath, { recursive: true }); } catch {}

  const safeName = (name || 'link').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);
  const tempPath = path.join(downloadFolderPath, `${Date.now()}-${safeName}.zip`);

  console.log(`[index] Downloading "${name}" from MEGA: ${link}`);
  try {
    const result = await downloadManager.downloadMegaFile(link, tempPath, {
      timeoutMs: config.downloadEngine?.timeoutMs || 180000,
    });
    const remoteName = result?.name || null;
    const finalName  = remoteName || safeName;
    console.log(`[index] Downloaded "${finalName}" — feeding into pipeline.`);
    ingestDownloadedFile(tempPath, `${path.basename(finalName, path.extname(finalName))}.zip`, password, meta);
  } catch (err) {
    console.error(`[index] Download failed for "${name}" (${link}): ${err.message}`);
    safeDelete(tempPath);
  }
}

function ingestUploadedZip(zipPath, password) {
  const filename = path.basename(zipPath);
  const state    = getState(filename);

  if (state?.status === 'message_sent') {
    const currentSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : null;
    if (currentSize !== null && state.fileSize && currentSize === state.fileSize) {
      console.log(`[index] Skipping GUI upload "${filename}" — already processed.`);
      safeDelete(zipPath);
      return;
    }
    removeState(filename);
  }

  updateState(filename, {
    status: 'new',
    sourcePassword: password || config.zipInputPassword || null,
    error: null,
  });
  enqueue(filename, zipPath);
}

// ── TXT handler ───────────────────────────────────────────────────────────────
function handleTxtFile(txtPath) {
  const defaultName = path.basename(txtPath, '.txt');
  try {
    const jobs = parseTxtFile(txtPath, defaultName);
    if (jobs.length === 0) {
      console.log(`[index] No MEGA links found in "${path.basename(txtPath)}".`);
      return;
    }
    console.log(`[index] Found ${jobs.length} link(s) in "${path.basename(txtPath)}" — queuing.`);
    for (const job of jobs) {
      downloadAndIngest(job.name, job.link, job.password).catch((err) =>
        console.error(`[index] Error ingesting "${job.name}": ${err.message}`)
      );
    }
  } catch (err) {
    console.error(`[index] Failed to parse "${path.basename(txtPath)}": ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[index] mega-discord-bot starting...');
  console.log(`[index] Watch folder: ${watchFolderPath}`);
  console.log(`[index] Pipeline concurrency: ${MAX_CONCURRENT}`);
  console.log(`[index] Node.js: ${process.version}`);

  const client = await getClient(config);
  console.log(`[index] Discord bot logged in as ${client.user.tag}`);

  // Automatically fall back to client.user.id if client ID is missing or set to placeholder
  if (!config.discordClientId || config.discordClientId === 'SET_VIA_RAILWAY_ENV') {
    config.discordClientId = client.user.id;
  }
  // Automatically fall back to botOwnerId if missing
  if (!config.botOwnerId || config.botOwnerId === 'SET_VIA_RAILWAY_ENV') {
    // If not set, use client application owner or default to bot client ID
    config.botOwnerId = client.application?.owner?.id || null;
    console.log(`[index] Bot owner ID resolved to: ${config.botOwnerId}`);
  }

  if (config.discordClientId) {
    try {
      await registerCommands(config);
      attachCommandHandler(client, config, {
        startMirrorEngine,
        stopMirrorEngine,
        getMirrorEngineStatus,
        pauseDownloads,
        resumeDownloads,
        cancelDownloads
      });
      console.log('[index] Slash commands registered.');
    } catch (err) {
      console.warn(`[index] Slash commands unavailable: ${err.message}`);
    }
  }

  startGuiServer(config, {
    onRetry:          retryFile,
    onDownloadPause:  pauseDownloads,
    onDownloadResume: resumeDownloads,
    onDownloadCancel: cancelDownloads,
    onIngestLink:     downloadAndIngest,
    onIngestZip:      ingestUploadedZip,
    onIngestTxt:      handleTxtFile,
    watchFolderPath,
  });

  watchFolder(
    watchFolderPath,
    (zipPath) => {
      const filename = path.basename(zipPath);
      const state    = getState(filename);
      if (state?.status === 'message_sent') {
        const currentSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : null;
        if (currentSize !== null && state.fileSize && currentSize === state.fileSize) {
          console.log(`[index] Skipping "${filename}" — already processed.`);
          return;
        }
      }
      enqueue(filename, zipPath);
    },
    (txtPath) => handleTxtFile(txtPath)
  );

  // Init download manager once — shared by download engine, TXT ingester, and mirror engine
  downloadManager.init(config);

  startDownloadEngine(config, ingestDownloadedFile);

  // Mirror engine is fully standalone — only start if enabled
  startMirrorEngine(config);
}

main().catch((err) => {
  console.error('[index] Fatal startup error:', err.message, err.stack);
  process.exit(1);
});

process.on('SIGINT',  () => { stopMirrorEngine(); process.exit(0); });
process.on('SIGTERM', () => { stopMirrorEngine(); process.exit(0); });

// Prevent unhandled promise rejections from crashing the process on hosting
process.on('unhandledRejection', (reason) => {
  console.error('[index] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

async function startRegeneration(channelId) {
  const allStates = getAllStates() || {};
  const entry = Object.entries(allStates).find(([_, st]) => st.channelId === channelId);
  if (!entry) throw new Error('No tracked file found for this channel ID.');
  const [filename, state] = entry;
  const oldLink = state.megaLink;
  if (!oldLink) throw new Error('No existing MEGA link found in state to regenerate from.');

  // Validate immediately — throw before Discord times out
  console.log(`[index] Queuing background regeneration for channel ${channelId} (${filename})`);

  // Run the slow download + enqueue in the background
  setImmediate(async () => {
    try {
      const dlFolder = downloadFolderPath;
      if (!fs.existsSync(dlFolder)) fs.mkdirSync(dlFolder, { recursive: true });
      const tempPath = path.join(dlFolder, `${Date.now()}-regen-${filename}`);

      await downloadManager.downloadMegaFile(oldLink, tempPath, { timeoutMs: 300_000 });

      const stagedPath = path.join(stagingFolderPath, filename);
      if (fs.existsSync(stagedPath)) { try { fs.unlinkSync(stagedPath); } catch {} }
      fs.copyFileSync(tempPath, stagedPath);
      try { fs.unlinkSync(tempPath); } catch {}

      updateState(filename, {
        status:         'new',
        megaLink:       null,
        encryptedPath:  null,
        sourcePassword: state.zipPassword || config.zipInputPassword || null,
        error:          null,
      });

      enqueue(filename, stagedPath);
      console.log(`[index] Background regeneration enqueued for "${filename}"`);
    } catch (err) {
      console.error(`[index] Background regeneration failed for "${filename}": ${err.message}`);
    }
  });

  return filename; // returned immediately so Discord gets a reply right away
}
