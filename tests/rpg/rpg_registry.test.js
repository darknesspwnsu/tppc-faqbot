import { describe, it, expect, vi, afterEach } from "vitest";

async function loadRpg({ throwsAt = null } = {}) {
  vi.resetModules();

  const registerLeaderboard = vi.fn();
  const registerLeaderboardScheduler = vi.fn();
  const registerPowerPlant = vi.fn();
  const registerFindMyId = vi.fn();
  const registerViewbox = vi.fn();
  const registerPokedex = vi.fn();

  if (throwsAt === "leaderboard") registerLeaderboard.mockImplementation(() => {
    throw new Error("boom");
  });

  vi.doMock("../../rpg/leaderboard.js", () => ({ registerLeaderboard, registerLeaderboardScheduler }));
  vi.doMock("../../rpg/powerplant.js", () => ({ registerPowerPlant }));
  vi.doMock("../../rpg/findmyid.js", () => ({ registerFindMyId }));
  vi.doMock("../../rpg/viewbox.js", () => ({ registerViewbox }));
  vi.doMock("../../rpg/pokedex.js", () => ({ registerPokedex }));

  const mod = await import("../../rpg/rpg.js");
  return {
    ...mod,
    registerLeaderboard,
    registerLeaderboardScheduler,
    registerPowerPlant,
    registerFindMyId,
    registerViewbox,
    registerPokedex,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("rpg registry", () => {
  it("lists modules in order", async () => {
    const { listRpgModules } = await loadRpg();
    expect(listRpgModules()).toEqual(["leaderboard", "powerplant", "findmyid", "viewbox", "pokedex"]);
  });

  it("registers all modules", async () => {
    const {
      registerRpg,
      registerLeaderboard,
      registerPowerPlant,
      registerFindMyId,
      registerViewbox,
      registerPokedex,
    } = await loadRpg();

    const register = { info: vi.fn() };
    registerRpg(register);

    expect(registerLeaderboard).toHaveBeenCalledWith(register);
    expect(registerPowerPlant).toHaveBeenCalledWith(register);
    expect(registerFindMyId).toHaveBeenCalledWith(register);
    expect(registerViewbox).toHaveBeenCalledWith(register);
    expect(registerPokedex).toHaveBeenCalledWith(register);
  });

  it("logs errors but continues registration", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const {
      registerRpg,
      registerPowerPlant,
      registerFindMyId,
      registerViewbox,
      registerPokedex,
    } = await loadRpg({ throwsAt: "leaderboard" });

    const register = { info: vi.fn() };
    registerRpg(register);

    expect(consoleError).toHaveBeenCalledWith(
      "[rpg] failed to register leaderboard:",
      expect.any(Error)
    );
    expect(registerPowerPlant).toHaveBeenCalledWith(register);
    expect(registerFindMyId).toHaveBeenCalledWith(register);
    expect(registerViewbox).toHaveBeenCalledWith(register);
    expect(registerPokedex).toHaveBeenCalledWith(register);
  });
});
