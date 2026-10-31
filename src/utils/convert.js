'use strict';

/** Offline unit converter. Each category stores factors relative to a base unit. */
const CATEGORIES = {
  length: { base: 'm', units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 } },
  mass: { base: 'kg', units: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 } },
  volume: {
    base: 'l',
    units: { ml: 0.001, l: 1, m3: 1000, tsp: 0.00492892159375, tbsp: 0.01478676478125, floz: 0.0295735295625, cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784 },
  },
  speed: { base: 'm/s', units: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 1852 / 3600, 'ft/s': 0.3048 } },
  area: { base: 'm2', units: { cm2: 1e-4, m2: 1, km2: 1e6, ha: 1e4, in2: 6.4516e-4, ft2: 0.09290304, acre: 4046.8564224, mi2: 2589988.110336 } },
  time: { base: 's', units: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800 } },
  data: {
    base: 'byte',
    units: { bit: 0.125, byte: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 },
  },
  temperature: { base: 'c', units: { c: 1, f: 1, k: 1 } }, // handled separately
};

const ALIASES = {
  meter: 'm', meters: 'm', metre: 'm', metres: 'm', kilometer: 'km', kilometers: 'km', inch: 'in', inches: 'in',
  foot: 'ft', feet: 'ft', yard: 'yd', yards: 'yd', mile: 'mi', miles: 'mi', gram: 'g', grams: 'g', kilogram: 'kg',
  kilograms: 'kg', pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', liter: 'l', liters: 'l', litre: 'l',
  litres: 'l', gallon: 'gal', gallons: 'gal', second: 's', seconds: 's', sec: 's', minute: 'min', minutes: 'min',
  hour: 'h', hours: 'h', hr: 'h', day: 'd', days: 'd', week: 'wk', weeks: 'wk', celsius: 'c', fahrenheit: 'f', kelvin: 'k',
  '°c': 'c', '°f': 'f', kmh: 'km/h', kph: 'km/h', knot: 'kn', knots: 'kn', byte_: 'byte', bytes: 'byte', b: 'byte',
};

function resolveUnit(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  const unit = ALIASES[key] ?? key;
  for (const [category, def] of Object.entries(CATEGORIES)) {
    if (Object.prototype.hasOwnProperty.call(def.units, unit)) return { category, unit };
  }
  return null;
}

function toCelsius(v, unit) {
  if (unit === 'c') return v;
  if (unit === 'f') return ((v - 32) * 5) / 9;
  return v - 273.15;
}

function fromCelsius(v, unit) {
  if (unit === 'c') return v;
  if (unit === 'f') return (v * 9) / 5 + 32;
  return v + 273.15;
}

/**
 * @returns {{ result: number, category: string, from: string, to: string }}
 * @throws {Error} with a readable message
 */
function convert(value, fromRaw, toRaw) {
  if (!Number.isFinite(value)) throw new Error('The value must be a number.');
  const from = resolveUnit(fromRaw);
  const to = resolveUnit(toRaw);
  if (!from) throw new Error(`I do not know the unit "${fromRaw}". Use autocomplete to see supported units.`);
  if (!to) throw new Error(`I do not know the unit "${toRaw}". Use autocomplete to see supported units.`);
  if (from.category !== to.category) {
    throw new Error(`You cannot convert ${from.category} (${from.unit}) to ${to.category} (${to.unit}).`);
  }
  let result;
  if (from.category === 'temperature') {
    result = fromCelsius(toCelsius(value, from.unit), to.unit);
  } else {
    const def = CATEGORIES[from.category].units;
    result = (value * def[from.unit]) / def[to.unit];
  }
  return { result, category: from.category, from: from.unit, to: to.unit };
}

/** All canonical unit names (for autocomplete). */
function allUnits() {
  const out = [];
  for (const [category, def] of Object.entries(CATEGORIES)) {
    for (const unit of Object.keys(def.units)) out.push({ unit, category });
  }
  return out;
}

module.exports = { convert, resolveUnit, allUnits, CATEGORIES };
