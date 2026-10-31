'use strict';

const { Events } = require('discord.js');
const tv = require('../services/tempvoice');

/** Join the lobby channel -> get a private room; leave a room -> it disappears when empty. */
module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    const cfg = tv.cfgOf(newState.guild.id);

    if (cfg.enabled && newState.channelId && newState.channelId === cfg.lobbyChannelId && oldState.channelId !== newState.channelId) {
      await tv.createRoom(member, cfg);
    }
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await tv.cleanupIfEmpty(oldState.channel);
    }
  },
};
