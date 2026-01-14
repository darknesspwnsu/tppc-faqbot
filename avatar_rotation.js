// avatar_rotation.js
//
// Rotates the bot avatar based on the current date.

import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./shared/logger.js";
import { clearTimer, startTimeout } from "./shared/timer_utils.js";
import { AVATAR_ROTATION_ENABLED, AVATAR_ROTATION_RULES } from "./configs/avatar_rotation.js";

const CHECK_TIMEZONE = "America/New_York";
const CHECK_HOUR = 0;
const CHECK_MINUTE = 1;

let timer = null;
let lastAppliedKey = null;

function dateKey({ month, day }) {
  return month * 100 + day;
}

function rangeMatches(key, startKey, endKey) {
  if (startKey <= endKey) return key >= startKey && key <= endKey;
  return key >= startKey || key <= endKey;
}

export function ruleMatches(date, rule) {
  if (!rule) return false;

  const month = date.getMonth();
  const day = date.getDate();

  if (Array.isArray(rule.ranges) && rule.ranges.length > 0) {
    const key = dateKey({ month, day });
    for (const r of rule.ranges) {
      if (!r?.start || !r?.end) continue;
      const startKey = dateKey(r.start);
      const endKey = dateKey(r.end);
      if (rangeMatches(key, startKey, endKey)) return true;
    }
  }

  return false;
}

export function selectRuleForDate(date, rules = AVATAR_ROTATION_RULES) {
  for (const rule of rules || []) {
    if (ruleMatches(date, rule)) return rule;
  }
  return null;
}

export function resolveAvatarChoice(
  date,
  { overridePath = "", rules = AVATAR_ROTATION_RULES } = {}
) {
  const override = String(overridePath || "").trim();
  if (override) {
    return { file: override, ruleId: "override" };
  }

  const rule = selectRuleForDate(date, rules);
  if (!rule?.file) return null;
  return { file: rule.file, ruleId: rule.id };
}

function computeNextDelayMs() {
  const now = new Date();
  const nowParts = getZonedParts(now, CHECK_TIMEZONE);
  const todayTarget = makeZonedDate(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: CHECK_HOUR,
      minute: CHECK_MINUTE,
      second: 0,
    },
    CHECK_TIMEZONE
  );

  let target = todayTarget;
  if (target.getTime() <= now.getTime()) {
    const tomorrowParts = addZonedDays(nowParts, 1, CHECK_TIMEZONE);
    target = makeZonedDate(
      {
        year: tomorrowParts.year,
        month: tomorrowParts.month,
        day: tomorrowParts.day,
        hour: CHECK_HOUR,
        minute: CHECK_MINUTE,
        second: 0,
      },
      CHECK_TIMEZONE
    );
  }

  return Math.max(1_000, target.getTime() - now.getTime());
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type === "year") out.year = Number(part.value);
    if (part.type === "month") out.month = Number(part.value);
    if (part.type === "day") out.day = Number(part.value);
    if (part.type === "hour") out.hour = Number(part.value);
    if (part.type === "minute") out.minute = Number(part.value);
    if (part.type === "second") out.second = Number(part.value);
  }
  normalizeMidnight(out);
  return out;
}

function normalizeMidnight(out) {
  if (out.hour !== 24) return;
  out.hour = 0;
}

function makeZonedDate({ year, month, day, hour, minute, second }, timeZone) {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = new Date(desiredUtc);
  for (let i = 0; i < 2; i += 1) {
    const parts = getZonedParts(guess, timeZone);
    const actualUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diffMs = desiredUtc - actualUtc;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

function addZonedDays(parts, days, timeZone) {
  const noon = makeZonedDate(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 12,
      minute: 0,
      second: 0,
    },
    timeZone
  );
  const shifted = new Date(
    Date.UTC(
      noon.getUTCFullYear(),
      noon.getUTCMonth(),
      noon.getUTCDate() + days,
      12,
      0,
      0
    )
  );
  return getZonedParts(shifted, timeZone);
}

async function applyAvatar(client, reason) {
  if (!client?.user) {
    logger.warn("avatar_rotation.missing_client", { reason });
    return;
  }

  const now = new Date();
  const month = now.getMonth();
  const choice = resolveAvatarChoice(now, { overridePath: process.env.AVATAR_OVERRIDE });
  if (!choice?.file) {
    logger.warn("avatar_rotation.no_rule", { month, reason });
    return;
  }

  const filePath = path.resolve(process.cwd(), choice.file);
  if (filePath === lastAppliedKey) return;

  try {
    const buffer = await fs.readFile(filePath);
    await client.user.setAvatar(buffer);
    lastAppliedKey = filePath;
    logger.info("avatar_rotation.updated", {
      month,
      rule: choice.ruleId,
      file: choice.file,
      reason,
    });
  } catch (err) {
    logger.warn("avatar_rotation.update_failed", {
      month,
      rule: choice.ruleId,
      file: choice.file,
      reason,
      error: logger.serializeError(err),
    });
  }
}

function scheduleNext(client) {
  const delay = computeNextDelayMs();
  const now = new Date();
  const target = new Date(now.getTime() + delay);
  logger.info("avatar_rotation.next_check", {
    now: now.toISOString(),
    target: target.toISOString(),
    delayMs: delay,
    timeZone: CHECK_TIMEZONE,
  });
  timer = startTimeout({
    label: "avatar_rotation.daily",
    ms: delay,
    fn: () => {
      void applyAvatar(client, "scheduled");
      scheduleNext(client);
    },
  });
}

export function startAvatarRotation(context = {}) {
  if (!AVATAR_ROTATION_ENABLED) {
    logger.info("avatar_rotation.disabled");
    return;
  }

  const { client } = context;
  void applyAvatar(client, "startup");
  scheduleNext(client);
}

export function stopAvatarRotation() {
  clearTimer(timer, "avatar_rotation.daily");
  timer = null;
}

export const __testables = {
  computeNextDelayMs,
  makeZonedDate,
  addZonedDays,
  getZonedParts,
};
