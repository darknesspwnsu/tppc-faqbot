// shared/metrics.js
//
// Time-series counters with hourly buckets stored in MySQL.

import crypto from "node:crypto";
import { getDb } from "../db.js";
import { logger } from "./logger.js";

const DEFAULT_RETENTION_DAYS = 90;

function metricsEnabled() {
  const raw = String(process.env.METRICS_ENABLED || "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function retentionDays() {
  const raw = Number(process.env.METRICS_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

function bucketStartUtcMs(tsMs) {
  const d = new Date(tsMs);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
}

function formatBucketUtc(tsMs) {
  const d = new Date(tsMs);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeTags(tags) {
  const input = tags && typeof tags === "object" ? tags : {};
  const out = {};
  const keys = Object.keys(input).sort();
  for (const key of keys) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

function tagsHash(tagsJson) {
  return crypto.createHash("sha256").update(tagsJson).digest("hex");
}

async function increment(metric, tags = {}, count = 1) {
  if (!metricsEnabled()) return false;
  if (!metric) return false;

  const normalized = normalizeTags(tags);
  const tagsJson = JSON.stringify(normalized);
  const hash = tagsHash(tagsJson);
  const bucketMs = bucketStartUtcMs(Date.now());
  const bucketTs = formatBucketUtc(bucketMs);
  const inc = Number.isFinite(count) ? count : 1;

  try {
    const db = getDb();
    await db.execute(
      `
      INSERT INTO metrics_counters (bucket_ts, metric, tags_hash, tags_json, count)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE count = count + VALUES(count)
      `,
      [bucketTs, String(metric), hash, tagsJson, inc]
    );
    return true;
  } catch (err) {
    logger.warn("metrics.increment.failed", {
      metric,
      error: logger.serializeError(err),
    });
    return false;
  }
}

function incrementExternalFetch(source, status) {
  return increment("external.fetch", { source, status });
}

function incrementSchedulerRun(name, status) {
  return increment("scheduler.run", { name, status });
}

async function cleanupOldCounters() {
  if (!metricsEnabled()) return false;
  const days = retentionDays();
  try {
    const db = getDb();
    await db.execute(
      `
      DELETE FROM metrics_counters
      WHERE bucket_ts < (UTC_TIMESTAMP() - INTERVAL ? DAY)
      `,
      [days]
    );
    return true;
  } catch (err) {
    logger.warn("metrics.cleanup.failed", {
      error: logger.serializeError(err),
    });
    return false;
  }
}

function scheduleMetricsCleanup({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!metricsEnabled()) return;
  void cleanupOldCounters();
  const timer = setInterval(() => {
    void cleanupOldCounters();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

export const metrics = { increment, incrementExternalFetch, incrementSchedulerRun };

export const __testables = {
  bucketStartUtcMs,
  formatBucketUtc,
  normalizeTags,
  tagsHash,
  metricsEnabled,
  retentionDays,
};

export { scheduleMetricsCleanup, cleanupOldCounters };
