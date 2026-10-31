'use strict';

const db = require('../database');
const config = require('../config');
const settings = require('./settings');
const { isValidTimezone } = require('../utils/time');

/** A member's time zone: personal setting, else the server default, else DEFAULT_TIMEZONE. */
function getTimezone(userId, guildId = null) {
  const row = db.get('SELECT timezone FROM user_prefs WHERE user_id = ?', userId);
  if (row?.timezone && isValidTimezone(row.timezone)) return row.timezone;
  if (guildId) {
    const guildZone = settings.view(guildId).utility.timezone;
    if (guildZone && isValidTimezone(guildZone)) return guildZone;
  }
  return isValidTimezone(config.defaultTimezone) ? config.defaultTimezone : 'UTC';
}

function setTimezone(userId, timezone) {
  db.run(
    'INSERT INTO user_prefs (user_id, timezone) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone',
    userId, timezone,
  );
}

function clearTimezone(userId) {
  db.run('UPDATE user_prefs SET timezone = NULL WHERE user_id = ?', userId);
}

module.exports = { getTimezone, setTimezone, clearTimezone };
