'use strict';

/**
 * Default per-server settings. Stored per guild as JSON in SQLite and deep-merged
 * over these defaults, so new keys added here appear automatically for old servers.
 */
module.exports = {
  display: {
    accentColor: '#5865F2',
  },

  /** Join-to-create voice channels. */
  tempVoice: {
    enabled: false,
    lobbyChannelId: null,
    categoryId: null,
    nameTemplate: "{user}'s room",
    defaultLimit: 0,
    maxRooms: 30,
  },

  /** Staff applications: panel button -> form -> review message with accept / reject. */
  applications: {
    enabled: false,
    reviewChannelId: null,
    title: 'Staff application',
    questions: ['Why do you want to join the team?', 'How old are you and where are you from?', 'Any previous experience?'],
    staffRoleIds: [],
    acceptRoleId: null,
    cooldownHours: 24,
    dmApplicant: true,
  },

  /** Chat-prefix commands (e.g. "!ping") that work next to the slash commands. */
  prefix: {
    enabled: true,
    value: process.env.DEFAULT_PREFIX || '!',
    /** Also accept "@Bot command" as an invocation. */
    allowMention: true,
  },

  welcome: {
    enabled: false,
    channelId: null,
    useEmbed: true,
    title: 'Welcome!',
    message: 'Welcome {user} to **{server}**! You are member #{memberCount}.',
    color: '#57F287',
    imageUrl: null,
    showAvatar: true,
    dmEnabled: false,
    dmMessage: 'Welcome to **{server}**, {username}! Please read the rules.',
  },

  goodbye: {
    enabled: false,
    channelId: null,
    useEmbed: true,
    title: 'Goodbye',
    message: '**{username}** has left **{server}**. We now have {memberCount} members.',
    color: '#ED4245',
    imageUrl: null,
    showAvatar: true,
  },

  autorole: {
    roleIds: [],
    botRoleIds: [],
  },

  logs: {
    channels: {
      messages: null,
      members: null,
      roles: null,
      channels: null,
      voice: null,
      moderation: null,
      tickets: null,
    },
    ignoredChannelIds: [],
    // Which categories are active (a category also needs a channel to log to)
    enabled: {
      messages: true,
      members: true,
      roles: true,
      channels: true,
      voice: true,
      moderation: true,
      tickets: true,
    },
  },

  moderation: {
    dmOnAction: true,
    requireReason: false,
    // Automatic punishments when a member reaches N active warnings
    warnThresholds: [
      { count: 3, action: 'timeout', duration: '1h' },
      { count: 5, action: 'kick', duration: null },
    ],
    massRoleLimit: 100,
    purgeMax: 100,
    automod: {
      enabled: false,
      ignoredRoleIds: [],
      ignoredChannelIds: [],
      punishment: 'timeout', // delete | warn | timeout
      timeoutDuration: '5m',
      spam: { enabled: true, maxMessages: 6, perSeconds: 8, duplicateLimit: 3 },
      links: { enabled: false, allowedDomains: [] },
      invites: { enabled: true, allowOwnServer: true },
      mentions: { enabled: true, maxMentions: 5 },
      words: { enabled: false, list: [] },
      caps: { enabled: false, minLength: 15, percent: 70 },
    },
    antiRaid: {
      enabled: false,
      joinThreshold: 8,
      perSeconds: 10,
      action: 'kick', // kick | ban | lockdown-alert
      minAccountAgeDays: 0,
      alertChannelId: null,
    },
  },

  leveling: {
    enabled: true,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    minMessageLength: 5,
    multiplier: 1,
    announce: true,
    announceChannelId: null, // null = same channel as the message
    message: '🎉 {user} reached **level {level}**!',
    levelRoles: [], // [{ level: 5, roleId: '123' }]
    stackRoles: false,
    noXpChannelIds: [],
    noXpRoleIds: [],
  },

  economy: {
    enabled: true,
    currencyName: 'coins',
    currencySymbol: '🪙',
    startingBalance: 100,
    dailyAmount: 200,
    weeklyAmount: 1000,
    workMin: 50,
    workMax: 200,
    workCooldownMinutes: 60,
    begMin: 5,
    begMax: 50,
    begCooldownMinutes: 5,
    begSuccessRate: 0.7,
    robEnabled: true,
    robCooldownMinutes: 60,
    robSuccessRate: 0.4,
    robMaxPercent: 0.25,
    robFinePercent: 0.2,
    robMinTargetWallet: 100,
    maxBet: 5000,
    bankLimit: 0, // 0 = unlimited
    sellRefundPercent: 50,
  },

  tickets: {
    categoryChannelId: null,
    supportRoleIds: [],
    logChannelId: null,
    transcriptChannelId: null,
    panelChannelId: null,
    preventDuplicates: true,
    maxOpenPerUser: 1,
    counter: 0,
    categories: [{ id: 'general', label: 'General Support', emoji: '🎫', description: 'Questions and help' }],
    welcomeMessage: 'Thanks for opening a ticket, {user}. A staff member will be with you shortly.',
  },

  suggestions: {
    channelId: null,
    logChannelId: null,
    staffRoleIds: [],
    anonymous: false,
    requireStaffNote: false,
  },

  roles: {
    verificationRoleId: null,
  },

  confessions: {
    channelId: null,
    banned: [],
  },

  ai: {
    enabled: false,
    channelIds: [],
  },

  utility: {
    timezone: null, // falls back to DEFAULT_TIMEZONE
  },
};
