'use strict';

const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const { UserError } = require('../../utils/errors');
const { parseDuration } = require('../../utils/time');
const { truncate } = require('../../utils/text');

const P = PermissionFlagsBits;
const onOff = (v) => (v ? '🟢 on' : '🔴 off');

function statusEmbed(guildId) {
  const s = settings.view(guildId).moderation;
  const a = s.automod;
  const r = s.antiRaid;
  return embeds
    .base('🤖 AutoMod and anti-raid', `Master switch: **${onOff(a.enabled)}**\nPunishment: **${a.punishment}**${a.punishment === 'timeout' ? ` (${a.timeoutDuration})` : ''}`)
    .addFields(
      { name: 'Anti-spam', value: `${onOff(a.spam.enabled)}\n${a.spam.maxMessages} msgs / ${a.spam.perSeconds}s\n${a.spam.duplicateLimit} duplicates`, inline: true },
      { name: 'Anti-link', value: `${onOff(a.links.enabled)}\nAllowed: ${a.links.allowedDomains.join(', ') || 'none'}`, inline: true },
      { name: 'Invites', value: `${onOff(a.invites.enabled)}\nOwn server allowed: ${a.invites.allowOwnServer ? 'yes' : 'no'}`, inline: true },
      { name: 'Mentions', value: `${onOff(a.mentions.enabled)}\nMax ${a.mentions.maxMentions}`, inline: true },
      { name: 'Blocked words', value: `${onOff(a.words.enabled)}\n${a.words.list.length} word(s)`, inline: true },
      { name: 'Caps', value: `${onOff(a.caps.enabled)}\n≥${a.caps.percent}% of ${a.caps.minLength}+ letters`, inline: true },
      {
        name: 'Anti-raid',
        value: `${onOff(r.enabled)}\n${r.joinThreshold} joins / ${r.perSeconds}s → ${r.action}\nMin account age: ${r.minAccountAgeDays} day(s)`,
        inline: true,
      },
      {
        name: 'Ignored',
        value: `Roles: ${a.ignoredRoleIds.map((id) => `<@&${id}>`).join(' ') || 'none'}\nChannels: ${a.ignoredChannelIds.map((id) => `<#${id}>`).join(' ') || 'none'}`,
      },
    )
    .setFooter({ text: 'Members with Manage Messages are never auto-moderated.' });
}

const automod = {
  data: guildCommand('automod', 'Configure AutoMod: anti-spam, anti-link, anti-raid, filters', P.ManageGuild)
    .addSubcommand((s) => s.setName('status').setDescription('Show the current AutoMod settings'))
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn the whole AutoMod system on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('punishment')
        .setDescription('Choose what happens when a rule is broken')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('Punishment')
            .setRequired(true)
            .addChoices({ name: 'Delete message only', value: 'delete' }, { name: 'Delete + warn', value: 'warn' }, { name: 'Delete + timeout', value: 'timeout' }),
        )
        .addStringOption((o) => o.setName('timeout_duration').setDescription('For timeouts, e.g. 5m or 1h')),
    )
    .addSubcommand((s) =>
      s
        .setName('spam')
        .setDescription('Anti-spam: too many or repeated messages')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addIntegerOption((o) => o.setName('max_messages').setDescription('Messages allowed in the window').setMinValue(2).setMaxValue(30))
        .addIntegerOption((o) => o.setName('per_seconds').setDescription('Window length in seconds').setMinValue(2).setMaxValue(60))
        .addIntegerOption((o) => o.setName('duplicates').setDescription('Identical messages allowed in the window').setMinValue(2).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('links')
        .setDescription('Anti-link: block links except allowed domains')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addStringOption((o) => o.setName('allow_domain').setDescription('Add an allowed domain, e.g. youtube.com'))
        .addStringOption((o) => o.setName('remove_domain').setDescription('Remove an allowed domain')),
    )
    .addSubcommand((s) =>
      s
        .setName('invites')
        .setDescription('Invite filter: block Discord invite links')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addBooleanOption((o) => o.setName('allow_own_server').setDescription('Still allow invites to this server')),
    )
    .addSubcommand((s) =>
      s
        .setName('mentions')
        .setDescription('Mention limit per message')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addIntegerOption((o) => o.setName('max').setDescription('Maximum mentions per message').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) =>
      s
        .setName('caps')
        .setDescription('Excessive capital letters')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addIntegerOption((o) => o.setName('percent').setDescription('Percent of capitals that triggers it').setMinValue(40).setMaxValue(100))
        .addIntegerOption((o) => o.setName('min_length').setDescription('Minimum letters before checking').setMinValue(8).setMaxValue(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('words')
        .setDescription('Blocked words list')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What to do')
            .setRequired(true)
            .addChoices(
              { name: 'Turn filter on', value: 'on' },
              { name: 'Turn filter off', value: 'off' },
              { name: 'Add a word', value: 'add' },
              { name: 'Remove a word', value: 'remove' },
              { name: 'Show the list (only you see it)', value: 'list' },
              { name: 'Clear the list', value: 'clear' },
            ),
        )
        .addStringOption((o) => o.setName('word').setDescription('The word or short phrase (for add/remove)').setMaxLength(50)),
    )
    .addSubcommand((s) =>
      s
        .setName('ignore')
        .setDescription('Exempt a role or channel from AutoMod')
        .addRoleOption((o) => o.setName('role').setDescription('Role to ignore'))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel to ignore').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice))
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove the exemption instead of adding it')),
    )
    .addSubcommand((s) =>
      s
        .setName('raid')
        .setDescription('Anti-raid: reacts to join floods and brand-new accounts')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addIntegerOption((o) => o.setName('join_threshold').setDescription('Joins that count as a raid').setMinValue(3).setMaxValue(100))
        .addIntegerOption((o) => o.setName('per_seconds').setDescription('Within how many seconds').setMinValue(3).setMaxValue(120))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What to do with raiders')
            .addChoices({ name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Only alert staff', value: 'lockdown-alert' }),
        )
        .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Reject accounts younger than N days (0 = off)').setMinValue(0).setMaxValue(365))
        .addChannelOption((o) => o.setName('alert_channel').setDescription('Where to post raid alerts').addChannelTypes(ChannelType.GuildText)),
    ),
  cooldown: 3,
  userPermissions: [P.ManageGuild],

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const o = interaction.options;
    let note = null;

    if (sub === 'status') {
      await interaction.reply({ embeds: [statusEmbed(guildId)], flags: EPHEMERAL });
      return;
    }

    settings.update(guildId, (s) => {
      const a = s.moderation.automod;
      switch (sub) {
        case 'toggle':
          a.enabled = o.getBoolean('enabled', true);
          break;
        case 'punishment': {
          a.punishment = o.getString('action', true);
          const d = o.getString('timeout_duration');
          if (d) {
            const ms = parseDuration(d);
            if (!ms || ms > 28 * 86_400_000) throw new UserError('Invalid timeout duration (max 28d).');
            a.timeoutDuration = d.toLowerCase();
          }
          break;
        }
        case 'spam':
          a.spam.enabled = o.getBoolean('enabled', true);
          a.spam.maxMessages = o.getInteger('max_messages') ?? a.spam.maxMessages;
          a.spam.perSeconds = o.getInteger('per_seconds') ?? a.spam.perSeconds;
          a.spam.duplicateLimit = o.getInteger('duplicates') ?? a.spam.duplicateLimit;
          break;
        case 'links': {
          a.links.enabled = o.getBoolean('enabled', true);
          const clean = (v) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
          const add = o.getString('allow_domain');
          const rem = o.getString('remove_domain');
          if (add) {
            const d = clean(add);
            if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new UserError('That does not look like a domain (example: `youtube.com`).');
            if (!a.links.allowedDomains.includes(d)) a.links.allowedDomains.push(d);
            if (a.links.allowedDomains.length > 50) throw new UserError('You can allow at most 50 domains.');
          }
          if (rem) a.links.allowedDomains = a.links.allowedDomains.filter((d) => d !== clean(rem));
          break;
        }
        case 'invites':
          a.invites.enabled = o.getBoolean('enabled', true);
          a.invites.allowOwnServer = o.getBoolean('allow_own_server') ?? a.invites.allowOwnServer;
          break;
        case 'mentions':
          a.mentions.enabled = o.getBoolean('enabled', true);
          a.mentions.maxMentions = o.getInteger('max') ?? a.mentions.maxMentions;
          break;
        case 'caps':
          a.caps.enabled = o.getBoolean('enabled', true);
          a.caps.percent = o.getInteger('percent') ?? a.caps.percent;
          a.caps.minLength = o.getInteger('min_length') ?? a.caps.minLength;
          break;
        case 'words': {
          const action = o.getString('action', true);
          const word = o.getString('word')?.trim().toLowerCase();
          if (action === 'on') a.words.enabled = true;
          else if (action === 'off') a.words.enabled = false;
          else if (action === 'clear') a.words.list = [];
          else if (action === 'add' || action === 'remove') {
            if (!word) throw new UserError('Give the `word` option.');
            if (action === 'add') {
              if (a.words.list.length >= 200) throw new UserError('The list is full (200 words).');
              if (!a.words.list.includes(word)) a.words.list.push(word);
              a.words.enabled = true;
            } else {
              a.words.list = a.words.list.filter((w) => w !== word);
            }
          } else if (action === 'list') {
            note = a.words.list.length ? `Blocked words (${a.words.list.length}):\n||${truncate(a.words.list.join(', '), 1500)}||` : 'The blocked word list is empty.';
          }
          break;
        }
        case 'ignore': {
          const role = o.getRole('role');
          const channel = o.getChannel('channel');
          const remove = o.getBoolean('remove') ?? false;
          if (!role && !channel) throw new UserError('Choose a `role` or a `channel`.');
          const toggle = (list, id) => (remove ? list.filter((x) => x !== id) : list.includes(id) ? list : [...list, id]);
          if (role) a.ignoredRoleIds = toggle(a.ignoredRoleIds, role.id);
          if (channel) a.ignoredChannelIds = toggle(a.ignoredChannelIds, channel.id);
          break;
        }
        case 'raid': {
          const r = s.moderation.antiRaid;
          r.enabled = o.getBoolean('enabled', true);
          r.joinThreshold = o.getInteger('join_threshold') ?? r.joinThreshold;
          r.perSeconds = o.getInteger('per_seconds') ?? r.perSeconds;
          r.action = o.getString('action') ?? r.action;
          r.minAccountAgeDays = o.getInteger('min_account_age_days') ?? r.minAccountAgeDays;
          r.alertChannelId = o.getChannel('alert_channel')?.id ?? r.alertChannelId;
          break;
        }
        default:
          throw new UserError('Unknown subcommand.');
      }
    });

    audit.record(guildId, interaction.user.id, `automod.${sub}`, null, 'settings changed');
    if (note) {
      await interaction.reply({ content: note, flags: EPHEMERAL });
      return;
    }
    await interaction.reply({ embeds: [embeds.success('AutoMod settings updated.'), statusEmbed(guildId)], flags: EPHEMERAL });
  },
};

module.exports = [automod];
