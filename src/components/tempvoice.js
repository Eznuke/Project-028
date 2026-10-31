'use strict';

const {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, OverwriteType, PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');
const tv = require('../services/tempvoice');
const logger = require('../utils/logger');

const P = PermissionFlagsBits;
const renamedAt = new Map(); // room -> last rename (Discord allows only 2 renames per 10 minutes)
const RENAME_WAIT_MS = 5 * 60_000;

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

function modal(id, title, input) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

/** Re-draws the control panel (the message the click came from). */
async function refresh(interaction, channel, ownerId, state) {
  const payload = tv.panel(channel, ownerId, state);
  if (interaction.isFromMessage?.() || interaction.isMessageComponent?.()) return interaction.update(payload);
  return interaction.reply({ content: '✅ Done.', flags: MessageFlags.Ephemeral });
}

async function giveRoom(channel, room, newOwnerId) {
  if (room.owner_id !== newOwnerId) await channel.permissionOverwrites.delete(room.owner_id).catch(() => {});
  await channel.permissionOverwrites.edit(newOwnerId, { ViewChannel: true, Connect: true, Speak: true }, { type: OverwriteType.Member });
  db.run('UPDATE temp_voice SET owner_id = ? WHERE channel_id = ?', newOwnerId, channel.id);
}

module.exports = {
  prefix: 'tv',
  async execute(interaction, args) {
    const [action] = args;
    const channel = interaction.channel;
    const room = interaction.inGuild() ? tv.getRoom(interaction.channelId) : null;
    if (!room || room.guild_id !== interaction.guildId) return say(interaction, 'This room no longer exists.');
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me)?.has([P.ManageChannels, P.MoveMembers])) {
      return say(interaction, 'I am missing the **Manage Channels** / **Move Members** permissions here. Tell an admin.');
    }

    if (action === 'claim') {
      if (channel.members.has(room.owner_id)) return say(interaction, 'The owner is still in the room.');
      if (!channel.members.has(interaction.user.id)) return say(interaction, 'Join the room first to claim it.');
      await giveRoom(channel, room, interaction.user.id);
      return refresh(interaction, channel, interaction.user.id);
    }

    if (room.owner_id !== interaction.user.id) return say(interaction, `Only the room owner (<@${room.owner_id}>) can do this. If they left, press **Claim**.`);

    switch (action) {
      case 'lock': {
        const lock = !tv.isLocked(channel);
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: lock ? false : null });
        return refresh(interaction, channel, room.owner_id, { locked: lock });
      }
      case 'hide': {
        const hide = !tv.isHidden(channel);
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: hide ? false : null });
        return refresh(interaction, channel, room.owner_id, { hidden: hide });
      }
      case 'rename':
        return interaction.showModal(modal('tv:renamed', 'Rename your room',
          new TextInputBuilder().setCustomId('name').setLabel('New name').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(100).setRequired(true)));
      case 'renamed': {
        const wait = RENAME_WAIT_MS - (Date.now() - (renamedAt.get(channel.id) ?? 0));
        if (wait > 0) return say(interaction, `Discord limits renaming. Try again in ${Math.ceil(wait / 60_000)} minute(s).`);
        renamedAt.set(channel.id, Date.now());
        await channel.setName(tv.cleanName(interaction.fields.getTextInputValue('name'), channel.name), 'Renamed by the room owner');
        return say(interaction, '✅ Renamed.');
      }
      case 'limit':
        return interaction.showModal(modal('tv:limited', 'Set a user limit',
          new TextInputBuilder().setCustomId('limit').setLabel('Maximum people (0 = no limit, max 99)').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(2).setRequired(true)));
      case 'limited': {
        const text = interaction.fields.getTextInputValue('limit').trim();
        if (!/^\d{1,2}$/.test(text)) return say(interaction, '❌ Enter a whole number from 0 to 99.');
        const limit = Number(text);
        await channel.setUserLimit(limit, 'Set by the room owner');
        return refresh(interaction, channel, room.owner_id, { limit });
      }
      case 'kick': {
        const target = interaction.values?.[0];
        if (!target || target === interaction.user.id) return say(interaction, 'Pick someone else.');
        const user = interaction.users?.get(target);
        if (user?.bot) return say(interaction, 'I cannot kick bots.');
        await channel.permissionOverwrites.edit(target, { Connect: false }, { type: OverwriteType.Member });
        const inRoom = channel.members.get(target);
        if (inRoom) await inRoom.voice.disconnect('Kicked by the room owner').catch((err) => logger.debug('Voice kick failed:', err.message));
        await interaction.update(tv.panel(channel, room.owner_id)).catch(() => {});
        return interaction.followUp({ content: `🚪 <@${target}> was ${inRoom ? 'removed and ' : ''}blocked from this room.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      case 'transfer': {
        const target = interaction.values?.[0];
        const member = target ? channel.members.get(target) : null;
        if (!member || member.user.bot || target === interaction.user.id) return say(interaction, 'Choose a person who is currently in this room (not yourself, not a bot).');
        await giveRoom(channel, room, target);
        return refresh(interaction, channel, target);
      }
      default:
        return undefined;
    }
  },
};
