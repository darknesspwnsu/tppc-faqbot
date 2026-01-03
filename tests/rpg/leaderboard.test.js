import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ButtonBuilder, ButtonStyle } from "discord.js";

const storageMocks = vi.hoisted(() => ({
  getLeaderboard: vi.fn(),
  upsertLeaderboard: vi.fn(),
}));

const pokedexMocks = vi.hoisted(() => ({
  findPokedexEntry: vi.fn(),
  parsePokemonQuery: vi.fn(),
}));

const rpgMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
}));

vi.mock("../../rpg/storage.js", () => storageMocks);
vi.mock("../../rpg/pokedex.js", () => pokedexMocks);
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage(...args) {
      return rpgMocks.fetchPage(...args);
    }
  },
}));

import { registerLeaderboard, handleLeaderboardInteraction } from "../../rpg/leaderboard.js";

function makeRegister() {
  const calls = [];
  const register = (name, handler, help, opts) => {
    calls.push({ name, handler, help, opts });
  };
  register.calls = calls;
  return register;
}

function getHandler(register, name) {
  return register.calls.find((c) => c.name === name)?.handler;
}

function makeMessage() {
  return {
    guildId: "g1",
    reply: vi.fn(async () => ({})),
  };
}

describe("rpg leaderboard register", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    storageMocks.getLeaderboard.mockReset();
    storageMocks.upsertLeaderboard.mockReset();
    pokedexMocks.findPokedexEntry.mockReset();
    pokedexMocks.parsePokemonQuery.mockReset();
    rpgMocks.fetchPage.mockReset();
    process.env = { ...envSnapshot };
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("renders help when no subcommand is provided", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    const message = makeMessage();
    await handler({ message, rest: "" });

    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("Leaderboard options:"));
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("pokemon|poke"));
  });

  it("rejects invalid trainer counts", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    const message = makeMessage();
    await handler({ message, rest: "trainers 0" });

    expect(message.reply).toHaveBeenCalledWith(
      "❌ `num_trainers` must be an integer between 1 and 20."
    );
  });

  it("renders trainers from cached data", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "trainers",
      payload: {
        rows: [
          { rank: "1", trainer: "Ash", faction: "Team TPPC", level: "10", number: "1" },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "trainers 1" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **Top Trainers**");
    expect(body).toContain("Ash");
  });

  it("offers pokemon suggestions with variant buttons", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    pokedexMocks.parsePokemonQuery.mockReturnValue({
      base: "herracross",
      variant: "golden",
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({
      entry: null,
      suggestions: ["Heracross"],
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({
      entry: null,
      suggestions: ["Heracross"],
    });

    const message = makeMessage();
    await handler({ message, rest: "pokemon g.herracross 5" });

    const replyArg = message.reply.mock.calls[0][0];
    const row = replyArg.components[0];
    const button = row.components[0];
    const label = button.data?.label ?? button.label;
    expect(label).toBe("GoldenHeracross");
    expect(replyArg.content).toContain("Did you mean");
  });

  it("accepts accented pokemon subcommand", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    pokedexMocks.parsePokemonQuery.mockReturnValue({ base: "mew", variant: "" });
    pokedexMocks.findPokedexEntry.mockResolvedValue({
      entry: { name: "Mew", key: "151-0" },
      suggestions: [],
    });
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "pokemon:151-0",
      payload: {
        rows: [
          { rank: "1", trainer: "Ash", pokemon: "Mew", level: "5", number: "1" },
        ],
        pageCount: 1,
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "Pokémon Mew 1" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **Mew**");
    expect(body).toContain("Ash");
  });

  it("filters pokemon leaderboard by variant", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    pokedexMocks.parsePokemonQuery.mockReturnValue({
      base: "heracross",
      variant: "golden",
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({
      entry: { key: "214-0", name: "Heracross" },
      suggestions: [],
    });

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "pokemon:214-0",
      payload: {
        rows: [
          {
            rank: "1",
            trainer: "A",
            pokemon: "GoldenHeracross",
            level: "10",
            number: "1",
          },
          {
            rank: "2",
            trainer: "B",
            pokemon: "Heracross",
            level: "9",
            number: "2",
          },
        ],
        pageCount: 1,
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "pokemon g.heracross 5" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("GoldenHeracross");
    expect(body).toContain("top 1");
  });

  it("renders roulette weekly results", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "roulette_weekly",
      payload: {
        rows: [
          { rank: "1", trainer: "Ace", faction: "Team TPPC", wins: "5" },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "roulette weekly" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("Battle Roulette (Weekly)");
    expect(body).toContain("Ace");
  });
});

describe("rpg leaderboard interaction", () => {
  it("handles retry buttons and disables them", async () => {
    const row = {
      type: 1,
      components: [
        new ButtonBuilder()
          .setCustomId("lb_retry:pokemon%20Heracross%205")
          .setLabel("Heracross")
          .setStyle(ButtonStyle.Secondary)
          .toJSON(),
      ],
    };
    const interaction = {
      customId: "lb_retry:pokemon%20Heracross%205",
      message: { components: [row] },
      isButton: () => true,
      update: vi.fn(async () => ({})),
      deferUpdate: vi.fn(async () => ({})),
    };

    const result = await handleLeaderboardInteraction(interaction);

    expect(result).toEqual({ cmd: "!leaderboard", rest: "pokemon Heracross 5" });
    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updated = interaction.update.mock.calls[0][0];
    const updatedRow = updated.components[0].toJSON();
    expect(updatedRow.components[0].disabled).toBe(true);
  });
});
