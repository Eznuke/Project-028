'use strict';

const { isValidTimezone } = require('./time');

/** Offset (ms) of `timeZone` from UTC at the instant `ms`. */
function zoneOffset(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to a UTC timestamp (ms). */
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone); // second pass handles DST edges
  return result;
}

/**
 * Parses "YYYY-MM-DD", "YYYY-MM-DD HH:mm" or "YYYY-MM-DDTHH:mm" in the given zone.
 * @returns {number|null} UTC milliseconds, or null when invalid
 */
function parseLocalDateTime(input, timeZone = 'UTC') {
  const zone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  const m = String(input ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1) return null; // e.g. 2026-02-31
  return zonedToUtc({ year, month, day, hour, minute }, zone);
}

module.exports = { zoneOffset, zonedToUtc, parseLocalDateTime };
