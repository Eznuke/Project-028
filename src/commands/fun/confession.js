'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const settings = require('../../services/settings');
const { UserError } = require('../../utils/errors');
const { stripMentions, escapeRegex } = require('../../utils/text');

const confession = {
  data: guildCommand('confession', 'Post an anonymous confession in the confessions channel')
    .addStringOption((o) => o.setName('text').setDescription('Your confession').setRequired(true).setMinLength(10).setMaxLength(1500)),
  cooldown: 60,
  prefix: false, // anonymous: a chat message would show who wrote it

  async execute(interaction) {
    const g = interaction.guildId;
    const cfg = settings.view(g).confessions;
    if (!cfg.channelId) throw new UserError('Confessions are not set up. An admin can choose a channel with `/config confessions`.');
    if (cfg.banned.includes(interaction.user.id)) throw new UserError('You are not allowed to post confessions in this server.');

    const channel = interaction.guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased()) throw new UserError('The confessions channel no longer exists.');
    if (!channel.permissionsFor(interaction.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new UserError(`I cannot post in ${channel}.`);
    }

    const text = stripMentions(interaction.options.getString('text', true)).trim();
    // Anonymous posts bypass normal message filters, so apply the server's blocked words and invite filter here.
    const words = settings.view(g).moderation.automod.words;
    const hasBlockedWord = words.enabled && words.list.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
    const hasInvite = /(discord\.gg|discord(?:app)?\.com\/invite)\/\w+/i.test(text);
    if (hasBlockedWord || hasInvite) throw new UserError('Your confession contains content that is not allowed in this server.');

    const now = Date.now();
    const id = db.run('INSERT INTO confessions (guild_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', g, interaction.user.id, text, now).lastInsertRowid;
    const message = await channel.send({
      embeds: [embeds.base(`🤫 Anonymous confession #${id}`, text, 0x2c2f33).setFooter({ text: 'Sent anonymously' })],
      allowedMentions: { parse: [] },
    });
    db.run('UPDATE confessions SET message_id = ? WHERE id = ?', message.id, id);
    await interaction.reply({ embeds: [embeds.success(`Your confession was posted anonymously as **#${id}**.`)], flags: EPHEMERAL });
  },
};

module.exports = [confession];
