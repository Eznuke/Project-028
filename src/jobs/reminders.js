'use strict';

const { PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const logger = require('../utils/logger');

const TITLES = { reminder: '⏰ Reminder', timer: '⏲️ Timer finished', countdown: '🎉 Countdown reached' };

/** Delivers due reminders, timers and countdown alerts. */
module.exports = {
  name: 'reminders',
  intervalMs: 10_000,
  async run(client) {
    const due = db.all('SELECT * FROM reminders WHERE sent = 0 AND remind_at <= ? ORDER BY remind_at LIMIT 30', Date.now());
    for (const r of due) {
      // Mark first: a crash must never cause the same reminder to be sent forever.
      db.run('UPDATE reminders SET sent = 1 WHERE id = ?', r.id);
      const text = `${TITLES[r.kind] ?? TITLES.reminder}: ${r.message}`;
      let delivered = false;

      if (r.channel_id) {
        try {
          const channel = client.channels.cache.get(r.channel_id) ?? (await client.channels.fetch(r.channel_id).catch(() => null));
          const me = channel?.guild?.members.me;
          if (channel?.isTextBased() && (!me || channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))) {
            await channel.send({ content: `<@${r.user_id}> ${text}`.slice(0, 1990), allowedMentions: { users: [r.user_id] } });
            delivered = true;
          }
        } catch (err) {
          logger.debug(`Reminder ${r.id}: channel delivery failed: ${err.message}`);
        }
      }
      if (!delivered) {
        try {
          const user = await client.users.fetch(r.user_id);
          await user.send({ content: text.slice(0, 1990), allowedMentions: { parse: [] } });
          delivered = true;
        } catch (err) {
          logger.debug(`Reminder ${r.id}: DM delivery failed: ${err.message}`);
        }
      }
    }
    // Housekeeping: forget delivered reminders after a week.
    db.run('DELETE FROM reminders WHERE sent = 1 AND remind_at < ?', Date.now() - 7 * 86_400_000);
  },
};
