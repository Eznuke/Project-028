'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { T, ArgError, tokenize, parseArguments, usageLines, usageFor } = require('../src/utils/argparse');

const opt = (type, name, extra = {}) => ({ type, name, description: name, ...extra });
const sub = (name, options = []) => ({ type: T.SUB, name, description: name, options });
const group = (name, options) => ({ type: T.GROUP, name, description: name, options });

const ban = {
  name: 'ban', description: 'Ban',
  options: [opt(T.USER, 'user', { required: true }), opt(T.STRING, 'reason', { max_length: 50 }), opt(T.STRING, 'duration'), opt(T.INTEGER, 'delete_messages', { min_value: 0, max_value: 7 })],
};
const timeout = {
  name: 'timeout', description: 'Timeout',
  options: [opt(T.USER, 'user', { required: true }), opt(T.STRING, 'duration', { required: true }), opt(T.STRING, 'reason')],
};
const translate = {
  name: 'translate', description: 'Translate',
  options: [opt(T.STRING, 'text', { required: true }), opt(T.STRING, 'to', { required: true }), opt(T.STRING, 'from')],
};
const shop = {
  name: 'shop', description: 'Shop',
  options: [sub('view'), sub('add', [opt(T.STRING, 'name', { required: true }), opt(T.INTEGER, 'price', { required: true, min_value: 1 }), opt(T.STRING, 'description'), opt(T.ROLE, 'role')]), sub('remove', [opt(T.STRING, 'name', { required: true })])],
};
const automod = { name: 'automod', description: 'x', options: [group('words', [sub('add', [opt(T.STRING, 'word', { required: true })])])] };
const flip = { name: 'coinflip', description: 'x', options: [opt(T.STRING, 'side', { choices: [{ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }] }), opt(T.BOOLEAN, 'fancy')] };

test('tokenizer: quotes, named values and spacing', () => {
  assert.deepEqual(tokenize('a "b c" d').map((t) => t.text), ['a', 'b c', 'd']);
  assert.deepEqual(tokenize('reason:"too loud" x').map((t) => t.text), ['reason:too loud', 'x']);
  assert.deepEqual(tokenize('5" screen').map((t) => t.text), ['5"', 'screen']); // lone quote is literal
  assert.deepEqual(tokenize('“curly quotes” ok').map((t) => t.text), ['curly quotes', 'ok']);
  assert.deepEqual(tokenize("don't stop").map((t) => t.text), ["don't", 'stop']);
  assert.deepEqual(tokenize('   ').map((t) => t.text), []);
  assert.equal(tokenize('a\n\nb')[1].sep, '\n\n');
});

test('positional arguments and greedy reason', () => {
  const r = parseArguments(ban, '<@123> being   rude to everyone');
  assert.equal(r.values.get('user').raw, '<@123>');
  assert.equal(r.values.get('reason'), 'being   rude to everyone'); // spacing preserved
  assert.equal(r.values.has('duration'), false);
});

test('named values let optional options be skipped', () => {
  const r = parseArguments(ban, '<@123> spam duration:7d delete_messages:1');
  assert.equal(r.values.get('reason'), 'spam');
  assert.equal(r.values.get('duration'), '7d');
  assert.equal(r.values.get('delete_messages'), 1);
  const q = parseArguments(ban, '<@123> duration:"3 days"');
  assert.equal(q.values.get('duration'), '3 days');
});

test('quoted text that looks like name:value is not treated as named', () => {
  const r = parseArguments(ban, '<@1> "duration: forever"');
  assert.equal(r.values.get('reason'), 'duration: forever');
  assert.equal(r.values.has('duration'), false);
});

test('required options and plain positional options', () => {
  const r = parseArguments(timeout, '<@1> 10m shouting');
  assert.equal(r.values.get('duration'), '10m');
  assert.equal(r.values.get('reason'), 'shouting');
  assert.throws(() => parseArguments(timeout, '<@1>'), /Missing `duration`/);
});

test('a text option followed by a required option takes one word only', () => {
  const r = parseArguments(translate, '"hello world" id');
  assert.equal(r.values.get('text'), 'hello world');
  assert.equal(r.values.get('to'), 'id');
  assert.equal(parseArguments(translate, 'hello id es fr').values.get('from'), 'es fr'); // last text option is greedy
  assert.throws(() => parseArguments(flip, 'heads yes extra'), /Too many/);
});

test('numbers, ranges, choices and booleans', () => {
  assert.throws(() => parseArguments(ban, '<@1> r delete_messages:9'), /at most 7/);
  assert.throws(() => parseArguments(ban, '<@1> r delete_messages:x'), /must be a number/);
  assert.throws(() => parseArguments(ban, '<@1> r delete_messages:1.5'), /whole number/);
  assert.throws(() => parseArguments(ban, `<@1> ${'x'.repeat(60)}`), /at most 50/);
  assert.equal(parseArguments(flip, 'TAILS').values.get('side'), 'tails');
  assert.equal(parseArguments(flip, 'heads yes').values.get('fancy'), true);
  assert.equal(parseArguments(flip, 'heads off').values.get('fancy'), false);
  assert.throws(() => parseArguments(flip, 'edge'), /one of/);
  assert.throws(() => parseArguments(flip, 'heads maybe'), /yes or no/);
});

test('subcommands and groups', () => {
  const add = parseArguments(shop, 'add Cookie 1,500 "A tasty cookie"');
  assert.equal(add.sub, 'add');
  assert.equal(add.values.get('name'), 'Cookie');
  assert.equal(add.values.get('price'), 1500);
  assert.equal(add.values.get('description'), 'A tasty cookie');
  assert.equal(parseArguments(shop, 'VIEW').sub, 'view');
  assert.throws(() => parseArguments(shop, ''), /Say what you want/);
  assert.throws(() => parseArguments(shop, 'nope'), /Unknown option/);
  const g = parseArguments(automod, 'words add badword');
  assert.deepEqual([g.group, g.sub, g.values.get('word')], ['words', 'add', 'badword']);
  assert.throws(() => parseArguments(automod, 'words'), /Choose one of/);
});

test('entities are returned for the caller to resolve', () => {
  const r = parseArguments(shop, 'add Cookie 5 desc role:@Role');
  assert.deepEqual(r.values.get('role'), { entity: T.ROLE, raw: '@Role' });
});

test('commands without options ignore nothing silently and need no arguments', () => {
  const none = { name: 'ping', description: 'x', options: [] };
  assert.equal(parseArguments(none, 'whatever').values.size, 0);
  assert.equal(parseArguments({ name: 'ping', description: 'x' }, '').values.size, 0);
});

test('usage lines', () => {
  assert.deepEqual(usageLines(timeout, '!').map((l) => l.usage), ['!timeout <user> <duration> [reason]']);
  const lines = usageLines(shop, '!').map((l) => l.usage);
  assert.deepEqual(lines, ['!shop view', '!shop add <name> <price> [description] [role]', '!shop remove <name>']);
  assert.deepEqual(usageFor(shop, '!', 'add').map((l) => l.usage), ['!shop add <name> <price> [description] [role]']);
  assert.equal(usageFor(shop, '!', 'zzz').length, 3);
  assert.deepEqual(usageLines(automod, '/').map((l) => l.usage), ['/automod words add <word>']);
});

test('ArgError carries a readable message', () => {
  try { parseArguments(timeout, ''); } catch (e) { assert.ok(e instanceof ArgError); assert.match(e.message, /user/); }
});
