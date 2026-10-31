'use strict';

const { EmbedBuilder } = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const logging = require('./logging');
const audit = require('./audit');
const logger = require('../utils/logger');
const { COLORS } = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { parseDuration, formatDuration, ts } = require('../utils/time');
const { truncate } = require('../utils/text');

const ACTIONS = {
  warn: { label: 'Warning', emoji: '⚠️', color: COLORS.warning },
  kick: { label: 'Kick', emoji: '👢', color: COLORS.warning },
  ban: { label: 'Ban', emoji: '🔨', color: COLORS.danger },
  tempban: { label: 'Temporary ban', emoji: '⏳', color: COLORS.danger },
  unban: { label: 'Unban', emoji: '🕊️', color: COLORS.success },
  timeout: { label: 'Timeout', emoji: '🔇', color: COLORS.warning },
  untimeout: { label: 'Timeout removed', emoji: '🔊', color: COLORS.success },
  clearwarnings: { label: 'Warnings cleared', emoji: '🧹', color: COLORS.info },
  automod: { label: 'AutoMod', emoji: '🤖', color: COLORS.warning },
};

const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Reads the "reason" option, applying the server's "require reason" rule. */
function getReason(interaction, { required = false } = {}) {
  const raw = interaction.options.getString('reason');
  const reason = raw ? truncate(raw.trim(), 400) : null;
  const mustHave = required || settings.view(interaction.guildId).moderation.requireReason;
  if (mustHave && !reason) throw new UserError('This server requires a reason for moderation actions. Add the `reason` option.');
  return reason;
}

/** Text placed in Discord's own audit log (max 512 chars). */
function auditReason(interaction, reason) {
  return truncate(`${interaction.user.username}: ${reason ?? 'No reason provided'}`, 500);
}

function getCase(guildId, caseNumber) {
  return db.get('SELECT * FROM cases WHERE guild_id = ? AND case_number = ?', guildId, caseNumber);
}

function caseEmbed(c) {
  const meta = ACTIONS[c.action] ?? { label: c.action, emoji: '📌', color: COLORS.primary };
  const e = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Case #${c.case_number} — ${meta.label}`)
    .addFields(
      { name: 'User', value: `<@${c.user_id}> (\`${c.user_id}\`)`, inline: true },
      { name: 'Moderator', value: `<@${c.moderator_id}>`, inline: true },
      { name: 'Reason', value: truncate(c.reason || 'No reason provided', 1000) },
    )
    .setTimestamp(c.created_at);
  if (c.duration_ms) e.addFields({ name: 'Duration', value: formatDuration(c.duration_ms), inline: true });
  if (c.expires_at) e.addFields({ name: 'Expires', value: ts(c.expires_at, 'R'), inline: true });
  return e;
}

/**
 * Records a moderation case (numbered per server) and posts it to the moderation log channel.
 * @returns the stored case row
 */
function createCase({ guild, userId, moderatorId, action, reason = null, durationMs = null }) {
  const now = Date.now();
  const row = db.transaction(() => {
    const { n } = db.get('SELECT COALESCE(MAX(case_number), 0) + 1 AS n FROM cases WHERE guild_id = ?', guild.id);
    const result = db.run(
      `INSERT INTO cases (guild_id, case_number, user_id, moderator_id, action, reason, duration_ms, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guild.id,
      n,
      userId,
      moderatorId,
      action,
      reason,
      durationMs,
      durationMs ? now + durationMs : null,
      now,
    );
    return db.get('SELECT * FROM cases WHERE id = ?', result.lastInsertRowid);
  });

  audit.record(guild.id, moderatorId, `mod.${action}`, userId, reason);

  logging
    .send(guild, 'moderation', caseEmbed(row))
    .then((msg) => {
      if (msg) {
        db.run('UPDATE cases SET log_channel_id = ?, log_message_id = ? WHERE id = ?', msg.channelId, msg.id, row.id);
      }
    })
    .catch((err) => logger.warn('Could not store case log message:', err.message));

  return row;
}

/** Updates a case's reason and edits its log message when it still exists. */
async function updateCaseReason(guild, caseNumber, reason, editorId) {
  const c = getCase(guild.id, caseNumber);
  if (!c) return null;
  db.run('UPDATE cases SET reason = ? WHERE id = ?', reason, c.id);
  audit.record(guild.id, editorId, 'mod.reason', `case ${caseNumber}`, reason);
  const updated = { ...c, reason };
  if (c.log_channel_id && c.log_message_id) {
    try {
      const channel = await guild.channels.fetch(c.log_channel_id);
      const message = await channel.messages.fetch(c.log_message_id);
      await message.edit({ embeds: [caseEmbed(updated)] });
    } catch {
      /* log message deleted or channel unreachable */
    }
  }
  return updated;
}

/** Sends the user a DM about an action when the server allows it. Never throws. */
async function dmUser(user, guild, { action, reason, durationMs }) {
  if (!settings.view(guild.id).moderation.dmOnAction) return false;
  const meta = ACTIONS[action] ?? { label: action, emoji: '📌', color: COLORS.primary };
  const e = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${meta.label} in ${guild.name}`)
    .addFields({ name: 'Reason', value: truncate(reason || 'No reason provided', 1000) })
    .setTimestamp();
  if (durationMs) e.addFields({ name: 'Duration', value: formatDuration(durationMs) });
  try {
    await user.send({ embeds: [e] });
    return true;
  } catch {
    return false;
  }
}

function activeWarnings(guildId, userId) {
  return db.all(
    'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1 ORDER BY id DESC',
    guildId,
    userId,
  );
}

/** Adds a warning + case and applies configured thresholds. Returns { warning, caseRow, count, punishment }. */
async function addWarning({ guild, member, moderatorId, reason }) {
  const now = Date.now();
  const caseRow = createCase({ guild, userId: member.id, moderatorId, action: 'warn', reason });
  const result = db.run(
    'INSERT INTO warnings (guild_id, user_id, moderator_id, reason, case_number, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guild.id,
    member.id,
    moderatorId,
    reason,
    caseRow.case_number,
    now,
  );
  const count = activeWarnings(guild.id, member.id).length;
  const punishment = await applyThresholds(guild, member, count);
  return { warningId: result.lastInsertRowid, caseRow, count, punishment };
}

/** Fires the automatic punishment whose warning count equals `count`. */
async function applyThresholds(guild, member, count) {
  const rule = settings.view(guild.id).moderation.warnThresholds.find((t) => t.count === count);
  if (!rule) return null;
  const botId = guild.client.user.id;
  const reason = `Automatic: reached ${count} warnings`;
  try {
    if (rule.action === 'timeout') {
      const ms = Math.min(parseDuration(rule.duration) ?? 3_600_000, MAX_TIMEOUT_MS);
      if (!member.moderatable) return null;
      await dmUser(member.user, guild, { action: 'timeout', reason, durationMs: ms });
      await member.timeout(ms, reason);
      createCase({ guild, userId: member.id, moderatorId: botId, action: 'timeout', reason, durationMs: ms });
      return `timed out for ${formatDuration(ms)}`;
    }
    if (rule.action === 'kick') {
      if (!member.kickable) return null;
      await dmUser(member.user, guild, { action: 'kick', reason });
      await member.kick(reason);
      createCase({ guild, userId: member.id, moderatorId: botId, action: 'kick', reason });
      return 'kicked';
    }
    if (rule.action === 'ban') {
      if (!member.bannable) return null;
      await dmUser(member.user, guild, { action: 'ban', reason });
      await member.ban({ reason });
      createCase({ guild, userId: member.id, moderatorId: botId, action: 'ban', reason });
      return 'banned';
    }
  } catch (err) {
    logger.warn(`Warning threshold action failed in ${guild.id}: ${err.message}`);
  }
  return null;
}

module.exports = {
  ACTIONS,
  MAX_TIMEOUT_MS,
  getReason,
  auditReason,
  getCase,
  caseEmbed,
  createCase,
  updateCaseReason,
  dmUser,
  activeWarnings,
  addWarning,
  applyThresholds,
};
