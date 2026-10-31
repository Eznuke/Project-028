'use strict';

const { MessageFlags } = require('discord.js');
const db = require('../database');
const config = require('../config');
const embeds = require('../utils/embeds');
const { safeReply } = require('../utils/errors');
const { checkCooldown, resetCooldown, checkGlobal } = require('../utils/ratelimit');
const { permissionNames } = require('../utils/permissions');

const reply = (interaction, description) =>
  safeReply(interaction, { embeds: [embeds.error(description)], flags: MessageFlags.Ephemeral });

/**
 * Checks that apply to every interaction type: blacklist, maintenance, global rate limit.
 * Returns true when the interaction may continue. Chat (prefix) commands from blacklisted users are
 * ignored silently so a blocked user cannot make the bot spam a channel.
 */
async function globalGate(interaction, client) {
  const userId = interaction.user.id;
  if (config.isOwner(userId)) return true;

  const banned = db.get('SELECT reason FROM blacklist WHERE user_id = ?', userId);
  if (banned) {
    if (!interaction.isPrefixCommand) await reply(interaction, 'You are not allowed to use this bot.');
    return false;
  }
  if (client.maintenance) {
    await reply(interaction, '🛠️ The bot is in maintenance mode. Please try again later.');
    return false;
  }
  const wait = checkGlobal(userId, config.globalRateLimit);
  if (wait > 0) {
    await reply(interaction, `You are going too fast. Try again in ${Math.ceil(wait / 1000)}s.`);
    return false;
  }
  return true;
}

/**
 * Runs one command for either a slash interaction or a chat-prefix invocation (same checks, same code).
 * `prepare` (chat commands only) parses the typed arguments after the permission checks and before the
 * cooldown starts, so a typo never costs the user a cooldown.
 */
async function runCommand(interaction, client, command, { prepare } = {}) {
  if (!(await globalGate(interaction, client))) return;

  if (command.ownerOnly && !config.isOwner(interaction.user.id)) {
    await reply(interaction, 'Only the bot owner can use this command.');
    return;
  }

  if (command.guildOnly && !interaction.inGuild()) {
    await reply(interaction, 'This command can only be used inside a server.');
    return;
  }

  // Server-side permission validation (never rely on Discord's UI-only defaults).
  if (command.userPermissions?.length && interaction.inGuild()) {
    const have = interaction.memberPermissions;
    const missing = command.userPermissions.filter((p) => !have?.has(p));
    if (missing.length) {
      const bits = missing.reduce((a, b) => a | b, 0n);
      await reply(interaction, `You need these permissions: **${permissionNames(bits).join(', ')}**.`);
      return;
    }
  }
  if (command.botPermissions?.length && interaction.inGuild()) {
    const have = interaction.appPermissions;
    const missing = command.botPermissions.filter((p) => !have?.has(p));
    if (missing.length) {
      const bits = missing.reduce((a, b) => a | b, 0n);
      await reply(interaction, `I need these permissions in this channel: **${permissionNames(bits).join(', ')}**.`);
      return;
    }
  }

  if (prepare) await prepare();

  if (!config.isOwner(interaction.user.id)) {
    const wait = checkCooldown(command.data.name, interaction.user.id, command.cooldown);
    if (wait > 0) {
      await reply(interaction, `Please wait ${(wait / 1000).toFixed(1)}s before using \`${command.data.name}\` again.`);
      return;
    }
  }

  db.run(
    'INSERT INTO command_usage (name, count) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET count = count + 1',
    command.data.name,
  );
  client.stats.commandsRun += 1;

  await command.execute(interaction, client);
}

module.exports = { runCommand, globalGate, reply, resetCooldown };
