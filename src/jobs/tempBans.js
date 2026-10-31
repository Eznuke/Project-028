'use strict';

const db = require('../database');
const logger = require('../utils/logger');
const mod = require('../services/moderation');

/** Lifts temporary bans whose time is up. */
module.exports = {
  name: 'temp-bans',
  intervalMs: 30_000,
  async run(client) {
    const due = db.all('SELECT * FROM temp_bans WHERE done = 0 AND expires_at <= ? LIMIT 25', Date.now());
    for (const row of due) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) {
        // The bot left that server: nothing to do any more.
        db.run('UPDATE temp_bans SET done = 1 WHERE id = ?', row.id);
        continue;
      }
      try {
        await guild.bans.remove(row.user_id, 'Temporary ban expired');
        mod.createCase({
          guild,
          userId: row.user_id,
          moderatorId: client.user.id,
          action: 'unban',
          reason: 'Temporary ban expired',
        });
      } catch (err) {
        // 10026 = Unknown Ban (already unbanned manually): that is fine.
        if (err.code !== 10026) {
          logger.warn(`Could not lift temp ban ${row.id}: ${err.message}`);
          continue; // retry on the next tick
        }
      }
      db.run('UPDATE temp_bans SET done = 1 WHERE id = ?', row.id);
    }
  },
};
