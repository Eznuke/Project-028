'use strict';

const {
  PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const { guildCommand, EPHEMERAL } = require('../../utils/builders');
const embeds = require('../../utils/embeds');
const settings = require('../../services/settings');
const audit = require('../../services/audit');
const tickets = require('../../services/tickets');
const apps = require('../../services/applications');
const tempvoice = require('../../services/tempvoice');
const welcome = require('../../services/welcome');
const defaults = require('../../config/defaults');
const { UserError } = require('../../utils/errors');
const { confirm } = require('../../utils/confirm');
const { canManageRole } = require('../../utils/permissions');
const { parseDuration, isValidTimezone } = require('../../utils/time');
const { truncate } = require('../../utils/text');

const P = PermissionFlagsBits;
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.MentionEveryone];

/**
 * Declarative option specs. One spec both registers the slash-command option and
 * says where the value is stored (dotted path inside the settings object).
 *   type: bool | int | num | str | color | image | channel | role | roleadd | roleremove | chanadd | chanremove
 */
const SPECS = {
  welcome: [
    { name: 'enabled', type: 'bool', desc: 'Turn welcome messages on or off', path: 'welcome.enabled' },
    { name: 'channel', type: 'channel', desc: 'Channel for welcome messages', path: 'welcome.channelId' },
    { name: 'embed', type: 'bool', desc: 'Use an embed (otherwise plain text)', path: 'welcome.useEmbed' },
    { name: 'title', type: 'str', desc: 'Embed title. Placeholders: {user} {username} {server} {memberCount}', path: 'welcome.title', max: 100 },
    { name: 'message', type: 'str', desc: 'Message. Placeholders: {user} {username} {tag} {id} {server} {memberCount}', path: 'welcome.message', max: 1000 },
    { name: 'color', type: 'color', desc: 'Embed color as hex, e.g. #57F287', path: 'welcome.color' },
    { name: 'image', type: 'image', desc: 'Large image URL (https) or "none" to remove', path: 'welcome.imageUrl' },
    { name: 'show_avatar', type: 'bool', desc: 'Show the member avatar as thumbnail', path: 'welcome.showAvatar' },
    { name: 'dm', type: 'bool', desc: 'Also send a welcome DM', path: 'welcome.dmEnabled' },
    { name: 'dm_message', type: 'str', desc: 'Text of the welcome DM (same placeholders)', path: 'welcome.dmMessage', max: 1000 },
  ],
  goodbye: [
    { name: 'enabled', type: 'bool', desc: 'Turn goodbye messages on or off', path: 'goodbye.enabled' },
    { name: 'channel', type: 'channel', desc: 'Channel for goodbye messages', path: 'goodbye.channelId' },
    { name: 'embed', type: 'bool', desc: 'Use an embed (otherwise plain text)', path: 'goodbye.useEmbed' },
    { name: 'title', type: 'str', desc: 'Embed title. Placeholders: {username} {server} {memberCount}', path: 'goodbye.title', max: 100 },
    { name: 'message', type: 'str', desc: 'Message. Placeholders: {user} {username} {tag} {id} {server} {memberCount}', path: 'goodbye.message', max: 1000 },
    { name: 'color', type: 'color', desc: 'Embed color as hex, e.g. #ED4245', path: 'goodbye.color' },
    { name: 'image', type: 'image', desc: 'Large image URL (https) or "none" to remove', path: 'goodbye.imageUrl' },
    { name: 'show_avatar', type: 'bool', desc: 'Show the member avatar as thumbnail', path: 'goodbye.showAvatar' },
  ],
  leveling: [
    { name: 'enabled', type: 'bool', desc: 'Turn XP and levels on or off', path: 'leveling.enabled' },
    { name: 'xp_min', type: 'int', desc: 'Minimum XP per message', path: 'leveling.xpMin', min: 1, max: 1000 },
    { name: 'xp_max', type: 'int', desc: 'Maximum XP per message', path: 'leveling.xpMax', min: 1, max: 1000 },
    { name: 'cooldown', type: 'int', desc: 'Seconds between XP gains per member', path: 'leveling.cooldownSeconds', min: 5, max: 3600 },
    { name: 'min_length', type: 'int', desc: 'Minimum message length that earns XP', path: 'leveling.minMessageLength', min: 0, max: 100 },
    { name: 'multiplier', type: 'num', desc: 'XP multiplier (e.g. 2 for double XP)', path: 'leveling.multiplier', min: 0.1, max: 10 },
    { name: 'announce', type: 'bool', desc: 'Announce level-ups', path: 'leveling.announce' },
    { name: 'announce_channel', type: 'channel', desc: 'Channel for level-up messages (default: same channel)', path: 'leveling.announceChannelId' },
    { name: 'message', type: 'str', desc: 'Level-up text. Placeholders: {user} {username} {level} {server}', path: 'leveling.message', max: 300 },
    { name: 'stack_roles', type: 'bool', desc: 'Keep old level roles (otherwise only the highest)', path: 'leveling.stackRoles' },
    { name: 'no_xp_channel_add', type: 'chanadd', desc: 'Channel where no XP is earned', path: 'leveling.noXpChannelIds' },
    { name: 'no_xp_channel_remove', type: 'chanremove', desc: 'Channel to earn XP in again', path: 'leveling.noXpChannelIds' },
  ],
  economy: [
    { name: 'enabled', type: 'bool', desc: 'Turn the economy on or off', path: 'economy.enabled' },
    { name: 'currency_name', type: 'str', desc: 'Currency name (e.g. coins)', path: 'economy.currencyName', max: 20 },
    { name: 'currency_symbol', type: 'str', desc: 'Currency symbol or emoji', path: 'economy.currencySymbol', max: 10 },
    { name: 'starting_balance', type: 'int', desc: 'Coins new accounts start with', path: 'economy.startingBalance', min: 0, max: 1_000_000_000 },
    { name: 'daily', type: 'int', desc: 'Daily reward', path: 'economy.dailyAmount', min: 0, max: 1_000_000 },
    { name: 'weekly', type: 'int', desc: 'Weekly reward', path: 'economy.weeklyAmount', min: 0, max: 10_000_000 },
    { name: 'work_min', type: 'int', desc: 'Minimum /work payout', path: 'economy.workMin', min: 0, max: 1_000_000 },
    { name: 'work_max', type: 'int', desc: 'Maximum /work payout', path: 'economy.workMax', min: 0, max: 1_000_000 },
    { name: 'work_cooldown', type: 'int', desc: 'Minutes between /work', path: 'economy.workCooldownMinutes', min: 1, max: 1440 },
    { name: 'beg_cooldown', type: 'int', desc: 'Minutes between /beg', path: 'economy.begCooldownMinutes', min: 1, max: 1440 },
    { name: 'beg_success', type: 'num', desc: 'Chance that /beg works (0.05 - 1)', path: 'economy.begSuccessRate', min: 0.05, max: 1 },
    { name: 'rob_enabled', type: 'bool', desc: 'Allow /rob', path: 'economy.robEnabled' },
    { name: 'rob_success', type: 'num', desc: 'Chance that /rob succeeds (0.05 - 0.9)', path: 'economy.robSuccessRate', min: 0.05, max: 0.9 },
    { name: 'max_bet', type: 'int', desc: 'Maximum bet in gambling games', path: 'economy.maxBet', min: 1, max: 100_000_000 },
    { name: 'bank_limit', type: 'int', desc: 'Bank capacity per member (0 = unlimited)', path: 'economy.bankLimit', min: 0, max: 1_000_000_000 },
    { name: 'sell_refund', type: 'int', desc: 'Percent of the price paid when selling items', path: 'economy.sellRefundPercent', min: 0, max: 100 },
  ],
  suggestions: [
    { name: 'channel', type: 'channel', desc: 'Channel where suggestions are posted', path: 'suggestions.channelId' },
    { name: 'log_channel', type: 'channel', desc: 'Channel notified about decisions', path: 'suggestions.logChannelId' },
    { name: 'staff_role_add', type: 'roleadd', desc: 'Role allowed to approve/reject suggestions', path: 'suggestions.staffRoleIds', check: false },
    { name: 'staff_role_remove', type: 'roleremove', desc: 'Remove a suggestion staff role', path: 'suggestions.staffRoleIds' },
    { name: 'anonymous', type: 'bool', desc: 'Hide the author of suggestions', path: 'suggestions.anonymous' },
    { name: 'require_note', type: 'bool', desc: 'Staff must write a note when deciding', path: 'suggestions.requireStaffNote' },
  ],
  autorole: [
    { name: 'role_add', type: 'roleadd', desc: 'Role given to every new member', path: 'autorole.roleIds', check: true },
    { name: 'role_remove', type: 'roleremove', desc: 'Stop giving this role to new members', path: 'autorole.roleIds' },
    { name: 'bot_role_add', type: 'roleadd', desc: 'Role given to every new bot', path: 'autorole.botRoleIds', check: true },
    { name: 'bot_role_remove', type: 'roleremove', desc: 'Stop giving this role to new bots', path: 'autorole.botRoleIds' },
  ],
  confessions: [
    { name: 'channel', type: 'channel', desc: 'Channel where anonymous confessions are posted', path: 'confessions.channelId' },
  ],
  tempvoice: [
    { name: 'enabled', type: 'bool', desc: 'Turn join-to-create voice rooms on or off', path: 'tempVoice.enabled' },
    { name: 'lobby', type: 'voicechan', desc: 'Voice channel members join to get their own room', path: 'tempVoice.lobbyChannelId' },
    { name: 'category', type: 'catchan', desc: 'Category where the rooms are created (default: the lobby\'s category)', path: 'tempVoice.categoryId' },
    { name: 'name_template', type: 'str', desc: 'Room name. Placeholders: {user} {username} {count}', path: 'tempVoice.nameTemplate', max: 60 },
    { name: 'default_limit', type: 'int', desc: 'Starting user limit of new rooms (0 = none)', path: 'tempVoice.defaultLimit', min: 0, max: 99 },
    { name: 'max_rooms', type: 'int', desc: 'Most rooms that may exist at once', path: 'tempVoice.maxRooms', min: 1, max: 100 },
  ],
  prefix: [
    { name: 'enabled', type: 'bool', desc: 'Allow chat commands like !help (slash commands always work)', path: 'prefix.enabled' },
    { name: 'value', type: 'prefix', desc: 'Prefix for chat commands, 1-5 characters (default !)', path: 'prefix.value', max: 5 },
    { name: 'allow_mention', type: 'bool', desc: 'Also accept "@Bot command" as a chat command', path: 'prefix.allowMention' },
  ],
  appearance: [
    { name: 'accent_color', type: 'color', desc: 'Accent color as hex', path: 'display.accentColor' },
  ],
  ai: [
    { name: 'enabled', type: 'bool', desc: 'Turn AI chat on for this server (needs API key on the bot)', path: 'ai.enabled' },
    { name: 'channel_add', type: 'chanadd', desc: 'Channel where I answer every message', path: 'ai.channelIds' },
    { name: 'channel_remove', type: 'chanremove', desc: 'Stop answering in this channel', path: 'ai.channelIds' },
  ],
};

const DESCRIPTIONS = {
  welcome: 'Configure welcome messages',
  goodbye: 'Configure goodbye messages',
  leveling: 'Configure XP and levels',
  economy: 'Configure the economy',
  suggestions: 'Configure suggestions',
  autorole: 'Configure automatic roles for new members',
  confessions: 'Configure anonymous confessions',
  prefix: 'Configure the chat-command prefix (for example !help)',
  tempvoice: 'Configure join-to-create voice rooms',
  appearance: 'Configure the look of the bot in this server',
  ai: 'Configure AI chat for this server',
};

function addSpecOption(sub, spec) {
  const base = (o) => o.setName(spec.name).setDescription(spec.desc.slice(0, 100));
  switch (spec.type) {
    case 'bool': return sub.addBooleanOption(base);
    case 'int': return sub.addIntegerOption((o) => base(o).setMinValue(spec.min).setMaxValue(spec.max));
    case 'num': return sub.addNumberOption((o) => base(o).setMinValue(spec.min).setMaxValue(spec.max));
    case 'channel': case 'chanadd': case 'chanremove': return sub.addChannelOption((o) => base(o).addChannelTypes(...TEXT));
    case 'voicechan': return sub.addChannelOption((o) => base(o).addChannelTypes(ChannelType.GuildVoice));
    case 'catchan': return sub.addChannelOption((o) => base(o).addChannelTypes(ChannelType.GuildCategory));
    case 'role': case 'roleadd': case 'roleremove': return sub.addRoleOption(base);
    default: return sub.addStringOption((o) => base(o).setMaxLength(spec.max ?? (spec.type === 'image' ? 500 : 20)));
  }
}

function getPath(obj, path) {
  return path.split('.').reduce((n, k) => (n === undefined || n === null ? undefined : n[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (const k of keys.slice(0, -1)) node = node[k];
  node[keys[keys.length - 1]] = value;
}

/** Reads the option for a spec. Returns undefined when it was not provided. */
function readOption(o, spec, interaction) {
  const get = {
    bool: () => o.getBoolean(spec.name), int: () => o.getInteger(spec.name), num: () => o.getNumber(spec.name),
    channel: () => o.getChannel(spec.name), voicechan: () => o.getChannel(spec.name), catchan: () => o.getChannel(spec.name), chanadd: () => o.getChannel(spec.name), chanremove: () => o.getChannel(spec.name),
    role: () => o.getRole(spec.name), roleadd: () => o.getRole(spec.name), roleremove: () => o.getRole(spec.name),
  }[spec.type] ?? (() => o.getString(spec.name));
  const v = get();
  return v === null ? undefined : v;
}

function checkRole(interaction, role) {
  const res = canManageRole(interaction.guild, interaction.member, role);
  if (!res.ok) throw new UserError(res.reason);
  if (DANGEROUS.some((p) => role.permissions.has(p))) throw new UserError(`${role} has moderation/admin permissions, so it cannot be handed out automatically.`);
}

/** Applies every provided option of a subcommand. Returns change descriptions. */
function applySpecs(interaction, specs) {
  const g = interaction.guildId;
  const o = interaction.options;
  const changes = [];
  // Validate first, then write once.
  const writes = [];
  for (const spec of specs) {
    const v = readOption(o, spec, interaction);
    if (v === undefined) continue;
    switch (spec.type) {
      case 'bool': case 'int': case 'num':
        writes.push({ spec, value: v, text: `${spec.name}: **${v}**` }); break;
      case 'channel': case 'voicechan': case 'catchan':
        writes.push({ spec, value: v.id, text: `${spec.name}: ${v}` }); break;
      case 'role':
        writes.push({ spec, value: v.id, text: `${spec.name}: ${v}` }); break;
      case 'color': {
        if (!embeds.isHexColor(v)) throw new UserError(`\`${spec.name}\` must be a hex color like \`#57F287\`.`);
        const hex = `#${v.trim().replace('#', '').toUpperCase()}`;
        writes.push({ spec, value: hex, text: `${spec.name}: **${hex}**` }); break;
      }
      case 'image': {
        if (v.trim().toLowerCase() === 'none') { writes.push({ spec, value: null, text: `${spec.name}: removed` }); break; }
        let ok = false;
        try { ok = new URL(v).protocol === 'https:'; } catch { /* invalid */ }
        if (!ok) throw new UserError('The image must be an `https://` link (or `none`).');
        writes.push({ spec, value: v.trim(), text: `${spec.name}: set` }); break;
      }
      case 'prefix': {
        const value = v.trim();
        if (!/^[^\s`@#*_~|\\/<>]{1,5}$/u.test(value)) throw new UserError('The prefix must be 1-5 characters with no spaces and none of `` ` @ # * _ ~ | \\ / < > ``. Examples: `!` `?` `.` `$` `b!`');
        writes.push({ spec, value, text: `${spec.name}: \`${value}\`` }); break;
      }
      case 'str':
        writes.push({ spec, value: v.trim(), text: `${spec.name}: \`${truncate(v.trim(), 60)}\`` }); break;
      case 'chanadd': writes.push({ spec, list: 'add', value: v.id, text: `${spec.name}: ${v}` }); break;
      case 'chanremove': writes.push({ spec, list: 'remove', value: v.id, text: `${spec.name}: ${v}` }); break;
      case 'roleadd':
        if (spec.check) checkRole(interaction, v);
        writes.push({ spec, list: 'add', value: v.id, text: `${spec.name}: ${v}` }); break;
      case 'roleremove': writes.push({ spec, list: 'remove', value: v.id, text: `${spec.name}: ${v}` }); break;
      default: break;
    }
  }
  if (!writes.length) return changes;
  settings.update(g, (s) => {
    for (const w of writes) {
      if (w.list) {
        const list = getPath(s, w.spec.path);
        const next = w.list === 'add' ? [...new Set([...list, w.value])] : list.filter((x) => x !== w.value);
        if (next.length > 50) throw new UserError('That list is full (max 50).');
        setPath(s, w.spec.path, next);
      } else {
        setPath(s, w.spec.path, w.value);
      }
      changes.push(w.text);
    }
    if (s.leveling.xpMin > s.leveling.xpMax) throw new UserError('`xp_min` cannot be greater than `xp_max`.');
    if (s.economy.workMin > s.economy.workMax) throw new UserError('`work_min` cannot be greater than `work_max`.');
  });
  return changes;
}

/** Human readable view of one settings section. */
function describeSection(section, data, depth = 0) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (depth < 2) lines.push(`**${key}:**`, ...describeSection(section, value, depth + 1).map((l) => `  ${l}`));
      continue;
    }
    let text;
    if (Array.isArray(value)) {
      if (/RoleIds$/.test(key)) text = value.map((id) => `<@&${id}>`).join(' ') || '*none*';
      else if (/ChannelIds$/.test(key)) text = value.map((id) => `<#${id}>`).join(' ') || '*none*';
      else if (key === 'levelRoles') text = value.map((r) => `L${r.level}→<@&${r.roleId}>`).join(' ') || '*none*';
      else if (key === 'warnThresholds') text = value.map((t) => `${t.count} warns→${t.action}${t.duration ? ` (${t.duration})` : ''}`).join(', ') || '*none*';
      else if (key === 'categories') text = value.map((c) => c.label).join(', ') || '*none*';
      else text = value.length ? truncate(value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', '), 80) : '*none*';
    } else if (/ChannelId$|^categoryId$/.test(key)) text = value ? `<#${value}>` : '*not set*';
    else if (/RoleId$/.test(key)) text = value ? `<@&${value}>` : '*not set*';
    else if (typeof value === 'boolean') text = value ? '🟢 on' : '🔴 off';
    else if (value === null || value === '') text = '*not set*';
    else text = `\`${truncate(String(value), 80)}\``;
    lines.push(`${key}: ${text}`);
  }
  return lines;
}

function sectionEmbed(section, guildId, title) {
  const data = settings.view(guildId)[SECTION_OF[section] ?? section];
  const lines = describeSection(section, data);
  return embeds.base(title ?? `⚙️ ${section}`, truncate(lines.join('\n'), 4000));
}

// ---- Interactive panel -------------------------------------------------------

const PANEL_SECTIONS = {
  welcome: { label: 'Welcome', toggles: [['welcome.enabled', 'Welcome']] },
  goodbye: { label: 'Goodbye', toggles: [['goodbye.enabled', 'Goodbye']] },
  moderation: { label: 'Moderation', toggles: [['moderation.dmOnAction', 'DM on action'], ['moderation.automod.enabled', 'AutoMod'], ['moderation.antiRaid.enabled', 'Anti-raid']] },
  leveling: { label: 'Leveling', toggles: [['leveling.enabled', 'Leveling'], ['leveling.announce', 'Announce']] },
  economy: { label: 'Economy', toggles: [['economy.enabled', 'Economy'], ['economy.robEnabled', 'Robbing']] },
  tickets: { label: 'Tickets', toggles: [['tickets.preventDuplicates', 'No duplicates']] },
  suggestions: { label: 'Suggestions', toggles: [['suggestions.anonymous', 'Anonymous']] },
  prefix: { label: 'Chat prefix', toggles: [['prefix.enabled', 'Chat commands'], ['prefix.allowMention', '@mention prefix']] },
  tempvoice: { label: 'Temp voice', toggles: [['tempVoice.enabled', 'Temp voice rooms']] },
  applications: { label: 'Applications', toggles: [['applications.enabled', 'Applications open'], ['applications.dmApplicant', 'DM applicant']] },
  ai: { label: 'AI chat', toggles: [['ai.enabled', 'AI chat']] },
};

function panelPayload(guildId, section) {
  const select = new StringSelectMenuBuilder().setCustomId('cfg:section').setPlaceholder('Choose a settings section').addOptions(
    Object.entries(PANEL_SECTIONS).map(([value, s]) => ({ label: s.label, value, default: value === section })),
  );
  const rows = [new ActionRowBuilder().addComponents(select)];
  let embed = embeds.base('⚙️ Server configuration', 'Pick a section to view it. Use the buttons to flip switches, or the `/config <section>` commands to change values.');
  if (section) {
    embed = sectionEmbed(section, guildId, `⚙️ ${PANEL_SECTIONS[section].label}`);
    const buttons = PANEL_SECTIONS[section].toggles.map(([path, label]) => {
      const on = getPath(settings.view(guildId), path);
      return new ButtonBuilder().setCustomId(`cfg:toggle:${section}:${path}`).setLabel(`${label}: ${on ? 'ON' : 'OFF'}`).setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
    });
    rows.push(new ActionRowBuilder().addComponents(buttons));
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

// ---- Command ---------------------------------------------------------------------

const builder = guildCommand('config', 'Configure the bot for this server', P.ManageGuild);

for (const [name, specs] of Object.entries(SPECS)) {
  builder.addSubcommand((s) => {
    s.setName(name).setDescription(DESCRIPTIONS[name]);
    for (const spec of specs) addSpecOption(s, spec);
    if (name === 'welcome' || name === 'goodbye') s.addBooleanOption((o) => o.setName('test').setDescription('Show me a preview with my own account'));
    return s;
  });
}

builder
  .addSubcommand((s) => {
    s.setName('logs').setDescription('Configure log channels')
      .addStringOption((o) => o.setName('category').setDescription('Which log').setRequired(true).addChoices(
        { name: 'All categories', value: 'all' }, { name: 'Messages', value: 'messages' }, { name: 'Members', value: 'members' },
        { name: 'Roles & nicknames', value: 'roles' }, { name: 'Channels', value: 'channels' }, { name: 'Voice', value: 'voice' },
        { name: 'Moderation', value: 'moderation' }, { name: 'Tickets', value: 'tickets' }))
      .addChannelOption((o) => o.setName('channel').setDescription('Log channel (omit to keep)').addChannelTypes(...TEXT))
      .addBooleanOption((o) => o.setName('enabled').setDescription('Enable or disable this log category'))
      .addBooleanOption((o) => o.setName('clear').setDescription('Remove the channel of this category'))
      .addChannelOption((o) => o.setName('ignore_channel').setDescription('Never log messages from this channel').addChannelTypes(...TEXT))
      .addChannelOption((o) => o.setName('unignore_channel').setDescription('Log messages from this channel again').addChannelTypes(...TEXT));
    return s;
  })
  .addSubcommand((s) =>
    s.setName('moderation').setDescription('Configure moderation behaviour (AutoMod has its own /automod command)')
      .addBooleanOption((o) => o.setName('dm_on_action').setDescription('DM members when they are punished'))
      .addBooleanOption((o) => o.setName('require_reason').setDescription('Require a reason for every moderation action'))
      .addIntegerOption((o) => o.setName('mass_role_limit').setDescription('Max members changed by one /massrole').setMinValue(1).setMaxValue(500))
      .addIntegerOption((o) => o.setName('purge_max').setDescription('Max messages per /purge').setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName('warn_timeout_at').setDescription('Auto-timeout at N active warnings (0 = off)').setMinValue(0).setMaxValue(20))
      .addStringOption((o) => o.setName('warn_timeout_duration').setDescription('Auto-timeout length, e.g. 1h (default 1h)').setMaxLength(10))
      .addIntegerOption((o) => o.setName('warn_kick_at').setDescription('Auto-kick at N active warnings (0 = off)').setMinValue(0).setMaxValue(20)))
  .addSubcommand((s) => tickets.addSetupOptions(s.setName('tickets').setDescription('Configure tickets (same options as /ticket setup)')))
  .addSubcommand((s) => apps.addSetupOptions(s.setName('applications').setDescription('Configure staff applications (form, review channel, roles)')))
  .addSubcommand((s) => s.setName('timezone').setDescription('Set the default time zone of this server')
    .addStringOption((o) => o.setName('zone').setDescription('IANA name, e.g. Asia/Jakarta (or "none")').setRequired(true).setMaxLength(50)))
  .addSubcommand((s) => s.setName('view').setDescription('Show one settings section')
    .addStringOption((o) => o.setName('section').setDescription('Section to show').setRequired(true).addChoices(
      ...['welcome', 'goodbye', 'logs', 'moderation', 'leveling', 'economy', 'tickets', 'suggestions', 'autorole', 'confessions', 'prefix', 'appearance', 'tempvoice', 'applications', 'ai'].map((v) => ({ name: v, value: v })))))
  .addSubcommand((s) => s.setName('panel').setDescription('Open the interactive configuration menu'))
  .addSubcommand((s) => s.setName('reset').setDescription('Reset one section to its defaults')
    .addStringOption((o) => o.setName('section').setDescription('Section to reset').setRequired(true).addChoices(
      ...['welcome', 'goodbye', 'logs', 'moderation', 'leveling', 'economy', 'tickets', 'suggestions', 'confessions', 'prefix', 'tempvoice', 'applications', 'ai'].map((v) => ({ name: v, value: v })))));

const SECTION_OF = { appearance: 'display', autorole: 'autorole', tempvoice: 'tempVoice' };

const config = {
  data: builder,
  cooldown: 3,
  userPermissions: [P.ManageGuild],

  async execute(interaction) {
    const g = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const ephemeral = { flags: EPHEMERAL, allowedMentions: { parse: [] } };

    if (sub === 'panel') {
      await interaction.reply({ ...panelPayload(g, null), flags: EPHEMERAL });
      return;
    }

    if (sub === 'view') {
      const section = interaction.options.getString('section', true);
      await interaction.reply({ embeds: [sectionEmbed(SECTION_OF[section] ?? section, g, `⚙️ ${section}`)], ...ephemeral });
      return;
    }

    if (sub === 'reset') {
      const section = interaction.options.getString('section', true);
      const ok = await confirm(interaction, { description: `Reset all **${section}** settings to their defaults?`, confirmLabel: 'Reset' });
      if (!ok) return;
      settings.resetSection(g, SECTION_OF[section] ?? section);
      audit.record(g, interaction.user.id, 'config.reset', section);
      await interaction.editReply({ embeds: [embeds.success(`Section **${section}** was reset.`)], components: [] });
      return;
    }

    let changes = [];
    let section = SECTION_OF[sub] ?? sub;

    if (SPECS[sub]) {
      changes = applySpecs(interaction, SPECS[sub]);
    } else if (sub === 'logs') {
      changes = applyLogs(interaction);
      section = 'logs';
    } else if (sub === 'moderation') {
      changes = applyModeration(interaction);
    } else if (sub === 'tickets') {
      changes = tickets.applySetup(g, interaction.options);
    } else if (sub === 'applications') {
      changes = await apps.applySetup(interaction);
    } else if (sub === 'timezone') {
      const zone = interaction.options.getString('zone', true).trim();
      if (zone.toLowerCase() === 'none') {
        settings.set(g, 'utility.timezone', null);
        changes.push('Server time zone cleared');
      } else {
        if (!isValidTimezone(zone)) throw new UserError('Unknown time zone. Use an IANA name such as `Asia/Jakarta` or `Europe/London`.');
        settings.set(g, 'utility.timezone', zone);
        changes.push(`Server time zone: **${zone}**`);
      }
      section = 'utility';
    }

    if (changes.length) audit.record(g, interaction.user.id, `config.${sub}`, null, changes.join('; '));
    const warnings = sub === 'tempvoice' ? tempvoice.problems(interaction.guild).map((i) => `⚠️ ${i}`) : [];
    const embed = sectionEmbed(section, g, `⚙️ ${sub}`);
    embed.setDescription(`${changes.length ? `**Updated**\n${changes.map((c) => `• ${c}`).join('\n')}\n\n` : '*No options given, nothing changed.*\n\n'}${embed.data.description}${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`.slice(0, 4000));
    await interaction.reply({ embeds: [embed], ...ephemeral });

    if ((sub === 'welcome' || sub === 'goodbye') && interaction.options.getBoolean('test')) {
      const cfg = settings.view(g)[sub];
      await interaction.followUp({ content: `Preview of the ${sub} message:`, ...welcome.render(sub, cfg, interaction.member), allowedMentions: { parse: [] }, flags: EPHEMERAL });
    }
  },

  components: {
    async cfg(interaction, args) {
      if (!interaction.inGuild() || !interaction.memberPermissions.has(P.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission.', flags: MessageFlags.Ephemeral });
      }
      const g = interaction.guildId;
      const [action, section, ...rest] = args;
      if (action === 'section') {
        const chosen = interaction.values[0];
        if (!PANEL_SECTIONS[chosen]) return undefined;
        return interaction.update(panelPayload(g, chosen));
      }
      if (action === 'toggle') {
        const path = rest.join(':');
        const allowed = PANEL_SECTIONS[section]?.toggles.some(([p]) => p === path);
        if (!allowed) return undefined;
        const next = !getPath(settings.view(g), path);
        settings.set(g, path, next);
        audit.record(g, interaction.user.id, 'config.toggle', path, String(next));
        return interaction.update(panelPayload(g, section));
      }
      return undefined;
    },
  },
};

function applyLogs(interaction) {
  const o = interaction.options;
  const category = o.getString('category', true);
  const channel = o.getChannel('channel');
  const enabled = o.getBoolean('enabled');
  const clear = o.getBoolean('clear');
  const ignore = o.getChannel('ignore_channel');
  const unignore = o.getChannel('unignore_channel');
  const keys = category === 'all' ? Object.keys(defaults.logs.channels) : [category];
  const changes = [];
  const me = interaction.guild.members.me;
  if (channel && !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
    throw new UserError(`I need View Channel, Send Messages and Embed Links in ${channel}.`);
  }
  settings.update(interaction.guildId, (s) => {
    for (const k of keys) {
      if (channel) { s.logs.channels[k] = channel.id; changes.push(`${k} logs → ${channel}`); }
      if (clear) { s.logs.channels[k] = null; changes.push(`${k} logs: channel removed`); }
      if (enabled !== null) { s.logs.enabled[k] = enabled; changes.push(`${k} logs: ${enabled ? 'enabled' : 'disabled'}`); }
    }
    if (ignore) { s.logs.ignoredChannelIds = [...new Set([...s.logs.ignoredChannelIds, ignore.id])]; changes.push(`Ignoring messages in ${ignore}`); }
    if (unignore) { s.logs.ignoredChannelIds = s.logs.ignoredChannelIds.filter((id) => id !== unignore.id); changes.push(`No longer ignoring ${unignore}`); }
  });
  return changes;
}

function applyModeration(interaction) {
  const o = interaction.options;
  const changes = [];
  const timeoutAt = o.getInteger('warn_timeout_at');
  const kickAt = o.getInteger('warn_kick_at');
  const durationText = o.getString('warn_timeout_duration');
  let duration = null;
  if (durationText) {
    duration = parseDuration(durationText);
    if (!duration || duration > 28 * 86_400_000) throw new UserError('Timeout duration must be between 1 second and 28 days, e.g. `1h`.');
  }
  settings.update(interaction.guildId, (s) => {
    const m = s.moderation;
    const dm = o.getBoolean('dm_on_action');
    if (dm !== null) { m.dmOnAction = dm; changes.push(`DM on action: ${dm ? 'on' : 'off'}`); }
    const req = o.getBoolean('require_reason');
    if (req !== null) { m.requireReason = req; changes.push(`Require reason: ${req ? 'on' : 'off'}`); }
    const mass = o.getInteger('mass_role_limit');
    if (mass !== null) { m.massRoleLimit = mass; changes.push(`Mass role limit: ${mass}`); }
    const purge = o.getInteger('purge_max');
    if (purge !== null) { m.purgeMax = purge; changes.push(`Purge max: ${purge}`); }
    if (timeoutAt !== null || kickAt !== null || durationText) {
      const current = m.warnThresholds;
      const oldTimeout = current.find((t) => t.action === 'timeout');
      const oldKick = current.find((t) => t.action === 'kick');
      const next = [];
      const tCount = timeoutAt ?? oldTimeout?.count ?? 0;
      const tDuration = durationText ?? oldTimeout?.duration ?? '1h';
      const kCount = kickAt ?? oldKick?.count ?? 0;
      if (tCount > 0) next.push({ count: tCount, action: 'timeout', duration: tDuration });
      if (kCount > 0) next.push({ count: kCount, action: 'kick', duration: null });
      m.warnThresholds = next;
      changes.push(`Warning punishments: ${next.map((t) => `${t.count}→${t.action}`).join(', ') || 'none'}`);
    }
  });
  return changes;
}

module.exports = [config];
