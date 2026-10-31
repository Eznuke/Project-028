'use strict';

const {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags,
} = require('discord.js');
const db = require('../database');
const apps = require('../services/applications');
const audit = require('../services/audit');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { canManageRole, isStaff } = require('../utils/permissions');
const { stripMentions, truncate } = require('../utils/text');

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const canReview = (interaction) => isStaff(interaction.member, apps.cfgOf(interaction.guildId).staffRoleIds);

/** Gives the accept role. Returns a short sentence about what happened. */
async function grantRole(guild, app, cfg) {
  if (!cfg.acceptRoleId) return '';
  const role = guild.roles.cache.get(cfg.acceptRoleId);
  if (!role) return ' The accept role no longer exists.';
  const check = canManageRole(guild, null, role);
  if (!check.ok) return ` Could not give ${role}: ${check.reason}`;
  const member = await guild.members.fetch(app.user_id).catch(() => null);
  if (!member) return ' The applicant is no longer in the server, so no role was given.';
  try {
    await member.roles.add(role, `Application #${app.id} accepted`);
    return ` Gave ${role}.`;
  } catch (err) {
    logger.warn(`Could not give the accept role: ${err.message}`);
    return ` I could not give ${role} (check my role position).`;
  }
}

module.exports = {
  prefix: 'app',
  async execute(interaction, args, client) {
    const [action, ...rest] = args;
    if (!interaction.inGuild()) return undefined;
    const guild = interaction.guild;
    const cfg = apps.cfgOf(guild.id);

    if (action === 'open') {
      const problem = apps.applyProblem(guild, interaction.user.id);
      if (problem) return say(interaction, `❌ ${problem}`);
      const modal = new ModalBuilder().setCustomId('app:submit').setTitle(truncate(cfg.title, 45));
      cfg.questions.slice(0, apps.MAX_QUESTIONS).forEach((q, i) => {
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId(`q${i}`).setLabel(truncate(q, 45)).setPlaceholder(truncate(q, 100))
            .setStyle(TextInputStyle.Paragraph).setMinLength(2).setMaxLength(900).setRequired(true),
        ));
      });
      return interaction.showModal(modal);
    }

    if (action === 'submit') {
      const problem = apps.applyProblem(guild, interaction.user.id); // re-check: it may have changed while the form was open
      if (problem) return say(interaction, `❌ ${problem}`);
      const answers = cfg.questions.slice(0, apps.MAX_QUESTIONS).map((q, i) => ({
        q, a: stripMentions(interaction.fields.getTextInputValue(`q${i}`)).trim(),
      }));
      const id = db.run(
        'INSERT INTO applications (guild_id, user_id, answers, created_at) VALUES (?, ?, ?, ?)',
        guild.id, interaction.user.id, JSON.stringify(answers), Date.now(),
      ).lastInsertRowid;
      try {
        const channel = guild.channels.cache.get(cfg.reviewChannelId);
        const message = await channel.send(apps.renderReview(apps.get(id), interaction.user, cfg));
        db.run('UPDATE applications SET message_id = ?, channel_id = ? WHERE id = ?', message.id, channel.id, id);
      } catch (err) {
        db.run('DELETE FROM applications WHERE id = ?', id);
        logger.warn(`Could not post application: ${err.message}`);
        return say(interaction, '❌ I could not deliver your application to the staff channel. Please tell an admin (I may be missing permissions there).');
      }
      audit.record(guild.id, interaction.user.id, 'application.submit', id);
      return say(interaction, `✅ Your application **#${id}** was sent to the staff. You will hear back${cfg.dmApplicant ? ' by DM' : ''} once it is reviewed.`);
    }

    if (action === 'decide') {
      if (!canReview(interaction)) return say(interaction, 'Only application reviewers can do this.');
      const [id, status] = [Number(rest[0]), rest[1]];
      const app = apps.get(id);
      if (!app || app.guild_id !== guild.id) return say(interaction, 'That application no longer exists.');
      if (app.status !== 'pending') return say(interaction, `This application was already ${app.status}.`);
      if (status !== 'accepted' && status !== 'rejected') return undefined;
      return interaction.showModal(
        new ModalBuilder().setCustomId(`app:note:${id}:${status}`).setTitle(status === 'accepted' ? 'Accept application' : 'Reject application')
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('note').setLabel('Message to the applicant (optional)').setStyle(TextInputStyle.Paragraph)
              .setRequired(false).setMaxLength(500),
          )),
      );
    }

    if (action === 'note') {
      if (!canReview(interaction)) return say(interaction, 'Only application reviewers can do this.');
      const [id, status] = [Number(rest[0]), rest[1]];
      const note = stripMentions(interaction.fields.getTextInputValue('note') ?? '').trim();
      // The status change is the lock: only one reviewer can decide.
      const done = db.run(
        "UPDATE applications SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND status = 'pending'",
        status, interaction.user.id, note || null, Date.now(), id, guild.id,
      );
      if (!done.changes) return say(interaction, 'Someone else already decided this application.');
      const app = apps.get(id);
      const extra = status === 'accepted' ? await grantRole(guild, app, cfg) : '';
      audit.record(guild.id, interaction.user.id, `application.${status}`, id, note || null);

      const applicant = await client.users.fetch(app.user_id).catch(() => null);
      const review = apps.renderReview(app, applicant, cfg);
      if (interaction.isFromMessage?.()) await interaction.update(review);
      else await interaction.reply({ content: `Application #${id} ${status}.`, flags: MessageFlags.Ephemeral });

      let dm = '';
      if (cfg.dmApplicant && applicant) {
        const e = status === 'accepted'
          ? embeds.success(`Your **${truncate(cfg.title, 60)}** at **${guild.name}** was **accepted**! 🎉${note ? `\n\n${note}` : ''}`)
          : embeds.error(`Your **${truncate(cfg.title, 60)}** at **${guild.name}** was **not accepted**.${note ? `\n\n${note}` : ''}`);
        const sent = await applicant.send({ embeds: [e] }).then(() => true).catch(() => false);
        if (!sent) dm = ' (the applicant has DMs closed, so they were not notified)';
      }
      if (extra || dm) {
        await interaction.followUp({ content: `${status === 'accepted' ? '✅' : '❌'} Decision saved.${extra}${dm}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
      }
      return undefined;
    }
    return undefined;
  },
};
