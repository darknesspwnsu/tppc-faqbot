import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

const mockExecute = vi.fn(async () => [[], []]);

vi.mock("../../db.js", () => ({
  getDb: () => ({
    execute: mockExecute,
  }),
}));

import { registerGiveaway, _test } from "../../contests/giveaway.js";
import { isAdminOrPrivileged } from "../../auth.js";

function buildRegister() {
  const handlers = new Map();
  const register = (cmd, handler) => {
    handlers.set(cmd, { handler });
  };
  register.slash = (meta, handler, opts) => {
    handlers.set(`/${meta.name}`, { handler, meta, opts });
  };
  register.component = (prefix, handler) => {
    handlers.set(`component:${prefix}`, { handler, prefix });
  };
  register.listener = () => {};
  return { handlers, register };
}

function mockInteraction(overrides = {}) {
  return {
    guildId: "g1",
    channelId: "c1",
    user: { id: "u1" },
    client: {
      channels: {
        fetch: vi.fn(async () => ({ name: "general" })),
      },
    },
    options: {
      getSubcommand: vi.fn(() => "create"),
      getString: vi.fn(() => ""),
      getFocused: vi.fn(() => ""),
    },
    showModal: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

function buildChannel({ giveawayMessage, summaryMessage } = {}) {
  const msg = giveawayMessage || { id: "m1", edit: vi.fn(async () => {}) };
  const summary = summaryMessage || { id: "s1", url: "https://example.com/summary" };
  const send = vi.fn(async (payload) => {
    if (payload?.files) return summary;
    if (payload?.embeds) return msg;
    return {};
  });
  return {
    id: "c1",
    name: "general",
    isTextBased: () => true,
    messages: {
      fetch: vi.fn(async () => msg),
    },
    send,
  };
}

function buildClient(channel) {
  return {
    channels: {
      fetch: vi.fn(async () => channel),
    },
  };
}

async function createGiveaway({ handlers, channel, client, prize = "Prize", winners = "1" } = {}) {
  const interaction = mockInteraction({
    client,
    channel,
    isModalSubmit: () => true,
    isButton: () => false,
    customId: "giveaway:modal:abc",
    fields: {
      getTextInputValue: vi.fn((key) => {
        if (key === "duration") return "10m";
        if (key === "winners") return winners;
        if (key === "prize") return prize;
        if (key === "description") return "Desc";
        return "";
      }),
    },
  });

  const handler = handlers.get("component:giveaway:")?.handler;
  await handler({ interaction });
  return { interaction };
}

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue([[], []]);
  _test.resetState();
});

describe("giveaway slash + modal", () => {
  test("shows a modal for /giveaway create", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      options: { getSubcommand: vi.fn(() => "create") },
    });
    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid duration in modal submit", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      customId: "giveaway:modal:abc",
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "duration") return "nope";
          if (key === "winners") return "1";
          if (key === "prize") return "Prize";
          return "";
        }),
      },
    });

    const handler = handlers.get("component:giveaway:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Please provide a valid duration (e.g. 10m, 2h, 1d).",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects duration over max", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      customId: "giveaway:modal:abc",
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "duration") return "4d";
          if (key === "winners") return "1";
          if (key === "prize") return "Prize";
          return "";
        }),
      },
    });

    const handler = handlers.get("component:giveaway:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Giveaway duration cannot exceed 3 days.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects invalid winner counts", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      customId: "giveaway:modal:abc",
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "duration") return "10m";
          if (key === "winners") return "0";
          if (key === "prize") return "Prize";
          return "";
        }),
      },
    });

    const handler = handlers.get("component:giveaway:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Number of winners must be between 1 and 50.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects missing prize", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      customId: "giveaway:modal:abc",
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "duration") return "10m";
          if (key === "winners") return "1";
          if (key === "prize") return "";
          return "";
        }),
      },
    });

    const handler = handlers.get("component:giveaway:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Please provide a prize.",
        flags: expect.any(Number),
      })
    );
  });

  test("creates a giveaway from modal submit", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const channel = buildChannel();
    const client = buildClient(channel);
    const message = { id: "m1", edit: vi.fn(async () => {}) };
    channel.messages.fetch = vi.fn(async () => message);
    channel.send = vi.fn(async (payload) => (payload?.embeds ? message : {}));

    const interaction = mockInteraction({
      client,
      channel,
      isModalSubmit: () => true,
      isButton: () => false,
      customId: "giveaway:modal:abc",
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "duration") return "10m";
          if (key === "winners") return "1";
          if (key === "prize") return "Prize";
          if (key === "description") return "Desc";
          return "";
        }),
      },
    });

    const handler = handlers.get("component:giveaway:")?.handler;
    await handler({ interaction });

    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(message.edit).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "The giveaway was successfully created! ID: m1",
        flags: expect.any(Number),
      })
    );
  });
});

describe("giveaway buttons", () => {
  test("join button adds an entrant", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const channel = buildChannel();
    const client = buildClient(channel);
    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    channel.messages.fetch = vi.fn(async () => giveawayMessage);
    channel.send = vi.fn(async (payload) => (payload?.embeds ? giveawayMessage : {}));

    const componentHandler = handlers.get("component:giveaway:")?.handler;
    await createGiveaway({ handlers, channel, client });

    const joinInteraction = mockInteraction({
      client,
      user: { id: "u2" },
      isModalSubmit: () => false,
      isButton: () => true,
      customId: "giveaway:join:m1",
      message: giveawayMessage,
    });

    await componentHandler({ interaction: joinInteraction });

    expect(joinInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You have entered the giveaway!",
        flags: expect.any(Number),
      })
    );
  });

  test("duplicate join shows leave option", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const channel = buildChannel();
    const client = buildClient(channel);
    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    channel.messages.fetch = vi.fn(async () => giveawayMessage);
    channel.send = vi.fn(async (payload) => (payload?.embeds ? giveawayMessage : {}));

    const componentHandler = handlers.get("component:giveaway:")?.handler;
    await createGiveaway({ handlers, channel, client });

    const joinInteraction = mockInteraction({
      client,
      user: { id: "u2" },
      isModalSubmit: () => false,
      isButton: () => true,
      customId: "giveaway:join:m1",
      message: giveawayMessage,
    });

    await componentHandler({ interaction: joinInteraction });
    await componentHandler({ interaction: joinInteraction });

    expect(joinInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You have already entered this giveaway!",
        flags: expect.any(Number),
      })
    );
  });

  test("leave button removes entrant", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const channel = buildChannel();
    const client = buildClient(channel);
    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    channel.messages.fetch = vi.fn(async () => giveawayMessage);
    channel.send = vi.fn(async (payload) => (payload?.embeds ? giveawayMessage : {}));

    const componentHandler = handlers.get("component:giveaway:")?.handler;
    await createGiveaway({ handlers, channel, client });

    const joinInteraction = mockInteraction({
      client,
      user: { id: "u2" },
      isModalSubmit: () => false,
      isButton: () => true,
      customId: "giveaway:join:m1",
      message: giveawayMessage,
    });
    await componentHandler({ interaction: joinInteraction });

    const leaveInteraction = mockInteraction({
      client,
      user: { id: "u2" },
      isModalSubmit: () => false,
      isButton: () => true,
      customId: "giveaway:leave:m1",
      message: giveawayMessage,
    });
    await componentHandler({ interaction: leaveInteraction });

    expect(leaveInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You have left the giveaway.",
        flags: expect.any(Number),
      })
    );
  });

  test("leave when not entered rejects", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const channel = buildChannel();
    const client = buildClient(channel);
    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    channel.messages.fetch = vi.fn(async () => giveawayMessage);
    channel.send = vi.fn(async (payload) => (payload?.embeds ? giveawayMessage : {}));

    const componentHandler = handlers.get("component:giveaway:")?.handler;
    await createGiveaway({ handlers, channel, client });

    const leaveInteraction = mockInteraction({
      client,
      user: { id: "u2" },
      isModalSubmit: () => false,
      isButton: () => true,
      customId: "giveaway:leave:m1",
      message: giveawayMessage,
    });
    await componentHandler({ interaction: leaveInteraction });

    expect(leaveInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not entered in this giveaway.",
        flags: expect.any(Number),
      })
    );
  });
});

describe("giveaway list + autocomplete", () => {
  test("giveaway list returns formatted rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const endsAt = Date.now() + (9 * 60 + 50) * 1000;
    mockExecute
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
      [
        {
          message_id: "1456537975746859095",
          channel_id: "c1",
          guild_id: "g1",
          prize: "nothing. do not join",
          ends_at_ms: endsAt,
          winners_count: 1,
          host_id: "u1",
        },
      ],
      [],
    ]);

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      options: { getSubcommand: vi.fn(() => "list") },
    });
    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    const content = interaction.reply.mock.calls[0]?.[0]?.content || "";
    expect(content).toContain(
      "[1456537975746859095](https://discord.com/channels/g1/c1/1456537975746859095) | general | 1 winner"
    );
    expect(content).toContain("Prize: nothing. do not join");
    expect(content).toContain("Host: <@u1>");
    expect(content).toContain("Ends in 9 minutes, 50 seconds");

    vi.useRealTimers();
  });

  test("autocomplete returns giveaway titles without ids", async () => {
    mockExecute.mockResolvedValueOnce([
      [
        {
          message_id: "m1",
          prize: "Shiny Prize",
          ends_at_ms: Date.now() + 10000,
        },
      ],
      [],
    ]);

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const autocomplete = handlers.get("/giveaway")?.opts?.autocomplete;
    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "end"),
        getFocused: vi.fn(() => "shiny"),
      },
      respond: vi.fn(async () => {}),
    });

    await autocomplete({ interaction });

    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "Shiny Prize",
        value: "m1",
      }),
    ]);
  });

  test("autocomplete returns empty when not privileged", async () => {
    isAdminOrPrivileged.mockReturnValueOnce(false);
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const autocomplete = handlers.get("/giveaway")?.opts?.autocomplete;
    const interaction = mockInteraction({
      respond: vi.fn(async () => {}),
      options: {
        getSubcommand: vi.fn(() => "end"),
        getFocused: vi.fn(() => ""),
      },
    });

    await autocomplete({ interaction });
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

describe("giveaway reroll errors", () => {
  test("reroll reports a friendly error on failure", async () => {
    mockExecute
      .mockResolvedValueOnce([[], []])
      .mockRejectedValueOnce(new Error("db fail"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "reroll"),
        getString: vi.fn(() => "m1"),
      },
    });

    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "💥 An error occurred when trying to reroll the giveaway.",
        flags: expect.any(Number),
      })
    );

    warnSpy.mockRestore();
  });
});

describe("giveaway end/delete flows", () => {
  test("giveaway end shows a dropdown when no message id provided", async () => {
    mockExecute
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          { message_id: "m1", prize: "Prize", ends_at_ms: Date.now() + 1000 },
        ],
        [],
      ]);

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "end"),
        getString: vi.fn(() => ""),
      },
    });
    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Select a giveaway to end:",
        components: expect.any(Array),
        flags: expect.any(Number),
      })
    );
  });

  test("giveaway delete shows a dropdown when no message id provided", async () => {
    mockExecute
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([
        [
          { message_id: "m1", prize: "Prize", ends_at_ms: Date.now() + 1000 },
        ],
        [],
      ]);

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "delete"),
        getString: vi.fn(() => ""),
      },
    });
    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Select a giveaway to cancel:",
        components: expect.any(Array),
        flags: expect.any(Number),
      })
    );
  });

  test("giveaway end ends an active giveaway", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    const channel = buildChannel({ giveawayMessage });
    const client = buildClient(channel);
    channel.messages.fetch = vi.fn(async () => giveawayMessage);

    await createGiveaway({ handlers, channel, client });

    const interaction = mockInteraction({
      client,
      options: {
        getSubcommand: vi.fn(() => "end"),
        getString: vi.fn(() => "m1"),
      },
    });

    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Ending giveaway m1...",
        flags: expect.any(Number),
      })
    );
    expect(giveawayMessage.edit).toHaveBeenCalled();
  });

  test("giveaway delete cancels an active giveaway", async () => {
    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    const channel = buildChannel({ giveawayMessage });
    const client = buildClient(channel);
    channel.messages.fetch = vi.fn(async () => giveawayMessage);

    await createGiveaway({ handlers, channel, client });

    const interaction = mockInteraction({
      client,
      options: {
        getSubcommand: vi.fn(() => "delete"),
        getString: vi.fn(() => "m1"),
      },
    });

    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Giveaway m1 cancelled.",
        flags: expect.any(Number),
      })
    );
    expect(giveawayMessage.edit).toHaveBeenCalled();
  });
});

describe("giveaway reroll success", () => {
  test("reroll updates winners and edits message", async () => {
    const record = {
      message_id: "m1",
      guild_id: "g1",
      channel_id: "c1",
      host_id: "u1",
      prize: "Prize",
      description: "",
      winners_count: 1,
      ends_at_ms: Date.now() - 1000,
      entrants_json: JSON.stringify(["u2", "u3"]),
      winners_json: JSON.stringify(["u2"]),
      ended_at_ms: Date.now() - 500,
      summary_message_id: "s1",
      canceled: 0,
    };

    mockExecute
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[record], []])
      .mockResolvedValueOnce([[], []]);

    const { handlers, register } = buildRegister();
    registerGiveaway(register);

    const giveawayMessage = { id: "m1", edit: vi.fn(async () => {}) };
    const channel = buildChannel({ giveawayMessage });
    const client = buildClient(channel);
    channel.messages.fetch = vi.fn(async () => ({
      ...giveawayMessage,
      components: [{ components: [{ url: "https://example.com/summary" }] }],
    }));

    const interaction = mockInteraction({
      client,
      options: {
        getSubcommand: vi.fn(() => "reroll"),
        getString: vi.fn(() => "m1"),
      },
    });

    const handler = handlers.get("/giveaway")?.handler;
    await handler({ interaction });

    expect(giveawayMessage.edit).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Rerolled giveaway m1.",
        flags: expect.any(Number),
      })
    );
  });
});
