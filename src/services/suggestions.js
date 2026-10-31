'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { ts } = require('../utils/time');
const { truncate } = require('../utils/text');

const STATUS = {
  pending: { label: 'Pending review', emoji: '🕓', color: embeds.COLORS.primary },
  approved: { label: 'Approved', emoji: '✅', color: embeds.COLORS.success },
  rejected: { label: 'Rejected', emoji: '❌', color: embeds.COLORS.danger },
  implemented: { label: 'Implemented', emoji: '🚀', color: 0x9b59b6 },
};

const get = (id) => db.get('SELECT * FROM suggestions WHERE id = ?', id);

function tally(id) {
  const rows = db.all('SELECT vote, COUNT(*) AS n FROM suggestion_votes WHERE suggestion_id = ? GROUP BY vote', id);
  return { up: rows.find((r) => r.vote === 1)?.n ?? 0, down: rows.find((r) => r.vote === -1)?.n ?? 0 };
}

function history(id, limit = 20) {
  return db.all('SELECT * FROM suggestion_history WHERE suggestion_id = ? ORDER BY id DESC LIMIT ?', id, limit);
}

function addHistory(id, actorId, action, note = null) {
  db.run(
    'INSERT INTO suggestion_history (suggestion_id, actor_id, action, note, created_at) VALUES (?, ?, ?, ?, ?)',
    id, actorId, action, note ? truncate(note, 500) : null, Date.now(),
  );
}

/** The message payload (embed + buttons) for a suggestion. */
function render(s) {
  const st = STATUS[s.status] ?? STATUS.pending;
  const cfg = settings.view(s.guild_id).suggestions;
  const votes = tally(s.id);
  const embed = embeds
    .base(`💡 Suggestion #${s.id}`, truncate(s.content, 3900), st.color)
    .addFields(
      { name: 'Status', value: `${st.emoji} ${st.label}`, inline: true },
      { name: 'Votes', value: `👍 **${votes.up}** • 👎 **${votes.down}**`, inline: true },
    )
    .setFooter({ text: `Submitted ${new Date(s.created_at).toISOString().slice(0, 10)}` });
  if (!cfg.anonymous) embed.addFields({ name: 'Suggested by', value: `<@${s.user_id}>`, inline: true });
  if (s.staff_note) {
    const last = db.get("SELECT actor_id FROM suggestion_history WHERE suggestion_id = ? AND action != 'created' ORDER BY id DESC LIMIT 1", s.id);
    embed.addFields({ name: `Staff response${last ? ` (by <@${last.actor_id}>)` : ''}`, value: truncate(s.staff_note, 1000) });
  }

  const votingOpen = s.status === 'pending' || s.status === 'approved';
  const voteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sug:vote:${s.id}:1`).setEmoji('👍').setLabel('Upvote').setStyle(ButtonStyle.Success).setDisabled(!votingOpen),
    new ButtonBuilder().setCustomId(`sug:vote:${s.id}:-1`).setEmoji('👎').setLabel('Downvote').setStyle(ButtonStyle.Danger).setDisabled(!votingOpen),
  );
  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sug:staff:${s.id}:approved`).setLabel('Approve').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sug:staff:${s.id}:rejected`).setLabel('Reject').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sug:staff:${s.id}:implemented`).setLabel('Implemented').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [voteRow, staffRow], allowedMentions: { parse: [] } };
}

/** Creates a suggestion and posts it in the configured channel. */
async function create(guild, user, content) {
  const cfg = settings.view(guild.id).suggestions;
  if (!cfg.channelId) throw new UserError('Suggestions are not set up yet. An admin must run `/config suggestions` and choose a channel.');
  const channel = guild.channels.cache.get(cfg.channelId) ?? (await guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel?.isTextBased()) throw new UserError('The suggestions channel no longer exists. An admin must set it again.');
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new UserError(`I cannot post in <#${channel.id}>. Give me View Channel, Send Messages and Embed Links there.`);
  }
  const text = content.trim();
  if (text.length < 10) throw new UserError('Please write at least 10 characters.');
  if (text.length > 1500) throw new UserError('Please keep suggestions under 1500 characters.');

  const now = Date.now();
  const id = db.run(
    'INSERT INTO suggestions (guild_id, channel_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    guild.id, channel.id, user.id, text, now, now,
  ).lastInsertRowid;
  addHistory(id, user.id, 'created');
  const message = await channel.send(render(get(id)));
  db.run('UPDATE suggestions SET message_id = ? WHERE id = ?', message.id, id);
  return { id, message };
}

/** Applies a staff decision, edits the message and notifies the log channel. */
async function decide(interaction, id, status, note) {
  const s = get(id);
  if (!s || s.guild_id !== interaction.guildId) throw new UserError('That suggestion no longer exists.');
  if (!STATUS[status] || status === 'pending') throw new UserError('Invalid status.');
  db.run('UPDATE suggestions SET status = ?, staff_note = ?, updated_at = ? WHERE id = ?', status, note || null, Date.now(), id);
  addHistory(id, interaction.user.id, status, note);
  const updated = get(id);

  const cfg = settings.view(s.guild_id).suggestions;
  if (cfg.logChannelId) {
    const channel = interaction.guild.channels.cache.get(cfg.logChannelId);
    if (channel?.isTextBased()) {
      const st = STATUS[status];
      await channel
        .send({
          embeds: [embeds.base(`${st.emoji} Suggestion #${id} ${st.label.toLowerCase()}`, `${truncate(s.content, 500)}\n\nBy ${interaction.user}${note ? `\n**Note:** ${truncate(note, 500)}` : ''}\n[Jump to suggestion](https://discord.com/channels/${s.guild_id}/${s.channel_id}/${s.message_id}) • ${ts(Date.now(), 'R')}`, st.color)],
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
  }
  return updated;
}

module.exports = { STATUS, get, tally, history, addHistory, render, create, decide };
