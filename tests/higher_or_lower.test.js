import { describe, it, expect, vi, afterEach } from "vitest";
import { __testables } from "../games/higher_or_lower.js";

const { parseRangeToken, rollNotEqual } = __testables;

describe("higher_or_lower helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseRangeToken parses min-max with various dashes", () => {
    expect(parseRangeToken("1-10")).toEqual({ min: 1, max: 10 });
    expect(parseRangeToken(`2\u201320`)).toEqual({ min: 2, max: 20 });
    expect(parseRangeToken(`3\u201430`)).toEqual({ min: 3, max: 30 });
  });

  it("parseRangeToken rejects invalid input", () => {
    expect(parseRangeToken("nope")).toBe(null);
    expect(parseRangeToken("1-")).toBe(null);
  });

  it("rollNotEqual avoids returning the current value", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(rollNotEqual(1, 2, 1)).toBe(2);
    expect(rollNotEqual(1, 2, 2)).toBe(1);
  });
});
