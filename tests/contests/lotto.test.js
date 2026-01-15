import { describe, it, expect } from "vitest";
import { __testables } from "../../contests/lotto.js";

describe("lotto helpers", () => {
  it("parses bracketed lotto numbers only when valid", () => {
    expect(__testables.parseLottoNumbersFromText("Name - [1] [2] [3]")).toEqual([1, 2, 3]);
    expect(__testables.parseLottoNumbersFromText("Name - [10] [9] [1]")).toEqual([1, 9, 10]);
    expect(__testables.parseLottoNumbersFromText("Name - [1] [1] [2]")).toBe(null);
    expect(__testables.parseLottoNumbersFromText("Name - [11] [2] [3]")).toBe(null);
    expect(__testables.parseLottoNumbersFromText("No brackets 1 2 3")).toBe(null);
    expect(__testables.parseLottoNumbersFromText("Too many [1] [2] [3] [4]")).toBe(null);
  });

  it("parses check input into a sorted combo", () => {
    expect(__testables.parseNumbersFromInput("1 2 3")).toEqual([1, 2, 3]);
    expect(__testables.parseNumbersFromInput("[3] [1] [2]")).toEqual([1, 2, 3]);
    expect(__testables.parseNumbersFromInput("1 1 2")).toBe(null);
    expect(__testables.parseNumbersFromInput("1 2")).toBe(null);
    expect(__testables.parseNumbersFromInput("0 2 3")).toBe(null);
    expect(__testables.parseNumbersFromInput("1 2 11")).toBe(null);
  });

  it("builds all 120 unique combos", () => {
    const combos = __testables.allCombos();
    expect(combos).toHaveLength(120);
    expect(combos[0]).toEqual([1, 2, 3]);
    expect(combos[combos.length - 1]).toEqual([8, 9, 10]);
  });

  it("builds post URLs with anchors", () => {
    const url = __testables.buildPostUrl("https://forums.tppc.info/showthread.php?t=641631", 123);
    expect(url).toBe("https://forums.tppc.info/showthread.php?t=641631&p=123#post123");
  });

  it("computes the correct start page for a post id", () => {
    expect(__testables.computeStartPage(1)).toBe(1);
    expect(__testables.computeStartPage(25)).toBe(1);
    expect(__testables.computeStartPage(26)).toBe(2);
    expect(__testables.computeStartPage(51)).toBe(3);
    expect(__testables.computeStartPage(0)).toBe(1);
    expect(__testables.computeStartPage(-5)).toBe(1);
  });

  it("extracts the forum post count from post html", () => {
    const html =
      '<td class="thead">#<a href="showpost.php?p=11521972&amp;postcount=705" id="postcount11521972" name="705"><strong>705</strong></a></td>';
    expect(__testables.extractPostCount(html)).toBe(705);
  });

  it("builds stable combo keys", () => {
    expect(__testables.comboKey([1, 2, 3])).toBe("1-2-3");
    expect(__testables.comboKey([8, 9, 10])).toBe("8-9-10");
  });

  it("extracts bracket numbers in order", () => {
    expect(__testables.extractBracketNumbers("A - [2] [1] [3]")).toEqual([2, 1, 3]);
    expect(__testables.extractBracketNumbers("No brackets")).toBe(null);
  });

  it("flags invalid number reasons", () => {
    expect(__testables.invalidReasonForNumbers([1, 2, 3])).toBe(null);
    expect(__testables.invalidReasonForNumbers([1, 1, 2])).toBe("numbers must be unique");
    expect(__testables.invalidReasonForNumbers([2, 1, 3])).toBe("numbers must be in ascending order");
    expect(__testables.invalidReasonForNumbers([1, 2, 11])).toBe("numbers must be between 1 and 10");
    expect(__testables.invalidReasonForNumbers([1, 2])).toBe("expected exactly 3 numbers");
  });
});
