'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-dbtest-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');
const settings = require('../src/services/settings');
const eco = require('../src/services/economy');
const leveling = require('../src/services/leveling');
const { parseAmount } = require('../src/utils/amount');

test.before(() => db.open());
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const G = '1000';

test('migrations create the schema and are idempotent', () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  for (const t of ['guild_settings', 'cases', 'warnings', 'levels', 'economy', 'tickets', 'suggestions', 'polls', 'reminders', 'role_panels']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.migrate(); // running again must be a no-op
});

test('settings: defaults, dotted set, persistence, reset', () => {
  assert.equal(settings.view(G).economy.currencyName, 'coins');
  settings.set(G, 'welcome.channelId', '555');
  assert.equal(settings.view(G).welcome.channelId, '555');
  assert.equal(JSON.parse(db.get('SELECT data FROM guild_settings WHERE guild_id = ?', G).data).welcome.channelId, '555');
  settings.resetSection(G, 'welcome');
  assert.equal(settings.view(G).welcome.channelId, null);
});

test('economy: accounts, bank, transfers and limits', () => {
  settings.set(G, 'economy.startingBalance', 1000);
  const acc = eco.getAccount(G, 'a');
  assert.equal(acc.wallet, 1000);
  assert.equal(eco.deposit(G, 'a', 400), 400);
  assert.equal(eco.getAccount(G, 'a').bank, 400);
  assert.equal(eco.withdraw(G, 'a', 'all'), 400);
  eco.transfer(G, 'a', 'b', 300);
  assert.equal(eco.getAccount(G, 'a').wallet, 700);
  assert.equal(eco.getAccount(G, 'b').wallet, 1300);
  assert.throws(() => eco.transfer(G, 'a', 'b', 99999), /enough/);
  assert.throws(() => eco.transfer(G, 'a', 'a', 1), /yourself/);
  assert.throws(() => eco.deposit(G, 'a', 99999), /much/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions WHERE guild_id = ?', G).n > 0, true);
});

test('economy: daily cooldown and streak', () => {
  const first = eco.claimDaily(G, 'c');
  assert.ok(first.ok);
  assert.equal(first.streak, 1);
  const second = eco.claimDaily(G, 'c');
  assert.equal(second.ok, false);
  assert.ok(second.remainingMs > 0);
});

test('economy: bets never go negative', () => {
  eco.getAccount(G, 'd');
  const bet = eco.validateBet(G, 'd', 100);
  const after = eco.settleBet(G, 'd', bet, 0, 'test');
  assert.equal(after.wallet, 900);
  const win = eco.settleBet(G, 'd', 100, 200, 'test');
  assert.equal(win.wallet, 1000);
  assert.throws(() => eco.validateBet(G, 'd', 10_000_000), /maximum/i);
  assert.throws(() => eco.validateBet(G, 'd', -5), /positive/);
});

test('shop: buy, stock, inventory, sell', () => {
  const id = eco.addItem(G, { name: 'Cookie', price: 100, stock: 2 });
  const item = eco.getItem(G, id);
  eco.getAccount(G, 'e');
  assert.equal(eco.buy(G, 'e', item, 2), 200);
  assert.throws(() => eco.buy(G, 'e', eco.getItem(G, id), 1), /stock/i);
  assert.equal(eco.inventory(G, 'e')[0].quantity, 2);
  assert.equal(eco.sell(G, 'e', item, 1), 50); // 50% default refund
  assert.throws(() => eco.sell(G, 'e', item, 5), /only own/);
  assert.throws(() => eco.addItem(G, { name: 'cookie', price: 5 }), /already exists/);
});

test('leveling math is consistent', () => {
  for (const xp of [0, 99, 100, 5000, 123456]) {
    const p = leveling.progress(xp);
    assert.equal(leveling.totalXpForLevel(p.level) + p.current, xp);
    assert.ok(p.current < p.needed);
  }
});

test('amount parser', () => {
  assert.equal(parseAmount('1,500'), 1500);
  assert.equal(parseAmount('2k'), 2000);
  assert.equal(parseAmount('1.5m'), 1_500_000);
  assert.equal(parseAmount('ALL'), 'all');
  for (const bad of ['-5', '0', 'abc', '1e9', '']) assert.throws(() => parseAmount(bad));
});
