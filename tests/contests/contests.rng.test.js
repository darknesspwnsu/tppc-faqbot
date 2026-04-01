import { describe, expect, test, vi, afterEach } from "vitest";

vi.mock("../../games/closest_roll_wins.js", () => ({
  onAwesomeRoll: vi.fn(async () => {}),
}));

import { chooseOne, runElimFromItems, parseSecondsToMs, registerRng } from "../../contests/rng.js";
import { onAwesomeRoll } from "../../games/closest_roll_wins.js";

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
    vi.useRealTimers();
  });

  test("rolls values from 1..sides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T12:00:00Z"));

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

  test("returns all ones on April Fools without bypass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const rollCall = register.expose.mock.calls.find((call) => call[0].name === "roll");
    const handler = rollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, rest: "3d6 nr", cmd: "!roll" });

    expect(send).toHaveBeenCalledWith("<@u1> 1, 1, 1 (norepeat mode: ON)");
  });

  test("bypass prefix restores normal roll behavior on April Fools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const rollCall = register.expose.mock.calls.find((call) => call[0].name === "roll");
    const handler = rollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    vi.spyOn(Math, "random").mockReturnValue(0.999);
    await handler({ message, rest: "1d6", cmd: "!roll", aprilFoolsBypass: true });

    expect(send).toHaveBeenCalledWith("<@u1> 6");
  });
});

describe("dexroll command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("rolls a Pokemon in default range when no args are provided", async () => {
    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const dexRollCall = register.expose.mock.calls.find((call) => call[0].name === "dexroll");
    const handler = dexRollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    vi.spyOn(Math, "random").mockReturnValue(0);
    await handler({ message, rest: "", cmd: "!dexroll" });

    expect(send).toHaveBeenCalledWith("#1 - Bulbasaur");
  });

  test("supports gen mode", async () => {
    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const dexRollCall = register.expose.mock.calls.find((call) => call[0].name === "dexroll");
    const handler = dexRollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    vi.spyOn(Math, "random").mockReturnValue(0);
    await handler({ message, rest: "gen 1", cmd: "!dexroll" });

    expect(send).toHaveBeenCalledWith("#1 - Bulbasaur");
  });

  test("validates lower/upper ranges after max-supported cap", async () => {
    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const dexRollCall = register.expose.mock.calls.find((call) => call[0].name === "dexroll");
    const handler = dexRollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, rest: "9999 9999", cmd: "!dexroll" });

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Invalid dex range:"));
  });

  test("always returns #1 on April Fools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const dexRollCall = register.expose.mock.calls.find((call) => call[0].name === "dexroll");
    const handler = dexRollCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, rest: "gen 8", cmd: "!dexroll" });

    expect(send).toHaveBeenCalledWith("#1 - Bulbasaur");
  });
});

describe("April Fools command overrides", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("choose always returns cheese on April Fools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const chooseCall = register.expose.mock.calls.find((call) => call[0].name === "choose");
    const handler = chooseCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, rest: "red blue green", cmd: "!choose" });

    expect(send).toHaveBeenCalledWith("cheese");
  });

  test("awesome shows 0 percent on April Fools but keeps real roll for ClosestRoll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const awesomeCall = register.expose.mock.calls.find((call) => call[0].name === "awesome");
    const handler = awesomeCall[0].handler;

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await handler({ message, cmd: "!awesome" });

    expect(send).toHaveBeenCalledWith("<@u1> is 0% awesome!");
    expect(onAwesomeRoll).toHaveBeenCalledWith(message, 51);
  });

  test("coinflip lands on its side on April Fools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const register = vi.fn();
    register.expose = vi.fn();
    registerRng(register);

    const coinflipCall = register.mock.calls.find((call) => call[0] === "!coinflip");
    const handler = coinflipCall[1];

    const send = vi.fn(async () => {});
    const message = { channel: { send }, author: { id: "u1" } };

    await handler({ message, cmd: "!coinflip" });

    expect(send).toHaveBeenCalledWith("<@u1> 🪙 landed on its side!");
  });
});
