'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const embeds = require('../../utils/embeds');

const ping = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency'),
  cooldown: 5,
  guildOnly: false,
  async execute(interaction, client) {
    await interaction.reply({ content: 'Pinging…' });
    const sent = await interaction.fetchReply();
    const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
    const ws = Math.round(client.ws.ping);
    await interaction.editReply({
      content: '',
      embeds: [
        new EmbedBuilder()
          .setColor(embeds.COLORS.primary)
          .setTitle('🏓 Pong!')
          .addFields(
            { name: 'Round trip', value: `${roundTrip} ms`, inline: true },
            { name: 'WebSocket', value: ws >= 0 ? `${ws} ms` : 'n/a', inline: true },
          ),
      ],
    });
  },
};

module.exports = [ping];
