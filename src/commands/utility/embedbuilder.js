'use strict';

const {
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, MessageFlags,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const audit = require('../../services/audit');
const { UserError } = require('../../utils/errors');
const { stripMentions } = require('../../utils/text');

const P = PermissionFlagsBits;
const drafts = new Map(); // userId -> { draft, touched }
const TTL = 30 * 60_000;

function getDraft(userId) {
  const entry = drafts.get(userId);
  if (!entry || Date.now() - entry.touched > TTL) return null;
  entry.touched = Date.now();
  return entry.draft;
}

function newDraft() {
  return { title: null, description: 'Use **Edit text** to write your embed.', color: embeds.COLORS.primary, footer: null, image: null, fields: [] };
}

function toEmbed(d) {
  const e = new EmbedBuilder().setColor(d.color);
  if (d.title) e.setTitle(d.title);
  if (d.description) e.setDescription(d.description);
  if (d.footer) e.setFooter({ text: d.footer });
  if (d.image) e.setImage(d.image);
  if (d.fields.length) e.addFields(d.fields);
  return e;
}

function panel(d) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('eb:text').setLabel('Edit text').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('eb:field').setLabel('Add field').setEmoji('➕').setStyle(ButtonStyle.Secondary).setDisabled(d.fields.length >= 10),
    new ButtonBuilder().setCustomId('eb:popfield').setLabel('Remove last field').setStyle(ButtonStyle.Secondary).setDisabled(d.fields.length === 0),
    new ButtonBuilder().setCustomId('eb:cancel').setLabel('Discard').setStyle(ButtonStyle.Danger),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('eb:send').setPlaceholder('Send to a channel…').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1),
  );
  return { content: '**Embed builder** — this is a private preview.', embeds: [toEmbed(d)], components: [row1, row2], allowedMentions: { parse: [] } };
}

const input = (id, label, style, { value, required = false, max, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (value) t.setValue(String(value).slice(0, max ?? 4000));
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};

function isHttps(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

const embedbuilder = {
  data: guildCommand('embedbuilder', 'Build a custom embed with an interactive editor', P.ManageMessages),
  cooldown: 10,
  prefix: false, // needs modal forms
  userPermissions: [P.ManageMessages],

  async execute(interaction) {
    const d = newDraft();
    drafts.set(interaction.user.id, { draft: d, touched: Date.now() });
    await interaction.reply({ ...panel(d), flags: EPHEMERAL });
  },

  components: {
    async eb(interaction, args) {
      const action = args[0];
      if (!interaction.inGuild() || !interaction.memberPermissions.has(P.ManageMessages)) {
        return interaction.reply({ content: 'You need the **Manage Messages** permission.', flags: MessageFlags.Ephemeral });
      }
      const d = getDraft(interaction.user.id);
      if (!d) return interaction.reply({ content: 'This builder expired. Run `/embedbuilder` again.', flags: MessageFlags.Ephemeral });

      if (action === 'text') {
        return interaction.showModal(
          new ModalBuilder().setCustomId('eb:textmodal').setTitle('Embed text').addComponents(
            input('title', 'Title', TextInputStyle.Short, { value: d.title, max: 256 }),
            input('description', 'Description', TextInputStyle.Paragraph, { value: d.description, max: 4000 }),
            input('color', 'Color (hex, e.g. #57F287)', TextInputStyle.Short, { value: `#${d.color.toString(16).padStart(6, '0')}`, max: 7 }),
            input('footer', 'Footer', TextInputStyle.Short, { value: d.footer, max: 200 }),
            input('image', 'Image URL (https only)', TextInputStyle.Short, { value: d.image, max: 500 }),
          ),
        );
      }
      if (action === 'textmodal') {
        const f = (id) => interaction.fields.getTextInputValue(id).trim();
        const color = f('color');
        if (color && !embeds.isHexColor(color)) throw new UserError('The color must be a hex value such as `#57F287`.');
        const image = f('image');
        if (image && !isHttps(image)) throw new UserError('The image URL must start with `https://`.');
        d.title = stripMentions(f('title')) || null;
        d.description = stripMentions(f('description')) || null;
        d.color = color ? embeds.parseColor(color) : embeds.COLORS.primary;
        d.footer = stripMentions(f('footer')) || null;
        d.image = image || null;
        if (!d.title && !d.description) throw new UserError('An embed needs a title or a description.');
        return interaction.update(panel(d));
      }
      if (action === 'field') {
        return interaction.showModal(
          new ModalBuilder().setCustomId('eb:fieldmodal').setTitle('Add a field').addComponents(
            input('name', 'Field name', TextInputStyle.Short, { required: true, max: 256 }),
            input('value', 'Field text', TextInputStyle.Paragraph, { required: true, max: 1024 }),
            input('inline', 'Inline? (yes / no)', TextInputStyle.Short, { value: 'no', max: 3 }),
          ),
        );
      }
      if (action === 'fieldmodal') {
        if (d.fields.length >= 10) throw new UserError('An embed can show at most 10 fields here.');
        d.fields.push({
          name: stripMentions(interaction.fields.getTextInputValue('name')),
          value: stripMentions(interaction.fields.getTextInputValue('value')),
          inline: /^y/i.test(interaction.fields.getTextInputValue('inline')),
        });
        return interaction.update(panel(d));
      }
      if (action === 'popfield') {
        d.fields.pop();
        return interaction.update(panel(d));
      }
      if (action === 'cancel') {
        drafts.delete(interaction.user.id);
        return interaction.update({ content: 'Embed discarded.', embeds: [], components: [] });
      }
      if (action === 'send' && interaction.isChannelSelectMenu()) {
        const channel = interaction.channels.first();
        const me = interaction.guild.members.me;
        const mine = channel.permissionsFor(me);
        if (!mine?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I cannot send embeds in ${channel}.`);
        if (!channel.permissionsFor(interaction.member)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`You cannot send embeds in ${channel}.`);
        if (!d.title && !d.description && !d.fields.length) throw new UserError('The embed is empty.');
        await channel.send({ embeds: [toEmbed(d)], allowedMentions: { parse: [] } });
        audit.record(interaction.guildId, interaction.user.id, 'embedbuilder.send', channel.id);
        drafts.delete(interaction.user.id);
        return interaction.update({ content: `✅ Embed sent to ${channel}.`, embeds: [], components: [] });
      }
      return undefined;
    },
  },
};

module.exports = [embedbuilder];
