'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const settings = require('../../services/settings');
const leveling = require('../../services/leveling');
const eco = require('../../services/economy');
const audit = require('../../services/audit');
const db = require('../../database');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { paginate } = require('../../utils/pagination');
const { canManageRole } = require('../../utils/permissions');
const { chunk, formatNumber } = require('../../utils/text');

const P = PermissionFlagsBits;

function bar(current, needed, size = 12) {
  const filled = Math.max(0, Math.min(size, Math.round((current / needed) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function requireEnabled(guildId) {
  if (!settings.view(guildId).leveling.enabled) {
    throw new UserError('Leveling is turned off in this server. An admin can enable it with `/config leveling`.');
  }
}

const rank = {
  data: guildCommand('rank', 'Show your XP, level and server rank')
    .addUserOption((o) => o.setName('user').setDescription('Member (default: you)')),
  cooldown: 5,
  async execute(interaction) {
    requireEnabled(interaction.guildId);
    const user = interaction.options.getUser('user') ?? interaction.user;
    if (user.bot) throw new UserError('Bots do not earn XP.');
    const row = leveling.getRow(interaction.guildId, user.id);
    if (!row) throw new UserError(`${user.username} has no XP yet. Chat a little first!`);
    const p = leveling.progress(row.xp);
    const e = embeds
      .base(`📈 ${user.username}`, `**Level ${p.level}**\n\`${bar(p.current, p.needed)}\` ${formatNumber(p.current)} / ${formatNumber(p.needed)} XP`)
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Rank', value: `#${leveling.getRank(interaction.guildId, user.id)}`, inline: true },
        { name: 'Total XP', value: formatNumber(row.xp), inline: true },
        { name: 'Messages counted', value: formatNumber(row.messages), inline: true },
      );
    await interaction.reply({ embeds: [e] });
  },
};

const leaderboard = {
  data: guildCommand('leaderboard', 'Show the top members by XP or by coins')
    .addStringOption((o) =>
      o.setName('type').setDescription('Which ranking (default: xp)')
        .addChoices({ name: 'XP / levels', value: 'xp' }, { name: 'Economy / coins', value: 'economy' })),
  cooldown: 10,
  async execute(interaction) {
    const g = interaction.guildId;
    const type = interaction.options.getString('type') ?? 'xp';
    let lines;
    let title;
    if (type === 'economy') {
      eco.assertEnabled(g);
      title = `${eco.cfg(g).currencySymbol} Richest members`;
      lines = eco.leaderboard(g, 100).map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${eco.money(g, r.total)}`);
    } else {
      requireEnabled(g);
      title = '🏆 XP leaderboard';
      lines = leveling.top(g, 100).map((r, i) => `**${i + 1}.** <@${r.user_id}> — level **${r.level}** • ${formatNumber(r.xp)} XP`);
    }
    if (!lines.length) throw new UserError('Nobody is on the leaderboard yet.');
    const pages = chunk(lines, 10).map((part) => embeds.base(title, part.join('\n')));
    await paginate(interaction, pages);
  },
};

const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.MentionEveryone];

const level = {
  data: guildCommand('level', 'Level details and level-role rewards')
    .addSubcommand((s) => s.setName('view').setDescription('Show detailed level information')
      .addUserOption((o) => o.setName('user').setDescription('Member (default: you)')))
    .addSubcommand((s) => s.setName('roles').setDescription('List the level role rewards'))
    .addSubcommand((s) => s.setName('role-add').setDescription('Give a role at a level (Manage Server)')
      .addIntegerOption((o) => o.setName('level').setDescription('Level required').setRequired(true).setMinValue(1).setMaxValue(500))
      .addRoleOption((o) => o.setName('role').setDescription('Role to grant').setRequired(true)))
    .addSubcommand((s) => s.setName('role-remove').setDescription('Remove a level reward (Manage Server)')
      .addIntegerOption((o) => o.setName('level').setDescription('Level of the reward').setRequired(true).setMinValue(1).setMaxValue(500)))
    .addSubcommand((s) => s.setName('set-xp').setDescription('Set a member\'s total XP (Manage Server)')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((o) => o.setName('xp').setDescription('New total XP').setRequired(true).setMinValue(0).setMaxValue(100_000_000)))
    .addSubcommand((s) => s.setName('reset').setDescription('Reset a member\'s XP to zero (Manage Server)')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
  cooldown: 3,

  async execute(interaction) {
    const g = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      requireEnabled(g);
      const user = interaction.options.getUser('user') ?? interaction.user;
      const row = leveling.getRow(g, user.id);
      if (!row) throw new UserError(`${user.username} has no XP yet.`);
      const p = leveling.progress(row.xp);
      const next = settings.view(g).leveling.levelRoles.filter((r) => r.level > p.level).sort((a, b) => a.level - b.level)[0];
      const e = embeds.base(`Level ${p.level} — ${user.username}`)
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Progress', value: `\`${bar(p.current, p.needed, 16)}\`\n${formatNumber(p.current)} / ${formatNumber(p.needed)} XP`, },
          { name: 'XP to next level', value: formatNumber(p.needed - p.current), inline: true },
          { name: 'Total XP', value: formatNumber(row.xp), inline: true },
          { name: 'Server rank', value: `#${leveling.getRank(g, user.id)}`, inline: true },
        );
      if (next) e.addFields({ name: 'Next reward', value: `<@&${next.roleId}> at level ${next.level}` });
      await interaction.reply({ embeds: [e], allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'roles') {
      const list = [...settings.view(g).leveling.levelRoles].sort((a, b) => a.level - b.level);
      const text = list.length ? list.map((r) => `Level **${r.level}** → <@&${r.roleId}>`).join('\n') : 'No level roles configured. Use `/level role-add`.';
      await interaction.reply({ embeds: [embeds.base('🎖️ Level roles', text)], allowedMentions: { parse: [] } });
      return;
    }

    if (!interaction.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the **Manage Server** permission for this.');

    if (sub === 'role-add') {
      const role = interaction.options.getRole('role', true);
      const lvl = interaction.options.getInteger('level', true);
      const check = canManageRole(interaction.guild, interaction.member, role);
      if (!check.ok) throw new UserError(check.reason);
      if (DANGEROUS.some((p) => role.permissions.has(p))) throw new UserError('For safety, level rewards cannot grant roles with moderation or admin permissions.');
      const current = settings.view(g).leveling.levelRoles;
      if (current.length >= 25 && !current.some((r) => r.level === lvl)) throw new UserError('You can configure at most 25 level roles.');
      settings.update(g, (s) => {
        s.leveling.levelRoles = s.leveling.levelRoles.filter((r) => r.level !== lvl);
        s.leveling.levelRoles.push({ level: lvl, roleId: role.id });
      });
      audit.record(g, interaction.user.id, 'level.role_add', role.id, `level ${lvl}`);
      await interaction.reply({ embeds: [embeds.success(`${role} will be granted at **level ${lvl}**.`)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'role-remove') {
      const lvl = interaction.options.getInteger('level', true);
      if (!settings.view(g).leveling.levelRoles.some((r) => r.level === lvl)) throw new UserError('There is no reward at that level.');
      settings.update(g, (s) => { s.leveling.levelRoles = s.leveling.levelRoles.filter((r) => r.level !== lvl); });
      audit.record(g, interaction.user.id, 'level.role_remove', null, `level ${lvl}`);
      await interaction.reply({ embeds: [embeds.success(`Removed the reward at level ${lvl}.`)], flags: EPHEMERAL });
      return;
    }

    const user = interaction.options.getUser('user', true);
    if (user.bot) throw new UserError('Bots do not earn XP.');

    if (sub === 'set-xp') {
      const xp = interaction.options.getInteger('xp', true);
      const lvl = leveling.setXp(g, user.id, xp);
      audit.record(g, interaction.user.id, 'level.set_xp', user.id, `${xp} xp`);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (member) await leveling.syncLevelRoles(member, lvl);
      await interaction.reply({ embeds: [embeds.success(`${user} now has **${formatNumber(xp)} XP** (level ${lvl}).`)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    // reset
    const ok = await confirm(interaction, { description: `Reset **${user.username}**'s XP to zero? This cannot be undone.`, confirmLabel: 'Reset XP' });
    if (!ok) return;
    db.run('DELETE FROM levels WHERE guild_id = ? AND user_id = ?', g, user.id);
    audit.record(g, interaction.user.id, 'level.reset', user.id);
    await interaction.editReply({ embeds: [embeds.success(`Reset XP for **${user.username}**.`)], components: [] });
  },
};

module.exports = [rank, leaderboard, level];
