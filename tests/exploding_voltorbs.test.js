import { describe, it, expect } from "vitest";
import { __testables } from "../games/exploding_voltorbs.js";

const {
  parseMentionToken,
  parseRangeToken,
  parseModeToken,
  parseJoinWindowToken,
  parseFlagToken,
  formatRemainingList,
} = __testables;

describe("exploding_voltorbs helpers", () => {
  it("parseMentionToken extracts ids from mentions", () => {
    expect(parseMentionToken("<@123>")).toBe("123");
    expect(parseMentionToken("<@!456>")).toBe("456");
    expect(parseMentionToken("nope")).toBe(null);
  });

  it("parseRangeToken reads min-max seconds", () => {
    expect(parseRangeToken("30-90")).toEqual({ min: 30, max: 90 });
    expect(parseRangeToken("30-90s")).toEqual({ min: 30, max: 90 });
    expect(parseRangeToken("bad")).toBe(null);
  });

  it("parseModeToken accepts supported aliases", () => {
    expect(parseModeToken("elim")).toBe("elim");
    expect(parseModeToken("suddendeath")).toBe("suddendeath");
    expect(parseModeToken("sd")).toBe("suddendeath");
    expect(parseModeToken("unknown")).toBe(null);
  });

  it("parseJoinWindowToken accepts seconds-only values", () => {
    expect(parseJoinWindowToken("60")).toBe(60);
    expect(parseJoinWindowToken("60s")).toBe(60);
    expect(parseJoinWindowToken("10-20")).toBe(null);
  });

  it("parseFlagToken accepts nopingpong aliases", () => {
    expect(parseFlagToken("nopingpong")).toBe("nopingpong");
    expect(parseFlagToken("nopong")).toBe("nopingpong");
    expect(parseFlagToken("antipong")).toBe("nopingpong");
    expect(parseFlagToken("other")).toBe(null);
  });

  it("formatRemainingList mentions remaining ids", () => {
    expect(formatRemainingList(new Set())).toBe("(none)");
    expect(formatRemainingList(new Set(["1", "2"]))).toBe("<@1>, <@2>");
  });
});
