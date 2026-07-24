'use strict';

const path        = require('path');
const fs          = require('fs');
const EventEmitter = require('events');
const low         = require('lowdb');
const FileSync    = require('lowdb/adapters/FileSync');

// On Railway and other read-only hosts, the project root (/app) is read-only.
// Write state to /tmp which is always writable. Fall back to project root locally.
function resolveStatePath() {
  const preferred = path.join(__dirname, '..', 'state.json');
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    const tmp = path.join(
      process.env.TMPDIR || process.env.TEMP || '/tmp',
      'mzb-state.json'
    );
    console.log(`[stateStore] Using tmp path: ${tmp}`);
    return tmp;
  }
}

const dbPath  = resolveStatePath();
const adapter = new FileSync(dbPath);
const db      = low(adapter);

db.defaults({
  files: {},
  logs: [],
  systemLogs: [],
  mirrorState: {},
  batchState: {
    dchecksRun: 0,
    currentBatchChannelId: null,
    currentLinkCount: 0,
    batchSeriesNumber: 0,
  },
}).write();

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function getMirrorStateDb() {
  return db.get('mirrorState').value() || {};
}

function setMirrorStateDb(mirrorState) {
  if (!mirrorState || typeof mirrorState !== 'object') return;
  db.set('mirrorState', mirrorState).write();
}

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
  return db.get('files').value() || {};
}

function removeState(filename) {
  db.unset(['files', filename]).write();
  emitter.emit('update', { filename, state: null });
}

// ── Upload Logs ──────────────────────────────────────────────────────────────
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

// ── System / Control Logs ───────────────────────────────────────────────────
function appendSystemLog(level, message, source = 'system') {
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    source,
  };
  const logs = db.get('systemLogs').value() || [];
  logs.push(record);
  if (logs.length > 500) logs.shift();
  db.set('systemLogs', logs).write();
  emitter.emit('system-log', record);
  return record;
}

function getSystemLogs(limit = 100) {
  const logs = db.get('systemLogs').value() || [];
  return logs.slice(-limit);
}

function clearSystemLogs() {
  db.set('systemLogs', []).write();
  emitter.emit('system-logs-cleared');
}

// ── Batch State ─────────────────────────────────────────────────────────────
function getBatchState() {
  return db.get('batchState').value() || {
    dchecksRun: 0, currentBatchChannelId: null, currentLinkCount: 0, batchSeriesNumber: 0,
  };
}

function setBatchState(updates) {
  const current = getBatchState();
  db.set('batchState', { ...current, ...updates }).write();
}

function getDbPath() {
  return dbPath;
}

// ── State Archive Export / Import (/sa command) ──────────────────────────────
function exportStateArchive(mirrorState = {}) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    filesState: db.get('files').value() || {},
    batchState: getBatchState(),
    logs: db.get('logs').value() || [],
    mirrorState: mirrorState || {},
  };
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  return { payload, base64 };
}

function importStateArchive(base64Code, setMirrorStateFn) {
  if (!base64Code || typeof base64Code !== 'string') {
    throw new Error('Invalid Base64 code provided.');
  }
  let jsonString;
  try {
    jsonString = Buffer.from(base64Code.trim(), 'base64').toString('utf-8');
  } catch {
    throw new Error('Failed to decode Base64 string.');
  }

  let payload;
  try {
    payload = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON inside decoded archive.');
  }

  if (!payload || typeof payload !== 'object' || !payload.filesState) {
    throw new Error('Invalid state archive payload format.');
  }

  if (payload.filesState && typeof payload.filesState === 'object') {
    db.set('files', payload.filesState).write();
  }
  if (payload.batchState && typeof payload.batchState === 'object') {
    db.set('batchState', payload.batchState).write();
  }
  if (Array.isArray(payload.logs)) {
    db.set('logs', payload.logs).write();
  }

  let mirrorCount = 0;
  if (payload.mirrorState && typeof payload.mirrorState === 'object' && typeof setMirrorStateFn === 'function') {
    mirrorCount = setMirrorStateFn(payload.mirrorState);
  }

  const filesCount = Object.keys(payload.filesState || {}).length;
  appendSystemLog('WARN', `Imported state archive: ${filesCount} pipeline item(s), ${mirrorCount} mirror link(s) restored.`, 'stateStore');

  return {
    filesCount,
    mirrorCount,
    exportedAt: payload.exportedAt,
  };
}

module.exports = {
  getState,
  updateState,
  getAllStates,
  removeState,
  appendLog,
  getLogs,
  clearLogs,
  appendSystemLog,
  getSystemLogs,
  clearSystemLogs,
  emitter,
  getBatchState,
  setBatchState,
  getDbPath,
  exportStateArchive,
  importStateArchive,
  getMirrorStateDb,
  setMirrorStateDb,
};
