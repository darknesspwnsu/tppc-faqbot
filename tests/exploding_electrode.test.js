import { describe, it, expect, vi, afterEach } from "vitest";
import { __testables } from "../games/exploding_electrode.js";

const {
  parseJoinToken,
  parseMaxToken,
  parseBallsToken,
  parseElectrodesToken,
  parseTurnToken,
  parseModeToken,
  parseEeOptions,
  validateJoinOptionsForMode,
  computeConsumedTokens,
  nextAliveIndex,
  computeDefaultBalls,
  validateAndBuildGameConfig,
  buildBag,
} = __testables;

describe("exploding_electrode helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses option tokens", () => {
    expect(parseJoinToken("join=15")).toBe(15);
    expect(parseMaxToken("max=8")).toBe(8);
    expect(parseBallsToken("balls=12")).toBe(12);
    expect(parseElectrodesToken("e=2")).toBe(2);
    expect(parseTurnToken("turn=10/20")).toEqual({ warn: 10, skip: 20 });
    expect(parseModeToken("mode=survivors")).toBe("survivors");
  });

  it("parseEeOptions aggregates tokens", () => {
    const opts = parseEeOptions(["join=20", "max=6", "balls=10", "e=2", "turn=5/15", "mode=last"]);
    expect(opts).toEqual({
      joinSeconds: 20,
      maxPlayers: 6,
      balls: 10,
      electrodes: 2,
      turnWarn: 5,
      turnSkip: 15,
      mode: "last",
    });
  });

  it("validateJoinOptionsForMode rejects join/max with mentions", () => {
    const res = validateJoinOptionsForMode(true, { joinSeconds: 10, maxPlayers: 5 });
    expect(res.ok).toBe(false);
  });

  it("validateJoinOptionsForMode enforces join window bounds", () => {
    const res = validateJoinOptionsForMode(false, { joinSeconds: 200 });
    expect(res.ok).toBe(false);
  });

  it("computeConsumedTokens marks consumed option tokens", () => {
    const tokens = ["join=20", "max=6", "mode=last", "<@123>"];
    const opts = parseEeOptions(tokens);
    const consumed = computeConsumedTokens(tokens, opts);
    expect(consumed.has("join=20")).toBe(true);
    expect(consumed.has("max=6")).toBe(true);
    expect(consumed.has("mode=last")).toBe(true);
    expect(consumed.has("<@123>")).toBe(true);
  });

  it("nextAliveIndex finds next live player", () => {
    const players = ["a", "b", "c"];
    const alive = new Set(["b", "c"]);
    expect(nextAliveIndex(players, alive, 0)).toBe(1);
  });

  it("computeDefaultBalls uses players + 2", () => {
    expect(computeDefaultBalls(3)).toBe(5);
  });

  it("validateAndBuildGameConfig rejects invalid electrode counts", () => {
    const res = validateAndBuildGameConfig(3, { electrodes: 5 });
    expect(res.ok).toBe(false);
  });

  it("validateAndBuildGameConfig returns a valid config", () => {
    const res = validateAndBuildGameConfig(3, { electrodes: 1, balls: 6, turnWarn: 10, turnSkip: 20, mode: "last" });
    expect(res.ok).toBe(true);
    expect(res.config).toEqual({ electrodes: 1, balls: 6, turnWarn: 10, turnSkip: 20, mode: "last" });
  });

  it("buildBag produces correct counts", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const bag = buildBag(5, 2);
    const eCount = bag.filter((x) => x === "E").length;
    const bCount = bag.filter((x) => x === "B").length;
    expect(bag.length).toBe(5);
    expect(eCount).toBe(2);
    expect(bCount).toBe(3);
  });
});
