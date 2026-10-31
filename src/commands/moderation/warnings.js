'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const db = require('../../database');
const embeds = require('../../utils/embeds');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { paginate } = require('../../utils/pagination');
const { canModerate } = require('../../utils/permissions');
const { ts } = require('../../utils/time');
const { truncate, chunk } = require('../../utils/text');
const mod = require('../../services/moderation');

const P = PermissionFlagsBits;

const warn = {
  data: guildCommand('warn', 'Warn a member', P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why they are being warned').setRequired(true).setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const reason = mod.getReason(interaction, { required: true });
    const check = canModerate(interaction.guild, interaction.member, member);
    if (!check.ok) throw new UserError(check.reason);
    if (member.user.bot) throw new UserError('Bots cannot be warned.');

    await interaction.deferReply({ flags: EPHEMERAL });
    const result = await mod.addWarning({
      guild: interaction.guild,
      member,
      moderatorId: interaction.user.id,
      reason,
    });
    const dmSent = await mod.dmUser(member.user, interaction.guild, { action: 'warn', reason });

    let text = `Warned **${member.user.username}** (case #${result.caseRow.case_number}). They now have **${result.count}** active warning(s).`;
    if (result.punishment) text += `\nAutomatic punishment: they were **${result.punishment}**.`;
    if (!dmSent) text += '\n*(I could not DM them.)*';
    await interaction.editReply({ embeds: [embeds.success(text)] });
  },
};

const warnings = {
  data: guildCommand('warnings', 'Show the warnings of a member (staff can view anyone)')
    .addUserOption((o) => o.setName('user').setDescription('Member (default: you)'))
    .addBooleanOption((o) => o.setName('include_cleared').setDescription('Also show cleared warnings')),
  cooldown: 5,

  async execute(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const includeCleared = interaction.options.getBoolean('include_cleared') ?? false;

    if (user.id !== interaction.user.id && !interaction.memberPermissions.has(P.ModerateMembers)) {
      throw new UserError('You can only view your own warnings.');
    }

    const rows = db.all(
      `SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ${includeCleared ? '' : 'AND active = 1'} ORDER BY id DESC`,
      interaction.guildId,
      user.id,
    );
    if (rows.length === 0) {
      await interaction.reply({ embeds: [embeds.info(`**${user.username}** has no ${includeCleared ? '' : 'active '}warnings.`)], flags: EPHEMERAL });
      return;
    }

    const pages = chunk(rows, 5).map((group) =>
      embeds.base(
        `Warnings for ${user.username}`,
        group
          .map(
            (w) =>
              `**#${w.id}** ${w.active ? '' : '*(cleared)* '}— ${ts(w.created_at, 'R')} by <@${w.moderator_id}>\n${truncate(w.reason || 'No reason', 300)}`,
          )
          .join('\n\n'),
        embeds.COLORS.warning,
      ),
    );
    await paginate(interaction, pages, { ephemeral: true });
  },
};

const clearwarnings = {
  data: guildCommand('clearwarnings', 'Clear the warnings of a member', P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption((o) => o.setName('warning_id').setDescription('Clear only this warning (see /warnings)').setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const warningId = interaction.options.getInteger('warning_id');
    const reason = mod.getReason(interaction);

    const active = mod.activeWarnings(interaction.guildId, user.id);
    const targets = warningId ? active.filter((w) => w.id === warningId) : active;
    if (targets.length === 0) throw new UserError(warningId ? 'No active warning with that ID for this user.' : 'That user has no active warnings.');

    const ok = await confirm(interaction, {
      description: `Clear **${targets.length}** warning(s) for **${user.username}**?`,
      confirmLabel: 'Clear',
    });
    if (!ok) return;

    const ids = targets.map((w) => w.id);
    db.transaction(() => {
      for (const id of ids) db.run('UPDATE warnings SET active = 0 WHERE id = ?', id);
    });
    const c = mod.createCase({
      guild: interaction.guild,
      userId: user.id,
      moderatorId: interaction.user.id,
      action: 'clearwarnings',
      reason: reason ?? `Cleared ${ids.length} warning(s)`,
    });
    await interaction.editReply({
      embeds: [embeds.success(`Cleared ${ids.length} warning(s) for **${user.username}** (case #${c.case_number}).`)],
      components: [],
    });
  },
};

module.exports = [warn, warnings, clearwarnings];
