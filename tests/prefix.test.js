'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-prefixtest-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/database');
const settings = require('../src/services/settings');
const prefix = require('../src/services/prefix');
const aliases = require('../src/config/aliases');
const { runCommand } = require('../src/services/commandRunner');
const { PrefixInteraction } = require('../src/utils/prefixInteraction');
const { ArgError, T } = require('../src/utils/argparse');
const { UserError } = require('../src/utils/errors');

test.before(() => db.open());
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---- minimal fakes of the Discord objects the adapter touches ------------------------------

class Coll extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
  first() { return this.values().next().value; }
}
const opt = (type, name, extra = {}) => ({ type, name, description: name, ...extra });
const fakeCommand = (name, options, extra = {}) => ({
  data: { name, toJSON: () => ({ name, description: `${name} command`, options }) },
  category: 'test', cooldown: 0, guildOnly: true, execute: async () => {}, ...extra,
});

const GUILD = '4000';
const sentMessages = [];

function world() {
  const member = (id, name) => ({ id, displayName: name, user: { id, username: name }, permissions: { has: () => true } });
  const members = new Coll([['100000000000000001', member('100000000000000001', 'asa')], ['100000000000000002', member('100000000000000002', 'budi')]]);
  members.fetch = async (id) => members.get(id) ?? null;
  members.search = async ({ query }) => new Coll([...members].filter(([, m]) => m.displayName.includes(query.toLowerCase())));
  members.me = { id: '900' };
  members.cache = members;
  const roles = new Coll([['100000000000000003', { id: '100000000000000003', name: 'Member' }], ['100000000000000004', { id: '100000000000000004', name: 'VIP Gold' }]]);
  const channels = new Coll([['100000000000000005', { id: '100000000000000005', name: 'general', type: 0 }], ['100000000000000006', { id: '100000000000000006', name: 'voice-1', type: 2 }]]);
  const guild = { id: GUILD, members, roles: { cache: roles }, channels: { cache: channels } };
  const channel = { send: async (p) => ({ ...p, id: 'sent' }), sendTyping: async () => {}, permissionsFor: () => ({ has: () => true }) };
  const client = {
    user: { id: '900' }, commands: new Map(), maintenance: false, stats: { commandsRun: 0 },
    users: { fetch: async (id) => (id === '100000000000000001' || id === '100000000000000002' ? members.get(id).user : Promise.reject(new Error('unknown'))) },
  };
  const makeMessage = (content, authorId = '100000000000000001') => {
    const message = {
      id: 'm1', content, author: { id: authorId, username: 'asa', bot: false }, member: members.get(authorId), guild, guildId: GUILD,
      channel, channelId: 'c1', createdTimestamp: 1000, mentions: { everyone: false }, attachments: new Map(),
      reply: async (payload) => {
        const sent = { ...payload, edits: [], deleted: false, edit: async (p) => { sent.edits.push(p); return sent; }, delete: async () => { sent.deleted = true; } };
        sentMessages.push(sent);
        return sent;
      },
    };
    return message;
  };
  return { client, guild, makeMessage };
}

// ---- recognising chat commands ------------------------------------------------------------------

test('aliases never shadow real commands and point at real commands', () => {
  const { client } = world();
  for (const n of ['balance', 'ping', 'help', 'ban']) client.commands.set(n, fakeCommand(n, []));
  const map = prefix.aliasMap(client.commands);
  assert.equal(map.get('bal'), 'balance');
  for (const list of Object.values(aliases)) for (const a of list) assert.ok(/^[a-z0-9]+$/.test(a), `bad alias ${a}`);
  const all = Object.values(aliases).flat();
  assert.equal(new Set(all).size, all.length, 'duplicate alias');
});

test('parseInvocation: prefix, alias, mention and things that are not commands', () => {
  const { client, makeMessage } = world();
  client.commands.set('balance', fakeCommand('balance', []));
  client.commands.set('ban', fakeCommand('ban', []));

  const hit = prefix.parseInvocation(makeMessage('!bal @asa'), client);
  assert.equal(hit.command.data.name, 'balance');
  assert.equal(hit.args, '@asa');
  assert.equal(prefix.parseInvocation(makeMessage('!BAN   x  y'), client).args, 'x  y');
  assert.equal(prefix.parseInvocation(makeMessage('!unknowncmd'), client), null);
  assert.equal(prefix.parseInvocation(makeMessage('hello !ban'), client), null);
  assert.equal(prefix.parseInvocation(makeMessage('! ban'), client), null);
  assert.equal(prefix.parseInvocation(makeMessage('!'), client), null);

  assert.equal(prefix.parseInvocation(makeMessage('<@900> ban foo'), client).via, 'mention');
  assert.equal(prefix.parseInvocation(makeMessage('<@!900> bal'), client).command.data.name, 'balance');
  assert.equal(prefix.parseInvocation(makeMessage('<@900> what is the weather'), client), null); // left for AI chat
  assert.equal(prefix.parseInvocation(makeMessage('<@900>'), client).bareMention, true);
  assert.equal(prefix.parseInvocation(makeMessage('<@900>ban'), client), null);
});

test('per-server prefix, switching off, and mention switch', () => {
  const { client, makeMessage } = world();
  client.commands.set('ban', fakeCommand('ban', []));
  settings.set(GUILD, 'prefix.value', '?');
  assert.equal(prefix.parseInvocation(makeMessage('?ban'), client).command.data.name, 'ban');
  assert.equal(prefix.parseInvocation(makeMessage('!ban'), client), null);
  settings.set(GUILD, 'prefix.value', 'b!');
  assert.equal(prefix.parseInvocation(makeMessage('B!ban'), client).via, 'prefix');
  settings.set(GUILD, 'prefix.enabled', false);
  assert.equal(prefix.parseInvocation(makeMessage('b!ban'), client), null);
  assert.equal(prefix.parseInvocation(makeMessage('<@900> ban'), client).via, 'mention'); // slash + mention still work
  settings.set(GUILD, 'prefix.allowMention', false);
  assert.equal(prefix.parseInvocation(makeMessage('<@900> ban'), client), null);
  settings.resetSection(GUILD, 'prefix');
  assert.equal(prefix.prefixSettings(GUILD).value, '!');
});

// ---- the adapter -------------------------------------------------------------------------------

test('options: users, roles, channels, numbers, booleans', async () => {
  const { client, makeMessage } = world();
  const command = fakeCommand('mix', [
    opt(T.USER, 'user', { required: true }), opt(T.ROLE, 'role'), opt(T.CHANNEL, 'channel', { channel_types: [0] }),
    opt(T.INTEGER, 'n'), opt(T.BOOLEAN, 'flag'),
  ]);
  const ia = new PrefixInteraction(makeMessage('x'), command, '<@100000000000000002> "VIP Gold" #general 5 yes', client);
  await ia.prepare();
  assert.equal(ia.options.getUser('user', true).id, '100000000000000002');
  assert.equal(ia.options.getMember('user').id, '100000000000000002');
  assert.equal(ia.options.getRole('role').id, '100000000000000004');
  assert.equal(ia.options.getChannel('channel').id, '100000000000000005');
  assert.equal(ia.options.getInteger('n'), 5);
  assert.equal(ia.options.getBoolean('flag'), true);
  assert.equal(ia.options.getString('n'), null); // wrong type, like discord.js
  assert.equal(ia.inGuild(), true);
  assert.equal(ia.guildId, GUILD);
});

test('options: look-ups by name, ID, and clear errors', async () => {
  const { client, makeMessage } = world();
  const command = fakeCommand('who', [opt(T.USER, 'user', { required: true }), opt(T.CHANNEL, 'channel', { channel_types: [0] })]);
  let ia = new PrefixInteraction(makeMessage('x'), command, 'budi', client);
  await ia.prepare();
  assert.equal(ia.options.getUser('user').id, '100000000000000002');
  ia = new PrefixInteraction(makeMessage('x'), command, '100000000000000001', client);
  await ia.prepare();
  assert.equal(ia.options.getUser('user').id, '100000000000000001');
  await assert.rejects(new PrefixInteraction(makeMessage('x'), command, 'nobody-here', client).prepare(), (e) => e instanceof ArgError && /could not find a user/.test(e.message));
  await assert.rejects(new PrefixInteraction(makeMessage('x'), command, '<@999999999999999999>', client).prepare(), ArgError);
  await assert.rejects(new PrefixInteraction(makeMessage('x'), command, 'asa #voice-1', client).prepare(), /not a valid kind of channel/);
  await assert.rejects(new PrefixInteraction(makeMessage('x'), command, 'asa #nope', client).prepare(), /could not find a channel/);
  await assert.rejects(new PrefixInteraction(makeMessage('x'), command, '', client).prepare(), /Missing `user`/);
});

test('options: subcommands and attachments', async () => {
  const { client, makeMessage } = world();
  const command = fakeCommand('music', [
    { type: T.SUB, name: 'play', description: 'x', options: [opt(T.STRING, 'url'), opt(T.ATTACHMENT, 'file')] },
    { type: T.SUB, name: 'stop', description: 'x', options: [] },
  ]);
  const message = makeMessage('x');
  message.attachments.set('1', { id: '1', name: 'song.mp3', url: 'https://cdn.example/song.mp3' });
  const ia = new PrefixInteraction(message, command, 'play', client);
  await ia.prepare();
  assert.equal(ia.options.getSubcommand(), 'play');
  assert.equal(ia.options.getAttachment('file').name, 'song.mp3');
  assert.equal(ia.options.getString('url'), null);
});

test('replies: normal, deferred, edited, follow-up', async () => {
  const { client, makeMessage } = world();
  const ia = new PrefixInteraction(makeMessage('x'), fakeCommand('t', []), '', client);
  await ia.deferReply();
  assert.equal(ia.deferred, true);
  const first = await ia.editReply({ content: 'hello', embeds: [], flags: 64, allowedMentions: { users: ['1'] } });
  assert.equal(first.content, 'hello');
  assert.equal(first.flags, undefined); // flags are not valid for chat messages
  assert.equal(first.allowedMentions.repliedUser, false);
  assert.deepEqual(first.allowedMentions.users, ['1']);
  assert.equal(ia.replied, true);
  await ia.editReply({ content: 'again' });
  assert.equal(first.edits.at(-1).content, 'again');
  const follow = await ia.followUp({ content: 'more' });
  assert.equal(follow.content, 'more');
  assert.equal(await ia.fetchReply(), first);
});

test('private replies are temporary and never carry controls others could press', async () => {
  const { client, makeMessage } = world();
  const ia = new PrefixInteraction(makeMessage('x'), fakeCommand('secret', []), '', client);
  const row = (id) => ({ toJSON: () => ({ components: [{ custom_id: id }] }) });
  await assert.rejects(ia.reply({ content: 'x', components: [row('shop:buy:1')], flags: 64 }), (e) => e instanceof UserError && /slash command/.test(e.message));
  await ia.reply({ content: 'ok', components: [row('~cf:1:yes'), row('help:category')], flags: 64 });
  await assert.rejects(ia.editReply({ components: [row('rp:grant:1')] }), UserError); // inherits "private" from the first reply
  const pub = new PrefixInteraction(makeMessage('x'), fakeCommand('open', []), '', client);
  await pub.reply({ content: 'public', components: [row('rp:grant:1')] }); // public replies may carry any controls
});

test('modal-only commands explain what to do', async () => {
  const { client, makeMessage } = world();
  const ia = new PrefixInteraction(makeMessage('x'), fakeCommand('embedbuilder', []), '', client);
  await assert.rejects(ia.showModal({}), /slash command/);
});

// ---- the shared command runner ---------------------------------------------------------------------

test('runCommand: permissions, owner-only, blacklist, arguments and success', async () => {
  const { client, makeMessage } = world();
  const calls = [];
  const send = (ia) => ia.replies;
  const make = (content, extra = {}, cmdExtra = {}) => {
    const command = fakeCommand('kick', [opt(T.USER, 'user', { required: true }), opt(T.STRING, 'reason')], {
      execute: async (i) => { calls.push(i.options.getUser('user', true).id + '|' + (i.options.getString('reason') ?? '')); await i.reply({ content: 'done' }); },
      ...cmdExtra,
    });
    const ia = new PrefixInteraction(makeMessage(content, extra.author ?? '100000000000000001'), command, content.split(' ').slice(1).join(' '), client);
    return { command, ia };
  };
  const mark = sentMessages.length;
  let { command, ia } = make('!kick <@100000000000000002> being rude');
  await runCommand(ia, client, command, { prepare: () => ia.prepare() });
  assert.deepEqual(calls, ['100000000000000002|being rude']);
  assert.equal(client.stats.commandsRun, 1);

  // missing permission -> error reply, command not executed
  ({ command, ia } = make('!kick <@100000000000000002>', {}, { userPermissions: [1n << 1n] }));
  ia.member.permissions = { has: () => false };
  await runCommand(ia, client, command, { prepare: () => ia.prepare() });
  assert.equal(calls.length, 1);
  ia.member.permissions = { has: () => true };

  // owner only
  ({ command, ia } = make('!kick <@100000000000000002>', {}, { ownerOnly: true }));
  await runCommand(ia, client, command, { prepare: () => ia.prepare() });
  assert.equal(calls.length, 1);

  // bad arguments never run the command and do not start the cooldown
  ({ command, ia } = make('!kick', {}, { cooldown: 60 }));
  await assert.rejects(runCommand(ia, client, command, { prepare: () => ia.prepare() }), ArgError);
  ({ command, ia } = make('!kick <@100000000000000002>', {}, { cooldown: 60 }));
  await runCommand(ia, client, command, { prepare: () => ia.prepare() });
  assert.equal(calls.length, 2); // would be blocked if the failed attempt had used the cooldown

  // blacklisted users are ignored silently in chat
  db.run('INSERT INTO blacklist (user_id, reason, created_at) VALUES (?, ?, ?)', '100000000000000001', 'test', Date.now());
  const before = sentMessages.length;
  ({ command, ia } = make('!kick <@100000000000000002>'));
  await runCommand(ia, client, command, { prepare: () => ia.prepare() });
  assert.equal(calls.length, 2);
  assert.equal(sentMessages.length, before, 'blacklisted user must not get any reply');
  db.run('DELETE FROM blacklist WHERE user_id = ?', '100000000000000001');
  assert.ok(sentMessages.length > mark);
  void send;
});
