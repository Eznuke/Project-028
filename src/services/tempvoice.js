'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, OverwriteType,
} = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { fill, truncate } = require('../utils/text');
const { checkCooldown } = require('../utils/ratelimit');

const P = PermissionFlagsBits;
const creating = new Set(); // user IDs whose room is being created right now
const warned = new Map(); // guild -> last time a setup problem was logged

const cfgOf = (guildId) => settings.view(guildId).tempVoice;
const getRoom = (channelId) => db.get('SELECT * FROM temp_voice WHERE channel_id = ?', channelId);
const roomCount = (guildId) => db.get('SELECT COUNT(*) AS n FROM temp_voice WHERE guild_id = ?', guildId).n;
const humansIn = (channel) => channel.members.filter((m) => !m.user.bot);

/** Room names come from user-controlled text: one line, no mentions, 1-100 characters. */
function cleanName(text, fallback = 'Voice room') {
  const name = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
  return truncate(name, 100, '') || fallback;
}

/** Setup problems an admin should fix, as readable lines (empty = fine). */
function problems(guild) {
  const cfg = cfgOf(guild.id);
  const out = [];
  const me = guild.members.me;
  const lobby = cfg.lobbyChannelId ? guild.channels.cache.get(cfg.lobbyChannelId) : null;
  if (cfg.enabled && !lobby) out.push('Pick a **lobby** voice channel with `lobby:`; members join it to get a room.');
  if (cfg.lobbyChannelId && !lobby) out.push('The lobby channel no longer exists.');
  if (cfg.categoryId && !guild.channels.cache.get(cfg.categoryId)) out.push('The room category no longer exists.');
  if (!me.permissions.has([P.ManageChannels, P.MoveMembers])) out.push('I need the **Manage Channels** and **Move Members** permissions.');
  const place = (cfg.categoryId && guild.channels.cache.get(cfg.categoryId)) || lobby?.parent;
  if (place && !place.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.Connect])) {
    out.push(`I need View Channel, Connect and Manage Channels in **${place.name}**.`);
  }
  return out;
}

// ---- control panel -------------------------------------------------------------------------

function isLocked(channel) { return !channel.permissionsFor(channel.guild.roles.everyone)?.has(P.Connect); }
function isHidden(channel) { return !channel.permissionsFor(channel.guild.roles.everyone)?.has(P.ViewChannel); }

/** `state` overrides what is read from the (possibly not yet refreshed) channel cache right after a change. */
function panel(channel, ownerId, state = {}) {
  const locked = state.locked ?? isLocked(channel);
  const hidden = state.hidden ?? isHidden(channel);
  const limit = state.limit ?? channel.userLimit;
  const embed = embeds.base('🎙️ Your voice room', [
    `Owner: <@${ownerId}>`,
    `Status: ${locked ? '🔒 locked' : '🔓 open'} · ${hidden ? '🙈 hidden' : '👁️ visible'} · limit ${limit || '∞'}`,
    '',
    'Only the owner can use these controls. The room is deleted when everyone has left.',
  ].join('\n'));
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tv:lock').setLabel(locked ? 'Unlock' : 'Lock').setEmoji(locked ? '🔓' : '🔒').setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv:hide').setLabel(hidden ? 'Show' : 'Hide').setEmoji(hidden ? '👁️' : '🙈').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tv:rename').setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tv:limit').setLabel('Limit').setEmoji('👥').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tv:claim').setLabel('Claim').setEmoji('👑').setStyle(ButtonStyle.Secondary),
  );
  const kick = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('tv:kick').setPlaceholder('Kick and block someone from this room').setMinValues(1).setMaxValues(1),
  );
  const transfer = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId('tv:transfer').setPlaceholder('Give the room to someone else').setMinValues(1).setMaxValues(1),
  );
  return { embeds: [embed], components: [row1, kick, transfer], allowedMentions: { parse: [] } };
}

// ---- rooms ----------------------------------------------------------------------------------

async function createRoom(member, cfg) {
  const guild = member.guild;
  const me = guild.members.me;
  const lobby = guild.channels.cache.get(cfg.lobbyChannelId);
  if (!lobby) return;

  const issues = problems(guild);
  if (issues.length) {
    if (Date.now() - (warned.get(guild.id) ?? 0) > 10 * 60_000) {
      warned.set(guild.id, Date.now());
      logger.warn(`Temporary voice is misconfigured in ${guild.name}: ${issues.join(' ')}`);
    }
    return;
  }
  if (roomCount(guild.id) >= cfg.maxRooms) return;
  if (checkCooldown('tv-create', member.id, 5) > 0 || creating.has(member.id)) return;
  creating.add(member.id);

  let channel = null;
  try {
    const parent = (cfg.categoryId && guild.channels.cache.get(cfg.categoryId)) || lobby.parent || null;
    const name = cleanName(fill(cfg.nameTemplate, { user: member.displayName, username: member.user.username, count: roomCount(guild.id) + 1 }), `${member.displayName}'s room`);
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parent?.id ?? null,
      userLimit: cfg.defaultLimit || 0,
      bitrate: Math.min(lobby.bitrate ?? 64000, guild.maximumBitrate ?? 96000),
      reason: `Temporary room for ${member.user.tag}`,
    });
    db.run('INSERT INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)', channel.id, guild.id, member.id, Date.now());
    // The owner can always see, join and speak in their own room (even when it is locked or hidden).
    await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, Connect: true, Speak: true }, { type: OverwriteType.Member });
    await member.voice.setChannel(channel, 'Moved to their temporary room');
    const sent = await channel.send(panel(channel, member.id)).catch((err) => { logger.debug('Could not post the room panel:', err.message); return null; });
    if (sent) db.run('UPDATE temp_voice SET panel_message_id = ? WHERE channel_id = ?', sent.id, channel.id);
  } catch (err) {
    logger.warn(`Could not create a temporary room for ${member.user.tag}: ${err.message}`);
    if (channel) await removeRoom(channel, 'creation failed');
  } finally {
    creating.delete(member.id);
  }
}

/** Deletes a room channel and its record. Never throws. */
async function removeRoom(channel, reason) {
  db.run('DELETE FROM temp_voice WHERE channel_id = ?', channel.id);
  await channel.delete(`Temporary room: ${reason}`).catch((err) => logger.debug('Could not delete temporary room:', err.message));
}

/** Deletes the channel when nobody (but bots) is left. */
async function cleanupIfEmpty(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice || !getRoom(channel.id)) return;
  if (humansIn(channel).size === 0) await removeRoom(channel, 'empty');
}

module.exports = { cfgOf, getRoom, roomCount, humansIn, cleanName, problems, panel, isLocked, isHidden, createRoom, removeRoom, cleanupIfEmpty };
