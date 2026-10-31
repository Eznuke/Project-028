'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { UserError } = require('../utils/errors');
const { stripMentions, truncate } = require('../utils/text');
const { request } = require('../utils/http');

/**
 * Optional AI chat through any OpenAI-compatible "chat completions" endpoint
 * (Groq, OpenAI, OpenRouter, a local server...). Configure it in .env.
 * Conversation memory is kept in RAM only (last few turns per user and channel).
 */
const HISTORY_TURNS = 6;
const histories = new Map(); // `${channelId}:${userId}` -> [{role, content}]
const lastCall = new Map(); // userId -> timestamp
const calls = new Map(); // userId -> [timestamps within the last hour]

const isEnabled = () => config.ai.enabled;

function checkLimits(userId) {
  const now = Date.now();
  const wait = (lastCall.get(userId) ?? 0) + config.ai.cooldownMs - now;
  if (wait > 0) throw new UserError(`Please wait ${Math.ceil(wait / 1000)}s before asking the AI again.`);
  const recent = (calls.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= config.ai.hourlyLimit) {
    const minutes = Math.ceil((recent[0] + 3_600_000 - now) / 60_000);
    throw new UserError(`You reached the hourly AI limit (${config.ai.hourlyLimit}). Try again in about ${minutes} minute(s).`);
  }
  recent.push(now);
  calls.set(userId, recent);
  lastCall.set(userId, now);
}

/**
 * @returns {Promise<string>} the answer text (mentions neutralised, max 1900 chars)
 */
async function ask({ userId, channelId, prompt, username = 'user' }) {
  if (!config.ai.enabled) {
    throw new UserError(config.ai.requested
      ? 'AI chat is enabled but no API key is configured. The bot owner must set `AI_API_KEY`.'
      : 'AI chat is turned off on this bot.');
  }
  const text = String(prompt ?? '').trim();
  if (!text) throw new UserError('Please write a message for the AI.');
  if (text.length > config.ai.maxInput) throw new UserError(`Your message is too long (max ${config.ai.maxInput} characters).`);

  checkLimits(userId);

  const key = `${channelId}:${userId}`;
  const history = histories.get(key) ?? [];
  const messages = [
    { role: 'system', content: config.ai.system },
    ...history,
    { role: 'user', content: `${username}: ${text}` },
  ];

  let data;
  try {
    const res = await request(config.ai.url, {
      method: 'POST',
      timeoutMs: 30_000,
      allowError: true,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.key}` },
      body: JSON.stringify({ model: config.ai.model, messages, max_tokens: 700, temperature: 0.7 }),
    });
    if (!res.ok) {
      logger.warn(`AI API returned HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) throw new UserError('The AI service rejected the bot\'s credentials. Please tell the bot owner.');
      if (res.status === 429) throw new UserError('The AI service is busy right now. Try again in a minute.');
      if (res.status === 404 || res.status === 400) throw new UserError('The AI service did not accept the request (check `AI_MODEL` and `AI_API_URL`).');
      throw new UserError('The AI service had a problem. Try again later.');
    }
    data = await res.json();
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new UserError('The AI service took too long to answer. Try again.');
    logger.warn('AI request failed:', err.message);
    throw new UserError('I could not reach the AI service. Try again later.');
  }

  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new UserError('The AI returned an empty answer. Try rephrasing.');

  history.push({ role: 'user', content: `${username}: ${text}` }, { role: 'assistant', content: answer });
  histories.set(key, history.slice(-HISTORY_TURNS * 2));
  if (histories.size > 2000) histories.delete(histories.keys().next().value);

  return truncate(stripMentions(answer.trim()), 1900);
}

function reset(userId, channelId) {
  return histories.delete(`${channelId}:${userId}`);
}

module.exports = { ask, reset, isEnabled };
