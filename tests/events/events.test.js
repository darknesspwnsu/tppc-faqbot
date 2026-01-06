import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", () => ({ getDb: vi.fn(() => ({ execute: vi.fn(async () => [[]]) })) }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { incrementSchedulerRun: vi.fn() } }));
vi.mock("../../shared/dm.js", () => ({ sendDm: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../configs/rpg_event_channels.js", () => ({ RPG_EVENT_CHANNELS_BY_GUILD: {} }));
vi.mock("../../configs/rpg_events.js", () => ({
  RPG_EVENT_TIMEZONE: "America/New_York",
  RPG_EVENT_OVERRIDES: {},
  RPG_EVENTS: [
    {
      id: "soon",
      name: "Soon Event",
      kind: "fixed_date",
      month: 2,
      day: 1,
      description: "Soon",
    },
    {
      id: "later",
      name: "Later Event",
      kind: "fixed_date",
      month: 4,
      day: 1,
      description: "Later",
    },
  ],
}));
vi.mock("../../rpg/radio_tower.js", () => ({
  detectRadioTower: vi.fn(async () => false),
  buildRadioTowerMessage: () => "Rocket!",
}));
vi.mock("../../events/special_days.js", async () => {
  const actual = await vi.importActual("../../events/special_days.js");
  return {
    ...actual,
    loadSpecialDays: async () => ({
      defaults: { timezone: "America/New_York", announceHour: 0, announceMinute: 0 },
      days: [],
    }),
  };
});

import { __testables } from "../../events/events.js";

describe("events parsing helpers", () => {
  it("parses event ids and dedupes", () => {
    const ids = __testables.parseEventIds("golden_days, team_rocket team_rocket");
    expect(ids).toEqual(["golden_days", "team_rocket"]);
  });

  it("limits upcoming events to the next two months by default", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const limited = await __testables.resolveEventsForList(now);
    expect(limited.upcoming.map((e) => e.id)).toEqual(["soon"]);

    const all = await __testables.resolveEventsForList(now, { includeAll: true });
    expect(all.upcoming.map((e) => e.id)).toEqual(["team_rocket", "soon", "later"]);
  });
});
