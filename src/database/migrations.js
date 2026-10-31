'use strict';

/**
 * Ordered, append-only migrations. The applied version is stored in SQLite's
 * `PRAGMA user_version`. Never edit a migration that has shipped: add a new one.
 */
module.exports = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE guild_settings (
        guild_id   TEXT PRIMARY KEY,
        data       TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE blacklist (
        user_id    TEXT PRIMARY KEY,
        reason     TEXT,
        added_by   TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE command_usage (
        name  TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT,
        actor_id   TEXT,
        action     TEXT NOT NULL,
        target     TEXT,
        detail     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_guild ON audit_log (guild_id, created_at);

      CREATE TABLE cases (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT NOT NULL,
        case_number    INTEGER NOT NULL,
        user_id        TEXT NOT NULL,
        moderator_id   TEXT NOT NULL,
        action         TEXT NOT NULL,
        reason         TEXT,
        duration_ms    INTEGER,
        expires_at     INTEGER,
        log_channel_id TEXT,
        log_message_id TEXT,
        created_at     INTEGER NOT NULL,
        UNIQUE (guild_id, case_number)
      );
      CREATE INDEX idx_cases_user ON cases (guild_id, user_id);

      CREATE TABLE warnings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason       TEXT,
        case_number  INTEGER,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_warnings_user ON warnings (guild_id, user_id, active);

      CREATE TABLE temp_bans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_temp_bans_due ON temp_bans (done, expires_at);

      CREATE TABLE reports (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT NOT NULL,
        reporter_id  TEXT NOT NULL,
        target_id    TEXT NOT NULL,
        reason       TEXT NOT NULL,
        message_link TEXT,
        status       TEXT NOT NULL DEFAULT 'open',
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE levels (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        xp         INTEGER NOT NULL DEFAULT 0,
        level      INTEGER NOT NULL DEFAULT 0,
        messages   INTEGER NOT NULL DEFAULT 0,
        last_xp_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX idx_levels_rank ON levels (guild_id, xp DESC);

      CREATE TABLE economy (
        guild_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        wallet      INTEGER NOT NULL DEFAULT 0,
        bank        INTEGER NOT NULL DEFAULT 0,
        last_daily  INTEGER NOT NULL DEFAULT 0,
        last_weekly INTEGER NOT NULL DEFAULT 0,
        last_work   INTEGER NOT NULL DEFAULT 0,
        last_beg    INTEGER NOT NULL DEFAULT 0,
        last_rob    INTEGER NOT NULL DEFAULT 0,
        daily_streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE transactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        type       TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        note       TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_tx_user ON transactions (guild_id, user_id, created_at);

      CREATE TABLE shop_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        name        TEXT NOT NULL COLLATE NOCASE,
        description TEXT,
        price       INTEGER NOT NULL,
        role_id     TEXT,
        stock       INTEGER,
        sellable    INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        UNIQUE (guild_id, name)
      );

      CREATE TABLE inventory (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        item_id  INTEGER NOT NULL REFERENCES shop_items (id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (guild_id, user_id, item_id)
      );

      CREATE TABLE reminders (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        guild_id   TEXT,
        channel_id TEXT,
        message    TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'reminder',
        remind_at  INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_reminders_due ON reminders (sent, remind_at);

      CREATE TABLE afk (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        reason   TEXT,
        since    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE todos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE user_prefs (
        user_id  TEXT PRIMARY KEY,
        timezone TEXT
      );

      CREATE TABLE polls (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        question   TEXT NOT NULL,
        options    TEXT NOT NULL,
        multi      INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        ends_at    INTEGER,
        closed     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE poll_votes (
        poll_id      INTEGER NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        PRIMARY KEY (poll_id, user_id, option_index)
      );

      CREATE TABLE tickets (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        ticket_number INTEGER NOT NULL,
        channel_id    TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        category      TEXT,
        subject       TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        claimed_by    TEXT,
        created_at    INTEGER NOT NULL,
        closed_at     INTEGER,
        closed_by     TEXT,
        UNIQUE (guild_id, ticket_number)
      );
      CREATE INDEX idx_tickets_user ON tickets (guild_id, user_id, status);
      CREATE INDEX idx_tickets_channel ON tickets (channel_id);

      CREATE TABLE suggestions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        staff_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE suggestion_votes (
        suggestion_id INTEGER NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL,
        vote          INTEGER NOT NULL,
        PRIMARY KEY (suggestion_id, user_id)
      );

      CREATE TABLE suggestion_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        suggestion_id INTEGER NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
        actor_id      TEXT NOT NULL,
        action        TEXT NOT NULL,
        note          TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE role_panels (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT,
        message_id  TEXT,
        type        TEXT NOT NULL DEFAULT 'buttons',
        title       TEXT NOT NULL,
        description TEXT,
        exclusive   INTEGER NOT NULL DEFAULT 0,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE role_panel_roles (
        panel_id    INTEGER NOT NULL REFERENCES role_panels (id) ON DELETE CASCADE,
        role_id     TEXT NOT NULL,
        label       TEXT NOT NULL,
        emoji       TEXT,
        description TEXT,
        PRIMARY KEY (panel_id, role_id)
      );

      CREATE TABLE confessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        content    TEXT NOT NULL,
        message_id TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'giveaways, temporary voice channels, staff applications',
    sql: `
      CREATE TABLE giveaways (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        channel_id       TEXT NOT NULL,
        message_id       TEXT,
        host_id          TEXT NOT NULL,
        prize            TEXT NOT NULL,
        winner_count     INTEGER NOT NULL DEFAULT 1,
        ends_at          INTEGER NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        required_role_id TEXT,
        min_level        INTEGER NOT NULL DEFAULT 0,
        winner_ids       TEXT NOT NULL DEFAULT '[]',
        created_at       INTEGER NOT NULL,
        ended_at         INTEGER
      );
      CREATE INDEX idx_giveaways_active ON giveaways (status, ends_at);
      CREATE INDEX idx_giveaways_guild ON giveaways (guild_id, status);

      CREATE TABLE giveaway_entries (
        giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        entered_at  INTEGER NOT NULL,
        PRIMARY KEY (giveaway_id, user_id)
      );

      CREATE TABLE temp_voice (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        owner_id   TEXT NOT NULL,
        panel_message_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_temp_voice_guild ON temp_voice (guild_id);

      CREATE TABLE applications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        answers    TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        message_id TEXT,
        channel_id TEXT,
        decided_by TEXT,
        decision_note TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
      CREATE INDEX idx_applications_user ON applications (guild_id, user_id, status);
    `,
  },
];
