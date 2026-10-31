'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');

/** Use as `flags: EPHEMERAL` for replies only the command user can see. */
const EPHEMERAL = MessageFlags.Ephemeral;

/**
 * A slash command that only exists inside servers.
 * @param {string} name
 * @param {string} description
 * @param {bigint|null} [permission] default member permission (hides the command from members without it)
 */
function guildCommand(name, description, permission = null) {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild);
  if (permission !== null) builder.setDefaultMemberPermissions(permission);
  return builder;
}

/** A slash command that also works in DMs with the bot. */
function anywhereCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);
}

module.exports = { guildCommand, anywhereCommand, EPHEMERAL };
