import { describe, expect, it } from "vitest";

import { computeSpecialDayWindow, easterDate } from "../../events/special_days.js";

describe("special days", () => {
  it("computes fixed date window", () => {
    const now = new Date("2026-07-01T05:00:00Z");
    const defaults = { timezone: "America/New_York", announceHour: 0, announceMinute: 0 };
    const day = { kind: "fixed_date", month: 7, day: 1 };
    const window = computeSpecialDayWindow(day, defaults, now);
    expect(window).toBeTruthy();
  });

  it("computes easter date", () => {
    const date = easterDate(2026);
    expect(date.month).toBe(4);
    expect(date.day).toBe(5);
  });
});
