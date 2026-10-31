'use strict';

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Parses "90s", "10m", "2h30m", "1d", "1w2d" into milliseconds.
 * Returns null when the text is not a valid duration.
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;
  const re = /(\d+)([smhdw])/g;
  let total = 0;
  let consumed = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    total += Number(match[1]) * UNITS[match[2]];
    consumed += match[0].length;
  }
  if (consumed !== text.length || total <= 0) return null;
  return total;
}

/** 93784000 -> "1d 2h 3m 4s" (max `parts` units). */
function formatDuration(ms, parts = 3) {
  let remaining = Math.max(0, Math.floor(ms / 1000));
  if (remaining === 0) return '0s';
  const out = [];
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (remaining >= size) {
      out.push(`${Math.floor(remaining / size)}${label}`);
      remaining %= size;
    }
  }
  return out.slice(0, parts).join(' ');
}

/** Discord timestamp markdown. style: t T d D f F R */
function ts(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Formats a date in a given IANA time zone, e.g. "Thu, 29 Oct 2026, 12:52". */
function formatInZone(date, timeZone = 'UTC') {
  const zone = isValidTimezone(timeZone) ? timeZone : 'UTC';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

module.exports = { parseDuration, formatDuration, ts, isValidTimezone, formatInZone };
