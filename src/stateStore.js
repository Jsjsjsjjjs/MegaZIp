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
  // Test writability by checking if the parent dir is writable
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

db.defaults({ files: {}, logs: [], batchState: {
  dchecksRun: 0,
  currentBatchChannelId: null,
  currentLinkCount: 0,
  batchSeriesNumber: 0,
} }).write();

const emitter = new EventEmitter();
// Increase max listeners to avoid spurious warnings when many pipeline workers attach
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

module.exports = { getState, updateState, getAllStates, removeState, appendLog, getLogs, clearLogs, emitter, getBatchState, setBatchState };
