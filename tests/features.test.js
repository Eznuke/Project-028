'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-featuretest-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');
const settings = require('../src/services/settings');
const gw = require('../src/services/giveaways');
const apps = require('../src/services/applications');
const tv = require('../src/services/tempvoice');

test.before(() => db.open());
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const G = '700000000000000001';

// ---- fakes -----------------------------------------------------------------------------------------
function fakeWorld({ present = [], roles = {} } = {}) {
  const sent = [];
  const edits = [];
  const message = { id: 'msg1', edit: async (p) => { edits.push(p); } };
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => message },
    send: async (p) => { sent.push(p); return { id: 'ann' }; },
  };
  const guild = {
    id: G, members: {
      me: {},
      fetch: async (id) => (present.includes(id) ? { id, user: { bot: false }, roles: { cache: { has: (r) => (roles[id] ?? []).includes(r) } } } : Promise.reject(new Error('gone'))),
    },
  };
  const client = { guilds: { cache: new Map([[G, guild]]) }, channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } };
  return { client, sent, edits };
}

function newGiveaway(extra = {}) {
  const id = db.run(
    'INSERT INTO giveaways (guild_id, channel_id, message_id, host_id, prize, winner_count, ends_at, required_role_id, min_level, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    G, 'c1', 'msg1', 'host', extra.prize ?? 'Nitro', extra.winners ?? 2, extra.endsAt ?? Date.now() - 1000, extra.role ?? null, extra.minLevel ?? 0, Date.now(),
  ).lastInsertRowid;
  for (const u of extra.entries ?? []) db.run('INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?,?,?)', id, u, Date.now());
  return Number(id);
}

// ---- giveaways -------------------------------------------------------------------------------------
test('pickRandom: unique, bounded, never invents entries', () => {
  const pool = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 50; i += 1) {
    const picked = gw.pickRandom(pool, 3);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3);
    assert.ok(picked.every((p) => pool.includes(p)));
  }
  assert.equal(gw.pickRandom(pool, 10).length, 4);
  assert.deepEqual(gw.pickRandom([], 2), []);
  assert.deepEqual(pool, ['a', 'b', 'c', 'd'], 'input must not be modified');
});

test('entry requirements: ended, role, level', () => {
  const id = newGiveaway({ endsAt: Date.now() + 60_000, role: 'r1', minLevel: 3 });
  const row = gw.get(id);
  const member = (roles) => ({ id: 'u1', roles: { cache: { has: (r) => roles.includes(r) } } });
  assert.match(gw.entryProblem(row, member([])), /role/);
  assert.match(gw.entryProblem(row, member(['r1'])), /level/);
  db.run('INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?)', G, 'u1', 100_000, 20);
  assert.equal(gw.entryProblem(row, member(['r1'])), null);
  assert.match(gw.entryProblem({ ...row, status: 'ended' }, member(['r1'])), /ended/);
  assert.match(gw.entryProblem({ ...row, ends_at: Date.now() - 1 }, member(['r1'])), /ended/);
});

test('ending a giveaway picks only valid entrants, once', async () => {
  const id = newGiveaway({ winners: 2, entries: ['u1', 'u2', 'u3', 'gone'] });
  const { client, sent, edits } = fakeWorld({ present: ['u1', 'u2', 'u3'] });
  const winners = await gw.end(client, id);
  assert.equal(winners.length, 2);
  assert.ok(winners.every((w) => ['u1', 'u2', 'u3'].includes(w)));
  assert.equal(gw.get(id).status, 'ended');
  assert.deepEqual(JSON.parse(gw.get(id).winner_ids), winners);
  assert.equal(edits.length, 1);
  assert.match(sent[0].content, /Congratulations/);
  assert.deepEqual(sent[0].allowedMentions.users, winners);
  assert.equal(await gw.end(client, id), null, 'a second end must do nothing');
  assert.equal(sent.length, 1);
});

test('required role is checked again when the giveaway ends', async () => {
  const id = newGiveaway({ winners: 3, role: 'vip', entries: ['u1', 'u2'] });
  const { client } = fakeWorld({ present: ['u1', 'u2'], roles: { u1: ['vip'] } });
  assert.deepEqual(await gw.end(client, id), ['u1']);
});

test('no entries and cancelled giveaways', async () => {
  const empty = newGiveaway({ entries: [] });
  const world = fakeWorld();
  assert.deepEqual(await gw.end(world.client, empty), []);
  assert.match(world.sent[0].content, /Nobody could win/);
  const cancelled = newGiveaway({ entries: ['u1'] });
  const w2 = fakeWorld({ present: ['u1'] });
  assert.deepEqual(await gw.end(w2.client, cancelled, { cancel: true }), []);
  assert.equal(gw.get(cancelled).status, 'cancelled');
  assert.equal(w2.sent.length, 0, 'cancelling announces nothing');
});

test('reroll never repeats a winner', async () => {
  const id = newGiveaway({ winners: 1, entries: ['u1', 'u2', 'u3'] });
  const { client } = fakeWorld({ present: ['u1', 'u2', 'u3'] });
  const first = await gw.end(client, id);
  const second = await gw.reroll(client, id, 1);
  const third = await gw.reroll(client, id, 1);
  assert.equal(second.length, 1);
  assert.equal(third.length, 1);
  assert.equal(new Set([...first, ...second, ...third]).size, 3);
  assert.deepEqual(await gw.reroll(client, id, 1), [], 'everybody has won already');
});

// ---- applications ------------------------------------------------------------------------------------
test('applications: who may apply', () => {
  const guild = { id: G, channels: { cache: new Map([['review', {}]]) } };
  assert.match(apps.applyProblem(guild, 'u9'), /closed/);
  settings.set(G, 'applications.enabled', true);
  assert.match(apps.applyProblem(guild, 'u9'), /not fully set up/);
  settings.set(G, 'applications.reviewChannelId', 'review');
  assert.equal(apps.applyProblem(guild, 'u9'), null);

  const id = db.run('INSERT INTO applications (guild_id, user_id, answers, created_at) VALUES (?,?,?,?)', G, 'u9', '[]', Date.now()).lastInsertRowid;
  assert.match(apps.applyProblem(guild, 'u9'), /waiting for review/);
  db.run("UPDATE applications SET status = 'rejected', decided_at = ? WHERE id = ?", Date.now(), id);
  assert.match(apps.applyProblem(guild, 'u9'), /apply again/);
  settings.set(G, 'applications.cooldownHours', 0);
  assert.equal(apps.applyProblem(guild, 'u9'), null);
  db.run("UPDATE applications SET status = 'accepted' WHERE id = ?", id);
  assert.match(apps.applyProblem(guild, 'u9'), /already accepted/);
});

test('applications: review message follows the status', () => {
  const id = db.run('INSERT INTO applications (guild_id, user_id, answers, created_at) VALUES (?,?,?,?)', G, 'u5', JSON.stringify([{ q: 'Why?', a: 'Because' }]), Date.now()).lastInsertRowid;
  const view = apps.renderReview(apps.get(id), { username: 'x' }, settings.view(G).applications);
  assert.equal(view.embeds.length, 1);
  assert.equal(view.components.length, 1);
});

// ---- temporary voice -----------------------------------------------------------------------------------------
test('room names are one safe line of 1-100 characters', () => {
  assert.equal(tv.cleanName('  hello\n\nworld  '), 'hello world');
  assert.ok(!tv.cleanName('@everyone party').includes('@'));
  assert.equal(tv.cleanName('   ', 'fallback'), 'fallback');
  assert.equal(tv.cleanName('x'.repeat(300)).length, 100);
});

test('empty rooms are removed, occupied or unknown channels are not', async () => {
  const deleted = [];
  const mk = (id, humans) => ({
    id, type: 2, members: { filter: (fn) => { const list = humans.filter((m) => fn(m)); return { size: list.length }; } },
    delete: async () => { deleted.push(id); },
  });
  db.run('INSERT INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?,?,?,?)', 'v1', G, 'u1', Date.now());
  db.run('INSERT INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?,?,?,?)', 'v2', G, 'u1', Date.now());
  await tv.cleanupIfEmpty(mk('v1', [{ user: { bot: false } }]));
  assert.deepEqual(deleted, []);
  await tv.cleanupIfEmpty(mk('v2', [{ user: { bot: true } }])); // only a bot left
  assert.deepEqual(deleted, ['v2']);
  assert.ok(!tv.getRoom('v2'));
  await tv.cleanupIfEmpty(mk('not-a-room', [])); // channels we did not create are never touched
  assert.deepEqual(deleted, ['v2']);
});
