'use strict';

/**
 * Short names for chat (prefix) commands:  { command: ['alias', ...] }
 * An alias can never shadow a real command name; clashes are skipped and logged at startup.
 */
module.exports = {
  help: ['h', 'commands', 'bantuan'],
  ping: ['pong', 'latency'],
  about: ['info'],
  botinfo: ['stats'],
  userinfo: ['ui', 'whois', 'user'],
  serverinfo: ['si', 'server', 'guildinfo'],
  avatar: ['av', 'pfp', 'icon'],
  membercount: ['members', 'mc'],
  roleinfo: ['ri'],
  channelinfo: ['ci'],
  permissions: ['perms'],

  kick: ['boot'],
  ban: ['yeet'],
  timeout: ['mute', 'silence'],
  untimeout: ['unmute'],
  warnings: ['warns'],
  clearwarnings: ['clearwarns', 'unwarn'],
  modlogs: ['history', 'infractions'],
  purge: ['clear', 'prune', 'clean'],
  slowmode: ['sm'],
  nick: ['nickname', 'setnick'],
  roleadd: ['addrole', 'giverole'],
  roleremove: ['removerole', 'takerole'],

  rank: ['xp', 'lvl'],
  leaderboard: ['lb', 'top', 'rankings'],

  balance: ['bal', 'money', 'wallet', 'cash'],
  deposit: ['dep'],
  withdraw: ['with', 'wd'],
  inventory: ['inv', 'bag'],
  slots: ['slot'],
  pay: ['give', 'transfer'],

  coinflip: ['cf', 'flip', 'coin'],
  dice: ['roll'],
  wouldyourather: ['wyr'],
  highfive: ['hf', 'high5'],
  '8ball': ['8b', 'eightball'],
  choose: ['pick', 'pilih'],
  quote: ['quotes'],
  suggestion: ['suggest', 'saran'],

  remindme: ['remind', 'reminder', 'ingatkan'],
  calculator: ['calc', 'math', 'hitung'],
  convert: ['conv'],
  translate: ['tr', 'terjemah'],
  shorten: ['short'],
  timezone: ['tz'],

  ticket: ['tiket'],
  giveaway: ['gw', 'undian'],
  rolepanel: ['rp'],
  config: ['settings', 'setup', 'cfg'],
  music: ['m'],
  ai: ['chat'],
};
