import { describe, it, expect } from "vitest";
import { __testables } from "../../games/rps.js";

const { outcome, clampWins, pretty, fmtSeconds } = __testables;

describe("rps helpers", () => {
  it("outcome computes winner", () => {
    expect(outcome("rock", "scissors")).toBe(1);
    expect(outcome("paper", "rock")).toBe(1);
    expect(outcome("scissors", "rock")).toBe(2);
    expect(outcome("rock", "rock")).toBe(0);
  });

  it("clampWins validates target wins", () => {
    expect(clampWins(3)).toBe(3);
    expect(clampWins(0)).toBe(null);
    expect(clampWins(51)).toBe(null);
  });

  it("pretty and fmtSeconds render readable strings", () => {
    expect(pretty("rock")).toBe("Rock");
    expect(pretty("paper")).toBe("Paper");
    expect(pretty("scissors")).toBe("Scissors");
    expect(fmtSeconds(1000)).toBe("1s");
  });
});
