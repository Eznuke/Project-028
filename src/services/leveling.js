'use strict';

const { PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const settings = require('./settings');
const logger = require('../utils/logger');
const { fill, memberPlaceholders, randomInt } = require('../utils/text');

/** XP needed to go from level n to n+1 (same curve as many popular bots). */
const xpForNext = (level) => 5 * level * level + 50 * level + 100;

/** Total XP needed to *reach* a level from zero. */
function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i++) total += xpForNext(i);
  return total;
}

/** Converts total XP into { level, current, needed } where current/needed is progress inside the level. */
function progress(xp) {
  let level = 0;
  let remaining = Math.max(0, xp);
  while (remaining >= xpForNext(level)) {
    remaining -= xpForNext(level);
    level++;
    if (level > 1000) break;
  }
  return { level, current: remaining, needed: xpForNext(level) };
}

function getRow(guildId, userId) {
  return db.get('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?', guildId, userId);
}

function getRank(guildId, userId) {
  const row = getRow(guildId, userId);
  if (!row) return null;
  const { n } = db.get('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND xp > ?', guildId, row.xp);
  return n + 1;
}

function setXp(guildId, userId, xp) {
  const level = progress(xp).level;
  db.run(
    `INSERT INTO levels (guild_id, user_id, xp, level, messages, last_xp_at) VALUES (?, ?, ?, ?, 0, 0)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level`,
    guildId,
    userId,
    xp,
    level,
  );
  return level;
}

function top(guildId, limit = 100) {
  return db.all('SELECT user_id, xp, level, messages FROM levels WHERE guild_id = ? ORDER BY xp DESC LIMIT ?', guildId, limit);
}

// ---- Anti-farming memory -------------------------------------------------
const lastXp = new Map(); // `${guild}:${user}` -> timestamp
const lastText = new Map(); // `${guild}:${user}` -> last counted text
const recentGrants = new Map(); // `${guild}:${user}` -> [timestamps] (hard cap per hour)
const MAX_GRANTS_PER_HOUR = 90;

function looksLikeFarming(content, key) {
  const cleaned = content
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (new Set(cleaned.toLowerCase()).size < 4) return true; // "aaaaaaa", "....", emoji-only
  if (lastText.get(key) === cleaned.toLowerCase()) return true; // same message repeated
  lastText.set(key, cleaned.toLowerCase());
  return false;
}

/** Applies level roles for `level`. Returns the roles that were granted. */
async function syncLevelRoles(member, level) {
  const cfg = settings.view(member.guild.id).leveling;
  if (!cfg.levelRoles.length) return [];
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return [];

  const usable = (id) => {
    const role = member.guild.roles.cache.get(id);
    return role && !role.managed && role.position < me.roles.highest.position ? role : null;
  };
  const earned = cfg.levelRoles.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  const granted = [];
  try {
    if (cfg.stackRoles) {
      for (const r of earned) {
        const role = usable(r.roleId);
        if (role && !member.roles.cache.has(role.id)) {
          await member.roles.add(role, `Reached level ${r.level}`);
          granted.push(role);
        }
      }
    } else if (earned.length) {
      const best = earned[earned.length - 1];
      const bestRole = usable(best.roleId);
      if (bestRole && !member.roles.cache.has(bestRole.id)) {
        await member.roles.add(bestRole, `Reached level ${best.level}`);
        granted.push(bestRole);
      }
      for (const r of cfg.levelRoles) {
        if (r.roleId === best.roleId) continue;
        const role = usable(r.roleId);
        if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, 'Replaced by a higher level role');
      }
    }
  } catch (err) {
    logger.warn(`Level role sync failed for ${member.id}: ${err.message}`);
  }
  return granted;
}

/** Called for every guild message. Returns { leveledUp, level } or null when nothing was granted. */
async function handleMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId || !message.member) return null;
  const cfg = settings.view(message.guild.id).leveling;
  if (!cfg.enabled) return null;
  if (cfg.noXpChannelIds.includes(message.channelId)) return null;
  if (message.member.roles.cache.some((r) => cfg.noXpRoleIds.includes(r.id))) return null;
  if (message.content.length < cfg.minMessageLength) return null;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastXp.get(key) ?? 0) < cfg.cooldownSeconds * 1000) return null;
  if (looksLikeFarming(message.content, key)) return null;

  const grants = (recentGrants.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (grants.length >= MAX_GRANTS_PER_HOUR) return null;
  grants.push(now);
  recentGrants.set(key, grants);
  lastXp.set(key, now);

  const gained = Math.max(1, Math.round(randomInt(cfg.xpMin, cfg.xpMax) * cfg.multiplier));
  const previous = getRow(message.guild.id, message.author.id);
  const xp = (previous?.xp ?? 0) + gained;
  const level = progress(xp).level;
  const oldLevel = previous?.level ?? 0;

  db.run(
    `INSERT INTO levels (guild_id, user_id, xp, level, messages, last_xp_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level,
       messages = messages + 1, last_xp_at = excluded.last_xp_at`,
    message.guild.id,
    message.author.id,
    xp,
    level,
    now,
  );

  if (level > oldLevel) {
    await syncLevelRoles(message.member, level);
    if (cfg.announce) await announce(message, cfg, level);
    return { leveledUp: true, level };
  }
  return { leveledUp: false, level };
}

async function announce(message, cfg, level) {
  try {
    let channel = message.channel;
    if (cfg.announceChannelId) {
      channel = message.guild.channels.cache.get(cfg.announceChannelId) ?? channel;
    }
    const me = message.guild.members.me;
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;
    const text = fill(cfg.message, memberPlaceholders(message.member, { level }));
    await channel.send({ content: text.slice(0, 1900), allowedMentions: { users: [message.author.id] } });
  } catch (err) {
    logger.debug(`Level-up announcement failed: ${err.message}`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, t] of lastXp) if (now - t > 3_600_000) lastXp.delete(key);
  for (const [key, list] of recentGrants) {
    const fresh = list.filter((t) => now - t < 3_600_000);
    if (fresh.length === 0) recentGrants.delete(key);
    else recentGrants.set(key, fresh);
  }
  if (lastText.size > 5000) lastText.clear();
}, 10 * 60_000).unref?.();

module.exports = {
  xpForNext,
  totalXpForLevel,
  progress,
  getRow,
  getRank,
  setXp,
  top,
  syncLevelRoles,
  handleMessage,
};
