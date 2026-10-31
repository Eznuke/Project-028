'use strict';

const { Events, EmbedBuilder, ChannelType } = require('discord.js');
const logging = require('../services/logging');
const { COLORS } = require('../utils/embeds');
const { truncate } = require('../utils/text');
const { ts } = require('../utils/time');

/**
 * Server logs. Privacy: message content is truncated, attachments are listed by
 * name only, and bot/own messages are ignored.
 */
const channelKind = (type) =>
  ({
    [ChannelType.GuildText]: 'text',
    [ChannelType.GuildVoice]: 'voice',
    [ChannelType.GuildCategory]: 'category',
    [ChannelType.GuildAnnouncement]: 'announcement',
    [ChannelType.GuildStageVoice]: 'stage',
    [ChannelType.GuildForum]: 'forum',
  })[type] ?? 'channel';

const messageDelete = {
  name: Events.MessageDelete,
  async execute(message, client) {
    if (!message.guild || message.author?.bot || message.author?.id === client.user.id) return;
    if (logging.isIgnoredChannel(message.guild.id, message.channelId)) return;
    const e = new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle('🗑️ Message deleted')
      .addFields({ name: 'Channel', value: `<#${message.channelId}>`, inline: true });
    if (message.author) e.addFields({ name: 'Author', value: `${message.author} (${message.author.id})`, inline: true });
    e.addFields({
      name: 'Content',
      value: message.content ? truncate(message.content, 1000) : '*Not cached (message was older than my memory) or had no text.*',
    });
    if (message.attachments?.size) e.addFields({ name: 'Attachments', value: truncate([...message.attachments.values()].map((a) => a.name).join(', '), 500) });
    e.setTimestamp();
    await logging.send(message.guild, 'messages', e);
  },
};

const messageUpdate = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage, client) {
    if (!newMessage.guild || newMessage.author?.bot || newMessage.author?.id === client.user.id) return;
    if (!oldMessage.content || !newMessage.content || oldMessage.content === newMessage.content) return;
    if (logging.isIgnoredChannel(newMessage.guild.id, newMessage.channelId)) return;
    const e = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('✏️ Message edited')
      .setDescription(`[Jump to message](${newMessage.url})`)
      .addFields(
        { name: 'Author', value: `${newMessage.author} (${newMessage.author.id})`, inline: true },
        { name: 'Channel', value: `<#${newMessage.channelId}>`, inline: true },
        { name: 'Before', value: truncate(oldMessage.content, 1000) },
        { name: 'After', value: truncate(newMessage.content, 1000) },
      )
      .setTimestamp();
    await logging.send(newMessage.guild, 'messages', e);
  },
};

const bulkDelete = {
  name: Events.MessageBulkDelete,
  async execute(messages, channel) {
    if (!channel.guild || logging.isIgnoredChannel(channel.guild.id, channel.id)) return;
    const e = new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle('🧹 Bulk delete')
      .setDescription(`**${messages.size}** messages were deleted in ${channel}.`)
      .setTimestamp();
    await logging.send(channel.guild, 'messages', e);
  },
};

const memberUpdate = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    if (oldMember.partial) return;
    const fields = [];
    if (oldMember.nickname !== newMember.nickname) {
      fields.push({ name: 'Nickname', value: `${oldMember.nickname ?? '*none*'} → ${newMember.nickname ?? '*none*'}` });
    }
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
    if (added.size) fields.push({ name: 'Roles added', value: truncate(added.map((r) => `${r}`).join(' '), 1000) });
    if (removed.size) fields.push({ name: 'Roles removed', value: truncate(removed.map((r) => `${r}`).join(' '), 1000) });
    if (!fields.length) return;
    const e = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('👤 Member updated')
      .setDescription(`${newMember} (${newMember.id})`)
      .addFields(fields)
      .setTimestamp();
    await logging.send(newMember.guild, 'roles', e);
  },
};

const roleCreate = {
  name: Events.GuildRoleCreate,
  async execute(role) {
    await logging.send(role.guild, 'roles', new EmbedBuilder().setColor(COLORS.success).setTitle('🏷️ Role created').setDescription(`${role} (${role.id})`).setTimestamp());
  },
};

const roleDelete = {
  name: Events.GuildRoleDelete,
  async execute(role) {
    await logging.send(role.guild, 'roles', new EmbedBuilder().setColor(COLORS.danger).setTitle('🏷️ Role deleted').setDescription(`**${truncate(role.name, 100)}** (${role.id})`).setTimestamp());
  },
};

const channelCreate = {
  name: Events.ChannelCreate,
  async execute(channel) {
    if (!channel.guild) return;
    await logging.send(channel.guild, 'channels', new EmbedBuilder().setColor(COLORS.success).setTitle('📁 Channel created').setDescription(`${channel} — ${channelKind(channel.type)} (${channel.id})`).setTimestamp());
  },
};

const channelDelete = {
  name: Events.ChannelDelete,
  async execute(channel) {
    if (!channel.guild) return;
    await logging.send(channel.guild, 'channels', new EmbedBuilder().setColor(COLORS.danger).setTitle('📁 Channel deleted').setDescription(`**#${truncate(channel.name, 100)}** — ${channelKind(channel.type)} (${channel.id})`).setTimestamp());
  },
};

const voiceUpdate = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    let text = null;
    if (!oldState.channelId && newState.channelId) text = `joined <#${newState.channelId}>`;
    else if (oldState.channelId && !newState.channelId) text = `left <#${oldState.channelId}>`;
    else if (oldState.channelId !== newState.channelId) text = `moved <#${oldState.channelId}> → <#${newState.channelId}>`;
    if (!text) return;
    await logging.send(
      newState.guild,
      'voice',
      new EmbedBuilder().setColor(COLORS.neutral).setDescription(`🔊 ${member} ${text} • ${ts(Date.now(), 'T')}`),
    );
  },
};

module.exports = [messageDelete, messageUpdate, bulkDelete, memberUpdate, roleCreate, roleDelete, channelCreate, channelDelete, voiceUpdate];
