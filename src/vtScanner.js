'use strict';

/**
 * VirusTotal v3 API integration.
 * - Uploads a file (≤ 650 MB) and returns the analysis result.
 * - Falls back gracefully if no API key is configured.
 *
 * Requires env var: VIRUSTOTAL_API_KEY
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const VT_API_KEY = () => process.env.VIRUSTOTAL_API_KEY || '';

// ── Tiny HTTP helper (no axios/node-fetch dependency) ─────────────────────────
function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Multipart form upload helper ──────────────────────────────────────────────
function uploadFileVT(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const boundary = `----VTBoundary${Date.now()}`;

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body   = Buffer.concat([header, fileData, footer]);

    const options = {
      method: 'POST',
      headers: {
        'x-apikey': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Accept': 'application/json',
      },
    };

    const req = https.request('https://www.virustotal.com/api/v3/files', options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Poll analysis result ───────────────────────────────────────────────────────
async function pollAnalysis(analysisId, apiKey, maxWaitMs = 120_000) {
  const url = `https://www.virustotal.com/api/v3/analyses/${analysisId}`;
  const opts = {
    method: 'GET',
    headers: { 'x-apikey': apiKey, 'Accept': 'application/json' },
  };

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000)); // poll every 15s
    const res = await httpRequest(url, opts);
    if (res.status !== 200) continue;
    const status = res.body?.data?.attributes?.status;
    if (status === 'completed') return res.body;
  }
  return null; // timed out
}

/**
 * Scans a local file with VirusTotal.
 * @param {string} filePath - absolute path to file
 * @returns {Promise<{malicious:number, suspicious:number, undetected:number, total:number, analysisUrl:string, sha256:string}|null>}
 */
async function scanFile(filePath) {
  const apiKey = VT_API_KEY();
  if (!apiKey) return null;

  // 1. Upload
  const uploadRes = await uploadFileVT(filePath, apiKey);
  if (uploadRes.status !== 200) {
    throw new Error(`VT upload failed (HTTP ${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
  }

  const analysisId = uploadRes.body?.data?.id;
  if (!analysisId) throw new Error('VT returned no analysis ID');

  // 2. Poll
  const result = await pollAnalysis(analysisId, apiKey);
  if (!result) throw new Error('VT analysis timed out (2 minutes)');

  const stats = result.data?.attributes?.stats || {};
  const sha256 = result.meta?.file_info?.sha256 || '';

  return {
    malicious:  stats.malicious  || 0,
    suspicious: stats.suspicious || 0,
    undetected: stats.undetected || 0,
    total:      (stats.malicious || 0) + (stats.suspicious || 0) + (stats.undetected || 0) + (stats.harmless || 0) + (stats.failure || 0),
    analysisUrl: `https://www.virustotal.com/gui/file/${sha256}`,
    sha256,
  };
}

/**
 * Scan a file by SHA-256 hash (avoids re-upload if already known to VT).
 * Returns null if VT has never seen it.
 */
async function checkHashVT(sha256) {
  const apiKey = VT_API_KEY();
  if (!apiKey || !sha256) return null;

  const res = await httpRequest(
    `https://www.virustotal.com/api/v3/files/${sha256}`,
    { method: 'GET', headers: { 'x-apikey': apiKey, 'Accept': 'application/json' } }
  );
  if (res.status !== 200) return null;
  const stats = res.body?.data?.attributes?.last_analysis_stats || {};
  return {
    malicious:   stats.malicious  || 0,
    suspicious:  stats.suspicious || 0,
    undetected:  stats.undetected || 0,
    total:       Object.values(stats).reduce((a, v) => a + v, 0),
    analysisUrl: `https://www.virustotal.com/gui/file/${sha256}`,
    sha256,
  };
}

module.exports = { scanFile, checkHashVT };
