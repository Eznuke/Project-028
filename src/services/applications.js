'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const embeds = require('../utils/embeds');
const { UserError } = require('../utils/errors');
const { canManageRole } = require('../utils/permissions');
const { stripMentions, truncate } = require('../utils/text');
const { ts } = require('../utils/time');

const P = PermissionFlagsBits;
const MAX_QUESTIONS = 5;
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.MentionEveryone];

const cfgOf = (guildId) => settings.view(guildId).applications;
const get = (id) => db.get('SELECT * FROM applications WHERE id = ?', id);
const pendingOf = (guildId, userId) => db.get("SELECT * FROM applications WHERE guild_id = ? AND user_id = ? AND status = 'pending'", guildId, userId);

const STATUS = {
  pending: { label: 'Pending', emoji: '🕓', color: embeds.COLORS.warning },
  accepted: { label: 'Accepted', emoji: '✅', color: embeds.COLORS.success },
  rejected: { label: 'Rejected', emoji: '❌', color: embeds.COLORS.danger },
};

/** Why this person cannot apply right now, or null. */
function applyProblem(guild, userId) {
  const cfg = cfgOf(guild.id);
  if (!cfg.enabled) return 'Applications are closed right now.';
  if (!cfg.questions.length || !cfg.reviewChannelId || !guild.channels.cache.has(cfg.reviewChannelId)) {
    return 'Applications are not fully set up yet. Ask an admin to run `/config applications`.';
  }
  if (pendingOf(guild.id, userId)) return 'You already have an application waiting for review. Please be patient.';
  const last = db.get("SELECT * FROM applications WHERE guild_id = ? AND user_id = ? AND status <> 'pending' ORDER BY id DESC LIMIT 1", guild.id, userId);
  if (last?.status === 'accepted') return 'Your application was already accepted.';
  if (last?.status === 'rejected' && cfg.cooldownHours > 0) {
    const again = (last.decided_at ?? last.created_at) + cfg.cooldownHours * 3_600_000;
    if (again > Date.now()) return `Your last application was rejected. You can apply again ${ts(again, 'R')}.`;
  }
  return null;
}

/** Review message for staff. */
function renderReview(app, user, cfg) {
  const st = STATUS[app.status] ?? STATUS.pending;
  const answers = JSON.parse(app.answers);
  const e = embeds.base(`📝 ${truncate(cfg.title, 60)} #${app.id}`,
    `**Applicant:** <@${app.user_id}> (${stripMentions(user?.username ?? app.user_id)})\n**Sent:** ${ts(app.created_at, 'R')}\n**Status:** ${st.emoji} ${st.label}`
    + (app.decided_by ? ` by <@${app.decided_by}>${app.decision_note ? `\n**Note:** ${truncate(app.decision_note, 300)}` : ''}` : ''), st.color);
  for (const { q, a } of answers) e.addFields({ name: truncate(q, 100), value: truncate(a || '—', 900) });
  e.setFooter({ text: `Application #${app.id}` });
  const pending = app.status === 'pending';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app:decide:${app.id}:accepted`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!pending),
    new ButtonBuilder().setCustomId(`app:decide:${app.id}:rejected`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(!pending),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

// ---- /config applications -------------------------------------------------------------------

function addSetupOptions(sub) {
  sub
    .addBooleanOption((o) => o.setName('enabled').setDescription('Open or close applications'))
    .addChannelOption((o) => o.setName('review_channel').setDescription('Private staff channel where applications are reviewed').addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName('title').setDescription('Name of the application, e.g. Moderator application').setMaxLength(60))
    .addRoleOption((o) => o.setName('staff_role').setDescription('Role allowed to accept/reject (adds to the list; admins always can)'))
    .addRoleOption((o) => o.setName('remove_staff_role').setDescription('Remove a role from the reviewers'))
    .addRoleOption((o) => o.setName('accept_role').setDescription('Role given automatically when an application is accepted'))
    .addBooleanOption((o) => o.setName('clear_accept_role').setDescription('Stop giving a role when accepting'))
    .addIntegerOption((o) => o.setName('cooldown_hours').setDescription('Hours before a rejected person may apply again (0 = anytime)').setMinValue(0).setMaxValue(720))
    .addBooleanOption((o) => o.setName('dm_applicant').setDescription('Send the applicant a DM with the decision'))
    .addChannelOption((o) => o.setName('post_panel').setDescription('Post the "Apply" button panel in this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
  for (let i = 1; i <= MAX_QUESTIONS; i += 1) {
    sub.addStringOption((o) => o.setName(`question${i}`).setDescription(`Question ${i} (max 100 characters, "none" removes it)`).setMaxLength(100));
  }
  return sub;
}

/** Applies the options of addSetupOptions(). Returns change descriptions. */
async function applySetup(interaction) {
  const o = interaction.options;
  const guild = interaction.guild;
  const changes = [];

  const accept = o.getRole('accept_role');
  if (accept) {
    const check = canManageRole(guild, interaction.member, accept);
    if (!check.ok) throw new UserError(check.reason);
    if (DANGEROUS.some((p) => accept.permissions.has(p))) throw new UserError(`${accept} has moderation/admin permissions, so it cannot be handed out automatically.`);
  }
  const review = o.getChannel('review_channel');
  if (review && !review.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
    throw new UserError(`I need View Channel, Send Messages and Embed Links in ${review}.`);
  }

  settings.update(guild.id, (s) => {
    const a = s.applications;
    const enabled = o.getBoolean('enabled');
    if (enabled !== null) { a.enabled = enabled; changes.push(`Applications: ${enabled ? 'open' : 'closed'}`); }
    if (review) { a.reviewChannelId = review.id; changes.push(`Review channel: ${review}`); }
    const title = o.getString('title');
    if (title) { a.title = stripMentions(title).trim(); changes.push(`Title: **${a.title}**`); }
    const staff = o.getRole('staff_role');
    if (staff) { a.staffRoleIds = [...new Set([...a.staffRoleIds, staff.id])].slice(0, 20); changes.push(`Reviewer role added: ${staff}`); }
    const unstaff = o.getRole('remove_staff_role');
    if (unstaff) { a.staffRoleIds = a.staffRoleIds.filter((id) => id !== unstaff.id); changes.push(`Reviewer role removed: ${unstaff}`); }
    if (accept) { a.acceptRoleId = accept.id; changes.push(`Accept role: ${accept}`); }
    if (o.getBoolean('clear_accept_role')) { a.acceptRoleId = null; changes.push('Accept role removed'); }
    const cooldown = o.getInteger('cooldown_hours');
    if (cooldown !== null) { a.cooldownHours = cooldown; changes.push(`Re-apply wait: ${cooldown}h`); }
    const dm = o.getBoolean('dm_applicant');
    if (dm !== null) { a.dmApplicant = dm; changes.push(`DM applicant: ${dm ? 'on' : 'off'}`); }

    // Question slots 1-5: text replaces a slot, "none" empties it; the rest move up.
    const slots = Array.from({ length: MAX_QUESTIONS }, (_v, i) => a.questions[i] ?? null);
    let touched = false;
    for (let i = 1; i <= MAX_QUESTIONS; i += 1) {
      const text = o.getString(`question${i}`);
      if (text === null) continue;
      touched = true;
      slots[i - 1] = text.trim().toLowerCase() === 'none' ? null : stripMentions(text).trim() || null;
    }
    if (touched) {
      const next = slots.filter(Boolean);
      if (!next.length) throw new UserError('You need at least one question.');
      a.questions = next;
      changes.push(`Questions: ${next.map((q, i) => `${i + 1}. ${truncate(q, 40)}`).join(' · ')}`);
    }
  });

  const panelChannel = o.getChannel('post_panel');
  if (panelChannel) {
    const cfg = cfgOf(guild.id);
    if (!cfg.reviewChannelId) throw new UserError('Choose a `review_channel` first, then post the panel.');
    if (!panelChannel.permissionsFor(guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
      throw new UserError(`I cannot post in ${panelChannel}.`);
    }
    await panelChannel.send({
      embeds: [embeds.base(`📝 ${truncate(cfg.title, 60)}`, `Want to join the team? Press **Apply** and answer ${cfg.questions.length} question${cfg.questions.length === 1 ? '' : 's'}.\nYou will get a reply by DM or in the server once it has been reviewed.`)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('app:open').setLabel('Apply').setEmoji('📝').setStyle(ButtonStyle.Primary))],
    });
    changes.push(`Panel posted in ${panelChannel}`);
  }

  const cfg = cfgOf(guild.id);
  if (cfg.enabled && (!cfg.reviewChannelId || !cfg.questions.length)) {
    changes.push('⚠️ Applications are open but no review channel is set yet.');
  }
  return changes;
}

module.exports = { MAX_QUESTIONS, STATUS, cfgOf, get, pendingOf, applyProblem, renderReview, addSetupOptions, applySetup };
