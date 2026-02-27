#!/usr/bin/env node

/**
 * Compare TPPC rarity list snapshots and report newly added entries.
 *
 * Usage examples:
 *   node scripts/rarity_new_additions.js --lookback 7d
 *   node scripts/rarity_new_additions.js --lookback 14d
 *   node scripts/rarity_new_additions.js --since 2026-02-20
 *   node scripts/rarity_new_additions.js --from 2026-02-20 --to 2026-02-26T12:00:00Z
 *   node scripts/rarity_new_additions.js --since 2026-02-20 --json
 *
 * Notes:
 *   - Default behavior is "one point in time vs latest" (use --lookback/--since/--from).
 *   - Use --from and --to together to compare two explicit snapshots.
 */

import http from "node:http";
import https from "node:https";

const REPO_OWNER = "darknesspwnsu";
const REPO_NAME = "tppc-data";
const REPO_BRANCH = "main";
const REPO_FILE_PATH = "data/rarity.json";
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}`;

function usage(exitCode = 0) {
  const text = `
Usage:
  node scripts/rarity_new_additions.js --lookback <duration>
  node scripts/rarity_new_additions.js --since <datetime> [--to <datetime|latest>]
  node scripts/rarity_new_additions.js --from <datetime> [--to <datetime|latest>]

Modes:
  --lookback <duration>     Relative baseline (examples: 7d, 2w, 36h)
  --since <datetime>        Baseline point in time, defaults to diff against latest
  --from <datetime>         Alias of --since, useful with --to
  --to <datetime|latest>    Target point in time (default: latest)

Output:
  --json                    Print machine-readable JSON
  --with-removed            Also print entries removed between snapshots
  -h, --help                Show this help

Notes:
  - Datetimes are parsed by JavaScript Date(). Example formats:
      2026-02-20
      2026-02-20T11:00:00Z
      2026-02-20T07:00:00-05:00
`.trim();
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    lookback: null,
    since: null,
    from: null,
    to: "latest",
    json: false,
    withRemoved: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") usage(0);
    else if (arg === "--json") out.json = true;
    else if (arg === "--with-removed") out.withRemoved = true;
    else if (arg === "--lookback") out.lookback = argv[++i];
    else if (arg === "--since") out.since = argv[++i];
    else if (arg === "--from") out.from = argv[++i];
    else if (arg === "--to") out.to = argv[++i];
    else if (!arg.startsWith("-") && !out.lookback && !out.since && !out.from) out.lookback = arg;
    else usage(1);
  }

  const pointFlags = [out.lookback ? 1 : 0, out.since ? 1 : 0, out.from ? 1 : 0].reduce(
    (sum, v) => sum + v,
    0
  );
  if (pointFlags === 0) {
    console.error("Missing required baseline argument.");
    usage(1);
  }
  if (pointFlags > 1) {
    console.error("Use only one baseline mode: --lookback, --since, or --from.");
    usage(1);
  }
  if (out.to == null || out.to === "") {
    console.error("`--to` requires a value.");
    usage(1);
  }
  return out;
}

function parseLookbackDuration(input) {
  const m = String(input || "")
    .trim()
    .match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks)$/i);
  if (!m) {
    throw new Error(`Invalid duration: "${input}". Examples: 7d, 2w, 36h`);
  }
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();

  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  if (unit.startsWith("d")) return value * 24 * 60 * 60 * 1000;
  return value * 7 * 24 * 60 * 60 * 1000;
}

function parsePointInTime(input, label) {
  const s = String(input || "").trim();
  if (!s) {
    throw new Error(`Missing ${label} value.`);
  }
  if (s.toLowerCase() === "latest") return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label} datetime: "${input}"`);
  }
  return d;
}

function toIsoSafe(dateLike) {
  if (!dateLike) return "";
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function formatMaybeIso(dateLike) {
  const iso = toIsoSafe(dateLike);
  return iso || "unknown";
}

function buildGithubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tppc-faqbot-rarity-diff",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fetchText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { headers: opts.headers || {} }, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 400) {
        let errBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (errBody.length < 400) errBody += chunk;
        });
        res.on("end", () => reject(new Error(`HTTP ${status} for ${url}\n${errBody.slice(0, 400)}`)));
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

function commitListUrl(untilIso) {
  const params = new URLSearchParams({
    path: REPO_FILE_PATH,
    sha: REPO_BRANCH,
    per_page: "1",
  });
  if (untilIso) params.set("until", untilIso);
  return `${API_BASE}/commits?${params.toString()}`;
}

async function getCommitAtOrBefore(untilDateOrNull) {
  const untilIso = untilDateOrNull ? untilDateOrNull.toISOString() : null;
  const url = commitListUrl(untilIso);
  const commits = await fetchJson(url, { headers: buildGithubHeaders() });
  if (!Array.isArray(commits) || commits.length === 0) {
    if (untilIso) {
      throw new Error(`No commit found for ${REPO_FILE_PATH} at or before ${untilIso}`);
    }
    throw new Error(`No commits found for ${REPO_FILE_PATH}`);
  }

  const c = commits[0];
  return {
    sha: c.sha,
    commitDate: c?.commit?.author?.date || c?.commit?.committer?.date || null,
    htmlUrl: c.html_url || "",
  };
}

function rawSnapshotUrl(sha) {
  return `${RAW_BASE}/${sha}/${REPO_FILE_PATH}`;
}

function sortedNamesSet(json) {
  const data = json?.data || {};
  const names = Object.keys(data);
  names.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return names;
}

async function loadSnapshot(label, atDateOrNull) {
  const commit = await getCommitAtOrBefore(atDateOrNull);
  const rarityJson = await fetchJson(rawSnapshotUrl(commit.sha));
  const names = sortedNamesSet(rarityJson);
  return {
    label,
    requestedDate: atDateOrNull ? atDateOrNull.toISOString() : "latest",
    commitSha: commit.sha,
    commitDate: commit.commitDate,
    commitUrl: commit.htmlUrl,
    sourceUrl: rawSnapshotUrl(commit.sha),
    meta: rarityJson?.meta || null,
    names,
    nameSet: new Set(names),
  };
}

function diffNames(base, target) {
  const added = target.names.filter((name) => !base.nameSet.has(name));
  const removed = base.names.filter((name) => !target.nameSet.has(name));
  return { added, removed };
}

function printTextResult(base, target, delta, withRemoved) {
  console.log(`Baseline request: ${base.requestedDate}`);
  console.log(`Baseline commit:  ${base.commitSha} (${formatMaybeIso(base.commitDate)})`);
  if (base.commitUrl) console.log(`Baseline URL:     ${base.commitUrl}`);
  console.log(`Target request:   ${target.requestedDate}`);
  console.log(`Target commit:    ${target.commitSha} (${formatMaybeIso(target.commitDate)})`);
  if (target.commitUrl) console.log(`Target URL:       ${target.commitUrl}`);
  console.log("");
  console.log(`Baseline entries: ${base.names.length}`);
  console.log(`Target entries:   ${target.names.length}`);
  console.log(`Added entries:    ${delta.added.length}`);
  console.log(`Removed entries:  ${delta.removed.length}`);
  console.log("");
  if (delta.added.length === 0) {
    console.log("No newly added rarity entries in this window.");
  } else {
    console.log("New additions:");
    for (const name of delta.added) {
      console.log(`- ${name}`);
    }
  }
  if (withRemoved && delta.removed.length > 0) {
    console.log("");
    console.log("Removed entries:");
    for (const name of delta.removed) {
      console.log(`- ${name}`);
    }
  }
}

function buildJsonResult(base, target, delta) {
  return {
    base: {
      requestedDate: base.requestedDate,
      commitSha: base.commitSha,
      commitDate: toIsoSafe(base.commitDate),
      commitUrl: base.commitUrl,
      sourceUrl: base.sourceUrl,
      totalEntries: base.names.length,
    },
    target: {
      requestedDate: target.requestedDate,
      commitSha: target.commitSha,
      commitDate: toIsoSafe(target.commitDate),
      commitUrl: target.commitUrl,
      sourceUrl: target.sourceUrl,
      totalEntries: target.names.length,
    },
    diff: {
      addedCount: delta.added.length,
      removedCount: delta.removed.length,
      added: delta.added,
      removed: delta.removed,
    },
  };
}

function resolveTimeBounds(args) {
  const now = Date.now();
  let fromDate = null;
  let toDate = null;

  if (args.lookback) {
    const ms = parseLookbackDuration(args.lookback);
    fromDate = new Date(now - ms);
    toDate = args.to && String(args.to).toLowerCase() !== "latest" ? parsePointInTime(args.to, "--to") : null;
    return { fromDate, toDate };
  }

  if (args.since) {
    fromDate = parsePointInTime(args.since, "--since");
    toDate = args.to && String(args.to).toLowerCase() !== "latest" ? parsePointInTime(args.to, "--to") : null;
    return { fromDate, toDate };
  }

  fromDate = parsePointInTime(args.from, "--from");
  toDate = args.to && String(args.to).toLowerCase() !== "latest" ? parsePointInTime(args.to, "--to") : null;
  return { fromDate, toDate };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { fromDate, toDate } = resolveTimeBounds(args);

    const base = await loadSnapshot("from", fromDate);
    const target = await loadSnapshot("to", toDate);
    const delta = diffNames(base, target);

    if (args.json) {
      console.log(JSON.stringify(buildJsonResult(base, target, delta), null, 2));
      return;
    }
    printTextResult(base, target, delta, args.withRemoved);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}

await main();
