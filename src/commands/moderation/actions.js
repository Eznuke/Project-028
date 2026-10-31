'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const db = require('../../database');
const embeds = require('../../utils/embeds');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { canModerate } = require('../../utils/permissions');
const { parseDuration, formatDuration } = require('../../utils/time');
const mod = require('../../services/moderation');

const P = PermissionFlagsBits;

const kick = {
  data: guildCommand('kick', 'Kick a member from the server', P.KickMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why they are being kicked').setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.KickMembers],
  botPermissions: [P.KickMembers],

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = mod.getReason(interaction);
    const check = canModerate(interaction.guild, interaction.member, member);
    if (!check.ok) throw new UserError(check.reason);
    if (!member.kickable) throw new UserError('I cannot kick that member.');

    const ok = await confirm(interaction, {
      description: `Kick **${member.user.username}**?\n**Reason:** ${reason ?? 'No reason provided'}`,
      confirmLabel: 'Kick',
    });
    if (!ok) return;

    await mod.dmUser(member.user, interaction.guild, { action: 'kick', reason });
    await member.kick(mod.auditReason(interaction, reason));
    const c = mod.createCase({
      guild: interaction.guild,
      userId: member.id,
      moderatorId: interaction.user.id,
      action: 'kick',
      reason,
    });
    await interaction.editReply({
      embeds: [embeds.success(`Kicked **${member.user.username}** (case #${c.case_number}).`)],
      components: [],
    });
  },
};

const ban = {
  data: guildCommand('ban', 'Ban a user (optionally for a limited time)', P.BanMembers)
    .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why they are being banned').setMaxLength(400))
    .addStringOption((o) => o.setName('duration').setDescription('Temporary ban length, e.g. 7d, 12h (empty = permanent)'))
    .addIntegerOption((o) =>
      o
        .setName('delete_messages')
        .setDescription('Delete their recent messages')
        .addChoices(
          { name: "Don't delete", value: 0 },
          { name: 'Last hour', value: 3600 },
          { name: 'Last 24 hours', value: 86400 },
          { name: 'Last 7 days', value: 604800 },
        ),
    ),
  cooldown: 3,
  userPermissions: [P.BanMembers],
  botPermissions: [P.BanMembers],

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const member = interaction.options.getMember('user');
    const reason = mod.getReason(interaction);
    const durationText = interaction.options.getString('duration');
    const deleteSeconds = interaction.options.getInteger('delete_messages') ?? 0;

    let durationMs = null;
    if (durationText) {
      durationMs = parseDuration(durationText);
      if (!durationMs || durationMs > 365 * 86_400_000) {
        throw new UserError('Invalid duration. Use something like `30m`, `12h` or `7d` (max 365d).');
      }
    }

    if (member) {
      const check = canModerate(interaction.guild, interaction.member, member);
      if (!check.ok) throw new UserError(check.reason);
      if (!member.bannable) throw new UserError('I cannot ban that member.');
    } else if (user.id === interaction.user.id || user.id === interaction.guild.ownerId || user.id === interaction.client.user.id) {
      throw new UserError('You cannot ban that user.');
    }

    const existing = await interaction.guild.bans.fetch(user.id).catch(() => null);
    if (existing) throw new UserError(`**${user.username}** is already banned.`);

    const ok = await confirm(interaction, {
      description:
        `Ban **${user.username}**${durationMs ? ` for ${formatDuration(durationMs)}` : ' permanently'}?\n` +
        `**Reason:** ${reason ?? 'No reason provided'}`,
      confirmLabel: 'Ban',
    });
    if (!ok) return;

    await mod.dmUser(user, interaction.guild, { action: durationMs ? 'tempban' : 'ban', reason, durationMs });
    await interaction.guild.members.ban(user.id, {
      reason: mod.auditReason(interaction, reason),
      deleteMessageSeconds: deleteSeconds,
    });

    if (durationMs) {
      db.run(
        'INSERT INTO temp_bans (guild_id, user_id, expires_at) VALUES (?, ?, ?)',
        interaction.guildId,
        user.id,
        Date.now() + durationMs,
      );
    }
    const c = mod.createCase({
      guild: interaction.guild,
      userId: user.id,
      moderatorId: interaction.user.id,
      action: durationMs ? 'tempban' : 'ban',
      reason,
      durationMs,
    });
    await interaction.editReply({
      embeds: [embeds.success(`Banned **${user.username}**${durationMs ? ` for ${formatDuration(durationMs)}` : ''} (case #${c.case_number}).`)],
      components: [],
    });
  },
};

const unban = {
  data: guildCommand('unban', 'Unban a user by their ID', P.BanMembers)
    .addStringOption((o) =>
      o.setName('user_id').setDescription('The ID of the banned user').setRequired(true).setMinLength(15).setMaxLength(22),
    )
    .addStringOption((o) => o.setName('reason').setDescription('Why they are being unbanned').setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.BanMembers],
  botPermissions: [P.BanMembers],

  async execute(interaction) {
    const id = interaction.options.getString('user_id', true).trim();
    if (!/^\d{15,22}$/.test(id)) throw new UserError('That is not a valid user ID (numbers only).');
    const reason = mod.getReason(interaction);

    const ban = await interaction.guild.bans.fetch(id).catch(() => null);
    if (!ban) throw new UserError('That user is not banned.');

    await interaction.guild.bans.remove(id, mod.auditReason(interaction, reason));
    db.run('UPDATE temp_bans SET done = 1 WHERE guild_id = ? AND user_id = ? AND done = 0', interaction.guildId, id);
    const c = mod.createCase({
      guild: interaction.guild,
      userId: id,
      moderatorId: interaction.user.id,
      action: 'unban',
      reason,
    });
    await interaction.reply({
      embeds: [embeds.success(`Unbanned **${ban.user.username}** (case #${c.case_number}).`)],
      flags: EPHEMERAL,
    });
  },
};

const timeout = {
  data: guildCommand('timeout', 'Temporarily mute a member', P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
    .addStringOption((o) =>
      o.setName('duration').setDescription('For how long: 10m, 2h, 1d … (max 28d)').setRequired(true),
    )
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],
  botPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = mod.getReason(interaction);
    const ms = parseDuration(interaction.options.getString('duration', true));
    if (!ms) throw new UserError('Invalid duration. Examples: `10m`, `2h`, `1d`.');
    if (ms > mod.MAX_TIMEOUT_MS) throw new UserError('Discord limits timeouts to 28 days.');

    const check = canModerate(interaction.guild, interaction.member, member);
    if (!check.ok) throw new UserError(check.reason);
    if (!member.moderatable) throw new UserError('I cannot time out that member (administrators cannot be timed out).');

    await mod.dmUser(member.user, interaction.guild, { action: 'timeout', reason, durationMs: ms });
    await member.timeout(ms, mod.auditReason(interaction, reason));
    const c = mod.createCase({
      guild: interaction.guild,
      userId: member.id,
      moderatorId: interaction.user.id,
      action: 'timeout',
      reason,
      durationMs: ms,
    });
    await interaction.reply({
      embeds: [embeds.success(`Timed out **${member.user.username}** for ${formatDuration(ms)} (case #${c.case_number}).`)],
      flags: EPHEMERAL,
    });
  },
};

const untimeout = {
  data: guildCommand('untimeout', 'Remove a timeout from a member', P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],
  botPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = mod.getReason(interaction);
    const check = canModerate(interaction.guild, interaction.member, member);
    if (!check.ok) throw new UserError(check.reason);
    if (!member.isCommunicationDisabled()) throw new UserError('That member is not timed out.');
    if (!member.moderatable) throw new UserError('I cannot change that member’s timeout.');

    await member.timeout(null, mod.auditReason(interaction, reason));
    const c = mod.createCase({
      guild: interaction.guild,
      userId: member.id,
      moderatorId: interaction.user.id,
      action: 'untimeout',
      reason,
    });
    await interaction.reply({
      embeds: [embeds.success(`Removed the timeout from **${member.user.username}** (case #${c.case_number}).`)],
      flags: EPHEMERAL,
    });
  },
};

module.exports = [kick, ban, unban, timeout, untimeout];
