'use strict';

const {
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, MessageFlags,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const settings = require('../../services/settings');
const sug = require('../../services/suggestions');
const { UserError } = require('../../utils/errors');
const { isStaff } = require('../../utils/permissions');
const { ts } = require('../../utils/time');
const { stripMentions, truncate } = require('../../utils/text');

const P = PermissionFlagsBits;

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function suggestionModal() {
  return new ModalBuilder()
    .setCustomId('sug:modal')
    .setTitle('Submit a suggestion')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('content').setLabel('Your suggestion').setStyle(TextInputStyle.Paragraph)
          .setMinLength(10).setMaxLength(1500).setRequired(true).setPlaceholder('Describe your idea clearly…'),
      ),
    );
}

const suggestion = {
  data: guildCommand('suggestion', 'Submit and manage community suggestions')
    .addSubcommand((s) => s.setName('submit').setDescription('Submit a suggestion')
      .addStringOption((o) => o.setName('text').setDescription('Your suggestion').setRequired(true).setMinLength(10).setMaxLength(1500)))
    .addSubcommand((s) => s.setName('panel').setDescription('Post a panel with a "Submit" button (Manage Server)')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post the panel (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('history').setDescription('Show the audit history of a suggestion (staff)')
      .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setRequired(true).setMinValue(1))),
  cooldown: 20,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;

    if (sub === 'submit') {
      const { id, message } = await sug.create(interaction.guild, interaction.user, stripMentions(interaction.options.getString('text', true)));
      await interaction.reply({ embeds: [embeds.success(`Your suggestion **#${id}** was posted: [jump to it](${message.url}).`)], flags: EPHEMERAL });
      return;
    }

    if (sub === 'panel') {
      if (!interaction.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the **Manage Server** permission to post a panel.');
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const me = interaction.guild.members.me;
      if (!channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot post in ${channel}.`);
      await channel.send({
        embeds: [embeds.base('💡 Suggestions', 'Have an idea for the server? Press the button below and tell us!')],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sug:open').setLabel('Submit a suggestion').setEmoji('💡').setStyle(ButtonStyle.Primary))],
      });
      await interaction.reply({ embeds: [embeds.success(`Panel posted in ${channel}.`)], flags: EPHEMERAL });
      return;
    }

    // history
    const cfg = settings.view(g).suggestions;
    if (!isStaff(interaction.member, cfg.staffRoleIds)) throw new UserError('Only suggestion staff can view the audit history.');
    const s = sug.get(interaction.options.getInteger('id', true));
    if (!s || s.guild_id !== g) throw new UserError('I could not find that suggestion.');
    const lines = sug.history(s.id).map((h) => `${ts(h.created_at, 'f')} — <@${h.actor_id}> **${h.action}**${h.note ? `: ${truncate(h.note, 150)}` : ''}`);
    await interaction.reply({
      embeds: [embeds.base(`📜 Suggestion #${s.id} history`, `Status: **${sug.STATUS[s.status]?.label ?? s.status}**\n\n${lines.join('\n') || 'No history.'}`)],
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },

  components: {
    async sug(interaction, args) {
      const [action, ...rest] = args;

      if (action === 'open') {
        if (!settings.view(interaction.guildId).suggestions.channelId) {
          return interaction.reply(ephemeral('Suggestions are not set up yet. Ask an admin to run `/config suggestions`.'));
        }
        return interaction.showModal(suggestionModal());
      }

      if (action === 'modal') {
        const content = stripMentions(interaction.fields.getTextInputValue('content'));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { id, message } = await sug.create(interaction.guild, interaction.user, content);
        return interaction.editReply({ embeds: [embeds.success(`Your suggestion **#${id}** was posted: [jump to it](${message.url}).`)] });
      }

      if (action === 'vote') {
        const [id, value] = [Number(rest[0]), Number(rest[1])];
        const s = sug.get(id);
        if (!s || s.guild_id !== interaction.guildId) return interaction.reply(ephemeral('That suggestion no longer exists.'));
        if (s.status === 'rejected' || s.status === 'implemented') return interaction.reply(ephemeral('Voting is closed for this suggestion.'));
        if (value !== 1 && value !== -1) return undefined;
        const existing = db.get('SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', id, interaction.user.id);
        if (existing?.vote === value) db.run('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', id, interaction.user.id);
        else db.run(
          'INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?, ?, ?) ON CONFLICT(suggestion_id, user_id) DO UPDATE SET vote = excluded.vote',
          id, interaction.user.id, value,
        );
        return interaction.update(sug.render(sug.get(id)));
      }

      if (action === 'staff') {
        const [id, status] = [Number(rest[0]), rest[1]];
        const cfg = settings.view(interaction.guildId).suggestions;
        if (!isStaff(interaction.member, cfg.staffRoleIds)) return interaction.reply(ephemeral('Only suggestion staff can do this.'));
        if (!sug.STATUS[status] || status === 'pending') return undefined;
        const modal = new ModalBuilder()
          .setCustomId(`sug:note:${id}:${status}`)
          .setTitle(`Mark as ${sug.STATUS[status].label}`.slice(0, 45))
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('note').setLabel(cfg.requireStaffNote ? 'Reason / note (required)' : 'Reason / note (optional)')
              .setStyle(TextInputStyle.Paragraph).setRequired(!!cfg.requireStaffNote).setMaxLength(500),
          ));
        return interaction.showModal(modal);
      }

      if (action === 'note') {
        const [id, status] = [Number(rest[0]), rest[1]];
        const cfg = settings.view(interaction.guildId).suggestions;
        if (!isStaff(interaction.member, cfg.staffRoleIds)) return interaction.reply(ephemeral('Only suggestion staff can do this.'));
        const note = stripMentions(interaction.fields.getTextInputValue('note') ?? '').trim();
        const updated = await sug.decide(interaction, id, status, note);
        // The modal was opened from the suggestion message, so update() edits that message.
        if (interaction.isFromMessage?.()) return interaction.update(sug.render(updated));
        return interaction.reply(ephemeral(`Suggestion #${id} marked as ${status}.`));
      }
      return undefined;
    },
  },
};

module.exports = [suggestion];
