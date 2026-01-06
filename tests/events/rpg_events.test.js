import { describe, expect, it } from "vitest";

import {
  computeEventWindow,
  computeNextStart,
  RPG_EVENT_TIMEZONE,
  __testables,
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

  it("easter date matches known year", () => {
    const date = __testables.easterDate(2026);
    expect(date.month).toBe(4);
    expect(date.day).toBe(5);
  });
});
