'use strict';

const { UserError } = require('./errors');

/**
 * Parses money amounts: "500", "1,500", "2k", "1.5m", "all".
 * @returns {'all'|number}
 */
function parseAmount(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/[,_\s]/g, '');
  if (text === 'all' || text === 'max') return 'all';
  const m = text.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) throw new UserError('Enter a positive amount such as `500`, `2k`, `1.5m` or `all`.');
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] ?? 1;
  const value = Math.round(Number(m[1]) * mult);
  if (!Number.isSafeInteger(value) || value <= 0) throw new UserError('The amount must be a positive whole number.');
  return value;
}

module.exports = { parseAmount };
