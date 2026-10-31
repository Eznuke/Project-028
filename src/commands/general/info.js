'use strict';

const fs = require('node:fs');
const os = require('node:os');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  version: discordJsVersion,
} = require('discord.js');
const { anywhereCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const config = require('../../config');
const db = require('../../database');
const { formatDuration, ts } = require('../../utils/time');
const { formatNumber } = require('../../utils/text');
const pkg = require('../../../package.json');

const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

function inviteUrl(client) {
  return (
    `https://discord.com/oauth2/authorize?client_id=${client.user.id}` +
    `&permissions=${config.invitePermissions}&scope=bot%20applications.commands`
  );
}

const about = {
  data: anywhereCommand('about', 'Learn what this bot can do'),
  cooldown: 5,
  guildOnly: false,
  async execute(interaction, client) {
    const e = embeds
      .base(
        `About ${client.user.username}`,
        'An all-in-one bot for moderation, leveling, economy, tickets, suggestions, utilities and fun. ' +
          'Use `/help` to browse every command.',
      )
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Version', value: pkg.version, inline: true },
        { name: 'Servers', value: formatNumber(client.guilds.cache.size), inline: true },
        { name: 'Commands', value: formatNumber(client.commands.size), inline: true },
        {
          name: 'Highlights',
          value:
            '🛡️ Moderation, AutoMod, anti-raid\n📈 XP and level roles\n💰 Virtual economy and shop\n🎫 Tickets with transcripts\n💡 Suggestions with voting\n🏷️ Self-role panels',
        },
      );
    await interaction.reply({ embeds: [e] });
  },
};

const botinfo = {
  data: anywhereCommand('botinfo', 'Technical information about the bot'),
  cooldown: 10,
  guildOnly: false,
  async execute(interaction, client) {
    let dbSize = 0;
    try {
      dbSize = fs.statSync(config.dbPath).size;
    } catch {
      /* new database */
    }
    const users = client.guilds.cache.reduce((n, g) => n + g.memberCount, 0);
    const mem = process.memoryUsage();
    const e = embeds
      .base(`${client.user.username} — technical info`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Servers', value: formatNumber(client.guilds.cache.size), inline: true },
        { name: 'Members (total)', value: formatNumber(users), inline: true },
        { name: 'Commands run', value: formatNumber(client.stats.commandsRun), inline: true },
        { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
        { name: 'WebSocket ping', value: `${Math.round(client.ws.ping)} ms`, inline: true },
        { name: 'Memory', value: formatBytes(mem.rss), inline: true },
        { name: 'Database', value: formatBytes(dbSize), inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'discord.js', value: `v${discordJsVersion}`, inline: true },
        { name: 'Platform', value: `${os.platform()} ${os.arch()}`, inline: true },
      );
    await interaction.reply({ embeds: [e] });
  },
};

const uptime = {
  data: anywhereCommand('uptime', 'How long the bot has been online'),
  cooldown: 5,
  guildOnly: false,
  async execute(interaction, client) {
    const since = client.stats.readyAt ?? Date.now() - process.uptime() * 1000;
    await interaction.reply({
      embeds: [embeds.info(`Online for **${formatDuration(Date.now() - since, 4)}**\nSince ${ts(since, 'F')}`, '⏱️ Uptime')],
    });
  },
};

const invite = {
  data: anywhereCommand('invite', 'Get the link to add this bot to your server'),
  cooldown: 5,
  guildOnly: false,
  async execute(interaction, client) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Add to server').setStyle(ButtonStyle.Link).setURL(inviteUrl(client)),
    );
    await interaction.reply({
      embeds: [embeds.info('Click the button to invite me. You need **Manage Server** permission in the target server.')],
      components: [row],
      flags: EPHEMERAL,
    });
  },
};

const support = {
  data: anywhereCommand('support', 'Get help with the bot'),
  cooldown: 5,
  guildOnly: false,
  async execute(interaction) {
    if (!config.supportServerUrl) {
      await interaction.reply({
        embeds: [embeds.info('No support server is configured. Ask the bot owner, or use `/help` and `/report` in this server.')],
        flags: EPHEMERAL,
      });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Join support server').setStyle(ButtonStyle.Link).setURL(config.supportServerUrl),
    );
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(embeds.COLORS.primary).setDescription('Need help? Join the support server.')], components: [row], flags: EPHEMERAL });
  },
};

module.exports = [about, botinfo, uptime, invite, support];
