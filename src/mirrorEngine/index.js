'use strict';

/**
 * Mirror Engine — Fully Standalone MEGA Link Mirroring System
 * ===========================================================
 *
 * Completely isolated from the main watcher pipeline.
 * Has its own state file, its own temp directory, and its own
 * download → encrypt → upload → post flow.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const archiver  = require('archiver');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');

const { encryptZip, generatePassword } = require('../zipEncryptor');
const { uploadToMega }   = require('../megaUploader');
const { createZipChannel, addToBatch } = require('../discordManager');
const { sendZipMessage } = require('../webhookSender');
const downloadManager    = require('../downloadEngine/downloadManager');
const { extractMegaLinks, extractSuggestedName, flattenEmbed } = require('../downloadEngine/linkExtractor');
const { getClient }      = require('../discordClient');
const bandwidthManager  = require('../utils/bandwidthManager');
const { appendSystemLog } = require('../stateStore');

try {
  archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
} catch (e) {
  if (!e.message.includes('already registered')) throw e;
}

// ─── Paths ────────────────────────────────────────────────────────────────────
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

function linkKey(url) {
  return url.replace(/\/$/, '').toLowerCase().trim();
}

// ─── State ────────────────────────────────────────────────────────────────────
let _state   = {}; // { [linkKey]: LinkEntry }
let _started = false;
let _selfbot = null;

// ─── Live engine status ────────────────────────────────────────────────────────
const _engineStatus = {
  running:    false,
  phase:      null,
  done:       0,
  total:      0,
  lastRunAt:  null,
};

function getMirrorEngineStatus() {
  const bw = bandwidthManager.getStatus();
  return {
    ..._engineStatus,
    phase: bw.paused ? `Bandwidth Paused (${bw.remainingSeconds}s remaining)` : _engineStatus.phase,
    bandwidth: bw,
  };
}

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
  // If bandwidth limit is currently active, wait until it resets
  if (bandwidthManager.isPaused()) {
    await bandwidthManager.waitUntilResumed();
  }

  const { link, name, categoryName } = entry;
  const mc = config.mirrorEngine;
  const sourcePassword = mc.sourcePassword || null;
  const outputPassword = generatePassword(12);

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

    const baseName = remoteName
      ? path.basename(remoteName, path.extname(remoteName))
      : safeName(name);

    const remoteExt = remoteName ? path.extname(remoteName).toLowerCase() : '';
    const isZip     = remoteExt === '.zip';

    const renamedPath = path.join(tmpDir, remoteName || `${baseName}${remoteExt || '.bin'}`);
    fs.renameSync(dlPath, renamedPath);

    // ── 2. Encrypt ─────────────────────────────────────────────────────────
    setEntry(link, { status: 'encrypting' });

    let encryptedZipPath;

    if (isZip) {
      try {
        const result = await encryptZip(renamedPath, outputPassword, sourcePassword);
        encryptedZipPath = result.encryptedPath;
        safeDelete(renamedPath);
      } catch (err) {
        if (sourcePassword && /wrong password/i.test(err.message)) {
          const result = await encryptZip(renamedPath, outputPassword, null);
          encryptedZipPath = result.encryptedPath;
          safeDelete(renamedPath);
        } else {
          throw new Error(`Encrypt: ${err.message}`);
        }
      }
    } else {
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
    let batchMode = existingEntry?.batchMode || false;
    let batchGuild = null;

    if (existingEntry?.channelId && existingEntry.channelId !== 'batch') {
      try {
        const botClient = await getClient(config);
        channel = await botClient.channels.fetch(existingEntry.channelId);
      } catch { channel = null; }
    }

    if (!channel && !batchMode) {
      setEntry(link, { status: 'channel_creating' });
      try {
        const result = await createZipChannel(baseName, config, { sourceCategoryName: categoryName });
        channel = result.channel;
        batchMode = result.batchMode || false;
        batchGuild = result.guild || null;
        if (!batchMode) {
          setEntry(link, { status: 'channel_created', channelId: channel.id, batchMode: false });
        } else {
          setEntry(link, { status: 'channel_created', channelId: 'batch', batchMode: true });
        }
      } catch (err) {
        throw new Error(`Channel: ${err.message}`);
      }
    }

    // ── 5. Send message ────────────────────────────────────────────────────
    try {
      if (batchMode) {
        if (!batchGuild) {
          const botClient = await getClient(config);
          batchGuild = await botClient.guilds.fetch(config.guildId);
        }
        await addToBatch(batchGuild, config, baseName, megaLink);
        setEntry(link, {
          status:    'done',
          megaLink,
          password:  outputPassword,
          channelId: 'batch',
          messageId: null,
          error:     null,
          batchMode: true,
        });
      } else {
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
          batchMode: false,
        });
      }
      console.log(`[mirrorEngine] ✓ ${baseName}`);
      appendSystemLog('INFO', `Mirrored "${baseName}" successfully.`, 'mirrorEngine');
    } catch (err) {
      throw new Error(`Post: ${err.message}`);
    }

  } catch (err) {
    if (downloadManager.isBandwidthError(err)) {
      const waitSec = downloadManager.extractBandwidthWaitSeconds(err.message);
      console.warn(`[mirrorEngine] ⏳ Bandwidth limit hit for "${name}". Pausing engine for ${waitSec}s...`);
      appendSystemLog('WARN', `Bandwidth limit hit processing "${name}". Engine paused for ${waitSec}s (${(waitSec / 3600).toFixed(2)} hrs). Item kept in queue.`, 'mirrorEngine');
      // Keep entry in pending status so it retries automatically on reset!
      setEntry(link, { status: 'pending', error: `Bandwidth limit reached — auto-resuming in ${waitSec}s` });
      bandwidthManager.triggerPause(waitSec, 'mirrorEngine');
    } else {
      console.error(`[mirrorEngine] ✗ ${name}: ${err.message}`);
      appendSystemLog('ERROR', `Mirror failed for "${name}": ${err.message}`, 'mirrorEngine');
      setEntry(link, { status: 'failed', error: err.message });
    }
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
  const MAX_MESSAGES = 500;
  let fetched = 0;

  const deadline = Date.now() + timeoutMs;

  while (fetched < MAX_MESSAGES) {
    if (Date.now() >= deadline) break;

    let batch;
    try {
      const remaining = deadline - Date.now();
      batch = await Promise.race([
        channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(remaining, 1000))),
      ]);
    } catch {
      break;
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

// ─── Concurrency pool with bandwidth limit pause support ─────────────────────
async function runWithConcurrency(items, concurrency, fn) {
  const total = items.length;
  let completed = 0;
  let active = 0;
  let idx = 0;

  return new Promise((resolve) => {
    function dispatch() {
      if (bandwidthManager.isPaused()) {
        const rem = bandwidthManager.getRemainingSeconds();
        console.log(`[mirrorEngine] Bandwidth pause active (${rem}s remaining). Concurrency dispatcher waiting...`);
        bandwidthManager.waitUntilResumed().then(() => dispatch());
        return;
      }

      while (idx < items.length && active < concurrency) {
        if (bandwidthManager.isPaused()) break;

        const item = items[idx++];
        active++;
        fn(item)
          .catch(() => {})
          .finally(() => {
            active--;
            completed++;
            _engineStatus.done = completed;
            _engineStatus.total = total;
            console.log(`[mirrorEngine] Progress: ${completed}/${total}`);
            dispatch();
            if (completed === total && active === 0) resolve();
          });
      }
      if (idx === items.length && active === 0 && completed === total) resolve();
    }

    if (items.length === 0) { resolve(); return; }
    dispatch();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function startMirrorEngine(config) {
  const mc = config.mirrorEngine;

  if (!mc?.enabled) {
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

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  try {
    for (const entry of fs.readdirSync(TEMP_DIR)) {
      safeDelete(path.join(TEMP_DIR, entry));
    }
  } catch {}

  if (process.env.RESET_MIRROR_STATE === 'true') {
    console.log('[mirrorEngine] RESET_MIRROR_STATE=true — clearing state for fresh run.');
    _state = {};
    try { if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH); } catch {}
  } else {
    loadState();
  }

  const STALE = ['downloading', 'encrypting', 'uploading', 'channel_creating'];
  let resetCount = 0;
  for (const [k, v] of Object.entries(_state)) {
    if (STALE.includes(v.status)) {
      _state[k] = { ...v, status: 'pending', error: 'Reset after restart' };
      resetCount++;
    }
  }
  if (resetCount) { saveState(); console.log(`[mirrorEngine] Reset ${resetCount} stale entry(ies).`); }

  const counts = Object.values(_state).reduce((a, v) => { a[v.status] = (a[v.status]||0)+1; return a; }, {});
  if (Object.keys(counts).length) console.log('[mirrorEngine] Loaded state:', JSON.stringify(counts));

  _selfbot = new SelfbotClient({ checkUpdate: false });
  _started = true;

  _selfbot.on('error', e => console.error('[mirrorEngine] Selfbot error:', e.message));

  _selfbot.once('ready', async () => {
    console.log(`[mirrorEngine] Selfbot: ${_selfbot.user.tag} (${_selfbot.guilds.cache.size} guild(s))`);
    appendSystemLog('INFO', `Selfbot logged in as ${_selfbot.user.tag}.`, 'mirrorEngine');

    try {
      await runEngine(config);
    } catch (e) {
      console.error('[mirrorEngine] Fatal:', e.message);
      appendSystemLog('ERROR', `Mirror engine fatal error: ${e.message}`, 'mirrorEngine');
    } finally {
      _started = false;
      _engineStatus.running = false;
      if (_selfbot) {
        _selfbot.destroy();
        _selfbot = null;
        console.log('[mirrorEngine] Selfbot disconnected. Engine stopped.');
        appendSystemLog('INFO', 'Mirror engine stopped.', 'mirrorEngine');
      }
    }
  });

  _selfbot.login(mc.userToken).catch(e => {
    console.error('[mirrorEngine] Login failed:', e.message);
    appendSystemLog('ERROR', `Selfbot login failed: ${e.message}`, 'mirrorEngine');
    _started = false;
  });
}

async function runEngine(config) {
  const mc          = config.mirrorEngine;
  const concurrency = Math.max(1, mc.concurrency || 4);

  _engineStatus.running   = true;
  _engineStatus.lastRunAt = new Date().toISOString();

  // ── Phase 1: Scan ────────────────────────────────────────────────────
  _engineStatus.phase = 'Scanning';
  console.log('[mirrorEngine] ── Phase 1: Scanning for MEGA links...');
  appendSystemLog('INFO', 'Phase 1: Scanning for MEGA links...', 'mirrorEngine');
  const found = await scanAllGuilds(config, _selfbot);

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
  appendSystemLog('INFO', `Scan complete: ${newCount} new, ${pending.length} pending, ${done} done, ${failed} failed.`, 'mirrorEngine');

  if (pending.length === 0) {
    console.log('[mirrorEngine] Nothing to do — all links processed.');
    _engineStatus.phase = 'Done';
    return;
  }

  // ── Phase 2: Process ──────────────────────────────────────────────────────
  _engineStatus.phase = 'Processing';
  console.log(`[mirrorEngine] ── Phase 2: Processing ${pending.length} link(s) (concurrency=${concurrency})...`);
  await runWithConcurrency(pending, concurrency, item => processLink(item, config));

  const fin = Object.values(_state).reduce((a, v) => { a[v.status] = (a[v.status]||0)+1; return a; }, {});
  console.log('[mirrorEngine] ── Done:', JSON.stringify(fin));
  _engineStatus.phase = 'Done';
}

function stopMirrorEngine() {
  _started = false;
  _engineStatus.running = false;
  _engineStatus.phase   = null;
  if (_selfbot) { _selfbot.destroy(); _selfbot = null; }
  appendSystemLog('INFO', 'Mirror engine manually stopped.', 'mirrorEngine');
}

function resetMirrorState() {
  const count = Object.keys(_state).length;
  _state = {};
  try { if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH); } catch {}
  console.log(`[mirrorEngine] State reset — cleared ${count} entries.`);
  appendSystemLog('WARN', `Mirror state reset (${count} entries cleared).`, 'mirrorEngine');
  return count;
}

module.exports = { startMirrorEngine, stopMirrorEngine, getMirrorEngineStatus, resetMirrorState };
