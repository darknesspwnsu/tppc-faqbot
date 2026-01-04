import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn() } }));

import { registerMafia } from "../../games/mafia.js";

function buildRegister() {
  const handlers = new Map();
  const register = (cmd, handler) => {
    handlers.set(cmd, { handler });
  };
  register.onMessage = () => {};
  register.listener = () => {};
  return { handlers, register };
}

function mockMessage(overrides = {}) {
  return {
    guildId: "g1",
    channelId: "c1",
    author: { id: "u1" },
    content: "",
    reply: vi.fn(async () => {}),
    channel: {
      send: vi.fn(async () => ({ id: "m1", react: vi.fn(async () => {}) })),
    },
    client: {
      users: {
        fetch: vi.fn(async () => ({
          createDM: vi.fn(async () => ({ send: vi.fn(async () => {}) })),
        })),
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mafia command", () => {
  test("starts a lobby on !mafia", async () => {
    const { handlers, register } = buildRegister();
    registerMafia(register);

    const message = mockMessage();
    const handler = handlers.get("!mafia")?.handler;
    await handler({ message, rest: "" });

    expect(message.channel.send).toHaveBeenCalledTimes(1);
  });

  test("shows help on !mafia help", async () => {
    const { handlers, register } = buildRegister();
    registerMafia(register);

    const message = mockMessage();
    const handler = handlers.get("!mafia")?.handler;
    await handler({ message, rest: "help" });

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Mafia — Help"),
      })
    );
  });

  test("rejects start without enough players", async () => {
    const { handlers, register } = buildRegister();
    registerMafia(register);

    const joinMsg = {
      id: "m1",
      react: vi.fn(async () => {}),
      reactions: {
        cache: new Map([
          [
            "✅",
            {
              users: {
                fetch: vi.fn(async () =>
                  new Map([
                    ["u1", { id: "u1", bot: false }],
                    ["u2", { id: "u2", bot: false }],
                  ])
                ),
              },
            },
          ],
        ]),
      },
    };

    const message = mockMessage({
      channel: {
        send: vi.fn(async () => joinMsg),
        messages: {
          fetch: vi.fn(async () => joinMsg),
        },
      },
    });

    const handler = handlers.get("!mafia")?.handler;
    await handler({ message, rest: "" });
    await handler({ message, rest: "start" });

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Need at least"),
      })
    );
  });

  test("warns the channel when detective DM fails", async () => {
    const { handlers, register } = buildRegister();
    registerMafia(register);

    const joinUsers = new Map([
      ["1", { id: "1", bot: false }],
      ["2", { id: "2", bot: false }],
      ["3", { id: "3", bot: false }],
      ["4", { id: "4", bot: false }],
      ["5", { id: "5", bot: false }],
    ]);

    const joinMsg = {
      id: "m1",
      react: vi.fn(async () => {}),
      reactions: {
        cache: new Map([
          [
            "✅",
            {
              users: {
                fetch: vi.fn(async () => joinUsers),
              },
            },
          ],
        ]),
      },
    };

    const detectiveUser = { id: "3", createDM: vi.fn() };
    detectiveUser.createDM
      .mockResolvedValueOnce({ send: vi.fn(async () => {}) })
      .mockRejectedValueOnce(Object.assign(new Error("DMs closed"), { code: 50007 }));

    const userMap = new Map([
      ["1", { id: "1", createDM: vi.fn(async () => ({ send: vi.fn(async () => {}) })) }],
      ["2", { id: "2", createDM: vi.fn(async () => ({ send: vi.fn(async () => {}) })) }],
      ["3", detectiveUser],
      ["4", { id: "4", createDM: vi.fn(async () => ({ send: vi.fn(async () => {}) })) }],
      ["5", { id: "5", createDM: vi.fn(async () => ({ send: vi.fn(async () => {}) })) }],
    ]);

    const channel = {
      send: vi.fn(async () => joinMsg),
      messages: {
        fetch: vi.fn(async () => joinMsg),
      },
    };

    const message = mockMessage({
      author: { id: "1" },
      channel,
      client: {
        users: {
          fetch: vi.fn(async (id) => userMap.get(id)),
        },
      },
    });

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.999);

    const handler = handlers.get("!mafia")?.handler;
    await handler({ message, rest: "" });
    await handler({ message, rest: "start" });

    const dmMessage = mockMessage({
      guildId: null,
      channelId: null,
      author: { id: "3" },
      reply: vi.fn(async () => {}),
    });
    await handler({ message: dmMessage, rest: "inspect <@2>" });

    await handler({ message, rest: "resolve" });

    const warningSent = channel.send.mock.calls.some((call) =>
      String(call[0]).includes("Detective could not be reached via DM")
    );
    expect(warningSent).toBe(true);

    randomSpy.mockRestore();
  });
});
