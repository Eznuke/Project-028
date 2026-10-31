'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, OverwriteType,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const tickets = require('../../services/tickets');
const { UserError } = require('../../utils/errors');
const { stripMentions, truncate } = require('../../utils/text');

const P = PermissionFlagsBits;
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function requireTicket(channelId) {
  const t = tickets.getByChannel(channelId);
  if (!t) throw new UserError('This channel is not a ticket.');
  return t;
}

function requireStaff(member) {
  if (!tickets.isTicketStaff(member)) throw new UserError('Only ticket support staff can do this.');
}

function openModal(categoryId) {
  return new ModalBuilder()
    .setCustomId(`ticket:modal:${categoryId}`)
    .setTitle('Open a ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Subject').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Describe your problem').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)),
    );
}

function panelPayload(cfg) {
  const embed = embeds.base('🎫 Support', 'Need help? Open a private ticket and our staff will assist you.\nPlease do not open more tickets than you need.');
  if (cfg.categories.length <= 1) {
    const cat = cfg.categories[0] ?? { id: 'general', label: 'Open a ticket', emoji: '🎫' };
    return {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket:open:${cat.id}`).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))],
    };
  }
  const menu = new StringSelectMenuBuilder().setCustomId('ticket:pick').setPlaceholder('Choose a category to open a ticket').addOptions(
    cfg.categories.slice(0, 25).map((c) => ({ label: truncate(c.label, 100), value: c.id, description: truncate(c.description ?? '', 100) || undefined, emoji: c.emoji })),
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

const ticket = {
  data: guildCommand('ticket', 'Support tickets')
    .addSubcommand((s) => tickets.addSetupOptions(s.setName('setup').setDescription('Configure the ticket system (Manage Server)')))
    .addSubcommand((s) => s.setName('panel').setDescription('Post the "open a ticket" panel (Manage Server)')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket')
      .addStringOption((o) => o.setName('reason').setDescription('Why it is being closed').setMaxLength(300)))
    .addSubcommand((s) => s.setName('reopen').setDescription('Reopen this closed ticket'))
    .addSubcommand((s) => s.setName('add').setDescription('Add a member to this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Member to add').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a member from this ticket')
      .addUserOption((o) => o.setName('user').setDescription('Member to remove').setRequired(true)))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim (or release) this ticket as staff')),
  cooldown: 3,

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;

    if (sub === 'setup') {
      if (!interaction.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the **Manage Server** permission.');
      const changes = tickets.applySetup(g, interaction.options);
      audit.record(g, interaction.user.id, 'tickets.setup', null, changes.join('; '));
      const cfg = tickets.cfgOf(g);
      const text = changes.length ? changes.join('\n') : 'Nothing changed. Provide at least one option.';
      await interaction.reply({
        embeds: [embeds.base('🎫 Ticket setup', `${text}\n\n**Current:** category ${cfg.categoryChannelId ? `<#${cfg.categoryChannelId}>` : 'none'} • support roles ${cfg.supportRoleIds.map((r) => `<@&${r}>`).join(' ') || 'none'} • ${cfg.categories.length} categor${cfg.categories.length === 1 ? 'y' : 'ies'}\nNext: post the panel with \`/ticket panel\`.`)],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'panel') {
      if (!interaction.memberPermissions.has(P.ManageGuild)) throw new UserError('You need the **Manage Server** permission.');
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!channel.permissionsFor(interaction.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot post in ${channel}.`);
      await channel.send(panelPayload(tickets.cfgOf(g)));
      settings.set(g, 'tickets.panelChannelId', channel.id);
      await interaction.reply({ embeds: [embeds.success(`Ticket panel posted in ${channel}.`)], flags: EPHEMERAL });
      return;
    }

    const t = requireTicket(interaction.channelId);

    if (sub === 'close') {
      if (t.status !== 'open') throw new UserError('This ticket is already closed.');
      if (t.user_id !== interaction.user.id) requireStaff(interaction.member);
      await interaction.reply({ embeds: [embeds.info('Closing the ticket and saving the transcript…')], flags: EPHEMERAL });
      await tickets.closeTicket(interaction.guild, t, interaction.user, stripMentions(interaction.options.getString('reason') ?? ''));
      return;
    }

    requireStaff(interaction.member);

    if (sub === 'reopen') {
      if (t.status !== 'closed') throw new UserError('This ticket is not closed.');
      await tickets.reopenTicket(interaction.guild, t, interaction.user);
      await interaction.reply({ embeds: [embeds.success('Ticket reopened.')], flags: EPHEMERAL });
      return;
    }

    if (sub === 'claim') {
      if (t.status !== 'open') throw new UserError('Only open tickets can be claimed.');
      if (t.claimed_by && t.claimed_by !== interaction.user.id) throw new UserError(`This ticket is already claimed by <@${t.claimed_by}>.`);
      const release = t.claimed_by === interaction.user.id;
      db.run('UPDATE tickets SET claimed_by = ? WHERE id = ?', release ? null : interaction.user.id, t.id);
      await interaction.reply({
        embeds: [embeds.success(release ? `${interaction.user} released this ticket.` : `${interaction.user} claimed this ticket and will help you.`)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // add / remove
    const user = interaction.options.getUser('user', true);
    if (user.bot) throw new UserError('Bots cannot be added to tickets.');
    if (t.status !== 'open') throw new UserError('Reopen the ticket first.');
    if (sub === 'add') {
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { type: OverwriteType.Member, reason: `Added by ${interaction.user.username}` });
      await interaction.reply({ embeds: [embeds.success(`${user} was added to this ticket.`)], allowedMentions: { parse: [] } });
    } else {
      if (user.id === t.user_id) throw new UserError('You cannot remove the person who opened the ticket. Close the ticket instead.');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (member && tickets.isTicketStaff(member)) throw new UserError('Support staff cannot be removed from tickets.');
      await interaction.channel.permissionOverwrites.delete(user.id, `Removed by ${interaction.user.username}`);
      await interaction.reply({ embeds: [embeds.success(`${user} was removed from this ticket.`)], allowedMentions: { parse: [] } });
    }
  },

  components: {
    async ticket(interaction, args) {
      const [action, arg] = args;
      const g = interaction.guildId;

      if (action === 'open') return interaction.showModal(openModal(arg ?? 'general'));
      if (action === 'pick') return interaction.showModal(openModal(interaction.values[0]));

      if (action === 'modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const subject = stripMentions(interaction.fields.getTextInputValue('subject'));
        const details = stripMentions(interaction.fields.getTextInputValue('details') ?? '');
        const { channel } = await tickets.openTicket(interaction.guild, interaction.user, arg, subject, details);
        return interaction.editReply({ embeds: [embeds.success(`Your ticket was created: ${channel}`)] });
      }

      // Everything below happens inside a ticket channel.
      const t = requireTicket(interaction.channelId);

      if (action === 'close') {
        if (t.status !== 'open') return interaction.reply(ephemeral('This ticket is already closed.'));
        if (t.user_id !== interaction.user.id) requireStaff(interaction.member);
        return interaction.reply({
          embeds: [embeds.warning('Close this ticket? A transcript will be saved.')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket:doclose').setLabel('Yes, close it').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ticket:dismiss').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (action === 'dismiss') return interaction.update({ embeds: [embeds.info('Cancelled.')], components: [] });
      if (action === 'doclose') {
        if (t.status !== 'open') return interaction.update({ embeds: [embeds.info('Already closed.')], components: [] });
        if (t.user_id !== interaction.user.id) requireStaff(interaction.member);
        await interaction.update({ embeds: [embeds.info('Closing the ticket and saving the transcript…')], components: [] });
        await tickets.closeTicket(interaction.guild, t, interaction.user, '');
        return undefined;
      }

      requireStaff(interaction.member);

      if (action === 'claim') {
        if (t.status !== 'open') return interaction.reply(ephemeral('Only open tickets can be claimed.'));
        if (t.claimed_by && t.claimed_by !== interaction.user.id) return interaction.reply(ephemeral(`Already claimed by <@${t.claimed_by}>.`));
        const release = t.claimed_by === interaction.user.id;
        db.run('UPDATE tickets SET claimed_by = ? WHERE id = ?', release ? null : interaction.user.id, t.id);
        await interaction.update({ components: [tickets.controlRow({ claimed: !release })] });
        await interaction.channel.send({ embeds: [embeds.success(release ? `${interaction.user} released this ticket.` : `${interaction.user} claimed this ticket.`)], allowedMentions: { parse: [] } });
        return undefined;
      }
      if (action === 'reopen') {
        if (t.status !== 'closed') return interaction.reply(ephemeral('This ticket is not closed.'));
        await interaction.deferUpdate();
        await tickets.reopenTicket(interaction.guild, t, interaction.user);
        return interaction.message.edit({ components: [] }).catch(() => {});
      }
      if (action === 'delete') {
        return interaction.reply({
          embeds: [embeds.warning('Delete this channel permanently? The transcript was already saved when the ticket was closed.')],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket:dodelete').setLabel('Delete channel').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ticket:dismiss').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (action === 'dodelete') {
        if (t.status !== 'closed') return interaction.update({ embeds: [embeds.info('Close the ticket first.')], components: [] });
        db.run("UPDATE tickets SET status = 'deleted' WHERE id = ?", t.id);
        await interaction.update({ embeds: [embeds.info('Deleting the channel in 5 seconds…')], components: [] });
        const channel = interaction.channel;
        setTimeout(() => channel.delete(`Ticket #${t.ticket_number} deleted by ${interaction.user.username}`).catch(() => {}), 5000).unref?.();
        return undefined;
      }
      return undefined;
    },
  },
};

module.exports = [ticket];
