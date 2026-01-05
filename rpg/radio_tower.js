// rpg/radio_tower.js
//
// Daily Radio Tower check for the Team Rocket takeover event.

import https from "node:https";
import http from "node:http";
import { parse } from "node-html-parser";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { RADIO_TOWER_ALERTS_BY_GUILD } from "../configs/radio_tower_alerts.js";

const RADIO_TOWER_URL = "https://www.tppcrpg.net/radio_tower.php";
const RADIO_TOWER_TIMEZONE = "America/New_York";
const NEEDLE = /team rocket/i;

let schedulerBooted = false;
let checkHook = null;

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

function extractInnerText(html) {
  const root = parse(String(html || ""));
  return String(root.text || "").replace(/\s+/g, " ").trim();
}

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
  let year = Number(get("year"));
  let month = Number(get("month"));
  let day = Number(get("day"));
  let hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  // Intl may return hour=24 at midnight; normalize to 00:00 same day.
  if (hour === 24) {
    hour = 0;
  }

  return { year, month, day, hour, minute, second };
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

function nextMidnightEt(now = new Date()) {
  const parts = getZonedDateParts(now, RADIO_TOWER_TIMEZONE);
  const todayMidnight = zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0 },
    RADIO_TOWER_TIMEZONE
  );
  if (todayMidnight.getTime() > now.getTime()) return todayMidnight;
  return new Date(todayMidnight.getTime() + 24 * 60 * 60_000);
}

async function postToChannels(client, content) {
  const entries = Object.entries(RADIO_TOWER_ALERTS_BY_GUILD || {});
  for (const [guildId, channelIds] of entries) {
    if (!client.guilds.cache.get(String(guildId))) continue;
    for (const channelId of channelIds || []) {
      try {
        const channel = await client.channels.fetch(String(channelId));
        if (!channel || typeof channel.send !== "function") continue;
        await channel.send(content);
      } catch (err) {
        logger.warn("radio_tower.notify.failed", {
          guildId,
          channelId,
          error: logger.serializeError(err),
        });
      }
    }
  }
}

export async function checkRadioTower(client, reason = "scheduled") {
  try {
    const html = await fetchText(RADIO_TOWER_URL);
    const text = extractInnerText(html);
    const hit = NEEDLE.test(text);

    if (hit) {
      const msg =
        "🚨 **Team Rocket Takeover detected at the Radio Tower!**\n" +
        "The **Secret Key** is available (used to unlock Shaymin).";
      await postToChannels(client, msg);
    }

    void metrics.incrementSchedulerRun("radio_tower", "ok");
    logger.info("radio_tower.check.ok", { reason, hit });
  } catch (err) {
    void metrics.incrementSchedulerRun("radio_tower", "error");
    logger.warn("radio_tower.check.failed", { reason, error: logger.serializeError(err) });
  }
}

export function scheduleRadioTowerMonitor(client) {
  if (schedulerBooted) return;
  schedulerBooted = true;

  const startupCheck = checkHook || checkRadioTower;
  void startupCheck(client, "startup");

  const now = new Date();
  const runAt = nextMidnightEt(now);
  let delay = runAt.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 0) delay = 60_000;

  setTimeout(function tick() {
    void checkRadioTower(client, "scheduled");
    const next = nextMidnightEt(new Date());
    let nextDelay = next.getTime() - Date.now();
    if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 24 * 60 * 60_000;
    setTimeout(tick, nextDelay);
  }, delay);
}

export const __testables = {
  extractInnerText,
  nextMidnightEt,
  getZonedDateParts,
  __resetScheduler: () => {
    schedulerBooted = false;
  },
  __setCheckHook: (hook) => {
    checkHook = hook;
  },
};

export function registerSchedulerForRadioTower({ client } = {}) {
  registerScheduler("radio_tower", () => scheduleRadioTowerMonitor(client));
}
