const { Client, GatewayIntentBits } = require('discord.js');

let clientPromise = null;

/**
 * Logs into Discord once and shares the same client across the whole app
 * (discordManager, webhookSender, commandHandler all use this).
 */
function getClient(config) {
  if (clientPromise) return clientPromise;

  clientPromise = new Promise((resolve, reject) => {
    if (!config.discordToken) {
      return reject(new Error('discordToken missing in config.json'));
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', () => resolve(client));
    client.once('error', (err) => reject(err));

    // Errors that happen AFTER the client is already ready won't be caught
    // by the .once() above (it only fires for the very first error), so we
    // also log them here instead of letting them disappear silently.
    client.on('error', (err) => {
      console.error('[discordClient] Discord client error:', err.message);
    });

    client.login(config.discordToken).catch(reject);
  });

  clientPromise.catch(() => {
    clientPromise = null;
  });

  return clientPromise;
}

module.exports = { getClient };
