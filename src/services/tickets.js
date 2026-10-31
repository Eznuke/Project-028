'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, OverwriteType,
} = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const logging = require('./logging');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { UserError } = require('../utils/errors');
const { isStaff } = require('../utils/permissions');
const { fill, truncate } = require('../utils/text');
const { ts } = require('../utils/time');

const P = PermissionFlagsBits;
const MEMBER_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const STAFF_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageMessages];
const BOT_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageChannels];

const slug = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'ticket';
const cfgOf = (guildId) => settings.view(guildId).tickets;

const getByChannel = (channelId) => db.get('SELECT * FROM tickets WHERE channel_id = ? AND status IN (\'open\', \'closed\')', channelId);
const getById = (id) => db.get('SELECT * FROM tickets WHERE id = ?', id);
const openTicketsOf = (guildId, userId) => db.all("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'", guildId, userId);

const isTicketStaff = (member) => isStaff(member, cfgOf(member.guild.id).supportRoleIds, P.ManageChannels);

/** Parses "General, Billing, Report a user" into category objects. */
function parseCategories(text) {
  const labels = [...new Set(String(text).split(/[,|]/).map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  if (!labels.length) throw new UserError('Provide at least one category name, separated by commas.');
  return labels.map((label, i) => ({ id: `${slug(label)}${i}`, label: truncate(label, 40), emoji: '🎫', description: `Open a ${truncate(label, 40)} ticket` }));
}

function controlRow({ closed = false, claimed = false } = {}) {
  const row = new ActionRowBuilder();
  if (closed) {
    row.addComponents(
      new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reopen').setEmoji('🔓').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:delete').setLabel('Delete channel').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket:claim').setLabel(claimed ? 'Release' : 'Claim').setEmoji('🙋').setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

/** Creates the private channel and the database record. */
async function openTicket(guild, user, categoryId, subject, details) {
  const cfg = cfgOf(guild.id);
  const me = guild.members.me;
  if (!me.permissions.has([P.ManageChannels, P.ViewChannel])) throw new UserError('I need the **Manage Channels** permission to create tickets.');

  const open = openTicketsOf(guild.id, user.id);
  if (cfg.preventDuplicates && open.length >= Math.max(1, cfg.maxOpenPerUser)) {
    throw new UserError(`You already have an open ticket: <#${open[0].channel_id}>. Please use it or close it first.`);
  }
  const category = cfg.categories.find((c) => c.id === categoryId) ?? cfg.categories[0];

  // Allocate the number first (synchronous, so two simultaneous tickets never share one).
  let number = 0;
  settings.update(guild.id, (s) => { s.tickets.counter += 1; number = s.tickets.counter; });

  const overwrites = [
    { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
    { id: user.id, type: OverwriteType.Member, allow: MEMBER_ALLOW },
    { id: me.id, type: OverwriteType.Member, allow: BOT_ALLOW },
  ];
  for (const roleId of cfg.supportRoleIds) {
    if (guild.roles.cache.has(roleId)) overwrites.push({ id: roleId, type: OverwriteType.Role, allow: STAFF_ALLOW });
  }

  let parent = null;
  if (cfg.categoryChannelId) {
    const p = guild.channels.cache.get(cfg.categoryChannelId);
    if (p?.type === ChannelType.GuildCategory && p.children.cache.size < 50) parent = p.id;
  }

  const channel = await guild.channels.create({
    name: `${slug(category.label)}-${String(number).padStart(4, '0')}`,
    type: ChannelType.GuildText,
    parent,
    topic: `Ticket #${number} • ${category.label} • opened by ${user.username}`,
    permissionOverwrites: overwrites,
    reason: `Ticket #${number} opened by ${user.username}`,
  });

  let id;
  try {
    id = db.run(
      'INSERT INTO tickets (guild_id, ticket_number, channel_id, user_id, category, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      guild.id, number, channel.id, user.id, category.id, subject ? truncate(subject, 200) : null, Date.now(),
    ).lastInsertRowid;
  } catch (err) {
    await channel.delete('Could not save ticket').catch(() => {});
    throw err;
  }

  const intro = embeds
    .base(`🎫 Ticket #${number} — ${category.label}`, fill(cfg.welcomeMessage, { user: `<@${user.id}>`, username: user.username, server: guild.name }), embeds.COLORS.primary)
    .addFields({ name: 'Subject', value: truncate(subject || 'Not provided', 250) });
  if (details) intro.addFields({ name: 'Details', value: truncate(details, 1000) });
  const roleMentions = cfg.supportRoleIds.filter((r) => guild.roles.cache.has(r)).map((r) => `<@&${r}>`);
  await channel.send({
    content: `<@${user.id}> ${roleMentions.join(' ')}`.trim(),
    embeds: [intro],
    components: [controlRow()],
    allowedMentions: { users: [user.id], roles: cfg.supportRoleIds },
  });

  await logging.send(guild, 'tickets', embeds.base('🎫 Ticket opened', `#${number} ${channel} by <@${user.id}> (${category.label})`, embeds.COLORS.success).setTimestamp());
  return { id, number, channel };
}

/** Builds a plain-text transcript (up to 1000 messages, oldest first). */
async function buildTranscript(channel, ticket, closedBy) {
  const collected = [];
  let before;
  while (collected.length < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    collected.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  collected.reverse();
  const lines = [
    `Transcript of ticket #${ticket.ticket_number} (${channel.guild.name})`,
    `Opened by user ID ${ticket.user_id} on ${new Date(ticket.created_at).toISOString()}`,
    `Closed by user ID ${closedBy} on ${new Date().toISOString()}`,
    `Messages: ${collected.length}${collected.length >= 1000 ? ' (limited to the most recent 1000)' : ''}`,
    '='.repeat(60),
  ];
  for (const m of collected) {
    const when = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`[${when}] ${m.author.username}${m.author.bot ? ' [BOT]' : ''}: ${m.content || ''}`.trimEnd());
    for (const a of m.attachments.values()) lines.push(`    [attachment] ${a.name}: ${a.url}`);
    if (m.embeds.length) lines.push(`    [${m.embeds.length} embed(s)]`);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Closes a ticket: transcript, lock the opener out, rename, post controls. */
async function closeTicket(guild, ticket, closer, reason) {
  const channel = guild.channels.cache.get(ticket.channel_id) ?? (await guild.channels.fetch(ticket.channel_id).catch(() => null));
  if (!channel) {
    db.run("UPDATE tickets SET status = 'deleted', closed_at = ?, closed_by = ? WHERE id = ?", Date.now(), closer.id, ticket.id);
    throw new UserError('The ticket channel no longer exists.');
  }
  db.run("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?", Date.now(), closer.id, ticket.id);

  let file = null;
  try {
    file = new AttachmentBuilder(await buildTranscript(channel, ticket, closer.id), { name: `transcript-ticket-${ticket.ticket_number}.txt` });
  } catch (err) {
    logger.warn(`Transcript for ticket ${ticket.id} failed: ${err.message}`);
  }

  const cfg = cfgOf(guild.id);
  const summary = embeds
    .base(`📁 Ticket #${ticket.ticket_number} closed`, `Opened by <@${ticket.user_id}> • closed by <@${closer.id}>${reason ? `\n**Reason:** ${truncate(reason, 300)}` : ''}${ticket.claimed_by ? `\nClaimed by <@${ticket.claimed_by}>` : ''}`, embeds.COLORS.neutral)
    .setTimestamp();
  const target = cfg.transcriptChannelId ?? cfg.logChannelId;
  const targetChannel = target ? guild.channels.cache.get(target) : null;
  if (targetChannel?.isTextBased()) {
    await targetChannel.send({ embeds: [summary], files: file ? [file] : [], allowedMentions: { parse: [] } }).catch((err) => logger.warn(`Could not post transcript: ${err.message}`));
  } else {
    await logging.send(guild, 'tickets', summary);
  }

  // The opener keeps no access while the ticket is closed.
  await channel.permissionOverwrites.edit(ticket.user_id, { ViewChannel: false, SendMessages: false }, { type: OverwriteType.Member, reason: 'Ticket closed' }).catch(() => {});
  if (!channel.name.startsWith('closed-')) await channel.setName(`closed-${channel.name}`.slice(0, 100), 'Ticket closed').catch(() => {});
  await channel.send({
    embeds: [embeds.base('🔒 Ticket closed', `Closed by ${closer}${reason ? `\n**Reason:** ${truncate(reason, 300)}` : ''}\nStaff can reopen it or delete the channel.`, embeds.COLORS.neutral)],
    components: [controlRow({ closed: true })],
    allowedMentions: { parse: [] },
  });
  return file;
}

async function reopenTicket(guild, ticket, actor) {
  const channel = guild.channels.cache.get(ticket.channel_id) ?? (await guild.channels.fetch(ticket.channel_id).catch(() => null));
  if (!channel) throw new UserError('The ticket channel no longer exists.');
  db.run("UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id = ?", ticket.id);
  await channel.permissionOverwrites.edit(ticket.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { type: OverwriteType.Member, reason: 'Ticket reopened' });
  if (channel.name.startsWith('closed-')) await channel.setName(channel.name.slice(7), 'Ticket reopened').catch(() => {});
  await channel.send({
    content: `<@${ticket.user_id}>`,
    embeds: [embeds.success(`Ticket reopened by ${actor}.`)],
    components: [controlRow({ claimed: !!ticket.claimed_by })],
    allowedMentions: { users: [ticket.user_id] },
  });
  await logging.send(guild, 'tickets', embeds.base('🔓 Ticket reopened', `#${ticket.ticket_number} ${channel} by ${actor}`, embeds.COLORS.success).setTimestamp());
}


/** Adds the shared ticket-setup options to a subcommand builder (used by /ticket setup and /config tickets). */
function addSetupOptions(sub) {
  return sub
    .addChannelOption((o) => o.setName('category').setDescription('Discord category where tickets are created').addChannelTypes(ChannelType.GuildCategory))
    .addRoleOption((o) => o.setName('support_role').setDescription('Role that can see and answer tickets (adds to the list)'))
    .addRoleOption((o) => o.setName('remove_support_role').setDescription('Remove a role from the support roles'))
    .addChannelOption((o) => o.setName('log_channel').setDescription('Channel for ticket logs').addChannelTypes(ChannelType.GuildText))
    .addChannelOption((o) => o.setName('transcript_channel').setDescription('Channel for transcripts (default: log channel)').addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName('categories').setDescription('Ticket categories, comma separated (e.g. General, Billing, Report)').setMaxLength(300))
    .addBooleanOption((o) => o.setName('prevent_duplicates').setDescription('Limit open tickets per user'))
    .addIntegerOption((o) => o.setName('max_open').setDescription('Open tickets allowed per user (default 1)').setMinValue(1).setMaxValue(10))
    .addStringOption((o) => o.setName('welcome_message').setDescription('First message in a ticket. Placeholders: {user} {username} {server}').setMaxLength(500));
}

/** Applies the options of addSetupOptions() to the server settings. Returns a list of change descriptions. */
function applySetup(guildId, o) {
  const changes = [];
  settings.update(guildId, (s) => {
    const t = s.tickets;
    const category = o.getChannel('category');
    if (category) { t.categoryChannelId = category.id; changes.push(`Category: **${category.name}**`); }
    const role = o.getRole('support_role');
    if (role) {
      if (!t.supportRoleIds.includes(role.id)) t.supportRoleIds.push(role.id);
      changes.push(`Support role added: ${role}`);
    }
    const removed = o.getRole('remove_support_role');
    if (removed) { t.supportRoleIds = t.supportRoleIds.filter((r) => r !== removed.id); changes.push(`Support role removed: ${removed}`); }
    const log = o.getChannel('log_channel');
    if (log) { t.logChannelId = log.id; s.logs.channels.tickets = log.id; changes.push(`Log channel: ${log}`); }
    const tr = o.getChannel('transcript_channel');
    if (tr) { t.transcriptChannelId = tr.id; changes.push(`Transcript channel: ${tr}`); }
    const cats = o.getString('categories');
    if (cats) { t.categories = parseCategories(cats); changes.push(`Categories: ${t.categories.map((c) => c.label).join(', ')}`); }
    const dup = o.getBoolean('prevent_duplicates');
    if (dup !== null) { t.preventDuplicates = dup; changes.push(`Prevent duplicates: ${dup ? 'on' : 'off'}`); }
    const max = o.getInteger('max_open');
    if (max !== null) { t.maxOpenPerUser = max; changes.push(`Max open per user: ${max}`); }
    const welcome = o.getString('welcome_message');
    if (welcome) { t.welcomeMessage = welcome; changes.push('Welcome message updated'); }
  });
  return changes;
}

module.exports = {
  addSetupOptions, applySetup, slug, cfgOf, getByChannel, getById, openTicketsOf, isTicketStaff, parseCategories, controlRow,
  openTicket, closeTicket, reopenTicket, buildTranscript, ts,
};
