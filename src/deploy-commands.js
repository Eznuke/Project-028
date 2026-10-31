'use strict';

/**
 * Registers slash commands with Discord.
 *   npm run deploy          -> global commands (can take up to an hour to appear everywhere)
 *   npm run deploy:guild    -> only in GUILD_ID (instant, great for testing)
 *   npm run deploy:clear    -> removes all commands (add --guild to clear the test server)
 */
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const { loadCommands } = require('./utils/loader');

async function main() {
  const args = new Set(process.argv.slice(2));
  const useGuild = args.has('--guild');
  const clear = args.has('--clear');

  const problems = config.validate({ needToken: true }).filter((p) => !p.startsWith('OWNER_ID'));
  if (problems.length) {
    logger.error('Configuration problems:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  if (useGuild && !config.guildId) {
    logger.error('--guild needs GUILD_ID in your .env file.');
    process.exit(1);
  }

  const route = useGuild
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);
  const scope = useGuild ? `server ${config.guildId}` : 'GLOBAL scope';
  const rest = new REST({ version: '10' }).setToken(config.token);

  if (clear) {
    await rest.put(route, { body: [] });
    logger.info(`Removed all commands from ${scope}.`);
    return;
  }

  const commands = loadCommands(path.join(__dirname, 'commands'));
  const body = [...commands.values()].map((c) => c.data.toJSON());

  // Validate before talking to Discord.
  if (body.length > 100) {
    throw new Error(`Discord allows 100 slash commands per scope; this project has ${body.length}.`);
  }
  const names = new Set();
  for (const c of body) {
    if (names.has(c.name)) throw new Error(`Duplicate command name: ${c.name}`);
    names.add(c.name);
    if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(c.name) || c.name !== c.name.toLowerCase()) {
      throw new Error(`Invalid command name: "${c.name}" (lowercase, 1-32 chars, letters/numbers/-/_).`);
    }
    if (!c.description || c.description.length > 100) {
      throw new Error(`Command /${c.name} needs a description of 1-100 characters.`);
    }
  }

  logger.info(`Registering ${body.length} commands in ${scope}…`);
  const result = await rest.put(route, { body });
  logger.info(`Done. Discord now knows ${result.length} commands.`);
  if (!useGuild) logger.info('Global commands can take a while to appear. Use deploy:guild while testing.');
}

main().catch((err) => {
  logger.error('Deploy failed:', err.rawError ? JSON.stringify(err.rawError) : err);
  process.exit(1);
});
