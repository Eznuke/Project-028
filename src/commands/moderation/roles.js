'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const audit = require('../../services/audit');
const logging = require('../../services/logging');
const settings = require('../../services/settings');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { canModerate, canManageRole } = require('../../utils/permissions');
const { getReason, auditReason } = require('../../services/moderation');

const P = PermissionFlagsBits;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logRoleAction(interaction, text, target) {
  audit.record(interaction.guildId, interaction.user.id, text.split(':')[0], target, text);
  logging.send(
    interaction.guild,
    'moderation',
    embeds.base('Role / nickname action', `${text}\nBy ${interaction.user}`, embeds.COLORS.info),
  );
}

const nick = {
  data: guildCommand('nick', "Change or reset a member's nickname", P.ManageNicknames)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('nickname').setDescription('New nickname (leave empty to reset)').setMaxLength(32)),
  cooldown: 3,
  userPermissions: [P.ManageNicknames],
  botPermissions: [P.ManageNicknames],

  async execute(interaction) {
    const member = interaction.options.getMember('user');
    const nickname = interaction.options.getString('nickname')?.trim() || null;
    if (!member) throw new UserError('That user is not in this server.');

    if (member.id !== interaction.user.id) {
      const check = canModerate(interaction.guild, interaction.member, member);
      if (!check.ok) throw new UserError(check.reason);
    }
    if (!member.manageable) throw new UserError('I cannot change that member’s nickname.');

    const old = member.displayName;
    await member.setNickname(nickname, auditReason(interaction, 'Nickname change'));
    logRoleAction(interaction, `nick: ${member} "${old}" → "${nickname ?? 'reset'}"`, member.id);
    await interaction.reply({
      embeds: [embeds.success(nickname ? `Changed the nickname of ${member} to **${nickname}**.` : `Reset the nickname of ${member}.`)],
      flags: EPHEMERAL,
    });
  },
};

function roleToggle({ name, description, add }) {
  return {
    data: guildCommand(name, description, P.ManageRoles)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
    cooldown: 3,
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],

    async execute(interaction) {
      const member = interaction.options.getMember('user');
      const role = interaction.options.getRole('role', true);
      const reason = getReason(interaction);
      if (!member) throw new UserError('That user is not in this server.');

      const roleCheck = canManageRole(interaction.guild, interaction.member, role);
      if (!roleCheck.ok) throw new UserError(roleCheck.reason);
      if (member.id !== interaction.user.id) {
        const check = canModerate(interaction.guild, interaction.member, member);
        if (!check.ok) throw new UserError(check.reason);
      }

      const has = member.roles.cache.has(role.id);
      if (add && has) throw new UserError(`${member} already has ${role}.`);
      if (!add && !has) throw new UserError(`${member} does not have ${role}.`);

      if (add) await member.roles.add(role, auditReason(interaction, reason));
      else await member.roles.remove(role, auditReason(interaction, reason));

      logRoleAction(interaction, `${name}: ${add ? 'gave' : 'removed'} ${role} ${add ? 'to' : 'from'} ${member}`, member.id);
      await interaction.reply({
        embeds: [embeds.success(`${add ? 'Gave' : 'Removed'} ${role} ${add ? 'to' : 'from'} ${member}.`)],
        flags: EPHEMERAL,
      });
    },
  };
}

const roleadd = roleToggle({ name: 'roleadd', description: 'Give a role to a member', add: true });
const roleremove = roleToggle({ name: 'roleremove', description: 'Remove a role from a member', add: false });

const massrole = {
  data: guildCommand('massrole', 'Add or remove a role for many members at once (with safety limits)', P.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give a role to a group of members')
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('filter')
            .setDescription('Who gets it')
            .setRequired(true)
            .addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' }, { name: 'Everyone', value: 'all' }, { name: 'Members of another role', value: 'role' }),
        )
        .addRoleOption((o) => o.setName('having_role').setDescription('Required when filter is "Members of another role"')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a role from a group of members')
        .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('filter')
            .setDescription('Who loses it')
            .setRequired(true)
            .addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' }, { name: 'Everyone', value: 'all' }),
        ),
    ),
  cooldown: 30,
  userPermissions: [P.ManageRoles],
  botPermissions: [P.ManageRoles],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const add = sub === 'add';
    const role = interaction.options.getRole('role', true);
    const filter = interaction.options.getString('filter', true);
    const havingRole = interaction.options.getRole('having_role');

    const roleCheck = canManageRole(interaction.guild, interaction.member, role);
    if (!roleCheck.ok) throw new UserError(roleCheck.reason);
    if (filter === 'role' && !havingRole) throw new UserError('Choose the `having_role` option for that filter.');

    const limit = settings.view(interaction.guildId).moderation.massRoleLimit;
    if (interaction.guild.memberCount > 20_000 && filter === 'all') {
      throw new UserError('This server is too large for a mass role on everyone. Use a narrower filter.');
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    const members = await interaction.guild.members.fetch();

    const targets = members.filter((m) => {
      if (filter === 'humans' && m.user.bot) return false;
      if (filter === 'bots' && !m.user.bot) return false;
      if (filter === 'role' && !m.roles.cache.has(havingRole.id)) return false;
      return add ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id);
    });

    if (targets.size === 0) throw new UserError('No members match, nothing to do.');
    if (targets.size > limit) {
      throw new UserError(
        `That would change **${targets.size}** members, but the safety limit is **${limit}**. ` +
          'Use a narrower filter, or raise the limit with `/config moderation`.',
      );
    }

    const ok = await confirm(interaction, {
      description: `${add ? 'Give' : 'Remove'} ${role} ${add ? 'to' : 'from'} **${targets.size}** member(s)?\nThis can take about ${Math.ceil((targets.size * 0.4) / 60)} minute(s).`,
      confirmLabel: 'Start',
    });
    if (!ok) return;

    let done = 0;
    let failed = 0;
    for (const member of targets.values()) {
      try {
        if (add) await member.roles.add(role, `Mass role by ${interaction.user.username}`);
        else await member.roles.remove(role, `Mass role by ${interaction.user.username}`);
        done++;
      } catch {
        failed++;
      }
      await sleep(350); // gentle pacing to respect Discord rate limits
      if ((done + failed) % 25 === 0) {
        await interaction
          .editReply({ embeds: [embeds.info(`Working… ${done + failed}/${targets.size}`)], components: [] })
          .catch(() => {});
      }
    }

    logRoleAction(interaction, `massrole: ${sub} ${role} (${filter}) — ${done} ok, ${failed} failed`, role.id);
    await interaction.editReply({
      embeds: [embeds.success(`Finished. ${done} member(s) updated${failed ? `, ${failed} failed (hierarchy or permissions)` : ''}.`)],
      components: [],
    });
  },
};

module.exports = [nick, roleadd, roleremove, massrole];
