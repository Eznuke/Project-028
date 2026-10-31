'use strict';

/** Per-command cooldowns and a global per-user rate limit, kept in memory. */
const cooldowns = new Map(); // `${command}:${userId}` -> expiry timestamp
const hits = new Map(); // userId -> [timestamps]

/**
 * @returns {number} milliseconds the user still has to wait (0 = allowed). Starts the cooldown when allowed.
 */
function checkCooldown(commandName, userId, seconds) {
  if (!seconds || seconds <= 0) return 0;
  const key = `${commandName}:${userId}`;
  const now = Date.now();
  const expires = cooldowns.get(key) ?? 0;
  if (expires > now) return expires - now;
  cooldowns.set(key, now + seconds * 1000);
  return 0;
}

/** Clears a cooldown (e.g. when a command failed validation before doing real work). */
function resetCooldown(commandName, userId) {
  cooldowns.delete(`${commandName}:${userId}`);
}

/**
 * Global limiter: at most `limit` interactions per 10 seconds for one user.
 * @returns {number} ms to wait, or 0 when allowed.
 */
function checkGlobal(userId, limit, windowMs = 10_000) {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(userId, list);
    return windowMs - (now - list[0]);
  }
  list.push(now);
  hits.set(userId, list);
  return 0;
}

// Periodic cleanup so the maps never grow forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of cooldowns) if (expiry <= now) cooldowns.delete(key);
  for (const [user, list] of hits) {
    const fresh = list.filter((t) => now - t < 10_000);
    if (fresh.length === 0) hits.delete(user);
    else hits.set(user, fresh);
  }
}, 60_000);
sweeper.unref?.();

module.exports = { checkCooldown, resetCooldown, checkGlobal };
