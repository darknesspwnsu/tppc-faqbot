import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ButtonBuilder, ButtonStyle } from "discord.js";

const storageMocks = vi.hoisted(() => ({
  getLeaderboard: vi.fn(),
  upsertLeaderboard: vi.fn(),
  incrementLeaderboardHistory: vi.fn(),
  getLeaderboardHistoryTop: vi.fn(),
}));

const pokedexMocks = vi.hoisted(() => ({
  findPokedexEntry: vi.fn(),
  parsePokemonQuery: vi.fn(),
}));

const rpgMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
}));

const findMyIdMocks = vi.hoisted(() => ({
  fetchFindMyIdMatches: vi.fn(),
}));

const customLbMocks = vi.hoisted(() => ({
  fetchCustomLeaderboardForGuild: vi.fn(),
  fetchCustomLeaderboardEntries: vi.fn(),
  fetchCustomLeaderboardEntry: vi.fn(),
}));

vi.mock("../../rpg/storage.js", () => storageMocks);
vi.mock("../../rpg/pokedex.js", () => pokedexMocks);
vi.mock("../../rpg/findmyid.js", () => findMyIdMocks);
vi.mock("../../contests/custom_leaderboard.js", () => customLbMocks);
vi.mock("../../shared/metrics.js", () => ({ metrics: { increment: vi.fn(), incrementExternalFetch: vi.fn(), incrementSchedulerRun: vi.fn() } }));
vi.mock("../../rpg/rpg_client.js", () => ({
  RpgClient: class {
    fetchPage(...args) {
      return rpgMocks.fetchPage(...args);
    }
  },
}));

import { registerLeaderboard, handleLeaderboardInteraction, __testables } from "../../rpg/leaderboard.js";
const { recordChallengeWinner, parseSpeedHallOfFame, renderSpeedHallOfFame } = __testables;

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
    findMyIdMocks.fetchFindMyIdMatches.mockReset();
    customLbMocks.fetchCustomLeaderboardForGuild.mockReset();
    customLbMocks.fetchCustomLeaderboardEntries.mockReset();
    customLbMocks.fetchCustomLeaderboardEntry.mockReset();
    customLbMocks.fetchCustomLeaderboardForGuild.mockResolvedValue(null);
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

  it("renders custom leaderboards without RPG credentials", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    customLbMocks.fetchCustomLeaderboardForGuild.mockResolvedValue({
      id: 1,
      name: "shop",
      metric: "Coins",
    });
    customLbMocks.fetchCustomLeaderboardEntries.mockResolvedValue([
      {
        participantType: "text",
        participantKey: "haunter",
        name: "Haunter",
        score: 3,
      },
    ]);

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    const message = makeMessage();
    await handler({ message, rest: "shop" });

    const replyArg = message.reply.mock.calls[0][0];
    const content = typeof replyArg === "string" ? replyArg : replyArg.content;
    expect(content).toContain("shop");
    expect(content).toContain("Haunter");
  });

  it("renders custom leaderboards with quoted names", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    customLbMocks.fetchCustomLeaderboardForGuild.mockResolvedValue({
      id: 2,
      name: "Haunter Shop",
      metric: "Coins",
    });
    customLbMocks.fetchCustomLeaderboardEntries.mockResolvedValue([
      {
        participantType: "text",
        participantKey: "haunter",
        name: "Haunter",
        score: 7,
      },
    ]);

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    const message = makeMessage();
    await handler({ message, rest: '"Haunter Shop"' });

    const replyArg = message.reply.mock.calls[0][0];
    const content = typeof replyArg === "string" ? replyArg : replyArg.content;
    expect(content).toContain("Haunter Shop");
    expect(content).toContain("Haunter");
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

  it("rejects invalid faction counts", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    const message = makeMessage();
    await handler({ message, rest: "faction 6" });

    expect(message.reply).toHaveBeenCalledWith(
      "❌ `num_rows` must be an integer between 1 and 5."
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

  it("renders faction leaderboard from cached data", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "faction",
      payload: {
        rows: [
          {
            rank: "1",
            trainer: "GratzMatt Gym",
            faction: "Team Galactic",
            level: "22207",
            number: "3476575",
          },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "faction" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **Top Trainers by Faction**");
    expect(body).toContain("GratzMatt Gym");
    expect(body).toContain("Team Galactic");
  });

  it("renders history for ssanne", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboardHistoryTop.mockResolvedValueOnce([
      { trainer_id: "100", wins: 3 },
      { trainer_id: "200", wins: 1 },
    ]);

    const message = makeMessage();
    await handler({ message, rest: "ssanne history" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **SS Anne — History**");
    expect(body).toContain("1. 100 — 3 wins");
    expect(body).toContain("2. 200 — 1 win");
  });

  it("renders history with trainer names when available", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboardHistoryTop.mockResolvedValueOnce([
      { trainer_id: "1", trainer_name: "Ceci and Hailey", wins: 2 },
      { trainer_id: "2", trainer_name: "", wins: 1 },
    ]);

    const message = makeMessage();
    await handler({ message, rest: "ssanne history" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("1. Ceci and Hailey — 2 wins");
    expect(body).toContain("2. 2 — 1 win");
  });

  it("resolves SS Anne winner IDs via findmyid", async () => {
    const rows = [
      { rank: "1", trainer: "mike123", trainerId: "" },
    ];
    findMyIdMocks.fetchFindMyIdMatches.mockResolvedValueOnce([
      { name: "mike12345", id: "999" },
      { name: "mike123", id: "123" },
    ]);

    const recorded = await recordChallengeWinner({
      challengeKey: "ssanne",
      rows,
      client: {},
    });

    expect(recorded).toBe(true);
    expect(storageMocks.incrementLeaderboardHistory).toHaveBeenCalledWith({
      challenge: "ssanne",
      trainerId: "123",
      trainerName: "mike123",
    });
  });

  it("does not record SS Anne history when no exact findmyid match", async () => {
    const rows = [
      { rank: "1", trainer: "mike123", trainerId: "" },
    ];
    findMyIdMocks.fetchFindMyIdMatches.mockResolvedValueOnce([
      { name: "mike12345", id: "999" },
    ]);

    const recorded = await recordChallengeWinner({
      challengeKey: "ssanne",
      rows,
      client: {},
    });

    expect(recorded).toBe(false);
    expect(storageMocks.incrementLeaderboardHistory).not.toHaveBeenCalled();
  });

  it("records non-SS Anne winners by name when ID is missing", async () => {
    const rows = [
      { rank: "1", trainer: "Ace", trainerId: "" },
    ];

    const recorded = await recordChallengeWinner({
      challengeKey: "safarizone",
      rows,
      client: {},
    });

    expect(recorded).toBe(true);
    expect(storageMocks.incrementLeaderboardHistory).toHaveBeenCalledWith({
      challenge: "safarizone",
      trainerId: "",
      trainerName: "Ace",
    });
    expect(findMyIdMocks.fetchFindMyIdMatches).not.toHaveBeenCalled();
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

  it("renders overall pokemon leaderboard when no name is provided", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "pokemon_overall",
      payload: {
        rows: [
          {
            rank: "1",
            trainer: "Lord Smaug",
            pokemon: "Charizard",
            level: "20405",
            number: "3384868",
          },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "pokemon" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **Top Pokemon**");
    expect(body).toContain("Lord Smaug");
    expect(body).toContain("Charizard");
    expect(pokedexMocks.parsePokemonQuery).not.toHaveBeenCalled();
    expect(pokedexMocks.findPokedexEntry).not.toHaveBeenCalled();
  });

  it("parses speed hall of fame rows", () => {
    const html = `
      <table class="ranks">
        <tbody>
          <tr><td>Fastest Ever</td><td><a href="profile.php?id=1">Alpha</a></td><td>Team TPPC</td><td>39</td><td>00:23</td></tr>
          <tr><td>March's Fastest</td><td><a href="profile.php?id=2">Beta</a></td><td>Team Aqua</td><td>40</td><td>00:30</td></tr>
          <tr><td>This Week's Fastest</td><td><a href="profile.php?id=3">Gamma</a></td><td>Team Rocket</td><td>41</td><td>00:31</td></tr>
          <tr><td>Yesterday's Fastest</td><td><a href="profile.php?id=4">Delta</a></td><td>Team Magma</td><td>42</td><td>00:32</td></tr>
        </tbody>
      </table>
    `;

    const rows = parseSpeedHallOfFame(html);
    expect(rows).toHaveLength(4);
    expect(rows[0].kind).toBe("ever");
    expect(rows[1].kind).toBe("month");
    expect(rows[2].kind).toBe("week");
    expect(rows[3].kind).toBe("yesterday");
  });

  it("renders speed hall of fame results with placeholders", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T12:00:00Z"));

    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "speed_hof",
      payload: {
        rows: [
          {
            standing: "Fastest Ever",
            kind: "ever",
            trainer: "Braixen",
            trainerId: "2645731",
            faction: "Team TPPC",
            moves: "39",
            time: "00:23",
          },
          {
            standing: "This Week's Fastest",
            kind: "week",
            trainer: "Braixen",
            trainerId: "2645731",
            faction: "Team TPPC",
            moves: "39",
            time: "00:28",
          },
          {
            standing: "Yesterday's Fastest",
            kind: "yesterday",
            trainer: "the infinity stones",
            trainerId: "3181487",
            faction: "Team TPPC",
            moves: "45",
            time: "00:38",
          },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "speed hof" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("Speed Tower Hall of Fame");
    expect(body).toContain("Fastest Ever");
    expect(body).toContain("February's Fastest — not set");
    expect(body).toContain("This Week's Fastest");
    expect(body).toContain("Yesterday's Fastest");

    vi.useRealTimers();
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
          {
            rank: "1",
            trainer: "Ace",
            faction: "Team TPPC",
            wins: "5",
            battleDate: "January 15, 2026",
          },
        ],
      },
      updatedAt: Date.now(),
    });

    const message = makeMessage();
    await handler({ message, rest: "roulette weekly" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("Battle Roulette (Weekly)");
    expect(body).toContain("Ace");
    expect(body).toContain("Jan 15, 2026");
  });

  it("rejects invalid swarm row counts", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T16:00:00Z"));

    const message = makeMessage();
    await handler({ message, rest: "swarm 11" });

    expect(message.reply).toHaveBeenCalledWith(
      "❌ `num_rows` must be an integer between 1 and 10."
    );
    expect(rpgMocks.fetchPage).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("renders swarm results with custom count", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    const html = `
      <table class="ranks">
        <tbody>
          <tr><td>1</td><td><a href="profile.php?id=1">silverdragon3</a></td><td>21</td></tr>
          <tr><td>2</td><td><a href="profile.php?id=2">Mr Hax</a></td><td>11</td></tr>
          <tr><td>3</td><td><a href="profile.php?id=3">Noxation</a></td><td>4</td></tr>
        </tbody>
      </table>
    `;
    rpgMocks.fetchPage.mockResolvedValueOnce(html);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T16:00:00Z"));

    const message = makeMessage();
    await handler({ message, rest: "swarm 2" });

    const body = message.reply.mock.calls[0][0];
    expect(body).toContain("🏆 **Swarm** (top 2)");
    expect(body).toContain("silverdragon3");
    expect(body).toContain("Mr Hax");
    expect(body).not.toContain("Noxation");

    vi.useRealTimers();
  });

  it("blocks swarm outside Saturday", async () => {
    delete process.env.RPG_USERNAME;
    delete process.env.RPG_PASSWORD;

    const register = makeRegister();
    registerLeaderboard(register);
    const handler = getHandler(register, "!leaderboard");

    process.env.RPG_USERNAME = "user";
    process.env.RPG_PASSWORD = "pass";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-14T16:00:00Z"));

    const message = makeMessage();
    await handler({ message, rest: "swarm" });

    expect(message.reply).toHaveBeenCalledWith(
      "❌ Swarm leaderboard is only available on Saturdays."
    );
    expect(rpgMocks.fetchPage).not.toHaveBeenCalled();

    vi.useRealTimers();
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
