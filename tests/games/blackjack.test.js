import { describe, it, expect } from "vitest";
import { __testables } from "../../games/blackjack.js";

const { cardValueRank, handValue, handTotals, bestTotal, fmtTotals, isBlackjack } = __testables;

describe("blackjack helpers", () => {
  it("cardValueRank maps ranks to values", () => {
    expect(cardValueRank("A")).toBe(11);
    expect(cardValueRank("K")).toBe(10);
    expect(cardValueRank("7")).toBe(7);
  });

  it("handTotals returns low/high totals with aces", () => {
    expect(handTotals([{ r: "A" }, { r: "6" }])).toEqual([7, 17]);
    expect(handTotals([{ r: "A" }, { r: "K" }])).toEqual([11, 21]);
    expect(handTotals([{ r: "A" }, { r: "9" }, { r: "9" }])).toEqual([19]);
  });

  it("bestTotal picks the highest valid total", () => {
    expect(bestTotal([{ r: "A" }, { r: "6" }])).toBe(17);
    expect(bestTotal([{ r: "A" }, { r: "9" }, { r: "9" }])).toBe(19);
  });

  it("handValue reports total and softness", () => {
    expect(handValue([{ r: "A" }, { r: "6" }])).toEqual({ total: 17, soft: true });
    expect(handValue([{ r: "A" }, { r: "9" }, { r: "9" }])).toEqual({ total: 19, soft: false });
  });

  it("fmtTotals matches totals formatting", () => {
    expect(fmtTotals([{ r: "A" }, { r: "6" }])).toBe("7/17");
    expect(fmtTotals([{ r: "9" }, { r: "9" }])).toBe("18");
  });

  it("isBlackjack detects natural blackjack", () => {
    expect(isBlackjack([{ r: "A" }, { r: "K" }])).toBe(true);
    expect(isBlackjack([{ r: "A" }, { r: "9" }])).toBe(false);
    expect(isBlackjack([{ r: "A" }, { r: "K" }, { r: "2" }])).toBe(false);
  });
});
