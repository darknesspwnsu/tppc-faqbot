import { describe, expect, it, vi } from "vitest";

import { computeSpecialDayWindow, easterDate, getZonedDateParts } from "../../events/special_days.js";

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

  it("loads special days config with defaults", async () => {
    vi.resetModules();
    vi.mock("node:fs/promises", () => ({
      default: {
        readFile: vi.fn(async () =>
          JSON.stringify({
            defaults: { announceHour: 6 },
            days: [{ id: "test", name: "Test", kind: "fixed_date", month: 1, day: 2 }],
          })
        ),
      },
    }));

    const mod = await import("../../events/special_days.js");
    const data = await mod.loadSpecialDays();
    expect(data.defaults.announceHour).toBe(6);
    expect(data.defaults.timezone).toBe("America/New_York");
    expect(data.days).toHaveLength(1);
  });

  it("returns null when missing month/day", () => {
    const now = new Date("2026-07-01T05:00:00Z");
    const defaults = { timezone: "America/New_York", announceHour: 0, announceMinute: 0 };
    const day = { kind: "fixed_date" };
    const window = computeSpecialDayWindow(day, defaults, now);
    expect(window).toBeNull();
  });

  it("computes easter window for the current year", () => {
    const now = new Date("2026-03-01T05:00:00Z");
    const defaults = { timezone: "America/New_York", announceHour: 0, announceMinute: 0 };
    const day = { kind: "easter" };
    const window = computeSpecialDayWindow(day, defaults, now);
    expect(window).toBeTruthy();
    const parts = getZonedDateParts(window.start, defaults.timezone);
    expect(parts.month).toBe(4);
    expect(parts.day).toBe(5);
  });
});
