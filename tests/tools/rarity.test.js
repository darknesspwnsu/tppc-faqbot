import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const RARITY_JSON = JSON.stringify({
  meta: { lastUpdatedText: "12-30-2025 07:10 EST" },
  data: {
    Pikachu: { total: 10, male: 4, female: 3, ungendered: 2, genderless: 1 },
    "Shiny Pikachu": { total: 1, male: 1, female: 0, ungendered: 0, genderless: 0 },
    "Golden Meowth": { total: 5, male: 2, female: 2, ungendered: 1, genderless: 0 },
    "Golden Meowth (Alola)": { total: 3, male: 1, female: 1, ungendered: 1, genderless: 0 },
    "Golden Vulpix (Alola)": { total: 4, male: 2, female: 1, ungendered: 1, genderless: 0 },
  },
});

const L4_JSON = JSON.stringify({
  meta: { lastUpdatedText: "12-30-2025 07:10 EST" },
  data: {
    Pikachu: { total: 2, male: 1, female: 1, ungendered: 0, genderless: 0 },
  },
});

const RARITY_HISTORY_JSON = JSON.stringify({
  status: "success",
  data: {
    name: "Pikachu",
    last_update: "5 minutes",
    male: 4,
    female: 3,
    ungendered: 2,
    genderless: 1,
    total: 10,
    historical: { timeframe: "7d" },
    changes: { male: 1, female: 0, ungendered: -1, genderless: 0, total: 0 },
  },
});

const isAdminOrPrivileged = vi.fn(() => true);

vi.mock("../../auth.js", () => ({ isAdminOrPrivileged }));
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn(), incrementSchedulerRun: vi.fn() } }));

const httpGet = vi.fn((url, cb) => {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setEncoding = vi.fn();

  const urlStr = String(url);
  let payload = RARITY_JSON;
  if (urlStr.includes("api/v1/rarity")) {
    payload = RARITY_HISTORY_JSON;
  } else if (urlStr.includes("l4")) {
    payload = L4_JSON;
  }
  process.nextTick(() => {
    cb(res);
    res.emit("data", payload);
    res.emit("end");
  });

  return { on: vi.fn() };
});

vi.mock("node:http", () => ({ default: { get: httpGet }, get: httpGet }));
vi.mock("node:https", () => ({ default: { get: httpGet }, get: httpGet }));

vi.mock("discord.js", () => {
  class ActionRowBuilder {
    constructor() {
      this.components = [];
    }
    addComponents(...comps) {
      const flat = comps.flat();
      this.components.push(...flat);
      return this;
    }
  }

  class ButtonBuilder {
    constructor() {
      this.data = {};
    }
    setCustomId(id) {
      this.data.customId = id;
      return this;
    }
    setLabel(label) {
      this.data.label = label;
      return this;
    }
    setStyle(style) {
      this.data.style = style;
      return this;
    }
  }

  return {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle: { Secondary: "Secondary" },
  };
});

const originalEnv = { ...process.env };

async function loadRarityModule() {
  vi.resetModules();
  return import("../../tools/rarity.js");
}

beforeEach(() => {
  process.env = {
    ...originalEnv,
    RARITY_JSON_URL: "http://example.test/rarity.json",
    RARITY4_JSON_URL: "http://example.test/l4_rarity.json",
  };
  httpGet.mockClear();
  vi.spyOn(global, "setTimeout").mockImplementation(() => 0);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("rarity.js", () => {
  it("registerRarity serves entries and suggestions", async () => {
    const { registerRarity } = await loadRarityModule();
    const register = { expose: vi.fn() };

    registerRarity(register);
    await new Promise((r) => setImmediate(r));

    const rarityCall = register.expose.mock.calls.find((call) => call[0].name === "rarity");
    const handler = rarityCall[0].handler;

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "Pikachu", cmd: "?rarity" });
    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Pikachu" })],
      })
    );

    await handler({ message, rest: "Pikac", cmd: "?rarity" });
    const payload = message.reply.mock.calls[0][0];
    expect(payload.content).toContain("Did you mean");
  });

  it("includes the requester id in rarity suggestion buttons", async () => {
    const { registerRarity } = await loadRarityModule();
    const register = { expose: vi.fn() };

    registerRarity(register);
    await new Promise((r) => setImmediate(r));

    const rarityCall = register.expose.mock.calls.find((call) => call[0].name === "rarity");
    const handler = rarityCall[0].handler;

    const message = {
      author: { id: "123456789012345678" },
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "Pikac", cmd: "?rarity" });
    const payload = message.reply.mock.calls[0][0];
    const customId = payload.components[0].components[0].data.customId;
    expect(customId).toContain("rarity_retry:123456789012345678:");
  });

  it("registerRarity supports help and history timeframes", async () => {
    const { registerRarity } = await loadRarityModule();
    const register = { expose: vi.fn() };

    registerRarity(register);
    await new Promise((r) => setImmediate(r));

    const rarityCall = register.expose.mock.calls.find((call) => call[0].name === "rarity");
    const handler = rarityCall[0].handler;

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "help", cmd: "!rarity" });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("Usage: `!rarity <pokemon>`")
    );

    await handler({ message, rest: "Pikachu 7d", cmd: "!rarity" });
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Pikachu — Rarity History (7 days)",
          }),
        ],
      })
    );
  });

  it("registerLevel4Rarity returns usage when no query is provided", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const l4Call = register.expose.mock.calls.find((call) => call[0].name === "l4");
    const handler = l4Call[0].handler;

    const message = { reply: vi.fn(async () => ({})) };
    await handler({ message, rest: "", cmd: "!l4" });
    expect(message.reply).toHaveBeenCalledWith("Usage: `!l4 <pokemon>`");
  });

  it("handleRarityInteraction maps retry buttons to commands", async () => {
    const { handleRarityInteraction } = await loadRarityModule();

    const interaction = {
      isButton: () => true,
      customId: "rarity_retry:?rarity:Pikachu:",
      user: { id: "u1" },
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
      message: {
        components: [
          {
            components: [
              {
                type: 2,
                custom_id: "rarity_retry:?rarity:Pikachu:",
                label: "Pikachu",
                style: 2,
              },
            ],
          },
        ],
      },
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toEqual({ cmd: "?rarity", rest: "Pikachu" });
  });

  it("rejects rarity retry buttons from other users", async () => {
    const { handleRarityInteraction } = await loadRarityModule();

    const interaction = {
      isButton: () => true,
      customId: "rarity_retry:123456789012345678:?rarity:Pikachu:",
      user: { id: "987654321098765432" },
      reply: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
      message: { components: [] },
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toBe(false);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true })
    );
  });

  it("handleRarityInteraction preserves extras for rarity retries", async () => {
    const { handleRarityInteraction } = await loadRarityModule();

    const interaction = {
      isButton: () => true,
      customId: "rarity_retry:?rarity:Pikachu:7d",
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
      message: { components: [] },
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toEqual({ cmd: "?rarity", rest: "Pikachu 7d" });
  });

  it("handleRarityInteraction maps generic rarity retries", async () => {
    const { handleRarityInteraction } = await loadRarityModule();

    const interaction = {
      isButton: () => true,
      customId: "rarity_retry:!rc_replace:Pikachu:2%7Cg.meowth%7Cg.vulpix%20(alola)",
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
      message: { components: [] },
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toEqual({ cmd: "!rc", rest: "\"g.meowth\" \"g.vulpix (alola)\" \"Pikachu\"" });
  });

  it("registerRarityHistory fetches API data and formats output", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rhCall = register.mock.calls.find((call) => call[0] === "!rh");
    const handler = rhCall[1];

    const message = { reply: vi.fn(async () => ({})) };
    await handler({ message, rest: "Pikachu 7d" });

    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Pikachu — Rarity History (7 days)",
            fields: expect.arrayContaining([
              expect.objectContaining({ name: "Total", value: "10 (0)" }),
              expect.objectContaining({ name: "♂", value: "4 (+1)" }),
            ]),
          }),
        ],
      })
    );
  });

  it("registerRarityHistory keeps timeframe on did-you-mean retries", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rhCall = register.mock.calls.find((call) => call[0] === "!rh");
    const handler = rhCall[1];

    const message = { reply: vi.fn(async () => ({})) };
    await handler({ message, rest: "Pikac 7d" });

    const payload = message.reply.mock.calls[0][0];
    const button = payload.components[0].components[0].data;
    expect(button.customId).toContain("rarity_retry:!rh:Pikachu:7d");
  });

  it("registerRarityHistory maps retry buttons back to timeframe", async () => {
    const { handleRarityInteraction } = await loadRarityModule();

    const interaction = {
      isButton: () => true,
      customId: "rarity_retry:!rh:Pikachu:7d",
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
      message: {
        components: [
          {
            components: [
              {
                type: 2,
                custom_id: "rarity_retry:!rh:Pikachu:7d",
                label: "Pikachu",
                style: 2,
              },
            ],
          },
        ],
      },
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toEqual({ cmd: "!rh", rest: "Pikachu 7d" });
  });

  it("registerRarityHistory accepts years and converts to months", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rhCall = register.mock.calls.find((call) => call[0] === "!rh");
    const handler = rhCall[1];

    const message = { reply: vi.fn(async () => ({})) };
    await handler({ message, rest: "Pikachu 1 year" });

    const apiCall = httpGet.mock.calls.find((call) =>
      String(call[0]).includes("api/v1/rarity")
    );
    expect(String(apiCall[0])).toContain("timeframe=12m");
  });

  it("rarity comparison supports parenthetical forms as a single arg", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "g.meowth g.meowth (alola)" });

    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Golden Meowth vs Golden Meowth (Alola)" })],
      })
    );
    expect(message.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("compare a Pokémon to itself")
    );
  });

  it("rarity comparison accepts missing space before forms", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "g.meowth(alola) g.meowth" });

    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Golden Meowth (Alola) vs Golden Meowth" })],
      })
    );
  });

  it("rarity comparison accepts variant prefix without dot for forms", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "g.meowth gmeowth (alola)" });

    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.objectContaining({ title: "Golden Meowth vs Golden Meowth (Alola)" })],
      })
    );
  });

  it("rarity comparison supports multiple parenthetical forms", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "g.vulpix (alola) g.meowth (alola)" });

    expect(message.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            title: "Golden Vulpix (Alola) vs Golden Meowth (Alola)",
          }),
        ],
      })
    );
  });

  it("rarity comparison supports three-way comparisons", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "Pikachu s.pikachu g.meowth" });

    const payload = message.channel.send.mock.calls[0][0];
    expect(payload.embeds[0].title).toBe("Pikachu vs Shiny Pikachu vs Golden Meowth");
    expect(payload.embeds[0].fields[0].value).toBe("10 vs 1 vs 5");
  });

  it("rarity comparison suggests buttons for missing third entry", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "g.meowth g.vulpix (alola) Pikac" });

    const payload = message.reply.mock.calls[0][0];
    const ids = payload.components[0].components.map((button) => button.data.customId);
    expect(ids.some((id) => id.startsWith("rarity_retry:!rc_replace:"))).toBe(true);
    expect(ids[0]).toContain("2%7Cg.meowth%7Cg.vulpix%20(alola)");
  });

  it("rarity comparison rejects duplicate entries in three-way mode", async () => {
    const { registerLevel4Rarity } = await loadRarityModule();
    const register = vi.fn();
    register.expose = vi.fn();

    registerLevel4Rarity(register);
    await new Promise((r) => setImmediate(r));

    const rcCall = register.mock.calls.find((call) => call[0] === "!rc");
    const handler = rcCall[1];

    const message = {
      channel: { send: vi.fn(async () => ({})) },
      reply: vi.fn(async () => ({})),
    };

    await handler({ message, rest: "Pikachu Pikachu s.pikachu" });

    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("distinct Pokémon")
    );
  });

  it("nextRunInEastern schedules same-day runs after offset conversion (standard time)", async () => {
    const { __testables } = await loadRarityModule();
    vi.setSystemTime(new Date("2026-01-01T11:45:00Z")); // 06:45 ET

    const runAt = __testables.nextRunInEastern("07:10");
    expect(runAt.toISOString()).toBe("2026-01-01T12:10:00.000Z");
  });

  it("nextRunInEastern rolls to next day after target time (standard time)", async () => {
    const { __testables } = await loadRarityModule();
    vi.setSystemTime(new Date("2026-01-01T12:15:00Z")); // 07:15 ET

    const runAt = __testables.nextRunInEastern("07:10");
    expect(runAt.toISOString()).toBe("2026-01-02T12:10:00.000Z");
  });

  it("nextRunInEastern respects daylight time offsets", async () => {
    const { __testables } = await loadRarityModule();
    vi.setSystemTime(new Date("2026-06-01T10:45:00Z")); // 06:45 ET (DST)

    const runAt = __testables.nextRunInEastern("07:10");
    expect(runAt.toISOString()).toBe("2026-06-01T11:10:00.000Z");
  });

  it("nextRunInEastern handles DST fall-back dates", async () => {
    const { __testables } = await loadRarityModule();
    vi.setSystemTime(new Date("2026-11-01T11:45:00Z")); // 06:45 ET

    const runAt = __testables.nextRunInEastern("07:10");
    expect(runAt.toISOString()).toBe("2026-11-01T12:10:00.000Z");
  });
});
