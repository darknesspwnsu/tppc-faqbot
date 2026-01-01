import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const RARITY_JSON = JSON.stringify({
  meta: { lastUpdatedText: "12-30-2025 07:10 EST" },
  data: {
    Pikachu: { total: 10, male: 4, female: 3, ungendered: 2, genderless: 1 },
    "Shiny Pikachu": { total: 1, male: 1, female: 0, ungendered: 0, genderless: 0 },
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
});
