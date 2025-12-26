// rarity.js
//
// !rarity <pokemon> — shows rarity counts from a preprocessed JSON.
// Data source is your GitHub Pages JSON that is refreshed daily by GitHub Actions.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

let rarity = null;      // { lowerName: entry }
let rarityNorm = null;  // { normalizedKey: entry }
let meta = null;

// ✅ Default to your live, auto-refreshed GitHub Pages JSON:
const DEFAULT_URL = "https://darknesspwnsu.github.io/tppc-data/data/rarity.json";

const FILE = process.env.RARITY_JSON_FILE || "data/rarity.json";
const URL = process.env.RARITY_JSON_URL || DEFAULT_URL;
const DAILY_REFRESH_ET = process.env.RARITY_DAILY_REFRESH_ET || "07:10";

// How often the bot checks for updates (keep modest; 5–10 min is perfect)
const REFRESH_MS = Number(process.env.RARITY_REFRESH_MS ?? 10 * 60_000);

// Suggestion tuning (env override)
const SUGGEST_MIN_SCORE = Number(process.env.RARITY_SUGGEST_MIN_SCORE ?? 0.55);
const SUGGEST_MAX_LEN_DIFF = Number(process.env.RARITY_SUGGEST_MAX_LEN_DIFF ?? 12);
const RARITY_GUILD_ALLOWLIST = (process.env.RARITY_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RARITY_ENABLED_ANYWHERE = RARITY_GUILD_ALLOWLIST.length > 0;

function isGuildAllowed(message) {
  // If no allowlist is set, treat it as disabled.
  if (!RARITY_ENABLED_ANYWHERE) return false;

  // Don’t respond in DMs for rarity (you can change this if you want)
  const gid = message?.guild?.id;
  if (!gid) return false;

  return RARITY_GUILD_ALLOWLIST.includes(gid);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }

      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
  });
}

function parseLastUpdatedTextEastern(text) {
  // Accept:
  // "MM-DD-YYYY HH:mm"
  // "MM-DD-YYYY HH:mm EST"
  // "MM-DD-YYYY HH:mm EDT"
  if (!text) return null;

  const s = String(text).trim();

  const m = s.match(
    /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?:\s+(EST|EDT))?$/i
  );
  if (!m) return null;

  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(m[4]);
  const min = Number(m[5]);
  const tz = (m[6] || "EST").toUpperCase(); // default to EST if missing

  if (
    !Number.isFinite(mm) || mm < 1 || mm > 12 ||
    !Number.isFinite(dd) || dd < 1 || dd > 31 ||
    !Number.isFinite(yyyy) ||
    !Number.isFinite(hh) || hh < 0 || hh > 23 ||
    !Number.isFinite(min) || min < 0 || min > 59
  ) return null;

  // Convert Eastern -> UTC by offset.
  // EST = UTC-5, EDT = UTC-4
  const offsetHours = tz === "EDT" ? 4 : 5;

  const utcMs = Date.UTC(yyyy, mm - 1, dd, hh + offsetHours, min, 0);
  return new Date(utcMs);
}

function formatDurationAgo(fromMs, nowMs = Date.now()) {
  let diff = Math.max(0, Math.floor((nowMs - fromMs) / 1000));

  const days = Math.floor(diff / 86400);
  diff %= 86400;

  const hours = Math.floor(diff / 3600);
  diff %= 3600;

  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;

  const parts = [];

  if (days) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);

  // ALWAYS include seconds
  parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts.join(" and ");
  return parts.slice(0, -1).join(", ") + " and " + parts.at(-1);
}

function stripDiacritics(s) {
  // NFKD splits letters + accents; remove accent marks.
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeKey(s) {
  // Lowercase, remove diacritics, drop all non-alphanumerics.
  // "Flabébé" -> "flabebe", "Shiny Gourgeist (Large)" -> "shinygourgeistlarge"
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeQueryVariants(qRaw) {
  // Returns normalized lookup keys to try (in priority order).
  const raw = String(qRaw ?? "").trim();
  if (!raw) return [];

  const q = raw.toLowerCase().trim();
  const candidates = new Set([normalizeKey(q)]);

  // Accept s.charmander / d.charmander / g.charmander
  const mDot = q.match(/^([sdg])\.(.+)$/);
  if (mDot) {
    const letter = mDot[1];
    const rest = mDot[2].trim();
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
  }

  const parts = q.split(/\s+/).filter(Boolean);

  // Accept "s charmander" / "d charmander" / "g charmander"
  if (parts.length >= 2 && ["s", "d", "g"].includes(parts[0])) {
    const letter = parts[0];
    const rest = parts.slice(1).join(" ");
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
  }

  // Accept "shiny charmander" / "dark charmander" / "golden charmander"
  if (parts.length >= 2 && ["shiny", "dark", "golden"].includes(parts[0])) {
    candidates.add(normalizeKey(parts.join(" ")));
  }

  return Array.from(candidates);
}

function queryVariantPrefix(qRaw) {
  const q = String(qRaw ?? "").trim().toLowerCase();

  if (q.startsWith("shiny") || q.startsWith("s.") || q.startsWith("s ")) return "shiny";
  if (q.startsWith("dark") || q.startsWith("d.") || q.startsWith("d ")) return "dark";
  if (q.startsWith("golden") || q.startsWith("g.") || q.startsWith("g ")) return "golden";

  return "";
}

function buildIndex(json) {
  meta = json.meta || null;

  const out = {};
  const outNorm = {};
  const data = json.data || {};

  for (const [k, v] of Object.entries(data)) {
    const entry = { name: k, ...v };
    out[String(k).toLowerCase()] = entry;
    outNorm[normalizeKey(k)] = entry;
  }

  rarity = out;
  rarityNorm = outNorm;
}

function bigrams(s) {
  s = String(s);
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function diceCoeff(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const A = bigrams(a);
  const B = bigrams(b);

  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;

  for (const v of A.values()) sizeA += v;
  for (const v of B.values()) sizeB += v;

  for (const [g, av] of A.entries()) {
    const bv = B.get(g);
    if (bv) inter += Math.min(av, bv);
  }

  return (2 * inter) / (sizeA + sizeB);
}

function getSuggestions(queryRaw, limit = 5) {
  if (!rarityNorm) return [];
  const q = normalizeKey(queryRaw);
  if (!q) return [];

  const pref = queryVariantPrefix(queryRaw); // "" | "shiny" | "dark" | "golden"

  const scored = [];
  for (const [nk, entry] of Object.entries(rarityNorm)) {
    // If user clearly asked for Golden/Dark/Shiny, keep suggestions in that bucket.
    if (pref) {
      if (!nk.startsWith(pref)) continue;
    } else {
      // No variant requested: keep suggestions to BASE only
      // (i.e., exclude Shiny*, Dark*, Golden* entries)
      if (nk.startsWith("shiny") || nk.startsWith("dark") || nk.startsWith("golden")) {
        continue;
      }
    }

    // Guardrail: avoid far-off matches with wildly different lengths.
    if (Math.abs(nk.length - q.length) > SUGGEST_MAX_LEN_DIFF) continue;

    const score = diceCoeff(q, nk);
    if (score >= SUGGEST_MIN_SCORE) scored.push([score, entry.name]);
  }

  scored.sort((a, b) => b[0] - a[0]);

  const seen = new Set();
  const out = [];
  for (const [, name] of scored) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

async function loadFromUrl() {
  const raw = await fetchText(URL);
  const json = JSON.parse(raw);
  buildIndex(json);
  console.log(`[RARITY] Loaded ${Object.keys(rarity).length} entries from URL`);
}

function loadFromFile() {
  const raw = fs.readFileSync(path.resolve(FILE), "utf8");
  const json = JSON.parse(raw);
  buildIndex(json);
  console.log(`[RARITY] Loaded ${Object.keys(rarity).length} entries from file`);
}

async function refresh() {
  try {
    if (URL) await loadFromUrl();
    else loadFromFile();
  } catch (e) {
    console.warn("[RARITY] Refresh failed:", e?.message ?? e);
    // Keep last-known-good cache in memory
  }
}

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("en-US") : "0";
}

function parseHHMM(hhmm) {
  const m = String(hhmm).trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return { hour: 7, minute: 10 }; // fallback
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// Computes the next occurrence of HH:MM in America/New_York as a real Date() timestamp.
// Uses Intl timeZone conversion so DST is handled correctly by the runtime.
function nextRunInEastern(hhmm) {
  const { hour, minute } = parseHHMM(hhmm);
  const tz = "America/New_York";

  const now = new Date();

  // Get today's date parts in Eastern
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type)?.value;
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const d = Number(get("day"));

  // Create a Date for today's target time *as Eastern*, by formatting a UTC guess and adjusting.
  // Approach: build a UTC Date for y/mo/d hour:minute, then interpret it in Eastern and correct.
  const candidateUtc = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));

  // If candidate is already past in Eastern time, schedule for tomorrow (Eastern calendar day).
  const nowInET = new Date(new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now));
  const candInET = new Date(new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(candidateUtc));

  let runUtc = candidateUtc;
  if (candInET <= nowInET) {
    runUtc = new Date(Date.UTC(y, mo - 1, d + 1, hour, minute, 0));
  }
  return runUtc;
}

function scheduleDailyRefresh(refreshFn) {
  const runAt = nextRunInEastern(DAILY_REFRESH_ET);
  let delay = runAt.getTime() - Date.now();
  if (!Number.isFinite(delay) || delay < 0) delay = 60_000;

  console.log(`[RARITY] Next daily refresh scheduled for ET ${DAILY_REFRESH_ET} (in ${Math.round(delay / 1000)}s)`);

  setTimeout(async function tick() {
    await refreshFn();

    // Schedule the next day
    const next = nextRunInEastern(DAILY_REFRESH_ET);
    let nextDelay = next.getTime() - Date.now();
    if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 24 * 60 * 60_000;

    console.log(`[RARITY] Next daily refresh scheduled for ET ${DAILY_REFRESH_ET} (in ${Math.round(nextDelay / 1000)}s)`);
    setTimeout(tick, nextDelay);
  }, delay);
}

export function registerRarity(register) {
  refresh(); // load once at startup
  scheduleDailyRefresh(refresh); // then refresh once per day around ET update time

  register(
    "?rarity",
    async ({ message, rest }) => {
      if (!isGuildAllowed(message)) return;

      const qRaw = String(rest ?? "").trim();
      if (!qRaw) return;

      let r = rarity?.[qRaw.toLowerCase()];

      if (!r) {
        const tries = normalizeQueryVariants(qRaw);
        for (const t of tries) {
          r = rarityNorm?.[t];
          if (r) break;
        }
      }

      if (!r) {
        const suggestions = getSuggestions(qRaw, 5);
        if (suggestions.length === 0) return;

        await message.reply(
          `No exact match for \`${qRaw}\`.\nDid you mean: ${suggestions
            .map((s) => `\`${s}\``)
            .join(", ")} ?`
        );
        return;
      }

      const updatedDate = parseLastUpdatedTextEastern(meta?.lastUpdatedText);

      const updatedLine = updatedDate
        ? `Updated ${formatDurationAgo(updatedDate.getTime())} ago`
        : "";

      await message.channel.send({
        embeds: [
          {
            title: r.name,
            description: updatedLine,
            color: 0xed8b2d,
            fields: [
              { name: "Total", value: fmt(r.total), inline: false },
              { name: "Male", value: fmt(r.male), inline: true },
              { name: "Female", value: fmt(r.female), inline: true },
              { name: "Ungendered", value: fmt(r.ungendered), inline: true },
              { name: "Genderless", value: fmt(r.genderless), inline: true }
            ],
            footer: { text: "Source: tppcrpg.net/rarity.html" }
          }
        ]
      });
    },
    "?rarity <pokemon> — shows rarity statistics"
  );

  register(
    "?rarityreload",
    async ({ message }) => {
      if (!isGuildAllowed(message)) return;
      const isAdmin =
        message.member?.permissions?.has("Administrator") ||
        message.member?.permissions?.has("ManageGuild");
      if (!isAdmin) return;

      await refresh();
      await message.reply("Rarity cache refreshed ✅");
    },
    "?rarityreload — refreshes rarity cache (admin)",
    { admin: true }
  );
}
