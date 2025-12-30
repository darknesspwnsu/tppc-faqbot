import { describe, it, expect, vi, afterEach } from "vitest";
import { __testables } from "../games/closest_roll_wins.js";

const { clampInt, parseDurationMs, randIntInclusive, formatTimeLeftMs } = __testables;

describe("closest_roll_wins helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clampInt accepts integers only", () => {
    expect(clampInt(5)).toBe(5);
    expect(clampInt(1.5)).toBe(null);
    expect(clampInt("nope")).toBe(null);
  });

  it("parseDurationMs parses seconds/minutes/hours", () => {
    expect(parseDurationMs("30")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("bad")).toBe(null);
  });

  it("formatTimeLeftMs formats using ceil", () => {
    expect(formatTimeLeftMs(0)).toBe("0s");
    expect(formatTimeLeftMs(1000)).toBe("1s");
    expect(formatTimeLeftMs(61_000)).toBe("2m");
  });

  it("randIntInclusive honors bounds", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(randIntInclusive(1, 3)).toBe(1);
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(randIntInclusive(1, 3)).toBe(3);
  });
});
