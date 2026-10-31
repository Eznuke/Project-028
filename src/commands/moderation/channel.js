'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const audit = require('../../services/audit');
const settings = require('../../services/settings');
const logging = require('../../services/logging');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { getReason, auditReason } = require('../../services/moderation');

const P = PermissionFlagsBits;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function targetChannel(interaction, { textOnly = true } = {}) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!channel) throw new UserError('I could not find that channel.');
  if (textOnly && !TEXT_TYPES.includes(channel.type)) throw new UserError('That only works on text channels.');
  if (!channel.manageable) throw new UserError('I cannot edit that channel. Check my permissions there.');
  return channel;
}

function logChannelAction(interaction, text) {
  audit.record(interaction.guildId, interaction.user.id, text.split(' ')[0], interaction.channelId, text);
  logging.send(
    interaction.guild,
    'moderation',
    embeds.base('Channel action', `${text}\nBy ${interaction.user} in <#${interaction.channelId}>`, embeds.COLORS.info),
  );
}

const purge = {
  data: guildCommand('purge', 'Bulk delete recent messages (max 100, newer than 14 days)', P.ManageMessages)
    .addIntegerOption((o) =>
      o.setName('amount').setDescription('How many messages to scan (1-100)').setRequired(true).setMinValue(1).setMaxValue(100),
    )
    .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'))
    .addBooleanOption((o) => o.setName('bots').setDescription('Only delete messages from bots'))
    .addStringOption((o) => o.setName('contains').setDescription('Only delete messages containing this text').setMaxLength(100)),
  cooldown: 5,
  userPermissions: [P.ManageMessages],
  botPermissions: [P.ManageMessages, P.ReadMessageHistory],

  async execute(interaction) {
    const amount = interaction.options.getInteger('amount', true);
    const user = interaction.options.getUser('user');
    const botsOnly = interaction.options.getBoolean('bots') ?? false;
    const contains = interaction.options.getString('contains')?.toLowerCase();
    const max = settings.view(interaction.guildId).moderation.purgeMax;
    if (amount > max) throw new UserError(`This server limits purge to ${max} messages at once.`);

    const channel = interaction.channel;
    if (!channel?.isTextBased() || channel.isDMBased()) throw new UserError('Use this in a server text channel.');

    // Larger purges need a confirmation click.
    if (amount >= 25) {
      const ok = await confirm(interaction, {
        description: `Delete up to **${amount}** recent messages in ${channel}?`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
    } else {
      await interaction.deferReply({ flags: EPHEMERAL });
    }

    const fetched = await channel.messages.fetch({ limit: 100 });
    const cutoff = Date.now() - 14 * 86_400_000;
    const matches = [...fetched.values()]
      .filter((m) => !m.pinned && m.createdTimestamp > cutoff)
      .filter((m) => (user ? m.author.id === user.id : true))
      .filter((m) => (botsOnly ? m.author.bot : true))
      .filter((m) => (contains ? m.content.toLowerCase().includes(contains) : true))
      .slice(0, amount);

    if (matches.length === 0) {
      await interaction.editReply({ embeds: [embeds.info('No matching messages to delete.')], components: [] });
      return;
    }
    const deleted = await channel.bulkDelete(matches, true);
    logChannelAction(interaction, `purge: deleted ${deleted.size} message(s) in <#${channel.id}>`);
    await interaction.editReply({ embeds: [embeds.success(`Deleted **${deleted.size}** message(s).`)], components: [] });
  },
};

const slowmode = {
  data: guildCommand('slowmode', 'Set the slowmode of a channel', P.ManageChannels)
    .addIntegerOption((o) =>
      o.setName('seconds').setDescription('Seconds between messages (0 turns it off, max 21600)').setRequired(true).setMinValue(0).setMaxValue(21600),
    )
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(ChannelType.GuildText)),
  cooldown: 5,
  userPermissions: [P.ManageChannels],
  botPermissions: [P.ManageChannels],

  async execute(interaction) {
    const seconds = interaction.options.getInteger('seconds', true);
    const channel = targetChannel(interaction);
    await channel.setRateLimitPerUser(seconds, `Slowmode by ${interaction.user.username}`);
    logChannelAction(interaction, `slowmode: set to ${seconds}s in <#${channel.id}>`);
    await interaction.reply({
      embeds: [embeds.success(seconds === 0 ? `Slowmode disabled in ${channel}.` : `Slowmode in ${channel} is now **${seconds}s**.`)],
      flags: EPHEMERAL,
    });
  },
};

/** Builds lock/unlock/hide/unhide with one factory (they only differ in the overwrite). */
function overwriteCommand({ name, description, permission, apply, success, perms }) {
  return {
    data: guildCommand(name, description, permission)
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(...TEXT_TYPES))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
    cooldown: 5,
    userPermissions: [permission],
    botPermissions: [P.ManageChannels, P.ManageRoles],

    async execute(interaction) {
      const channel = targetChannel(interaction);
      const reason = getReason(interaction);
      const everyone = interaction.guild.roles.everyone;
      const me = interaction.guild.members.me;

      // Make sure the bot keeps its own access before changing @everyone.
      await channel.permissionOverwrites.edit(me, { ViewChannel: true, SendMessages: true }, { reason: 'Keep bot access' });
      await channel.permissionOverwrites.edit(everyone, apply, { reason: auditReason(interaction, reason) });

      logChannelAction(interaction, `${name}: ${channel} (${reason ?? 'no reason'})`);
      await interaction.reply({ embeds: [embeds.success(success(channel))], flags: EPHEMERAL });
      if (name === 'lock' || name === 'unlock') {
        channel
          .send({ embeds: [embeds.info(name === 'lock' ? `🔒 This channel was locked.${reason ? `\n**Reason:** ${reason}` : ''}` : '🔓 This channel was unlocked.')] })
          .catch(() => {});
      }
    },
  };
}

const lock = overwriteCommand({
  name: 'lock',
  description: 'Stop @everyone from sending messages in a channel',
  permission: P.ManageChannels,
  apply: { SendMessages: false, SendMessagesInThreads: false, AddReactions: false },
  success: (c) => `Locked ${c}.`,
});
const unlock = overwriteCommand({
  name: 'unlock',
  description: 'Let @everyone send messages in a channel again',
  permission: P.ManageChannels,
  apply: { SendMessages: null, SendMessagesInThreads: null, AddReactions: null },
  success: (c) => `Unlocked ${c}.`,
});
const hide = overwriteCommand({
  name: 'hide',
  description: 'Hide a channel from @everyone',
  permission: P.ManageChannels,
  apply: { ViewChannel: false },
  success: (c) => `Hid ${c} from @everyone.`,
});
const unhide = overwriteCommand({
  name: 'unhide',
  description: 'Make a hidden channel visible to @everyone again',
  permission: P.ManageChannels,
  apply: { ViewChannel: null },
  success: (c) => `${c} is visible to @everyone again.`,
});

module.exports = [purge, slowmode, lock, unlock, hide, unhide];
