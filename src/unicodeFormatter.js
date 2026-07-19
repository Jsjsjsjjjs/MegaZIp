/**
 * Converts a plain ASCII string into Unicode "Mathematical Bold" style
 * characters (e.g. "leak" -> "𝐥𝐞𝐚𝐤"). These are distinct Unicode code
 * points outside the normal Latin alphabet block, so Discord's channel-name
 * normalization (which lowercases/strips plain Latin letters) generally
 * leaves them untouched.
 *
 * NOTE: Discord's rules can change without notice — always test a real
 * channel creation after making changes here.
 */

const UPPER_BASE = 0x1d400; // MATHEMATICAL BOLD CAPITAL A
const LOWER_BASE = 0x1d41a; // MATHEMATICAL BOLD SMALL A
const DIGIT_BASE = 0x1d7ce; // MATHEMATICAL BOLD DIGIT ZERO

const MAX_CHANNEL_NAME_LENGTH = 100; // Discord's hard limit

/**
 * Truncates a string to at most `maxLength` *code points* (not raw UTF-16
 * units). A plain `str.slice(0, n)` can cut a surrogate pair in half —
 * our bold Unicode letters and any emoji in the template are all outside
 * the Basic Multilingual Plane, so a naive slice risks producing a
 * corrupted/unpaired character right at the cutoff.
 */
function safeTruncate(str, maxLength) {
  if (str.length <= maxLength) return str; // fast path, definitely short enough
  const codePoints = Array.from(str); // splits by code point, respects surrogate pairs
  if (codePoints.length <= maxLength) return str;
  return codePoints.slice(0, maxLength).join('');
}

function toStylizedBold(text) {
  if (!text) return text;

  let result = '';

  for (const ch of text) {
    const code = ch.codePointAt(0);

    if (code >= 65 && code <= 90) {
      // A-Z
      result += String.fromCodePoint(UPPER_BASE + (code - 65));
    } else if (code >= 97 && code <= 122) {
      // a-z
      result += String.fromCodePoint(LOWER_BASE + (code - 97));
    } else if (code >= 48 && code <= 57) {
      // 0-9
      result += String.fromCodePoint(DIGIT_BASE + (code - 48));
    } else if (ch === ' ' || ch === '_') {
      result += '-'; // Discord channel names conventionally use hyphens, not spaces
    } else if (ch === '-' || ch === '.') {
      result += ch; // keep harmless separators as-is
    }
    // any other character (emoji, symbols, etc.) is dropped to keep the
    // channel name safe/predictable
  }

  if (result.length === 0) {
    // Fallback: if literally nothing survived formatting, use the original text
    result = text;
  }

  if (result.length > MAX_CHANNEL_NAME_LENGTH) {
    result = safeTruncate(result, MAX_CHANNEL_NAME_LENGTH);
  }

  return result;
}

function buildChannelName(zipBaseName, config = {}) {
  // Normalize spaces/underscores to hyphens (Discord channel naming convention)
  let name = zipBaseName.replace(/[\s_]+/g, '-');

  if (config.channelNameBoldStyle) {
    name = toStylizedBold(name);
  }

  // Wrap in a decorative template, e.g. "『🎐』|{name}" -> "『🎐』|My-Zip"
  const template = config.channelNameTemplate || '{name}';
  let fullName = template.replace('{name}', name);

  if (fullName.length > MAX_CHANNEL_NAME_LENGTH) {
    fullName = safeTruncate(fullName, MAX_CHANNEL_NAME_LENGTH);
  }

  return fullName;
}

module.exports = { toStylizedBold, buildChannelName };
