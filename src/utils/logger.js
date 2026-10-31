'use strict';
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** Removes every known secret (bot token, API keys) from a string. */
function redact(text) {
  let out = String(text);
  for (const s of config.secrets()) out = out.split(s).join('[REDACTED]');
  return out;
}

function fmt(arg) {
  if (arg instanceof Error) {
    const stack = arg.stack ? `\n${arg.stack.split('\n').slice(1, 6).join('\n')}` : '';
    return `${arg.name}: ${arg.message}${stack}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}

function write(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = redact(`${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(fmt).join(' ')}`);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

module.exports = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  redact,
};
