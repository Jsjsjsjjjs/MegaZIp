// Matches mega.nz AND mega.co.nz (legacy domain), both modern /file/id#key format
// and the legacy #!id!key / #F!id!key format.
const MEGA_LINK_REGEX =
  /https?:\/\/mega(?:\.co)?\.nz\/(?:file|folder)\/[a-zA-Z0-9_-]+#[a-zA-Z0-9_!-]+|https?:\/\/mega(?:\.co)?\.nz\/#(?:F!|!)[a-zA-Z0-9_-]+![a-zA-Z0-9_-]+/gi;

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
 * Collects all text from a Discord embed into one searchable string.
 * Covers: title, description, url, all field values, footer text, author name/url.
 * @param {import('discord.js').MessageEmbed} embed
 * @returns {string}
 */
function flattenEmbed(embed) {
  const parts = [];
  if (embed.title)       parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  if (embed.url)         parts.push(embed.url);
  if (embed.author) {
    if (embed.author.name) parts.push(embed.author.name);
    if (embed.author.url)  parts.push(embed.author.url);
  }
  if (embed.footer && embed.footer.text) parts.push(embed.footer.text);
  if (Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      if (field.name)  parts.push(field.name);
      if (field.value) parts.push(field.value);
    }
  }
  return parts.join(' ');
}

/**
 * Extracts every candidate download job from a single Discord message.
 * Scans both the plain message text AND all embeds attached to the message.
 * Returns [] if no valid MEGA link (with decryption key) is found anywhere.
 *
 * @param {import('discord.js').Message} message
 * @returns {Array<{link: string, password: string|null, suggestedName: string|null, sourceMessageId: string, sourceChannelId: string}>}
 */
function extractJobsFromMessage(message) {
  const content   = message.content || '';
  const allLinks  = new Set(extractMegaLinks(content));
  const allText   = [content];

  // Also scan every embed attached to this message
  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      const embedText = flattenEmbed(embed);
      if (embedText) {
        allText.push(embedText);
        for (const link of extractMegaLinks(embedText)) allLinks.add(link);
      }
    }
  }

  if (allLinks.size === 0) return [];

  // Try to find a password and a suggested name from all available text combined
  const combinedText = allText.join(' ');
  const password     = extractPassword(combinedText);
  const suggestedName = extractSuggestedName(combinedText);

  return [...allLinks].map((link) => ({
    link,
    password,
    suggestedName,
    sourceMessageId:  message.id,
    sourceChannelId:  message.channelId,
  }));
}

module.exports = { extractMegaLinks, extractPassword, extractSuggestedName, flattenEmbed, extractJobsFromMessage };
