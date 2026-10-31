'use strict';

const db = require('../database');
const gw = require('../services/giveaways');

/** Ends giveaways whose time is up (also catches ones that ended while the bot was offline). */
module.exports = {
  name: 'giveaways',
  intervalMs: 15_000,
  async run(client) {
    const due = db.all("SELECT id FROM giveaways WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at LIMIT 10", Date.now());
    for (const { id } of due) await gw.end(client, id);
  },
};
