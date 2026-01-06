// events/rpg_events.js
//
// RPG event date helpers.

import { RPG_EVENTS, RPG_EVENT_OVERRIDES, RPG_EVENT_TIMEZONE } from "../configs/rpg_events.js";

export { RPG_EVENTS, RPG_EVENT_OVERRIDES, RPG_EVENT_TIMEZONE };

function getZonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const weekday = get("weekday");
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday,
  };
}

function weekdayIndex(weekday) {
  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
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

function parseLocalDateTime(str) {
  const raw = String(str || "").trim();
  if (!raw) return null;
  const [datePart, timePart = "00:00"] = raw.split("T");
  const [year, month, day] = datePart.split("-").map((v) => Number(v));
  const [hour, minute] = timePart.split(":").map((v) => Number(v));
  if (!year || !month || !day) return null;
  return { year, month, day, hour: hour || 0, minute: minute || 0 };
}

function overrideWindow(eventId, year, timeZone) {
  const entry = RPG_EVENT_OVERRIDES?.[eventId]?.[String(year)];
  if (!entry) return null;
  const startParts = parseLocalDateTime(entry.start);
  const endParts = parseLocalDateTime(entry.end);
  if (!startParts || !endParts) return null;
  const start = zonedTimeToUtc(startParts, timeZone);
  const endBase = zonedTimeToUtc(endParts, timeZone);
  const end = new Date(endBase.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

function fixedDateWindow({ year, month, day, timeZone, eventId }) {
  const override = overrideWindow(eventId, year, timeZone);
  if (override) return override;
  const start = zonedTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

function monthlyFirstWindow({ year, month, timeZone }) {
  const start = zonedTimeToUtc({ year, month, day: 1, hour: 0, minute: 0 }, timeZone);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

function weeklyWindow({ now, weekday, timeZone, durationDays = 1 }) {
  const parts = getZonedDateParts(now, timeZone);
  const currentWeekday = weekdayIndex(parts.weekday);
  const delta = (weekday - currentWeekday + 7) % 7;
  const base = zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0 },
    timeZone
  );
  const start = new Date(base.getTime() + delta * 24 * 60 * 60_000);
  const end = new Date(start.getTime() + durationDays * 24 * 60 * 60_000);
  return { start, end };
}

function goldenDaysWindow({ now, timeZone }) {
  const parts = getZonedDateParts(now, timeZone);
  const isJan1 = parts.month === 1 && parts.day === 1;
  const startYear = isJan1 ? parts.year - 1 : parts.year;
  const start = zonedTimeToUtc(
    { year: startYear, month: 12, day: 31, hour: 0, minute: 0 },
    timeZone
  );
  const end = new Date(start.getTime() + 48 * 60 * 60_000);
  return { start, end };
}

function easterDate(year) {
  // Anonymous Gregorian algorithm.
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

function seasonalMarkerDates(year) {
  // Approximate equinox/solstice dates; override per year if needed.
  return [
    { month: 3, day: 20 },
    { month: 6, day: 21 },
    { month: 9, day: 22 },
    { month: 12, day: 21 },
  ];
}

function seasonalWindow({ now, timeZone, eventId }) {
  const parts = getZonedDateParts(now, timeZone);
  const override = overrideWindow(eventId, parts.year, timeZone);
  if (override) return override;
  const markers = seasonalMarkerDates(parts.year);
  const todayKey = parts.month * 100 + parts.day;
  let marker = markers.find((m) => m.month * 100 + m.day === todayKey);
  if (!marker) return null;
  const start = zonedTimeToUtc(
    { year: parts.year, month: marker.month, day: marker.day, hour: 0, minute: 0 },
    timeZone
  );
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { start, end };
}

function winterGoldenWindows({ year, timeZone, eventId }) {
  const override = overrideWindow(eventId, year, timeZone);
  if (override) return [override];

  const dec25 = zonedTimeToUtc({ year, month: 12, day: 25, hour: 0, minute: 0 }, timeZone);
  const dec31 = zonedTimeToUtc({ year, month: 12, day: 31, hour: 0, minute: 0 }, timeZone);
  return [
    { start: dec25, end: new Date(dec25.getTime() + 24 * 60 * 60_000) },
    { start: dec31, end: new Date(dec31.getTime() + 48 * 60 * 60_000) },
  ];
}

export function computeEventWindow(event, now = new Date()) {
  const timeZone = RPG_EVENT_TIMEZONE;
  const parts = getZonedDateParts(now, timeZone);
  switch (event.kind) {
    case "radio_tower":
      return null;
    case "monthly_first":
      return monthlyFirstWindow({ year: parts.year, month: parts.month, timeZone });
    case "weekly":
      return weeklyWindow({
        now,
        weekday: event.weekday ?? 0,
        timeZone,
        durationDays: event.id === "weekly_promo" ? 7 : 1,
      });
    case "fixed_date":
      return fixedDateWindow({ year: parts.year, month: event.month, day: event.day, timeZone, eventId: event.id });
    case "easter": {
      const override = overrideWindow(event.id, parts.year, timeZone);
      if (override) return override;
      const date = easterDate(parts.year);
      const start = zonedTimeToUtc(
        { year: parts.year, month: date.month, day: date.day, hour: 0, minute: 0 },
        timeZone
      );
      const end = new Date(start.getTime() + 24 * 60 * 60_000);
      return { start, end };
    }
    case "winter_golden_days": {
      const windows = [
        ...winterGoldenWindows({ year: parts.year - 1, timeZone, eventId: event.id }),
        ...winterGoldenWindows({ year: parts.year, timeZone, eventId: event.id }),
      ];
      return windows.find((window) => now >= window.start && now < window.end) || null;
    }
    case "seasonal_marker":
      return seasonalWindow({ now, timeZone, eventId: event.id });
    default:
      return null;
  }
}

export function computeNextStart(event, now = new Date()) {
  const timeZone = RPG_EVENT_TIMEZONE;
  const parts = getZonedDateParts(now, timeZone);
  const nowMs = now.getTime();

  switch (event.kind) {
    case "radio_tower":
      return null;
    case "monthly_first": {
      const start = monthlyFirstWindow({ year: parts.year, month: parts.month, timeZone }).start;
      if (nowMs < start.getTime()) return start;
      const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
      const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
      return monthlyFirstWindow({ year: nextYear, month: nextMonth, timeZone }).start;
    }
    case "weekly": {
      const window = weeklyWindow({ now, weekday: event.weekday ?? 0, timeZone });
      if (nowMs < window.start.getTime()) return window.start;
      return new Date(window.start.getTime() + 7 * 24 * 60 * 60_000);
    }
    case "fixed_date": {
      const window = fixedDateWindow({
        year: parts.year,
        month: event.month,
        day: event.day,
        timeZone,
        eventId: event.id,
      });
      if (nowMs < window.start.getTime()) return window.start;
      const next = fixedDateWindow({
        year: parts.year + 1,
        month: event.month,
        day: event.day,
        timeZone,
        eventId: event.id,
      });
      return next.start;
    }
    case "easter": {
      const override = overrideWindow(event.id, parts.year, timeZone);
      if (override && nowMs < override.start.getTime()) return override.start;
      if (!override) {
        const date = easterDate(parts.year);
        const start = zonedTimeToUtc(
          { year: parts.year, month: date.month, day: date.day, hour: 0, minute: 0 },
          timeZone
        );
        if (nowMs < start.getTime()) return start;
      }
      const nextYear = parts.year + 1;
      const nextOverride = overrideWindow(event.id, nextYear, timeZone);
      if (nextOverride) return nextOverride.start;
      const nextDate = easterDate(nextYear);
      return zonedTimeToUtc(
        { year: nextYear, month: nextDate.month, day: nextDate.day, hour: 0, minute: 0 },
        timeZone
      );
    }
    case "winter_golden_days": {
      const candidates = [];
      for (const year of [parts.year, parts.year + 1]) {
        const windows = winterGoldenWindows({ year, timeZone, eventId: event.id });
        for (const window of windows) {
          candidates.push(window.start.getTime());
        }
      }
      const next = candidates.filter((ts) => ts > nowMs).sort((a, b) => a - b)[0];
      return next ? new Date(next) : null;
    }
    case "seasonal_marker": {
      const markers = seasonalMarkerDates(parts.year);
      const todayKey = parts.month * 100 + parts.day;
      const nextMarker = markers.find((m) => m.month * 100 + m.day >= todayKey);
      if (nextMarker) {
        return zonedTimeToUtc(
          { year: parts.year, month: nextMarker.month, day: nextMarker.day, hour: 0, minute: 0 },
          timeZone
        );
      }
      const next = seasonalMarkerDates(parts.year + 1)[0];
      return zonedTimeToUtc(
        { year: parts.year + 1, month: next.month, day: next.day, hour: 0, minute: 0 },
        timeZone
      );
    }
    default:
      return null;
  }
}

export function startOfDayInZone(now = new Date(), timeZone = EVENT_TZ) {
  const parts = getZonedDateParts(now, timeZone);
  return zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0 },
    timeZone
  );
}

export const __testables = {
  getZonedDateParts,
  zonedTimeToUtc,
  easterDate,
  computeEventWindow,
  computeNextStart,
  startOfDayInZone,
};
