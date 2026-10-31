'use strict';

const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { handleInteractionError } = require('../utils/errors');
const { runCommand, globalGate, reply } = require('../services/commandRunner');

async function handleCommand(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    await reply(interaction, 'That command is not available right now.');
    return;
  }
  await runCommand(interaction, client, command);
}

async function handleAutocomplete(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (!command || typeof command.autocomplete !== 'function') return;
  try {
    await command.autocomplete(interaction, client);
  } catch (err) {
    logger.warn(`Autocomplete failed for /${interaction.commandName}:`, err.message);
    if (!interaction.responded) await interaction.respond([]).catch(() => {});
  }
}

async function handleComponent(interaction, client) {
  const id = String(interaction.customId);
  if (id.startsWith('~')) return; // collector-owned component
  const [prefix, ...args] = id.split(':');
  const handler = client.components.get(prefix);
  if (!handler) {
    await reply(interaction, 'This control is no longer active.');
    return;
  }
  if (!(await globalGate(interaction, client))) return;
  await handler(interaction, args, client);
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    try {
      if (interaction.isAutocomplete()) return await handleAutocomplete(interaction, client);
      if (interaction.isChatInputCommand()) return await handleCommand(interaction, client);
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        return await handleComponent(interaction, client);
      }
    } catch (err) {
      await handleInteractionError(interaction, err);
    }
    return undefined;
  },
};
