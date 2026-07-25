const fs = require('fs');
const path = require('path');
const { Storage } = require('megajs');

// Timeout for a single upload operation (15 minutes)
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// Pool of active MEGA storage sessions
// Map<accountKey, { storage: Storage, error: string|null, quotaExceeded: boolean }>
const storagePool = new Map();
let currentAccountIndex = 0;

/**
 * Normalizes accounts config list into an array of { email, password }
 */
function getAccountList(config) {
  const list = [];
  if (Array.isArray(config.megaAccounts) && config.megaAccounts.length > 0) {
    for (const acc of config.megaAccounts) {
      if (acc && acc.email && acc.password) {
        list.push({ email: acc.email.trim(), password: acc.password.trim() });
      }
    }
  }
  // Fallback to single account config if megaAccounts list is empty
  if (list.length === 0 && config.megaEmail && config.megaPassword) {
    list.push({ email: config.megaEmail.trim(), password: config.megaPassword.trim() });
  }
  return list;
}

/**
 * Gets or initializes a MEGA storage session for a specific account.
 */
async function getStorageForAccount(account) {
  const key = `${account.email.toLowerCase()}`;
  if (storagePool.has(key)) {
    const session = storagePool.get(key);
    if (session.storage) return session.storage;
    if (session.promise) return session.promise;
  }

  const promise = new Promise((resolve, reject) => {
    const storage = new Storage({
      email: account.email,
      password: account.password,
      autologin: true,
      keepalive: false,
    });

    storage.once('ready', () => {
      storagePool.set(key, { storage, quotaExceeded: false, promise: null });
      resolve(storage);
    });

    storage.once('error', (err) => {
      storagePool.delete(key);
      if (err && err.message && (err.message.includes('-9') || err.message.includes('ENOENT'))) {
        reject(new Error(`MEGA login failed for ${account.email} — invalid credentials.`));
      } else {
        reject(err);
      }
    });
  });

  storagePool.set(key, { storage: null, promise });
  return promise;
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
 * Checks if an error is a MEGA quota error (EOVERQUOTA / -17)
 */
function isQuotaError(err) {
  if (!err) return false;
  const msg = err.message || String(err);
  return msg.includes('EOVERQUOTA') || msg.includes('-17') || /over quota/i.test(msg);
}

/**
 * Uploads a file to MEGA using multi-account failover.
 * If account #1 hits EOVERQUOTA, it automatically rotates to account #2, etc.
 *
 * @param {string} filePath - path to the (already encrypted) file to upload
 * @param {object} config   - the loaded config.json object
 * @returns {Promise<string>} the MEGA share link
 */
async function uploadToMega(filePath, config) {
  const accounts = getAccountList(config);
  if (accounts.length === 0) {
    throw new Error('megaEmail / megaPassword or megaAccounts missing in config.json');
  }

  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  let lastError = null;

  // Try accounts starting from currentAccountIndex up to accounts.length attempts
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const idx = (currentAccountIndex + attempt) % accounts.length;
    const account = accounts[idx];
    const key = account.email.toLowerCase();

    const poolEntry = storagePool.get(key);
    if (poolEntry && poolEntry.quotaExceeded) {
      console.warn(`[megaUploader] Account ${account.email} marked as quota exceeded — skipping to next.`);
      continue;
    }

    try {
      console.log(`[megaUploader] Attempting upload with account: ${account.email} (${idx + 1}/${accounts.length})`);
      const storage = await getStorageForAccount(account);

      const uploadStream = storage.upload({ name: fileName, size: fileSize });
      const readStream = fs.createReadStream(filePath);
      readStream.on('error', (err) => uploadStream.destroy(err));
      readStream.pipe(uploadStream);

      const uploadedFile = await withTimeout(
        uploadStream.complete,
        UPLOAD_TIMEOUT_MS,
        `MEGA upload of "${fileName}" via ${account.email}`
      );

      if (!uploadedFile) {
        throw new Error('MEGA upload completed but returned no file object.');
      }

      const link = await withTimeout(
        uploadedFile.link(),
        30_000,
        'MEGA link generation'
      );

      if (!link) {
        throw new Error('MEGA returned an empty share link.');
      }

      // Success! Update current index so next upload continues with this working account
      currentAccountIndex = idx;
      return link;

    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        console.warn(`[megaUploader] ⚠️ Account ${account.email} hit EOVERQUOTA (-17). Switching to next account...`);
        const existing = storagePool.get(key);
        if (existing) existing.quotaExceeded = true;
        // Continue loop to try next account
      } else {
        // Discard session cache on network/other errors
        storagePool.delete(key);
        console.error(`[megaUploader] Upload error with ${account.email}: ${err.message}`);
        // If it's not a quota error, still try next account if available
      }
    }
  }

  throw new Error(`All ${accounts.length} MEGA account(s) failed or exceeded quota. Last error: ${lastError?.message || lastError}`);
}

/**
 * Resets quota status for all accounts in pool (e.g. after time passes or on manual reset)
 */
function resetAccountQuotas() {
  for (const entry of storagePool.values()) {
    if (entry) entry.quotaExceeded = false;
  }
}

module.exports = {
  uploadToMega,
  getStorageForConfig: async (config) => {
    const accounts = getAccountList(config);
    if (accounts.length === 0) throw new Error('No MEGA accounts configured.');
    return getStorageForAccount(accounts[0]);
  },
  resetAccountQuotas,
};
