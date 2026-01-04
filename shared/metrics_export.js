// shared/metrics_export.js
// Export metrics snapshots and publish to a GitHub Pages repo.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "../db.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_BRANCH = "gh-pages";
const DEFAULT_EXPORT_DIR = ".metrics_export";
const DEFAULT_EXPORT_PATH = "metrics/all.json";

let exportSchedulerBooted = false;
let warnedMissingConfig = false;
let exportInFlight = null;

function exportConfig() {
  return {
    token: String(process.env.METRICS_EXPORT_TOKEN || "").trim(),
    repo: String(process.env.METRICS_EXPORT_REPO || "").trim(),
    branch: String(process.env.METRICS_EXPORT_BRANCH || "").trim() || DEFAULT_BRANCH,
    exportDir: String(process.env.METRICS_EXPORT_DIR || "").trim() || DEFAULT_EXPORT_DIR,
    exportPath: String(process.env.METRICS_EXPORT_PATH || "").trim() || DEFAULT_EXPORT_PATH,
    windowDays: Number(process.env.METRICS_EXPORT_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS,
    gitName: String(process.env.METRICS_EXPORT_GIT_NAME || "").trim() || "spectreon-bot",
    gitEmail:
      String(process.env.METRICS_EXPORT_GIT_EMAIL || "").trim() || "spectreon-bot@users.noreply.github.com",
  };
}

function isExportConfigured(cfg) {
  return Boolean(cfg.repo && cfg.token);
}

function buildAuthedRepoUrl(repo, token) {
  if (!repo || !token) return repo;
  if (repo.includes("@")) return repo; // already authed
  return repo.replace("https://", `https://x-access-token:${token}@`);
}

function scrubRepoUrl(repo) {
  if (!repo) return repo;
  return repo.replace(/x-access-token:[^@]+@/i, "x-access-token:***@");
}

async function runGit(args, { cwd, repoLabel } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { ok: true, stdout: stdout?.trim?.() || "", stderr: stderr?.trim?.() || "" };
  } catch (err) {
    logger.warn("metrics.export.git.failed", {
      repo: repoLabel,
      args: args.join(" "),
      error: logger.serializeError(err),
    });
    return { ok: false, error: err };
  }
}

async function ensureExportRepo(cfg) {
  const exportDir = path.resolve(cfg.exportDir);
  const repoLabel = scrubRepoUrl(cfg.repo);

  try {
    const stat = await fs.stat(exportDir);
    if (!stat.isDirectory()) {
      throw new Error("export dir is not a directory");
    }
    await fs.stat(path.join(exportDir, ".git"));
  } catch {
    const authed = buildAuthedRepoUrl(cfg.repo, cfg.token);
    const cloneArgs = ["clone", "--depth", "1", authed, exportDir];
    const clone = await runGit(cloneArgs, { repoLabel });
    if (!clone.ok) return { ok: false, reason: "clone_failed" };
  }

  await runGit(["config", "user.name", cfg.gitName], { cwd: exportDir, repoLabel });
  await runGit(["config", "user.email", cfg.gitEmail], { cwd: exportDir, repoLabel });

  const status = await runGit(["status", "--porcelain"], { cwd: exportDir, repoLabel });
  if (!status.ok) return { ok: false, reason: "status_failed" };
  if (status.stdout) {
    logger.warn("metrics.export.repo.dirty", { repo: repoLabel });
    return { ok: false, reason: "dirty_repo" };
  }

  const fetched = await runGit(["fetch", "origin", cfg.branch], { cwd: exportDir, repoLabel });
  if (!fetched.ok) return { ok: false, reason: "fetch_failed" };

  const remoteRef = `refs/remotes/origin/${cfg.branch}`;
  const remoteExists = await runGit(["show-ref", "--verify", remoteRef], { cwd: exportDir, repoLabel });

  if (remoteExists.ok) {
    const checkout = await runGit(["checkout", "-B", cfg.branch, `origin/${cfg.branch}`], {
      cwd: exportDir,
      repoLabel,
    });
    if (!checkout.ok) return { ok: false, reason: "checkout_failed" };
    await runGit(["pull", "--ff-only", "origin", cfg.branch], { cwd: exportDir, repoLabel });
  } else {
    const localRef = `refs/heads/${cfg.branch}`;
    const localExists = await runGit(["show-ref", "--verify", localRef], { cwd: exportDir, repoLabel });
    if (localExists.ok) {
      const checkout = await runGit(["checkout", cfg.branch], { cwd: exportDir, repoLabel });
      if (!checkout.ok) return { ok: false, reason: "checkout_failed" };
    } else {
      const orphan = await runGit(["checkout", "--orphan", cfg.branch], { cwd: exportDir, repoLabel });
      if (!orphan.ok) return { ok: false, reason: "checkout_failed" };
      await runGit(["rm", "-rf", "."], { cwd: exportDir, repoLabel });
    }
  }

  return { ok: true, dir: exportDir };
}

function parseBucketTs(bucketTs) {
  const raw = String(bucketTs || "").trim();
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  return new Date(`${iso}Z`).getTime();
}

function parseTags(tagsJson) {
  if (!tagsJson) return {};
  try {
    const parsed = JSON.parse(tagsJson);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isErrorMetric(metric, tags) {
  const status = String(tags?.status || "").toLowerCase();
  if (metric === "dm.fail") return true;
  if (metric === "command.invoked" && status === "error") return true;
  if (metric === "external.fetch" && status === "error") return true;
  if (metric === "scheduler.run" && status === "error") return true;
  if (metric.endsWith(".refresh") && status === "error") return true;
  if (metric.endsWith(".fetch") && status === "error") return true;
  if (metric.endsWith(".trigger") && status === "error") return true;
  return false;
}

function accumulate(map, key, count) {
  if (!key) return;
  const next = (map.get(key) || 0) + count;
  map.set(key, next);
}

function sortedTop(map, limit = 5, mapper = (key, count) => ({ key, count })) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => mapper(key, count));
}

function buildMetricsSnapshot(rows, { nowMs = Date.now(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const last24Start = nowMs - 24 * 60 * 60 * 1000;
  const last7Start = nowMs - 7 * 24 * 60 * 60 * 1000;

  const totals24 = new Map();
  const totals7 = new Map();
  const topCommands = new Map();
  const topErrors = new Map();
  const series = new Map();

  for (const row of rows || []) {
    const tsMs = parseBucketTs(row.bucket_ts);
    if (!Number.isFinite(tsMs)) continue;
    const metric = String(row.metric || "");
    if (!metric) continue;
    const count = Number(row.count) || 0;
    const tags = parseTags(row.tags_json);

    const tsIso = new Date(tsMs).toISOString();
    if (!series.has(metric)) series.set(metric, []);
    series.get(metric).push({ ts: tsIso, count, tags });

    if (tsMs >= last24Start) {
      accumulate(totals24, metric, count);
      if (metric === "command.invoked" && String(tags.status || "").toLowerCase() === "ok") {
        accumulate(topCommands, String(tags.cmd || ""), count);
      }
      if (isErrorMetric(metric, tags)) {
        const key = `${metric}|${JSON.stringify(tags)}`;
        accumulate(topErrors, key, count);
      }
    }

    if (tsMs >= last7Start) {
      accumulate(totals7, metric, count);
    }
  }

  const overview = {
    last_24h: Object.fromEntries(totals24),
    last_7d: Object.fromEntries(totals7),
    top_commands_24h: sortedTop(topCommands, 5, (cmd, count) => ({ cmd, count })),
    top_errors_24h: sortedTop(topErrors, 5, (key, count) => {
      const split = key.split("|");
      const metric = split[0];
      const tags = parseTags(split.slice(1).join("|"));
      return { metric, tags, count };
    }),
  };

  const timeseries = {};
  for (const [metric, points] of series.entries()) {
    timeseries[metric] = points;
  }

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const rangeStart = new Date(nowMs - windowMs).toISOString();

  return {
    meta: {
      generated_at: new Date(nowMs).toISOString(),
      bucket: "hour",
      window_days: windowDays,
      range: { start: rangeStart, end: new Date(nowMs).toISOString() },
    },
    overview,
    timeseries,
  };
}

async function fetchMetricsRows(windowDays) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT bucket_ts, metric, tags_json, count
    FROM metrics_counters
    WHERE bucket_ts >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
    ORDER BY bucket_ts ASC
    `,
    [windowDays]
  );
  return rows || [];
}

async function writeSnapshotFile({ dir, filePath, snapshot }) {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(snapshot, null, 2));
  return fullPath;
}

async function commitAndPush({ dir, branch, filePath, repoLabel }) {
  const status = await runGit(["status", "--porcelain"], { cwd: dir, repoLabel });
  if (!status.ok) return { ok: false, reason: "status_failed" };
  if (!status.stdout) return { ok: true, reason: "no_changes" };

  await runGit(["add", filePath], { cwd: dir, repoLabel });
  const msg = `Update metrics snapshot (${new Date().toISOString()})`;
  const commit = await runGit(["commit", "-m", msg], { cwd: dir, repoLabel });
  if (!commit.ok) return { ok: false, reason: "commit_failed" };

  const push = await runGit(["push", "origin", branch], { cwd: dir, repoLabel });
  if (!push.ok) return { ok: false, reason: "push_failed" };

  return { ok: true };
}

export async function exportMetricsSnapshot({ reason = "scheduled" } = {}) {
  if (exportInFlight) return { ok: false, reason: "in_flight" };
  const cfg = exportConfig();
  const repoLabel = scrubRepoUrl(cfg.repo);

  if (!isExportConfigured(cfg)) {
    if (!warnedMissingConfig) {
      logger.warn("metrics.export.missing_config", { repo: repoLabel });
      warnedMissingConfig = true;
    }
    return { ok: false, reason: "missing_config" };
  }

  exportInFlight = (async () => {
    try {
      const repo = await ensureExportRepo(cfg);
      if (!repo.ok) return { ok: false, reason: repo.reason };

      const rows = await fetchMetricsRows(cfg.windowDays);
      const snapshot = buildMetricsSnapshot(rows, { windowDays: cfg.windowDays });
      const fullPath = await writeSnapshotFile({ dir: repo.dir, filePath: cfg.exportPath, snapshot });

      const relPath = path.relative(repo.dir, fullPath) || cfg.exportPath;
      const pushed = await commitAndPush({
        dir: repo.dir,
        branch: cfg.branch,
        filePath: relPath,
        repoLabel,
      });
      if (!pushed.ok) {
        logger.warn("metrics.export.push_failed", { reason: pushed.reason, repo: repoLabel });
        return { ok: false, reason: pushed.reason };
      }

      logger.info("metrics.export.ok", { reason, repo: repoLabel });
      return { ok: true, reason: "ok" };
    } catch (err) {
      logger.error("metrics.export.failed", { reason, repo: repoLabel, error: logger.serializeError(err) });
      return { ok: false, reason: "error" };
    } finally {
      exportInFlight = null;
    }
  })();

  return exportInFlight;
}

function msUntilNextHour(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  const next = d.getTime() + 60 * 60 * 1000;
  return Math.max(0, next - nowMs);
}

export function scheduleMetricsExport() {
  if (exportSchedulerBooted) return;
  exportSchedulerBooted = true;

  const delay = msUntilNextHour();
  setTimeout(() => {
    void exportMetricsSnapshot({ reason: "scheduled" });
    const timer = setInterval(() => {
      void exportMetricsSnapshot({ reason: "scheduled" });
    }, 60 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }, delay);
}

export const __testables = {
  buildMetricsSnapshot,
  parseBucketTs,
  parseTags,
  isErrorMetric,
  msUntilNextHour,
};
