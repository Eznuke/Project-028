'use strict';

const { PermissionFlagsBits } = require('discord.js');
const settings = require('./settings');
const logging = require('./logging');
const mod = require('./moderation');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');
const { parseDuration, formatDuration } = require('../utils/time');
const { escapeRegex, truncate } = require('../utils/text');

const INVITE_RE = /(?:discord(?:app)?\.(?:gg|com\/invite)|discord\.me|invite\.gg)\/([\w-]+)/i;
const URL_RE = /\bhttps?:\/\/[^\s<>]+|\bwww\.[^\s<>]+/gi;

const spamTracker = new Map(); // `${guildId}:${userId}` -> [{ at, text }]
const punishLock = new Map(); // `${guildId}:${userId}` -> expiry
const wordCache = new Map(); // guildId -> { key, regex }
const inviteCache = new Map(); // guildId -> { at, codes:Set }

/** Collects invite codes that belong to this server (needs Manage Server; otherwise just the vanity URL). */
async function ownInviteCodes(guild) {
  const hit = inviteCache.get(guild.id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.codes;
  const codes = new Set();
  if (guild.vanityURLCode) codes.add(guild.vanityURLCode.toLowerCase());
  try {
    if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      const invites = await guild.invites.fetch();
      for (const code of invites.keys()) codes.add(code.toLowerCase());
    }
  } catch {
    /* keep what we have */
  }
  inviteCache.set(guild.id, { at: Date.now(), codes });
  return codes;
}

function wordRegex(guildId, list) {
  const key = list.join('\u0000');
  const cached = wordCache.get(guildId);
  if (cached && cached.key === key) return cached.regex;
  const regex = list.length
    ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${list.map(escapeRegex).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'iu')
    : null;
  wordCache.set(guildId, { key, regex });
  return regex;
}

function hostOf(raw) {
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Returns a short violation reason or null when the message is fine. */
async function detect(message, cfg) {
  const text = message.content ?? '';

  if (cfg.invites.enabled) {
    const match = text.match(INVITE_RE);
    if (match) {
      const code = match[1].toLowerCase();
      const own = cfg.invites.allowOwnServer ? await ownInviteCodes(message.guild) : new Set();
      if (!own.has(code)) return 'Posting server invites is not allowed';
    }
  }

  if (cfg.links.enabled) {
    const urls = text.match(URL_RE) ?? [];
    for (const raw of urls) {
      if (INVITE_RE.test(raw)) continue; // handled by the invite filter
      const host = hostOf(raw);
      if (!host) continue;
      const allowed = cfg.links.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!allowed) return 'Posting links is not allowed here';
    }
  }

  if (cfg.words.enabled && cfg.words.list.length) {
    const regex = wordRegex(message.guild.id, cfg.words.list);
    if (regex && regex.test(` ${text} `)) return 'Used a blocked word';
  }

  if (cfg.mentions.enabled) {
    const total = message.mentions.users.size + message.mentions.roles.size;
    if (total > cfg.mentions.maxMentions) return `Too many mentions (${total})`;
  }

  if (cfg.caps.enabled) {
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length >= cfg.caps.minLength) {
      const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
      if ((upper / letters.length) * 100 >= cfg.caps.percent) return 'Too many capital letters';
    }
  }

  if (cfg.spam.enabled) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const windowMs = cfg.spam.perSeconds * 1000;
    const list = (spamTracker.get(key) ?? []).filter((e) => now - e.at < windowMs);
    list.push({ at: now, text: text.trim().toLowerCase() });
    spamTracker.set(key, list);

    if (list.length > cfg.spam.maxMessages) {
      spamTracker.delete(key);
      return 'Sending messages too fast (spam)';
    }
    if (text.trim().length > 0) {
      const same = list.filter((e) => e.text === text.trim().toLowerCase()).length;
      if (same >= cfg.spam.duplicateLimit) {
        spamTracker.delete(key);
        return 'Repeating the same message (spam)';
      }
    }
  }
  return null;
}

/** Entry point from the messageCreate event. Returns true when the message was actioned. */
async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.system || !message.member) return false;
  const cfg = settings.view(message.guild.id).moderation.automod;
  if (!cfg.enabled) return false;
  if (cfg.ignoredChannelIds.includes(message.channelId)) return false;
  if (message.member.roles.cache.some((r) => cfg.ignoredRoleIds.includes(r.id))) return false;
  // Staff are never auto-moderated.
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages) || message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return false;
  }

  const violation = await detect(message, cfg);
  if (!violation) return false;

  const lockKey = `${message.guild.id}:${message.author.id}`;
  const locked = (punishLock.get(lockKey) ?? 0) > Date.now();
  punishLock.set(lockKey, Date.now() + 8000);

  // Always try to remove the offending message.
  if (message.deletable) await message.delete().catch(() => {});
  if (locked) return true; // already punished a moment ago, only delete

  await punish(message, cfg, violation);
  return true;
}

async function punish(message, cfg, violation) {
  const { guild, member } = message;
  const botId = guild.client.user.id;
  let outcome = 'message deleted';

  try {
    if (cfg.punishment === 'warn') {
      const result = await mod.addWarning({ guild, member, moderatorId: botId, reason: `AutoMod: ${violation}` });
      outcome = `warning #${result.count}${result.punishment ? `, then ${result.punishment}` : ''}`;
      await mod.dmUser(member.user, guild, { action: 'warn', reason: `AutoMod: ${violation}` });
    } else if (cfg.punishment === 'timeout' && member.moderatable) {
      const ms = Math.min(parseDuration(cfg.timeoutDuration) ?? 300_000, mod.MAX_TIMEOUT_MS);
      await mod.dmUser(member.user, guild, { action: 'timeout', reason: `AutoMod: ${violation}`, durationMs: ms });
      await member.timeout(ms, `AutoMod: ${violation}`);
      mod.createCase({ guild, userId: member.id, moderatorId: botId, action: 'timeout', reason: `AutoMod: ${violation}`, durationMs: ms });
      outcome = `timed out for ${formatDuration(ms)}`;
    } else {
      logging.send(
        guild,
        'moderation',
        embeds
          .base('🤖 AutoMod', `${member} in <#${message.channelId}>: **${violation}**\nAction: message deleted.`, embeds.COLORS.warning)
          .setFooter({ text: `User ID ${member.id}` }),
      );
    }
  } catch (err) {
    logger.warn(`AutoMod punishment failed in ${guild.id}: ${err.message}`);
  }

  try {
    const notice = await message.channel.send({
      content: `${member}, ${truncate(violation.toLowerCase(), 100)}. Action: ${outcome}.`,
      allowedMentions: { users: [member.id] },
    });
    setTimeout(() => notice.delete().catch(() => {}), 6000).unref?.();
  } catch {
    /* no permission to talk here */
  }
}

// Keep the trackers small.
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of spamTracker) {
    if (list.length === 0 || now - list[list.length - 1].at > 60_000) spamTracker.delete(key);
  }
  for (const [key, expiry] of punishLock) if (expiry < now) punishLock.delete(key);
}, 60_000).unref?.();

module.exports = { handleMessage, detect };
