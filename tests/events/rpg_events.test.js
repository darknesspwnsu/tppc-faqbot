import { describe, expect, it } from "vitest";

import {
  computeEventWindow,
  computeNextStart,
  RPG_EVENT_TIMEZONE,
  __testables,
  RPG_EVENT_OVERRIDES,
} from "../../events/rpg_events.js";

describe("rpg events date helpers", () => {
  it("winter golden days window spans Dec 31 to Jan 1", () => {
    const jan1 = new Date("2026-01-01T12:00:00Z");
    const event = { id: "winter_golden_day", kind: "winter_golden_days" };
    const window = computeEventWindow(event, jan1);
    expect(window).toBeTruthy();
    const startParts = __testables.getZonedDateParts(window.start, RPG_EVENT_TIMEZONE);
    expect(startParts.month).toBe(12);
    expect(startParts.day).toBe(31);
  });

  it("monthly first event next start advances to next month", () => {
    const now = new Date("2026-02-15T05:00:00Z");
    const event = { id: "cherubi", kind: "monthly_first" };
    const next = computeNextStart(event, now);
    const parts = __testables.getZonedDateParts(next, RPG_EVENT_TIMEZONE);
    expect(parts.day).toBe(1);
    expect(parts.month).toBe(3);
  });

  it("weekly promo spans 7 days", () => {
    const now = new Date("2026-01-04T05:00:00Z"); // Sunday midnight ET
    const event = { id: "weekly_promo", kind: "weekly", weekday: 0 };
    const window = computeEventWindow(event, now);
    expect(window).toBeTruthy();
    const duration = window.end.getTime() - window.start.getTime();
    expect(duration).toBe(7 * 24 * 60 * 60_000);
  });

  it("winter golden day includes Dec 25 window", () => {
    const dec25 = new Date("2026-12-25T12:00:00Z");
    const event = { id: "winter_golden_day", kind: "winter_golden_days" };
    const window = computeEventWindow(event, dec25);
    expect(window).toBeTruthy();
    const parts = __testables.getZonedDateParts(window.start, RPG_EVENT_TIMEZONE);
    expect(parts.month).toBe(12);
    expect(parts.day).toBe(25);
  });

  it("fixed date overrides can shift the window", () => {
    RPG_EVENT_OVERRIDES.test_fixed = { "2026": { start: "2026-01-03", end: "2026-01-04" } };
    const now = new Date("2026-01-03T12:00:00Z");
    const event = { id: "test_fixed", kind: "fixed_date", month: 1, day: 1 };
    const window = computeEventWindow(event, now);
    const parts = __testables.getZonedDateParts(window.start, RPG_EVENT_TIMEZONE);
    expect(parts.month).toBe(1);
    expect(parts.day).toBe(3);
    delete RPG_EVENT_OVERRIDES.test_fixed;
  });

  it("seasonal marker rolls to next year after last marker", () => {
    const now = new Date("2026-12-22T05:00:00Z");
    const event = { id: "deerling", kind: "seasonal_marker" };
    const next = computeNextStart(event, now);
    const parts = __testables.getZonedDateParts(next, RPG_EVENT_TIMEZONE);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(20);
  });

  it("easter date matches known year", () => {
    const date = __testables.easterDate(2026);
    expect(date.month).toBe(4);
    expect(date.day).toBe(5);
  });
});
