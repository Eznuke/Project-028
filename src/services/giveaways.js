'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const leveling = require('./leveling');
const { ts } = require('../utils/time');
const { truncate } = require('../utils/text');

const get = (id) => db.get('SELECT * FROM giveaways WHERE id = ?', id);
const entryCount = (id) => db.get('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?', id).n;
const winnersOf = (row) => { try { return JSON.parse(row.winner_ids); } catch { return []; } };

/** What a member needs to enter, as readable lines. */
function requirementLines(row) {
  const lines = [];
  if (row.required_role_id) lines.push(`Role <@&${row.required_role_id}>`);
  if (row.min_level > 0) lines.push(`Level ${row.min_level}+`);
  return lines;
}

/** Message payload (embed + enter button) for a giveaway in any state. */
function render(row) {
  const active = row.status === 'active';
  const winners = winnersOf(row);
  const n = entryCount(row.id);
  const req = requirementLines(row);

  const lines = [`**Hosted by:** <@${row.host_id}>`, `**Winners:** ${row.winner_count}`, `**Entries:** ${n}`];
  if (req.length) lines.push(`**Requires:** ${req.join(' · ')}`);
  if (active) lines.push(`**Ends:** ${ts(row.ends_at, 'R')} (${ts(row.ends_at, 'f')})`);
  else if (row.status === 'cancelled') lines.push('**Cancelled** — no winners.');
  else lines.push(`**Ended:** ${ts(row.ended_at ?? row.ends_at, 'R')}`, winners.length ? `**Winner${winners.length > 1 ? 's' : ''}:** ${winners.map((id) => `<@${id}>`).join(', ')}` : '**Winners:** nobody entered');

  const color = active ? embeds.COLORS.primary : row.status === 'cancelled' ? embeds.COLORS.danger : embeds.COLORS.neutral;
  const embed = embeds.base(`🎁 ${truncate(row.prize, 200)}`, lines.join('\n'), color).setFooter({ text: `Giveaway #${row.id}` });
  const button = new ButtonBuilder()
    .setCustomId(`gw:enter:${row.id}`)
    .setLabel(active ? `Enter (${n})` : row.status === 'cancelled' ? 'Cancelled' : 'Ended')
    .setEmoji('🎉')
    .setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!active);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: [] } };
}

/** Why this member may not enter right now, or null. */
function entryProblem(row, member) {
  if (row.status !== 'active' || row.ends_at <= Date.now()) return 'This giveaway has ended.';
  if (row.required_role_id && !member.roles.cache.has(row.required_role_id)) return `You need the <@&${row.required_role_id}> role to enter.`;
  if (row.min_level > 0) {
    const level = leveling.progress(leveling.getRow(row.guild_id, member.id)?.xp ?? 0).level;
    if (level < row.min_level) return `You need level **${row.min_level}** to enter (you are level ${level}).`;
  }
  return null;
}

/** Uniformly random pick without replacement (crypto-grade). */
function pickRandom(list, count) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return out;
}

/** Entrants who are still in the server and still meet the requirements. */
async function eligibleEntrants(guild, row, exclude = []) {
  const ids = db.all('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', row.id).map((r) => r.user_id).filter((id) => !exclude.includes(id));
  const ok = [];
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member || member.user.bot) continue;
    if (row.required_role_id && !member.roles.cache.has(row.required_role_id)) continue;
    ok.push(id);
  }
  return ok;
}

async function fetchMessage(client, row) {
  const channel = client.channels.cache.get(row.channel_id) ?? (await client.channels.fetch(row.channel_id).catch(() => null));
  if (!channel?.isTextBased()) return { channel: null, message: null };
  const message = row.message_id ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  return { channel, message };
}

function canPost(channel, me) {
  return channel?.permissionsFor?.(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
}

/**
 * Ends an active giveaway: picks winners, edits the message, announces. Safe to call twice (the status
 * change is the lock). Returns the winners' user IDs, or null if it was not active.
 */
async function end(client, id, { cancel = false } = {}) {
  const claimed = db.run(
    "UPDATE giveaways SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'",
    cancel ? 'cancelled' : 'ended', Date.now(), id,
  );
  if (!claimed.changes) return null;

  let row = get(id);
  const guild = client.guilds.cache.get(row.guild_id);
  let winners = [];
  if (!cancel && guild) {
    winners = pickRandom(await eligibleEntrants(guild, row), row.winner_count);
    db.run('UPDATE giveaways SET winner_ids = ? WHERE id = ?', JSON.stringify(winners), id);
    row = get(id);
  }

  try {
    const { channel, message } = await fetchMessage(client, row);
    if (message) await message.edit(render(row)).catch((e) => logger.debug('Giveaway edit failed:', e.message));
    if (!cancel && channel && canPost(channel, guild?.members.me)) {
      const text = winners.length
        ? `🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${truncate(row.prize, 200)}**!`
        : `😢 Nobody could win **${truncate(row.prize, 200)}** — there were no valid entries.`;
      await channel.send({
        content: text,
        reply: message ? { messageReference: message.id, failIfNotExists: false } : undefined,
        allowedMentions: { users: winners, parse: [] },
      }).catch((e) => logger.debug('Giveaway announce failed:', e.message));
    }
  } catch (err) {
    logger.warn('Could not update giveaway message:', err.message);
  }
  return winners;
}

/** Draws new winner(s) for an ended giveaway, never picking previous winners again. */
async function reroll(client, id, count) {
  const row = get(id);
  const guild = client.guilds.cache.get(row.guild_id);
  if (!guild) return [];
  const previous = winnersOf(row);
  const fresh = pickRandom(await eligibleEntrants(guild, row, previous), count);
  if (!fresh.length) return [];
  db.run('UPDATE giveaways SET winner_ids = ? WHERE id = ?', JSON.stringify([...previous, ...fresh]), id);
  const updated = get(id);
  const { channel, message } = await fetchMessage(client, updated);
  if (message) await message.edit(render(updated)).catch(() => {});
  if (channel && canPost(channel, guild.members.me)) {
    await channel.send({
      content: `🎉 New winner${fresh.length > 1 ? 's' : ''}: ${fresh.map((w) => `<@${w}>`).join(', ')}! Congratulations on **${truncate(row.prize, 200)}**!`,
      reply: message ? { messageReference: message.id, failIfNotExists: false } : undefined,
      allowedMentions: { users: fresh, parse: [] },
    }).catch(() => {});
  }
  return fresh;
}

module.exports = { get, entryCount, winnersOf, render, requirementLines, entryProblem, pickRandom, end, reroll, canPost };
