'use strict';

const { PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const db = require('../../database');
const gw = require('../../services/giveaways');
const { UserError } = require('../../utils/errors');
const { parseDuration, ts } = require('../../utils/time');
const { stripMentions, truncate } = require('../../utils/text');

const P = PermissionFlagsBits;
const MAX_ACTIVE = 10;
const idOption = (o) => o.setName('id').setDescription('Giveaway number (shown in its footer)').setRequired(true).setMinValue(1);

function loadOwn(interaction) {
  const row = gw.get(interaction.options.getInteger('id', true));
  if (!row || row.guild_id !== interaction.guildId) throw new UserError('I could not find that giveaway in this server.');
  return row;
}

const giveaway = {
  data: guildCommand('giveaway', 'Run giveaways with an enter button and automatic winners', P.ManageGuild)
    .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway')
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
      .addStringOption((o) => o.setName('duration').setDescription('How long it runs, e.g. 30m, 12h, 3d').setRequired(true).setMaxLength(12))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role can enter'))
      .addIntegerOption((o) => o.setName('min_level').setDescription('Minimum chat level to enter').setMinValue(1).setMaxValue(500)))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and pick the winners').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a giveaway without winners').addIntegerOption(idOption))
    .addSubcommand((s) => s.setName('reroll').setDescription('Pick new winner(s) for an ended giveaway')
      .addIntegerOption(idOption)
      .addIntegerOption((o) => o.setName('count').setDescription('How many new winners (default 1)').setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName('list').setDescription('Show the running giveaways')),
  cooldown: 5,
  userPermissions: [P.ManageGuild],

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;

    if (sub === 'list') {
      const rows = db.all("SELECT * FROM giveaways WHERE guild_id = ? AND status = 'active' ORDER BY ends_at LIMIT 15", g);
      const text = rows.map((r) => `**#${r.id}** · ${truncate(stripMentions(r.prize), 60)} · ${gw.entryCount(r.id)} entries · ends ${ts(r.ends_at, 'R')} · <#${r.channel_id}>`).join('\n');
      await interaction.reply({ embeds: [embeds.base('🎁 Running giveaways', text || 'No giveaway is running. Start one with `/giveaway start`.')], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'start') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      if (!gw.canPost(channel, interaction.guild.members.me)) throw new UserError(`I need View Channel, Send Messages and Embed Links in ${channel}.`);
      const ms = parseDuration(interaction.options.getString('duration', true));
      if (!ms || ms < 60_000 || ms > 30 * 86_400_000) throw new UserError('Duration must be between 1 minute and 30 days, e.g. `30m`, `12h`, `3d`.');
      const active = db.get("SELECT COUNT(*) AS n FROM giveaways WHERE guild_id = ? AND status = 'active'", g).n;
      if (active >= MAX_ACTIVE) throw new UserError(`This server already has ${MAX_ACTIVE} running giveaways. End or cancel one first.`);
      const prize = stripMentions(interaction.options.getString('prize', true)).trim();
      if (!prize) throw new UserError('The prize cannot be empty.');
      const role = interaction.options.getRole('required_role');
      if (role?.id === g) throw new UserError('Pick a real role, not @everyone.');

      const id = db.run(
        `INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winner_count, ends_at, required_role_id, min_level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        g, channel.id, interaction.user.id, prize, interaction.options.getInteger('winners') ?? 1,
        Date.now() + ms, role?.id ?? null, interaction.options.getInteger('min_level') ?? 0, Date.now(),
      ).lastInsertRowid;
      try {
        const message = await channel.send(gw.render(gw.get(id)));
        db.run('UPDATE giveaways SET message_id = ? WHERE id = ?', message.id, id);
        await interaction.reply({ embeds: [embeds.success(`Giveaway **#${id}** started in ${channel}: [jump to it](${message.url}).`)], flags: EPHEMERAL });
      } catch (err) {
        db.run('DELETE FROM giveaways WHERE id = ?', id); // nothing was posted, so nothing to keep
        throw err;
      }
      return;
    }

    const row = loadOwn(interaction);

    if (sub === 'reroll') {
      if (row.status !== 'ended') throw new UserError('Only an ended giveaway can be rerolled.');
      const fresh = await gw.reroll(client, row.id, interaction.options.getInteger('count') ?? 1);
      if (!fresh.length) throw new UserError('There is nobody left to pick: every valid entrant has already won.');
      await interaction.reply({ embeds: [embeds.success(`Picked ${fresh.map((w) => `<@${w}>`).join(', ')}.`)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }

    if (row.status !== 'active') throw new UserError('That giveaway is not running.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const winners = await gw.end(client, row.id, { cancel: sub === 'cancel' });
    await interaction.editReply({
      embeds: [embeds.success(sub === 'cancel' ? `Giveaway **#${row.id}** was cancelled.` : `Giveaway **#${row.id}** ended. ${winners?.length ? `Winner${winners.length > 1 ? 's' : ''}: ${winners.map((w) => `<@${w}>`).join(', ')}` : 'Nobody entered.'}`)],
      allowedMentions: { parse: [] },
    });
  },

  components: {
    async gw(interaction, args) {
      const [action, idText] = args;
      if (action !== 'enter') return undefined;
      const row = gw.get(Number(idText));
      const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      if (!row || row.guild_id !== interaction.guildId) return reply('This giveaway no longer exists.');
      const member = interaction.member;
      const problem = gw.entryProblem(row, member);
      if (problem) return reply(`❌ ${problem}`);

      const already = db.get('SELECT 1 AS x FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', row.id, interaction.user.id);
      if (already) {
        db.run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', row.id, interaction.user.id);
      } else {
        db.run('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)', row.id, interaction.user.id, Date.now());
      }
      // Update the message (entry counter) and tell the member what happened.
      await interaction.update(gw.render(row)).catch(() => {});
      await interaction.followUp({ content: already ? '👋 You left the giveaway. Press the button again to re-enter.' : '🎉 You are in! Good luck. Press the button again to leave.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return undefined;
    },
  },
};

module.exports = [giveaway];
