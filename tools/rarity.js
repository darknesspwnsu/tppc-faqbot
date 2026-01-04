// rarity.js
//
// rarity: exposable via register.expose logicalId "rarity.main"
// l4: exposable via register.expose logicalId "rarity.l4"
//
// Data source(s) are GitHub Pages JSON refreshed by GitHub Actions.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";
import {
  getSuggestionsFromIndex,
  normalizeKey,
  normalizeQueryVariants,
} from "../shared/pokename_utils.js";

/* ----------------------------- caches (main) ----------------------------- */
let rarity = null; // { lowerName: entry }
let rarityNorm = null; // { normalizedKey: entry }
let meta = null;

/* ----------------------------- caches (level4) ---------------------------- */
let rarity4 = null; // { lowerName: entry }
let rarity4Norm = null; // { normalizedKey: entry }
let meta4 = null;

/* --------------------------------- config -------------------------------- */

// ✅ Default to our live, auto-refreshed GitHub Pages JSON:
const DEFAULT_URL = "https://darknesspwnsu.github.io/tppc-data/data/rarity.json";
const DEFAULT_L4_URL = "https://darknesspwnsu.github.io/tppc-data/data/l4_rarity.json";

const FILE = "data/rarity.json";
const URL = process.env.RARITY_JSON_URL || DEFAULT_URL;

const L4_FILE = "data/l4_rarity.json";
const L4_URL = process.env.RARITY4_JSON_URL || DEFAULT_L4_URL;

const DAILY_REFRESH_ET = process.env.RARITY_DAILY_REFRESH_ET || "07:10";

// How often the bot checks for updates (keep modest; 5–10 min is perfect)
const REFRESH_MS = Number(process.env.RARITY_REFRESH_MS ?? 10 * 60_000);

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

/* ---------------------------- rarity history api --------------------------- */

function parseRarityHistoryArgs(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return { pokemon: "", timeframe: "" };

  const m = input.match(
    /^(.*\S)\s+(\d+)\s*(d|day|days|w|wk|week|weeks|m|mth|month|months|y|yr|year|years)?$/i
  );
  if (!m) return { pokemon: input, timeframe: "" };

  const pokemon = m[1].trim();
  const amount = Number(m[2]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { pokemon, timeframe: "" };
  }

  const unitRaw = String(m[3] || "d").toLowerCase();
  if (unitRaw.startsWith("y")) {
    return { pokemon, timeframe: `${amount * 12}m` };
  }

  const unit = unitRaw.startsWith("d") ? "d" : unitRaw.startsWith("w") ? "w" : "m";
  return { pokemon, timeframe: `${amount}${unit}` };
}

function historyUrlFromPokemonName(name) {
  const compact = String(name ?? "").trim().replace(/\s+/g, "");
  return `https://tppc.electa.buzz/history/${encodeURIComponent(compact.toLowerCase())}`;
}

function formatTimeframeLabel(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d+)\s*([dwmy])$/i);
  if (!match) return value;
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  const labels = {
    d: "day",
    w: "week",
    m: "month",
    y: "year",
  };
  const label = labels[unit];
  if (!label || !Number.isFinite(count)) return value;
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function fmtDelta(n) {
  const v = Number(n) || 0;
  if (v === 0) return "0";
  return `${v > 0 ? "+" : ""}${fmt(v)}`;
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

function formatDurationAgoWithoutSeconds(fromMs, nowMs = Date.now()) {
  let diff = Math.max(0, Math.floor((nowMs - fromMs) / 1000));

  const days = Math.floor(diff / 86400);
  diff %= 86400;
  const hours = Math.floor(diff / 3600);
  diff %= 3600;
  const minutes = Math.floor(diff / 60);

  const parts = [];
  if (days) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);

  return parts.join(", ");
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

function findEntry({ lowerIndex, normIndex }, qRaw) {
  if (!qRaw) return null;

  let r = lowerIndex?.[String(qRaw).toLowerCase()];
  if (r) return r;

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

  const mDot = q.match(/^([sdg])\.(.+)$/i);
  if (mDot) {
    const letter = mDot[1].toLowerCase();
    const rest = mDot[2].trim();
    const prefix = letter === "s" ? "Shiny" : letter === "d" ? "Dark" : "Golden";
    return prefix + rest;
  }

  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && ["s", "d", "g"].includes(parts[0].toLowerCase())) {
    const letter = parts[0].toLowerCase();
    const rest = parts.slice(1).join(" ");
    const prefix = letter === "s" ? "Shiny" : letter === "d" ? "Dark" : "Golden";
    return `${prefix} ${rest}`;
  }

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
  const s = String(rest ?? "").trim();
  if (!s) return [];

  const sepMatch = s.match(/\s*\|\s*|\s+vs\s+/i);
  if (sepMatch) {
    const parts = s.split(sepMatch[0]).map((x) => x.trim()).filter(Boolean);
    return parts.slice(0, 2);
  }

  const out = [];
  let cur = "";
  let q = null;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }
  if (cur) out.push(cur);

  const merged = [];
  for (const token of out) {
    if (!token) continue;
    if (!merged.length) {
      merged.push(token);
      continue;
    }

    if (token.startsWith("(")) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${token}`;
      continue;
    }

    if (merged.length < 2) {
      merged.push(token);
      continue;
    }
  }

  return merged.slice(0, 2);
}

function cmpLine(a, b) {
  return `${fmt(a)} vs ${fmt(b)}`;
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
  if (!m) return { hour: 7, minute: 10 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function nextRunInEastern(hhmm) {
  const { hour, minute } = parseHHMM(hhmm);
  const tz = "America/New_York";

  const now = new Date();

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

function buildDidYouMeanButtons(command, suggestions, extraArgs = "") {
  const enc = (s) => encodeURIComponent(String(s ?? "").slice(0, 120));

  const row = new ActionRowBuilder().addComponents(
    suggestions.slice(0, 5).map((name) =>
      new ButtonBuilder()
        .setCustomId(`rarity_retry:${command}:${enc(name)}:${enc(extraArgs)}`)
        .setLabel(name.length > 80 ? name.slice(0, 77) + "…" : name)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return [row];
}

async function disableInteractionButtons(interaction) {
  const rows = interaction.message?.components || [];
  if (!rows.length) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const disabledRows = rows.map((row) => {
    const newRow = new ActionRowBuilder();
    for (const component of row.components || []) {
      let button = null;
      if (typeof ButtonBuilder.from === "function") {
        try {
          button = ButtonBuilder.from(component);
        } catch {}
      }
      if (!button || typeof button.setDisabled !== "function") {
        const customId = component?.customId ?? component?.custom_id ?? "";
        const label = component?.label ?? component?.data?.label ?? "";
        const style = component?.style ?? component?.data?.style ?? ButtonStyle.Secondary;
        button = new ButtonBuilder();
        if (customId) button.setCustomId(customId);
        if (label) button.setLabel(label);
        if (style) button.setStyle(style);
        if (component?.emoji) button.setEmoji(component.emoji);
      }
      if (typeof button.setDisabled === "function") {
        button.setDisabled(true);
      }
      newRow.addComponents(button);
    }
    return newRow;
  });

  await interaction.update({ components: disabledRows }).catch(async () => {
    await interaction.deferUpdate().catch(() => {});
  });
}

async function replyRarityHelp(message, cmd) {
  const lines = [
    `Usage: \`${cmd} <pokemon>\``,
    `History: \`${cmd} <pokemon> <timeframe>\` (e.g. 7d, 2 weeks, 3m, 1 year; min unit: days)`,
  ];
  await message.reply(lines.join("\n"));
}

async function handleRarityHistory({ message, cmd, qRaw, timeframe }) {
  if (!rarityNorm) await refresh();

  const hit = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, qRaw);
  if (!hit) {
    const suggestions = getSuggestionsFromIndex(rarityNorm, qRaw, 5);
    if (suggestions.length) {
      await message.reply({
        content: `No exact match for \`${qRaw}\`.\nDid you mean:`,
        components: buildDidYouMeanButtons(cmd, suggestions, timeframe),
      });
    }
    return;
  }

  const apiPokemon = hit.name.toLowerCase();
  const url = `https://tppc.electa.buzz/api/v1/rarity?pokemon=${encodeURIComponent(
    apiPokemon
  )}&timeframe=${encodeURIComponent(timeframe)}`;
  console.log(`[${cmd}] Fetching ${url}`);

  let payload;
  try {
    payload = await fetchText(url);
  } catch (e) {
    await message.reply(`Couldn’t fetch rarity history for \`${hit.name}\`.`);
    return;
  }

  let data;
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.status !== "success") {
      throw new Error(parsed?.message || "API returned error");
    }
    data = parsed?.data;
  } catch (e) {
    await message.reply(`No rarity history found for \`${hit.name}\`.`);
    return;
  }

  const changes = data?.changes || {};
  const historical = data?.historical || {};
  const title = `${hit.name} — Rarity History (${formatTimeframeLabel(timeframe)})`;

  await message.reply({
    embeds: [
      {
        title,
        url: historyUrlFromPokemonName(hit.name),
        description: `Timeframe: **${formatTimeframeLabel(
          historical.timeframe || timeframe
        )}**`,
        color: 0xed8b2d,
        fields: [
          { name: "Total", value: `${fmt(data?.total)} (${fmtDelta(changes.total)})`, inline: false },
          { name: "♂", value: `${fmt(data?.male)} (${fmtDelta(changes.male)})`, inline: true },
          { name: "♀", value: `${fmt(data?.female)} (${fmtDelta(changes.female)})`, inline: true },
          {
            name: "(?)",
            value: `${fmt(data?.ungendered)} (${fmtDelta(changes.ungendered)})`,
            inline: true,
          },
          {
            name: "G",
            value: `${fmt(data?.genderless)} (${fmtDelta(changes.genderless)})`,
            inline: true,
          },
        ],
        footer: { text: `Last update: ${data?.last_update || "unknown"}` },
      },
    ],
  });
}

/* --------------------------------- exports -------------------------------- */

export function registerRarity(register) {
  refresh();
  scheduleDailyRefresh(refresh, "RARITY");

  // Exposable rarity main command (policy-controlled by logicalId rarity.main)
  register.expose({
    logicalId: "rarity.main",
    name: "rarity",
    handler: async ({ message, rest, cmd }) => {
      const raw = String(rest ?? "").trim();
      if (!raw || raw.toLowerCase() === "help") {
        await replyRarityHelp(message, cmd);
        return;
      }

      const { pokemon: historyPokemon, timeframe } = parseRarityHistoryArgs(raw);
      if (historyPokemon && timeframe) {
        await handleRarityHistory({ message, cmd, qRaw: historyPokemon, timeframe });
        return;
      }

      const qRaw = raw;
      const r = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, qRaw);

      if (!r) {
        const suggestions = getSuggestionsFromIndex(rarityNorm, qRaw, 5);
        if (suggestions.length === 0) return;

        await message.reply({
          content: `No exact match for \`${qRaw}\`.\nDid you mean:`,
          components: buildDidYouMeanButtons(cmd, suggestions),
        });

        return;
      }

      const updatedDate = parseLastUpdatedTextEastern(meta?.lastUpdatedText);
      const updatedLine = updatedDate
        ? `Updated ${formatDurationAgoWithoutSeconds(updatedDate.getTime())} ago`
        : "";

      await message.channel.send({
        embeds: [
          {
            title: r.name,
            color: 0xed8b2d,
            fields: [
              { name: "Total", value: fmt(r.total), inline: false },
              { name: "♂", value: fmt(r.male), inline: true },
              { name: "♀", value: fmt(r.female), inline: true },
              { name: "(?)", value: fmt(r.ungendered), inline: true },
              { name: "G", value: fmt(r.genderless), inline: true }
            ],
            footer: { text: updatedLine }
          }
        ]
      });
    },
    help: "?rarity <pokemon> — shows rarity statistics (add <timeframe> for history)"
  });

  // Rarity reload should be OFF wherever rarity.main is OFF
  register.expose({
    logicalId: "rarity.main",
    name: "rarityreload",
    handler: async ({ message }) => {
      if (!isAdminOrPrivileged(message)) return;

      await refresh();
      await message.reply("Rarity cache refreshed ✅");
    },
    help: "?rarityreload — refreshes rarity cache (admin)",
    opts: { admin: true, hideFromHelp: true }
  });
}

export function registerLevel4Rarity(register) {
  refreshL4();

  const handleL4 = async ({ message, rest, cmd }) => {
    const qRaw = String(rest ?? "").trim();
    if (!qRaw) {
      await message.reply(`Usage: \`${cmd} <pokemon>\``);
      return;
    }

    if (!rarity4Norm) await refreshL4();
    if (!rarityNorm) await refresh();

    const r = findEntry({ lowerIndex: rarity4, normIndex: rarity4Norm }, qRaw);

    if (!r) {
      const generalHit = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, qRaw);
      if (generalHit) {
        await message.reply(`No Level 4 rarity data found for \`${generalHit.name}\`.`);
        return;
      }

      const sL4 = getSuggestionsFromIndex(rarity4Norm, qRaw, 5);
      const sGen = getSuggestionsFromIndex(rarityNorm, qRaw, 5);
      const merged = mergeSuggestions(sL4, sGen);

      if (merged.length) {
        await message.reply({
          content: `No exact match for \`${qRaw}\`.\nDid you mean:`,
          components: buildDidYouMeanButtons(cmd, merged),
        });
        return;
      }

      const guess = prettyVariantGuess(qRaw);
      await message.reply(`No exact match for \`${guess ?? qRaw}\`.`);
      return;
    }

    const updatedDate = parseLastUpdatedTextEastern(meta4?.lastUpdatedText);
    const updatedLine = updatedDate
      ? `Updated ${formatDurationAgoWithoutSeconds(updatedDate.getTime())} ago`
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
  };

  // Exposable l4 command (policy-controlled by logicalId rarity.l4)
  register.expose({
    logicalId: "rarity.l4",
    name: "l4",
    handler: handleL4,
    help: "!l4 <pokemon> — shows level 4 rarity statistics",
    // IMPORTANT: bare aliases (no !/?). register.expose will prefix-match them.
    opts: { aliases: ["rarity4", "l4rarity", "rarityl4"] }
  });

  register(
    "!rc",
    async ({ message, rest }) => {
      const [q1, q2] = parseTwoArgs(rest);
      if (!q1 || !q2) {
        await message.reply(
          "Usage: `!rc <pokemon1> <pokemon2>` (tip: wrap names in quotes if they contain spaces)"
        );
        return;
      }
      if (!rarityNorm) await refresh();

      const r1 = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, q1);
      const r2 = findEntry({ lowerIndex: rarity, normIndex: rarityNorm }, q2);

      if (!r1 || !r2) {
        if (!r1) {
          const s1 = getSuggestionsFromIndex(rarityNorm, q1, 5);
          if (s1.length) {
            await message.reply({
              content: `No exact match for \`${q1}\`.\nDid you mean:`,
              components: buildDidYouMeanButtons("!rc_left", s1, q2),
            });
          } else {
            await message.reply(`No exact match for \`${q1}\`.`);
          }
        }

        if (!r2) {
          const s2 = getSuggestionsFromIndex(rarityNorm, q2, 5);
          if (s2.length) {
            await message.reply({
              content: `No exact match for \`${q2}\`.\nDid you mean:`,
              components: buildDidYouMeanButtons("!rc_right", s2, q1),
            });
          } else {
            await message.reply(`No exact match for \`${q2}\`.`);
          }
        }

        return;
      }

      if (normalizeKey(r1.name) === normalizeKey(r2.name)) {
        await message.reply("You can’t compare a Pokémon to itself. Please pick two different Pokémon.");
        return;
      }

      const updatedDate = parseLastUpdatedTextEastern(meta?.lastUpdatedText);
      const updatedLine = updatedDate
        ? `Updated ${formatDurationAgoWithoutSeconds(updatedDate.getTime())} ago`
        : "";

      await message.channel.send({
        embeds: [
          {
            title: `${r1.name} vs ${r2.name}`,
            color: 0xed8b2d,
            fields: [
              { name: "Total", value: cmpLine(r1.total, r2.total), inline: false },
              { name: "♂", value: cmpLine(r1.male, r2.male), inline: true },
              { name: "♀", value: cmpLine(r1.female, r2.female), inline: true },
              { name: "(?)", value: cmpLine(r1.ungendered, r2.ungendered), inline: true },
              { name: "G", value: cmpLine(r1.genderless, r2.genderless), inline: true }
            ],
            footer: { text: updatedLine }
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
      if (!isAdminOrPrivileged(message)) return;

      await refreshL4();
      await message.reply("Rarity4 cache refreshed ✅");
    },
    "!rarity4reload — refreshes rarity4 cache (admin)",
    { admin: true }
  );

  // ------------------------------- !rh (history) -------------------------------

  register(
    "!rh",
    async ({ message, rest }) => {
      const { pokemon: qRaw, timeframe } = parseRarityHistoryArgs(rest);
      if (!qRaw || !timeframe) {
        await message.reply(
          "Usage: `!rh <pokemon> <timeframe>` (e.g. 7d, 2 weeks, 3m, 1 year; min unit: days)"
        );
        return;
      }
      await handleRarityHistory({ message, cmd: "!rh", qRaw, timeframe });
    },
    "!rh <pokemon> <timeframe> — shows rarity history (timeframe: d/w/m/y)",
    { aliases: ["!rarityhistory"] }
  );
}

export async function handleRarityInteraction(interaction) {
  if (!interaction?.isButton?.()) return false;

  const id = String(interaction.customId || "");
  if (!id.startsWith("rarity_retry:")) return false;

  const [, cmdKey, encMon, encExtra] = id.split(":");
  const mon = decodeURIComponent(encMon || "");
  const extra = decodeURIComponent(encExtra || "");

  await disableInteractionButtons(interaction);

  // Rarity main (supports both prefixes; actual cmd used is encoded in the button customId)
  if (cmdKey === "?rarity") {
    const rest = extra ? `${mon} ${extra}` : mon;
    return { cmd: "?rarity", rest };
  }
  if (cmdKey === "!rarity") {
    const rest = extra ? `${mon} ${extra}` : mon;
    return { cmd: "!rarity", rest };
  }

  // L4 (supports both prefixes; actual cmd used is encoded in the button customId)
  if (cmdKey === "!l4") return { cmd: "!l4", rest: mon };
  if (cmdKey === "?l4") return { cmd: "?l4", rest: mon };

  if (cmdKey === "!rc_left") return { cmd: "!rc", rest: `"${mon}" "${extra}"` };
  if (cmdKey === "!rc_right") return { cmd: "!rc", rest: `"${extra}" "${mon}"` };

  if (cmdKey === "!rh") {
    const rest = extra ? `${mon} ${extra}` : mon;
    return { cmd: "!rh", rest };
  }

  return false;
}

// Reusable name normalization + suggestions (shared with RPG lookups).
