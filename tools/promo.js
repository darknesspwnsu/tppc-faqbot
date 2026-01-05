// tools/promo.js
//
// Promo commands (DB-backed when enabled; otherwise in-memory per guild).

import { parse } from "node-html-parser";

import { isAdminOrPrivileged } from "../auth.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { getDb, getUserTextRow, setUserText } from "../db.js";
import { RpgClient } from "../rpg/rpg_client.js";

// Store promo as a guild-scoped text in user_texts using a sentinel user_id.
const PROMO_KIND = "promo";
const PROMO_USER_ID = "__guild__";
const PROMO_URL = "https://www.tppcrpg.net/team.php";
const PROMO_TIMEZONE = "America/New_York";

// Cache promos per guild to avoid DB hits on every call.
const promoCache = new Map(); // guildId -> { value, updatedAtMs }
const forceRefresh = new Set(); // guildId -> force live fetch on next read
let schedulerBooted = false;

function getZonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

function getTimeZoneOffset(date, timeZone) {
  const parts = getZonedDateParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = getTimeZoneOffset(new Date(baseUtc), timeZone);
  let utc = baseUtc - offset;
  const offset2 = getTimeZoneOffset(new Date(utc), timeZone);
  if (offset2 !== offset) {
    utc = baseUtc - offset2;
  }
  return new Date(utc);
}

function getMostRecentSundayMidnightEt(now = new Date()) {
  const parts = getZonedDateParts(now, PROMO_TIMEZONE);
  const etDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const dayIndex = etDate.getUTCDay(); // 0 = Sunday
  const sundayDate = parts.day - dayIndex;
  return zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: sundayDate, hour: 0, minute: 0, second: 0 },
    PROMO_TIMEZONE
  );
}

function nextPromoRefreshEt(now = new Date()) {
  const last = getMostRecentSundayMidnightEt(now);
  const next = new Date(last.getTime() + 7 * 24 * 60 * 60_000);
  return next.getTime() <= now.getTime() ? new Date(next.getTime() + 7 * 24 * 60 * 60_000) : next;
}

function isPromoStale(updatedAtMs, now = Date.now()) {
  if (!Number.isFinite(updatedAtMs)) return true;
  const lastRollover = getMostRecentSundayMidnightEt(new Date(now)).getTime();
  return updatedAtMs < lastRollover;
}

function parsePromoPrize(html) {
  const root = parse(String(html || ""));
  const table = root.querySelector("table.ranks.facrew");
  if (!table) return "";
  const row = table.querySelector("tbody tr");
  if (!row) return "";
  const tds = row.querySelectorAll("td");
  if (tds.length < 2) return "";
  const prize = String(tds[1].text || "").replace(/\s+/g, " ").trim();
  return prize;
}

async function fetchCurrentPromo(client) {
  const html = await client.fetchPage(PROMO_URL);
  return parsePromoPrize(html);
}

async function listPromoGuilds() {
  try {
    const db = getDb();
    const [rows] = await db.execute(
      `SELECT DISTINCT guild_id FROM user_texts WHERE user_id = ? AND kind = ?`,
      [PROMO_USER_ID, PROMO_KIND]
    );
    return (rows || []).map((row) => String(row.guild_id)).filter(Boolean);
  } catch (err) {
    console.warn("[promo] failed to load guild list:", err);
    return [];
  }
}

async function refreshPromoForGuilds(guildIds, reason = "scheduled") {
  if (!process.env.RPG_USERNAME || !process.env.RPG_PASSWORD) {
    logger.warn("promo.refresh.skipped", { reason: "missing-credentials" });
    console.warn("[promo] RPG credentials not configured; skipping promo refresh.");
    void metrics.increment("promo.refresh", { reason, status: "skipped" });
    return;
  }
  if (!guildIds.length) return;
  let promo = "";
  try {
    const client = new RpgClient();
    promo = await fetchCurrentPromo(client);
  } catch (err) {
    logger.warn("promo.fetch.error", { reason, error: logger.serializeError(err) });
    console.warn(`[promo] failed to fetch current promo (${reason}):`, err);
    void metrics.increment("promo.refresh", { reason, status: "error" });
    return;
  }
  if (!promo) return;
  for (const guildId of guildIds) {
    await setPromoForGuild(guildId, promo);
  }
  void metrics.increment("promo.refresh", { reason, status: "ok" });
}

async function ensurePromoScheduler() {
  if (schedulerBooted) return;
  schedulerBooted = true;

  try {
    const guildIds = await listPromoGuilds();
    if (guildIds.length) {
      await refreshPromoForGuilds(guildIds, "startup");
    }
  } catch (err) {
    logger.warn("promo.refresh.error", { reason: "startup", error: logger.serializeError(err) });
    console.warn("[promo] startup promo refresh failed:", err);
    void metrics.increment("promo.refresh", { reason: "startup", status: "error" });
  }

  const now = new Date();
  const runAt = nextPromoRefreshEt(now);
  let delay = runAt.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 0) delay = 60_000;

  setTimeout(async function tick() {
    try {
      const ids = await listPromoGuilds();
      await refreshPromoForGuilds(ids, "scheduled");
    } catch (err) {
      logger.warn("promo.refresh.error", { reason: "scheduled", error: logger.serializeError(err) });
      console.warn("[promo] scheduled promo refresh failed:", err);
      void metrics.increment("promo.refresh", { reason: "scheduled", status: "error" });
    }
    const next = nextPromoRefreshEt(new Date());
    let nextDelay = next.getTime() - Date.now();
    if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 7 * 24 * 60 * 60_000;
    setTimeout(tick, nextDelay);
  }, delay);
}

async function getPromoForGuild(guildId) {
  if (!guildId) return "Not set";

  if (forceRefresh.has(String(guildId))) {
    forceRefresh.delete(String(guildId));
    await refreshPromoForGuilds([String(guildId)], "force-read");
    const refreshed = promoCache.get(guildId);
    if (refreshed?.value) return refreshed.value;
  }

  if (promoCache.has(guildId)) {
    const cached = promoCache.get(guildId);
    if (cached && !isPromoStale(cached.updatedAtMs)) return cached.value;
  }

  try {
    const row = await getUserTextRow({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND });
    const promo = row?.text && String(row.text).trim() ? String(row.text).trim() : "Not set";
    const updatedAtMs = row?.updatedAt ?? null;
    promoCache.set(guildId, { value: promo, updatedAtMs });
      if (isPromoStale(updatedAtMs)) {
        await refreshPromoForGuilds([String(guildId)], "stale-read");
        const refreshed = promoCache.get(guildId);
        if (refreshed?.value) return refreshed.value;
      }
    return promo;
  } catch {
    const promo = "Not set";
    promoCache.set(guildId, { value: promo, updatedAtMs: null });
    return promo;
  }
}

async function setPromoForGuild(guildId, promoText) {
  if (!guildId) return;

  const promo = String(promoText || "").trim() || "Not set";
  promoCache.set(guildId, { value: promo, updatedAtMs: Date.now() });

  try {
    await setUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND, text: promo });
  } catch {
    // Ignore DB failures; cache already updated.
  }
}

export function registerPromo(register) {
  register(
    "!promo",
    async ({ message }) => {
      const guildId = message.guild?.id;
      const promo = await getPromoForGuild(guildId);
      await message.reply(`Current promo: ${promo}`);
    },
    "!promo — shows the last promo",
    { aliases: ["!p"] }
  );

  register(
    "!setpromo",
    async ({ message, rest }) => {
      if (!isAdminOrPrivileged(message)) {
        await message.reply("You do not have permission to set the promo.");
        return;
      }

      const guildId = message.guild?.id;
      const newPromo = rest.trim();
      if (!newPromo) {
        promoCache.delete(String(guildId || ""));
        if (guildId) forceRefresh.add(String(guildId));
        await message.reply("✅ Promo cache cleared. Use !p to refetch.");
        return;
      }
      await setPromoForGuild(guildId, newPromo);

      const promo = await getPromoForGuild(guildId);
      await message.reply(`Promo updated to: ${promo}`);
    },
    "!setpromo <text> — sets the last promo",
    { admin: true }
  );
}

export function registerPromoScheduler() {
  void ensurePromoScheduler();
}

export const __testables = {
  parsePromoPrize,
  nextPromoRefreshEt,
  isPromoStale,
  getMostRecentSundayMidnightEt,
  getZonedDateParts,
  getTimeZoneOffset,
  zonedTimeToUtc,
};
