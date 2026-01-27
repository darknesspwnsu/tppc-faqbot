import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getUserText: vi.fn(),
  setUserText: vi.fn(),
  deleteUserText: vi.fn(),
}));

vi.mock("../../db.js", () => dbMocks);

import { registerTradeCommands } from "../../trades/trade_commands.js";

function makeRegister() {
  const calls = [];
  return {
    expose: (cfg) => calls.push(cfg),
    get calls() {
      return calls;
    },
  };
}

function getHandler(register, name) {
  return register.calls.find((c) => c.name === name)?.handler;
}

function makeMessage({
  guildId = "g1",
  authorId = "u1",
  mentions = [],
} = {}) {
  return {
    guild: { id: guildId },
    author: { id: authorId },
    channel: { send: vi.fn(async () => ({})) },
    reply: vi.fn(async () => ({})),
    mentions: {
      users: new Map(mentions.map((u) => [u.id, u])),
    },
  };
}

describe("trade_commands.js", () => {
  beforeEach(() => {
    dbMocks.getUserText.mockReset();
    dbMocks.setUserText.mockReset();
    dbMocks.deleteUserText.mockReset();
  });

  it("handles add for ft", async () => {
    const register = makeRegister();
    registerTradeCommands(register);

    const handler = getHandler(register, "ft");
    const message = makeMessage();

    await handler({ message, rest: "add pikachu", cmd: "?ft" });

    expect(dbMocks.setUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      kind: "ft",
      text: "pikachu",
    });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("Trading list saved")
    );
  });

  it("handles del when list exists", async () => {
    const register = makeRegister();
    registerTradeCommands(register);

    const handler = getHandler(register, "lf");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce("old list");

    await handler({ message, rest: "del", cmd: "?lf" });

    expect(dbMocks.deleteUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      kind: "lf",
    });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("list cleared")
    );
  });

  it("handles append for ft with existing list", async () => {
    const register = makeRegister();
    registerTradeCommands(register);

    const handler = getHandler(register, "ft");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce("pikachu");

    await handler({ message, rest: "append eevee", cmd: "?ft" });

    expect(dbMocks.setUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      kind: "ft",
      text: "pikachu, eevee",
    });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("list updated")
    );
  });

  it("handles append when list is empty", async () => {
    const register = makeRegister();
    registerTradeCommands(register);

    const handler = getHandler(register, "lf");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce(null);

    await handler({ message, rest: "append charmander", cmd: "?lf" });

    expect(dbMocks.setUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      kind: "lf",
      text: "charmander",
    });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("list updated")
    );
  });

  it("renders mention lookups", async () => {
    const register = makeRegister();
    registerTradeCommands(register);

    const handler = getHandler(register, "ft");
    const message = makeMessage({
      mentions: [{ id: "u2" }, { id: "u3" }],
    });

    dbMocks.getUserText.mockResolvedValueOnce("a list");
    dbMocks.getUserText.mockResolvedValueOnce(null);

    await handler({ message, rest: "<@u2> <@u3>", cmd: "?ft" });

    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "<@u2> is trading: a list\n<@u3> has not set a list!",
        allowedMentions: { parse: [], users: ["u2", "u3"], roles: [] },
      })
    );
  });
});
