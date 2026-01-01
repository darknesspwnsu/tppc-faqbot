import { describe, expect, it, vi } from "vitest";

vi.mock("../../games/framework.js", async () => {
  const actual = await vi.importActual("../../games/framework.js");
  return {
    ...actual,
    reply: vi.fn(),
  };
});

import * as framework from "../../games/framework.js";
import {
  getMentionedUsers,
  parseMentionToken,
  parseMinMaxRangeToken,
  registerHelpAndRules,
  validateJoinAndMaxForMode,
} from "../../games/helpers.js";

describe("games/helpers", () => {
  it("parses min-max range tokens", () => {
    expect(parseMinMaxRangeToken("1-3")).toEqual({ min: 1, max: 3 });
    expect(parseMinMaxRangeToken("1–3")).toEqual({ min: 1, max: 3 });
    expect(parseMinMaxRangeToken("1—3")).toEqual({ min: 1, max: 3 });
    expect(parseMinMaxRangeToken("1 - x")).toBeNull();
  });

  it("parses mention tokens", () => {
    expect(parseMentionToken("<@123>")).toBe("123");
    expect(parseMentionToken("<@!456>")).toBe("456");
    expect(parseMentionToken(" <@789> ")).toBe("789");
    expect(parseMentionToken("123")).toBeNull();
  });

  it("returns mentioned users from message objects", () => {
    const users = new Map([
      ["1", { id: "1" }],
      ["2", { id: "2" }],
    ]);
    expect(getMentionedUsers({ mentions: { users } })).toEqual([
      { id: "1" },
      { id: "2" },
    ]);
    expect(getMentionedUsers(null)).toEqual([]);
  });

  it("registers help and rules commands with reply handlers", async () => {
    const register = vi.fn();

    registerHelpAndRules(register, {
      id: "foo",
      label: "Foo",
      helpText: "Help text",
      rulesText: "Rules text",
    });

    expect(register).toHaveBeenCalledTimes(2);
    const [helpCall, rulesCall] = register.mock.calls;
    expect(helpCall[0]).toBe("!foohelp");
    expect(rulesCall[0]).toBe("!foorules");

    const message = { id: "m1" };
    await helpCall[1]({ message });
    await rulesCall[1]({ message });

    expect(framework.reply).toHaveBeenCalledWith({ message }, "Help text");
    expect(framework.reply).toHaveBeenCalledWith({ message }, "Rules text");
  });

  it("validates join/max inputs for mention and non-mention modes", () => {
    expect(
      validateJoinAndMaxForMode({
        hasMentions: true,
        joinSeconds: 10,
        maxPlayers: 4,
        mentionErrorText: "mention error",
      })
    ).toEqual({ ok: false, err: "mention error" });

    expect(
      validateJoinAndMaxForMode({
        hasMentions: true,
      })
    ).toEqual({ ok: true, joinSeconds: null, maxPlayers: null });

    expect(
      validateJoinAndMaxForMode({
        hasMentions: false,
        defaultJoinSeconds: 10,
        joinMin: 5,
        joinMax: 20,
        joinErrorText: "join error",
      })
    ).toEqual({ ok: true, joinSeconds: 10, maxPlayers: null });

    expect(
      validateJoinAndMaxForMode({
        hasMentions: false,
        joinSeconds: 1,
        joinMin: 5,
        joinMax: 20,
        joinErrorText: "join error",
      })
    ).toEqual({ ok: false, err: "join error" });

    expect(
      validateJoinAndMaxForMode({
        hasMentions: false,
        joinSeconds: 10,
        joinMin: 5,
        joinMax: 20,
        maxPlayers: 99,
        maxMin: 2,
        maxMax: 10,
        joinErrorText: "join error",
        maxErrorText: "max error",
      })
    ).toEqual({ ok: false, err: "max error" });
  });
});
