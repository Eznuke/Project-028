'use strict';

const {
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const db = require('../../database');
const embeds = require('../../utils/embeds');
const logging = require('../../services/logging');
const mod = require('../../services/moderation');
const audit = require('../../services/audit');
const { UserError } = require('../../utils/errors');
const { paginate } = require('../../utils/pagination');
const { ts } = require('../../utils/time');
const { truncate, chunk } = require('../../utils/text');

const P = PermissionFlagsBits;

const modlogs = {
  data: guildCommand('modlogs', 'Show the moderation history of a user', P.ModerateMembers).addUserOption((o) =>
    o.setName('user').setDescription('User').setRequired(true),
  ),
  cooldown: 5,
  userPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const rows = db.all(
      'SELECT * FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY case_number DESC',
      interaction.guildId,
      user.id,
    );
    if (rows.length === 0) {
      await interaction.reply({ embeds: [embeds.info(`No moderation cases for **${user.username}**.`)], flags: EPHEMERAL });
      return;
    }
    const pages = chunk(rows, 6).map((group) =>
      embeds.base(
        `Moderation history — ${user.username}`,
        group
          .map((c) => {
            const meta = mod.ACTIONS[c.action] ?? { emoji: '📌', label: c.action };
            return `${meta.emoji} **#${c.case_number} ${meta.label}** — ${ts(c.created_at, 'd')} by <@${c.moderator_id}>\n${truncate(c.reason || 'No reason provided', 200)}`;
          })
          .join('\n\n'),
      ).setFooter({ text: `${rows.length} case(s) in total` }),
    );
    await paginate(interaction, pages, { ephemeral: true });
  },
};

const caseCommand = {
  data: guildCommand('case', 'Look up a moderation case by number', P.ModerateMembers).addIntegerOption((o) =>
    o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1),
  ),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const number = interaction.options.getInteger('number', true);
    const c = mod.getCase(interaction.guildId, number);
    if (!c) throw new UserError(`Case #${number} does not exist.`);
    await interaction.reply({ embeds: [mod.caseEmbed(c)], flags: EPHEMERAL });
  },
};

const reason = {
  data: guildCommand('reason', 'Change the reason of an existing case', P.ModerateMembers)
    .addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(400)),
  cooldown: 3,
  userPermissions: [P.ModerateMembers],

  async execute(interaction) {
    const number = interaction.options.getInteger('number', true);
    const text = interaction.options.getString('reason', true).trim();
    const updated = await mod.updateCaseReason(interaction.guild, number, text, interaction.user.id);
    if (!updated) throw new UserError(`Case #${number} does not exist.`);
    await interaction.reply({ embeds: [embeds.success(`Updated the reason of case #${number}.`)], flags: EPHEMERAL });
  },
};

const REPORT_STATUS = { open: '🟡 Open', resolved: '🟢 Resolved', dismissed: '⚪ Dismissed' };

function reportEmbed(r) {
  const e = new EmbedBuilder()
    .setColor(r.status === 'open' ? embeds.COLORS.warning : embeds.COLORS.neutral)
    .setTitle(`🚩 Report #${r.id} — ${REPORT_STATUS[r.status] ?? r.status}`)
    .addFields(
      { name: 'Reported user', value: `<@${r.target_id}> (\`${r.target_id}\`)`, inline: true },
      { name: 'Reported by', value: `<@${r.reporter_id}>`, inline: true },
      { name: 'Reason', value: truncate(r.reason, 1000) },
    )
    .setTimestamp(r.created_at);
  if (r.message_link) e.addFields({ name: 'Message', value: truncate(r.message_link, 500) });
  return e;
}

const report = {
  data: guildCommand('report', 'Report a member to the moderators')
    .addUserOption((o) => o.setName('user').setDescription('Who are you reporting?').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('What happened?').setRequired(true).setMaxLength(800))
    .addStringOption((o) => o.setName('message_link').setDescription('Link to the message (optional)').setMaxLength(200)),
  cooldown: 60,

  async execute(interaction) {
    const target = interaction.options.getUser('user', true);
    const text = interaction.options.getString('reason', true).trim();
    const link = interaction.options.getString('message_link')?.trim() || null;
    if (target.id === interaction.user.id) throw new UserError('You cannot report yourself.');
    if (target.bot) throw new UserError('You cannot report bots. Ask a moderator instead.');
    if (link && !/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+$/.test(link)) {
      throw new UserError('That does not look like a Discord message link.');
    }

    const result = db.run(
      'INSERT INTO reports (guild_id, reporter_id, target_id, reason, message_link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      interaction.guildId,
      interaction.user.id,
      target.id,
      text,
      link,
      Date.now(),
    );
    const row = db.get('SELECT * FROM reports WHERE id = ?', result.lastInsertRowid);

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`report:resolved:${row.id}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`report:dismissed:${row.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
    );
    const sent = await logging.send(interaction.guild, 'moderation', reportEmbed(row), { components: [buttons] });

    audit.record(interaction.guildId, interaction.user.id, 'report', target.id, text);
    await interaction.reply({
      embeds: [
        embeds.success(
          sent
            ? 'Thanks, your report was sent to the moderators.'
            : 'Your report was saved, but this server has no moderation log channel set up yet, so moderators may not see it right away.',
        ),
      ],
      flags: EPHEMERAL,
    });
  },

  components: {
    async report(interaction, args) {
      if (!interaction.memberPermissions?.has(P.ModerateMembers)) {
        throw new UserError('Only moderators can handle reports.');
      }
      const [status, idText] = args;
      const id = Number.parseInt(idText, 10);
      if (!['resolved', 'dismissed'].includes(status) || !Number.isInteger(id)) throw new UserError('Invalid report action.');

      const row = db.get('SELECT * FROM reports WHERE id = ? AND guild_id = ?', id, interaction.guildId);
      if (!row) throw new UserError('That report no longer exists.');
      db.run('UPDATE reports SET status = ? WHERE id = ?', status, id);
      audit.record(interaction.guildId, interaction.user.id, `report.${status}`, String(id));

      await interaction.update({
        embeds: [reportEmbed({ ...row, status }).setFooter({ text: `${REPORT_STATUS[status]} by ${interaction.user.username}` })],
        components: [],
      });
    },
  },
};

module.exports = [modlogs, caseCommand, reason, report];
