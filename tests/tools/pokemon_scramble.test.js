import { describe, expect, it } from "vitest";

import { __testables } from "../../tools/pokemon_scramble.js";

const {
  normalizeGuess,
  scrambleWord,
  isEligiblePokemonName,
  loadPokemonNames,
  choosePokemonName,
  parseMinutes,
  parseSeconds,
  buildCadencePatch,
  renderChallenge,
  renderSuccess,
  renderFailure,
} = __testables;

describe("pokemon scramble helpers", () => {
  it("normalizes guesses case-insensitively and ignores punctuation", () => {
    expect(normalizeGuess("Mr. Mime")).toBe("MRMIME");
    expect(normalizeGuess("far-fetch'd")).toBe("FARFETCHD");
  });

  it("filters out forms and multi-word names from the automatic pool", () => {
    expect(isEligiblePokemonName("Pikachu")).toBe(true);
    expect(isEligiblePokemonName("Abra")).toBe(false);
    expect(isEligiblePokemonName("Mew")).toBe(false);
    expect(isEligiblePokemonName("Unown")).toBe(false);
    expect(isEligiblePokemonName("Charizard (Mega X)")).toBe(false);
    expect(isEligiblePokemonName("Mr. Mime")).toBe(false);
    expect(isEligiblePokemonName("Ho-Oh")).toBe(false);
    expect(isEligiblePokemonName("Porygon-Z")).toBe(false);
    expect(isEligiblePokemonName("Porygon2")).toBe(false);
    expect(isEligiblePokemonName("Type: Null")).toBe(false);
    expect(isEligiblePokemonName("GoldenPikachu")).toBe(false);
  });

  it("loads a non-empty single-token Pokemon pool", () => {
    const names = loadPokemonNames();
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain("Pikachu");
    expect(names).not.toContain("Unown");
    expect(names).not.toContain("Ho-Oh");
    expect(names).not.toContain("Charizard (Mega X)");
  });

  it("chooses lowercase names for display and scrambling", () => {
    const name = choosePokemonName();
    expect(name).toBe(name.toLowerCase());
    expect(/^[a-z]+$/.test(name)).toBe(true);
  });

  it("scrambles without changing the normalized answer", () => {
    const word = "Pikachu";
    const scrambled = scrambleWord(word);
    expect(normalizeGuess(scrambled).split("").sort().join("")).toBe(
      normalizeGuess(word).split("").sort().join("")
    );
  });

  it("parses cadence minutes and challenge seconds", () => {
    expect(parseMinutes("2h")).toBe(120);
    expect(parseMinutes("45")).toBe(45);
    expect(parseSeconds("30s")).toBe(30);
    expect(parseSeconds("30")).toBe(30);
  });

  it("reschedules the next run when cadence changes while enabled", () => {
    expect(buildCadencePatch({ minutes: 5, enabled: true, nowMs: 1_000 })).toEqual({
      cadenceMinutes: 5,
      nextRunAtMs: 301_000,
    });
    expect(buildCadencePatch({ minutes: 5, enabled: false, nowMs: 1_000 })).toEqual({
      cadenceMinutes: 5,
    });
  });

  it("renders challenge states", () => {
    expect(renderChallenge({ scramble: "KIPACHU", durationSeconds: 30 })).toContain("30s");
    expect(renderChallenge({ scramble: "KIPACHU", durationSeconds: 30, endsAtMs: 30_000 })).toContain("<t:30:R>");
    expect(renderSuccess({ word: "Pikachu", userId: "123" })).toContain("<@123>");
    expect(renderFailure({ word: "Pikachu" })).toContain("Nobody managed to unscramble");
  });
});
