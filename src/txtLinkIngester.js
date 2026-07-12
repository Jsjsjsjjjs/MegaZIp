/**
 * txtLinkIngester.js
 *
 * Reads a .txt file, extracts every MEGA link it contains, and returns each
 * as an ingestion job. Each link becomes its own Discord channel + message
 * (exactly like a ZIP file going through the pipeline) but skips the
 * encrypt + MEGA-upload steps since the link is already on MEGA.
 */

const fs = require('fs');

// Matches mega.nz URLs (file, folder, legacy #! / #F! formats)
const MEGA_LINK_REGEX =
  /https?:\/\/mega\.nz\/(?:file|folder)\/[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_!-]+)?|https?:\/\/mega\.nz\/#(?:F!|!)[a-zA-Z0-9_-]+(?:![a-zA-Z0-9_-]+)?/gi;

// Looks for "password: xxx" or "pass: xxx" near a link
const PASSWORD_REGEX = /(?:password|pass|pwd)\s*[:\-–]?\s*[`*_]*([^\s`*_]{3,64})/i;

/**
 * Parses a .txt file and returns an array of jobs.
 *
 * Line formats supported:
 *   https://mega.nz/file/xxx#key
 *   Name | https://mega.nz/file/xxx#key | password: abc123
 *   ToolName: https://mega.nz/file/xxx#key  pass: abc
 *   (bare link on a line by itself)
 *
 * @param {string} filePath - absolute path to the .txt file
 * @param {string} [defaultName] - fallback name if no name can be parsed from the line
 * @returns {Array<{ name: string, link: string, password: string|null }>}
 */
function parseTxtFile(filePath, defaultName) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const jobs = [];
  const seenLinks = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const links = trimmed.match(MEGA_LINK_REGEX);
    if (!links || links.length === 0) continue;

    // Password — look on the same line
    const pwMatch = trimmed.match(PASSWORD_REGEX);
    const password = pwMatch ? pwMatch[1] : null;

    // Name — text before the first link (stripped of trailing separators)
    const firstLinkIdx = trimmed.indexOf(links[0]);
    const beforeLink = trimmed.slice(0, firstLinkIdx).replace(/[\|:\-–]+\s*$/, '').trim();
    const name = beforeLink || defaultName || 'MegaLink';

    for (const link of links) {
      if (seenLinks.has(link)) continue;
      seenLinks.add(link);
      jobs.push({ name: sanitize(name), link, password });
    }
  }

  return jobs;
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);
}

module.exports = { parseTxtFile };
