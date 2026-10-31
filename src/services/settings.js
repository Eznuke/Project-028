'use strict';

const db = require('../database');
const defaults = require('../config/defaults');

const cache = new Map();

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects merge, arrays and primitives from `override` replace. */
function merge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base?.[key])) out[key] = merge(base[key], value);
    else out[key] = value;
  }
  return out;
}

function load(guildId) {
  const row = db.get('SELECT data FROM guild_settings WHERE guild_id = ?', guildId);
  let stored = {};
  if (row) {
    try {
      stored = JSON.parse(row.data);
    } catch {
      stored = {};
    }
  }
  const merged = merge(structuredClone(defaults), stored);
  cache.set(guildId, merged);
  return merged;
}

function save(guildId, settings) {
  db.run(
    `INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    guildId,
    JSON.stringify(settings),
    Date.now(),
  );
  cache.set(guildId, settings);
}

/**
 * Read-only view for hot paths (message handlers). Do NOT mutate the result.
 * @returns {typeof defaults}
 */
function view(guildId) {
  return cache.get(guildId) ?? load(guildId);
}

/** A private copy that is safe to modify. */
function get(guildId) {
  return structuredClone(view(guildId));
}

/** Reads, mutates with `fn(settings)`, saves. Returns the new settings. */
function update(guildId, fn) {
  const next = get(guildId);
  fn(next);
  save(guildId, next);
  return next;
}

/** Sets a value by dotted path, e.g. set(id, 'welcome.channelId', '123'). */
function set(guildId, dottedPath, value) {
  return update(guildId, (s) => {
    const keys = dottedPath.split('.');
    let node = s;
    for (const key of keys.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  });
}

/** Restores one top-level section (e.g. "welcome") to defaults. */
function resetSection(guildId, section) {
  if (!Object.prototype.hasOwnProperty.call(defaults, section)) throw new Error(`Unknown section: ${section}`);
  return update(guildId, (s) => {
    s[section] = structuredClone(defaults[section]);
  });
}

function remove(guildId) {
  db.run('DELETE FROM guild_settings WHERE guild_id = ?', guildId);
  cache.delete(guildId);
}

module.exports = { view, get, update, set, resetSection, remove, merge };
