'use strict';

/**
 * stateStore.js — Persistent state for the main upload pipeline
 *
 * Storage priority:
 *   1. /data/state.json          — Railway Volume (survives restarts, preferred)
 *   2. <project-root>/state.json — Local dev (writable project dir)
 *   3. /tmp/mzb-state.json       — Last resort (ephemeral, Railway without volume)
 *
 * To avoid duplication on Railway restarts, mount a Volume at /data in the
 * Railway dashboard: Service → Volumes → Add Volume → Mount path: /data
 */

const path         = require('path');
const fs           = require('fs');
const EventEmitter = require('events');
const low          = require('lowdb');
const FileSync     = require('lowdb/adapters/FileSync');

// ── Resolve the best writable path for state storage ─────────────────────────
function resolveStatePath() {
  const candidates = [
    // 1. Railway Volume (persistent across restarts)
    process.env.STATE_DIR ? path.join(process.env.STATE_DIR, 'state.json') : null,
    '/data/state.json',
    // 2. Project root (local dev)
    path.join(__dirname, '..', 'state.json'),
    // 3. Temp dir (Railway without volume — ephemeral fallback)
    path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'mzb-state.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const dir = path.dirname(candidate);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (candidate.includes('/data/') || candidate.includes('state.json')) {
        const isVolume = candidate.startsWith('/data/');
        console.log(`[stateStore] Using ${isVolume ? '📦 Railway Volume' : '📁 local'} state: ${candidate}`);
      }
      return candidate;
    } catch { /* try next */ }
  }

  // Should never reach here
  return '/tmp/mzb-state.json';
}

const dbPath  = resolveStatePath();
const adapter = new FileSync(dbPath);
const db      = low(adapter);

db.defaults({ files: {}, logs: [] }).write();

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/**
 * NOTE: We always use ARRAY paths like ['files', filename] instead of the
 * dot-string form 'files.myzip.zip'. lowdb/lodash treats dot-strings as
 * nested paths, so a filename like "myzip.zip" would be misread as
 * files → myzip → zip. Array paths avoid that bug entirely.
 */

function getState(filename) {
  return db.get(['files', filename]).value() || null;
}

function updateState(filename, updates) {
  const existing = db.get(['files', filename]).value() || {
    status: 'pending',
    megaLink: null,
    zipPassword: null,
    channelId: null,
    error: null,
  };

  const merged = {
    ...existing,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };

  db.set(['files', filename], merged).write();
  emitter.emit('update', { filename, state: merged });
  return merged;
}

function getAllStates() {
  return db.get('files').value();
}

function removeState(filename) {
  db.unset(['files', filename]).write();
  emitter.emit('update', { filename, state: null });
}

// ── Upload Logs ───────────────────────────────────────────────────────────────
function appendLog(entry) {
  const record = { ...entry, sentAt: new Date().toISOString() };
  db.get('logs').push(record).write();
  emitter.emit('log', record);
  return record;
}

function getLogs() {
  return db.get('logs').value() || [];
}

function clearLogs() {
  db.set('logs', []).write();
  emitter.emit('logs-cleared');
}

module.exports = { getState, updateState, getAllStates, removeState, appendLog, getLogs, clearLogs, emitter };
