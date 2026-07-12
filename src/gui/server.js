const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const { getAllStates, removeState, getLogs, clearLogs, emitter } = require('../stateStore');

const configPath = path.join(__dirname, '..', '..', 'config', 'config.json');

function maskSecret(value) {
  if (!value || typeof value !== 'string') return value;
  if (value.length <= 4) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Starts the local dashboard server.
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
    watchFolderPath,
  } = handlers;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── File upload via multipart/form-data (drag-and-drop) ─────────────────────
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = watchFolderPath || path.join(__dirname, '..', '..', 'watched-folder');
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      // Preserve original name; sanitize dangerous chars
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
    res.json({ ok: true });
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
    try { onRetry(decodeURIComponent(filename)); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/reset-failed', (req, res) => {
    const all = getAllStates() || {};
    let count = 0;
    for (const [filename, state] of Object.entries(all)) {
      if (state && state.status === 'failed') { removeState(filename); count++; }
    }
    res.json({ ok: true, reset: count });
  });

  app.post('/api/reset-all', (req, res) => {
    const all = getAllStates() || {};
    let count = 0;
    for (const filename of Object.keys(all)) { removeState(filename); count++; }
    res.json({ ok: true, reset: count });
  });

  app.post('/api/download-engine/:action', (req, res) => {
    const actions = { pause: onDownloadPause, resume: onDownloadResume, cancel: onDownloadCancel };
    const handler = actions[req.params.action];
    if (typeof handler !== 'function') return res.status(400).json({ error: `Unknown action: ${req.params.action}` });
    try { handler(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Ingest a raw MEGA link directly from the GUI
  app.post('/api/ingest-link', (req, res) => {
    const { name, link, password } = req.body || {};
    if (!link || typeof link !== 'string') return res.status(400).json({ error: 'link is required.' });
    if (typeof onIngestLink !== 'function') return res.status(500).json({ error: 'Ingest not available.' });
    try {
      onIngestLink(name || 'Custom Link', link.trim(), password || null);
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
        // Trigger pipeline directly — don't rely on chokidar detecting the file
        try { onIngestZip(f.path); } catch (err) {
          console.error(`[gui] ingestZip error for "${f.originalname}": ${err.message}`);
        }
      }
      // .txt files are picked up automatically by the folder watcher
    }

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
      'mirrorEngine', 'downloadEngine',
    ];
    const body = req.body || {};
    for (const key of allowed) {
      if (key in body) config[key] = body[key];
    }
    // On Railway the config file may be read-only. We still update the in-memory
    // config so changes survive for the current session, but warn if we can't persist.
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      res.json({ ok: true });
    } catch (err) {
      // Config saved in memory for this session but not persisted to disk.
      // On Railway, set variables via the Variables tab instead.
      console.warn(`[gui] Could not save config.json (read-only host?): ${err.message}`);
      res.json({ ok: true, warning: 'Settings applied for this session only. Set environment variables in Railway for persistence.' });
    }
  });

  // ── Socket.IO ─────────────────────────────────────────────────────────────────

  io.on('connection', (socket) => {
    socket.emit('initial-state', getAllStates() || {});
    socket.emit('initial-logs', getLogs() || []);
  });

  emitter.on('update', ({ filename, state }) => io.emit('state-update', { filename, state }));
  emitter.on('log', (entry) => io.emit('new-log', entry));
  emitter.on('logs-cleared', () => io.emit('logs-cleared'));

  // Railway injects PORT; fall back to guiPort from config.
  const basePort = parseInt(process.env.PORT, 10) || config.guiPort || 3737;

  function tryListen(port) {
    server.listen(port, () => {
      if (port !== basePort) {
        console.warn(`[gui] Port ${basePort} in use — dashboard running at http://localhost:${port}`);
      } else {
        console.log(`[gui] Dashboard running at http://localhost:${port}`);
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
