import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../auth.js", () => ({
  isAdminOrPrivileged: vi.fn(() => false),
}));

vi.mock("../../shared/metrics.js", () => ({
  metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn(), incrementSchedulerRun: vi.fn() },
}));

vi.mock("../../configs/command_exposure.js", () => ({
  DEFAULT_EXPOSURE: "bang",
  DEFAULT_SLASH_EXPOSURE: "on",
  COMMAND_EXPOSURE_BY_GUILD: {
    g1: { ping: "q", bangoff: "off" },
    g2: { ping: "off" },
  },
  SLASH_EXPOSURE_BY_GUILD: {
    g1: { slashoff: "off" },
  },
  COMMAND_CHANNEL_POLICY_BY_GUILD: {
    g3: { ping: { allow: ["c-allowed"], silent: false } },
  },
}));

vi.mock("../../trades/trades.js", () => ({ registerTrades: vi.fn() }));
vi.mock("../../tools/tools.js", () => ({ registerTools: vi.fn() }));
vi.mock("../../info/info.js", () => ({ registerInfo: vi.fn() }));
vi.mock("../../verification/verification.js", () => ({ registerVerification: vi.fn() }));
vi.mock("../../contests/contests.js", () => ({ registerContests: vi.fn() }));
vi.mock("../../games/games.js", () => ({ registerGames: vi.fn() }));
vi.mock("../../toybox.js", () => ({ registerToybox: vi.fn() }));
vi.mock("../../tools/rarity.js", () => ({ handleRarityInteraction: vi.fn(async () => null) }));
vi.mock("../../rpg/pokedex.js", () => ({
  handlePokedexInteraction: vi.fn(async () => null),
  registerPokedex: vi.fn(),
}));

import { buildCommandRegistry } from "../../commands.js";
import { isAdminOrPrivileged } from "../../auth.js";
import { registerInfo } from "../../info/info.js";
import { registerTrades } from "../../trades/trades.js";
import { handleRarityInteraction } from "../../tools/rarity.js";
import { handlePokedexInteraction } from "../../rpg/pokedex.js";

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

  it("registerInfo receives helpModel", () => {
    const reg = buildCommandRegistry({});
    const call = lastCall(registerInfo);
    expect(call[1]?.helpModel).toBe(reg.helpModel);
  });

  it("helpModel moves admin commands to the Admin category", () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register("!usercmd", handler, "!usercmd — user", { category: "Info" });
      register("!admincmd", handler, "!admincmd — admin", { category: "Info", admin: true });
    });

    isAdminOrPrivileged.mockReturnValue(true);
    const reg = buildCommandRegistry({});

    const pages = reg.helpModel("g1", makeMessage({ guildId: "g1" }));
    const info = pages.find((page) => page.category === "Info");
    const admin = pages.find((page) => page.category === "Admin");

    expect(info?.lines || []).toContain("!usercmd — user");
    expect(info?.lines || []).not.toContain("!admincmd — admin");
    expect(admin?.lines || []).toContain("!admincmd — admin");
  });

  it("helpModel hides admin commands for non-admin viewers", () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register("!admincmd", handler, "!admincmd — admin", { category: "Info", admin: true });
    });

    isAdminOrPrivileged.mockReturnValue(false);
    const reg = buildCommandRegistry({});
    const pages = reg.helpModel("g1", makeMessage({ guildId: "g1" }));

    expect(pages.some((page) => page.category === "Admin")).toBe(false);
    expect(pages.some((page) => (page.lines || []).includes("!admincmd — admin"))).toBe(false);
  });

  it("helpModel sorts categories alphabetically with Admin last", () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register("!alpha", handler, "!alpha — user", { category: "Alpha" });
      register("!beta", handler, "!beta — user", { category: "Beta" });
      register("!admincmd", handler, "!admincmd — admin", { category: "Info", admin: true });
    });

    isAdminOrPrivileged.mockReturnValue(true);
    const reg = buildCommandRegistry({});
    const pages = reg.helpModel("g1", makeMessage({ guildId: "g1" }));
    const categories = pages.map((page) => page.category);

    const subset = categories.filter((cat) => ["Alpha", "Beta", "Admin"].includes(cat));
    expect(subset).toEqual(["Alpha", "Beta", "Admin"]);
    expect(categories[categories.length - 1]).toBe("Admin");
  });

  it("helpModel keeps admin commands in override categories", () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register("!admincmd", handler, "!admincmd — admin", {
        category: "Info",
        admin: true,
        adminCategory: "Contests",
      });
    });

    isAdminOrPrivileged.mockReturnValue(true);
    const reg = buildCommandRegistry({});
    const pages = reg.helpModel("g1", makeMessage({ guildId: "g1" }));

    const contests = pages.find((page) => page.category === "Contests");
    const admin = pages.find((page) => page.category === "Admin");

    expect(contests?.lines || []).toContain("!admincmd — admin");
    expect(admin?.lines || []).not.toContain("!admincmd — admin");
  });

  it("dispatchMessage logs errors from handlers without throwing", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    registerTrades.mockImplementation((register) => {
      register.expose({
        logicalId: "boom",
        name: "boom",
        handler,
        help: "!boom - test",
        opts: { category: "Info" },
      });
    });

    const reg = buildCommandRegistry({});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reg.dispatchMessage(makeMessage({ guildId: "g0", content: "!boom" }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it("dispatchMessage blocks bang commands disabled in the guild", async () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register("!bangoff", handler, "!bangoff — test");
    });

    const reg = buildCommandRegistry({});
    const msg = makeMessage({ guildId: "g1", content: "!bangoff" });
    await reg.dispatchMessage(msg);

    expect(handler).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith("This command isn’t allowed in this server.");
  });

  it("dispatchInteraction logs errors from slash handlers without throwing", async () => {
    const handler = vi.fn(async () => {
      throw new Error("slash boom");
    });
    registerTrades.mockImplementation((register) => {
      register.slash({ name: "boom", description: "test" }, handler);
    });

    const reg = buildCommandRegistry({});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const interaction = {
      commandName: "boom",
      isChatInputCommand: () => true,
    };

    await reg.dispatchInteraction(interaction);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });

  it("dispatchInteraction routes autocomplete interactions", async () => {
    const autoHandler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register.slash({ name: "auto", description: "test" }, async () => {}, {
        autocomplete: autoHandler,
      });
    });

    const reg = buildCommandRegistry({});
    const interaction = {
      commandName: "auto",
      isAutocomplete: () => true,
    };

    await reg.dispatchInteraction(interaction);
    expect(autoHandler).toHaveBeenCalledTimes(1);
  });

  it("dispatchInteraction blocks slash commands disabled in the guild", async () => {
    const handler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register.slash({ name: "slashoff", description: "test" }, handler);
    });

    const reg = buildCommandRegistry({});
    const interaction = {
      commandName: "slashoff",
      guildId: "g1",
      isChatInputCommand: () => true,
      reply: vi.fn(async () => {}),
    };

    await reg.dispatchInteraction(interaction);
    expect(handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This command isn’t allowed in this server.",
        ephemeral: true,
      })
    );
  });

  it("helpModel hides slash commands disabled in the guild", () => {
    registerTrades.mockImplementation((register) => {
      register.slash({ name: "slashoff", description: "test" }, async () => {});
      register.slash({ name: "slashion", description: "ok" }, async () => {});
    });

    const reg = buildCommandRegistry({});
    const pages = reg.helpModel("g1");
    const flat = pages.flatMap((p) => p.lines);
    expect(flat.some((line) => line.includes("/slashoff"))).toBe(false);
    expect(flat.some((line) => line.includes("/slashion"))).toBe(true);
  });

  it("falls back to component handler when rarity retry throws", async () => {
    handleRarityInteraction.mockImplementationOnce(async () => {
      throw new Error("rarity boom");
    });

    const componentHandler = vi.fn(async () => {});
    registerTrades.mockImplementation((register) => {
      register.component("rarity_retry:", componentHandler);
    });

    const reg = buildCommandRegistry({});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const interaction = {
      customId: "rarity_retry:abc",
      isChatInputCommand: () => false,
      isModalSubmit: () => false,
      guildId: "g1",
      guild: { id: "g1" },
      channel: { id: "c1" },
      user: { id: "u1" },
      member: {},
    };

    await reg.dispatchInteraction(interaction);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(componentHandler).toHaveBeenCalledTimes(1);

    errSpy.mockRestore();
  });
});
