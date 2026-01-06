// events/special_days.js
//
// Special day announcements powered by configs/special_days.json.

import fs from "node:fs/promises";

const DEFAULTS = {
  timezone: "America/New_York",
  announceHour: 0,
  announceMinute: 0,
  enabledByDefault: true,
};

const DATA_PATH = "configs/special_days.json";

let cached = null;

export async function loadSpecialDays() {
  if (cached) return cached;
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const parsed = JSON.parse(raw || "{}");
  cached = {
    defaults: { ...DEFAULTS, ...(parsed.defaults || {}) },
    days: Array.isArray(parsed.days) ? parsed.days : [],
  };
  return cached;
}

export function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

export function getZonedDateParts(date, timeZone) {
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
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
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

export function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = getTimeZoneOffset(new Date(baseUtc), timeZone);
  let utc = baseUtc - offset;
  const offset2 = getTimeZoneOffset(new Date(utc), timeZone);
  if (offset2 !== offset) {
    utc = baseUtc - offset2;
  }
  return new Date(utc);
}

export function computeSpecialDayWindow(dayDef, defaults, now = new Date()) {
  const timeZone = defaults.timezone || DEFAULTS.timezone;
  const parts = getZonedDateParts(now, timeZone);
  let month = dayDef.month;
  let day = dayDef.day;

  if (dayDef.kind === "easter") {
    const date = easterDate(parts.year);
    month = date.month;
    day = date.day;
  }

  if (!month || !day) return null;

  const start = zonedTimeToUtc(
    {
      year: parts.year,
      month,
      day,
      hour: defaults.announceHour ?? 0,
      minute: defaults.announceMinute ?? 0,
      second: 0,
    },
    timeZone
  );
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

export const __testables = {
  easterDate,
  computeSpecialDayWindow,
  zonedTimeToUtc,
};
