'use strict';

const config = require('../config');
const settings = require('./settings');
const aliasTable = require('../config/aliases');
const logger = require('../utils/logger');

/** Settings that apply to chat commands in this place (a server, or a DM with the bot). */
function prefixSettings(guildId) {
  if (!guildId) return { enabled: true, value: config.defaultPrefix, allowMention: false };
  const p = settings.view(guildId).prefix;
  return { enabled: p.enabled !== false, value: p.value || config.defaultPrefix, allowMention: p.allowMention !== false };
}

/** Text that goes in front of a command when we show usage to the user. */
function displayPrefix(guildId) {
  const p = prefixSettings(guildId);
  return p.enabled ? p.value : '/';
}

let aliasCache = { commands: null, size: -1, map: new Map() };

/** alias -> command name, skipping anything that clashes with a real command or another alias. */
function aliasMap(commands) {
  if (aliasCache.commands === commands && aliasCache.size === commands.size) return aliasCache.map;
  const map = new Map();
  for (const [name, aliases] of Object.entries(aliasTable)) {
    if (!commands.has(name)) continue;
    for (const alias of aliases) {
      const a = alias.toLowerCase();
      if (commands.has(a) || map.has(a)) {
        logger.warn(`Chat alias "${a}" for "${name}" clashes with another command or alias and is ignored.`);
        continue;
      }
      map.set(a, name);
    }
  }
  aliasCache = { commands, size: commands.size, map };
  return map;
}

function aliasesOf(commands, name) {
  return [...aliasMap(commands)].filter(([, target]) => target === name).map(([alias]) => alias);
}

/** Finds a command by its name or alias (case-insensitive). */
function findCommand(commands, word) {
  const w = String(word ?? '').toLowerCase();
  if (!w) return null;
  if (commands.has(w)) return commands.get(w);
  const target = aliasMap(commands).get(w);
  return target ? commands.get(target) : null;
}

/**
 * Decides whether a message is a chat command.
 * @returns {{ command: object, word: string, args: string, via: 'prefix'|'mention' } | { bareMention: true } | null}
 */
function parseInvocation(message, client) {
  const text = message.content;
  if (!text || text.length > 2000) return null;
  const guildId = message.guild?.id ?? null;
  const p = prefixSettings(guildId);

  let rest = null;
  let via = null;
  const mention = new RegExp(`^<@!?${client.user.id}>`).exec(text);
  if (mention && (p.allowMention || !guildId)) {
    const after = text.slice(mention[0].length);
    if (!after.trim()) return { bareMention: true };
    if (/^\s/.test(after)) { rest = after.trimStart(); via = 'mention'; }
  } else if (p.enabled && text.toLowerCase().startsWith(p.value.toLowerCase())) {
    rest = text.slice(p.value.length);
    via = 'prefix';
  }
  if (rest === null) return null;

  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (!m) return null;
  const command = findCommand(client.commands, m[1]);
  if (!command) return null;
  return { command, word: m[1].toLowerCase(), args: (m[2] ?? '').trim(), via };
}

module.exports = { prefixSettings, displayPrefix, parseInvocation, findCommand, aliasesOf, aliasMap };
