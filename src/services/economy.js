'use strict';

const db = require('../database');
const settings = require('./settings');
const { UserError } = require('../utils/errors');
const { formatNumber } = require('../utils/text');

const cfg = (guildId) => settings.view(guildId).economy;

/** "🪙 1,234" using the server's currency symbol. */
function money(guildId, amount) {
  return `${cfg(guildId).currencySymbol} ${formatNumber(amount)}`;
}

function assertEnabled(guildId) {
  if (!cfg(guildId).enabled) throw new UserError('The economy is turned off in this server. An admin can enable it with `/config economy`.');
}

/** Gets (and creates on first use) an account. New accounts receive the starting balance. */
function getAccount(guildId, userId) {
  let row = db.get('SELECT * FROM economy WHERE guild_id = ? AND user_id = ?', guildId, userId);
  if (!row) {
    const start = Math.max(0, Math.floor(cfg(guildId).startingBalance));
    db.run('INSERT OR IGNORE INTO economy (guild_id, user_id, wallet) VALUES (?, ?, ?)', guildId, userId, start);
    row = db.get('SELECT * FROM economy WHERE guild_id = ? AND user_id = ?', guildId, userId);
  }
  return row;
}

function logTx(guildId, userId, type, amount, note = null) {
  db.run(
    'INSERT INTO transactions (guild_id, user_id, type, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guildId, userId, type, amount, note, Date.now(),
  );
}

/**
 * Changes wallet/bank by deltas and records a transaction (amount = wallet delta + bank delta).
 * Throws UserError when a balance would become negative.
 * NOTE: do not call inside db.transaction() together with other transaction() users.
 */
function adjust(guildId, userId, { wallet = 0, bank = 0 }, type, note = null) {
  const acc = getAccount(guildId, userId);
  const newWallet = acc.wallet + wallet;
  const newBank = acc.bank + bank;
  if (newWallet < 0) throw new UserError('You do not have enough coins in your wallet.');
  if (newBank < 0) throw new UserError('You do not have enough coins in your bank.');
  db.run('UPDATE economy SET wallet = ?, bank = ? WHERE guild_id = ? AND user_id = ?', newWallet, newBank, guildId, userId);
  logTx(guildId, userId, type, wallet + bank, note);
  return { wallet: newWallet, bank: newBank };
}

/** Checks a cooldown column and, when ready, stamps it. Returns { ok, remainingMs }. */
function claim(guildId, userId, column, cooldownMs) {
  if (!['last_daily', 'last_weekly', 'last_work', 'last_beg', 'last_rob'].includes(column)) throw new Error('bad column');
  const acc = getAccount(guildId, userId);
  const now = Date.now();
  const remaining = acc[column] + cooldownMs - now;
  if (remaining > 0) return { ok: false, remainingMs: remaining };
  db.run(`UPDATE economy SET ${column} = ? WHERE guild_id = ? AND user_id = ?`, now, guildId, userId);
  return { ok: true, remainingMs: 0 };
}

/** Daily reward with streak bonus (streak survives up to 48 hours between claims). */
function claimDaily(guildId, userId) {
  const c = cfg(guildId);
  const acc = getAccount(guildId, userId);
  const now = Date.now();
  const cooldown = 20 * 3_600_000;
  const remaining = acc.last_daily + cooldown - now;
  if (remaining > 0) return { ok: false, remainingMs: remaining };
  const streak = acc.last_daily && now - acc.last_daily <= 48 * 3_600_000 ? acc.daily_streak + 1 : 1;
  const bonus = Math.min(streak - 1, 10) * Math.round(c.dailyAmount * 0.1);
  const amount = c.dailyAmount + bonus;
  db.run('UPDATE economy SET last_daily = ?, daily_streak = ? WHERE guild_id = ? AND user_id = ?', now, streak, guildId, userId);
  adjust(guildId, userId, { wallet: amount }, 'daily', `streak ${streak}`);
  return { ok: true, amount, bonus, streak };
}

function deposit(guildId, userId, amount) {
  const c = cfg(guildId);
  const acc = getAccount(guildId, userId);
  let value = amount === 'all' ? acc.wallet : amount;
  if (c.bankLimit > 0) value = Math.min(value, Math.max(0, c.bankLimit - acc.bank));
  if (!Number.isInteger(value) || value <= 0) throw new UserError('Nothing to deposit (check your amount and the bank limit).');
  if (value > acc.wallet) throw new UserError('You do not have that much in your wallet.');
  adjust(guildId, userId, { wallet: -value, bank: value }, 'deposit');
  return value;
}

function withdraw(guildId, userId, amount) {
  const acc = getAccount(guildId, userId);
  const value = amount === 'all' ? acc.bank : amount;
  if (!Number.isInteger(value) || value <= 0) throw new UserError('Nothing to withdraw.');
  if (value > acc.bank) throw new UserError('You do not have that much in your bank.');
  adjust(guildId, userId, { wallet: value, bank: -value }, 'withdraw');
  return value;
}

/** Moves coins wallet -> wallet atomically. */
function transfer(guildId, fromId, toId, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new UserError('The amount must be a positive whole number.');
  if (fromId === toId) throw new UserError('You cannot pay yourself.');
  getAccount(guildId, fromId);
  getAccount(guildId, toId);
  db.transaction(() => {
    const from = db.get('SELECT wallet FROM economy WHERE guild_id = ? AND user_id = ?', guildId, fromId);
    if (from.wallet < amount) throw new UserError('You do not have enough coins in your wallet.');
    db.run('UPDATE economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?', amount, guildId, fromId);
    db.run('UPDATE economy SET wallet = wallet + ? WHERE guild_id = ? AND user_id = ?', amount, guildId, toId);
    logTx(guildId, fromId, 'pay_out', -amount, `to ${toId}`);
    logTx(guildId, toId, 'pay_in', amount, `from ${fromId}`);
  });
}

/** Rob mechanics: returns { success, amount }. Stamps the cooldown. */
function rob(guildId, robberId, targetId) {
  const c = cfg(guildId);
  if (!c.robEnabled) throw new UserError('Robbing is disabled in this server.');
  if (robberId === targetId) throw new UserError('You cannot rob yourself.');
  const robber = getAccount(guildId, robberId);
  const target = getAccount(guildId, targetId);
  const minRobber = Math.max(50, Math.floor(c.robMinTargetWallet / 2));
  if (robber.wallet < minRobber) throw new UserError(`You need at least ${money(guildId, minRobber)} in your wallet to attempt a robbery (to pay the fine if you fail).`);
  if (target.wallet < c.robMinTargetWallet) throw new UserError(`That user has less than ${money(guildId, c.robMinTargetWallet)} in their wallet. Not worth it.`);

  const cd = claim(guildId, robberId, 'last_rob', c.robCooldownMinutes * 60_000);
  if (!cd.ok) return { cooldown: true, remainingMs: cd.remainingMs };

  if (Math.random() < c.robSuccessRate) {
    const amount = Math.max(1, Math.floor(target.wallet * c.robMaxPercent * (0.4 + Math.random() * 0.6)));
    transfer(guildId, targetId, robberId, amount);
    return { success: true, amount };
  }
  const fine = Math.max(1, Math.min(robber.wallet, Math.floor(robber.wallet * c.robFinePercent)));
  adjust(guildId, robberId, { wallet: -fine }, 'rob_fine', `failed robbery on ${targetId}`);
  return { success: false, amount: fine };
}

// ---- Gambling --------------------------------------------------------------

/** Validates a bet against the wallet and the server's max bet. Returns the integer bet. */
function validateBet(guildId, userId, bet) {
  const c = cfg(guildId);
  if (!Number.isInteger(bet) || bet <= 0) throw new UserError('Your bet must be a positive whole number.');
  if (bet > c.maxBet) throw new UserError(`The maximum bet is ${money(guildId, c.maxBet)}.`);
  const acc = getAccount(guildId, userId);
  if (bet > acc.wallet) throw new UserError(`You only have ${money(guildId, acc.wallet)} in your wallet.`);
  return bet;
}

/** Settles a bet: `returned` is what the user gets back (0 = lost, 2*bet = doubled). */
function settleBet(guildId, userId, bet, returned, game) {
  return adjust(guildId, userId, { wallet: returned - bet }, `bet_${game}`, returned > bet ? 'win' : returned === bet ? 'push' : 'loss');
}

// ---- Leaderboard & history -------------------------------------------------

function leaderboard(guildId, limit = 100) {
  return db.all(
    'SELECT user_id, wallet, bank, wallet + bank AS total FROM economy WHERE guild_id = ? ORDER BY total DESC LIMIT ?',
    guildId, limit,
  );
}

function history(guildId, userId, limit = 15) {
  return db.all('SELECT * FROM transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?', guildId, userId, limit);
}

// ---- Shop ------------------------------------------------------------------

const listItems = (guildId) => db.all('SELECT * FROM shop_items WHERE guild_id = ? ORDER BY price ASC, name ASC', guildId);
const findItem = (guildId, name) => db.get('SELECT * FROM shop_items WHERE guild_id = ? AND name = ?', guildId, String(name).trim());
const getItem = (guildId, id) => db.get('SELECT * FROM shop_items WHERE guild_id = ? AND id = ?', guildId, id);

function addItem(guildId, { name, description, price, roleId, stock, sellable }) {
  if (listItems(guildId).length >= 50) throw new UserError('A server can have at most 50 shop items.');
  try {
    return db.run(
      `INSERT INTO shop_items (guild_id, name, description, price, role_id, stock, sellable, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      guildId, name, description ?? null, price, roleId ?? null, stock ?? null, sellable === false ? 0 : 1, Date.now(),
    ).lastInsertRowid;
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new UserError('An item with that name already exists.');
    throw err;
  }
}

function removeItem(guildId, name) {
  return db.run('DELETE FROM shop_items WHERE guild_id = ? AND name = ?', guildId, String(name).trim()).changes > 0;
}

/** Buys `quantity` of an item. Returns the item. Role items are limited to quantity 1. */
function buy(guildId, userId, item, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new UserError('Quantity must be between 1 and 100.');
  if (item.role_id && quantity !== 1) throw new UserError('Role items can only be bought one at a time.');
  const total = item.price * quantity;
  db.transaction(() => {
    const fresh = db.get('SELECT * FROM shop_items WHERE id = ?', item.id);
    if (!fresh) throw new UserError('That item no longer exists.');
    if (fresh.stock !== null && fresh.stock < quantity) throw new UserError(`Only ${fresh.stock} left in stock.`);
    const acc = getAccount(guildId, userId);
    if (acc.wallet < total) throw new UserError(`You need ${money(guildId, total)} but only have ${money(guildId, acc.wallet)}.`);
    db.run('UPDATE economy SET wallet = wallet - ? WHERE guild_id = ? AND user_id = ?', total, guildId, userId);
    if (fresh.stock !== null) db.run('UPDATE shop_items SET stock = stock - ? WHERE id = ?', quantity, item.id);
    db.run(
      `INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      guildId, userId, item.id, quantity,
    );
    logTx(guildId, userId, 'buy', -total, `${quantity}x ${item.name}`);
  });
  return total;
}

function inventory(guildId, userId) {
  return db.all(
    `SELECT i.item_id, i.quantity, s.name, s.price, s.role_id, s.sellable
     FROM inventory i JOIN shop_items s ON s.id = i.item_id
     WHERE i.guild_id = ? AND i.user_id = ? AND i.quantity > 0 ORDER BY s.name`,
    guildId, userId,
  );
}

/** Sells items back for sellRefundPercent of the price. Returns the refund. */
function sell(guildId, userId, item, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new UserError('Quantity must be at least 1.');
  if (!item.sellable) throw new UserError('That item cannot be sold back.');
  const refund = Math.floor((item.price * cfg(guildId).sellRefundPercent) / 100) * quantity;
  db.transaction(() => {
    const row = db.get('SELECT quantity FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?', guildId, userId, item.id);
    if (!row || row.quantity < quantity) throw new UserError(`You only own ${row?.quantity ?? 0} of that item.`);
    db.run('UPDATE inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?', quantity, guildId, userId, item.id);
    getAccount(guildId, userId);
    db.run('UPDATE economy SET wallet = wallet + ? WHERE guild_id = ? AND user_id = ?', refund, guildId, userId);
    logTx(guildId, userId, 'sell', refund, `${quantity}x ${item.name}`);
  });
  return refund;
}

module.exports = {
  cfg, money, assertEnabled, getAccount, adjust, claim, claimDaily, deposit, withdraw, transfer, rob,
  validateBet, settleBet, leaderboard, history, listItems, findItem, getItem, addItem, removeItem, buy, inventory, sell,
};
