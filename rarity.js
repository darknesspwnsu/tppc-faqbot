// rarity.js
//
// ?rarity <pokemon> — shows rarity counts from a preprocessed JSON (gated by RARITY_GUILD_ALLOWLIST).
// !rarity4 / !l4 <pokemon> — shows LEVEL 4 rarity counts from l4_rarity.json (available everywhere).
//
// Data source(s) are GitHub Pages JSON refreshed by GitHub Actions.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

/* ----------------------------- caches (main) ----------------------------- */
let rarity = null;      // { lowerName: entry }
let rarityNorm = null;  // { normalizedKey: entry }
let meta = null;

/* ----------------------------- caches (level4) ---------------------------- */
let rarity4 = null;      // { lowerName: entry }
let rarity4Norm = null;  // { normalizedKey: entry }
let meta4 = null;

/* --------------------------------- config -------------------------------- */

// ✅ Default to our live, auto-refreshed GitHub Pages JSON:
const DEFAULT_URL = "https://darknesspwnsu.github.io/tppc-data/data/rarity.json";
const DEFAULT_L4_URL = "https://darknesspwnsu.github.io/tppc-data/data/l4_rarity.json";

const FILE = process.env.RARITY_JSON_FILE || "data/rarity.json";
const URL = process.env.RARITY_JSON_URL || DEFAULT_URL;

const L4_FILE = process.env.RARITY4_JSON_FILE || "data/l4_rarity.json";
const L4_URL = process.env.RARITY4_JSON_URL || DEFAULT_L4_URL;

const DAILY_REFRESH_ET = process.env.RARITY_DAILY_REFRESH_ET || "07:10";

// How often the bot checks for updates (keep modest; 5–10 min is perfect)
const REFRESH_MS = Number(process.env.RARITY_REFRESH_MS ?? 10 * 60_000);

// Suggestion tuning (env override)
const SUGGEST_MIN_SCORE = Number(process.env.RARITY_SUGGEST_MIN_SCORE ?? 0.55);
const SUGGEST_MAX_LEN_DIFF = Number(process.env.RARITY_SUGGEST_MAX_LEN_DIFF ?? 12);

// Rarity allowlist (ONLY applies to ?rarity / ?rarityreload)
const RARITY_GUILD_ALLOWLIST = (process.env.RARITY_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RARITY_ENABLED_ANYWHERE = RARITY_GUILD_ALLOWLIST.length > 0;

function isGuildAllowed(message) {
  // If no allowlist is set, treat it as disabled.
  if (!RARITY_ENABLED_ANYWHERE) return false;

  const gid = message?.guild?.id;
  if (!gid) return false;

  return RARITY_GUILD_ALLOWLIST.includes(gid);
}

/* --------------------------------- fetch --------------------------------- */

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

/* ------------------------- time: TPPC banner -> Date ------------------------ */

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

/* ------------------------------ normalization ------------------------------ */

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

  // Accept "gpichu" / "spichu" / "dpichu" (NO dot, NO space)
  // IMPORTANT: this is only a *candidate*; findEntry() still tries exact match first.
  const mStuck = q.match(/^([sdg])([a-z0-9].+)$/);
  if (mStuck && !q.includes(".") && !q.includes(" ")) {
    const letter = mStuck[1];
    const rest = mStuck[2].trim();
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
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

/* ---------------------------- indexing + search ---------------------------- */

function buildIndexGeneric(json) {
  const metaOut = json.meta || null;

  const out = {};
  const outNorm = {};
  const data = json.data || {};

  for (const [k, v] of Object.entries(data)) {
    const entry = { name: k, ...v };
    out[String(k).toLowerCase()] = entry;
    outNorm[normalizeKey(k)] = entry;
  }

  return { meta: metaOut, lower: out, norm: outNorm };
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

function getSuggestionsFromIndex(normIndex, queryRaw, limit = 5) {
  if (!normIndex) return [];

  const qKeys = normalizeQueryVariants(queryRaw); // expands g./s./d. forms too
  if (!qKeys.length) return [];

  let pref = queryVariantPrefix(queryRaw); // "" | "shiny" | "dark" | "golden"

  // If user used "gpichu"/"spichu"/"dpichu" and it doesn't directly exist,
  // treat it as variant intent for suggestions.
  if (!pref) {
    const q = String(queryRaw ?? "").trim().toLowerCase();
    const mStuck = q.match(/^([sdg])([a-z0-9].+)$/);
    if (mStuck && !q.includes(".") && !q.includes(" ")) {
      const directKey = normalizeKey(q);
      if (!normIndex[directKey]) {
        pref = mStuck[1] === "s" ? "shiny" : mStuck[1] === "d" ? "dark" : "golden";
      }
    }
  }

  const scored = [];
  for (const [nk, entry] of Object.entries(normIndex)) {
    // If user clearly asked for Golden/Dark/Shiny, keep suggestions in that bucket.
    if (pref) {
      if (!nk.startsWith(pref)) continue;
    } else {
      // No variant requested: keep suggestions to BASE only
      if (nk.startsWith("shiny") || nk.startsWith("dark") || nk.startsWith("golden")) {
        continue;
      }
    }

    // Score = best Dice coefficient among all candidate normalized queries
    let best = 0;
    for (const q of qKeys) {
      if (Math.abs(nk.length - q.length) > SUGGEST_MAX_LEN_DIFF) continue;
      const s = diceCoeff(q, nk);
      if (s > best) best = s;
    }

    if (best >= SUGGEST_MIN_SCORE) scored.push([best, entry.name]);
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

function findEntry({ lowerIndex, normIndex }, qRaw) {
  if (!qRaw) return null;

  // exact case-insensitive key hit
  let r = lowerIndex?.[String(qRaw).toLowerCase()];
  if (r) return r;

  // normalized tries (variant-aware)
  const tries = normalizeQueryVariants(qRaw);
  for (const t of tries) {
    r = normIndex?.[t];
    if (r) return r;
  }

  return null;
}

function prettyVariantGuess(qRaw) {
  const q = String(qRaw ?? "").trim();
  if (!q) return null;

  // Handle dot prefixes: g.sneasel (hisui) -> GoldenSneasel (hisui)
  const mDot = q.match(/^([sdg])\.(.+)$/i);
  if (mDot) {
    const letter = mDot[1].toLowerCase();
    const rest = mDot[2].trim();
    const prefix = letter === "s" ? "Shiny" : letter === "d" ? "Dark" : "Golden";
    return prefix + rest;
  }

  // Handle spaced prefixes: "g sneasel (hisui)" -> "Golden sneasel (hisui)"
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && ["s", "d", "g"].includes(parts[0].toLowerCase())) {
    const letter = parts[0].toLowerCase();
    const rest = parts.slice(1).join(" ");
    const prefix = letter === "s" ? "Shiny" : letter === "d" ? "Dark" : "Golden";
    return `${prefix} ${rest}`;
  }

  // Handle stuck prefixes: "gpichu" -> "GoldenPichu"
  const mStuck = q.match(/^([sdg])([^\s.].+)$/i);
  if (mStuck && !q.includes(".") && !q.includes(" ")) {
    const letter = mStuck[1].toLowerCase();
    const rest = mStuck[2].trim();
    const prefix = letter === "s" ? "Shiny" : letter === "d" ? "Dark" : "Golden";
    const restPretty = rest ? rest[0].toUpperCase() + rest.slice(1) : rest;
    return prefix + restPretty;
  }

  return q;
}

// Merge suggestions from multiple sources, dedupe case-insensitively, keep order.
function mergeSuggestions(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of list || []) {
      const k = String(s).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function parseTwoArgs(rest) {
  // Supports:
  //   !rc a b
  //   !rc "GoldenSneasel (Hisui)" "ShinySneasel (Hisui)"
  //   !rc a | b
  //   !rc a vs b
  const s = String(rest ?? "").trim();
  if (!s) return [];

  // Prefer explicit separators first
  const sepMatch = s.match(/\s*\|\s*|\s+vs\s+/i);
  if (sepMatch) {
    const parts = s.split(sepMatch[0]).map((x) => x.trim()).filter(Boolean);
    return parts.slice(0, 2);
  }

  // Quote-aware split
  const out = [];
  let cur = "";
  let q = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (q) {
      if (ch === q) {
        q = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }

    cur += ch;
  }
  if (cur) out.push(cur);

  // If user didn’t quote multi-word names, they’ll get >2 tokens — we just take first 2.
  return out.slice(0, 2);
}

function fmtDiffCaret(a, b) {
  const da = Number(a) || 0;
  const db = Number(b) || 0;
  const d = db - da;

  if (d === 0) return { sym: "●", text: "±0" };

  return d > 0
    ? { sym: "▲", text: `+${Math.abs(d).toLocaleString("en-US")}` }
    : { sym: "▼", text: `-${Math.abs(d).toLocaleString("en-US")}` };
}

function cmpLine(a, b) {
  return `(${fmt(a)} vs ${fmt(b)})`;
}

/* --------------------------------- loading -------------------------------- */

async function loadIndexFromUrl(url) {
  const raw = await fetchText(url);
  const json = JSON.parse(raw);
  return buildIndexGeneric(json);
}

function loadIndexFromFile(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8");
  const json = JSON.parse(raw);
  return buildIndexGeneric(json);
}

/* -------------------------- main rarity: refreshers ------------------------- */

async function refresh() {
  try {
    const idx = URL ? await loadIndexFromUrl(URL) : loadIndexFromFile(FILE);
    meta = idx.meta;
    rarity = idx.lower;
    rarityNorm = idx.norm;
    console.log(`[RARITY] Loaded ${Object.keys(rarity).length} entries`);
  } catch (e) {
    console.warn("[RARITY] Refresh failed:", e?.message ?? e);
    // Keep last-known-good cache in memory
  }
}

/* -------------------------- level4 rarity: refreshers ------------------------ */

async function refreshL4() {
  try {
    const idx = L4_URL ? await loadIndexFromUrl(L4_URL) : loadIndexFromFile(L4_FILE);
    meta4 = idx.meta;
    rarity4 = idx.lower;
    rarity4Norm = idx.norm;
    console.log(`[RARITY4] Loaded ${Object.keys(rarity4).length} entries`);
  } catch (e) {
    console.warn("[RARITY4] Refresh failed:", e?.message ?? e);
    // Keep last-known-good cache in memory
  }
}

/* --------------------------------- format --------------------------------- */

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("en-US") : "0";
}

/* ------------------------ daily refresh scheduling (ET) --------------------- */

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

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const d = Number(get("day"));

  // Create a Date for today's target time *as Eastern*, by formatting a UTC guess and adjusting.
  const candidateUtc = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));

  const nowInET = new Date(new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now));
  const candInET = new Date(new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(candidateUtc));

  let runUtc = candidateUtc;
  if (candInET <= nowInET) {
    runUtc = new Date(Date.UTC(y, mo - 1, d + 1, hour, minute, 0));
  }
  return runUtc;
}

function scheduleDailyRefresh(refreshFn, label = "RARITY") {
  const runAt = nextRunInEastern(DAILY_REFRESH_ET);
  let delay = runAt.getTime() - Date.now();
  if (!Number.isFinite(delay) || delay < 0) delay = 60_000;

  console.log(
    `[${label}] Next daily refresh scheduled for ET ${DAILY_REFRESH_ET} (in ${Math.round(delay / 1000)}s)`
  );

  setTimeout(async function tick() {
    await refreshFn();

    const next = nextRunInEastern(DAILY_REFRESH_ET);
    let nextDelay = next.getTime() - Date.now();
    if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 24 * 60 * 60_000;

    console.log(
      `[${label}] Next daily refresh scheduled for ET ${DAILY_REFRESH_ET} (in ${Math.round(nextDelay / 1000)}s)`
    );
    setTimeout(tick, nextDelay);
  }, delay);
}

/* --------------------------------- exports -------------------------------- */

export function registerRarity(register) {
  refresh();                 // load once at startup
  scheduleDailyRefresh(refresh, "RARITY"); // refresh once per day around ET update time

  register(
    "?rarity",
    async ({ message, rest }) => {
      if (!isGuildAllowed(message)) return;

      const qRaw = String(rest ?? "").trim();
      if (!qRaw) {
        await message.reply("Usage: `?rarity <pokemon>`");
        return;
      }

      const r = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, qRaw);

      if (!r) {
        const suggestions = getSuggestionsFromIndex(rarityNorm, qRaw, 5);
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
              { name: "♂", value: fmt(r.male), inline: true },
              { name: "♀", value: fmt(r.female), inline: true },
              { name: "(?)", value: fmt(r.ungendered), inline: true },
              { name: "Genderless", value: fmt(r.genderless), inline: true }
            ],
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

export function registerLevel4Rarity(register) {
  // Available out-of-the-box everywhere.
  refreshL4(); // load once at startup

  register(
    "!l4",
    async ({ message, rest }) => {
      const qRaw = String(rest ?? "").trim();
      if (!qRaw) {
        await message.reply("Usage: `!l4 <pokemon>`");
        return;
      }

      // Ensure both datasets are loaded:
      // - L4 is for display
      // - general rarity is for "does this key exist?" + richer suggestions (forms)
      if (!rarity4Norm) await refreshL4();
      if (!rarityNorm) await refresh();

      const r = findEntry({ lowerIndex: rarity4, normIndex: rarity4Norm }, qRaw);

      if (!r) {
        // If general rarity recognizes this exact/canonical key, then this is a "valid mon, no L4 data" case.
        const generalHit = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, qRaw);
        if (generalHit) {
          await message.reply(`No Level 4 rarity data found for \`${generalHit.name}\`.`);
          return;
        }

        // Otherwise, treat as typo/unknown: offer "did you mean" from BOTH sources.
        const sL4 = getSuggestionsFromIndex(rarity4Norm, qRaw, 5);
        const sGen = getSuggestionsFromIndex(rarityNorm, qRaw, 5);
        const merged = mergeSuggestions(sL4, sGen);

        if (merged.length) {
          await message.reply(
            `No exact match for \`${qRaw}\`.\nDid you mean: ${merged
              .map((s) => `\`${s}\``)
              .join(", ")} ?`
          );
          return;
        }

        // No suggestions anywhere
        const guess = prettyVariantGuess(qRaw);
        await message.reply(`No exact match for \`${guess ?? qRaw}\`.`);
        return;
      }

      const updatedDate = parseLastUpdatedTextEastern(meta4?.lastUpdatedText);
      const updatedLine = updatedDate
        ? `Updated ${formatDurationAgo(updatedDate.getTime())} ago`
        : "";

      await message.channel.send({
        embeds: [
          {
            title: `${r.name} - Level 4`,
            description: updatedLine,
            color: 0xed8b2d,
            fields: [
              { name: "Total", value: fmt(r.total), inline: false },
              { name: "♂", value: fmt(r.male), inline: true },
              { name: "♀", value: fmt(r.female), inline: true },
              { name: "(?)", value: fmt(r.ungendered), inline: true },
              { name: "Genderless", value: fmt(r.genderless), inline: true }
            ],
            footer: { text: "Source: forums.tppc.info/showthread.php?t=318183" }
          }
        ]
      });
    },
    "!l4 <pokemon> — shows level 4 rarity statistics",
    { aliases: ["!rarity4", "!l4rarity", "!rarityl4"] }
  );

  register(
    "!rc",
    async ({ message, rest }) => {
      const [q1, q2] = parseTwoArgs(rest);
      if (!q1 || !q2) {
        await message.reply("Usage: `!rc <pokemon1> <pokemon2>` (tip: wrap names in quotes if they contain spaces)");
        return;
      }

      // Disallow comparing the same Pokémon (including aliases that resolve to the same entry)
      if (String(r1.name).toLowerCase() === String(r2.name).toLowerCase()) {
        await message.reply("You can’t compare a Pokémon to itself. Please pick two different Pokémon.");
        return;
      }

      // Ensure cache is loaded
      if (!rarityNorm) await refresh();

      const r1 = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, q1);
      const r2 = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, q2);

      // Did-you-mean handling per-side
      if (!r1 || !r2) {
        const parts = [];

        if (!r1) {
          const s1 = getSuggestionsFromIndex(rarityNorm, q1, 5);
          parts.push(
            s1.length
              ? `No exact match for \`${q1}\`. Did you mean: ${s1.map((s) => `\`${s}\``).join(", ")} ?`
              : `No exact match for \`${q1}\`.`
          );
        }

        if (!r2) {
          const s2 = getSuggestionsFromIndex(rarityNorm, q2, 5);
          parts.push(
            s2.length
              ? `No exact match for \`${q2}\`. Did you mean: ${s2.map((s) => `\`${s}\``).join(", ")} ?`
              : `No exact match for \`${q2}\`.`
          );
        }

        await message.reply(parts.join("\n"));
        return;
      }

      const updatedDate = parseLastUpdatedTextEastern(meta?.lastUpdatedText);
      const updatedLine = updatedDate
        ? `Updated ${formatDurationAgo(updatedDate.getTime())} ago`
        : "";

      await message.channel.send({
        embeds: [
          {
            title: `${r1.name} vs ${r2.name}`,
            description: updatedLine,
            color: 0xed8b2d,
            fields: [
              { name: "Total", value: cmpLine(r1.total, r2.total), inline: false },
              { name: "♂", value: cmpLine(r1.male, r2.male), inline: true },
              { name: "♀", value: cmpLine(r1.female, r2.female), inline: true },
              { name: "(?)", value: cmpLine(r1.ungendered, r2.ungendered), inline: true },
              { name: "Genderless", value: cmpLine(r1.genderless, r2.genderless), inline: true }
            ],
          }
        ]
      });
    },
    "!rc <pokemon1> <pokemon2> — compares rarity statistics",
    { aliases: ["!raritycompare", "!rarityc", "!rcompare", "!rcomp"] }
  );

  register(
    "!rarity4reload",
    async ({ message }) => {
      const isAdmin =
        message.member?.permissions?.has("Administrator") ||
        message.member?.permissions?.has("ManageGuild");
      if (!isAdmin) return;

      await refreshL4();
      await message.reply("Rarity4 cache refreshed ✅");
    },
    "!rarity4reload — refreshes rarity4 cache (admin)",
    { admin: true }
  );
}
