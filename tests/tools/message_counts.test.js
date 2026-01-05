import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("../../db.js", () => dbMocks);
vi.mock("../../configs/message_count_channels.js", () => ({
  MESSAGE_COUNT_CHANNELS_BY_GUILD: { g1: ["c1"] },
}));
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => "{}"),
  },
}));

import fs from "node:fs/promises";
import { registerMessageCounts } from "../../tools/message_counts.js";

function makeRegister() {
  const calls = { listener: [], bang: [] };
  const register = (name, handler, help, opts) => calls.bang.push({ name, handler, help, opts });
  register.listener = (handler) => calls.listener.push(handler);
  register.slash = vi.fn();
  register.component = vi.fn();
  register.calls = calls;
  return register;
}

function makeMessage({
  guildId = "g1",
  channelId = "c1",
  content = "",
  authorId = "u1",
  bot = false,
  mentions = [],
} = {}) {
  return {
    guildId,
    channelId,
    content,
    author: { id: authorId, bot },
    mentions: {
      users: {
        first: () => (mentions.length ? { id: mentions[0] } : null),
      },
    },
    reply: vi.fn(async () => {}),
    guild: {
      members: {
        fetch: vi.fn(async () => new Map()),
      },
      client: {
        users: {
          fetch: vi.fn(async (id) => ({ username: `user-${id}` })),
        },
      },
    },
  };
}

describe("tools/message_counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments counts only in tracked channels", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerMessageCounts(register);

    const listener = register.calls.listener[0];
    const tracked = makeMessage({ channelId: "c1" });
    const untracked = makeMessage({ channelId: "c2" });

    await listener({ message: tracked });
    await listener({ message: untracked });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO message_counts"),
      ["g1", "u1"]
    );
  });

  it("skips counting when the message is a command", async () => {
    const execute = vi.fn(async () => [[]]);
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerMessageCounts(register);
    const listener = register.calls.listener[0];

    const tracked = makeMessage({ channelId: "c1", content: "!count" });
    await listener({ message: tracked, isCommand: true });

    expect(execute).not.toHaveBeenCalled();
  });

  it("returns counts for self and tagged users", async () => {
    const execute = vi.fn(async (sql, params) => {
      if (sql.includes("SELECT count FROM message_counts")) {
        if (params[1] === "u2") return [[{ count: 42 }]];
        return [[{ count: 7 }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerMessageCounts(register);
    const cmd = register.calls.bang.find((c) => c.name === "!count");

    const msgSelf = makeMessage();
    await cmd.handler({ message: msgSelf, rest: "" });
    expect(msgSelf.reply).toHaveBeenCalledWith(expect.stringContaining("message count of **7** messages"));

    const msgTagged = makeMessage({ mentions: ["u2"] });
    await cmd.handler({ message: msgTagged, rest: "<@u2>" });
    expect(msgTagged.reply).toHaveBeenCalledWith(expect.stringContaining("message count of **42** messages"));
  });

  it("adds flareon counts when overall is requested", async () => {
    fs.readFile.mockResolvedValueOnce(
      JSON.stringify({ g1: { u1: 5 } })
    );
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT count FROM message_counts")) {
        return [[{ count: 7 }]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerMessageCounts(register);
    const cmd = register.calls.bang.find((c) => c.name === "!count");

    const message = makeMessage({ content: "!count overall" });
    await cmd.handler({ message, rest: "overall" });

    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("message count of **12** messages")
    );
  });

  it("renders leaderboard without mentions", async () => {
    const execute = vi.fn(async (sql) => {
      if (sql.includes("SELECT user_id, count")) {
        return [[
          { user_id: "u1", count: 10 },
          { user_id: "u2", count: 9 },
        ]];
      }
      return [[]];
    });
    dbMocks.getDb.mockReturnValue({ execute });

    const register = makeRegister();
    registerMessageCounts(register);
    const cmd = register.calls.bang.find((c) => c.name === "!count");

    const message = makeMessage({ content: "!count leaderboard" });
    await cmd.handler({ message, rest: "leaderboard" });

    const output = message.reply.mock.calls[0][0];
    expect(output).toContain("Top 2 highest message counts for this server");
    expect(output).toContain("**user-u1**");
    expect(output).not.toContain("<@");
  });
});
