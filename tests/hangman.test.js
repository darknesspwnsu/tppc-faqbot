import { describe, it, expect } from "vitest";
import { __testables } from "../games/hangman.js";

const { normalizeWord, isLetterGuess, uniqueLettersNeeded, prettyMask, hangmanStage } = __testables;

describe("hangman helpers", () => {
  it("normalizeWord strips punctuation and normalizes spaces", () => {
    expect(normalizeWord("Hello-World!!")).toBe("hello world");
    expect(normalizeWord("  A--B ")).toBe("a b");
    expect(normalizeWord("123")).toBe("");
  });

  it("isLetterGuess recognizes single letters", () => {
    expect(isLetterGuess("a")).toBe(true);
    expect(isLetterGuess("A")).toBe(true);
    expect(isLetterGuess("ab")).toBe(false);
    expect(isLetterGuess("!")).toBe(false);
  });

  it("uniqueLettersNeeded returns distinct letters", () => {
    const set = uniqueLettersNeeded("apple pie");
    expect(set.has("a")).toBe(true);
    expect(set.has("p")).toBe(true);
    expect(set.has("l")).toBe(true);
    expect(set.has("e")).toBe(true);
    expect(set.has("i")).toBe(true);
    expect(set.size).toBe(5);
  });

  it("prettyMask renders revealed letters and spaces", () => {
    const st = { wordNorm: "a b", revealed: new Set(["a"]) };
    expect(prettyMask(st)).toBe("A   _");
  });

  it("hangmanStage clamps mistakes to available stages", () => {
    const s0 = hangmanStage(0);
    const s7 = hangmanStage(7);
    const s99 = hangmanStage(99);
    expect(typeof s0).toBe("string");
    expect(typeof s7).toBe("string");
    expect(s7).toBe(s99);
  });
});
