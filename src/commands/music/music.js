'use strict';

const { guildCommand } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const music = require('../../services/music');
const { UserError } = require('../../utils/errors');
const { truncate, escapeMarkdown } = require('../../utils/text');

const musicCmd = {
  data: guildCommand('music', 'Optional music player for direct audio links and attachments')
    .addSubcommand((s) => s.setName('play').setDescription('Play a direct audio link (mp3/ogg/radio stream) or an uploaded audio file')
      .addStringOption((o) => o.setName('url').setDescription('Direct audio URL (https)').setMaxLength(500))
      .addAttachmentOption((o) => o.setName('file').setDescription('An audio file instead of a link')))
    .addSubcommand((s) => s.setName('pause').setDescription('Pause playback'))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume playback'))
    .addSubcommand((s) => s.setName('skip').setDescription('Skip the current track'))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop and leave the voice channel'))
    .addSubcommand((s) => s.setName('queue').setDescription('Show the queue'))
    .addSubcommand((s) => s.setName('volume').setDescription('Set the volume')
      .addIntegerOption((o) => o.setName('percent').setDescription('0 - 100').setRequired(true).setMinValue(0).setMaxValue(100))),
  cooldown: 3,
  botPermissions: [],

  async execute(interaction) {
    music.assertEnabled();
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;
    const m = interaction.member;

    if (sub === 'play') {
      const url = interaction.options.getString('url');
      const file = interaction.options.getAttachment('file');
      if (!url && !file) throw new UserError('Give me a `url` or attach an audio `file`.');
      if (file && !(file.contentType ?? '').startsWith('audio/')) throw new UserError('That attachment is not an audio file.');
      const target = file ? file.url : url.trim();
      let title = file?.name;
      if (!title) {
        try {
          title = truncate(new URL(target).hostname, 60);
        } catch {
          throw new UserError('That is not a valid URL.');
        }
      }
      await interaction.deferReply();
      const s = await music.enqueue(m, { url: target, title, requestedBy: interaction.user.id });
      await interaction.editReply({ embeds: [embeds.success(`Queued **${escapeMarkdown(title)}** (position ${s.queue.length || 'now playing'}).`, '🎵 Music')] });
      return;
    }
    if (sub === 'pause') { music.pause(g, m); await interaction.reply({ embeds: [embeds.info('⏸️ Paused.')] }); return; }
    if (sub === 'resume') { music.resume(g, m); await interaction.reply({ embeds: [embeds.info('▶️ Resumed.')] }); return; }
    if (sub === 'skip') { music.skip(g, m); await interaction.reply({ embeds: [embeds.info('⏭️ Skipped.')] }); return; }
    if (sub === 'stop') { music.stop(g, m); await interaction.reply({ embeds: [embeds.info('⏹️ Stopped and left the channel.')] }); return; }
    if (sub === 'volume') {
      const p = interaction.options.getInteger('percent', true);
      music.setVolume(g, m, p);
      await interaction.reply({ embeds: [embeds.info(`🔊 Volume set to **${p}%**.`)] });
      return;
    }
    const snap = music.snapshot(g);
    if (!snap) throw new UserError('Nothing is playing.');
    const lines = [`**Now:** ${snap.current ? escapeMarkdown(snap.current.title) : '*loading…*'}`, ...snap.queue.map((t, i) => `${i + 1}. ${escapeMarkdown(t.title)}`)];
    await interaction.reply({ embeds: [embeds.base('🎵 Queue', truncate(lines.join('\n'), 4000)).setFooter({ text: `Volume ${Math.round(snap.volume * 100)}%` })] });
  },
};

module.exports = [musicCmd];
