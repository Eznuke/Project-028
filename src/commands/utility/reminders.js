'use strict';

const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const prefs = require('../../services/userprefs');
const { UserError } = require('../../utils/errors');
const { parseDuration, formatDuration, ts, isValidTimezone, formatInZone } = require('../../utils/time');
const { parseLocalDateTime } = require('../../utils/zone');
const { stripMentions, truncate } = require('../../utils/text');

const MAX_PENDING = 25;

function pendingCount(userId, kind) {
  const sql = kind
    ? 'SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND sent = 0 AND kind = ?'
    : 'SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND sent = 0';
  return (kind ? db.get(sql, userId, kind) : db.get(sql, userId)).n;
}

function addReminder({ userId, guildId, channelId, message, kind, at }) {
  return db.run(
    'INSERT INTO reminders (user_id, guild_id, channel_id, message, kind, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, guildId, channelId, message, kind, at, Date.now(),
  ).lastInsertRowid;
}

const remindme = {
  data: guildCommand('remindme', 'Set, list or delete reminders (they survive bot restarts)')
    .addSubcommand((s) => s.setName('set').setDescription('Remind me later')
      .addStringOption((o) => o.setName('in').setDescription('When, e.g. 10m, 2h30m, 1d').setRequired(true).setMaxLength(20))
      .addStringOption((o) => o.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(500))
      .addBooleanOption((o) => o.setName('dm').setDescription('Send the reminder by DM instead of this channel')))
    .addSubcommand((s) => s.setName('list').setDescription('Show your pending reminders and timers'))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a pending reminder or timer')
      .addIntegerOption((o) => o.setName('id').setDescription('ID from /remindme list').setRequired(true).setMinValue(1))),
  cooldown: 3,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;

    if (sub === 'set') {
      const ms = parseDuration(interaction.options.getString('in', true));
      if (!ms || ms < 10_000 || ms > 365 * 86_400_000) throw new UserError('Use a duration between 10 seconds and 365 days, like `45m`, `2h30m` or `3d`.');
      if (pendingCount(uid) >= MAX_PENDING) throw new UserError(`You already have ${MAX_PENDING} pending reminders. Delete some with \`/remindme delete\`.`);
      const at = Date.now() + ms;
      const id = addReminder({
        userId: uid,
        guildId: interaction.guildId,
        channelId: interaction.options.getBoolean('dm') ? null : interaction.channelId,
        message: stripMentions(interaction.options.getString('message', true)),
        kind: 'reminder',
        at,
      });
      await interaction.reply({ embeds: [embeds.success(`I will remind you ${ts(at, 'R')} (${ts(at, 'f')}).\nReminder ID: \`${id}\``)], flags: EPHEMERAL });
      return;
    }

    if (sub === 'list') {
      const rows = db.all('SELECT * FROM reminders WHERE user_id = ? AND sent = 0 ORDER BY remind_at LIMIT 25', uid);
      const text = rows.length
        ? rows.map((r) => `\`${r.id}\` ${r.kind === 'timer' ? '⏲️' : r.kind === 'countdown' ? '🎉' : '⏰'} ${ts(r.remind_at, 'R')} — ${truncate(r.message, 80)}`).join('\n')
        : 'You have no pending reminders.';
      await interaction.reply({ embeds: [embeds.base('⏰ Your reminders', text)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    const id = interaction.options.getInteger('id', true);
    const res = db.run('DELETE FROM reminders WHERE id = ? AND user_id = ? AND sent = 0', id, uid);
    if (!res.changes) throw new UserError('I could not find a pending reminder with that ID (it may already be done).');
    await interaction.reply({ embeds: [embeds.success(`Deleted reminder \`${id}\`.`)], flags: EPHEMERAL });
  },
};

const timer = {
  data: guildCommand('timer', 'Start a timer (up to 24 hours) and get pinged when it ends')
    .addStringOption((o) => o.setName('duration').setDescription('For example 90s, 25m, 1h30m').setRequired(true).setMaxLength(20))
    .addStringOption((o) => o.setName('label').setDescription('What is it for? (default: Timer)').setMaxLength(100)),
  cooldown: 5,
  async execute(interaction) {
    const ms = parseDuration(interaction.options.getString('duration', true));
    if (!ms || ms < 5_000 || ms > 86_400_000) throw new UserError('A timer must be between 5 seconds and 24 hours, like `90s`, `25m` or `1h30m`.');
    if (pendingCount(interaction.user.id, 'timer') >= 5) throw new UserError('You can run at most 5 timers at once.');
    const label = stripMentions(interaction.options.getString('label') ?? 'Timer');
    const at = Date.now() + ms;
    const id = addReminder({ userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId, message: label, kind: 'timer', at });
    await interaction.reply({
      embeds: [embeds.base('⏲️ Timer started', `**${truncate(label, 100)}** — ${formatDuration(ms)}\nEnds ${ts(at, 'R')}\n\nCancel it with \`/remindme delete id:${id}\`.`)],
      allowedMentions: { parse: [] },
    });
  },
};

const countdown = {
  data: guildCommand('countdown', 'Create a live countdown to a date (uses your time zone)')
    .addStringOption((o) => o.setName('event').setDescription('Name of the event').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('date').setDescription('Date as YYYY-MM-DD or YYYY-MM-DD HH:mm (your time zone)').setRequired(true).setMaxLength(20))
    .addBooleanOption((o) => o.setName('remind').setDescription('Ping me when the countdown ends')),
  cooldown: 10,
  async execute(interaction) {
    const tz = prefs.getTimezone(interaction.user.id, interaction.guildId);
    const at = parseLocalDateTime(interaction.options.getString('date', true), tz);
    if (at === null) throw new UserError('Use the format `YYYY-MM-DD` or `YYYY-MM-DD HH:mm`, for example `2026-12-31 23:59`.');
    if (at <= Date.now()) throw new UserError('That moment is already in the past.');
    if (at > Date.now() + 5 * 365 * 86_400_000) throw new UserError('Countdowns can be at most 5 years away.');
    const event = stripMentions(interaction.options.getString('event', true));

    let extra = '';
    if (interaction.options.getBoolean('remind')) {
      if (pendingCount(interaction.user.id) >= MAX_PENDING) throw new UserError(`You already have ${MAX_PENDING} pending reminders.`);
      addReminder({ userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId, message: event, kind: 'countdown', at });
      extra = '\n🔔 I will ping you when it is time.';
    }
    await interaction.reply({
      embeds: [embeds.base(`🎉 ${truncate(event, 100)}`, `Starts ${ts(at, 'R')}\n📅 ${ts(at, 'F')}\n🕒 Your zone (${tz}): ${formatInZone(new Date(at), tz)}${extra}`)],
      allowedMentions: { parse: [] },
    });
  },
};

const ALL_ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

const timezone = {
  data: guildCommand('timezone', 'Set the time zone used by /countdown and time displays')
    .addSubcommand((s) => s.setName('set').setDescription('Set your time zone')
      .addStringOption((o) => o.setName('zone').setDescription('IANA name, e.g. Asia/Jakarta, Europe/London, America/New_York').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('view').setDescription('Show your time zone and current local time'))
    .addSubcommand((s) => s.setName('reset').setDescription('Forget your time zone (use the server default)')),
  cooldown: 3,
  async autocomplete(interaction) {
    const q = String(interaction.options.getFocused()).toLowerCase().replace(/\s+/g, '_');
    const matches = ALL_ZONES.filter((z) => z.toLowerCase().includes(q)).slice(0, 25);
    await interaction.respond(matches.map((z) => ({ name: z, value: z })));
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const uid = interaction.user.id;
    if (sub === 'set') {
      const zone = interaction.options.getString('zone', true).trim();
      const canonical = ALL_ZONES.find((z) => z.toLowerCase() === zone.toLowerCase()) ?? (isValidTimezone(zone) ? zone : null);
      if (!canonical) throw new UserError('Unknown time zone. Pick one from the autocomplete list (for example `Asia/Jakarta`).');
      prefs.setTimezone(uid, canonical);
      await interaction.reply({ embeds: [embeds.success(`Your time zone is now **${canonical}**.\nLocal time: ${formatInZone(new Date(), canonical)}`)], flags: EPHEMERAL });
    } else if (sub === 'reset') {
      prefs.clearTimezone(uid);
      await interaction.reply({ embeds: [embeds.success('Your personal time zone was cleared.')], flags: EPHEMERAL });
    } else {
      const zone = prefs.getTimezone(uid, interaction.guildId);
      await interaction.reply({ embeds: [embeds.info(`Time zone: **${zone}**\nLocal time: ${formatInZone(new Date(), zone)}`, '🕒 Your time zone')], flags: EPHEMERAL });
    }
  },
};

module.exports = [remindme, timer, countdown, timezone];
