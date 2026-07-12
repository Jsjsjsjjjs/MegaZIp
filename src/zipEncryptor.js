const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const archiver = require('archiver');
const sevenBin = require('7zip-bin');

try {
  archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
} catch (e) {
  if (!e.message.includes('already registered')) throw e;
}

// Path to the bundled 7za binary (works on Windows/Linux/macOS with no system install)
const SEVEN_ZIP = sevenBin.path7za;

/**
 * Generates a random, human-typeable password (avoids visually confusing
 * characters like 0/O/1/l/I).
 */
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += chars[bytes[i] % chars.length];
  }
  return pass;
}

/**
 * Checks whether a zip file has any encrypted entries using 7zip's list command.
 * Returns true if any entry is flagged as encrypted.
 * @param {string} zipPath
 * @returns {Promise<boolean>}
 */
function isZipEncrypted(zipPath) {
  return new Promise((resolve) => {
    // `7za l -slt` prints technical listing; lines with "Encrypted = +" mean encrypted
    execFile(SEVEN_ZIP, ['l', '-slt', zipPath], (err, stdout) => {
      if (err) return resolve(false); // can't read → treat as not encrypted
      resolve(/Encrypted\s*=\s*\+/.test(stdout));
    });
  });
}

/**
 * Extracts a zip (encrypted or plain) into destDir using 7zip.
 * 7zip handles both ZipCrypto and AES-256 encrypted ZIPs.
 *
 * @param {string} zipPath   - path to the zip file
 * @param {string} destDir   - directory to extract into
 * @param {string|null} password - decryption password (null for unencrypted)
 * @returns {Promise<void>}
 */
function extractWith7zip(zipPath, destDir, password = null) {
  return new Promise((resolve, reject) => {
    const args = ['e', zipPath, `-o${destDir}`, '-y'];
    if (password) args.push(`-p${password}`);

    execFile(SEVEN_ZIP, args, (err, stdout, stderr) => {
      if (err) {
        // 7zip exit code 2 = fatal error (bad password, corrupted, etc.)
        // Extract the most useful part of the output for the error message
        const detail = stderr.trim() || stdout.trim() || err.message;
        if (/Wrong password|incorrect password|password/i.test(detail) ||
            err.code === 2) {
          return reject(new Error('Wrong password — check "zipInputPassword" in config or dashboard.'));
        }
        return reject(new Error(`7zip extraction failed: ${detail}`));
      }
      resolve();
    });
  });
}

/**
 * Takes an existing zip file (encrypted or not), extracts it, and re-packs it
 * as an AES-256 password-protected zip.
 *
 * Supports ZipCrypto AND AES-256 source ZIPs via the bundled 7-zip binary.
 * If the source zip is already encrypted, `inputPassword` must be provided.
 *
 * @param {string} zipPath       - path to the original zip file
 * @param {string|null} password - output password; if null/empty a random one is generated
 * @param {string|null} inputPassword - password to decrypt the source zip (if encrypted)
 * @returns {Promise<{ encryptedPath: string, password: string }>}
 */
async function encryptZip(zipPath, password, inputPassword = null) {
  const finalPassword = password && password.length > 0 ? password : generatePassword(12);
  const baseName = path.basename(zipPath, path.extname(zipPath));
  const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mzb-extract-'));
  const outputDir = path.join(path.dirname(zipPath), 'encrypted');
  const outputPath = path.join(outputDir, `${baseName}.zip`);

  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 1. Detect whether source ZIP is encrypted
    const encrypted = await isZipEncrypted(zipPath);

    if (encrypted && !inputPassword) {
      throw new Error(
        'This zip is password-protected. Set "zipInputPassword" in config or provide a sourcePassword.'
      );
    }

    // 2. Extract source ZIP into temp folder
    //    - If the zip IS encrypted, pass the inputPassword
    //    - If the zip is NOT encrypted, extract without password (ignore inputPassword)
    await extractWith7zip(zipPath, tempExtractDir, encrypted ? inputPassword : null);

    // 3. Re-zip the extracted contents with AES-256 password encryption
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver.create('zip-encrypted', {
        zlib: { level: 8 },
        encryptionMethod: 'aes256',
        password: finalPassword,
      });

      output.on('close', resolve);
      archive.on('error', (err) => reject(err));
      output.on('error', (err) => reject(err));

      archive.pipe(output);
      archive.directory(tempExtractDir, false);
      archive.finalize();
    });

    return { encryptedPath: outputPath, password: finalPassword };
  } finally {
    // Always clean up the temp extraction folder, even on failure
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
}


module.exports = { encryptZip, generatePassword, isZipEncrypted };
