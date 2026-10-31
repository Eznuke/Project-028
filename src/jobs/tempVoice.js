'use strict';

const db = require('../database');
const tv = require('../services/tempvoice');

/** Housekeeping: forget rooms that were deleted by hand, remove rooms left empty (e.g. while the bot was offline). */
module.exports = {
  name: 'tempVoice',
  intervalMs: 60_000,
  async run(client) {
    for (const row of db.all('SELECT * FROM temp_voice LIMIT 200')) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue; // guild unavailable right now: keep the record
      const channel = guild.channels.cache.get(row.channel_id);
      if (!channel) { db.run('DELETE FROM temp_voice WHERE channel_id = ?', row.channel_id); continue; }
      if (Date.now() - row.created_at > 30_000) await tv.cleanupIfEmpty(channel);
    }
  },
};
