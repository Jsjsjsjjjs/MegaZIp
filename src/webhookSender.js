/**
 * webhookSender.js
 *
 * Sends ZIP delivery messages via a webhook.
 * Supports two modes:
 *   - Plain text (config.advancedTemplate.useEmbed = false) — uses config.messageTemplate
 *   - Embed (config.advancedTemplate.useEmbed = true)       — builds a rich Discord embed
 */

async function getOrCreateWebhook(channel) {
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((wh) => wh.name === 'ZipBot Delivery');

  if (!webhook) {
    webhook = await channel.createWebhook({ name: 'ZipBot Delivery' });
  }

  return webhook;
}

function applyTemplate(template, { name, link, password }) {
  return template
    .replace(/{name}/g, name ?? '')
    .replace(/{link}/g, link ?? '')
    .replace(/{password}/g, password ?? '');
}

/**
 * Builds a Discord embed object from config.advancedTemplate.
 */
function buildEmbed(vars, advancedTemplate) {
  const at = advancedTemplate || {};
  const embed = {
    color: at.color ?? 5814783,
    title: at.title ? applyTemplate(at.title, vars) : vars.name,
    description: at.description ? applyTemplate(at.description, vars) : `🔗 ${vars.link}\n🔑 ${vars.password}`,
  };

  if (at.authorName || at.authorIconUrl) {
    embed.author = {};
    if (at.authorName) embed.author.name = applyTemplate(at.authorName, vars);
    if (at.authorIconUrl) embed.author.icon_url = at.authorIconUrl;
  }
  if (at.thumbnailUrl) embed.thumbnail = { url: at.thumbnailUrl };
  if (at.imageUrl)     embed.image     = { url: at.imageUrl };
  if (at.footerText || at.footerIconUrl) {
    embed.footer = {};
    if (at.footerText)    embed.footer.text     = applyTemplate(at.footerText, vars);
    if (at.footerIconUrl) embed.footer.icon_url = at.footerIconUrl;
  }

  embed.timestamp = new Date().toISOString();

  return embed;
}

/**
 * Sends the zip name/link/password message into `channel` via a webhook.
 * Returns the sent message object so callers can record the message ID.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {{ name: string, link: string, password: string }} vars
 * @param {object} config
 * @returns {Promise<import('discord.js').Message>}
 */
async function sendZipMessage(channel, vars, config) {
  const webhook = await getOrCreateWebhook(channel);

  const useEmbed = config.advancedTemplate && config.advancedTemplate.useEmbed;

  let message;
  if (useEmbed) {
    const embed = buildEmbed(vars, config.advancedTemplate);
    message = await webhook.send({ embeds: [embed] });
  } else {
    const content = applyTemplate(config.messageTemplate, vars);
    message = await webhook.send({ content });
  }

  return message;
}

/**
 * Edits an already-posted webhook message to the advanced embed format.
 * Used by the /updateposts command.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {string} messageId
 * @param {{ name: string, link: string, password: string }} vars
 * @param {object} config
 */
async function editZipMessage(channel, messageId, vars, config) {
  const webhook = await getOrCreateWebhook(channel);
  const useEmbed = config.advancedTemplate && config.advancedTemplate.useEmbed;

  if (useEmbed) {
    const embed = buildEmbed(vars, config.advancedTemplate);
    await webhook.editMessage(messageId, { embeds: [embed], content: '' });
  } else {
    const content = applyTemplate(config.messageTemplate, vars);
    await webhook.editMessage(messageId, { content, embeds: [] });
  }
}

module.exports = { sendZipMessage, editZipMessage, applyTemplate, buildEmbed };
