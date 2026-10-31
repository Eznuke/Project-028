'use strict';

const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const config = require('../../config');
const ai = require('../../services/ai');
const settings = require('../../services/settings');
const { formatDuration } = require('../../utils/time');

const aiCmd = {
  data: guildCommand('ai', 'Chat with the optional AI assistant')
    .addSubcommand((s) => s.setName('ask').setDescription('Ask the AI something')
      .addStringOption((o) => o.setName('prompt').setDescription('Your message').setRequired(true).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('reset').setDescription('Forget our conversation in this channel'))
    .addSubcommand((s) => s.setName('status').setDescription('Show whether AI chat is available and its limits')),
  cooldown: 2, // the AI service applies its own per-user cooldown and hourly limit

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'status') {
      const guildOn = settings.view(interaction.guildId).ai.enabled;
      const channels = settings.view(interaction.guildId).ai.channelIds;
      await interaction.reply({
        embeds: [embeds.base('🤖 AI chat status', [
          `Bot-wide: ${config.ai.enabled ? '🟢 available' : config.ai.requested ? '🔴 enabled but no API key' : '🔴 disabled by the owner'}`,
          `This server: ${guildOn ? '🟢 on' : '🔴 off (admins: `/config ai enabled:true`)'}`,
          `Auto-reply channels: ${channels.map((id) => `<#${id}>`).join(' ') || 'none (mention me or use `/ai ask`)'}`,
          `Cooldown: ${formatDuration(config.ai.cooldownMs)} • Hourly limit: ${config.ai.hourlyLimit}`,
          `Model: \`${config.ai.model}\``,
        ].join('\n'))],
        flags: EPHEMERAL,
      });
      return;
    }

    if (sub === 'reset') {
      const had = ai.reset(interaction.user.id, interaction.channelId);
      await interaction.reply({ embeds: [embeds.success(had ? 'I forgot our conversation in this channel.' : 'There was nothing to forget.')], flags: EPHEMERAL });
      return;
    }

    if (!settings.view(interaction.guildId).ai.enabled && config.ai.enabled) {
      await interaction.reply({ embeds: [embeds.error('AI chat is turned off in this server. An admin can enable it with `/config ai enabled:true`.')], flags: EPHEMERAL });
      return;
    }
    await interaction.deferReply();
    const answer = await ai.ask({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      prompt: interaction.options.getString('prompt', true),
      username: interaction.member?.displayName ?? interaction.user.username,
    });
    await interaction.editReply({ content: answer, allowedMentions: { parse: [] } });
  },
};

module.exports = [aiCmd];
