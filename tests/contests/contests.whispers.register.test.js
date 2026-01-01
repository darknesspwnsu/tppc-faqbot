import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../db.js", () => ({
  getUserText: vi.fn(),
  setUserText: vi.fn(),
}));

import { getUserText, setUserText } from "../../db.js";
import { registerWhispers } from "../../contests/whispers.js";

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
      getString: (key) => {
        if (key === "phrase") return phrase;
        if (key === "prize") return prize;
        if (key === "mode") return mode;
        return null;
      },
    },
    reply: vi.fn(async () => {}),
  };
}

describe("registerWhispers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      mode: null,
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

    const saved = JSON.parse(payload.text);
    expect(saved).toEqual([{ phrase: "secret", ownerId: "u1", prize: "candy" }]);
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

  test("listwhispers returns phrases for the user", async () => {
    const register = makeRegister();
    registerWhispers(register);

    const listSlash = register.calls.slash.find((call) => call.config.name === "listwhispers");

    getUserText.mockResolvedValue(
      JSON.stringify([
        { phrase: "alpha", ownerId: "u3", prize: "" },
        { phrase: "beta", ownerId: "u3", prize: "ticket" },
      ])
    );

    const interaction = {
      guild: { id: "g3", name: "Guild Three" },
      user: { id: "u3" },
      reply: vi.fn(async () => {}),
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
      mode: null,
      userId: "u4",
    });

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
    expect(setUserText).toHaveBeenCalledTimes(1);
  });
});
