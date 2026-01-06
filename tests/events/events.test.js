import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", () => ({ getDb: vi.fn(() => ({ execute: vi.fn(async () => [[]]) })) }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { incrementSchedulerRun: vi.fn() } }));
vi.mock("../../shared/dm.js", () => ({ sendDm: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../configs/rpg_event_channels.js", () => ({ RPG_EVENT_CHANNELS_BY_GUILD: {} }));
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
});
