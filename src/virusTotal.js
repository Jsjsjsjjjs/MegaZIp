'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Computes the SHA-256 hash of a file on disk.
 * @param {string} filePath 
 * @returns {Promise<string>}
 */
function getFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Helper to make HTTPS requests to the VirusTotal API v3.
 */
function vtRequest(endpoint, method, apiKey, postData = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.virustotal.com',
      path: endpoint,
      method: method,
      headers: {
        'x-apikey': apiKey,
        'accept': 'application/json',
      }
    };

    if (postData) {
      options.headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response from VirusTotal'));
          }
        } else {
          try {
            const parsed = JSON.parse(data);
            reject(new Error(parsed.error?.message || `VirusTotal HTTP Error ${res.statusCode}`));
          } catch {
            reject(new Error(`VirusTotal HTTP Error ${res.statusCode}`));
          }
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Retrieves report for a file SHA-256 hash.
 */
async function getFileReport(hash, apiKey) {
  try {
    const res = await vtRequest(`/api/v3/files/${hash}`, 'GET', apiKey);
    return res.data;
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('404')) {
      return null; // Not scanned yet
    }
    throw err;
  }
}

/**
 * Submits a URL for scanning and returns the analysis object.
 */
async function scanUrl(url, apiKey) {
  // Convert URL to Base64 (without padding, as VT API v3 expects)
  const urlId = Buffer.from(url).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  try {
    const res = await vtRequest(`/api/v3/urls/${urlId}`, 'GET', apiKey);
    return res.data;
  } catch (err) {
    // If not found, submit for analysis
    if (err.message.includes('not found') || err.message.includes('404')) {
      const submit = await vtRequest('/api/v3/urls', 'POST', apiKey, `url=${encodeURIComponent(url)}`);
      const analysisId = submit.data?.id;
      // Wait 3 seconds for analysis to run
      await new Promise(resolve => setTimeout(resolve, 3000));
      const report = await vtRequest(`/api/v3/analyses/${analysisId}`, 'GET', apiKey);
      return report.data;
    }
    throw err;
  }
}

module.exports = {
  getFileSha256,
  getFileReport,
  scanUrl,
};
