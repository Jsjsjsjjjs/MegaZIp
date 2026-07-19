'use strict';

/**
 * Mirror Engine — Fully Standalone MEGA Link Mirroring System
 * ===========================================================
 *
 * Completely isolated from the main watcher pipeline.
 * Has its own state file, its own temp directory, and its own
 * download → encrypt → upload → post flow.
 *
 * Behaviour:
 *  - On start: scans all source guilds/channels for MEGA links
 *  - Resumes from previous state (never re-processes 'done' links)
 *  - Resets 'downloading/encrypting/uploading' to 'pending' on restart
 *    (temp files are cleaned up, no leftover processes)
 *  - Clones exact category name from source to target server
 *  - Non-.zip files are wrapped directly into an AES-256 encrypted zip
 *  - .zip files are decrypted (with sourcePassword) and re-encrypted
 *  - Stops and disconnects selfbot when all work is done — no idle polling
 *
 * State file : mirror-state.json (project root)
 * Temp dir   : mirror-temp/       (cleaned per-link after processing)
 *
 * Config options (config.mirrorEngine):
 *   enabled           {boolean}   Must be true
 *   userToken         {string}    Discord self-bot user token
 *   sourcePassword    {string}    Single password to decrypt ALL source zips
 *   sourceGuildIds    {string[]}  Guilds to scan (empty = all guilds)
 *   excludeGuildIds   {string[]}  Guild IDs to skip
 *   excludeChannelIds {string[]}  Channel IDs to skip
 *   concurrency       {number}    Parallel download+upload workers (default 2)
 *   channelTimeoutMs  {number}    Per-channel scan timeout ms (default 10000)
 *   downloadTimeoutMs {number}    Per-file download timeout ms (default 300000)
 *
 * ⚠  Using a self-bot token violates Discord ToS. Use at your own risk.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const archiver  = require('archiver');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');

const { encryptZip, generatePassword } = require('../zipEncryptor');

const { uploadToMega }   = require('../megaUploader');
const { createZipChannel } = require('../discordManager');
const { sendZipMessage } = require('../webhookSender');
const downloadManager    = require('../downloadEngine/downloadManager');
const { extractMegaLinks, extractSuggestedName, flattenEmbed } = require('../downloadEngine/linkExtractor');
const { getClient }      = require('../discordClient');

try {
  archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
} catch (e) {
  if (!e.message.includes('already registered')) throw e;
  // Format already registered by zipEncryptor.js — skip silently
}

// ─── Paths ────────────────────────────────────────────────────────────────────
// Use /tmp for state and temp on read-only hosts (Railway). Fall back to project root locally.
function resolveWritablePath(preferred) {
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    const tmp = process.env.TMPDIR || process.env.TEMP || '/tmp';
    return path.join(tmp, path.basename(preferred));
  }
}

const STATE_PATH = resolveWritablePath(path.join(__dirname, '..', '..', 'mirror-state.json'));
const TEMP_DIR   = (() => {
  const preferred = path.join(__dirname, '..', '..', 'mirror-temp');
  try { fs.accessSync(path.dirname(preferred), fs.constants.W_OK); return preferred; }
  catch { return path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'mirror-temp'); }
})();

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeName(str, maxLen = 80) {
  return (str || 'file').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function safeDelete(p) {
  if (!p) return;
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// Normalise a MEGA URL so variant forms of the same link map to one key
function linkKey(url) {
  return url.replace(/\/$/, '').toLowerCase().trim();
}

// ─── State ────────────────────────────────────────────────────────────────────
// Status flow:
//   pending → downloading → encrypting → uploading → channel_created → done
//   any step can also transition to: failed

let _state = {}; // { [linkKey]: LinkEntry }

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      _state = raw.links || {};
    }
  } catch {
    _state = {};
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({ version: 3, savedAt: new Date().toISOString(), links: _state }, null, 2)
    );
  } catch (e) {
    console.error('[mirrorEngine] Could not save state:', e.message);
  }
}

function getEntry(url)         { return _state[linkKey(url)] || null; }
function setEntry(url, patch)  {
  const k = linkKey(url);
  _state[k] = { ..._state[k], ...patch, lastUpdated: new Date().toISOString() };
  saveState();
}

// ─── Encrypt a non-zip file directly into an AES-256 zip ─────────────────────
async function encryptFileAsZip(rawFilePath, outputZipPath, password) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outputZipPath);
    const arc = archiver.create('zip-encrypted', {
      zlib: { level: 8 },
      encryptionMethod: 'aes256',
      password,
    });
    out.on('close', resolve);
    arc.on('error', reject);
    out.on('error', reject);
    arc.pipe(out);
    arc.file(rawFilePath, { name: path.basename(rawFilePath) });
    arc.finalize();
  });
}

// ─── Per-link pipeline ────────────────────────────────────────────────────────
async function processLink(entry, config) {
  const { link, name, categoryName } = entry;
  const mc = config.mirrorEngine;
  const sourcePassword = mc.sourcePassword || null;
  const outputPassword = generatePassword(12);

  // Per-link temp directory — completely isolated
  const tmpDir = path.join(TEMP_DIR, crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });

  try {

    // ── 1. Download ────────────────────────────────────────────────────────
    setEntry(link, { status: 'downloading', error: null });

    const dlPath = path.join(tmpDir, 'download.bin');
    let remoteName = null;

    try {
      const result = await downloadManager.downloadMegaFile(link, dlPath, {
        timeoutMs: mc.downloadTimeoutMs || 300_000,
      });
      remoteName = result?.name || null;
    } catch (err) {
      throw new Error(`Download: ${err.message}`);
    }

    // Determine final display name: remote filename > message-text name > channel name
    const baseName = remoteName
      ? path.basename(remoteName, path.extname(remoteName))
      : safeName(name);

    const remoteExt = remoteName ? path.extname(remoteName).toLowerCase() : '';
    const isZip     = remoteExt === '.zip';

    // Rename download.bin to its real extension so 7zip can detect format
    const renamedPath = path.join(tmpDir, remoteName || `${baseName}${remoteExt || '.bin'}`);
    fs.renameSync(dlPath, renamedPath);

    // ── 2. Encrypt ─────────────────────────────────────────────────────────
    setEntry(link, { status: 'encrypting' });

    let encryptedZipPath;

    if (isZip) {
      // Re-encrypt: decrypt with sourcePassword (ignored if zip is not encrypted), pack with new password
      try {
        const result = await encryptZip(renamedPath, outputPassword, sourcePassword);
        encryptedZipPath = result.encryptedPath;
        safeDelete(renamedPath);
      } catch (err) {
        if (sourcePassword && /wrong password/i.test(err.message)) {
          // Try without password (zip may not actually be encrypted)
          const result = await encryptZip(renamedPath, outputPassword, null);
          encryptedZipPath = result.encryptedPath;
          safeDelete(renamedPath);
        } else {
          throw new Error(`Encrypt: ${err.message}`);
        }
      }
    } else {
      // Non-zip: wrap file directly into an AES-256 encrypted zip
      encryptedZipPath = path.join(tmpDir, `${baseName}.zip`);
      try {
        await encryptFileAsZip(renamedPath, encryptedZipPath, outputPassword);
        safeDelete(renamedPath);
      } catch (err) {
        throw new Error(`Wrap+encrypt: ${err.message}`);
      }
    }

    // ── 3. Upload to MEGA ──────────────────────────────────────────────────
    setEntry(link, { status: 'uploading' });
    console.log(`[mirrorEngine] ↑ ${baseName}`);

    let megaLink;
    try {
      megaLink = await uploadToMega(encryptedZipPath, config);
      safeDelete(encryptedZipPath);
    } catch (err) {
      throw new Error(`Upload: ${err.message}`);
    }

    // ── 4. Create Discord channel (with cloned category) ──────────────────
    const existingEntry = getEntry(link);
    let channel = null;

    if (existingEntry?.channelId) {
      try {
        const botClient = await getClient(config);
        channel = await botClient.channels.fetch(existingEntry.channelId);
      } catch { channel = null; }
    }

    if (!channel) {
      setEntry(link, { status: 'channel_creating' });
      try {
        channel = await createZipChannel(baseName, config, { sourceCategoryName: categoryName });
        setEntry(link, { status: 'channel_created', channelId: channel.id });
      } catch (err) {
        throw new Error(`Channel: ${err.message}`);
      }
    }

    // ── 5. Send message ────────────────────────────────────────────────────
    try {
      const sent = await sendZipMessage(
        channel,
        { name: baseName, link: megaLink, password: outputPassword },
        config
      );
      setEntry(link, {
        status:    'done',
        megaLink,
        password:  outputPassword,
        channelId: channel.id,
        messageId: sent?.id || null,
        error:     null,
      });
      console.log(`[mirrorEngine] ✓ ${baseName}`);
    } catch (err) {
      throw new Error(`Post: ${err.message}`);
    }

  } catch (err) {
    console.error(`[mirrorEngine] ✗ ${name}: ${err.message}`);
    setEntry(link, { status: 'failed', error: err.message });
  } finally {
    safeDelete(tmpDir);
  }
}

// ─── Scan a single channel for all MEGA links ─────────────────────────────────
async function scanChannel(channel, timeoutMs) {
  const categoryName = channel.parent?.name || null;
  const channelName  = channel.name;
  const results      = [];
  let lastId;
  const MAX_MESSAGES = 500; // don't dig deeper than 500 msgs per channel
  let fetched = 0;

  // Wrap the ENTIRE channel scan in one deadline
  const deadline = Date.now() + timeoutMs;

  while (fetched < MAX_MESSAGES) {
    if (Date.now() >= deadline) break; // total channel timeout hit

    let batch;
    try {
      const remaining = deadline - Date.now();
      batch = await Promise.race([
        channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(remaining, 1000))),
      ]);
    } catch {
      break; // permission denied, timeout, or rate limit — move on
    }

    if (!batch || batch.size === 0) break;

    const msgs = [...batch.values()];
    fetched += msgs.length;

    for (const msg of msgs) {
      const text = msg.content || '';
      for (const link of extractMegaLinks(text)) {
        const msgName = extractSuggestedName(text) || channelName;
        results.push({ link, name: msgName, categoryName });
      }

      if (Array.isArray(msg.embeds)) {
        for (const embed of msg.embeds) {
          const embedText = flattenEmbed(embed);
          for (const link of extractMegaLinks(embedText)) {
            const embedName = extractSuggestedName(embedText) || embed.title || channelName;
            results.push({ link, name: embedName, categoryName });
          }
        }
      }
    }

    lastId = msgs[msgs.length - 1].id;
  }

  return results;
}

// ─── Scan all guilds for MEGA links ──────────────────────────────────────────
async function scanAllGuilds(config, selfbot) {
  const mc          = config.mirrorEngine;
  const srcGuildIds = Array.isArray(mc.sourceGuildIds)    ? mc.sourceGuildIds    : [];
  const excGuilds   = new Set(Array.isArray(mc.excludeGuildIds)   ? mc.excludeGuildIds   : []);
  const excChannels = new Set(Array.isArray(mc.excludeChannelIds) ? mc.excludeChannelIds : []);
  const chTimeout   = mc.channelTimeoutMs || 30_000;
  const BATCH       = 6;

  let guilds = srcGuildIds.length
    ? srcGuildIds.map(id => selfbot.guilds.cache.get(id)).filter(Boolean)
    : [...selfbot.guilds.cache.values()];
  guilds = guilds.filter(g => !excGuilds.has(g.id));

  const all = [];

  for (const guild of guilds) {
    console.log(`[mirrorEngine] ── Guild: ${guild.name}`);

    let chCollection;
    try { chCollection = await guild.channels.fetch(); }
    catch (e) { console.warn(`[mirrorEngine]   ⚠ ${guild.name}: ${e.message}`); continue; }

    const channels = [...chCollection.values()].filter(
      ch => ch && typeof ch.messages?.fetch === 'function' && !excChannels.has(ch.id)
    );

    const total = channels.length;
    console.log(`[mirrorEngine]   ${total} text channel(s) to scan`);

    // Batch concurrent scans with progress
    for (let i = 0; i < channels.length; i += BATCH) {
      const batch     = channels.slice(i, i + BATCH);
      const batchNum  = Math.floor(i / BATCH) + 1;
      const batchTotal = Math.ceil(total / BATCH);
      const names     = batch.map(c => `#${c.name}`).join(', ');
      console.log(`[mirrorEngine]   Batch ${batchNum}/${batchTotal}: ${names}`);

      const results = await Promise.allSettled(
        batch.map(ch => scanChannel(ch, chTimeout))
      );
      let batchFound = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') { all.push(...r.value); batchFound += r.value.length; }
      }
      console.log(`[mirrorEngine]   Batch ${batchNum}/${batchTotal} done — ${batchFound} link(s) found (total so far: ${all.length})`);
      if (i + BATCH < channels.length) await sleep(1500);
    }

    console.log(`[mirrorEngine]   ✓ ${guild.name} scan complete — ${all.length} link(s) found total`);
  }

  return all;
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────
async function runWithConcurrency(items, concurrency, fn) {
  const total = items.length;
  let completed = 0;
  let active = 0;
  let idx = 0;

  return new Promise((resolve, reject) => {
    function dispatch() {
      while (idx < items.length && active < concurrency) {
        const item = items[idx++];
        active++;
        fn(item)
          .catch(() => {}) // errors already handled inside fn
          .finally(() => {
            active--;
            completed++;
            console.log(`[mirrorEngine] Progress: ${completed}/${total}`);
            dispatch();
            if (completed === total) resolve();
          });
      }
      if (idx === items.length && active === 0 && completed === total) resolve();
    }
    if (items.length === 0) { resolve(); return; }
    dispatch();
  });
}


// ─── Main ─────────────────────────────────────────────────────────────────────
let _selfbot = null;
let _started = false;

function getMirrorEngineStatus() {
  const counts = Object.values(_state).reduce((a, v) => { a[v.status] = (a[v.status]||0)+1; return a; }, {});
  return {
    started: _started,
    stateCounts: counts
  };
}

/**
 * Starts the mirror engine.
 * @param {object} config
 * @param {boolean} [force=false] - Bypass mc.enabled config check
 */
async function startMirrorEngine(config, force = false) {
  const mc = config.mirrorEngine;

  if (!force && !mc?.enabled) {
    console.log('[mirrorEngine] Disabled — skipping.');
    return;
  }
  if (!mc.userToken) {
    console.warn('[mirrorEngine] No userToken — skipping.');
    return;
  }
  if (_started) {
    console.warn('[mirrorEngine] Already running — skipping duplicate start.');
    return;
  }

  // Prepare directories
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Clean up any leftover temp files from previous runs
  try {
    for (const entry of fs.readdirSync(TEMP_DIR)) {
      safeDelete(path.join(TEMP_DIR, entry));
    }
  } catch {}

  // Load state and reset stale in-progress entries
  loadState();
  const STALE = ['downloading', 'encrypting', 'uploading', 'channel_creating'];
  let resetCount = 0;
  for (const [k, v] of Object.entries(_state)) {
    if (STALE.includes(v.status)) {
      _state[k] = { ...v, status: 'pending', error: 'Reset after restart' };
      resetCount++;
    }
  }
  if (resetCount) { saveState(); console.log(`[mirrorEngine] Reset ${resetCount} stale entry(ies).`); }

  // State summary
  const counts = Object.values(_state).reduce((a, v) => { a[v.status] = (a[v.status]||0)+1; return a; }, {});
  if (Object.keys(counts).length) console.log('[mirrorEngine] Loaded state:', JSON.stringify(counts));

  // downloadManager.init() is called by index.js before startMirrorEngine.
  // Do NOT call it again here — it would reset shared download state.

  _selfbot = new SelfbotClient({ checkUpdate: false });
  _started = true;

  _selfbot.on('error', e => console.error('[mirrorEngine] Selfbot error:', e.message));

  _selfbot.once('ready', async () => {
    console.log(`[mirrorEngine] Selfbot: ${_selfbot.user.tag} (${_selfbot.guilds.cache.size} guild(s))`);

    try {
      await runEngine(config);
    } catch (e) {
      console.error('[mirrorEngine] Fatal:', e.message);
    } finally {
      _started = false;
      if (_selfbot) {
        _selfbot.destroy();
        _selfbot = null;
        console.log('[mirrorEngine] Selfbot disconnected. Engine stopped.');
      }
    }
  });

  _selfbot.login(mc.userToken).catch(e =>
    console.error('[mirrorEngine] Login failed:', e.message)
  );
}

async function runEngine(config) {
  const mc          = config.mirrorEngine;
  const concurrency = Math.max(1, mc.concurrency || 2);

  // ── Phase 1: Scan ────────────────────────────────────────────────────────
  console.log('[mirrorEngine] ── Phase 1: Scanning for MEGA links...');
  const found = await scanAllGuilds(config, _selfbot);

  // Register new links into state (deduplicated)
  let newCount = 0;
  for (const { link, name, categoryName } of found) {
    if (!getEntry(link)) {
      setEntry(link, { link, name, categoryName, status: 'pending', megaLink: null, password: null, channelId: null, messageId: null, error: null });
      newCount++;
    }
  }

  const pending = Object.values(_state).filter(e => e.status === 'pending');
  const done    = Object.values(_state).filter(e => e.status === 'done').length;
  const failed  = Object.values(_state).filter(e => e.status === 'failed').length;

  console.log(`[mirrorEngine] Scan: ${newCount} new, ${pending.length} pending, ${done} done, ${failed} failed.`);

  if (pending.length === 0) {
    console.log('[mirrorEngine] Nothing to do — all links processed.');
    return;
  }

  // ── Phase 2: Process ──────────────────────────────────────────────────────
  console.log(`[mirrorEngine] ── Phase 2: Processing ${pending.length} link(s) (concurrency=${concurrency})...`);
  await runWithConcurrency(pending, concurrency, item => processLink(item, config));

  // Final summary
  const fin = Object.values(_state).reduce((a, v) => { a[v.status] = (a[v.status]||0)+1; return a; }, {});
  console.log('[mirrorEngine] ── Done:', JSON.stringify(fin));
}

function stopMirrorEngine() {
  _started = false;
  if (_selfbot) { _selfbot.destroy(); _selfbot = null; }
}

module.exports = { startMirrorEngine, stopMirrorEngine, getMirrorEngineStatus };
