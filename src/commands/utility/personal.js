'use strict';

const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { ts } = require('../../utils/time');
const { stripMentions, truncate } = require('../../utils/text');

const afk = {
  data: guildCommand('afk', 'Mark yourself as away; I will tell people who mention you')
    .addStringOption((o) => o.setName('reason').setDescription('Why you are away').setMaxLength(150)),
  cooldown: 10,
  async execute(interaction) {
    const reason = stripMentions(interaction.options.getString('reason') ?? 'AFK');
    db.run(
      'INSERT INTO afk (guild_id, user_id, reason, since) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, since = excluded.since',
      interaction.guildId, interaction.user.id, reason, Date.now(),
    );
    await interaction.reply({
      embeds: [embeds.success(`You are now AFK: **${truncate(reason, 150)}**\nSend any message to remove your AFK status.`)],
      allowedMentions: { parse: [] },
    });
  },
};

const MAX_ITEMS = 50;

const note = {
  data: guildCommand('note', 'Your private notes (only you can see them)')
    .addSubcommand((s) => s.setName('add').setDescription('Save a note')
      .addStringOption((o) => o.setName('text').setDescription('The note').setRequired(true).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('list').setDescription('List your notes'))
    .addSubcommand((s) => s.setName('view').setDescription('Read one note in full')
      .addIntegerOption((o) => o.setName('id').setDescription('Note ID').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a note')
      .addIntegerOption((o) => o.setName('id').setDescription('Note ID').setRequired(true).setMinValue(1))),
  cooldown: 3,
  prefix: false, // private notes: never answer in a public channel
  async execute(interaction) {
    const uid = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    const reply = (embed) => interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });

    if (sub === 'add') {
      if (db.get('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?', uid).n >= MAX_ITEMS) throw new UserError(`You can store at most ${MAX_ITEMS} notes. Delete some first.`);
      const id = db.run('INSERT INTO notes (user_id, content, created_at) VALUES (?, ?, ?)', uid, interaction.options.getString('text', true), Date.now()).lastInsertRowid;
      return reply(embeds.success(`Saved note \`${id}\`.`));
    }
    if (sub === 'list') {
      const rows = db.all('SELECT * FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 25', uid);
      return reply(embeds.base('📝 Your notes', rows.length ? rows.map((r) => `\`${r.id}\` ${ts(r.created_at, 'd')} — ${truncate(r.content, 80)}`).join('\n') : 'No notes yet. Add one with `/note add`.'));
    }
    const id = interaction.options.getInteger('id', true);
    if (sub === 'view') {
      const row = db.get('SELECT * FROM notes WHERE id = ? AND user_id = ?', id, uid);
      if (!row) throw new UserError('Note not found.');
      return reply(embeds.base(`📝 Note ${id}`, truncate(row.content, 3900)).setFooter({ text: new Date(row.created_at).toISOString().slice(0, 10) }));
    }
    const res = db.run('DELETE FROM notes WHERE id = ? AND user_id = ?', id, uid);
    if (!res.changes) throw new UserError('Note not found.');
    return reply(embeds.success(`Deleted note \`${id}\`.`));
  },
};

const todo = {
  data: guildCommand('todo', 'Your private to-do list (only you can see it)')
    .addSubcommand((s) => s.setName('add').setDescription('Add a task')
      .addStringOption((o) => o.setName('task').setDescription('What to do').setRequired(true).setMaxLength(200)))
    .addSubcommand((s) => s.setName('list').setDescription('Show your tasks'))
    .addSubcommand((s) => s.setName('done').setDescription('Mark a task as done (or undo)')
      .addIntegerOption((o) => o.setName('id').setDescription('Task ID').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a task')
      .addIntegerOption((o) => o.setName('id').setDescription('Task ID').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('clear').setDescription('Delete all finished tasks')),
  cooldown: 3,
  prefix: false, // private to-do list
  async execute(interaction) {
    const uid = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    const reply = (embed) => interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });

    if (sub === 'add') {
      if (db.get('SELECT COUNT(*) AS n FROM todos WHERE user_id = ?', uid).n >= MAX_ITEMS) throw new UserError(`You can have at most ${MAX_ITEMS} tasks.`);
      const id = db.run('INSERT INTO todos (user_id, content, created_at) VALUES (?, ?, ?)', uid, interaction.options.getString('task', true), Date.now()).lastInsertRowid;
      return reply(embeds.success(`Added task \`${id}\`.`));
    }
    if (sub === 'list') {
      const rows = db.all('SELECT * FROM todos WHERE user_id = ? ORDER BY done, id LIMIT 50', uid);
      const text = rows.length ? rows.map((r) => `${r.done ? '✅' : '⬜'} \`${r.id}\` ${r.done ? `~~${truncate(r.content, 150)}~~` : truncate(r.content, 150)}`).join('\n') : 'Nothing to do. Add a task with `/todo add`.';
      return reply(embeds.base('✅ Your to-do list', truncate(text, 4000)));
    }
    if (sub === 'clear') {
      const n = db.get('SELECT COUNT(*) AS n FROM todos WHERE user_id = ? AND done = 1', uid).n;
      if (!n) throw new UserError('You have no finished tasks.');
      const ok = await confirm(interaction, { description: `Delete **${n}** finished task(s)?`, confirmLabel: 'Delete' });
      if (!ok) return undefined;
      db.run('DELETE FROM todos WHERE user_id = ? AND done = 1', uid);
      return interaction.editReply({ embeds: [embeds.success(`Deleted ${n} finished task(s).`)], components: [] });
    }
    const id = interaction.options.getInteger('id', true);
    const row = db.get('SELECT * FROM todos WHERE id = ? AND user_id = ?', id, uid);
    if (!row) throw new UserError('Task not found.');
    if (sub === 'done') {
      db.run('UPDATE todos SET done = ? WHERE id = ?', row.done ? 0 : 1, id);
      return reply(embeds.success(row.done ? `Task \`${id}\` is open again.` : `Task \`${id}\` marked as done. 🎉`));
    }
    db.run('DELETE FROM todos WHERE id = ?', id);
    return reply(embeds.success(`Removed task \`${id}\`.`));
  },
};

module.exports = [afk, note, todo];
