'use strict';

const path = require('node:path');
const logger = require('../utils/logger');
const { loadJobs } = require('../utils/loader');

const timers = new Map();
let running = false;

/**
 * Starts every job found in src/jobs. A job is { name, intervalMs, run(client) }.
 * Jobs never overlap with themselves and a failing job never stops the bot.
 */
function start(client) {
  if (running) return;
  running = true;
  const jobs = loadJobs(path.join(__dirname, '..', 'jobs'));

  for (const job of jobs) {
    let busy = false;
    const tick = async () => {
      if (busy || !client.isReady()) return;
      busy = true;
      try {
        await job.run(client);
      } catch (err) {
        logger.error(`Job "${job.name}" failed:`, err);
      } finally {
        busy = false;
      }
    };
    timers.set(job.name, setInterval(tick, job.intervalMs));
    // First run shortly after start so overdue reminders fire quickly.
    setTimeout(tick, 3000).unref?.();
    logger.info(`Scheduled job "${job.name}" every ${Math.round(job.intervalMs / 1000)}s`);
  }
}

function stop() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
  running = false;
}

module.exports = { start, stop };
