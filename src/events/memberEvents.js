'use strict';

const { Events } = require('discord.js');
const welcome = require('../services/welcome');
const antiraid = require('../services/antiraid');

module.exports = [
  {
    name: Events.GuildMemberAdd,
    async execute(member) {
      // Anti-raid goes first: a removed member gets no welcome and no roles.
      const removed = await antiraid.handleJoin(member);
      if (removed) return;
      // Members who must still accept the rules screen get their roles later (see GuildMemberUpdate).
      if (!member.pending) await welcome.applyAutoroles(member);
      await welcome.sendWelcome(member);
      await welcome.logJoin(member);
    },
  },
  {
    name: Events.GuildMemberUpdate,
    async execute(oldMember, newMember) {
      if (oldMember.pending && !newMember.pending) await welcome.applyAutoroles(newMember);
    },
  },
  {
    name: Events.GuildMemberRemove,
    async execute(member) {
      await welcome.sendGoodbye(member);
      await welcome.logLeave(member);
    },
  },
];
