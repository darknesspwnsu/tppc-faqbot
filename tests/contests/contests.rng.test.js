import { describe, expect, test, vi, afterEach } from "vitest";

import { chooseOne, runElimFromItems, parseSecondsToMs, registerRng } from "../../contests/rng.js";

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

describe("roll command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rolls values from 1..sides", async () => {
    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const rollCall = register.expose.mock.calls.find((call) => call[0].name === "roll");
    const handler = rollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    vi.spyOn(Math, "random").mockReturnValue(0);
    await handler({ message, rest: "1d6", cmd: "!roll" });

    expect(send).toHaveBeenCalledWith("<@u1> 1");
  });

  test("rejects norepeat when n exceeds range size", async () => {
    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const rollCall = register.expose.mock.calls.find((call) => call[0].name === "roll");
    const handler = rollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, rest: "2d1 nr", cmd: "!roll" });
    expect(send).toHaveBeenCalledWith(
      "Impossible with norepeat: you asked for 2 unique rolls but range is only 1..1 (1 unique values)."
    );
  });
});
