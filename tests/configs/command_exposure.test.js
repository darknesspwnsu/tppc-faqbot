import { describe, it, expect } from "vitest";

import {
  DEFAULT_EXPOSURE,
  COMMAND_EXPOSURE_BY_GUILD,
  COMMAND_CHANNEL_POLICY_BY_GUILD,
} from "../../configs/command_exposure.js";

const VALID_EXPOSURES = new Set(["bang", "q", "off"]);

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

describe("command_exposure config", () => {
  it("uses a valid DEFAULT_EXPOSURE", () => {
    expect(VALID_EXPOSURES.has(DEFAULT_EXPOSURE)).toBe(true);
  });

  it("uses only valid exposure values per guild", () => {
    for (const [guildId, mappings] of Object.entries(COMMAND_EXPOSURE_BY_GUILD)) {
      expect(typeof guildId).toBe("string");
      for (const [logicalId, exposure] of Object.entries(mappings || {})) {
        expect(typeof logicalId).toBe("string");
        expect(VALID_EXPOSURES.has(exposure)).toBe(true);
      }
    }
  });

  it("validates channel policy shapes", () => {
    for (const [guildId, policies] of Object.entries(COMMAND_CHANNEL_POLICY_BY_GUILD)) {
      expect(typeof guildId).toBe("string");
      for (const [logicalId, policy] of Object.entries(policies || {})) {
        expect(typeof logicalId).toBe("string");
        expect(typeof policy).toBe("object");

        const keys = Object.keys(policy);
        for (const key of keys) {
          expect(["allow", "deny", "silent"].includes(key)).toBe(true);
        }

        if ("allow" in policy) expect(isStringArray(policy.allow)).toBe(true);
        if ("deny" in policy) expect(isStringArray(policy.deny)).toBe(true);
        if ("silent" in policy) expect(typeof policy.silent === "boolean").toBe(true);
      }
    }
  });
});
