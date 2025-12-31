import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getSavedId: vi.fn(),
  setSavedId: vi.fn(),
  deleteSavedId: vi.fn(),
  getUserText: vi.fn(),
  setUserText: vi.fn(),
  deleteUserText: vi.fn(),
}));

vi.mock("../../db.js", () => dbMocks);

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
  return register.calls.find((c) => c.name === name && c.handler && c.def)?.handler;
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
  label = "",
  target = "",
} = {}) {
  return {
    guildId,
    user: { id: userId },
    options: {
      getString: (key) => {
        if (key === "action") return action;
        if (key === "users") return usersText;
        if (key === "label") return label;
        if (key === "target") return target;
        return null;
      },
      getInteger: (key) => (key === "value" ? value : null),
      getUser: (key) => (key === "user" ? user : null),
    },
    reply: vi.fn(async () => ({})),
  };
}

describe("id.js", () => {
  beforeEach(() => {
    dbMocks.getSavedId.mockReset();
    dbMocks.setSavedId.mockReset();
    dbMocks.deleteSavedId.mockReset();
    dbMocks.getUserText.mockReset();
    dbMocks.setUserText.mockReset();
    dbMocks.deleteUserText.mockReset();
  });

  it("handles add and del in message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce(null);
    dbMocks.getSavedId.mockResolvedValueOnce(null);
    await handler({ message, rest: "add 123 main" });
    expect(dbMocks.setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 123,
    });

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({ ids: [{ id: 123, label: "main", addedAt: 1 }] })
    );
    await handler({ message, rest: "del" });
    expect(dbMocks.deleteUserText).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      kind: "ids",
    });
  });

  it("renders mention lookups for message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage({ mentions: [{ id: "u2" }] });

    dbMocks.getUserText.mockResolvedValueOnce(null);
    dbMocks.getSavedId.mockResolvedValueOnce(null);
    await handler({ message, rest: "<@u2>" });

    expect(message.channel.send).toHaveBeenCalledWith("<@u2> has not set an ID!");
  });

  it("handles slash lookups with default self", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getSlashHandler(register, "id");
    const interaction = makeInteraction();

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({ ids: [{ id: 456, label: null, addedAt: 1 }] })
    );
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
    const interaction = makeInteraction({ action: "add", value: 789, label: "main" });

    dbMocks.getUserText.mockResolvedValueOnce(null);
    dbMocks.getSavedId.mockResolvedValueOnce(null);
    await handler({ interaction });

    expect(dbMocks.setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 789,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "✅ ID saved." })
    );
  });

  it("returns defaults, labels, and all for message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: null, addedAt: 2 },
          { id: 333, label: "storage", addedAt: 3 },
        ],
      })
    );
    await handler({ message, rest: "" });
    expect(message.channel.send).toHaveBeenCalledWith("<@u1> 111 (main)");

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: null, addedAt: 2 },
          { id: 333, label: "storage", addedAt: 3 },
        ],
      })
    );
    await handler({ message, rest: "all" });
    expect(message.channel.send).toHaveBeenCalledWith(
      "<@u1>: 111 (main), 222, 333 (storage)"
    );

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: null, addedAt: 2 },
          { id: 333, label: "storage", addedAt: 3 },
        ],
      })
    );
    await handler({ message, rest: "storage" });
    expect(message.channel.send).toHaveBeenCalledWith("<@u1> 333 (storage)");
  });

  it("supports setdefault and deletes by label", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: "storage", addedAt: 2 },
        ],
      })
    );
    await handler({ message, rest: "setdefault storage" });
    expect(dbMocks.setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 222,
    });

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: "storage", addedAt: 2 },
        ],
      })
    );
    await handler({ message, rest: "del storage" });
    expect(dbMocks.setUserText).toHaveBeenCalled();
  });

  it("rejects reserved labels and duplicate ids", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    await handler({ message, rest: "add 123 all" });
    expect(message.reply).toHaveBeenCalledWith(
      "Label \"all\" is reserved. Please choose another label."
    );

    await handler({ message, rest: "add 123 help" });
    expect(message.reply).toHaveBeenCalledWith(
      "Label \"help\" is reserved. Please choose another label."
    );

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [{ id: 123, label: "main", addedAt: 1 }],
      })
    );
    await handler({ message, rest: "add 123" });
    expect(message.reply).toHaveBeenCalledWith("That ID is already saved.");
  });

  it("supports slash list and setdefault", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getSlashHandler(register, "id");
    const interaction = makeInteraction({ action: "list" });

    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: "storage", addedAt: 2 },
        ],
      })
    );
    await handler({ interaction });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("111 (main), 222 (storage)"),
      })
    );

    const interactionSet = makeInteraction({ action: "setdefault", target: "storage" });
    dbMocks.getUserText.mockResolvedValueOnce(
      JSON.stringify({
        ids: [
          { id: 111, label: "main", addedAt: 1 },
          { id: 222, label: "storage", addedAt: 2 },
        ],
      })
    );
    await handler({ interaction: interactionSet });
    expect(dbMocks.setSavedId).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      savedId: 222,
    });
  });

  it("responds to help in message handler", async () => {
    const register = makeRegister();
    registerId(register);

    const handler = getExposeHandler(register, "id");
    const message = makeMessage();

    await handler({ message, rest: "help", cmd: "!id" });
    const reply = message.reply.mock.calls[0]?.[0] || "";
    expect(reply).toContain("**ID commands**");
    expect(reply).toContain("!id add <number> [label]");
    expect(reply).toContain("!id del");
    expect(reply).toContain("!id setdefault <id|label>");
  });
});
