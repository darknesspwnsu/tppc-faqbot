import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => false),
}));

vi.mock("../../db.js", () => ({
  getUserText: vi.fn(),
  setUserText: vi.fn(),
  getDb: vi.fn(),
}));

import { getUserText, setUserText, getDb } from "../../db.js";
import { registerWhispers, __testables, migrateWhispersToEncrypted } from "../../contests/whispers.js";

function makeRegister() {
  const calls = { slash: [], listener: [] };
  return {
    slash: (config, handler) => calls.slash.push({ config, handler }),
    listener: (handler) => calls.listener.push(handler),
    calls,
  };
}

function makeInteraction({ guildId, guildName, phrase, prize, mode, userId }) {
  return {
    guild: { id: guildId, name: guildName },
    user: { id: userId },
    options: {
      getSubcommand: () => mode || "add",
      getString: (key) => {
        if (key === "phrase") return phrase;
        if (key === "prize") return prize;
        return null;
      },
    },
    reply: vi.fn(async () => {}),
  };
}

describe("registerWhispers", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...envSnapshot,
      WHISPER_ENC_KEY_ID: "v1",
      WHISPER_ENC_KEYS: JSON.stringify({ v1: "a".repeat(64) }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...envSnapshot };
  });

  test("adds a whisper and saves it", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const whisperSlash = register.calls.slash.find((call) => call.config.name === "whisper");

    getUserText.mockResolvedValue("[]");

    const interaction = makeInteraction({
      guildId: "g1",
      guildName: "Guild One",
      phrase: "secret",
      prize: "candy",
      mode: "add",
      userId: "u1",
    });

    await whisperSlash.handler({ interaction });

    const replyContent = interaction.reply.mock.calls[0][0].content;
    expect(replyContent).toContain("Listening for: \"secret\"");
    expect(replyContent).toContain("Prize: candy");

    expect(setUserText).toHaveBeenCalledTimes(1);
    const payload = setUserText.mock.calls[0][0];
    expect(payload.guildId).toBe("g1");
    expect(payload.userId).toBe("__guild__");
    expect(payload.kind).toBe("whisper");

    const decoded = __testables.decodeStoredItems(payload.text);
    const saved = decoded.items;
    expect(saved).toEqual([
      { phrase: "secret", ownerId: "u1", prize: "candy", createdAt: saved[0].createdAt },
    ]);
    expect(Number.isFinite(saved[0].createdAt)).toBe(true);
  });

  test("rejects phrases longer than 256 characters", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const whisperSlash = register.calls.slash.find((call) => call.config.name === "whisper");

    getUserText.mockResolvedValue("[]");

    const interaction = makeInteraction({
      guildId: "g1",
      guildName: "Guild One",
      phrase: "a".repeat(257),
      prize: "",
      mode: "add",
      userId: "u1",
    });

    await whisperSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Phrases must be 256 characters or fewer.",
      })
    );
    expect(setUserText).not.toHaveBeenCalled();
  });

  test("limits whispers to 5 per user for non-admins", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const whisperSlash = register.calls.slash.find((call) => call.config.name === "whisper");

    const existing = Array.from({ length: 5 }, (_, i) => ({
      phrase: `phrase${i + 1}`,
      ownerId: "u1",
      prize: "",
    }));
    getUserText.mockResolvedValue(JSON.stringify(existing));

    const interaction = makeInteraction({
      guildId: "g5",
      guildName: "Guild Five",
      phrase: "secret",
      prize: "",
      mode: "add",
      userId: "u1",
    });

    await whisperSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You can only have 5 active whispers.",
      })
    );
    expect(setUserText).not.toHaveBeenCalled();
  });

  test("delete reports missing phrase without saving", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const whisperSlash = register.calls.slash.find((call) => call.config.name === "whisper");

    getUserText.mockResolvedValue("[]");

    const interaction = makeInteraction({
      guildId: "g2",
      guildName: "Guild Two",
      phrase: "secret",
      prize: null,
      mode: "delete",
      userId: "u2",
    });

    await whisperSlash.handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0][0].content).toBe("You are not listening for: \"secret\"");
    expect(setUserText).not.toHaveBeenCalled();
  });

  test("list returns phrases for the user", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const listSlash = register.calls.slash.find((call) => call.config.name === "whisper");

    const encrypted = __testables.encryptPayload(
      JSON.stringify([
        { phrase: "alpha", ownerId: "u3", prize: "" },
        { phrase: "beta", ownerId: "u3", prize: "ticket" },
      ])
    );
    getUserText.mockResolvedValue(encrypted);

    const interaction = {
      guild: { id: "g3", name: "Guild Three" },
      user: { id: "u3" },
      reply: vi.fn(async () => {}),
      options: { getSubcommand: () => "list", getString: () => null },
    };

    await listSlash.handler({ interaction });

    const replyContent = interaction.reply.mock.calls[0][0].content;
    expect(replyContent).toContain("Guild Three");
    expect(replyContent).toContain("\"alpha\"");
    expect(replyContent).toContain("Prize: ticket");
  });

  test("listener announces and removes matched phrase", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const whisperSlash = register.calls.slash.find((call) => call.config.name === "whisper");
    const listener = register.calls.listener[0];

    getUserText.mockResolvedValue("[]");

    const interaction = makeInteraction({
      guildId: "g4",
      guildName: "Guild Four",
      phrase: "hidden",
      prize: "prize",
      mode: "add",
      userId: "u4",
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-12T08:30:00Z"));

    await whisperSlash.handler({ interaction });
    setUserText.mockClear();

    const reply = vi.fn(async () => {});
    await listener({
      message: {
        author: { bot: false },
        guild: { id: "g4" },
        content: "found the hidden phrase",
        reply,
      },
    });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0].content).toContain("hidden");
    expect(reply.mock.calls[0][0].content).toContain("<t:1768206600:f>");
    expect(setUserText).toHaveBeenCalledTimes(1);
  });

  test("migration encrypts plaintext rows and skips encrypted rows", async () => {
    const encrypted = __testables.encryptPayload(
      JSON.stringify([{ phrase: "alpha", ownerId: "u1", prize: "" }])
    );
    getDb.mockReturnValue({
      execute: vi.fn(async () => [
        [
          { guild_id: "g1", text: JSON.stringify([{ phrase: "beta", ownerId: "u2", prize: "" }]) },
          { guild_id: "g2", text: encrypted },
          { guild_id: "g3", text: "[]" },
        ],
      ]),
    });

    const res = await migrateWhispersToEncrypted();
    expect(res.ok).toBe(true);
    expect(res.migrated).toBe(1);
    expect(setUserText).toHaveBeenCalledTimes(1);
    expect(setUserText.mock.calls[0][0].guildId).toBe("g1");
  });
});
