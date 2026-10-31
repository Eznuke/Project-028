'use strict';

const crypto = require('node:crypto');
const { MessageFlags } = require('discord.js');
const logger = require('./logger');
const embeds = require('./embeds');

/** An error whose message is safe and useful to show directly to the user. */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

// Discord API error codes we can explain in plain language.
const API_MESSAGES = {
  50001: 'I do not have access to that.',
  50007: 'I could not send a direct message to that user (their DMs are closed).',
  50013: 'I am missing the permissions needed to do that. Check my role permissions and role position.',
  50035: 'Discord rejected some of the input. Please check the values and try again.',
  10003: 'That channel no longer exists.',
  10008: 'That message no longer exists.',
  10011: 'That role no longer exists.',
  10013: 'That user no longer exists.',
  10026: 'That ban does not exist.',
};

/** Sends or edits a reply no matter which state the interaction is in. */
async function safeReply(interaction, payload) {
  const data = { ...payload };
  if (data.ephemeral) {
    data.flags = (data.flags ?? 0) | MessageFlags.Ephemeral;
    delete data.ephemeral;
  }
  try {
    if (interaction.deferred && !interaction.replied) {
      // The visibility of a deferred reply was fixed by deferReply(); editReply cannot change it.
      delete data.flags;
      return await interaction.editReply(data);
    }
    if (interaction.replied || interaction.deferred) {
      const followUp = { ...data };
      return await interaction.followUp(followUp);
    }
    return await interaction.reply(data);
  } catch (err) {
    // 10062 = unknown interaction (expired), 40060 = already acknowledged
    if (err?.code === 10062 || err?.code === 40060) {
      logger.debug('Could not reply to interaction:', err.code);
      return null;
    }
    throw err;
  }
}

/** Central error handler for any interaction. Never leaks stack traces to Discord. */
async function handleInteractionError(interaction, err) {
  try {
    if (err instanceof UserError) {
      await safeReply(interaction, { embeds: [embeds.error(err.message)], ephemeral: true });
      return;
    }

    if (err && typeof err.code === 'number' && API_MESSAGES[err.code]) {
      logger.warn(`Discord API error ${err.code} in ${describe(interaction)}: ${err.message}`);
      await safeReply(interaction, { embeds: [embeds.error(API_MESSAGES[err.code])], ephemeral: true });
      return;
    }

    if (err?.code === 10062) {
      logger.warn(`Interaction expired before reply (${describe(interaction)}).`);
      return;
    }

    const ref = crypto.randomBytes(3).toString('hex');
    logger.error(`[ref ${ref}] Unhandled error in ${describe(interaction)}:`, err);
    await safeReply(interaction, {
      embeds: [embeds.error(`Something went wrong. If it keeps happening, tell the bot owner this reference: \`${ref}\``)],
      ephemeral: true,
    });
  } catch (inner) {
    logger.error('Error handler itself failed:', inner);
  }
}

function describe(interaction) {
  if (interaction.isChatInputCommand?.()) return `/${interaction.commandName}`;
  if (interaction.customId) return `component ${String(interaction.customId).split(':')[0]}`;
  return 'interaction';
}

module.exports = { UserError, safeReply, handleInteractionError };
