'use strict';

const settings = require('./settings');
const logging = require('./logging');
const mod = require('./moderation');
const embeds = require('../utils/embeds');
const logger = require('../utils/logger');

const joins = new Map(); // guildId -> [{ member, at }]
const raidUntil = new Map(); // guildId -> timestamp while a raid is considered active
const RAID_WINDOW_MS = 5 * 60_000;

async function alert(guild, cfg, text) {
  const e = embeds.base('🚨 Anti-raid', text, embeds.COLORS.danger);
  if (cfg.alertChannelId) {
    try {
      const channel = await guild.channels.fetch(cfg.alertChannelId);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [e], allowedMentions: { parse: [] } });
        return;
      }
    } catch {
      /* fall through to the moderation log */
    }
  }
  await logging.send(guild, 'moderation', e);
}

async function actOn(member, cfg, reason) {
  const { guild } = member;
  const botId = guild.client.user.id;
  try {
    if (cfg.action === 'ban' && member.bannable) {
      await member.ban({ reason });
      mod.createCase({ guild, userId: member.id, moderatorId: botId, action: 'ban', reason });
      return true;
    }
    if (cfg.action === 'kick' && member.kickable) {
      await member.kick(reason);
      mod.createCase({ guild, userId: member.id, moderatorId: botId, action: 'kick', reason });
      return true;
    }
  } catch (err) {
    logger.warn(`Anti-raid action failed for ${member.id}: ${err.message}`);
  }
  return false;
}

/**
 * Called for every new member.
 * @returns {Promise<boolean>} true when the member was removed (kicked/banned), so callers can skip the welcome.
 */
async function handleJoin(member) {
  if (member.user.bot) return false;
  const { guild } = member;
  const cfg = settings.view(guild.id).moderation.antiRaid;
  if (!cfg.enabled) return false;

  const now = Date.now();

  // 1) Account too new
  if (cfg.minAccountAgeDays > 0) {
    const ageDays = (now - member.user.createdTimestamp) / 86_400_000;
    if (ageDays < cfg.minAccountAgeDays) {
      if (cfg.action === 'lockdown-alert') {
        await alert(guild, cfg, `${member} joined with a very new account (${ageDays.toFixed(1)} days old). Review them manually.`);
        return false;
      }
      return actOn(member, cfg, `Anti-raid: account younger than ${cfg.minAccountAgeDays} days`);
    }
  }

  // 2) Join flood
  const list = (joins.get(guild.id) ?? []).filter((j) => now - j.at < cfg.perSeconds * 1000);
  list.push({ member, at: now });
  joins.set(guild.id, list);

  const active = (raidUntil.get(guild.id) ?? 0) > now;
  if (active) {
    raidUntil.set(guild.id, now + RAID_WINDOW_MS);
    if (cfg.action === 'lockdown-alert') return false;
    return actOn(member, cfg, 'Anti-raid: join flood in progress');
  }

  if (list.length >= cfg.joinThreshold) {
    raidUntil.set(guild.id, now + RAID_WINDOW_MS);
    joins.set(guild.id, []);
    let actioned = 0;
    let currentRemoved = false;
    if (cfg.action !== 'lockdown-alert') {
      for (const j of list) {
        if (await actOn(j.member, cfg, 'Anti-raid: join flood')) {
          actioned++;
          if (j.member.id === member.id) currentRemoved = true;
        }
      }
    }
    await alert(
      guild,
      cfg,
      `**${list.length}** members joined within ${cfg.perSeconds}s. ` +
        (cfg.action === 'lockdown-alert'
          ? 'No automatic action is configured, please review the new members.'
          : `Action \`${cfg.action}\` applied to ${actioned} of them. New joins will be handled the same way for the next 5 minutes.`),
    );
    return currentRemoved;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [guildId, until] of raidUntil) if (until < now) raidUntil.delete(guildId);
  for (const [guildId, list] of joins) {
    const fresh = list.filter((j) => now - j.at < 120_000);
    if (fresh.length === 0) joins.delete(guildId);
    else joins.set(guildId, fresh);
  }
}, 60_000).unref?.();

module.exports = { handleJoin };
