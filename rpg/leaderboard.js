// rpg/leaderboard.js
//
// Cached leaderboards for TPPC RPG challenges.

import { RpgClient } from "./rpg_client.js";
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
};

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

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseRowsFromTable(html) {
  const rows = [];
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) rows.push(m[1]);
  return rows;
}

function parseCells(rowHtml) {
  const cells = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(String(rowHtml || ""))) !== null) cells.push(m[1]);
  return cells;
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

function parseProfileLink(cellHtml) {
  const m = /profile\.php\?id=(\d+)/i.exec(String(cellHtml || ""));
  const name = stripTags(cellHtml);
  return { trainerId: m?.[1] || null, name };
}

function parseSpeedTower(html) {
  const rows = parseRowsFromTable(html);
  const out = [];
  for (const row of rows) {
    const cells = parseCells(row);
    if (cells.length < 5) continue;
    const rankText = stripTags(cells[0]);
    if (!rankText.toLowerCase().includes("today")) continue;
    const { trainerId, name } = parseProfileLink(cells[1]);
    out.push({
      rank: rankText,
      trainer: name,
      trainerId,
      faction: stripTags(cells[2]),
      floor: stripTags(cells[3]),
      time: stripTags(cells[4]),
    });
  }
  return out;
}

function parseSsAnne(html) {
  const tableMatch = /<table[^>]*class=["']ranks["'][^>]*>([\s\S]*?)<\/table>/i.exec(String(html || ""));
  if (!tableMatch) return [];
  const rows = parseRowsFromTable(tableMatch[1]);
  const out = [];
  for (const row of rows) {
    const cells = parseCells(row);
    if (cells.length < 4) continue;
    const rank = stripTags(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseProfileLink(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      faction: stripTags(cells[2]),
      wins: stripTags(cells[3]),
    });
  }
  return out;
}

function parseSafariZone(html) {
  const tableMatch = /<table[^>]*class=["']ranks["'][^>]*>([\s\S]*?)<\/table>/i.exec(String(html || ""));
  if (!tableMatch) return [];
  const rows = parseRowsFromTable(tableMatch[1]);
  const out = [];
  for (const row of rows) {
    const cells = parseCells(row);
    if (cells.length < 4) continue;
    if (isHeaderRank(stripTags(cells[0]))) continue;
    out.push({
      rank: stripTags(cells[0]),
      trainer: stripTags(cells[1]),
      pokemon: stripTags(cells[2]),
      points: stripTags(cells[3]),
    });
  }
  return out;
}

function parseRoulette(html) {
  const h3Match = /<h3[^>]*>Standings[\s\S]*?<\/h3>\s*<table[^>]*class=["']ranks["'][^>]*>([\s\S]*?)<\/table>/i.exec(
    String(html || "")
  );
  if (!h3Match) return [];
  const tableHtml = h3Match[1];
  const rows = parseRowsFromTable(tableHtml);
  const out = [];
  for (const row of rows) {
    const cells = parseCells(row);
    if (cells.length < 4) continue;
    const rank = stripTags(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseProfileLink(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      faction: stripTags(cells[2]),
      wins: stripTags(cells[3]),
    });
  }
  return out;
}

function parseTrainingChallenge(html) {
  const tableMatch = /<table[^>]*class=["']ranks["'][^>]*>([\s\S]*?)<\/table>/i.exec(String(html || ""));
  if (!tableMatch) return [];
  const rows = parseRowsFromTable(tableMatch[1]);
  const out = [];
  for (const row of rows) {
    const cells = parseCells(row);
    if (cells.length < 5) continue;
    const rank = stripTags(cells[0]);
    if (isHeaderRank(rank)) continue;
    const { trainerId, name } = parseProfileLink(cells[1]);
    out.push({
      rank,
      trainer: name,
      trainerId,
      pokemon: stripTags(cells[2]),
      level: stripTags(cells[3]),
      number: stripTags(cells[4]),
    });
  }
  return out;
}

function renderTopRows(challengeKey, rows) {
  const out = [];
  const top = rows.filter((row) => !isHeaderRow(row)).slice(0, 5);
  for (const row of top) {
    if (challengeKey === "speedtower") {
      out.push(
        `${row.rank} — ${row.trainer} (${row.faction}) • ${row.floor} • ${row.time}`
      );
    } else if (challengeKey === "ssanne") {
      out.push(`#${row.rank} — ${row.trainer} (${row.faction}) • ${row.wins}`);
    } else if (challengeKey === "roulette") {
      out.push(`#${row.rank} — ${row.trainer} (${row.faction}) • ${row.wins}`);
    } else if (challengeKey === "safarizone") {
      out.push(
        `#${row.rank} — ${row.trainer} • ${row.pokemon} • ${row.points} pts`
      );
    } else if (challengeKey === "tc") {
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
  else if (challenge.key === "roulette") rows = parseRoulette(html);
  else if (challenge.key === "tc") rows = parseTrainingChallenge(html);
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
      const key = ALIASES.get(raw);
      if (!key) {
        await message.reply(
          "Usage: `!leaderboard ssanne|safarizone|tc|roulette|speedtower`"
        );
        return;
      }

      const res = await getCachedOrFetch(key, client);
      if (!res) {
        await message.reply("❌ Unknown challenge.");
        return;
      }

      const lines = renderTopRows(res.challenge.key, res.rows || []);
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
    { category: "Info" }
  );
}

export const __testables = {
  parseSsAnne,
  parseSafariZone,
  parseSpeedTower,
  parseRoulette,
  parseTrainingChallenge,
  renderTopRows,
  stripTags,
};
