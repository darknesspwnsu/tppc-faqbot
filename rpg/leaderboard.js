// rpg/leaderboard.js
//
// Cached leaderboards for TPPC RPG challenges.

import { parse } from "node-html-parser";

import { RpgClient } from "./rpg_client.js";
import { findPokedexEntry, parsePokemonQuery } from "./pokedex.js";
import { normalizeKey } from "../tools/rarity.js";
import { getLeaderboard, upsertLeaderboard } from "./storage.js";

const CHALLENGES = {
  ssanne: {
    key: "ssanne",
    name: "SS Anne",
    url: "https://www.tppcrpg.net/ss_anne.php",
    ttlMs: 5 * 60_000,
  },
  tc: {
    key: "tc",
    name: "Training Challenge",
    url: "https://www.tppcrpg.net/ranks_training.php",
    ttlMs: 24 * 60 * 60_000,
  },
  safarizone: {
    key: "safarizone",
    name: "Safari Zone",
    url: "https://www.tppcrpg.net/safari_zone.php",
    ttlMs: 5 * 60_000,
  },
  speedtower: {
    key: "speedtower",
    name: "Speed Tower",
    url: "https://www.tppcrpg.net/speed_tower.php",
    ttlMs: 5 * 60_000,
  },
  roulette: {
    key: "roulette",
    name: "Battle Roulette",
    url: "https://www.tppcrpg.net/roulette.php",
    ttlMs: 5 * 60_000,
  },
  roulette_weekly: {
    key: "roulette_weekly",
    name: "Battle Roulette (Weekly)",
    url: "https://www.tppcrpg.net/roulette.php",
    ttlMs: 5 * 60_000,
  },
  trainers: {
    key: "trainers",
    name: "Top Trainers",
    url: "https://www.tppcrpg.net/ranks_team.php",
    ttlMs: 5 * 60_000,
  },
};

const POKEMON_TTL_MS = 24 * 60 * 60_000;
const POKEMON_REFRESH_ET = { hour: 6, minute: 5 };

const pokemonCache = new Map(); // lookupKey -> { rows, updatedAtMs }

const ALIASES = new Map([
  ["ssanne", "ssanne"],
  ["ss", "ssanne"],
  ["anne", "ssanne"],
  ["tc", "tc"],
  ["training", "tc"],
  ["trainingchallenge", "tc"],
  ["safarizone", "safarizone"],
  ["safari", "safarizone"],
  ["speedtower", "speedtower"],
  ["speed", "speedtower"],
  ["roulette", "roulette"],
  ["battleroulette", "roulette"],
  ["br", "roulette"],
]);

function getText(node) {
  if (!node) return "";
  return String(node.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHtml(html) {
  return String(html || "").replace(/<a\s+[^>]*>[^<]*?(?=<\/td>)/gi, (m) => `${m}</a>`);
}

function isHeaderRank(rankText) {
  const value = String(rankText || "").trim().toLowerCase();
  return value === "standing" || value === "rank";
}

function isHeaderRow(row) {
  const rank = String(row?.rank || "").trim().toLowerCase();
  const trainer = String(row?.trainer || "").trim().toLowerCase();
  const faction = String(row?.faction || "").trim().toLowerCase();
  const pokemon = String(row?.pokemon || "").trim().toLowerCase();
  if (isHeaderRank(rank)) return true;
  if (trainer === "trainer name") return true;
  if (faction === "faction") return true;
  if (pokemon === "pokémon" || pokemon === "pokemon") return true;
  return false;
}

function parseTrainerCell(cell) {
  const link = cell?.querySelector?.("a");
  const name = getText(link || cell);
  const href = link?.getAttribute?.("href") || "";
  const m = /profile\.php\?id=(\d+)/i.exec(href);
  return { trainerId: m?.[1] || null, name };
}

function parseSpeedTower(html) {
  const root = parse(normalizeHtml(html));
  const rows = root.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 5) continue;
    const rankText = getText(cells[0]);
    if (!rankText.toLowerCase().includes("today")) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    out.push({
      rank: rankText,
      trainer: name,
      trainerId,
      faction: getText(cells[2]),
      floor: getText(cells[3]),
      time: getText(cells[4]),
    });
  }
  return out;
}

function parseSsAnne(html) {
  const root = parse(normalizeHtml(html));
  const table = root.querySelector("table.ranks");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) continue;
    const rank = getText(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      faction: getText(cells[2]),
      wins: getText(cells[3]),
    });
  }
  return out;
}

function parseSafariZone(html) {
  const root = parse(normalizeHtml(html));
  const table = root.querySelector("table.ranks");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) continue;
    if (isHeaderRank(getText(cells[0]))) continue;
    out.push({
      rank: getText(cells[0]),
      trainer: getText(cells[1]),
      pokemon: getText(cells[2]),
      points: getText(cells[3]),
    });
  }
  return out;
}

function parseRouletteTable(table, { includeDate } = {}) {
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (includeDate && cells.length < 5) continue;
    if (!includeDate && cells.length < 4) continue;
    const rank = getText(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    const faction = getText(cells[2]);
    if (includeDate) {
      out.push({
        rank,
        trainer: name,
        trainerId,
        faction,
        battleDate: getText(cells[3]),
        wins: getText(cells[4]),
      });
    } else {
      out.push({
        rank,
        trainer: name,
        trainerId,
        faction,
        wins: getText(cells[3]),
      });
    }
  }
  return out;
}

function findRouletteTableAfterHeading(root, match) {
  const nodes = root.querySelectorAll("h3, table.ranks");
  let expectingTable = false;
  for (const node of nodes) {
    if (node.tagName === "H3") {
      const heading = getText(node).toLowerCase();
      expectingTable = match(heading);
      continue;
    }
    if (expectingTable && node.tagName === "TABLE") {
      return node;
    }
  }
  return null;
}

function parseRoulette(html) {
  const root = parse(normalizeHtml(html));
  const dailyTable =
    findRouletteTableAfterHeading(root, (heading) => heading.includes("standings for") && !heading.includes("through")) ||
    root.querySelectorAll("table.ranks")[0];
  const weeklyTable =
    findRouletteTableAfterHeading(root, (heading) => heading.includes("through")) ||
    root.querySelectorAll("table.ranks")[1];
  return {
    daily: parseRouletteTable(dailyTable, { includeDate: false }),
    weekly: parseRouletteTable(weeklyTable, { includeDate: true }),
  };
}

function parseTrainingChallenge(html) {
  const root = parse(normalizeHtml(html));
  const table = root.querySelector("table.ranks");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 5) continue;
    const rank = getText(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      pokemon: getText(cells[2]),
      level: getText(cells[3]),
      number: getText(cells[4]),
    });
  }
  return out;
}

function parseTrainerRanks(html) {
  const root = parse(normalizeHtml(html));
  const table = root.querySelector("table.ranks");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 5) continue;
    const rank = getText(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      faction: getText(cells[2]),
      level: getText(cells[3]),
      number: getText(cells[4]),
    });
  }
  return out;
}

function parsePokemonRanks(html) {
  const root = parse(normalizeHtml(html));
  const table = root.querySelector("table.ranks");
  if (!table) return [];
  const rows = table.querySelectorAll("tr");
  const out = [];
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 5) continue;
    const rank = getText(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseTrainerCell(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      pokemon: getText(cells[2]),
      level: getText(cells[3]),
      number: getText(cells[4]),
    });
  }
  return out;
}

function parsePokemonPageCount(html) {
  const root = parse(String(html || ""));
  const text = getText(root);
  const m = /Page\s+1\s+of\s+(\d+)/i.exec(text);
  if (!m) return 1;
  const count = Number(m[1]);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function renderTopRows(challengeKey, rows, limit = 5) {
  const out = [];
  const top = rows.filter((row) => !isHeaderRow(row)).slice(0, limit);
  for (const row of top) {
    if (challengeKey === "speedtower") {
      out.push(
        `${row.rank} — ${row.trainer} (${row.faction}) • ${row.floor} • ${row.time}`
      );
    } else if (challengeKey === "ssanne") {
      out.push(`#${row.rank} — ${row.trainer} (${row.faction}) • ${row.wins}`);
    } else if (challengeKey === "roulette" || challengeKey === "roulette_weekly") {
      out.push(`#${row.rank} — ${row.trainer} (${row.faction}) • ${row.wins}`);
    } else if (challengeKey === "safarizone") {
      out.push(
        `#${row.rank} — ${row.trainer} • ${row.pokemon} • ${row.points} pts`
      );
    } else if (challengeKey === "tc") {
      out.push(
        `#${row.rank} — ${row.trainer} • ${row.pokemon} Lv${row.level} • ID ${row.number}`
      );
    } else if (challengeKey === "trainers") {
      out.push(
        `#${row.rank} — ${row.trainer} (${row.faction}) • Lv ${row.level} • ID ${row.number}`
      );
    } else if (challengeKey === "pokemon") {
      out.push(
        `#${row.rank} — ${row.trainer} • ${row.pokemon} Lv${row.level} • ID ${row.number}`
      );
    }
  }
  return out;
}

async function fetchAndStore(challenge, client) {
  const html = await client.fetchPage(challenge.url);
  let rows = [];
  if (challenge.key === "speedtower") rows = parseSpeedTower(html);
  else if (challenge.key === "ssanne") rows = parseSsAnne(html);
  else if (challenge.key === "safarizone") rows = parseSafariZone(html);
  else if (challenge.key === "roulette") rows = parseRoulette(html).daily;
  else if (challenge.key === "roulette_weekly") rows = parseRoulette(html).weekly;
  else if (challenge.key === "tc") rows = parseTrainingChallenge(html);
  else if (challenge.key === "trainers") rows = parseTrainerRanks(html);
  await upsertLeaderboard({ challenge: challenge.key, payload: { rows } });
  return rows;
}

async function getCachedOrFetch(challengeKey, client) {
  const challenge = CHALLENGES[challengeKey];
  if (!challenge) return null;

  const cached = await getLeaderboard({ challenge: challenge.key });
  const now = Date.now();
  const stale =
    !cached?.updatedAt || (challenge.ttlMs && now - cached.updatedAt > challenge.ttlMs);

  if (!cached || stale || !cached.payload?.rows?.length) {
    const rows = await fetchAndStore(challenge, client);
    return { challenge, rows };
  }

  return { challenge, rows: cached.payload.rows || [] };
}

async function getCachedPokemon({ cacheKey, lookupKey, client }) {
  const cachedMem = pokemonCache.get(lookupKey);
  const now = Date.now();
  const staleMem = !cachedMem?.updatedAtMs || now - cachedMem.updatedAtMs > POKEMON_TTL_MS;
  if (cachedMem && !staleMem) return cachedMem.rows || [];

  const cached = await getLeaderboard({ challenge: cacheKey });
  const stale = !cached?.updatedAt || now - cached.updatedAt > POKEMON_TTL_MS;
  if (!cached || stale || !cached.payload?.rows?.length) {
    const rows = await fetchPokemonPages({ lookupKey, client });
    await upsertLeaderboard({ challenge: cacheKey, payload: { rows } });
    pokemonCache.set(lookupKey, { rows, updatedAtMs: Date.now() });
    return rows;
  }
  const rows = cached.payload.rows || [];
  pokemonCache.set(lookupKey, { rows, updatedAtMs: cached.updatedAt || Date.now() });
  return rows;
}

async function fetchPokemonPages({ lookupKey, client }) {
  const firstUrl = `https://www.tppcrpg.net/ranks_individual.php?p=1&f=${encodeURIComponent(lookupKey)}`;
  const firstHtml = await client.fetchPage(firstUrl);
  const totalPages = parsePokemonPageCount(firstHtml);
  const rows = [...parsePokemonRanks(firstHtml)];

  for (let page = 2; page <= totalPages; page += 1) {
    const url = `https://www.tppcrpg.net/ranks_individual.php?p=${page}&f=${encodeURIComponent(lookupKey)}`;
    const html = await client.fetchPage(url);
    rows.push(...parsePokemonRanks(html));
  }

  return rows;
}

function schedulePokemonCacheRefresh(client) {
  let lastRefreshKey = null;

  function getEtDateKey() {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function getEtTimeParts() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    return { hour, minute };
  }

  async function refreshAll() {
    for (const lookupKey of pokemonCache.keys()) {
      try {
        const rows = await fetchPokemonPages({ lookupKey, client });
        pokemonCache.set(lookupKey, { rows, updatedAtMs: Date.now() });
        const cacheKey = `pokemon:${lookupKey}`;
        await upsertLeaderboard({ challenge: cacheKey, payload: { rows } });
      } catch (err) {
        console.error(`[rpg] pokemon leaderboard refresh failed for ${lookupKey}:`, err);
      }
    }
  }

  async function tick() {
    const { hour, minute } = getEtTimeParts();
    if (Number.isNaN(hour) || Number.isNaN(minute)) return;
    if (hour < POKEMON_REFRESH_ET.hour) return;
    if (hour === POKEMON_REFRESH_ET.hour && minute < POKEMON_REFRESH_ET.minute) return;

    const dateKey = getEtDateKey();
    if (lastRefreshKey === dateKey) return;
    lastRefreshKey = dateKey;
    await refreshAll();
  }

  tick();
  setInterval(tick, 10 * 60_000);
}

function scheduleTrainingChallenge(client) {
  let lastRunDate = null;

  function getEtDateKey() {
    const dt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return dt;
  }

  function getEtHour() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    return hourPart ? Number(hourPart.value) : null;
  }

  async function tick() {
    const dateKey = getEtDateKey();
    const hour = getEtHour();
    if (hour == null) return;
    if (hour < 9) return;
    if (lastRunDate === dateKey) return;
    lastRunDate = dateKey;
    try {
      await fetchAndStore(CHALLENGES.tc, client);
    } catch (err) {
      console.error("[rpg] failed to refresh training challenge:", err);
    }
  }

  tick();
  setInterval(tick, 10 * 60_000);
}

export function registerLeaderboard(register) {
  const client = new RpgClient();
  scheduleTrainingChallenge(client);
  schedulePokemonCacheRefresh(client);

  register(
    "!leaderboard",
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!process.env.RPG_USERNAME || !process.env.RPG_PASSWORD) {
        console.error("[rpg] RPG_USERNAME/RPG_PASSWORD not configured for !leaderboard");
        await message.reply("❌ RPG leaderboard credentials are not configured.");
        return;
      }

      const raw = String(rest || "").trim().toLowerCase();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = parts[0] || "";

      if (!sub || sub === "help") {
        await message.reply(
          [
            "**Leaderboard options:**",
            "• `!leaderboard ssanne` — SS Anne standings",
            "• `!leaderboard safarizone` — Safari Zone standings",
            "• `!leaderboard tc` — Training Challenge standings",
            "• `!leaderboard roulette [weekly]` — Battle Roulette standings",
            "• `!leaderboard speedtower` — Speed Tower standings",
            "• `!leaderboard trainers [1-20]` — Top trainers by level",
            "• `!leaderboard pokemon <name> [1-20]` — Top trainers for a Pokemon",
          ].join("\n")
        );
        return;
      }

      if (sub === "trainers") {
        const countRaw = parts[1] || "";
        const count = countRaw ? Number(countRaw) : 5;
        if (!Number.isInteger(count) || count < 1 || count > 20) {
          await message.reply("❌ `num_trainers` must be an integer between 1 and 20.");
          return;
        }

        const res = await getCachedOrFetch("trainers", client);
        if (!res) {
          await message.reply("❌ Unknown challenge.");
          return;
        }

        const lines = renderTopRows("trainers", res.rows || [], count);
        if (!lines.length) {
          await message.reply(`No leaderboard entries found for ${res.challenge.name}.`);
          return;
        }

        await message.reply(
          `🏆 **${res.challenge.name}** (top ${Math.min(count, lines.length)})\n` +
            lines.join("\n")
        );
        return;
      }

      if (sub === "pokemon") {
        const countRaw = parts[parts.length - 1];
        const hasCount = countRaw && /^\d+$/.test(countRaw);
        const count = hasCount ? Number(countRaw) : 5;
        if (hasCount && (!Number.isInteger(count) || count < 1 || count > 20)) {
          await message.reply("❌ `max_number` must be an integer between 1 and 20.");
          return;
        }

        const nameTokens = parts.slice(1, hasCount ? -1 : undefined);
        const nameRaw = nameTokens.join(" ").trim();
        if (!nameRaw) {
          await message.reply("Usage: `!leaderboard pokemon <name> [1-20]`");
          return;
        }

        const { base, variant } = parsePokemonQuery(nameRaw);
        const { entry, suggestions } = await findPokedexEntry(base || nameRaw);
        if (!entry) {
          const suggestionLine =
            suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(", ")}?` : "";
          await message.reply(`❌ Unknown Pokemon name: **${nameRaw}**.${suggestionLine}`);
          return;
        }

        const cacheKey = `pokemon:${entry.key}`;
        let rows = await getCachedPokemon({ cacheKey, lookupKey: entry.key, client });
        if (variant) {
          const prefix = normalizeKey(variant);
          const baseNorm = normalizeKey(entry.name);
          rows = rows.filter((row) => {
            const norm = normalizeKey(row.pokemon);
            return norm.startsWith(prefix) && norm.includes(baseNorm);
          });
        }

        const lines = renderTopRows("pokemon", rows, count);
        if (!lines.length) {
          const label = variant ? `${variant} ${entry.name}` : entry.name;
          await message.reply(`No leaderboard entries found for ${label}.`);
          return;
        }

        await message.reply(
          `🏆 **${variant ? `${variant} ${entry.name}` : entry.name}** (top ${Math.min(count, lines.length)})\n` +
            lines.join("\n")
        );
        return;
      }

      const baseKey = ALIASES.get(sub);
      if (!baseKey) {
        await message.reply(
          "Usage: `!leaderboard ssanne|safarizone|tc|roulette [weekly]|speedtower|trainers [1-20]|pokemon <name> [1-20]`"
        );
        return;
      }

      const isWeekly = parts[1] === "weekly";
      const key = baseKey === "roulette" && isWeekly ? "roulette_weekly" : baseKey;
      if (parts.length > 1 && baseKey !== "roulette") {
        await message.reply(
          "Usage: `!leaderboard ssanne|safarizone|tc|roulette [weekly]|speedtower|trainers [1-20]|pokemon <name> [1-20]`"
        );
        return;
      }
      if (baseKey === "roulette" && parts.length > 1 && !isWeekly) {
        await message.reply(
          "Usage: `!leaderboard ssanne|safarizone|tc|roulette [weekly]|speedtower|trainers [1-20]|pokemon <name> [1-20]`"
        );
        return;
      }

      const res = await getCachedOrFetch(key, client);
      if (!res) {
        await message.reply("❌ Unknown challenge.");
        return;
      }

      const lines = renderTopRows(res.challenge.key, res.rows || [], 5);
      if (!lines.length) {
        await message.reply(`No leaderboard entries found for ${res.challenge.name}.`);
        return;
      }

      await message.reply(
        `🏆 **${res.challenge.name}** (top ${Math.min(5, lines.length)})\n` +
          lines.join("\n")
      );
    },
    "!leaderboard <challenge> — show cached TPPC RPG leaderboard",
    { aliases: ["!lb"], category: "Info" }
  );
}

export const __testables = {
  parseSsAnne,
  parseSafariZone,
  parseSpeedTower,
  parseRoulette,
  parseTrainingChallenge,
  parseTrainerRanks,
  parsePokemonRanks,
  parsePokemonPageCount,
  renderTopRows,
};
