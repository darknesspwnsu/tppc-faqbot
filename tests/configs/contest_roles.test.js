import { describe, it, expect } from "vitest";

import { CONTEST_ROLES_BY_GUILD } from "../../configs/contest_roles.js";

function isIdString(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

describe("contest_roles config", () => {
  it("uses numeric string ids for guilds/channels/roles", () => {
    for (const [guildId, channels] of Object.entries(CONTEST_ROLES_BY_GUILD)) {
      expect(isIdString(guildId)).toBe(true);
      for (const [channelId, config] of Object.entries(channels || {})) {
        expect(isIdString(channelId)).toBe(true);
        expect(isIdString(config?.roleId)).toBe(true);
      }
    }
  });

  it("validate applyTo is a string array when present", () => {
    for (const channels of Object.values(CONTEST_ROLES_BY_GUILD)) {
      for (const config of Object.values(channels || {})) {
        if (!("applyTo" in config)) continue;
        expect(Array.isArray(config.applyTo)).toBe(true);
        expect(config.applyTo.every((v) => typeof v === "string")).toBe(true);
      }
    }
  });
});
