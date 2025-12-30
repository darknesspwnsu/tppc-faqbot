import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

const helperMocks = vi.hoisted(() => ({
  sendChunked: vi.fn(async () => {}),
}));

vi.mock("../../auth.js", () => authMocks);
vi.mock("../../contests/helpers.js", () => helperMocks);

import { registerReading } from "../../contests/reading.js";

function makeRegister() {
  const calls = new Map();
  let listener = null;

  const register = (cmd, handler) => {
    calls.set(cmd, handler);
  };

  register.listener = (handler) => {
    listener = handler;
  };

  return {
    register,
    getHandler: (cmd) => calls.get(cmd),
    getListener: () => listener,
  };
}

function makeMessage({
  guildId = "g1",
  channelId = "c1",
  authorId = "u1",
  username = "User",
  displayName = "User",
  content = "",
  bot = false,
} = {}) {
  return {
    guildId,
    channelId,
    content,
    author: { id: authorId, username, bot },
    member: { displayName },
    reply: vi.fn(async () => ({})),
    channel: { send: vi.fn(async () => ({})) },
  };
}

describe("reading.js", () => {
  beforeEach(() => {
    authMocks.isAdminOrPrivileged.mockReturnValue(true);
    helperMocks.sendChunked.mockReset();
  });

  it("tracks responders and outputs sorted names on end", async () => {
    const { register, getHandler, getListener } = makeRegister();
    registerReading(register);

    const start = getHandler("!startReading");
    const end = getHandler("!endReading");
    const listener = getListener();

    const startMsg = makeMessage({ authorId: "u1" });
    await start({ message: startMsg, rest: "" });

    await listener({ message: makeMessage({ authorId: "u2", displayName: "Zoe" }) });
    await listener({ message: makeMessage({ authorId: "u3", displayName: "Amy" }) });

    const endMsg = makeMessage({ authorId: "u1" });
    await end({ message: endMsg });

    expect(helperMocks.sendChunked).toHaveBeenCalledWith(
      expect.objectContaining({
        header: "📖 Reading ended. Participants (2):",
        lines: ["Amy", "Zoe"],
      })
    );
  });

  it("respects phrase filter and reports no matches", async () => {
    const { register, getHandler, getListener } = makeRegister();
    registerReading(register);

    const start = getHandler("!startReading");
    const end = getHandler("!endReading");
    const listener = getListener();

    const startMsg = makeMessage({ authorId: "u1" });
    await start({ message: startMsg, rest: "hello" });

    await listener({ message: makeMessage({ authorId: "u2", content: "nope" }) });

    const endMsg = makeMessage({ authorId: "u1" });
    await end({ message: endMsg });

    expect(helperMocks.sendChunked).not.toHaveBeenCalled();
    expect(endMsg.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("No messages matched the phrase")
    );
  });
});
