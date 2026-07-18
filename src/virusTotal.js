'use strict';

/**
 * virusTotal.js — VirusTotal v3 API client
 *
 * Uses Node's built-in `https` module only (no extra dependencies).
 * Free-tier API key works — just set VIRUSTOTAL_API_KEY in Railway env vars.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ── Internal: make an authenticated request to VT v3 API ─────────────────────
function vtRequest(method, path, apiKey, postData = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.virustotal.com',
      path,
      method,
      headers: {
        'x-apikey': apiKey,
        'Accept': 'application/json',
      },
    };

    if (postData) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null); // not found on VT — not an error
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`VirusTotal response is not valid JSON (status ${res.statusCode})`)); }
        } else {
          reject(new Error(`VirusTotal API error: HTTP ${res.statusCode} — ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ── Compute SHA-256 hash of a local file ──────────────────────────────────────
function getFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Submit a URL to VirusTotal for reputation analysis.
 * Returns the full VT analysis attributes object.
 * @param {string} url
 * @param {string} apiKey
 */
async function scanUrl(url, apiKey) {
  const encoded = encodeURIComponent(url);
  // First: try to get an existing analysis
  const urlId = Buffer.from(url).toString('base64url').replace(/=/g, '');
  let report = await vtRequest('GET', `/api/v3/urls/${urlId}`, apiKey);

  if (!report) {
    // Submit for fresh scan
    const submitRes = await vtRequest('POST', '/api/v3/urls', apiKey, `url=${encoded}`);
    const analysisId = submitRes?.data?.id;
    if (!analysisId) throw new Error('VirusTotal did not return an analysis ID for URL scan.');

    // Poll until done (max 10 attempts × 3s)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const analysis = await vtRequest('GET', `/api/v3/analyses/${analysisId}`, apiKey);
      if (analysis?.data?.attributes?.status === 'completed') {
        report = analysis;
        break;
      }
    }
  }

  return report?.data || null;
}

/**
 * Look up a file by SHA-256 hash on VirusTotal.
 * Returns null if not found (never submitted).
 * @param {string} sha256
 * @param {string} apiKey
 */
async function getFileReport(sha256, apiKey) {
  const result = await vtRequest('GET', `/api/v3/files/${sha256}`, apiKey);
  return result?.data || null;
}

module.exports = { scanUrl, getFileReport, getFileSha256 };
