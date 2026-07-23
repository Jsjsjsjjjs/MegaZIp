const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const {
  getAllStates,
  removeState,
  getLogs,
  clearLogs,
  getSystemLogs,
  clearSystemLogs,
  appendSystemLog,
  getDbPath,
} = require('../stateStore');
const bandwidthManager = require('../utils/bandwidthManager');

const configPath = path.join(__dirname, '..', '..', 'config', 'config.json');

function maskSecret(value) {
  if (!value || typeof value !== 'string') return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Starts the local dashboard server (REST-only polling architecture, zero WebSockets).
 * @param {object} config - the shared config object (mutated in place on saves)
 * @param {object} handlers
 */
function startGuiServer(config, handlers = {}) {
  const {
    onRetry,
    onDownloadPause,
    onDownloadResume,
    onDownloadCancel,
    onIngestLink,
    onIngestZip,
    onIngestTxt,
    watchFolderPath,
    mirrorControls = {},
    pipelineControls = {},
    shrinkControls = {},
    runAutoDedup,
  } = handlers;

  const app = express();
  const server = http.createServer(app);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── File upload via multipart/form-data (drag-and-drop) ─────────────────────
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = watchFolderPath || path.join(__dirname, '..', '..', 'watched-folder');
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[\\/:*?"<>|]/g, '-');
      cb(null, safe);
    },
  });
  const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.zip' || ext === '.txt') return cb(null, true);
      cb(new Error('Only .zip and .txt files are allowed.'));
    },
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  });

  // ── REST API ─────────────────────────────────────────────────────────────────

  app.get('/api/status', (req, res) => res.json(getAllStates() || {}));

  app.get('/api/logs', (req, res) => res.json(getLogs() || []));

  app.delete('/api/logs', (req, res) => {
    clearLogs();
    appendSystemLog('INFO', 'Upload logs cleared via dashboard.', 'gui');
    res.json({ ok: true });
  });

  app.get('/api/system-logs', (req, res) => res.json(getSystemLogs(200) || []));

  app.delete('/api/system-logs', (req, res) => {
    clearSystemLogs();
    res.json({ ok: true });
  });

  // Comprehensive Telemetry Endpoint (Polling Target)
  app.get('/api/telemetry', (req, res) => {
    const states = getAllStates() || {};
    const entries = Object.values(states);
    const counts = { total: entries.length, pending: 0, encrypting: 0, uploading: 0, uploaded: 0, channel_created: 0, message_sent: 0, failed: 0 };
    for (const s of entries) {
      if (s.status in counts) counts[s.status]++;
    }

    const bw = bandwidthManager.getStatus();
    const mirrorStatus = mirrorControls.getStatus ? mirrorControls.getStatus() : { running: false, phase: null };
    const pipelineStatus = pipelineControls.getStatus ? pipelineControls.getStatus() : { active: 0, queued: 0 };
    const systemLogs = getSystemLogs(50);
    const dbPath = getDbPath();

    res.json({
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      counts,
      bandwidth: bw,
      mirror: mirrorStatus,
      pipeline: pipelineStatus,
      systemLogs,
      dbPath,
    });
  });

  app.get('/api/stats', (req, res) => {
    const states = getAllStates() || {};
    const entries = Object.values(states);
    const counts = { total: entries.length, pending: 0, encrypting: 0, uploading: 0, uploaded: 0, channel_created: 0, message_sent: 0, failed: 0 };
    for (const s of entries) {
      if (s.status in counts) counts[s.status]++;
    }
    counts.logs = (getLogs() || []).length;
    res.json(counts);
  });

  app.post('/api/retry/:filename', (req, res) => {
    const { filename } = req.params;
    if (typeof onRetry !== 'function') return res.status(500).json({ error: 'Retry not available.' });
    try {
      const decoded = decodeURIComponent(filename);
      onRetry(decoded);
      appendSystemLog('INFO', `Retry triggered for "${decoded}".`, 'gui');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/reset-failed', (req, res) => {
    const all = getAllStates() || {};
    let count = 0;
    for (const [filename, state] of Object.entries(all)) {
      if (state && state.status === 'failed') { removeState(filename); count++; }
    }
    appendSystemLog('WARN', `Reset ${count} failed pipeline file(s).`, 'gui');
    res.json({ ok: true, reset: count });
  });

  app.post('/api/reset-all', (req, res) => {
    const all = getAllStates() || {};
    let count = 0;
    for (const filename of Object.keys(all)) { removeState(filename); count++; }
    appendSystemLog('WARN', `Reset ALL (${count}) pipeline entries.`, 'gui');
    res.json({ ok: true, reset: count });
  });

  app.post('/api/download-engine/:action', (req, res) => {
    const actions = { pause: onDownloadPause, resume: onDownloadResume, cancel: onDownloadCancel };
    const handler = actions[req.params.action];
    if (typeof handler !== 'function') return res.status(400).json({ error: `Unknown action: ${req.params.action}` });
    try {
      handler();
      appendSystemLog('INFO', `Download engine action "${req.params.action}" executed.`, 'gui');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Control Center Endpoints ───────────────────────────────────────────────

  // Mirror Engine Control
  app.post('/api/control/mirror', (req, res) => {
    const { action } = req.body || {};
    try {
      if (action === 'start') {
        if (!mirrorControls.start) return res.status(400).json({ error: 'Mirror start not available.' });
        mirrorControls.start();
        appendSystemLog('INFO', 'Mirror engine started via Control Center.', 'gui');
        return res.json({ ok: true, message: 'Mirror engine started.' });
      }
      if (action === 'stop') {
        if (!mirrorControls.stop) return res.status(400).json({ error: 'Mirror stop not available.' });
        mirrorControls.stop();
        appendSystemLog('INFO', 'Mirror engine stopped via Control Center.', 'gui');
        return res.json({ ok: true, message: 'Mirror engine stopped.' });
      }
      if (action === 'reset') {
        if (!mirrorControls.reset) return res.status(400).json({ error: 'Mirror reset not available.' });
        const cleared = mirrorControls.reset();
        appendSystemLog('WARN', `Mirror engine state reset (${cleared} entries cleared).`, 'gui');
        return res.json({ ok: true, message: `Mirror state reset (${cleared} entries cleared).` });
      }
      res.status(400).json({ error: `Invalid action: ${action}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bandwidth Control
  app.post('/api/control/bandwidth', (req, res) => {
    const { action, waitSeconds } = req.body || {};
    try {
      if (action === 'clear') {
        bandwidthManager.clearPause();
        appendSystemLog('INFO', 'Bandwidth pause cleared manually via Control Center.', 'gui');
        return res.json({ ok: true, message: 'Bandwidth pause cleared.' });
      }
      if (action === 'pause') {
        const sec = parseInt(waitSeconds, 10) || 3600;
        bandwidthManager.triggerPause(sec, 'Control Center');
        appendSystemLog('WARN', `Manual bandwidth pause triggered for ${sec}s via Control Center.`, 'gui');
        return res.json({ ok: true, message: `Bandwidth pause set for ${sec}s.` });
      }
      res.status(400).json({ error: 'Action must be "clear" or "pause".' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Channel Deduplication Trigger (/dcheck)
  app.post('/api/control/dcheck', async (req, res) => {
    if (typeof runAutoDedup !== 'function') {
      return res.status(500).json({ error: 'Auto-dedup function not available.' });
    }
    try {
      appendSystemLog('INFO', 'Triggering server channel deduplication...', 'gui');
      const result = await runAutoDedup();
      appendSystemLog('INFO', `Server deduplication complete: ${result.deleted || 0} duplicate channel(s) removed.`, 'gui');
      res.json({ ok: true, deleted: result.deleted || 0 });
    } catch (err) {
      appendSystemLog('ERROR', `Deduplication failed: ${err.message}`, 'gui');
      res.status(500).json({ error: err.message });
    }
  });

  // South-to-North Channel Shrink Trigger (/shrink)
  app.post('/api/control/shrink', async (req, res) => {
    const count = parseInt(req.body?.count, 10) || 1;
    if (typeof shrinkControls.shrink !== 'function') {
      return res.status(500).json({ error: 'Shrink function not available.' });
    }
    try {
      appendSystemLog('INFO', `Triggering south-to-north shrink for ${count} channel(s)...`, 'gui');
      const result = await shrinkControls.shrink(count);
      appendSystemLog('INFO', `Shrink complete: ${result.shrunk || 0}/${count} channel(s) collapsed into batch embeds.`, 'gui');
      res.json({ ok: true, shrunk: result.shrunk || 0, details: result.details || [] });
    } catch (err) {
      appendSystemLog('ERROR', `Shrink failed: ${err.message}`, 'gui');
      res.status(500).json({ error: err.message });
    }
  });

  // Ingest a raw MEGA link directly from the GUI
  app.post('/api/ingest-link', (req, res) => {
    const { name, link, password } = req.body || {};
    if (!link || typeof link !== 'string') return res.status(400).json({ error: 'link is required.' });
    if (typeof onIngestLink !== 'function') return res.status(500).json({ error: 'Ingest not available.' });
    try {
      onIngestLink(name || 'Custom Link', link.trim(), password || null);
      appendSystemLog('INFO', `Ingested custom link "${name || 'Custom Link'}"`, 'gui');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Drag-and-drop file upload
  app.post('/api/upload', upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

    const names = [];
    for (const f of req.files) {
      names.push(f.originalname);
      const ext = path.extname(f.originalname).toLowerCase();
      if (ext === '.zip' && typeof onIngestZip === 'function') {
        try { onIngestZip(f.path); } catch (err) {
          console.error(`[gui] ingestZip error for "${f.originalname}": ${err.message}`);
        }
      } else if (ext === '.txt' && typeof onIngestTxt === 'function') {
        try { onIngestTxt(f.path); } catch (err) {
          console.error(`[gui] ingestTxt error for "${f.originalname}": ${err.message}`);
        }
      }
    }

    appendSystemLog('INFO', `Uploaded ${names.length} file(s) via web upload dashboard.`, 'gui');
    res.json({ ok: true, uploaded: names });
  });

  // ── Config API ───────────────────────────────────────────────────────────────

  app.get('/api/config', (req, res) => {
    const masked = { ...config };
    if (masked.advancedTemplate) masked.advancedTemplate = { ...masked.advancedTemplate };
    masked.discordToken = maskSecret(masked.discordToken);
    masked.megaPassword = maskSecret(masked.megaPassword);
    if (masked.mirrorEngine) {
      masked.mirrorEngine = { ...masked.mirrorEngine };
      masked.mirrorEngine.userToken = maskSecret(masked.mirrorEngine.userToken);
    }
    res.json(masked);
  });

  app.post('/api/config', (req, res) => {
    const allowed = [
      'messageTemplate', 'channelNameTemplate', 'channelNameBoldStyle',
      'zipInputPassword', 'zipPasswordMode', 'uploadDelaySeconds',
      'deleteEncryptedAfterUpload', 'advancedTemplate',
      'mirrorEngine', 'downloadEngine', 'batchEmbedTemplate',
    ];
    const body = req.body || {};
    for (const key of allowed) {
      if (key in body) config[key] = body[key];
    }
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      appendSystemLog('INFO', 'Updated config settings via GUI.', 'gui');
      res.json({ ok: true });
    } catch (err) {
      console.warn(`[gui] Could not save config.json (read-only host?): ${err.message}`);
      res.json({ ok: true, warning: 'Settings applied for this session only. Set environment variables in Railway for persistence.' });
    }
  });

  const basePort = parseInt(process.env.PORT, 10) || config.guiPort || 3737;

  function tryListen(port) {
    server.listen(port, '0.0.0.0', () => {
      if (port !== basePort) {
        console.warn(`[gui] Port ${basePort} in use — dashboard running at http://0.0.0.0:${port}`);
      } else {
        console.log(`[gui] Dashboard running at http://0.0.0.0:${port}`);
      }
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[gui] Port ${port} already in use, trying ${port + 1}...`);
        server.close();
        tryListen(port + 1);
      } else {
        console.error(`[gui] Server error: ${err.message}`);
      }
    });
  }

  tryListen(basePort);
  return server;
}

module.exports = { startGuiServer };
