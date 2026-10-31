'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  SnowflakeUtil,
  GuildVerificationLevel,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const { UserError } = require('../../utils/errors');
const { ts } = require('../../utils/time');
const { truncate, formatNumber } = require('../../utils/text');
const { permissionName } = require('../../utils/permissions');

const P = PermissionFlagsBits;
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/** Fetches all members, but gives up quickly on huge servers and falls back to the cache. */
async function loadMembers(guild) {
  try {
    await Promise.race([guild.members.fetch(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    return { members: guild.members.cache, complete: true };
  } catch {
    return { members: guild.members.cache, complete: guild.members.cache.size >= guild.memberCount };
  }
}

const userinfo = {
  data: guildCommand('userinfo', 'Show information about a user')
    .addUserOption((o) => o.setName('user').setDescription('User (default: you)')),
  cooldown: 5,

  async execute(interaction, client) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = await client.users.fetch(target.id, { force: true });
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const flags = user.flags?.toArray().map(permissionName) ?? [];
    const e = new EmbedBuilder()
      .setColor(member?.displayColor || user.accentColor || embeds.COLORS.primary)
      .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
      .setThumbnail((member ?? user).displayAvatarURL({ size: 256 }))
      .addFields(
        { name: 'ID', value: `\`${user.id}\``, inline: true },
        { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
        { name: 'Display name', value: user.displayName ?? user.username, inline: true },
        { name: 'Account created', value: `${ts(user.createdTimestamp, 'F')}\n${ts(user.createdTimestamp, 'R')}` },
      );

    if (member) {
      const roles = member.roles.cache.filter((r) => r.id !== interaction.guildId).sort((a, b) => b.position - a.position);
      e.addFields(
        { name: 'Joined server', value: `${ts(member.joinedTimestamp, 'F')}\n${ts(member.joinedTimestamp, 'R')}` },
        { name: 'Nickname', value: member.nickname ?? 'None', inline: true },
        { name: 'Highest role', value: `${member.roles.highest}`, inline: true },
      );
      if (member.premiumSince) e.addFields({ name: 'Boosting since', value: ts(member.premiumSinceTimestamp, 'R'), inline: true });
      if (member.isCommunicationDisabled()) e.addFields({ name: 'Timed out until', value: ts(member.communicationDisabledUntilTimestamp, 'R'), inline: true });
      e.addFields({
        name: `Roles (${roles.size})`,
        value: roles.size ? truncate([...roles.values()].slice(0, 15).join(' '), 1000) : 'None',
      });
    } else {
      e.setFooter({ text: 'This user is not in this server.' });
    }
    if (flags.length) e.addFields({ name: 'Badges', value: flags.join(', ') });
    if (user.bannerURL()) e.setImage(user.bannerURL({ size: 1024 }));

    await interaction.reply({ embeds: [e] });
  },
};

const avatar = {
  data: guildCommand('avatar', "Show a user's avatar")
    .addUserOption((o) => o.setName('user').setDescription('User (default: you)'))
    .addBooleanOption((o) => o.setName('server_avatar').setDescription('Show their server-specific avatar if they have one')),
  cooldown: 3,

  async execute(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const useServer = interaction.options.getBoolean('server_avatar') ?? false;
    const member = useServer ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;
    const source = member ?? user;
    const url = source.displayAvatarURL({ size: 1024, extension: 'png' });

    const link = (label, ext) =>
      new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(source.displayAvatarURL({ size: 1024, extension: ext }));
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(embeds.COLORS.primary).setTitle(`${user.username}'s avatar`).setImage(url)],
      components: [new ActionRowBuilder().addComponents(link('PNG', 'png'), link('JPG', 'jpg'), link('WEBP', 'webp'))],
    });
  },
};

const banner = {
  data: guildCommand('banner', "Show a user's profile banner")
    .addUserOption((o) => o.setName('user').setDescription('User (default: you)')),
  cooldown: 5,

  async execute(interaction, client) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = await client.users.fetch(target.id, { force: true });
    const url = user.bannerURL({ size: 1024 });
    if (!url) {
      if (user.accentColor) {
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(user.accentColor).setDescription(`**${user.username}** has no banner image, only an accent colour: \`${hex(user.accentColor)}\`.`)],
        });
        return;
      }
      throw new UserError(`**${user.username}** does not have a banner.`);
    }
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(user.accentColor ?? embeds.COLORS.primary).setTitle(`${user.username}'s banner`).setImage(url)],
    });
  },
};

const serverinfo = {
  data: guildCommand('serverinfo', 'Show information about this server'),
  cooldown: 10,

  async execute(interaction) {
    const guild = await interaction.guild.fetch();
    const channels = guild.channels.cache;
    const count = (...types) => channels.filter((c) => types.includes(c.type)).size;
    const e = new EmbedBuilder()
      .setColor(embeds.COLORS.primary)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'ID', value: `\`${guild.id}\``, inline: true },
        { name: 'Created', value: ts(guild.createdTimestamp, 'R'), inline: true },
        { name: 'Members', value: formatNumber(guild.memberCount), inline: true },
        {
          name: 'Channels',
          value: `💬 ${count(ChannelType.GuildText, ChannelType.GuildAnnouncement)} text\n🔊 ${count(ChannelType.GuildVoice, ChannelType.GuildStageVoice)} voice\n📁 ${count(ChannelType.GuildCategory)} categories`,
          inline: true,
        },
        { name: 'Roles', value: formatNumber(guild.roles.cache.size), inline: true },
        { name: 'Emojis / stickers', value: `${guild.emojis.cache.size} / ${guild.stickers.cache.size}`, inline: true },
        { name: 'Boosts', value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`, inline: true },
        { name: 'Verification', value: GuildVerificationLevel[guild.verificationLevel] ?? String(guild.verificationLevel), inline: true },
      );
    if (guild.description) e.setDescription(truncate(guild.description, 300));
    if (guild.vanityURLCode) e.addFields({ name: 'Vanity URL', value: `discord.gg/${guild.vanityURLCode}`, inline: true });
    if (guild.bannerURL()) e.setImage(guild.bannerURL({ size: 1024 }));
    await interaction.reply({ embeds: [e] });
  },
};

const servericon = {
  data: guildCommand('servericon', "Show this server's icon"),
  cooldown: 5,

  async execute(interaction) {
    const url = interaction.guild.iconURL({ size: 1024 });
    if (!url) throw new UserError('This server has no icon.');
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(embeds.COLORS.primary).setTitle(`${interaction.guild.name} icon`).setImage(url)],
    });
  },
};

const membercount = {
  data: guildCommand('membercount', 'Show how many members this server has'),
  cooldown: 10,

  async execute(interaction) {
    await interaction.deferReply();
    const { members, complete } = await loadMembers(interaction.guild);
    const bots = members.filter((m) => m.user.bot).size;
    const total = interaction.guild.memberCount;
    const e = embeds
      .base(`👥 ${interaction.guild.name}`, null)
      .addFields(
        { name: 'Total', value: formatNumber(total), inline: true },
        { name: 'Humans', value: formatNumber(Math.max(0, total - bots)), inline: true },
        { name: 'Bots', value: formatNumber(bots), inline: true },
      );
    if (!complete) e.setFooter({ text: 'Human/bot split is approximate (large server).' });
    await interaction.editReply({ embeds: [e] });
  },
};

const roleinfo = {
  data: guildCommand('roleinfo', 'Show information about a role').addRoleOption((o) =>
    o.setName('role').setDescription('Role').setRequired(true),
  ),
  cooldown: 5,

  async execute(interaction) {
    const role = interaction.options.getRole('role', true);
    const full = interaction.guild.roles.cache.get(role.id) ?? role;
    const perms = full.permissions.has(P.Administrator)
      ? 'Administrator (all permissions)'
      : full.permissions.toArray().map(permissionName).join(', ') || 'None';
    const e = new EmbedBuilder()
      .setColor(full.color || embeds.COLORS.neutral)
      .setTitle(`Role: ${full.name}`)
      .addFields(
        { name: 'ID', value: `\`${full.id}\``, inline: true },
        { name: 'Colour', value: full.color ? hex(full.color) : 'Default', inline: true },
        { name: 'Position', value: String(full.position), inline: true },
        { name: 'Members', value: String(full.members?.size ?? 0), inline: true },
        { name: 'Mentionable', value: full.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Shown separately', value: full.hoist ? 'Yes' : 'No', inline: true },
        { name: 'Managed by integration', value: full.managed ? 'Yes' : 'No', inline: true },
        { name: 'Created', value: ts(full.createdTimestamp, 'R'), inline: true },
        { name: 'Permissions', value: truncate(perms, 1000) },
      );
    await interaction.reply({ embeds: [e] });
  },
};

const channelinfo = {
  data: guildCommand('channelinfo', 'Show information about a channel').addChannelOption((o) =>
    o.setName('channel').setDescription('Channel (default: this one)'),
  ),
  cooldown: 5,

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const e = new EmbedBuilder()
      .setColor(embeds.COLORS.primary)
      .setTitle(`#${channel.name}`)
      .addFields(
        { name: 'ID', value: `\`${channel.id}\``, inline: true },
        { name: 'Type', value: ChannelType[channel.type] ?? String(channel.type), inline: true },
        { name: 'Created', value: ts(channel.createdTimestamp, 'R'), inline: true },
      );
    if (channel.parent) e.addFields({ name: 'Category', value: channel.parent.name, inline: true });
    if (channel.topic) e.addFields({ name: 'Topic', value: truncate(channel.topic, 500) });
    if (typeof channel.nsfw === 'boolean') e.addFields({ name: 'NSFW', value: channel.nsfw ? 'Yes' : 'No', inline: true });
    if (channel.rateLimitPerUser) e.addFields({ name: 'Slowmode', value: `${channel.rateLimitPerUser}s`, inline: true });
    if (channel.bitrate) e.addFields({ name: 'Bitrate', value: `${Math.round(channel.bitrate / 1000)} kbps`, inline: true });
    if (channel.userLimit) e.addFields({ name: 'User limit', value: String(channel.userLimit), inline: true });
    await interaction.reply({ embeds: [e] });
  },
};

const emojiinfo = {
  data: guildCommand('emojiinfo', 'Show information about an emoji')
    .addStringOption((o) => o.setName('emoji').setDescription('A custom emoji, its ID, or a standard emoji').setRequired(true)),
  cooldown: 5,

  async execute(interaction) {
    const input = interaction.options.getString('emoji', true).trim();
    const custom = input.match(/^<(a?):(\w+):(\d{15,22})>$/);
    const idOnly = /^\d{15,22}$/.test(input) ? input : null;

    if (custom || idOnly) {
      const id = custom ? custom[3] : idOnly;
      const known = interaction.guild.emojis.cache.get(id);
      const animated = known ? known.animated : custom?.[1] === 'a';
      const name = known?.name ?? custom?.[2] ?? 'unknown';
      const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=256`;
      const e = new EmbedBuilder()
        .setColor(embeds.COLORS.primary)
        .setTitle(`:${name}:`)
        .setThumbnail(url)
        .addFields(
          { name: 'ID', value: `\`${id}\``, inline: true },
          { name: 'Animated', value: animated ? 'Yes' : 'No', inline: true },
          { name: 'Created', value: ts(SnowflakeUtil.timestampFrom(id), 'R'), inline: true },
          { name: 'From this server', value: known ? 'Yes' : 'No', inline: true },
          { name: 'Image URL', value: url },
        );
      await interaction.reply({ embeds: [e] });
      return;
    }

    const chars = [...input].filter((c) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c));
    if (chars.length === 0) throw new UserError('I could not find an emoji in that. Paste a custom emoji, an emoji ID, or a standard emoji.');
    const codepoints = [...input].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    await interaction.reply({
      embeds: [
        embeds.base(`${input}  Standard emoji`, null).addFields(
          { name: 'Code points', value: `\`${codepoints}\`` },
          { name: 'Characters', value: String([...input].length), inline: true },
        ),
      ],
    });
  },
};

const permissions = {
  data: guildCommand('permissions', 'Show what a member can do in a channel')
    .addUserOption((o) => o.setName('user').setDescription('Member (default: you)'))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)')),
  cooldown: 5,

  async execute(interaction) {
    const member = interaction.options.getMember('user') ?? interaction.member;
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!member) throw new UserError('That user is not in this server.');

    const perms = channel.permissionsFor(member) ?? member.permissions;
    const all = Object.keys(PermissionsBitField.Flags);
    const granted = perms.has(P.Administrator) ? ['Administrator (everything)'] : all.filter((p) => perms.has(p)).map(permissionName);
    const denied = perms.has(P.Administrator) ? [] : all.filter((p) => !perms.has(p)).map(permissionName);

    const e = new EmbedBuilder()
      .setColor(embeds.COLORS.primary)
      .setTitle(`Permissions of ${member.displayName}`)
      .setDescription(`In ${channel}`)
      .addFields(
        { name: `✅ Allowed (${granted.length})`, value: truncate(granted.join(', ') || 'None', 1024) },
        { name: `❌ Not allowed (${denied.length})`, value: truncate(denied.join(', ') || 'None', 1024) },
      );
    await interaction.reply({ embeds: [e], flags: EPHEMERAL });
  },
};

const firstmessage = {
  data: guildCommand('firstmessage', 'Jump to the very first message of a channel')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel (default: this one)')),
  cooldown: 10,
  botPermissions: [P.ViewChannel, P.ReadMessageHistory],

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    if (!channel.isTextBased()) throw new UserError('That channel has no messages.');
    const need = [P.ViewChannel, P.ReadMessageHistory];
    if (!channel.permissionsFor(interaction.member)?.has(need)) throw new UserError('You cannot read the history of that channel.');
    if (!channel.permissionsFor(interaction.guild.members.me)?.has(need)) throw new UserError('I cannot read the history of that channel.');

    const [first] = (await channel.messages.fetch({ after: '0', limit: 1 })).values();
    if (!first) throw new UserError('That channel has no messages yet.');

    const e = new EmbedBuilder()
      .setColor(embeds.COLORS.primary)
      .setAuthor({ name: first.author.username, iconURL: first.author.displayAvatarURL() })
      .setTitle(`First message in #${channel.name}`)
      .setDescription(truncate(first.content || '*(no text, maybe an attachment or embed)*', 1500))
      .setTimestamp(first.createdTimestamp);
    await interaction.reply({
      embeds: [e],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Jump to message').setStyle(ButtonStyle.Link).setURL(first.url))],
    });
  },
};

const memberjoined = {
  data: guildCommand('memberjoined', 'When a member joined, or who joined at a given position')
    .addUserOption((o) => o.setName('user').setDescription('Member (default: you)'))
    .addIntegerOption((o) => o.setName('position').setDescription('Find who was the Nth member to join').setMinValue(1)),
  cooldown: 10,

  async execute(interaction) {
    await interaction.deferReply();
    const { members, complete } = await loadMembers(interaction.guild);
    const ordered = [...members.values()].filter((m) => m.joinedTimestamp).sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
    const position = interaction.options.getInteger('position');
    const note = complete ? null : 'Large server: order is approximate.';

    if (position) {
      const found = ordered[position - 1];
      if (!found) throw new UserError(`I only know ${ordered.length} members, so there is no member #${position}.`);
      const e = embeds.info(`Member **#${position}** to join was ${found} — ${ts(found.joinedTimestamp, 'F')}.`);
      if (note) e.setFooter({ text: note });
      await interaction.editReply({ embeds: [e] });
      return;
    }

    const member = interaction.options.getMember('user') ?? interaction.member;
    const index = ordered.findIndex((m) => m.id === member.id);
    const e = embeds.info(
      `${member} joined ${ts(member.joinedTimestamp, 'F')} (${ts(member.joinedTimestamp, 'R')}).\n` +
        (index >= 0 ? `They were member **#${index + 1}** to join.` : ''),
    );
    if (note) e.setFooter({ text: note });
    await interaction.editReply({ embeds: [e] });
  },
};

module.exports = [userinfo, avatar, banner, serverinfo, servericon, membercount, roleinfo, channelinfo, emojiinfo, permissions, firstmessage, memberjoined];
