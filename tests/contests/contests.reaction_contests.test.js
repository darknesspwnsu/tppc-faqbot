import { describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

vi.mock("../../db.js", () => ({
  getSavedId: vi.fn(async () => null),
}));

vi.mock("../../shared/dm.js", () => ({
  sendDm: vi.fn(async () => ({ ok: true })),
}));

import { isAdminOrPrivileged } from "../../auth.js";
import { getSavedId } from "../../db.js";
import { sendDm } from "../../shared/dm.js";
import * as reactionContests from "../../contests/reaction_contests.js";
import * as rng from "../../contests/rng.js";
const { collectEntrantsByReactions, registerReactionContests } = reactionContests;

function createRegister() {
  const handlers = new Map();
  const slashHandlers = new Map();
  const register = (cmd, fn, _help, opts = {}) => {
    handlers.set(cmd, fn);
    const aliases = Array.isArray(opts?.aliases) ? opts.aliases : [];
    for (const alias of aliases) {
      if (!alias) continue;
      handlers.set(String(alias), fn);
    }
  };
  register.slash = (config, fn) => slashHandlers.set(config.name, fn);
  register.handlers = handlers;
  register.slashHandlers = slashHandlers;
  return register;
}

function mockClient() {
  const handlers = new Map();
  const client = {
    on: vi.fn((evt, fn) => handlers.set(evt, fn)),
    channels: {
      fetch: vi.fn(async () => ({
        isTextBased: () => true,
        messages: {
          fetch: vi.fn(async () => ({ edit: vi.fn().mockResolvedValue(undefined) })),
        },
      })),
    },
  };
  client.__handlers = handlers;
  return client;
}

function mockJoinMessage() {
  return {
    id: "m1",
    react: vi.fn().mockResolvedValue(undefined),
  };
}

function mockMessage(joinMsg, client) {
  return {
    guildId: "1",
    channelId: "2",
    client,
    channel: {
      send: vi.fn().mockResolvedValue(joinMsg),
    },
  };
}

const sharedClient = mockClient();
reactionContests.installReactionHooks(sharedClient);

describe("collectEntrantsByReactions", () => {
  test("collects entrants and honors maxEntrants", async () => {
    const joinMsg = mockJoinMessage();
    const message = mockMessage(joinMsg, sharedClient);

    const p = collectEntrantsByReactions({
      message,
      promptText: "join",
      durationMs: 1000,
      maxEntrants: 2,
      emoji: "👍",
    });

    // Allow the async setup to register the collector state.
    await Promise.resolve();
    await Promise.resolve();

    const add = sharedClient.__handlers.get("messageReactionAdd");
    expect(add).toBeTypeOf("function");

    await add({ message: { id: "m1", guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });
    await add({ message: { id: "m1", guildId: "1", partial: false }, partial: false }, { id: "u2", bot: false });

    const res = await p;
    expect([...res.entrants]).toEqual(["u1", "u2"]);
  });

  test("DMs ineligible entrants when eligibility is required", async () => {
    isAdminOrPrivileged.mockReturnValue(false);
    sendDm.mockClear();

    const joinMsg = mockJoinMessage();
    const message = mockMessage(joinMsg, sharedClient);
    message.guildId = "329934860388925442";
    message.guild = {
      name: "TPPC Official Discord",
      members: {
        fetch: vi.fn(async () => ({ roles: { cache: new Set() } })),
      },
    };

    const p = collectEntrantsByReactions({
      message,
      promptText: "join",
      durationMs: 1000,
      maxEntrants: 2,
      emoji: "👍",
      eligibility: { requireVerified: true },
    });

    await Promise.resolve();
    await Promise.resolve();

    const add = sharedClient.__handlers.get("messageReactionAdd");
    await add({ message: { id: "m1", guildId: "329934860388925442", partial: false }, partial: false }, { id: "u1", bot: false });

    await p;
    expect(sendDm).toHaveBeenCalledTimes(1);
    isAdminOrPrivileged.mockReturnValue(true);
  });

  test("blocks conteststart when a collector is already active in the channel", async () => {
    const joinMsg = mockJoinMessage();
    const message = mockMessage(joinMsg, sharedClient);
    message.author = { id: "host" };

    const promise = collectEntrantsByReactions({
      message,
      promptText: "join",
      durationMs: 10_000,
      maxEntrants: 2,
      emoji: "👍",
    });

    await Promise.resolve();
    await Promise.resolve();

    const register = createRegister();
    registerReactionContests(register);

    const conteststart = register.handlers.get("!conteststart");
    const cancel = register.handlers.get("!cancelcontest");
    expect(conteststart).toBeTypeOf("function");
    expect(cancel).toBeTypeOf("function");

    const reply = vi.fn(async () => {});
    const channel = { send: vi.fn().mockResolvedValue(joinMsg) };
    const msg = {
      guildId: "1",
      channelId: "2",
      author: { id: "host" },
      client: sharedClient,
      channel,
      reply,
    };

    await conteststart({ message: msg, rest: "1min" });
    expect(reply).toHaveBeenCalledTimes(1);

    await cancel({ message: msg });
    await promise;
  });
});

describe("conteststart validation and outputs", () => {
  test("rejects invalid time formats", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const conteststart = register.handlers.get("!conteststart");
    const reply = vi.fn(async () => {});

    const spy = vi.spyOn(reactionContests, "collectEntrantsByReactions");

    await conteststart({ message: { guildId: "1", reply }, rest: "30" });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain("Invalid time");
    expect(spy).not.toHaveBeenCalled();
  });

  test("reports when winners exceed entrants", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const conteststart = register.handlers.get("!conteststart");
    vi.useFakeTimers();

    const joinMsg = mockJoinMessage();
    const send = vi.fn().mockResolvedValue(joinMsg);
    const message = {
      guildId: "1",
      channelId: "2",
      author: { id: "host" },
      client: sharedClient,
      channel: { send },
      reply: vi.fn(async () => {}),
      guild: {
        members: {
          fetch: vi.fn(async () =>
            new Map([
              ["u1", { displayName: "Alpha" }],
              ["u2", { displayName: "Beta" }],
            ])
          ),
        },
      },
    };

    const startPromise = conteststart({ message, rest: "choose 1sec winners=3" });

    await Promise.resolve();
    await Promise.resolve();

    const add = sharedClient.__handlers.get("messageReactionAdd");
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u2", bot: false });

    vi.advanceTimersByTime(1000);
    await startPromise;

    expect(send.mock.calls.some((call) => call[0]?.includes("Not enough entrants"))).toBe(true);
    vi.useRealTimers();
  });

  test("filters entrants when require=verified is set", async () => {
    isAdminOrPrivileged.mockImplementation((msg) => msg?.author?.id === "host");
    getSavedId.mockImplementation(async ({ userId }) => (userId === "u1" ? 123 : null));
    sendDm.mockClear();

    const register = createRegister();
    registerReactionContests(register);

    const conteststart = register.handlers.get("!conteststart");
    vi.useFakeTimers();

    const joinMsg = mockJoinMessage();
    const send = vi.fn().mockResolvedValue(joinMsg);
    const verifiedRoleId = "331095682335375361";
    const message = {
      guildId: "329934860388925442",
      channelId: "2",
      author: { id: "host" },
      client: sharedClient,
      channel: { send },
      reply: vi.fn(async () => {}),
      guild: {
        members: {
          fetch: vi.fn(async () =>
            new Map([
              ["u1", { displayName: "Alpha", roles: { cache: new Set([verifiedRoleId]) } }],
              ["u2", { displayName: "Beta", roles: { cache: new Set() } }],
            ])
          ),
        },
      },
    };

    const startPromise = conteststart({ message, rest: "list 1sec require=verified" });

    await Promise.resolve();
    await Promise.resolve();

    const add = sharedClient.__handlers.get("messageReactionAdd");
    await add({ message: { id: joinMsg.id, guildId: "329934860388925442", partial: false }, partial: false }, { id: "u1", bot: false });
    await add({ message: { id: joinMsg.id, guildId: "329934860388925442", partial: false }, partial: false }, { id: "u2", bot: false });

    vi.advanceTimersByTime(1000);
    await startPromise;

    expect(send.mock.calls.some((call) => String(call[0]).includes("1 entrant(s)"))).toBe(true);
    vi.useRealTimers();
    isAdminOrPrivileged.mockReturnValue(true);
  });

  test("includes prize for single-winner choose mode", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const conteststart = register.handlers.get("!conteststart");
    vi.useFakeTimers();

    const joinMsg = mockJoinMessage();
    const send = vi.fn().mockResolvedValue(joinMsg);
    const message = {
      guildId: "1",
      channelId: "2",
      author: { id: "host" },
      client: sharedClient,
      channel: { send },
      reply: vi.fn(async () => {}),
      guild: {
        members: {
          fetch: vi.fn(async () => new Map([["u1", { displayName: "Alpha" }]])),
        },
      },
    };

    const startPromise = conteststart({
      message,
      rest: "choose 1sec winners=1 prize=$$$ Shiny Klink!!!",
    });

    await Promise.resolve();
    await Promise.resolve();

    const add = sharedClient.__handlers.get("messageReactionAdd");
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });

    vi.advanceTimersByTime(1000);
    await startPromise;

    expect(send.mock.calls.some((call) => call[0]?.includes("Prize: **$$$ Shiny Klink!!!**"))).toBe(true);
    vi.useRealTimers();
  });

  test("prevents cancel by non-owner without privileges", async () => {
    isAdminOrPrivileged.mockReturnValue(false);
    vi.useFakeTimers();

    const joinMsg = mockJoinMessage();
    const message = mockMessage(joinMsg, sharedClient);
    message.author = { id: "host" };

    const promise = collectEntrantsByReactions({
      message,
      promptText: "join",
      durationMs: 1000,
      maxEntrants: 2,
      emoji: "👍",
    });

    await Promise.resolve();
    await Promise.resolve();

    const register = createRegister();
    registerReactionContests(register);

    const cancel = register.handlers.get("!cancelcontest");
    const reply = vi.fn(async () => {});

    const msg = {
      guildId: "1",
      channelId: "2",
      author: { id: "not-host" },
      client: sharedClient,
      reply,
    };

    await cancel({ message: msg });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain("only the contest host");

    vi.advanceTimersByTime(1000);
    await promise;
    vi.useRealTimers();
  });
});

describe("contest slash command", () => {
  test("replies with help when time is missing", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const slash = register.slashHandlers.get("contest");
    const reply = vi.fn(async () => {});

    const interaction = {
      guildId: "1",
      channelId: "2",
      channel: {},
      user: { id: "u1" },
      options: {
        getString: vi.fn(() => null),
        getInteger: vi.fn(() => null),
      },
      reply,
    };

    await slash({ interaction });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0].content).toContain("/contest — Help");
  });

  test("includes prize line for choose mode with one winner", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const slash = register.slashHandlers.get("contest");
    const reply = vi.fn(async () => {});
    const joinMsg = mockJoinMessage();
    const send = vi
      .fn()
      .mockImplementationOnce(async () => joinMsg)
      .mockImplementation(async () => {});

    const add = sharedClient.__handlers.get("messageReactionAdd");

    const interaction = {
      guildId: "1",
      channelId: "2",
      channel: { send },
      user: { id: "host" },
      guild: {
        members: {
          fetch: vi.fn(async () => new Map([["u1", { displayName: "Alpha" }]])),
        },
      },
      options: {
        getString: vi.fn((name) => {
          if (name === "mode") return "choose";
          if (name === "time") return "1sec";
          if (name === "prize") return "Gold";
          return null;
        }),
        getInteger: vi.fn((name) => {
          if (name === "quota") return 1;
          if (name === "winners") return 1;
          return null;
        }),
      },
      reply,
      client: sharedClient,
    };

    const run = slash({ interaction });
    await Promise.resolve();
    await Promise.resolve();
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });
    await run;

    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain("Prize: **Gold**");
  });

  test("passes prize to elimination runner", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const slash = register.slashHandlers.get("contest");
    const reply = vi.fn(async () => {});
    const joinMsg = mockJoinMessage();
    const send = vi
      .fn()
      .mockImplementationOnce(async () => joinMsg)
      .mockImplementation(async () => {});

    const add = sharedClient.__handlers.get("messageReactionAdd");
    const elimSpy = vi.spyOn(rng, "runElimFromItems").mockResolvedValue({ ok: true });

    const interaction = {
      guildId: "1",
      channelId: "2",
      channel: { send },
      user: { id: "host" },
      guild: {
        members: {
          fetch: vi.fn(async () =>
            new Map([
              ["u1", { displayName: "Alpha" }],
              ["u2", { displayName: "Beta" }],
            ])
          ),
        },
      },
      options: {
        getString: vi.fn((name) => {
          if (name === "mode") return "elim";
          if (name === "time") return "1sec";
          if (name === "prize") return "Bike";
          return null;
        }),
        getInteger: vi.fn(() => null),
      },
      reply,
      client: sharedClient,
    };

    const run = slash({ interaction });
    await Promise.resolve();
    await Promise.resolve();
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u1", bot: false });
    await add({ message: { id: joinMsg.id, guildId: "1", partial: false }, partial: false }, { id: "u2", bot: false });
    await run;

    expect(elimSpy).toHaveBeenCalledTimes(1);
    expect(elimSpy.mock.calls[0][0].winnerSuffix).toBe("Prize: **Bike**");
    elimSpy.mockRestore();
  });
});

describe("contest role toggle bang command", () => {
  test("!contest adds contest role when missing", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const handler = register.handlers.get("!contest");
    expect(handler).toBeTypeOf("function");

    const roleId = "398953158690471948";
    const roleSet = new Set();
    const add = vi.fn(async (id) => roleSet.add(String(id)));
    const remove = vi.fn(async () => {});
    const reply = vi.fn(async () => {});

    const message = {
      guildId: "329934860388925442",
      author: { id: "u1" },
      member: {
        roles: {
          cache: { has: (id) => roleSet.has(String(id)) },
          add,
          remove,
        },
      },
      reply,
    };

    await handler({ message });

    expect(add).toHaveBeenCalledWith(roleId, expect.stringContaining("!contest"));
    expect(remove).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Added contest notifications role."));
    expect(reply).not.toHaveBeenCalledWith(expect.stringContaining("<@&"));
  });

  test("!contest removes contest role when already present", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const handler = register.handlers.get("!contest");
    expect(handler).toBeTypeOf("function");

    const roleId = "398953158690471948";
    const roleSet = new Set([roleId]);
    const add = vi.fn(async () => {});
    const remove = vi.fn(async (id) => roleSet.delete(String(id)));
    const reply = vi.fn(async () => {});

    const message = {
      guildId: "329934860388925442",
      author: { id: "u1" },
      member: {
        roles: {
          cache: { has: (id) => roleSet.has(String(id)) },
          add,
          remove,
        },
      },
      reply,
    };

    await handler({ message });

    expect(remove).toHaveBeenCalledWith(roleId, expect.stringContaining("!contest"));
    expect(add).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Removed contest notifications role."));
    expect(reply).not.toHaveBeenCalledWith(expect.stringContaining("<@&"));
  });

  test("!contests alias points to role-toggle command, not !conteststart", async () => {
    const register = createRegister();
    registerReactionContests(register);

    const contest = register.handlers.get("!contest");
    const contests = register.handlers.get("!contests");
    const conteststart = register.handlers.get("!conteststart");
    const startcontest = register.handlers.get("!startcontest");

    expect(contest).toBeTypeOf("function");
    expect(contests).toBeTypeOf("function");
    expect(conteststart).toBeTypeOf("function");
    expect(startcontest).toBeTypeOf("function");
    expect(contests).toBe(contest);
    expect(contest).not.toBe(conteststart);
    expect(startcontest).toBe(conteststart);
  });
});
