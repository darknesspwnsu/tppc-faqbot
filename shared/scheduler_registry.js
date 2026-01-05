// shared/scheduler_registry.js
//
// Central registry for global/passive schedulers.

import { logger } from "./logger.js";

const schedulers = new Map(); // id -> { start, stop, meta, running }

export function registerScheduler(id, start, stop = null, meta = {}) {
  const key = String(id || "").trim();
  if (!key) throw new Error("registerScheduler requires an id");
  if (typeof start !== "function") throw new Error(`registerScheduler(${key}) missing start fn`);
  if (schedulers.has(key)) throw new Error(`Scheduler already registered: ${key}`);

  schedulers.set(key, {
    start,
    stop: typeof stop === "function" ? stop : null,
    meta: meta || {},
    running: false,
  });
}

export function startAll(context = {}) {
  for (const [id, entry] of schedulers.entries()) {
    if (entry.running) continue;
    try {
      entry.start(context);
      entry.running = true;
      logger.info("scheduler.start.ok", { id });
    } catch (err) {
      logger.error("scheduler.start.failed", { id, error: logger.serializeError(err) });
    }
  }
}

export function stopAll() {
  for (const [id, entry] of schedulers.entries()) {
    if (!entry.running || !entry.stop) continue;
    try {
      entry.stop();
      entry.running = false;
      logger.info("scheduler.stop.ok", { id });
    } catch (err) {
      logger.error("scheduler.stop.failed", { id, error: logger.serializeError(err) });
    }
  }
}

export function listSchedulers() {
  return Array.from(schedulers.keys());
}
