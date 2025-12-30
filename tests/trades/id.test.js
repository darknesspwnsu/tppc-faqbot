import { describe, it, expect, vi, beforeEach } from "vitest";

const getSavedId = vi.fn();
const setSavedId = vi.fn();
const deleteSavedId = vi.fn();

vi.mock("../../db.js", () => ({
  getSavedId,
  setSavedId,
  deleteSavedId,
}));

import { registerId } from "../../trades/id.js";

function makeRegister() {
  const calls = [];
  return {
    expose: (cfg) => calls.push(cfg),
    slash: (def, handler) => calls.push({ name: def.name, handler, def }),
    get calls() {
      return calls;
    },
  };
}

function getExposeHandler(register, name) {
  return register.calls.find((c) => c.name === name && c.handler)?.handler;
}

function getSlashHandler(register, name) {
  return register.calls.find((c) => c.name === name && c.handler)?.handler;
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

function makeInteraction({
  guildId = "g1",
  userId = "u1",
  action = "",
  value = null,
  user = null,
  usersText = "",
} = {}) {
  return {
    guildId,
    user: { id: userId },
    options: {
      getString: (key) => (key === "action" ? action : key === "users" ? usersText : null),
      getInteger: (key) => (key === "value" ? value : null),
      getUser: (key) => (key === "user" ? user : null),
    },
    reply: vi.fn(async () => ({})),
  };
}

describe("id.js", () => {
  beforeEach(() => {
    getSavedId.mockReset();
    setSavedId.mockReset();
    deleteSavedId.mockReset();
  });

  it("handles add and del in message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    await handler({ message, rest: "add 123" });
    expect(setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 123,
    });

    getSavedId.mockResolvedValueOnce(123);
    await handler({ message, rest: "del" });
    expect(deleteSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
    });
  });

  it("renders mention lookups for message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage({ mentions: [{ id: "u2" }] });

    getSavedId.mockResolvedValueOnce(null);
    await handler({ message, rest: "<@u2>" });

    expect(message.channel.send).toHaveBeenCalledWith("<@u2> has not set an ID!");
  });

  it("handles slash lookups with default self", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getSlashHandler(register, "id");
    const interaction = makeInteraction();

    getSavedId.mockResolvedValueOnce(456);
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("456"),
      })
    );
  });

  it("handles slash add", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getSlashHandler(register, "id");
    const interaction = makeInteraction({ action: "add", value: 789 });

    await handler({ interaction });

    expect(setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 789,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ ID saved." })
    );
  });
});
