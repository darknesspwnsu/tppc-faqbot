import { describe, expect, it } from "vitest";

import { __testables } from "../../tools/loot.js";

const { chooseLootWinners, modeDescription, renderDrop, renderResult } = __testables;

const claimants = [
  { userId: "1", displayName: "One" },
  { userId: "2", displayName: "Two" },
  { userId: "3", displayName: "Three" },
];

describe("loot helpers", () => {
  it("selects the first claimant in first mode", () => {
    expect(chooseLootWinners({ mode: "first", claimants })).toEqual([claimants[0]]);
  });

  it("selects every claimant in all mode", () => {
    expect(chooseLootWinners({ mode: "all", claimants })).toEqual(claimants);
  });

  it("selects one random claimant in random mode", () => {
    expect(chooseLootWinners({ mode: "random", claimants, random: () => 0 })).toEqual([claimants[0]]);
    expect(chooseLootWinners({ mode: "random", claimants, random: () => 0.99 })).toEqual([claimants[2]]);
  });

  it("returns no winners when nobody claims", () => {
    expect(chooseLootWinners({ mode: "random", claimants: [] })).toEqual([]);
    expect(chooseLootWinners({ mode: "all", claimants: [] })).toEqual([]);
  });

  it("describes each mode clearly", () => {
    expect(modeDescription("first")).toContain("first person");
    expect(modeDescription("random")).toContain("random");
    expect(modeDescription("all")).toContain("Everyone");
  });

  it("renders the Discord deadline and winners", () => {
    expect(renderDrop({ mode: "random", endsAtMs: 30_000 })).toContain("<t:30:R>");
    const result = renderResult({ mode: "all", winners: claimants.slice(0, 2), claimCount: 2 });
    expect(result).toContain("<@1>, <@2>");
    expect(result).toContain("1 loot point");
  });
});
