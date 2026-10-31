'use strict';
const path = require('node:path');

try { require('dotenv').config(); } catch { /* dotenv is optional when variables come from the host */ }

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const root = path.resolve(__dirname, '..', '..');

// Minimum permission bits the bot needs (see README). Added up as BigInt, shared as a string.
const INVITE_BITS = [
  1n << 1n, // Kick Members
  1n << 2n, // Ban Members
  1n << 4n, // Manage Channels
  1n << 6n, // Add Reactions
  1n << 10n, // View Channel
  1n << 11n, // Send Messages
  1n << 13n, // Manage Messages
  1n << 14n, // Embed Links
  1n << 15n, // Attach Files
  1n << 16n, // Read Message History
  1n << 20n, // Connect (music, optional)
  1n << 21n, // Speak (music, optional)
  1n << 24n, // Move Members (temporary voice rooms)
  1n << 27n, // Manage Nicknames
  1n << 28n, // Manage Roles
  1n << 40n, // Moderate Members (timeout)
];

const config = {
  root,
  token: env.DISCORD_TOKEN || '',
  clientId: env.CLIENT_ID || '',
  guildId: env.GUILD_ID || null,
  ownerIds: (env.OWNER_ID || '').split(',').map((s) => s.trim()).filter(Boolean),
  supportServerUrl: env.SUPPORT_SERVER_URL || null,
  color: parseInt((env.DEFAULT_COLOR || '5865F2').replace('#', ''), 16) || 0x5865f2,
  dbPath: path.resolve(root, env.DB_PATH || 'data/bot.db'),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
  defaultTimezone: env.DEFAULT_TIMEZONE || 'UTC',
  /** Chat prefix used in DMs and as the starting value for new servers. */
  defaultPrefix: ((env.DEFAULT_PREFIX || '!').trim().split(/\s+/)[0] || '!').slice(0, 5),
  /** Max interactions per user per 10 seconds, across all commands. */
  globalRateLimit: int(env.GLOBAL_RATE_MAX, 6),
  invitePermissions: INVITE_BITS.reduce((a, b) => a | b, 0n).toString(),

  ai: {
    requested: bool(env.AI_ENABLED, false),
    enabled: bool(env.AI_ENABLED, false) && !!env.AI_API_KEY,
    url: env.AI_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
    key: env.AI_API_KEY || '',
    model: env.AI_MODEL || 'llama-3.3-70b-versatile',
    system: env.AI_SYSTEM_PROMPT || 'You are a friendly, concise assistant inside a Discord server. Keep answers under 1500 characters.',
    cooldownMs: int(env.AI_COOLDOWN_SECONDS, 10) * 1000,
    hourlyLimit: int(env.AI_HOURLY_LIMIT, 30),
    maxInput: int(env.AI_MAX_INPUT_CHARS, 1000),
  },
  translate: {
    provider: (env.TRANSLATE_PROVIDER || 'mymemory').toLowerCase(),
    url: env.TRANSLATE_API_URL || '',
    key: env.TRANSLATE_API_KEY || '',
  },
  shortener: { template: env.SHORTENER_URL_TEMPLATE || '' },
  music: { enabled: bool(env.MUSIC_ENABLED, false) },

  isOwner(userId) {
    return this.ownerIds.includes(String(userId));
  },

  /** Every secret value; the logger redacts these from output. */
  secrets() {
    return [this.token, this.ai.key, this.translate.key].filter((s) => s && s.length > 6);
  },

  /**
   * @returns {string[]} human-readable problems (empty = fine).
   */
  validate({ needToken = true } = {}) {
    const problems = [];
    if (needToken && !this.token) problems.push('DISCORD_TOKEN is missing');
    if (!this.clientId) problems.push('CLIENT_ID is missing');
    if (!this.ownerIds.length) problems.push('OWNER_ID is not set (the /owner commands will be unavailable)');
    if (this.ai.requested && !this.ai.key) problems.push('AI_ENABLED is true but AI_API_KEY is empty (AI chat stays off)');
    return problems;
  },
};

module.exports = config;
