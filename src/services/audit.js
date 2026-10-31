'use strict';

const db = require('../database');
const { truncate } = require('../utils/text');

/**
 * Writes an entry to the bot's own audit trail (configuration changes,
 * moderation actions, owner actions). Never throws: auditing must not break a command.
 */
function record(guildId, actorId, action, target = null, detail = null) {
  try {
    db.run(
      'INSERT INTO audit_log (guild_id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      guildId ?? null,
      actorId ?? null,
      action,
      target === null ? null : String(target),
      detail === null ? null : truncate(typeof detail === 'string' ? detail : JSON.stringify(detail), 1000),
      Date.now(),
    );
  } catch {
    /* intentionally ignored */
  }
}

function recent(guildId, limit = 20) {
  return db.all('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?', guildId, limit);
}

module.exports = { record, recent };
