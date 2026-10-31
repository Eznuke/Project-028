'use strict';

// Node prints an "ExperimentalWarning" for node:sqlite on some versions. It is stable enough
// for this bot, so hide only that one warning and keep every other warning visible.
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/sqlite/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...args);
};

const path = require('node:path');
const { Client, GatewayIntentBits, Partials, Options } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const db = require('./database');
const { loadCommands, loadComponents, loadEvents } = require('./utils/loader');
const scheduler = require('./services/scheduler');

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  logger.error(`Node.js 22.13 or newer is required (found ${process.version}). In Termux run: pkg upgrade nodejs`);
  process.exit(1);
}

const problems = config.validate({ needToken: true });
if (problems.length) {
  logger.error('Configuration problems:\n - ' + problems.join('\n - '));
  logger.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

db.open();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: welcome, autorole, anti-raid, logs
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: leveling, automod, AI chat, AFK
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: ['users'], repliedUser: false },
  // Keep memory low on phones / small hosts.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 100,
    ReactionManager: 0,
    PresenceManager: 0,
    GuildScheduledEventManager: 0,
  }),
});

client.config = config;
client.db = db;
client.maintenance = db.getMeta('maintenance', '0') === '1';
client.stats = { commandsRun: 0, readyAt: null, messagesSeen: 0 };

client.commands = loadCommands(path.join(__dirname, 'commands'));
client.components = loadComponents(path.join(__dirname, 'components'), client.commands);
const eventCount = loadEvents(client, path.join(__dirname, 'events'));
logger.info(`Loaded ${client.commands.size} commands, ${client.components.size} component handlers, ${eventCount} event listeners.`);

client.on('error', (err) => logger.error('Client error:', err));
client.on('warn', (msg) => logger.warn('Client warning:', msg));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref?.();
  try {
    scheduler.stop();
    try { require('./services/music').shutdownAll(); } catch { /* music module not in use */ }
    await client.destroy();
  } catch (err) {
    logger.error('Error while shutting down the client:', err);
  }
  db.close();
  logger.info('Goodbye.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Never crash because of one failed promise; log it (tokens are redacted by the logger).
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

client.login(config.token).catch((err) => {
  logger.error('Login failed. Check DISCORD_TOKEN and that the privileged intents are enabled in the Developer Portal.');
  logger.error(err.message);
  db.close();
  process.exit(1);
});
