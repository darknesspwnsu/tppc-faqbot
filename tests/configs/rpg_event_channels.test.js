import { describe, expect, it } from "vitest";
import { RPG_EVENT_CHANNELS_BY_GUILD } from "../../configs/rpg_event_channels.js";

function isSnowflake(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

describe("rpg_event_channels config", () => {
  it("stores guild and channel ids as exact snowflake strings", () => {
    const entries = Object.entries(RPG_EVENT_CHANNELS_BY_GUILD || {});
    expect(entries.length).toBeGreaterThan(0);

    for (const [guildId, channelIds] of entries) {
      expect(isSnowflake(guildId)).toBe(true);
      expect(Array.isArray(channelIds)).toBe(true);
      expect(channelIds.length).toBeGreaterThan(0);
      for (const channelId of channelIds) {
        expect(isSnowflake(channelId)).toBe(true);
      }
    }
  });
});
