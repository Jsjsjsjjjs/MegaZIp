'use strict';

const fs   = require('fs');
const path = require('path');
const { Storage } = require('megajs');

// ── Session persistence ────────────────────────────────────────────────────────
// Saves the MEGA session token to disk after a fresh login.
// On the next start we resume the existing session instead of doing a brand-new
// email+password login, which prevents MEGA from flagging each Railway restart
// as a "suspicious login from a foreign IP".
// Fall back to /tmp if config folder is read-only on hosting (Railway).
function resolveSessionPath() {
  const preferred = path.join(__dirname, '..', 'config', 'mega-session.json');
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'mega-session-tmp.json');
  }
}

const SESSION_PATH    = resolveSessionPath();
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

function loadSavedSession() {
  try {
    const raw  = fs.readFileSync(SESSION_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data.sid && Date.now() - (data.savedAt || 0) < SESSION_MAX_AGE) {
      return data.sid;
    }
  } catch { /* no saved session or parse error — fall through */ }
  return null;
}

function persistSession(storage) {
  try {
    const sid = storage.sid;
    if (!sid) return;
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ sid, savedAt: Date.now() }), 'utf8');
    console.log('[megaUploader] MEGA session token saved — future restarts will reuse it.');
  } catch (e) {
    console.warn('[megaUploader] Could not persist MEGA session:', e.message);
  }
}

function clearSavedSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch {}
}

// ── Storage singleton ──────────────────────────────────────────────────────────
let storagePromise = null;

// How long to wait for a single upload before giving up (15 min — MEGA free tier is slow)
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Returns a ready MEGA Storage instance.
 *
 * Strategy:
 *  1. If a session token was saved from a previous run, try to resume it —
 *     this avoids a fresh email/password login (no "malicious login" alert).
 *  2. If the saved session is expired/invalid, fall back to a fresh login with
 *     email+password and save the new session token for next time.
 *  3. Within a single process, the same Storage instance is reused for all
 *     uploads (storagePromise is a module-level singleton).
 *
 * @param {object} config
 * @returns {Promise<Storage>}
 */
function getStorage(config) {
  if (storagePromise) return storagePromise;
  storagePromise = _createStorage(config, true);
  storagePromise.catch(() => { storagePromise = null; });
  return storagePromise;
}

function _createStorage(config, tryResume) {
  return new Promise((resolve, reject) => {
    const savedSid = tryResume ? loadSavedSession() : null;

    let storage;
    if (savedSid) {
      console.log('[megaUploader] Resuming existing MEGA session (no re-login needed).');
      storage = new Storage({ sid: savedSid, keepalive: true });
    } else {
      if (!config.megaEmail || !config.megaPassword) {
        return reject(new Error('megaEmail / megaPassword missing in config.json'));
      }
      console.log('[megaUploader] Starting fresh MEGA login...');
      storage = new Storage({
        email:     config.megaEmail,
        password:  config.megaPassword,
        autologin: true,
        keepalive: true,
      });
    }

    storage.once('ready', () => {
      persistSession(storage); // save token for next startup
      resolve(storage);
    });

    storage.once('error', (err) => {
      const msg = err?.message || String(err);

      // If the saved session is stale/invalid, discard it and retry with credentials
      if (savedSid) {
        console.warn('[megaUploader] Saved session rejected — falling back to fresh login.');
        clearSavedSession();
        storagePromise = null;
        // Recurse without tryResume so we do a proper email/password login
        resolve(_createStorage(config, false));
        return;
      }

      // ── Permanent account-level errors — no point retrying ─────────────────
      storagePromise = null;

      if (msg.includes('-16') || msg.includes('EBLOCKED')) {
        const e = new Error(
          'MEGA account is BLOCKED by MEGA. Log into mega.nz, complete verification, ' +
          'or update MEGA_EMAIL / MEGA_PASSWORD in your Railway Variables.'
        );
        e.nonRetryable = true;
        return reject(e);
      }
      if (msg.includes('-17') || msg.includes('EOVERQUOTA')) {
        const e = new Error(
          'MEGA account quota exceeded. Free up space at mega.nz or use a different account.'
        );
        e.nonRetryable = true;
        return reject(e);
      }
      if (msg.includes('-9') || msg.includes('ENOENT')) {
        const e = new Error(
          `MEGA login failed — wrong email/password. ` +
          `Verify MEGA_EMAIL (${config.megaEmail}) and MEGA_PASSWORD in your environment variables.`
        );
        e.nonRetryable = true;
        return reject(e);
      }

      reject(err);
    });
  });
}

// ── Session invalidation helper ────────────────────────────────────────────────
/**
 * Call this when credentials change (password reset, etc.) to force a fresh
 * login on the next upload instead of trying a stale session token.
 */
function invalidateSession() {
  clearSavedSession();
  storagePromise = null;
  console.log('[megaUploader] MEGA session invalidated — will re-login on next upload.');
}

// ── Upload timeout wrapper ─────────────────────────────────────────────────────
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms / 1000}s waiting for ${label}`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Main upload function ───────────────────────────────────────────────────────
/**
 * Uploads a file to MEGA and returns its public share link.
 *
 * @param {string} filePath - path to the (already encrypted) file to upload
 * @param {object} config   - the loaded config.json object
 * @returns {Promise<string>} the MEGA share link
 */
async function uploadToMega(filePath, config) {
  const storage  = await getStorage(config);
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  // Step 1: Start upload — pipe the file into the upload stream
  const uploadStream = storage.upload({ name: fileName, size: fileSize });

  const readStream = fs.createReadStream(filePath);
  readStream.on('error', (err) => uploadStream.destroy(err));
  readStream.pipe(uploadStream);

  // Step 2: Await stream.complete
  let uploadedFile;
  try {
    uploadedFile = await withTimeout(
      uploadStream.complete,
      UPLOAD_TIMEOUT_MS,
      `MEGA upload of "${fileName}"`
    );
  } catch (err) {
    // On upload failure, discard the cached session so the next attempt
    // tries a fresh login (avoids re-using a broken session object)
    storagePromise = null;
    throw err;
  }

  if (!uploadedFile) {
    storagePromise = null;
    throw new Error('MEGA upload completed but returned no file object.');
  }

  // Step 3: Get the public share link
  const link = await withTimeout(
    uploadedFile.link(),
    30_000,
    'MEGA link generation'
  );

  if (!link) {
    throw new Error('MEGA returned an empty share link.');
  }

  return link;
}

module.exports = { uploadToMega, invalidateSession };
