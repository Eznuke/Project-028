'use strict';

/**
 * Pre-flight check:  npm run check
 * Loads every command, component handler, event and job with the REAL discord.js library and verifies:
 *  - command schemas build (names, descriptions, option order) and fit Discord's limits (max 100 commands)
 *  - no duplicate command names or component prefixes
 *  - database migrations run on a throw-away database
 * It never connects to Discord and needs no token.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botcheck-')), 'check.db');
process.env.DB_PATH = tmpDb;
process.env.LOG_LEVEL = 'error';

const problems = [];
const fail = (msg) => problems.push(msg);

const root = path.join(__dirname, '..', 'src');
const { loadCommands, loadComponents, loadJobs, walk } = require(path.join(root, 'utils', 'loader'));

let commands = new Map();
let components = new Map();
try {
  commands = loadCommands(path.join(root, 'commands'));
  components = loadComponents(path.join(root, 'components'), commands);
} catch (err) {
  fail(`Loading commands/components failed: ${err.message}`);
}

const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;
let totalJson = 0;
for (const [name, cmd] of commands) {
  try {
    const json = cmd.data.toJSON();
    totalJson += 1;
    if (!NAME_RE.test(json.name) || json.name !== json.name.toLowerCase()) fail(`/${name}: invalid name`);
    if (!json.description || json.description.length > 100) fail(`/${name}: description missing or over 100 characters`);
    const walkOptions = (opts, where) => {
      for (const o of opts ?? []) {
        if (!NAME_RE.test(o.name) || o.name !== o.name.toLowerCase()) fail(`${where}: invalid option name "${o.name}"`);
        if (!o.description || o.description.length > 100) fail(`${where}.${o.name}: description missing or over 100 characters`);
        if (o.options) walkOptions(o.options, `${where}.${o.name}`);
      }
    };
    walkOptions(json.options, `/${name}`);
    if (typeof cmd.execute !== 'function') fail(`/${name}: no execute()`);
    if (cmd.autocomplete && typeof cmd.autocomplete !== 'function') fail(`/${name}: autocomplete must be a function`);
  } catch (err) {
    fail(`/${name}: schema error: ${err.message}`);
  }
}
if (totalJson > 100) fail(`Discord allows at most 100 global slash commands, found ${totalJson}.`);

// Component prefixes used in source must have a handler.
const used = new Set();
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/setCustomId\(\s*[`'"]([a-z]+):/g)) used.add(m[1]);
}
for (const prefix of used) if (!components.has(prefix)) fail(`customId prefix "${prefix}" is used but has no handler`);

// Chat-prefix aliases and argument parsing
try {
  const aliases = require(path.join(root, 'config', 'aliases'));
  const { usageLines } = require(path.join(root, 'utils', 'argparse'));
  const seenAlias = new Map();
  for (const [target, list] of Object.entries(aliases)) {
    if (!commands.has(target)) fail(`aliases.js: "${target}" is not a command`);
    for (const a of list) {
      if (!/^[a-z0-9]{1,20}$/.test(a)) fail(`aliases.js: alias "${a}" must be lowercase letters/digits`);
      if (commands.has(a)) fail(`aliases.js: alias "${a}" is also a real command name`);
      if (seenAlias.has(a)) fail(`aliases.js: alias "${a}" is used for both "${seenAlias.get(a)}" and "${target}"`);
      seenAlias.set(a, target);
    }
  }
  for (const [name, cmd] of commands) {
    try {
      const lines = usageLines(cmd.data.toJSON(), '!');
      if (!lines.length) fail(`/${name}: no usage could be built for chat use`);
    } catch (err) {
      fail(`/${name}: chat usage error: ${err.message}`);
    }
  }
} catch (err) {
  fail(`Chat prefix check: ${err.message}`);
}

// Help pages must fit Discord's embed limits
try {
  const help = require(path.join(root, 'commands', 'general', 'help.js')).internals;
  const fakeClient = { user: { username: 'Bot', id: '1' }, commands };
  const size = (e) => {
    const d = e.toJSON();
    return (d.title?.length ?? 0) + (d.description?.length ?? 0) + (d.footer?.text.length ?? 0)
      + (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  };
  const verify = (label, embed) => {
    const d = embed.toJSON();
    if (size(embed) > 5800) fail(`help page "${label}" is too long (${size(embed)} characters)`);
    if ((d.description?.length ?? 0) > 4096) fail(`help page "${label}": description over 4096`);
    if ((d.fields?.length ?? 0) > 25) fail(`help page "${label}": more than 25 fields`);
    for (const f of d.fields ?? []) if (!f.name || f.name.length > 256 || !f.value || f.value.length > 1024) fail(`help page "${label}": invalid field "${f.name}"`);
  };
  const groups = help.groupByCategory([...commands.values()]);
  verify('home', help.homePage(fakeClient, groups, null));
  verify('guide', help.guidePage(null));
  for (const [key, list] of groups) verify(`category ${key}`, help.categoryPage(key, list, null, fakeClient));
  for (const [name, cmd] of commands) verify(`command ${name}`, help.commandPage(cmd, null, fakeClient));
  if (groups.size > 23) fail('help menu supports at most 23 categories');
} catch (err) {
  fail(`Help pages: ${err.stack?.split('\n')[1]?.trim() ?? ''} ${err.message}`);
}

// Events and jobs
try {
  for (const file of walk(path.join(root, 'events'))) {
    const mod = require(file);
    for (const ev of Array.isArray(mod) ? mod : [mod]) {
      if (!ev.name || typeof ev.execute !== 'function') fail(`Invalid event in ${path.basename(file)}`);
    }
  }
  loadJobs(path.join(root, 'jobs'));
} catch (err) {
  fail(`Events/jobs: ${err.message}`);
}

// Database
try {
  const db = require(path.join(root, 'database'));
  db.open();
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").length;
  if (tables < 10) fail('Database looks incomplete');
  db.close();
} catch (err) {
  fail(`Database: ${err.message}`);
}

try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`Commands: ${commands.size} (limit 100) • component handlers: ${components.size}`);
if (problems.length) {
  console.error(`\n❌ ${problems.length} problem(s):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('✅ All checks passed.');
