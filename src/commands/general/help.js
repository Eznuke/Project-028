'use strict';

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const embeds = require('../../utils/embeds');
const config = require('../../config');
const { permissionNames } = require('../../utils/permissions');
const { usageLines } = require('../../utils/argparse');
const { truncate } = require('../../utils/text');
const prefix = require('../../services/prefix');

const CATEGORY_META = {
  general: { label: 'General', emoji: 'ℹ️', blurb: 'Information about the bot, users, roles, channels and the server.' },
  moderation: { label: 'Moderation', emoji: '🛡️', blurb: 'Keep the server safe: punishments, warnings, case history, channel tools and AutoMod.' },
  leveling: { label: 'Leveling', emoji: '📈', blurb: 'XP from chatting, ranks, leaderboards and level rewards.' },
  economy: { label: 'Economy', emoji: '💰', blurb: 'A virtual currency: earn it, bank it, spend it in the shop or gamble it. No real money.' },
  fun: { label: 'Fun & Social', emoji: '🎉', blurb: 'Games, polls, random fun and social commands.' },
  utility: { label: 'Utility', emoji: '🧰', blurb: 'Reminders, calculator, unit converter, translator and personal tools.' },
  tickets: { label: 'Tickets', emoji: '🎫', blurb: 'Private support channels with claiming and transcripts.' },
  giveaways: { label: 'Giveaways', emoji: '🎁', blurb: 'Giveaways with an enter button, requirements and automatic winners.' },
  suggestions: { label: 'Suggestions', emoji: '💡', blurb: 'Members suggest, everyone votes, staff decide.' },
  config: { label: 'Server Config', emoji: '⚙️', blurb: 'Set up welcome messages, logs, leveling, economy, the chat prefix and more.' },
  roles: { label: 'Roles', emoji: '🏷️', blurb: 'Self-role panels and verification buttons.' },
  music: { label: 'Music', emoji: '🎵', blurb: 'Optional voice playback of direct audio links.' },
  ai: { label: 'AI Chat', emoji: '🤖', blurb: 'Optional AI assistant (needs an API key on the bot).' },
  owner: { label: 'Owner', emoji: '👑', blurb: 'Bot-owner tools.' },
};

const meta = (key) => CATEGORY_META[key] ?? { label: key, emoji: '📦', blurb: '' };

// ---- data helpers ---------------------------------------------------------------------

function visibleCommands(client, userId) {
  return [...client.commands.values()].filter((c) => !c.ownerOnly || config.isOwner(userId));
}

function groupByCategory(commands) {
  const order = Object.keys(CATEGORY_META);
  const groups = new Map();
  for (const c of commands) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  for (const list of groups.values()) list.sort((a, b) => a.data.name.localeCompare(b.data.name));
  return new Map([...groups].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
}

/** The prefix to show in examples: the chat prefix when it is on, otherwise "/". */
function shown(guildId) {
  const p = prefix.prefixSettings(guildId);
  return { chat: p.enabled ? p.value : null, mention: p.enabled || p.allowMention, slash: '/' };
}

function permissionText(command) {
  const json = command.data.toJSON();
  const bits = command.userPermissions?.length
    ? command.userPermissions.reduce((a, b) => a | b, 0n)
    : (json.default_member_permissions ? BigInt(json.default_member_permissions) : 0n);
  return bits ? permissionNames(bits).join(', ') : null;
}

// ---- pages ------------------------------------------------------------------------------

function menu(groups, selected) {
  const options = [
    { label: 'Home', value: 'home', emoji: '🏠', description: 'Overview and quick start', default: selected === 'home' || !selected },
    { label: 'How to use commands', value: 'guide', emoji: '📖', description: 'Slash commands, chat prefix, arguments', default: selected === 'guide' },
    ...[...groups.keys()].slice(0, 23).map((key) => ({
      label: meta(key).label, value: key, emoji: meta(key).emoji, default: key === selected,
      description: `${groups.get(key).length} command${groups.get(key).length === 1 ? '' : 's'}`,
    })),
  ];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help:category').setPlaceholder('📚 Browse a category').addOptions(options),
  );
}

function linkRow(client) {
  const buttons = [];
  if (config.supportServerUrl) buttons.push(new ButtonBuilder().setLabel('Support server').setStyle(ButtonStyle.Link).setURL(config.supportServerUrl));
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

function howToLine(s) {
  const lines = ['**Slash:** type `/` and pick a command — Discord shows every option for you.'];
  if (s.chat) lines.push(`**Chat:** write \`${s.chat}command\` — for example \`${s.chat}balance\` or \`${s.chat}help moderation\`.`);
  if (s.mention) lines.push('**Mention:** `@me command` works too.');
  return lines.join('\n');
}

function homePage(client, groups, guildId) {
  const s = shown(guildId);
  const total = [...groups.values()].reduce((n, l) => n + l.length, 0);
  const e = embeds.base(`📚 ${client.user.username} — help`,
    `${howToLine(s)}\n\nPick a category in the menu below, or look up one command with \`${s.chat ?? '/'}help <command>\`.`);
  for (const [key, list] of groups) {
    const sample = list.slice(0, 4).map((c) => `\`${c.data.name}\``).join(' ');
    e.addFields({ name: `${meta(key).emoji} ${meta(key).label} · ${list.length}`, value: `${sample}${list.length > 4 ? ' …' : ''}`, inline: true });
  }
  e.setFooter({ text: `${total} commands · <required> [optional] · try ${s.chat ?? '/'}help ping` });
  return e;
}

function guidePage(guildId) {
  const s = shown(guildId);
  const c = s.chat;
  const e = embeds.base('📖 How to use commands', 'Every command works as a **slash command**' + (c ? ` and as a **chat command** with the prefix \`${c}\`.` : '.'));
  e.addFields({ name: '1 · Slash commands', value: 'Type `/`, choose the command and fill in the boxes Discord shows. Some commands (embed builder, confessions, notes, to-do list) only exist as slash commands because they need private replies or forms.' });
  if (c) {
    e.addFields(
      { name: `2 · Chat commands (\`${c}\`)`, value: [
        `Type the prefix and the command name, then the values in the **same order** as the slash options:`,
        `\`${c}balance\` · \`${c}balance @Asa\``,
        `\`${c}timeout @Asa 10m spamming\``,
        `\`${c}roleadd @Asa @Member\``,
        `\`${c}shop add "Golden Ticket" 500\``,
      ].join('\n') },
      { name: '3 · Text with spaces', value: `The last text option (like a reason or message) takes the rest of the line. For other text use "double quotes": \`${c}translate "good morning" id\`` },
      { name: '4 · Skip options by name', value: `Write \`option:value\` to give an option out of order or skip optional ones: \`${c}ban @Asa spam duration:7d\` · \`${c}shop add Sword 250 role:@Warrior\`` },
      { name: '5 · Sub-commands', value: `Some commands have several actions: \`${c}shop view\`, \`${c}level role-add 10 @Veteran\`, \`${c}config prefix value:?\`. Use \`${c}help <command>\` to see them all.` },
      { name: '6 · Short names', value: `Many commands have aliases: \`${c}bal\`, \`${c}lb\`, \`${c}inv\`, \`${c}calc\`… \`${c}help <command>\` lists them.` },
      { name: '7 · Good to know', value: 'Private (ephemeral) answers cannot exist in chat, so they are posted as a reply that **deletes itself after 2 minutes**. Mentions in replies never ping anyone. Admins can change or turn off the prefix with `/config prefix`.' },
    );
  } else {
    e.addFields({ name: 'Chat commands', value: 'Chat commands are switched off in this server. An admin can turn them on with `/config prefix enabled:true`.' });
  }
  e.addFields({ name: 'Reading usage lines', value: '`<name>` is required, `[name]` is optional.' });
  return e;
}

function categoryPage(key, list, guildId, client) {
  const s = shown(guildId);
  const lead = s.chat ?? '/';
  const lines = list.map((c) => {
    const name = c.data.name;
    const aliases = s.chat ? prefix.aliasesOf(client.commands, name).slice(0, 3) : [];
    const extras = [];
    if (aliases.length) extras.push(aliases.map((a) => `${lead}${a}`).join(', '));
    const perm = permissionText(c);
    if (perm) extras.push(`🔒 ${perm}`);
    if (c.prefix === false) extras.push('⌨️ slash only');
    return `**${lead}${name}** — ${c.data.description}${extras.length ? `\n› *${extras.join(' · ')}*` : ''}`;
  });
  const e = embeds.base(`${meta(key).emoji} ${meta(key).label}`, meta(key).blurb);
  // Fields keep each block under Discord's limits no matter how many commands a category has.
  let chunk = '';
  let part = 1;
  const flush = () => { if (chunk) { e.addFields({ name: part === 1 ? 'Commands' : '\u200b', value: chunk }); part += 1; chunk = ''; } };
  for (const line of lines) {
    if ((chunk + '\n' + line).length > 1000) flush();
    chunk = chunk ? `${chunk}\n${line}` : truncate(line, 1000);
  }
  flush();
  e.setFooter({ text: `${list.length} commands · ${lead}help <command> for details` });
  return e;
}

function commandPage(command, guildId, client) {
  const json = command.data.toJSON();
  const s = shown(guildId);
  const e = embeds.base(`${meta(command.category).emoji} /${json.name}`, json.description);

  const chat = s.chat ? usageLines(json, s.chat) : [];
  const slash = usageLines(json, '/');
  const lines = (chat.length ? chat : slash).map((l) => `\`${l.usage}\`${slash.length > 1 ? ` — ${l.description}` : ''}`);
  e.addFields({ name: s.chat && command.prefix !== false ? 'Chat usage' : 'Usage', value: truncate(lines.join('\n'), 1000) });
  if (chat.length && command.prefix !== false) {
    e.addFields({ name: 'Slash usage', value: truncate(slash.map((l) => `\`${l.usage}\``).join('\n'), 1000) });
  } else if (command.prefix === false) {
    e.addFields({ name: 'Chat usage', value: `Not available — \`/${json.name}\` only works as a slash command.` });
  }

  const aliases = s.chat ? prefix.aliasesOf(client.commands, json.name) : [];
  if (aliases.length) e.addFields({ name: 'Aliases', value: aliases.map((a) => `\`${s.chat}${a}\``).join(' '), inline: true });
  e.addFields(
    { name: 'Who can use it', value: permissionText(command) ?? 'Everyone', inline: true },
    { name: 'Cooldown', value: `${command.cooldown}s`, inline: true },
    { name: 'Works in', value: command.guildOnly ? 'Servers only' : 'Servers and DMs', inline: true },
  );
  if (command.botPermissions?.length) {
    e.addFields({ name: 'I need', value: permissionNames(command.botPermissions.reduce((a, b) => a | b, 0n)).join(', '), inline: true });
  }

  const optional = (json.options ?? []).filter((o) => !o.options && !o.required);
  if (s.chat && command.prefix !== false && optional.length >= 2) {
    e.addFields({ name: 'Tip', value: `Skip options with names: \`${s.chat}${json.name} … ${optional[optional.length - 1].name}:value\`` });
  }
  return e;
}

/** Looks up what the user typed: a category, a command or an alias. Returns { page } or { error }. */
function lookup(client, userId, guildId, text) {
  const commands = visibleCommands(client, userId);
  const groups = groupByCategory(commands);
  const first = String(text ?? '').trim().replace(/^[/!]/, '').split(/\s+/)[0].toLowerCase();
  if (!first) return { page: homePage(client, groups, guildId), components: [menu(groups, 'home'), ...linkRow(client)] };
  if (['guide', 'usage', 'howto', 'how'].includes(first)) return { page: guidePage(guildId), components: [menu(groups, 'guide')] };

  const command = prefix.findCommand(client.commands, first);
  if (command && commands.includes(command)) return { page: commandPage(command, guildId, client), components: [menu(groups)] };

  const byLabel = [...groups.keys()].find((k) => k === first || meta(k).label.toLowerCase().split(/\W+/)[0] === first);
  if (byLabel) return { page: categoryPage(byLabel, groups.get(byLabel), guildId, client), components: [menu(groups, byLabel)] };

  const names = commands.map((c) => c.data.name);
  const close = names.filter((n) => n.includes(first) || first.includes(n)).slice(0, 5);
  const hint = close.length ? ` Did you mean ${close.map((n) => `\`${n}\``).join(', ')}?` : ' Use the menu to browse everything.';
  return { error: `I don't know a command or category called \`${truncate(first, 30)}\`.${hint}`, components: [menu(groups, 'home')] };
}

/** Who may change a help message: the person it was opened for (others get their own private copy). */
async function ownerOf(interaction) {
  const meta1 = interaction.message?.interactionMetadata?.user?.id ?? interaction.message?.interaction?.user?.id;
  if (meta1) return meta1;
  const ref = interaction.message?.reference?.messageId;
  if (!ref) return null;
  const original = await interaction.channel?.messages?.fetch(ref).catch(() => null);
  return original?.author?.id ?? null;
}

const help = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Browse all commands, a category, or details about one command')
    .addStringOption((o) =>
      o.setName('command').setDescription('A command, alias or category (for example ban, bal or economy)').setAutocomplete(true).setMaxLength(60),
    ),
  cooldown: 3,
  guildOnly: false,
  prefixPublic: true, // harmless, so a chat reply may stay (it is not deleted like private replies)

  async execute(interaction, client) {
    const res = lookup(client, interaction.user.id, interaction.guildId, interaction.options.getString('command'));
    if (res.error) {
      await interaction.reply({ embeds: [embeds.error(res.error)], components: res.components, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [res.page], components: res.components, flags: MessageFlags.Ephemeral });
  },

  async autocomplete(interaction, client) {
    const typed = interaction.options.getFocused().toLowerCase();
    const commands = visibleCommands(client, interaction.user.id);
    const names = [...commands.map((c) => c.data.name), ...Object.keys(CATEGORY_META).filter((k) => commands.some((c) => c.category === k))];
    const matches = [...new Set(names)].filter((n) => n.includes(typed)).sort((a, b) => (a.startsWith(typed) ? 0 : 1) - (b.startsWith(typed) ? 0 : 1) || a.localeCompare(b)).slice(0, 25);
    await interaction.respond(matches.map((n) => ({ name: n, value: n })));
  },

  components: {
    async help(interaction, args, client) {
      const groups = groupByCategory(visibleCommands(client, interaction.user.id));
      const choice = interaction.values?.[0] ?? 'home';
      const guildId = interaction.guildId;
      let page;
      if (choice === 'guide') page = guidePage(guildId);
      else if (groups.has(choice)) page = categoryPage(choice, groups.get(choice), guildId, client);
      else page = homePage(client, groups, guildId);

      const selected = choice === 'guide' || groups.has(choice) ? choice : 'home';
      const components = [menu(groups, selected), ...(selected === 'home' ? linkRow(client) : [])];
      const owner = await ownerOf(interaction);
      if (owner && owner !== interaction.user.id) {
        // Somebody else clicked a public help message: show them a private copy instead of changing it for everyone.
        await interaction.reply({ embeds: [page], components, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.update({ embeds: [page], components });
    },
  },
};

module.exports = [help];
// Exposed for scripts/check.js, which renders every help page to make sure it fits Discord's limits.
Object.defineProperty(module.exports, 'internals', {
  value: { lookup, homePage, guidePage, categoryPage, commandPage, groupByCategory, visibleCommands },
});
