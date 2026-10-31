'use strict';

const { Events, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const settings = require('../services/settings');
const leveling = require('../services/leveling');
const ai = require('../services/ai');
const prefix = require('../services/prefix');
const logger = require('../utils/logger');
const { UserError } = require('../utils/errors');
const { ts } = require('../utils/time');
const { truncate } = require('../utils/text');

const canSpeak = (message) =>
  message.channel.permissionsFor(message.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);

async function handleAfk(message) {
  const gid = message.guild.id;
  // 1. The author is AFK and wrote something: welcome them back.
  const own = db.get('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?', gid, message.author.id);
  if (own) {
    db.run('DELETE FROM afk WHERE guild_id = ? AND user_id = ?', gid, message.author.id);
    if (canSpeak(message)) {
      const note = await message.reply({ content: `👋 Welcome back, **${message.author.username}**! I removed your AFK status (you were away since ${ts(own.since, 'R')}).`, allowedMentions: { repliedUser: false } }).catch(() => null);
      if (note) setTimeout(() => note.delete().catch(() => {}), 10_000).unref?.();
    }
  }
  // 2. Someone mentioned AFK members.
  const mentioned = [...message.mentions.users.values()].filter((u) => !u.bot && u.id !== message.author.id).slice(0, 5);
  if (!mentioned.length) return;
  const lines = [];
  for (const u of mentioned) {
    const row = db.get('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?', gid, u.id);
    if (row) lines.push(`💤 **${u.username}** is AFK: ${truncate(row.reason || 'No reason', 150)} (${ts(row.since, 'R')})`);
  }
  if (lines.length && canSpeak(message)) {
    await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  }
}

async function handleAi(message, client) {
  if (!ai.isEnabled()) return;
  const cfg = settings.view(message.guild.id).ai;
  if (!cfg.enabled) return;
  const inChannel = cfg.channelIds.includes(message.channelId);
  const mentioned = message.mentions.users.has(client.user.id) && !message.mentions.everyone;
  if (!inChannel && !mentioned) return;
  if (!canSpeak(message)) return;

  const prompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!prompt) return;
  try {
    await message.channel.sendTyping().catch(() => {});
    const answer = await ai.ask({ userId: message.author.id, channelId: message.channelId, prompt, username: message.member?.displayName ?? message.author.username });
    await message.reply({ content: answer, allowedMentions: { parse: [], repliedUser: false } });
  } catch (err) {
    if (err instanceof UserError) {
      await message.reply({ content: `⚠️ ${err.message}`, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    } else {
      logger.warn('AI chat message failed:', err.message);
    }
  }
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot || message.webhookId || message.system) return;
    if (message.partial) return;
    await handleAfk(message).catch((err) => logger.debug('AFK handler failed:', err.message));
    // Chat commands ("!daily", "@Bot help") are handled by prefixCommands.js: no XP for them and no AI answer.
    if (prefix.parseInvocation(message, client)) return;
    await leveling.handleMessage(message).catch((err) => logger.warn('Leveling failed:', err.message));
    await handleAi(message, client);
  },
};
