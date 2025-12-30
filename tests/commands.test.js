import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => false),
}));

vi.mock("../configs/command_exposure.js", () => ({
  DEFAULT_EXPOSURE: "bang",
  COMMAND_EXPOSURE_BY_GUILD: {
    g1: { ping: "q" },
    g2: { ping: "off" },
  },
  COMMAND_CHANNEL_POLICY_BY_GUILD: {
    g3: { ping: { allow: ["c-allowed"], silent: false } },
  },
}));

vi.mock("../trades.js", () => ({ registerTrades: vi.fn() }));
vi.mock("../tools.js", () => ({ registerTools: vi.fn() }));
vi.mock("../faq.js", () => ({ registerInfoCommands: vi.fn() }));
vi.mock("../verification/verification_module.js", () => ({ registerVerification: vi.fn() }));
vi.mock("../contests/contests.js", () => ({ registerContests: vi.fn() }));
vi.mock("../games/games.js", () => ({ registerGames: vi.fn() }));
vi.mock("../toybox.js", () => ({ registerToybox: vi.fn() }));
vi.mock("../helpbox.js", () => ({ registerHelpbox: vi.fn() }));
vi.mock("../rarity.js", () => ({ handleRarityInteraction: vi.fn(async () => null) }));

import { buildCommandRegistry } from "../commands.js";
import { isAdminOrPrivileged } from "../auth.js";
import { registerHelpbox } from "../helpbox.js";
import { registerTrades } from "../trades.js";

function makeMessage({ guildId = "g1", channelId = "c1", content = "" } = {}) {
  return {
    guildId,
    channelId,
    content,
    reply: vi.fn(async () => ({})),
  };
}

function lastCall(mockFn) {
  return mockFn.mock.calls[mockFn.mock.calls.length - 1] || [];
}

describe("commands registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTrades.mockReset();
    isAdminOrPrivileged.mockReturnValue(false);
  });

  it("register.expose routes by exposure (bang/q/off)", async () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register.expose({
        logicalId: "ping",
        name: "ping",
        handler,
        help: "!ping - check",
        opts: { category: "Info" },
      });
    });

    const reg = buildCommandRegistry({});

    await reg.dispatchMessage(makeMessage({ guildId: "g0", content: "!ping" }));
    expect(handler).toHaveBeenCalledTimes(1);

    await reg.dispatchMessage(makeMessage({ guildId: "g0", content: "?ping" }));
    expect(handler).toHaveBeenCalledTimes(1);

    await reg.dispatchMessage(makeMessage({ guildId: "g1", content: "?ping" }));
    expect(handler).toHaveBeenCalledTimes(2);

    await reg.dispatchMessage(makeMessage({ guildId: "g1", content: "!ping" }));
    expect(handler).toHaveBeenCalledTimes(2);

    await reg.dispatchMessage(makeMessage({ guildId: "g2", content: "!ping" }));
    await reg.dispatchMessage(makeMessage({ guildId: "g2", content: "?ping" }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("register.component routes to the longest matching prefix", async () => {
    const shortHandler = vi.fn(async () => {});
    const longHandler = vi.fn(async () => {});

    registerTrades.mockImplementation((register) => {
      register.component("foo:", shortHandler);
      register.component("foo:bar:", longHandler);
    });

    const reg = buildCommandRegistry({});
    const interaction = {
      customId: "foo:bar:xyz",
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
    };

    await reg.dispatchInteraction(interaction);
    expect(longHandler).toHaveBeenCalledTimes(1);
    expect(shortHandler).toHaveBeenCalledTimes(0);
  });

  it("register.component rejects duplicate prefixes", () => {
    registerTrades.mockImplementation((register) => {
      register.component("dup:", async () => {});
      register.component("dup:", async () => {});
    });

    expect(() => buildCommandRegistry({})).toThrow(/Duplicate component prefix/);
  });

  it("register.expose respects channel policies with silent=false", async () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register.expose({
        logicalId: "ping",
        name: "ping",
        handler,
        help: "!ping - check",
        opts: { category: "Info" },
      });
    });

    const reg = buildCommandRegistry({});

    const msg = makeMessage({ guildId: "g3", channelId: "c-denied", content: "!ping" });
    await reg.dispatchMessage(msg);
    expect(msg.reply).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("registerHelpbox receives helpModel", () => {
    const reg = buildCommandRegistry({});
    const call = lastCall(registerHelpbox);
    expect(call[1]?.helpModel).toBe(reg.helpModel);
  });
});
