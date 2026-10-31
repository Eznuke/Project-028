'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('./logger');

/** Recursively lists .js files. Files and folders starting with "_" are skipped (helpers). */
function walk(dir) {
  const root = path.resolve(dir); // absolute paths, so require() never treats them as package names
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/** A module may export one object, an array, or { commands: [...] } / { handlers: [...] }. */
function toList(mod, key) {
  if (Array.isArray(mod)) return mod;
  if (mod && Array.isArray(mod[key])) return mod[key];
  return [mod];
}

/**
 * Loads slash commands. Every command needs `data` (SlashCommandBuilder) and `execute`.
 * The folder name becomes the default `category`.
 * @returns {Map<string, object>}
 */
function loadCommands(dir) {
  const commands = new Map();
  for (const file of walk(dir)) {
    const category = path.basename(path.dirname(file));
    const mod = require(file);
    for (const cmd of toList(mod, 'commands')) {
      if (!cmd || !cmd.data || typeof cmd.data.toJSON !== 'function' || typeof cmd.execute !== 'function') {
        throw new Error(`Invalid command export in ${path.relative(process.cwd(), file)} (needs "data" and "execute").`);
      }
      const name = cmd.data.name;
      if (commands.has(name)) throw new Error(`Duplicate command name "${name}" in ${path.relative(process.cwd(), file)}.`);
      cmd.category = cmd.category || category;
      cmd.cooldown = typeof cmd.cooldown === 'number' ? cmd.cooldown : 3;
      cmd.guildOnly = cmd.guildOnly !== false;
      cmd.file = file;
      commands.set(name, cmd);
    }
  }
  return commands;
}

/**
 * Loads component handlers (buttons, select menus, modals) from a folder AND from
 * the `components` property of command modules.
 * A handler is { prefix: 'ticket', execute(interaction, args) }.
 * customId format: "prefix:arg1:arg2". IDs starting with "~" belong to collectors.
 * @returns {Map<string, Function>}
 */
function loadComponents(dir, commands = new Map()) {
  const handlers = new Map();
  const add = (prefix, fn, where) => {
    if (handlers.has(prefix)) throw new Error(`Duplicate component prefix "${prefix}" (${where}).`);
    if (prefix.includes(':') || prefix.startsWith('~')) throw new Error(`Invalid component prefix "${prefix}".`);
    handlers.set(prefix, fn);
  };

  for (const file of walk(dir)) {
    for (const h of toList(require(file), 'handlers')) {
      if (!h || typeof h.prefix !== 'string' || typeof h.execute !== 'function') {
        throw new Error(`Invalid component export in ${path.relative(process.cwd(), file)}.`);
      }
      add(h.prefix, h.execute, path.basename(file));
    }
  }
  for (const cmd of commands.values()) {
    if (!cmd.components) continue;
    for (const [prefix, fn] of Object.entries(cmd.components)) add(prefix, fn, `command ${cmd.data.name}`);
  }
  return handlers;
}

/**
 * Registers event listeners. Each file exports { name, once?, execute(...args, client) }
 * (or an array of those). A listener is registered at most once.
 */
function loadEvents(client, dir) {
  const seen = new Set();
  let count = 0;
  for (const file of walk(dir)) {
    for (const ev of toList(require(file), 'events')) {
      if (!ev || !ev.name || typeof ev.execute !== 'function') {
        throw new Error(`Invalid event export in ${path.relative(process.cwd(), file)}.`);
      }
      const key = `${file}:${String(ev.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const run = async (...args) => {
        try {
          await ev.execute(...args, client);
        } catch (err) {
          logger.error(`Error in event "${String(ev.name)}" (${path.basename(file)}):`, err);
        }
      };
      if (ev.once) client.once(ev.name, run);
      else client.on(ev.name, run);
      count++;
    }
  }
  return count;
}

/** Loads scheduled jobs: { name, intervalMs, run(client) }. */
function loadJobs(dir) {
  const jobs = [];
  for (const file of walk(dir)) {
    for (const job of toList(require(file), 'jobs')) {
      if (!job || !job.name || typeof job.run !== 'function' || !(job.intervalMs >= 1000)) {
        throw new Error(`Invalid job export in ${path.relative(process.cwd(), file)}.`);
      }
      jobs.push(job);
    }
  }
  return jobs;
}

module.exports = { walk, loadCommands, loadComponents, loadEvents, loadJobs };
