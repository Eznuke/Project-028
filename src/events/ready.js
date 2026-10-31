'use strict';

const { Events, ActivityType } = require('discord.js');
const logger = require('../utils/logger');
const scheduler = require('../services/scheduler');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    client.stats.readyAt = Date.now();
    logger.info(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s).`);
    client.user.setPresence({
      activities: [{ name: '/help', type: ActivityType.Listening }],
      status: 'online',
    });
    scheduler.start(client);
  },
};
