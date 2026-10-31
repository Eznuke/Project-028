'use strict';

const { Events } = require('discord.js');
const automod = require('../services/automod');

module.exports = [
  {
    name: Events.MessageCreate,
    async execute(message) {
      await automod.handleMessage(message);
    },
  },
  {
    // Edited messages are checked too, so nobody can bypass filters by editing afterwards.
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
      if (newMessage.partial) {
        try {
          newMessage = await newMessage.fetch();
        } catch {
          return;
        }
      }
      if (oldMessage.content === newMessage.content) return;
      await automod.handleMessage(newMessage);
    },
  },
];
