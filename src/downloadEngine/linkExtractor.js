// Matches both current MEGA URLs (mega.nz/file/xxx#key, mega.nz/folder/xxx#key)
// and the legacy format (mega.nz/#!xxx!key or mega.nz/#F!xxx!key).
const MEGA_LINK_REGEX =
  /https?:\/\/mega\.nz\/(?:file|folder)\/[a-zA-Z0-9_-]+#[a-zA-Z0-9_!-]+|https?:\/\/mega\.nz\/#(?:F!|!)[a-zA-Z0-9_-]+![a-zA-Z0-9_-]+/gi;

// Looks for "password: xyz", "pass - xyz", "pwd: xyz", etc. The value is
// whatever non-whitespace token follows, optionally wrapped in ` or * (as
// our own message template produces, e.g. "🔑 Password: `abc123`").
const PASSWORD_REGEX = /(?:password|pass|pwd)\s*[:\-–]?\s*[`*_]*([^\s`*_]{3,64})/i;

// Our own webhook messages wrap the filename in **bold** markdown — reuse
// that same convention when reading messages back out.
const NAME_REGEX = /\*\*(.+?)\*\*/;

function extractMegaLinks(content) {
  if (!content) return [];
  const matches = content.match(MEGA_LINK_REGEX);
  return matches ? [...new Set(matches)] : []; // de-dupe within the same message
}

function extractPassword(content) {
  if (!content) return null;
  const match = content.match(PASSWORD_REGEX);
  return match ? match[1] : null;
}

function extractSuggestedName(content) {
  if (!content) return null;
  const match = content.match(NAME_REGEX);
  return match ? match[1].trim() : null;
}

/**
 * Extracts every candidate download job from a single Discord message.
 * Returns [] if the message has no valid MEGA link (per the requirement to
 * ignore anything without one).
 *
 * @param {import('discord.js').Message} message
 * @returns {Array<{link: string, password: string|null, suggestedName: string|null, sourceMessageId: string, sourceChannelId: string}>}
 */
function extractJobsFromMessage(message) {
  const content = message.content || '';
  const links = extractMegaLinks(content);
  if (links.length === 0) return [];

  const password = extractPassword(content);
  const suggestedName = extractSuggestedName(content);

  return links.map((link) => ({
    link,
    password,
    suggestedName,
    sourceMessageId: message.id,
    sourceChannelId: message.channelId,
  }));
}

module.exports = { extractMegaLinks, extractPassword, extractSuggestedName, extractJobsFromMessage };
