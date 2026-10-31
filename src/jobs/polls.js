'use strict';

const db = require('../database');
const polls = require('../services/polls');

/** Closes polls whose end time has passed. */
module.exports = {
  name: 'polls',
  intervalMs: 20_000,
  async run(client) {
    const due = db.all('SELECT * FROM polls WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at <= ? LIMIT 20', Date.now());
    for (const row of due) {
      db.run('UPDATE polls SET closed = 1 WHERE id = ?', row.id);
      await polls.closeMessage(client, row);
    }
  },
};
