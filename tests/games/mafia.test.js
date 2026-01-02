import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => true),
}));

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
});
