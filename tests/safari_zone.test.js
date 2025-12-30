import { describe, it, expect, vi, afterEach } from "vitest";
import { __testables } from "../games/safari_zone.js";

const {
  parseMentionToken,
  parseKVInt,
  parseJoinToken,
  parseMaxToken,
  parseNToken,
  parsePrizesToken,
  parseTurnToken,
  parseWarnToken,
  idxFromRC,
  parseCoord,
  coordLabel,
  pickRandomUniqueIndices,
  buildGridText,
} = __testables;

describe("safari_zone helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses mention tokens", () => {
    expect(parseMentionToken("<@123>")).toBe("123");
    expect(parseMentionToken("<@!456>")).toBe("456");
    expect(parseMentionToken("nope")).toBe(null);
  });

  it("parses key=value integers", () => {
    expect(parseKVInt("join=10", "join")).toBe(10);
    expect(parseJoinToken("join=5")).toBe(5);
    expect(parseMaxToken("max=8")).toBe(8);
    expect(parseNToken("n=6")).toBe(6);
    expect(parsePrizesToken("prizes=3")).toBe(3);
    expect(parsePrizesToken("p=3")).toBe(3);
    expect(parseTurnToken("turn=20")).toBe(20);
    expect(parseWarnToken("warn=10")).toBe(10);
  });

  it("index and coordinate helpers work", () => {
    expect(idxFromRC(3, 1, 2)).toBe(5);
    expect(parseCoord("A1", 3)).toEqual({ r: 0, c: 0 });
    expect(parseCoord("B2", 3)).toEqual({ r: 1, c: 1 });
    expect(parseCoord("Z9", 3)).toBe(null);
    expect(coordLabel(0, 0)).toBe("A1");
    expect(coordLabel(1, 2)).toBe("B3");
  });

  it("pickRandomUniqueIndices returns a set of unique indices", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const set = pickRandomUniqueIndices(5, 3);
    expect(set.size).toBe(3);
    expect([...set].sort()).toEqual([0, 1, 2]);
  });

  it("buildGridText returns a string", () => {
    const game = {
      n: 2,
      revealed: [false, true, false, true],
      prizes: new Set([1]),
    };
    const text = buildGridText(game);
    expect(typeof text).toBe("string");
  });
});
