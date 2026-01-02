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

import { registerPollContest, _test } from "../../contests/pollcontest.js";

function buildRegister() {
  const handlers = new Map();
  const register = (cmd, handler, help, options) => {
    handlers.set(cmd, { handler, help, options });
  };
  register.slash = (meta, handler) => {
    handlers.set(`/${meta.name}`, { handler, meta });
  };
  register.component = (prefix, handler) => {
    handlers.set(`component:${prefix}`, { handler, prefix });
  };
  register.listener = (handler) => {
    handlers.set("listener", { handler });
  };
  return { handlers, register };
}

function mockInteraction(overrides = {}) {
  return {
    guildId: "g1",
    channelId: "c1",
    user: { id: "u1" },
    client: { on: vi.fn() },
    showModal: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    options: {
      getSubcommand: vi.fn(() => "create"),
      getString: vi.fn(() => ""),
    },
    ...overrides,
  };
}

beforeEach(() => {
  _test.resetState?.();
});

describe("pollcontest helpers", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([[], []]);
  });

  test("resolveWinnersOnly detects ties", () => {
    const res = _test.resolveWinnersOnly([
      { voters: ["a"] },
      { voters: ["b"] },
    ]);
    expect(res.mode).toBe("tie");
    expect(res.indices).toEqual([0, 1]);
  });
});

describe("pollcontest validation", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue([[], []]);
  });

  test("shows a modal for /pollcontest create", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const interaction = mockInteraction();
    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modalArg = interaction.showModal.mock.calls[0][0];
    expect(String(modalArg?.data?.custom_id || "")).toMatch(/^pollcontest:modal:/);
  });

  test("rejects polls with fewer than two options", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "options") return "Only option";
          if (key === "duration") return "10m";
          return "Question?";
        }),
      },
    });

    const handler = handlers.get("component:pollcontest:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Please provide at least two poll options.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects invalid durations", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const interaction = mockInteraction({
      isModalSubmit: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      fields: {
        getTextInputValue: vi.fn((key) => {
          if (key === "options") return "A\nB";
          if (key === "duration") return "25h";
          return "Question?";
        }),
      },
    });

    const handler = handlers.get("component:pollcontest:")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Poll duration cannot exceed 24 hours.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects polls started outside a guild", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const interaction = mockInteraction({ guildId: null });
    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Poll contests must be created in a server channel.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects invalid poll_id references", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({ poll: null })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Could not find a poll with that message ID in this channel.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects poll_id when poll is in another channel", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const answers = new Map([
      [0, { text: "A" }],
      [1, { text: "B" }],
    ]);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({
            id: "123",
            channelId: "other-channel",
            author: { id: "u2" },
            poll: {
              allowMultiselect: false,
              expiresTimestamp: Date.now() + 60_000,
              answers,
            },
          })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "That poll is not in this channel.",
        flags: expect.any(Number),
      })
    );
  });

  test("rejects poll_id when poll was started by bot", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const answers = new Map([
      [0, { text: "A" }],
      [1, { text: "B" }],
    ]);

    mockExecute.mockResolvedValue([[], []]);

    const interaction = mockInteraction({
      client: { on: vi.fn(), user: { id: "bot" } },
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({
            id: "123",
            channelId: "c1",
            author: { id: "bot" },
            poll: {
              allowMultiselect: false,
              expiresTimestamp: Date.now() + 60_000,
              answers,
            },
          })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "That poll was started by Spectreon and is already tracked.",
        flags: expect.any(Number),
      })
    );
  });

  test("allows poll_id when bot poll was previously untracked", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const answers = new Map([
      [0, { text: "A" }],
      [1, { text: "B" }],
    ]);

    mockExecute.mockImplementation(async (sql) => {
      if (String(sql).includes("poll_untracked")) {
        return [[{ message_id: "123" }], []];
      }
      return [[], []];
    });

    const interaction = mockInteraction({
      client: { on: vi.fn(), user: { id: "bot" } },
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({
            id: "123",
            channelId: "c1",
            author: { id: "bot" },
            poll: {
              allowMultiselect: false,
              expiresTimestamp: Date.now() + 60_000,
              answers,
            },
          })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Using existing poll."),
        flags: expect.any(Number),
      })
    );
  });

  test("allows ended poll_id and shows ended note", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const answers = new Map([
      [0, { text: "A" }],
      [1, { text: "B" }],
    ]);

    const interaction = mockInteraction({
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({
            id: "123",
            channelId: "c1",
            author: { id: "other" },
            poll: {
              allowMultiselect: false,
              expiresTimestamp: Date.now() - 1000,
              answers,
            },
          })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already ended"),
        flags: expect.any(Number),
      })
    );
  });

  test("uses poll author for list header when tracking external poll", async () => {
    const { handlers, register } = buildRegister();
    registerPollContest(register);

    const answers = new Map([
      [0, { text: "Yes", voters: { fetch: vi.fn(async () => new Map()) } }],
      [1, { text: "No", voters: { fetch: vi.fn(async () => new Map()) } }],
    ]);

    const channel = {
      id: "c1",
      isTextBased: () => true,
      send: vi.fn(async () => {}),
      messages: {
        endPoll: vi.fn(async () => {}),
        fetch: vi.fn(async () => ({
          id: "123",
          channelId: "c1",
          author: { id: "author-1" },
          poll: {
            allowMultiselect: false,
            expiresTimestamp: Date.now() - 1000,
            question: { text: "Question?" },
            answers,
          },
        })),
      },
      guild: {
        members: {
          fetch: vi.fn(async () => new Map()),
          cache: new Map(),
        },
      },
    };

    const client = {
      on: vi.fn(),
      user: { id: "bot" },
      channels: { fetch: vi.fn(async () => channel) },
    };

    const interaction = mockInteraction({
      client,
      options: {
        getSubcommand: vi.fn(() => "create"),
        getString: vi.fn(() => "123"),
      },
      channel: {
        messages: {
          fetch: vi.fn(async () => ({
            id: "123",
            channelId: "c1",
            author: { id: "author-1" },
            poll: {
              allowMultiselect: false,
              expiresTimestamp: Date.now() - 1000,
              question: { text: "Question?" },
              answers,
            },
          })),
        },
      },
    });

    const handler = handlers.get("/pollcontest")?.handler;
    await handler({ interaction });

    const reply = interaction.reply.mock.calls[0][0];
    const startId = String(reply?.components?.[1]?.components?.[0]?.data?.custom_id || "");

    const toggleInteraction = mockInteraction({
      client,
      isModalSubmit: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      customId: startId.replace(":start:", ":toggle:lists:"),
      update: vi.fn(async () => {}),
    });
    const componentHandler = handlers.get("component:pollcontest:")?.handler;
    await componentHandler({ interaction: toggleInteraction });

    const startInteraction = mockInteraction({
      client,
      isModalSubmit: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      customId: startId,
      channel,
      update: vi.fn(async () => {}),
    });
    await componentHandler({ interaction: startInteraction });

    const listMessage = channel.send.mock.calls
      .map((call) => String(call[0] || ""))
      .find((content) => content.includes("Poll started by:"));

    expect(listMessage).toContain("Poll started by: <@author-1>");
  });
});
