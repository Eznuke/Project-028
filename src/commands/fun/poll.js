'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const polls = require('../../services/polls');
const { UserError } = require('../../utils/errors');
const { parseDuration } = require('../../utils/time');
const { stripMentions } = require('../../utils/text');

const poll = {
  data: guildCommand('poll', 'Create a poll with voting buttons')
    .addSubcommand((s) => s.setName('create').setDescription('Create a poll')
      .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(250))
      .addStringOption((o) => o.setName('options').setDescription('2-10 options separated by | (e.g. Yes | No | Maybe)').setRequired(true).setMaxLength(900))
      .addStringOption((o) => o.setName('duration').setDescription('Auto-close after, e.g. 30m, 12h, 2d (default: manual)'))
      .addBooleanOption((o) => o.setName('multiple').setDescription('Allow voting for several options')))
    .addSubcommand((s) => s.setName('end').setDescription('Close one of your polls early')
      .addIntegerOption((o) => o.setName('id').setDescription('Poll number (shown in the poll footer)').setRequired(true).setMinValue(1))),
  cooldown: 10,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;

    if (sub === 'end') {
      const row = polls.getPoll(interaction.options.getInteger('id', true));
      if (!row || row.guild_id !== g) throw new UserError('I could not find that poll in this server.');
      if (row.closed) throw new UserError('That poll is already closed.');
      if (row.created_by !== interaction.user.id && !interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        throw new UserError('Only the poll creator or a moderator can end it.');
      }
      db.run('UPDATE polls SET closed = 1 WHERE id = ?', row.id);
      await polls.closeMessage(interaction.client, polls.getPoll(row.id));
      await interaction.reply({ embeds: [embeds.success(`Poll #${row.id} closed.`)], flags: EPHEMERAL });
      return;
    }

    const options = [...new Set(interaction.options.getString('options', true).split('|').map((s) => stripMentions(s.trim())).filter(Boolean))];
    if (options.length < 2 || options.length > 10) throw new UserError('A poll needs between 2 and 10 different options, separated by `|`.');
    if (options.some((o) => o.length > 80)) throw new UserError('Each option can be at most 80 characters.');

    let endsAt = null;
    const durationText = interaction.options.getString('duration');
    if (durationText) {
      const ms = parseDuration(durationText);
      if (!ms || ms < 60_000 || ms > 30 * 86_400_000) throw new UserError('Duration must be between 1 minute and 30 days (e.g. `30m`, `12h`, `2d`).');
      endsAt = Date.now() + ms;
    }
    const open = db.get('SELECT COUNT(*) AS n FROM polls WHERE guild_id = ? AND closed = 0', g).n;
    if (open >= 25) throw new UserError('This server already has 25 open polls. Close some first.');

    const id = db.run(
      `INSERT INTO polls (guild_id, channel_id, question, options, multi, created_by, ends_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      g, interaction.channelId, stripMentions(interaction.options.getString('question', true)), JSON.stringify(options),
      interaction.options.getBoolean('multiple') ? 1 : 0, interaction.user.id, endsAt, Date.now(),
    ).lastInsertRowid;

    await interaction.reply({ ...polls.render(polls.getPoll(id)), allowedMentions: { parse: [] } });
    const message = await interaction.fetchReply();
    db.run('UPDATE polls SET message_id = ? WHERE id = ?', message.id, id);
  },

  components: {
    async poll(interaction, args) {
      const [pollId, optionIndex] = args.map(Number);
      const row = polls.getPoll(pollId);
      if (!row || row.closed) {
        return interaction.reply({ content: 'This poll is closed.', flags: MessageFlags.Ephemeral });
      }
      if (row.ends_at && row.ends_at <= Date.now()) {
        return interaction.reply({ content: 'This poll has ended.', flags: MessageFlags.Ephemeral });
      }
      const optionCount = JSON.parse(row.options).length;
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) return undefined;

      const uid = interaction.user.id;
      const has = db.get('SELECT 1 AS x FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?', pollId, uid, optionIndex);
      db.transaction(() => {
        if (has) {
          db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?', pollId, uid, optionIndex);
        } else {
          if (!row.multi) db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', pollId, uid);
          db.run('INSERT INTO poll_votes (poll_id, user_id, option_index) VALUES (?, ?, ?)', pollId, uid, optionIndex);
        }
      });
      await interaction.update({ ...polls.render(row), allowedMentions: { parse: [] } });
      return undefined;
    },
  },
};

module.exports = [poll];
