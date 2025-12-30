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

const isAdminOrPrivileged = vi.fn(() => true);

vi.mock("../../auth.js", () => ({ isAdminOrPrivileged }));

const httpGet = vi.fn((url, cb) => {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setEncoding = vi.fn();

  const payload = String(url).includes("l4") ? L4_JSON : RARITY_JSON;
  process.nextTick(() => {
    cb(res);
    res.emit("data", payload);
    res.emit("end");
  });

  return { on: vi.fn() };
});

vi.mock("node:http", () => ({ get: httpGet }));
vi.mock("node:https", () => ({ get: httpGet }));

vi.mock("discord.js", () => {
  class ActionRowBuilder {
    constructor() {
      this.components = [];
    }
    addComponents(comps) {
      this.components.push(...comps);
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
    expect(payload.components[0].components[0].data.customId).toContain("rarity_retry:?rarity");
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
      deferUpdate: vi.fn(async () => ({})),
    };

    const res = await handleRarityInteraction(interaction);
    expect(res).toEqual({ cmd: "?rarity", rest: "Pikachu" });
  });
});
