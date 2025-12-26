// rarity.js
//
// !rarity <pokemon> — shows rarity counts from a preprocessed JSON.
// Data source is your GitHub Pages JSON that is refreshed daily by GitHub Actions.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

let rarity = null; // { lowerName: { name, rank, male, female, genderless, ungendered, total } }
let meta = null;

// ✅ Default to your live, auto-refreshed GitHub Pages JSON:
const DEFAULT_URL = "https://darknesspwnsu.github.io/tppc-data/data/rarity.json";

const FILE = process.env.RARITY_JSON_FILE || "data/rarity.json";
const URL = process.env.RARITY_JSON_URL || DEFAULT_URL;

// How often the bot checks for updates (keep modest; 5–10 min is perfect)
const REFRESH_MS = Number(process.env.RARITY_REFRESH_MS ?? 10 * 60_000);

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

function buildIndex(json) {
  meta = json.meta || null;

  const out = {};
  const data = json.data || {};
  for (const [k, v] of Object.entries(data)) {
    out[String(k).toLowerCase()] = { name: k, ...v };
  }

  rarity = out;
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
    if (URL) {
      await loadFromUrl();
    } else {
      loadFromFile();
    }
  } catch (e) {
    console.warn("[RARITY] Refresh failed:", e?.message ?? e);
    // Keep last-known-good cache in memory
  }
}

function fmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("en-US") : "0";
}

export function registerRarity(register) {
  // Initial load + periodic refresh
  refresh();
  setInterval(refresh, REFRESH_MS);

  register(
    "!rarity",
    async ({ message, rest }) => {
      const qRaw = String(rest ?? "").trim();
      if (!qRaw) return;

      const r = rarity?.[qRaw.toLowerCase()];
      if (!r) return;

      const updatedUnix = meta?.generatedAt ? Math.floor(meta.generatedAt / 1000) : null;
      const updatedLine = updatedUnix ? `Updated <t:${updatedUnix}:R>.` : "";

      // Embed style similar to your screenshot vibe
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
    "!rarity <pokemon> — shows rarity statistics"
  );

  // Optional: admin-only manual refresh (super useful for testing)
  register(
    "!rarityreload",
    async ({ message }) => {
      const isAdmin =
        message.member?.permissions?.has("Administrator") ||
        message.member?.permissions?.has("ManageGuild");
      if (!isAdmin) return;

      await refresh();
      await message.reply("Rarity cache refreshed ✅");
    },
    "!rarityreload — refreshes rarity cache (admin)",
    { admin: true }
  );
}
