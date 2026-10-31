'use strict';

process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), `bot-test-${process.pid}.db`);
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, formatResult } = require('../src/utils/calc');
const { convert } = require('../src/utils/convert');
const { parseDuration, formatDuration, isValidTimezone } = require('../src/utils/time');
const { parseLocalDateTime, zoneOffset } = require('../src/utils/zone');
const { isPrivateAddress } = require('../src/utils/http');
const { fill, stripMentions } = require('../src/utils/text');

test('calculator: arithmetic, precedence and functions', () => {
  assert.equal(evaluate('2+3*4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('sqrt(144)+abs(-3)'), 15);
  assert.equal(evaluate('max(1,5,3)'), 5);
  assert.equal(evaluate('10%3'), 1);
  assert.equal(formatResult(evaluate('0.1+0.2')), '0.3');
  assert.ok(Math.abs(evaluate('pi') - Math.PI) < 1e-12);
});

test('calculator: rejects code and bad input', () => {
  for (const bad of ['process.exit()', 'require("fs")', '1/0', '2+', '(1', 'foo(1)', '1;2', 'a'.repeat(300), '']) {
    assert.throws(() => evaluate(bad), undefined, `should reject: ${bad.slice(0, 20)}`);
  }
});

test('converter: units and temperature', () => {
  assert.ok(Math.abs(convert(1, 'km', 'mi').result - 0.621371) < 1e-5);
  assert.equal(convert(100, 'c', 'f').result, 212);
  assert.equal(convert(0, 'c', 'k').result, 273.15);
  assert.equal(convert(1, 'gib', 'mib').result, 1024);
  assert.throws(() => convert(1, 'kg', 'km'), /cannot convert/i);
  assert.throws(() => convert(1, 'zzz', 'km'), /unit/i);
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(parseDuration('0m'), null);
  assert.equal(formatDuration(93_784_000), '1d 2h 3m');
});

test('time zones', () => {
  assert.ok(isValidTimezone('Asia/Jakarta'));
  assert.ok(!isValidTimezone('Mars/Base'));
  assert.equal(zoneOffset(Date.UTC(2026, 0, 1), 'Asia/Jakarta'), 7 * 3_600_000);
  // 2026-12-31 23:59 in Jakarta (UTC+7) is 16:59 UTC
  assert.equal(parseLocalDateTime('2026-12-31 23:59', 'Asia/Jakarta'), Date.UTC(2026, 11, 31, 16, 59));
  assert.equal(parseLocalDateTime('2026-02-31', 'UTC'), null);
  assert.equal(parseLocalDateTime('nonsense', 'UTC'), null);
  // New York in winter is UTC-5, in summer UTC-4
  assert.equal(parseLocalDateTime('2026-01-15 12:00', 'America/New_York'), Date.UTC(2026, 0, 15, 17));
  assert.equal(parseLocalDateTime('2026-07-15 12:00', 'America/New_York'), Date.UTC(2026, 6, 15, 16));
});

test('SSRF guard: private addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) assert.ok(!isPrivateAddress(ip), ip);
});

test('text helpers', () => {
  assert.equal(fill('Hi {user}, {unknown}', { user: 'A' }), 'Hi A, {unknown}');
  assert.ok(!/@everyone/.test(stripMentions('@everyone hi')));
});
