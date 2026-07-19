const fs = require('fs');
const path = require('path');
const { Storage } = require('megajs');

let storagePromise = null;

// How long to wait for a single upload before giving up (15 minutes — MEGA free tier is slow)
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Logs into MEGA once, waits for the 'ready' event, then reuses the same
 * session for all subsequent uploads.
 */
const SESSION_PATH = (() => {
  const preferred = path.join(__dirname, '..', 'mega-session.json');
  try { fs.accessSync(path.dirname(preferred), fs.constants.W_OK); return preferred; }
  catch { return path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'mega-session.json'); }
})();

function saveSession(storage) {
  try {
    const sid = storage.sid || storage._storage?.sid;
    if (sid) fs.writeFileSync(SESSION_PATH, JSON.stringify({ sid }, null, 2));
  } catch {}
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
      return raw.sid || null;
    }
  } catch {}
  return null;
}

function getStorage(config) {
  if (storagePromise) return storagePromise;

  storagePromise = new Promise((resolve, reject) => {
    if (!config.megaEmail || !config.megaPassword) {
      return reject(new Error('megaEmail / megaPassword missing in config.json'));
    }

    // Try resuming a previous session first
    const savedSid = loadSession();
    const storageOpts = savedSid
      ? { email: config.megaEmail, password: config.megaPassword, sid: savedSid, autologin: true, keepalive: true }
      : { email: config.megaEmail, password: config.megaPassword, autologin: true, keepalive: false };

    const storage = new Storage(storageOpts);

    storage.once('ready', () => {
      saveSession(storage); // persist the new session
      resolve(storage);
    });
    storage.once('error', (err) => {
      // If session resume failed, clear the saved session and fall back to fresh login
      if (savedSid) {
        try { fs.unlinkSync(SESSION_PATH); } catch {}
        console.warn('[megaUploader] Saved session invalid — falling back to fresh login.');
        storagePromise = null;
        storagePromise = getStorage(config); // retry without sid
        storagePromise.then(resolve).catch(reject);
        return;
      }
      if (err && err.message && (err.message.includes('-9') || err.message.includes('ENOENT'))) {
        reject(new Error(
          `MEGA login failed — user not found. ` +
          `Check megaEmail (${config.megaEmail}) and megaPassword in config.json.`
        ));
      } else {
        reject(err);
      }
    });
  });

  // On failure, clear cache so the next call gets a fresh attempt
  storagePromise.catch(() => { storagePromise = null; });
  return storagePromise;
}

/**
 * Wraps a Promise with a timeout that rejects after `ms` milliseconds.
 */
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

/**
 * Uploads a file to MEGA and returns its public share link.
 *
 * Uses the correct megajs v1.x API:
 *   - storage.upload() returns a writable stream
 *   - stream.complete is a Promise that resolves with the uploaded MutableFile
 *   - file.link() is a Promise that resolves with the share URL
 *
 * @param {string} filePath - path to the (already encrypted) file to upload
 * @param {object} config   - the loaded config.json object
 * @returns {Promise<string>} the MEGA share link
 */
async function uploadToMega(filePath, config) {
  const storage = await getStorage(config);
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  // Step 1: Start upload — pipe the file into the upload stream
  const uploadStream = storage.upload({ name: fileName, size: fileSize });

  const readStream = fs.createReadStream(filePath);
  readStream.on('error', (err) => uploadStream.destroy(err));
  readStream.pipe(uploadStream);

  // Step 2: Await stream.complete (a Promise on the stream object itself)
  let uploadedFile;
  try {
    uploadedFile = await withTimeout(
      uploadStream.complete,
      UPLOAD_TIMEOUT_MS,
      `MEGA upload of "${fileName}"`
    );
  } catch (err) {
    // On any upload failure, discard the cached session so the next retry
    // creates a fresh MEGA login
    storagePromise = null;
    throw err;
  }

  if (!uploadedFile) {
    storagePromise = null;
    throw new Error('MEGA upload completed but returned no file object.');
  }

  // Step 3: Get the public share link (Promise-based in megajs v1.x)
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

module.exports = { uploadToMega };
