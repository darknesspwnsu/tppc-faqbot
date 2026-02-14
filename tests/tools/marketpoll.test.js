import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

const isAdminOrPrivileged = vi.fn(() => true);
const registerScheduler = vi.fn();

vi.mock("../../auth.js", () => ({ isAdminOrPrivileged }));
vi.mock("../../shared/scheduler_registry.js", () => ({ registerScheduler }));
vi.mock("../../shared/timer_utils.js", () => ({
  startInterval: vi.fn(() => 1),
  startTimeout: vi.fn(() => 1),
  clearTimer: vi.fn(),
}));

vi.mock("../../tools/marketpoll_store.js", () => ({
  MARKETPOLL_DEFAULTS: {
    enabled: false,
    channelId: null,
    cadenceMinutes: 180,
    pollMinutes: 15,
    pairCooldownDays: 90,
    minVotes: 5,
    matchupModes: ["1v1"],
  },
  ensureMarketPollSettings: vi.fn(async () => {}),
  getMarketPollSettings: vi.fn(async () => ({
    enabled: false,
    channelId: null,
    cadenceMinutes: 180,
    pollMinutes: 15,
    pairCooldownDays: 90,
    minVotes: 5,
    matchupModes: ["1v1"],
  })),
  updateMarketPollSettings: vi.fn(async () => ({
    enabled: false,
    channelId: null,
    cadenceMinutes: 180,
    pollMinutes: 15,
    pairCooldownDays: 90,
    minVotes: 5,
    matchupModes: ["1v1"],
  })),
  listEnabledMarketPollSettings: vi.fn(async () => []),
  insertMarketPollSchedulerLog: vi.fn(async () => {}),
  getLastMarketPollSchedulerRunMs: vi.fn(async () => null),
  insertMarketPollRun: vi.fn(async () => 1),
  listDueMarketPollRuns: vi.fn(async () => []),
  closeMarketPollRun: vi.fn(async () => {}),
  markMarketPollRunError: vi.fn(async () => {}),
  listOpenMarketPollPairKeys: vi.fn(async () => new Set()),
  getMarketPollCooldownMap: vi.fn(async () => new Map()),
  upsertMarketPollCooldown: vi.fn(async () => {}),
  getMarketPollScoresForAssets: vi.fn(async () => new Map()),
  upsertMarketPollScores: vi.fn(async () => {}),
  listMarketPollLeaderboard: vi.fn(async () => []),
  listMarketPollHistory: vi.fn(async () => []),
  countOpenMarketPolls: vi.fn(async () => 0),
}));

vi.mock("../../tools/marketpoll_model.js", () => ({
  GOLDMARKET_TIERS: [
    { id: "1-5kx", label: "1-5kx" },
    { id: "5-10kx", label: "5-10kx" },
  ],
  MARKETPOLL_MATCHUP_MODES: ["1v1", "1v2", "2v1", "2v2"],
  parseSeedCsv: vi.fn(() => ({ rows: [], errors: ["mock"] })),
  buildAssetUniverse: vi.fn(() => ({
    allAssetsByKey: new Map(),
    eligibleAssetsByKey: new Map(),
    eligibleAssets: [],
  })),
  selectCandidateMatchup: vi.fn(() => null),
  canonicalPairKey: vi.fn((a, b) => `${a}|${b}`),
  applyEloFromVotesBundles: vi.fn(() => ({
    leftScore: 1500,
    rightScore: 1500,
    leftScores: [1500],
    rightScores: [1500],
    totalVotes: 0,
    result: "tie",
    affectsScore: false,
  })),
  resolveAssetQuery: vi.fn(() => ({ asset: null, matches: [] })),
  formatX: vi.fn((n) => String(n)),
}));

describe("marketpoll registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminOrPrivileged.mockReturnValue(true);
  });

  it("registers as bang command only via register.expose", async () => {
    const { registerMarketPoll } = await import("../../tools/marketpoll.js");

    const register = vi.fn();
    register.expose = vi.fn();
    register.slash = vi.fn();
    register.listener = vi.fn();

    registerMarketPoll(register);

    expect(register.expose).toHaveBeenCalledTimes(1);
    expect(register.slash).not.toHaveBeenCalled();

    const exposed = register.expose.mock.calls[0][0];
    expect(exposed.logicalId).toBe("marketpoll.main");
    expect(exposed.name).toBe("marketpoll");
    expect(exposed.opts?.aliases || []).toEqual(expect.arrayContaining(["market", "mp"]));
  });

  it("returns help text", async () => {
    const { registerMarketPoll } = await import("../../tools/marketpoll.js");

    const register = vi.fn();
    register.expose = vi.fn();
    register.listener = vi.fn();

    registerMarketPoll(register);
    const handler = register.expose.mock.calls[0][0].handler;

    const message = {
      guildId: "g1",
      reply: vi.fn(async () => {}),
      channel: { send: vi.fn(async () => {}) },
    };

    await handler({ message, rest: "help", cmd: "!marketpoll" });
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("MarketPoll Commands"));
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("config matchups"));
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("Default matchup mode is `1v1`")
    );
  });

  it("formats unknown gender as (?) and parses flexible durations", async () => {
    const { __testables } = await import("../../tools/marketpoll.js");

    expect(__testables.formatAssetDisplay("GoldenHeracross|?")).toBe("GoldenHeracross (?)");
    expect(__testables.formatAssetDisplay("GoldenSnorlax|U")).toBe("GoldenSnorlax (?)");
    expect(__testables.formatAssetDisplay("GoldenGenesect|G")).toBe("GoldenGenesect G");
    expect(__testables.formatAssetDisplay("GoldenMiltank|F")).toBe("GoldenMiltank F");

    expect(__testables.parseDurationMinutes(["15"])).toBe(15);
    expect(__testables.parseDurationMinutes(["15m"])).toBe(15);
    expect(__testables.parseDurationMinutes(["2h"])).toBe(120);
    expect(__testables.parseDurationMinutes(["1", "day"])).toBe(1440);
    expect(__testables.parseDurationMinutes(["1.5h"])).toBe(90);
    expect(__testables.parseDurationMinutes(["0m"])).toBeNull();
    expect(__testables.parseDurationMinutes(["abc"])).toBeNull();

    expect(__testables.parseMatchupModesInput(["1v2", "2v1"]).modes).toEqual(["1v2", "2v1"]);
    expect(__testables.parseMatchupModesInput(["all"]).modes).toEqual([
      "1v1",
      "1v2",
      "2v1",
      "2v2",
    ]);
    expect(__testables.parseMatchupModesInput(["default"]).modes).toEqual(["1v1"]);
    expect(__testables.parseMatchupModesInput(["3v3"]).ok).toBe(false);
  });

  it("blocks admin-only config for non-admin users", async () => {
    const { registerMarketPoll } = await import("../../tools/marketpoll.js");

    const register = vi.fn();
    register.expose = vi.fn();
    register.listener = vi.fn();

    registerMarketPoll(register);
    const handler = register.expose.mock.calls[0][0].handler;

    isAdminOrPrivileged.mockReturnValue(false);
    const message = {
      guildId: "g1",
      reply: vi.fn(async () => {}),
      channel: { send: vi.fn(async () => {}) },
    };

    await handler({ message, rest: "config show", cmd: "!marketpoll" });
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("do not have permission")
    );
  });

  it("allows manual poll now while config enabled is off", async () => {
    const { registerMarketPoll } = await import("../../tools/marketpoll.js");
    const store = await import("../../tools/marketpoll_store.js");

    store.getMarketPollSettings.mockResolvedValue({
      enabled: false,
      channelId: "123",
      cadenceMinutes: 180,
      pollMinutes: 15,
      pairCooldownDays: 90,
      minVotes: 5,
      matchupModes: ["1v1"],
    });

    const register = vi.fn();
    register.expose = vi.fn();
    register.listener = vi.fn();

    registerMarketPoll(register);
    const handler = register.expose.mock.calls[0][0].handler;

    const message = {
      guildId: "g1",
      author: { id: "u1" },
      reply: vi.fn(async () => {}),
      channel: { send: vi.fn(async () => {}) },
    };

    await handler({ message, rest: "poll now", cmd: "!mp" });

    expect(message.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("currently disabled")
    );
    expect(message.reply).toHaveBeenCalledWith(
      expect.stringContaining("Cannot run poll now because seed validation failed.")
    );
  });

  it("surfaces missing SendPolls permission for manual poll now", async () => {
    const { registerMarketPoll, __testables } = await import("../../tools/marketpoll.js");
    const store = await import("../../tools/marketpoll_store.js");
    const model = await import("../../tools/marketpoll_model.js");

    store.getMarketPollSettings.mockResolvedValue({
      guildId: "g1",
      enabled: true,
      channelId: "123",
      cadenceMinutes: 180,
      pollMinutes: 15,
      pairCooldownDays: 90,
      minVotes: 5,
      matchupModes: ["1v1"],
    });

    model.parseSeedCsv.mockReturnValueOnce({
      rows: [{ assetKey: "GoldenAbra|M" }],
      errors: [],
    });
    await __testables.loadSeedState(true);
    model.selectCandidateMatchup.mockReturnValueOnce({
      left: { assetKeys: ["GoldenAbra|M"] },
      right: { assetKeys: ["GoldenKadabra|M"] },
    });

    const channel = {
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: vi.fn(() => ({
        has: vi.fn((flag) => flag !== PermissionFlagsBits.SendPolls),
      })),
      send: vi.fn(async () => ({ id: "m1" })),
    };

    const register = vi.fn();
    register.expose = vi.fn();
    register.listener = vi.fn();

    registerMarketPoll(register);
    const handler = register.expose.mock.calls[0][0].handler;

    const message = {
      guildId: "g1",
      author: { id: "u1" },
      client: {
        user: { id: "bot1" },
        channels: { fetch: vi.fn(async () => channel) },
      },
      reply: vi.fn(async () => {}),
      channel: { send: vi.fn(async () => {}) },
    };

    await handler({ message, rest: "poll now", cmd: "!marketpoll" });

    expect(channel.send).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("missing_permissions"));
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining("SendPolls"));
  });

  it("registers scheduler hook", async () => {
    const { registerMarketPollScheduler } = await import("../../tools/marketpoll.js");
    registerMarketPollScheduler();
    expect(registerScheduler).toHaveBeenCalledWith(
      "marketpoll",
      expect.any(Function),
      expect.any(Function)
    );
  });
});
