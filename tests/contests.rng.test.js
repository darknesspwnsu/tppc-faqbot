import { describe, expect, test } from "vitest";

import { chooseOne, runElimFromItems, parseSecondsToMs } from "../contests/rng.js";

function mockMessage() {
  return {
    guild: { id: "g1" },
    guildId: "g1",
    channelId: "c1",
    author: { id: "u1" },
    channel: { send: async () => {} },
  };
}

describe("rng helpers", () => {
  test("chooseOne returns null for empty", () => {
    expect(chooseOne([])).toBe(null);
  });

  test("parseSecondsToMs validates", () => {
    expect(parseSecondsToMs("2s").ms).toBe(2000);
    expect(parseSecondsToMs("0s").error).toBeTruthy();
    expect(parseSecondsToMs("5").error).toBeTruthy();
  });
});

describe("runElimFromItems", () => {
  test("rejects too few items", async () => {
    const res = await runElimFromItems({
      message: mockMessage(),
      delayMs: 1000,
      delaySec: 1,
      items: ["a"],
    });
    expect(res.ok).toBe(false);
  });
});
