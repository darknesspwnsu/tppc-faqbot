import { describe, it, expect } from "vitest";
import { __testables } from "../../games/bingo.js";

const { parseRangeToken, parseDrawList, fmtList, buildRemainingArray } = __testables;

describe("bingo helpers", () => {
  it("parseRangeToken reads min-max", () => {
    expect(parseRangeToken("1-10")).toEqual({ min: 1, max: 10 });
    expect(parseRangeToken(`2\u201320`)).toEqual({ min: 2, max: 20 });
    expect(parseRangeToken("bad")).toBe(null);
  });

  it("parseDrawList handles commas and spaces", () => {
    expect(parseDrawList("5,12, 77")).toEqual([5, 12, 77]);
    expect(parseDrawList("1 2 3")).toEqual([1, 2, 3]);
    expect(parseDrawList("")).toEqual([]);
  });

  it("fmtList returns a string", () => {
    expect(typeof fmtList([])).toBe("string");
    expect(typeof fmtList([1, 2, 3])).toBe("string");
  });

  it("buildRemainingArray excludes drawn numbers", () => {
    const st = { min: 1, max: 5, drawnSet: new Set([2, 4]) };
    expect(buildRemainingArray(st)).toEqual([1, 3, 5]);
  });
});
