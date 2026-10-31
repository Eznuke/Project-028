'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const logger = require('../utils/logger');
const migrations = require('./migrations');

/** Converts JS values into something node:sqlite can bind. */
function normalize(params) {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return p;
    if (typeof p === 'number') {
      if (!Number.isFinite(p)) throw new TypeError('Cannot bind a non-finite number');
      return p;
    }
    if (typeof p === 'string') return p;
    throw new TypeError(`Unsupported SQL parameter type: ${typeof p}`);
  });
}

/**
 * Thin wrapper around Node's built-in synchronous SQLite driver (node:sqlite).
 * It is synchronous, so a read/modify/write inside one function cannot be
 * interleaved with another command on the same process.
 */
class Database {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.cache = new Map();
  }

  open() {
    if (this.db) return this;
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      throw new Error(
        `This bot needs Node.js 22.13 or newer (built-in SQLite). You are running ${process.version}.`,
      );
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    } catch (err) {
      logger.warn('Could not enable WAL mode, continuing with the default journal:', err.message);
    }
    this.migrate();
    return this;
  }

  migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    if (pending.length === 0) {
      logger.debug(`Database is up to date (schema v${current}).`);
      return;
    }
    for (const m of pending) {
      logger.info(`Applying database migration ${m.version}: ${m.name}`);
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${Number(m.version)}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
      }
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** INSERT/UPDATE/DELETE. Returns { changes, lastInsertRowid }. */
  run(sql, ...params) {
    const r = this.stmt(sql).run(...normalize(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** First row or null. */
  get(sql, ...params) {
    const row = this.stmt(sql).get(...normalize(params));
    return row === undefined ? null : { ...row };
  }

  /** All rows as plain objects. */
  all(sql, ...params) {
    return this.stmt(sql)
      .all(...normalize(params))
      .map((r) => ({ ...r }));
  }

  /** Runs fn inside BEGIN/COMMIT. Rolls back if fn throws. Not re-entrant. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  getMeta(key, fallback = null) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : fallback;
  }

  setMeta(key, value) {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      String(value),
    );
  }

  close() {
    if (!this.db) return;
    try {
      this.cache.clear();
      this.db.close();
    } catch (err) {
      logger.warn('Error while closing the database:', err.message);
    }
    this.db = null;
  }
}

module.exports = new Database(config.dbPath);
module.exports.Database = Database;
