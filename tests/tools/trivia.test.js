import { describe, expect, it } from "vitest";

import { __testables } from "../../tools/trivia.js";

const {
  pointsForDifficulty,
  loadCuratedQuestions,
  loadPokemonRows,
  buildPokemonQuestion,
  resolveQuestionSelection,
  parseRunOverrides,
  renderQuestion,
  renderResult,
} = __testables;

describe("trivia helpers", () => {
  it("awards one point for easy and two for medium or hard", () => {
    expect(pointsForDifficulty("easy")).toBe(1);
    expect(pointsForDifficulty("medium")).toBe(2);
    expect(pointsForDifficulty("hard")).toBe(2);
  });

  it("loads valid TPPC questions at every difficulty", () => {
    const questions = loadCuratedQuestions();
    expect(questions.length).toBeGreaterThanOrEqual(12);
    for (const difficulty of ["easy", "medium", "hard"]) {
      expect(questions.some((question) => question.difficulty === difficulty)).toBe(true);
    }
    for (const question of questions) {
      expect(question.category).toBe("tppc");
      expect(question.choices).toHaveLength(4);
      expect(question.answerIndex).toBeGreaterThanOrEqual(0);
      expect(question.answerIndex).toBeLessThan(4);
    }
  });

  it("loads unique National Pokedex rows", () => {
    const rows = loadPokemonRows();
    expect(rows.length).toBeGreaterThan(800);
    expect(new Set(rows.map((row) => row.number)).size).toBe(rows.length);
    expect(rows).toContainEqual({ name: "Pikachu", number: 25 });
  });

  it("generates four-choice Pokemon questions in suitable number bands", () => {
    for (const [difficulty, min, max] of [
      ["easy", 1, 151],
      ["medium", 152, 493],
      ["hard", 494, Infinity],
    ]) {
      for (let i = 0; i < 10; i += 1) {
        const question = buildPokemonQuestion(difficulty);
        const number = Number(question.id.split(":").at(-1));
        expect(number).toBeGreaterThanOrEqual(min);
        expect(number).toBeLessThanOrEqual(max);
        expect(question.choices).toHaveLength(4);
        expect(new Set(question.choices).size).toBe(4);
        expect(question.answerIndex).toBeGreaterThanOrEqual(0);
        expect(question.answerIndex).toBeLessThan(4);
      }
    }
  });

  it("resolves both Pokemon and TPPC selections", () => {
    expect(resolveQuestionSelection({ category: "pokemon", difficulty: "easy" })).toMatchObject({
      category: "pokemon",
      difficulty: "easy",
    });
    expect(resolveQuestionSelection({ category: "tppc", difficulty: "hard" })).toMatchObject({
      category: "tppc",
      difficulty: "hard",
    });
  });

  it("parses positional manual-run overrides", () => {
    expect(parseRunOverrides(["pokemon", "hard"])).toEqual({
      ok: true,
      category: "pokemon",
      difficulty: "hard",
    });
    expect(parseRunOverrides(["pokemon", "all"])).toEqual({
      ok: true,
      category: "pokemon",
      difficulty: "all",
    });
    expect(parseRunOverrides(["hard"])).toEqual({ ok: true, category: null, difficulty: "hard" });
    expect(parseRunOverrides(["invalid"])).toEqual({ ok: false });
  });

  it("renders the answer window and multiple winners", () => {
    const question = {
      category: "pokemon",
      difficulty: "medium",
      question: "Which one?",
      choices: ["One", "Two", "Three", "Four"],
      answerIndex: 1,
    };
    expect(renderQuestion(question, 30_000)).toContain("<t:30:R>");
    expect(renderQuestion(question, 30_000)).toContain("Your first answer is final.");
    const result = renderResult({
      question,
      winners: [{ userId: "1" }, { userId: "2" }],
      responseCount: 3,
    });
    expect(result).toContain("B. Two");
    expect(result).toContain("<@1>, <@2>");
    expect(result).toContain("2 points");
  });
});
