'use strict';

const { PermissionFlagsBits } = require('discord.js');
const settings = require('./settings');
const logger = require('../utils/logger');

/**
 * Sends an embed to the configured log channel of a category
 * (messages, members, roles, channels, voice, moderation, tickets).
 * Returns the sent message, or null when logging is off / not possible.
 * It never throws, and it never pings anyone.
 */
async function send(guild, category, embed, extra = {}) {
  try {
    const cfg = settings.view(guild.id).logs;
    if (cfg.enabled[category] === false) return null;
    const channelId = cfg.channels[category];
    if (!channelId) return null;

    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return null;

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      logger.debug(`Cannot write to log channel ${channelId} in guild ${guild.id} (missing permissions).`);
      return null;
    }

    return await channel.send({ embeds: [embed], allowedMentions: { parse: [] }, ...extra });
  } catch (err) {
    logger.warn(`Logging to ${category} failed in guild ${guild.id}: ${err.message}`);
    return null;
  }
}

/** Whether messages in this channel should be ignored by message logs. */
function isIgnoredChannel(guildId, channelId) {
  return settings.view(guildId).logs.ignoredChannelIds.includes(channelId);
}

module.exports = { send, isIgnoredChannel };
