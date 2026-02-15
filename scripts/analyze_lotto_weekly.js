#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWithTimeout as fetchForumPage,
  computePageCountFromHtml,
  buildPageUrl,
  extractPostTables,
  extractPostMessageText,
  extractUsernameFromPostTable,
} from "../shared/forum_scrape.js";

const THREAD_URL = process.argv[2] || "https://forums.tppc.info/showthread.php?t=641631";
const OUTPUT_DIR = process.argv[3] || "analysis/lotto";
const FETCH_TIMEOUT_MS = 30_000;
const PAGE_DELAY_MS = 250;
const OP_USERNAME = "haunter";
const MIN_BOUNDARY_GAP_MS = 6 * 24 * 60 * 60 * 1000;
const BOUNDARY_CUE_RE =
  /\b(starts?\s+now|new week starts|next week starts|you may now guess again|try again|week\s+\d+\s+starts?)\b/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLottoNumbersFromText(text) {
  const matches = [...String(text || "").matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  if (matches.length !== 3) return null;
  const nums = matches.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
  if (nums.length !== 3) return null;
  if (new Set(nums).size !== 3) return null;
  return nums.slice().sort((a, b) => a - b);
}

function extractPostId(postHtml) {
  const m = /\bid\s*=\s*["']post(\d+)["']/.exec(postHtml);
  if (!m) return null;
  return Number(m[1]);
}

function extractUserId(postHtml) {
  const m = /member\.php[^"'<>]*\bu=(\d+)/i.exec(postHtml);
  if (!m) return null;
  return Number(m[1]);
}

function parsePostDateUtc(postHtml) {
  const m = /\b(\d{2})-(\d{2})-(\d{4}),\s+(\d{1,2}):(\d{2})\s*([AP]M)\b/i.exec(postHtml);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]) % 12;
  const minute = Number(m[5]);
  const ampm = String(m[6] || "").toUpperCase();
  if (ampm === "PM") hour += 12;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

function toDateKeyUtc(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isLikelyBoundaryCue(messageText) {
  return BOUNDARY_CUE_RE.test(String(messageText || ""));
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replaceAll('"', '""')}"`;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function ordinalSuffix(day) {
  const d = Number(day);
  const mod100 = d % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  const mod10 = d % 10;
  if (mod10 === 1) return "st";
  if (mod10 === 2) return "nd";
  if (mod10 === 3) return "rd";
  return "th";
}

function formatHumanDate(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map((n) => Number(n));
  if (!year || !month || !day) return String(dateKey || "");
  const dt = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const monthName = dt.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${day}${ordinalSuffix(day)} ${monthName}`;
}

function niceStep(maxValue, targetTicks = 6) {
  const rough = Math.max(1, maxValue) / Math.max(1, targetTicks);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  let niceFrac = 1;
  if (frac <= 1) niceFrac = 1;
  else if (frac <= 2) niceFrac = 2;
  else if (frac <= 5) niceFrac = 5;
  else niceFrac = 10;
  return niceFrac * pow;
}

function buildLineChartSvg({ points, title, subtitle }) {
  const width = 1400;
  const height = 800;
  const marginTop = 70;
  const marginRight = 40;
  const marginBottom = 180;
  const marginLeft = 90;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  const maxValue = Math.max(0, ...points.map((p) => p.entrant_count));
  const yStep = niceStep(maxValue, 6);
  const yTop = Math.max(yStep, Math.ceil(maxValue / yStep) * yStep);
  const avgEntrants = points.reduce((sum, p) => sum + Number(p.entrant_count || 0), 0) / Math.max(1, points.length);
  const avgWinRate = Math.max(0, Math.min(1, avgEntrants / 120));
  const n = points.length;
  const denom = Math.max(1, n - 1);

  const xFor = (index) => marginLeft + (index / denom) * plotWidth;
  const yFor = (value) => marginTop + (1 - value / yTop) * plotHeight;

  const yTicks = [];
  for (let y = 0; y <= yTop + 1e-9; y += yStep) yTicks.push(y);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(2)} ${yFor(p.entrant_count).toFixed(2)}`)
    .join(" ");

  const areaPath = [
    `M ${xFor(0).toFixed(2)} ${yFor(0).toFixed(2)}`,
    ...points.map((p, i) => `L ${xFor(i).toFixed(2)} ${yFor(p.entrant_count).toFixed(2)}`),
    `L ${xFor(n - 1).toFixed(2)} ${yFor(0).toFixed(2)}`,
    "Z",
  ].join(" ");
  const avgLineY = yFor(avgEntrants).toFixed(2);

  const gridLines = yTicks
    .map((tick) => {
      const y = yFor(tick).toFixed(2);
      return `<line x1="${marginLeft}" y1="${y}" x2="${marginLeft + plotWidth}" y2="${y}" stroke="#e6ecf3" stroke-width="1" />`;
    })
    .join("\n");

  const yLabels = yTicks
    .map((tick) => {
      const y = yFor(tick).toFixed(2);
      return `<text x="${marginLeft - 12}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="13" fill="#334155">${tick}</text>`;
    })
    .join("\n");

  const xTicksAndLabels = points
    .map((p, i) => {
      const x = xFor(i).toFixed(2);
      const y = marginTop + plotHeight;
      const human = formatHumanDate(p.week_start);
      return [
        `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + 6}" stroke="#7b8aa0" stroke-width="1" />`,
        `<text x="${x}" y="${y + 24}" text-anchor="end" font-size="11" fill="#334155" transform="rotate(-35 ${x} ${y + 24})">${xmlEscape(human)}</text>`,
      ].join("\n");
    })
    .join("\n");

  const dots = points
    .map((p, i) => {
      const x = xFor(i).toFixed(2);
      const y = yFor(p.entrant_count).toFixed(2);
      return `<circle cx="${x}" cy="${y}" r="3.2" fill="#0f766e" />`;
    })
    .join("\n");

  const pointDateLabels = points
    .map((p, i) => {
      const x = xFor(i).toFixed(2);
      const baseY = yFor(p.entrant_count);
      const y = (baseY - (i % 2 === 0 ? 10 : 20)).toFixed(2);
      const label = formatHumanDate(p.week_start);
      return `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="#0f172a">${xmlEscape(label)}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc" />
  <text x="${marginLeft}" y="34" font-size="28" font-family="Arial, Helvetica, sans-serif" fill="#0f172a">${xmlEscape(title)}</text>
  <text x="${marginLeft}" y="56" font-size="14" font-family="Arial, Helvetica, sans-serif" fill="#475569">${xmlEscape(subtitle)}</text>

  ${gridLines}
  <line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + plotHeight}" stroke="#334155" stroke-width="1.5" />
  <line x1="${marginLeft}" y1="${marginTop + plotHeight}" x2="${marginLeft + plotWidth}" y2="${marginTop + plotHeight}" stroke="#334155" stroke-width="1.5" />

  ${yLabels}
  ${xTicksAndLabels}

  <path d="${areaPath}" fill="#99f6e4" opacity="0.35" />
  <path d="${path}" fill="none" stroke="#0f766e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
  ${pointDateLabels}
  ${dots}
  <line x1="${marginLeft}" y1="${avgLineY}" x2="${marginLeft + plotWidth}" y2="${avgLineY}" stroke="#b45309" stroke-width="2" stroke-dasharray="8 6" />
  <text x="${marginLeft + plotWidth - 8}" y="${Number(avgLineY) - 8}" text-anchor="end" font-size="12" fill="#92400e">Avg entrants: ${avgEntrants.toFixed(1)}</text>

  <rect x="${marginLeft + plotWidth - 290}" y="${marginTop + 12}" width="270" height="72" rx="10" ry="10" fill="#ffffff" stroke="#cbd5e1" />
  <text x="${marginLeft + plotWidth - 275}" y="${marginTop + 38}" font-size="14" fill="#0f172a" font-weight="bold">Stats</text>
  <text x="${marginLeft + plotWidth - 275}" y="${marginTop + 56}" font-size="13" fill="#334155">Average entrants: ${avgEntrants.toFixed(1)}</text>
  <text x="${marginLeft + plotWidth - 275}" y="${marginTop + 74}" font-size="13" fill="#334155">Average win rate: ${(avgWinRate * 100).toFixed(1)}%</text>

  <text x="${marginLeft + plotWidth / 2}" y="${height - 20}" text-anchor="middle" font-size="13" fill="#334155">Lotto week start (OP boundary post date)</text>
  <text x="24" y="${marginTop + plotHeight / 2}" text-anchor="middle" font-size="13" fill="#334155" transform="rotate(-90 24 ${marginTop + plotHeight / 2})">Unique entrants</text>
</svg>
`;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = path.resolve(rootDir, OUTPUT_DIR);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Fetching page 1: ${THREAD_URL}`);
  const page1Html = await fetchForumPage(THREAD_URL, { timeoutMs: FETCH_TIMEOUT_MS, metricsKey: "lotto_analysis" });
  const pageCount = computePageCountFromHtml(page1Html);
  console.log(`Detected ${pageCount} thread pages.`);

  const pages = [{ page: 1, html: page1Html }];
  for (let page = 2; page <= pageCount; page += 1) {
    await sleep(PAGE_DELAY_MS);
    const url = buildPageUrl(THREAD_URL, page);
    console.log(`Fetching page ${page}/${pageCount}`);
    const html = await fetchForumPage(url, { timeoutMs: FETCH_TIMEOUT_MS, metricsKey: "lotto_analysis" });
    pages.push({ page, html });
  }

  const allPosts = [];
  for (const { page, html } of pages) {
    const posts = extractPostTables(html);
    for (const postHtml of posts) {
      const dateUtc = parsePostDateUtc(postHtml);
      if (!dateUtc) continue;
      const message = extractPostMessageText(postHtml);
      const combo = parseLottoNumbersFromText(message);
      const username = extractUsernameFromPostTable(postHtml) || "Unknown";
      const userId = extractUserId(postHtml);
      const postId = extractPostId(postHtml);
      const entrantKey = userId ? `u:${userId}` : `n:${normalizeName(username)}`;

      allPosts.push({
        page,
        post_id: postId,
        date_ms: dateUtc.getTime(),
        post_datetime_utc: dateUtc.toISOString(),
        post_date_utc: toDateKeyUtc(dateUtc),
        user_id: userId ?? "",
        username,
        username_norm: normalizeName(username),
        entrant_key: entrantKey,
        message,
        combo: combo ? combo.join("-") : "",
      });
    }
  }

  allPosts.sort((a, b) => {
    if (a.date_ms !== b.date_ms) return a.date_ms - b.date_ms;
    return Number(a.post_id || 0) - Number(b.post_id || 0);
  });

  const opPosts = allPosts.filter((p) => p.username_norm === OP_USERNAME);
  if (!opPosts.length) {
    throw new Error(`Could not find OP posts for username "${OP_USERNAME}"`);
  }

  const boundaryPosts = [opPosts[0]];
  for (const opPost of opPosts.slice(1)) {
    const lastBoundary = boundaryPosts[boundaryPosts.length - 1];
    const gapMs = opPost.date_ms - lastBoundary.date_ms;
    const dayOfWeek = new Date(opPost.date_ms).getUTCDay(); // Sunday=0
    const sundayOrMonday = dayOfWeek === 0 || dayOfWeek === 1;
    const cueMatch = isLikelyBoundaryCue(opPost.message);
    if (gapMs >= MIN_BOUNDARY_GAP_MS && (sundayOrMonday || cueMatch)) {
      boundaryPosts.push(opPost);
    }
  }

  if (!boundaryPosts.length) {
    throw new Error("No lotto week boundaries could be derived from OP posts.");
  }

  console.log(`Detected ${boundaryPosts.length} lotto week boundaries.`);

  const validEntries = allPosts.filter((p) => p.combo);
  if (!validEntries.length) {
    throw new Error("No valid lotto entries were found in the thread.");
  }

  const assignedEntries = [];
  let boundaryIdx = 0;
  for (const entry of validEntries) {
    while (
      boundaryIdx + 1 < boundaryPosts.length &&
      entry.date_ms >= boundaryPosts[boundaryIdx + 1].date_ms
    ) {
      boundaryIdx += 1;
    }
    const boundary = boundaryPosts[boundaryIdx];
    if (!boundary || entry.date_ms < boundary.date_ms) continue;

    const nextBoundary = boundaryPosts[boundaryIdx + 1] || null;
    const weekNumber = boundaryIdx + 1;

    assignedEntries.push({
      ...entry,
      week_number: weekNumber,
      week_start: boundary.post_date_utc,
      week_start_utc: boundary.post_datetime_utc,
      week_boundary_post_id: boundary.post_id ?? "",
      week_end_exclusive_utc: nextBoundary ? nextBoundary.post_datetime_utc : "",
    });
  }

  const weeklyRollup = boundaryPosts.map((boundary, idx) => {
    const nextBoundary = boundaryPosts[idx + 1] || null;
    return {
      week_number: idx + 1,
      week_start: boundary.post_date_utc,
      week_start_utc: boundary.post_datetime_utc,
      week_end_exclusive_utc: nextBoundary ? nextBoundary.post_datetime_utc : "",
      week_boundary_post_id: boundary.post_id ?? "",
      entrants: new Set(),
      valid_entry_posts: 0,
    };
  });

  for (const entry of assignedEntries) {
    const bucket = weeklyRollup[entry.week_number - 1];
    if (!bucket) continue;
    bucket.valid_entry_posts += 1;
    bucket.entrants.add(entry.entrant_key);
  }

  const weeklySeries = weeklyRollup.map((row) => ({
    week_number: row.week_number,
    week_start: row.week_start,
    week_start_utc: row.week_start_utc,
    week_end_exclusive_utc: row.week_end_exclusive_utc,
    week_boundary_post_id: row.week_boundary_post_id,
    entrant_count: row.entrants.size,
    valid_entry_posts: row.valid_entry_posts,
  }));

  const boundaryCsvLines = [
    "week_number,boundary_post_id,boundary_post_datetime_utc,boundary_post_date_utc,boundary_username",
  ];
  for (const row of weeklySeries) {
    boundaryCsvLines.push(
      [
        row.week_number,
        row.week_boundary_post_id,
        row.week_start_utc,
        row.week_start,
        OP_USERNAME,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const weeklyCsvLines = [
    "week_number,week_start,week_start_utc,week_end_exclusive_utc,boundary_post_id,entrant_count,valid_entry_posts",
  ];
  for (const row of weeklySeries) {
    weeklyCsvLines.push(
      [
        row.week_number,
        row.week_start,
        row.week_start_utc,
        row.week_end_exclusive_utc,
        row.week_boundary_post_id,
        row.entrant_count,
        row.valid_entry_posts,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const entriesCsvLines = [
    "post_id,page,post_datetime_utc,post_date_utc,user_id,username,combo,week_number,week_start,week_start_utc,week_end_exclusive_utc,boundary_post_id",
  ];
  for (const row of assignedEntries) {
    entriesCsvLines.push(
      [
        row.post_id ?? "",
        row.page,
        row.post_datetime_utc,
        row.post_date_utc,
        row.user_id,
        row.username,
        row.combo,
        row.week_number,
        row.week_start,
        row.week_start_utc,
        row.week_end_exclusive_utc,
        row.week_boundary_post_id,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const svg = buildLineChartSvg({
    points: weeklySeries,
    title: "TPPC Lottery Entrants Per Week",
    subtitle: `${weeklySeries[0].week_start} to ${weeklySeries[weeklySeries.length - 1].week_start} | ${assignedEntries.length} valid entry posts`,
  });

  const boundaryCsvPath = path.join(outDir, "week_boundaries.csv");
  const weeklyCsvPath = path.join(outDir, "weekly_entrants.csv");
  const entriesCsvPath = path.join(outDir, "valid_entries_raw.csv");
  const svgPath = path.join(outDir, "weekly_entrants_line.svg");
  const summaryJsonPath = path.join(outDir, "summary.json");

  await fs.writeFile(boundaryCsvPath, `${boundaryCsvLines.join("\n")}\n`, "utf8");
  await fs.writeFile(weeklyCsvPath, `${weeklyCsvLines.join("\n")}\n`, "utf8");
  await fs.writeFile(entriesCsvPath, `${entriesCsvLines.join("\n")}\n`, "utf8");
  await fs.writeFile(svgPath, svg, "utf8");

  const totals = weeklySeries.reduce(
    (acc, row) => {
      acc.max_weekly_entrants = Math.max(acc.max_weekly_entrants, row.entrant_count);
      acc.total_unique_week_slots += row.entrant_count;
      acc.total_valid_posts += row.valid_entry_posts;
      return acc;
    },
    { max_weekly_entrants: 0, total_unique_week_slots: 0, total_valid_posts: 0 }
  );

  const summary = {
    thread_url: THREAD_URL,
    pages_scraped: pageCount,
    weeks_covered: weeklySeries.length,
    boundary_detection: {
      op_username: OP_USERNAME,
      min_gap_days: MIN_BOUNDARY_GAP_MS / (24 * 60 * 60 * 1000),
      cue_pattern: String(BOUNDARY_CUE_RE),
    },
    first_week_start: weeklySeries[0].week_start,
    last_week_start: weeklySeries[weeklySeries.length - 1].week_start,
    max_weekly_entrants: totals.max_weekly_entrants,
    total_unique_week_slots: totals.total_unique_week_slots,
    total_valid_entry_posts: totals.total_valid_posts,
    outputs: {
      boundaries_csv: boundaryCsvPath,
      weekly_csv: weeklyCsvPath,
      valid_entries_csv: entriesCsvPath,
      chart_svg: svgPath,
    },
  };
  await fs.writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log("Done.");
  console.log(`Boundary CSV: ${boundaryCsvPath}`);
  console.log(`Weekly CSV: ${weeklyCsvPath}`);
  console.log(`Raw entries CSV: ${entriesCsvPath}`);
  console.log(`Chart SVG: ${svgPath}`);
  console.log(`Summary: ${summaryJsonPath}`);
}

main().catch((err) => {
  console.error("lotto analysis failed:", err?.stack || err?.message || err);
  process.exitCode = 1;
});
