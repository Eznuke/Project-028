'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');
const embeds = require('../utils/embeds');
const { ts } = require('../utils/time');
const { chunk, truncate, escapeMarkdown } = require('../utils/text');

const getPoll = (id) => db.get('SELECT * FROM polls WHERE id = ?', id);

function counts(poll) {
  const options = JSON.parse(poll.options);
  const rows = db.all('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index', poll.id);
  const result = options.map(() => 0);
  for (const r of rows) if (r.option_index < result.length) result[r.option_index] = r.n;
  const voters = db.get('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE poll_id = ?', poll.id).n;
  return { options, result, voters };
}

/** Builds the message payload (embed + vote buttons) for a poll. */
function render(poll) {
  const { options, result, voters } = counts(poll);
  const total = result.reduce((a, b) => a + b, 0) || 1;
  const lines = options.map((text, i) => {
    const pct = Math.round((result[i] / total) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `**${i + 1}.** ${escapeMarkdown(text)}\n\`${bar}\` ${result[i]} vote(s) • ${pct}%`;
  });
  const closed = !!poll.closed;
  const info = [
    poll.multi ? 'Multiple choice' : 'Single choice',
    `${voters} voter(s)`,
    closed ? 'closed' : poll.ends_at ? `ends ${ts(poll.ends_at, 'R')}` : 'open until ended manually',
  ].join(' • ');
  const embed = embeds
    .base(`📊 ${truncate(poll.question, 250)}`, `${lines.join('\n\n')}\n\n*${info}*`, closed ? embeds.COLORS.neutral : embeds.COLORS.primary)
    .setFooter({ text: `Poll #${poll.id}` });

  const buttons = options.map((_t, i) =>
    new ButtonBuilder().setCustomId(`poll:${poll.id}:${i}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Primary).setDisabled(closed));
  const components = chunk(buttons, 5).map((part) => new ActionRowBuilder().addComponents(part));
  return { embeds: [embed], components };
}

/** Edits the poll message to its final, closed state. Never throws. */
async function closeMessage(client, row) {
  try {
    const channel = client.channels.cache.get(row.channel_id) ?? (await client.channels.fetch(row.channel_id).catch(() => null));
    if (!channel?.isTextBased() || !row.message_id) return;
    const message = await channel.messages.fetch(row.message_id).catch(() => null);
    if (message) await message.edit({ ...render({ ...row, closed: 1 }), allowedMentions: { parse: [] } });
  } catch {
    /* the message may have been deleted */
  }
}

module.exports = { getPoll, counts, render, closeMessage };
