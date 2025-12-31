import { describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

vi.mock("../../db.js", () => ({
  getDb: () => ({
    execute: vi.fn(async () => [[], []]),
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
    ...overrides,
  };
}

describe("pollcontest helpers", () => {
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
  test("shows a modal for /pollcontest", async () => {
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
});
