import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
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
vi.mock("node:fs/promises", () => ({ ...fsMocks, default: fsMocks }));
vi.mock("../../shared/scheduler_registry.js", () => ({ registerScheduler: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({ logger: { error: vi.fn(), serializeError: (e) => e } }));

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

describe("rpginfo command", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    storageMocks.getLeaderboard.mockReset();
    storageMocks.upsertLeaderboard.mockReset();
    pokedexMocks.findPokedexEntry.mockReset();
    pokedexMocks.parsePokemonQuery.mockReset();
    rpgMocks.fetchPage.mockReset();
    fsMocks.readFile.mockReset();
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ base_by_name: {} }));
    process.env = { ...envSnapshot, RPG_USERNAME: "user", RPG_PASSWORD: "pass" };
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it("fetches SS Anne battle requirement", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce(null);
    rpgMocks.fetchPage.mockResolvedValueOnce(
      "<p>win the SS Anne Endurance Battle</em> by more than 27,920 battles</p>"
    );

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "ssanne" });

    expect(message.reply).toHaveBeenCalledWith(
      "Number of battles required to win GoldenVolcanion: 27,921"
    );
    expect(storageMocks.upsertLeaderboard).toHaveBeenCalledWith({
      challenge: "rpginfo:ssanne",
      payload: { battles: 27921 },
    });
  });

  it("registers !info as an alias", async () => {
    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);

    const call = register.calls.find((c) => c.name === "!rpginfo");
    expect(call?.opts?.aliases || []).toContain("!info");
  });

  it("lists top training gyms", async () => {
    fsMocks.readFile.mockImplementation((filePath) => {
      if (String(filePath).includes("training_gyms.json")) {
        return Promise.resolve(
          JSON.stringify({
            data: [
              { name: "GymA", number: 1, expDay: 100, expNight: 100, level: "100" },
              { name: "GymB", number: 2, expDay: 200, expNight: 200, level: "200" },
              { name: "GymC", number: 3, expDay: 150, expNight: 150, level: "150" },
              { name: "GymD", number: 4, expDay: 50, expNight: 50, level: "50" },
              { name: "GymE", number: 5, expDay: 25, expNight: 25, level: "25" },
              { name: "GymF", number: 6, expDay: 10, expNight: 10, level: "10" },
            ],
          })
        );
      }
      return Promise.resolve(JSON.stringify({ base_by_name: {} }));
    });

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "traininggyms" });

    const reply = message.reply.mock.calls[0][0];
    expect(reply).toContain("Top Training Gyms");
    expect(reply).toContain("GymB");
    expect(reply).toContain("GymC");
    expect(reply).toContain("GymA");
  });

  it("supports a custom count for training gyms", async () => {
    fsMocks.readFile.mockImplementation((filePath) => {
      if (String(filePath).includes("training_gyms.json")) {
        return Promise.resolve(
          JSON.stringify({
            data: [
              { name: "GymA", number: 1, expDay: 100, expNight: 100 },
              { name: "GymB", number: 2, expDay: 200, expNight: 200 },
              { name: "GymC", number: 3, expDay: 150, expNight: 150 },
            ],
          })
        );
      }
      return Promise.resolve(JSON.stringify({ base_by_name: {} }));
    });

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "gyms 2" });

    const reply = message.reply.mock.calls[0][0];
    expect(reply).toContain("GymB");
    expect(reply).toContain("GymC");
    expect(reply).not.toContain("GymA");
  });

  it("returns the cached Training Challenge ineligible list", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: ["Kangaskhan", "Diglett"] },
      updatedAt: Date.now(),
    });

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "tc" });

    expect(message.reply).toHaveBeenCalledWith(
      "Ineligible for this month's Training Challenge: Kangaskhan, Diglett"
    );
  });

  it("rejects banned Pokemon for Training Challenge eligibility", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: ["Kangaskhan"] },
      updatedAt: Date.now(),
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({ entry: { name: "Kangaskhan" }, suggestions: [] });
    pokedexMocks.parsePokemonQuery.mockReturnValue({ base: "Kangaskhan", variant: "" });

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "tc iseligible Kangaskhan" });

    expect(message.reply).toHaveBeenCalledWith(
      "No — **Kangaskhan** is ineligible for this week's Training Challenge."
    );
  });

  it("rejects non-base evolutions for Training Challenge eligibility", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: ["Diglett"] },
      updatedAt: Date.now(),
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({ entry: { name: "Gallade" }, suggestions: [] });
    pokedexMocks.parsePokemonQuery.mockReturnValue({ base: "Gallade", variant: "" });
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ base_by_name: { gallade: "Ralts", ralts: "Ralts" } })
    );

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "tc eligible Gallade" });

    expect(message.reply).toHaveBeenCalledWith(
      "**Gallade**'s base evolution **Ralts** might be eligible for this week's Training Challenge if it evolves through the Pokemon Center."
    );
  });

  it("accepts base evolutions for Training Challenge eligibility", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: ["Diglett"] },
      updatedAt: Date.now(),
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({ entry: { name: "Ralts" }, suggestions: [] });
    pokedexMocks.parsePokemonQuery.mockReturnValue({ base: "Ralts", variant: "" });
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ base_by_name: { ralts: "Ralts" } })
    );

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "tc iseligible Ralts" });

    expect(message.reply).toHaveBeenCalledWith(
      "**Ralts** might be eligible for this week's Training Challenge if it evolves through the Pokemon Center."
    );
  });

  it("does not treat leading s/d/g as a variant when the pokemon exists", async () => {
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: ["Diglett"] },
      updatedAt: Date.now(),
    });
    pokedexMocks.findPokedexEntry.mockResolvedValueOnce({ entry: { name: "Slaking" }, suggestions: [] });
    fsMocks.readFile.mockResolvedValueOnce(
      JSON.stringify({ base_by_name: { slaking: "Slakoth", slakoth: "Slakoth" } })
    );
    storageMocks.getLeaderboard.mockResolvedValueOnce({
      challenge: "rpginfo:tc_ineligible",
      payload: { list: [] },
      updatedAt: Date.now(),
    });

    const { registerRpgInfo } = await import("../../rpg/rpginfo.js");
    const register = makeRegister();
    registerRpgInfo(register);
    const handler = getHandler(register, "!rpginfo");

    const message = makeMessage();
    await handler({ message, rest: "tc eligible slaking" });

    expect(pokedexMocks.parsePokemonQuery).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(
      "**Slaking**'s base evolution **Slakoth** might be eligible for this week's Training Challenge if it evolves through the Pokemon Center."
    );
  });
});
