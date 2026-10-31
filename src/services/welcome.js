'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const settings = require('./settings');
const logging = require('./logging');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { fill, memberPlaceholders, truncate } = require('../utils/text');
const { ts } = require('../utils/time');

/**
 * Builds the message payload for a welcome/goodbye configuration.
 * @param {'welcome'|'goodbye'} kind
 */
function render(kind, cfg, member) {
  const values = memberPlaceholders(member);
  const text = truncate(fill(cfg.message, values), 2000);
  if (!cfg.useEmbed) return { content: text, allowedMentions: { users: [member.id] } };

  const user = member.user;
  const e = new EmbedBuilder()
    .setColor(embeds.parseColor(cfg.color, kind === 'welcome' ? embeds.COLORS.success : embeds.COLORS.danger))
    .setTitle(truncate(fill(cfg.title, values), 256))
    .setDescription(text)
    .setTimestamp();
  if (cfg.showAvatar) e.setThumbnail(user.displayAvatarURL({ size: 256 }));
  if (cfg.imageUrl) e.setImage(cfg.imageUrl);
  // The mention sits in the description; also ping in content so the member gets a notification.
  return {
    content: kind === 'welcome' ? `<@${member.id}>` : undefined,
    embeds: [e],
    allowedMentions: { users: [member.id] },
  };
}

async function postTo(guild, channelId, payload) {
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return false;
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    logger.debug(`Cannot post welcome/goodbye in ${channelId} (missing permissions).`);
    return false;
  }
  await channel.send(payload);
  return true;
}

async function sendWelcome(member) {
  const cfg = settings.view(member.guild.id).welcome;
  if (!cfg.enabled) return;
  try {
    await postTo(member.guild, cfg.channelId, render('welcome', cfg, member));
  } catch (err) {
    logger.warn(`Welcome message failed in ${member.guild.id}: ${err.message}`);
  }
  if (cfg.dmEnabled && !member.user.bot) {
    try {
      await member.send({ content: truncate(fill(cfg.dmMessage, memberPlaceholders(member)), 2000) });
    } catch {
      /* DMs closed */
    }
  }
}

async function sendGoodbye(member) {
  const cfg = settings.view(member.guild.id).goodbye;
  if (!cfg.enabled || !member.user) return;
  try {
    await postTo(member.guild, cfg.channelId, render('goodbye', cfg, member));
  } catch (err) {
    logger.warn(`Goodbye message failed in ${member.guild.id}: ${err.message}`);
  }
}

/** Gives the configured automatic roles. Never assigns a role at or above the bot's top role. */
async function applyAutoroles(member) {
  const { guild } = member;
  const cfg = settings.view(guild.id).autorole;
  const ids = member.user.bot ? cfg.botRoleIds : cfg.roleIds;
  if (!ids.length) return;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return;

  const roles = ids
    .map((id) => guild.roles.cache.get(id))
    .filter((r) => r && !r.managed && r.id !== guild.id && r.position < me.roles.highest.position);
  if (roles.length === 0) return;
  try {
    await member.roles.add(roles, 'Automatic role');
  } catch (err) {
    logger.warn(`Autorole failed for ${member.id} in ${guild.id}: ${err.message}`);
  }
}

/** Join/leave entries for the "members" log category. */
function logJoin(member) {
  const e = new EmbedBuilder()
    .setColor(embeds.COLORS.success)
    .setTitle('📥 Member joined')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(`${member} (\`${member.id}\`)`)
    .addFields(
      { name: 'Account created', value: `${ts(member.user.createdTimestamp, 'F')} (${ts(member.user.createdTimestamp, 'R')})` },
      { name: 'Member count', value: String(member.guild.memberCount), inline: true },
    )
    .setTimestamp();
  return logging.send(member.guild, 'members', e);
}

function logLeave(member) {
  const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => r.toString()) ?? [];
  const e = new EmbedBuilder()
    .setColor(embeds.COLORS.danger)
    .setTitle('📤 Member left')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(`${member.user.username} (\`${member.id}\`)`)
    .addFields({ name: 'Member count', value: String(member.guild.memberCount), inline: true })
    .setTimestamp();
  if (member.joinedTimestamp) e.addFields({ name: 'Joined', value: ts(member.joinedTimestamp, 'R'), inline: true });
  if (roles.length) e.addFields({ name: 'Roles', value: truncate(roles.join(' '), 1000) });
  return logging.send(member.guild, 'members', e);
}

module.exports = { render, sendWelcome, sendGoodbye, applyAutoroles, logJoin, logLeave };
