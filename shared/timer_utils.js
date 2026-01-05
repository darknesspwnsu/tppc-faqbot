// shared/timer_utils.js
//
// Lightweight timer helpers to standardize scheduler/timer setup.

import { logger } from "./logger.js";

export function startTimeout({ label, ms, fn }) {
  const delay = Number.isFinite(ms) ? ms : 0;
  const timer = setTimeout(fn, delay);
  logger.debug?.("timer.timeout.start", { label, ms: delay });
  return timer;
}

export function startInterval({ label, ms, fn }) {
  const delay = Number.isFinite(ms) ? ms : 0;
  const timer = setInterval(fn, delay);
  logger.debug?.("timer.interval.start", { label, ms: delay });
  return timer;
}

export function clearTimer(timer, label = "") {
  if (!timer) return;
  try {
    clearTimeout(timer);
    clearInterval(timer);
    if (label) logger.debug?.("timer.clear", { label });
  } catch (err) {
    logger.warn("timer.clear.failed", { label, error: logger.serializeError(err) });
  }
}
