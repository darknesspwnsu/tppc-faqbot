import { describe, expect, it } from "vitest";
import { ADVENT_DEFAULT_PERIOD, ADVENT_DEV_BOT_ID, getAdventClaimPeriod } from "../../configs/advent.js";

describe("Advent dev period configuration", () => {
  it("keeps production dates even if the override is set or malformed", () => {
    for (const botId of [undefined, "production-bot", "22222"]) {
      for (const raw of ["10-01..10-25", "invalid"]) {
        expect(getAdventClaimPeriod(botId, { ADVENT_DEV_CLAIM_PERIOD: raw })).toEqual(ADVENT_DEFAULT_PERIOD);
      }
    }
  });

  it("opts the identified dev bot into a valid period and defaults when unset", () => {
    expect(getAdventClaimPeriod(ADVENT_DEV_BOT_ID, {})).toEqual(ADVENT_DEFAULT_PERIOD);
    expect(getAdventClaimPeriod(ADVENT_DEV_BOT_ID, { ADVENT_DEV_CLAIM_PERIOD: "10-01..10-25" })).toEqual({
      startMonth: 10, startDay: 1, endMonth: 10, endDay: 25, devOverride: true,
    });
    expect(getAdventClaimPeriod(ADVENT_DEV_BOT_ID, { ADVENT_DEV_CLAIM_PERIOD: "02-29..03-01" })).toMatchObject({ startMonth: 2, startDay: 29, endMonth: 3 });
  });

  it.each(["invalid", "10-1..10-25", "00-01..10-25", "10-00..10-25", "10-01..13-01", "04-31..05-01", "02-30..03-01", "10-25..10-01", "12-25..01-01"])("rejects malformed or reversed dev period %s", (raw) => {
    expect(() => getAdventClaimPeriod(ADVENT_DEV_BOT_ID, { ADVENT_DEV_CLAIM_PERIOD: raw })).toThrow("Invalid ADVENT_DEV_CLAIM_PERIOD");
  });
});
