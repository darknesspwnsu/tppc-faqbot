import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POKEMON_DEX_CHANCE, POKEMON_DEX_LANDMARKS } from "../../configs/trivia.js";
import { __testables } from "../../tools/trivia.js";

const {
  pointsForDifficulty,
  loadCuratedQuestions,
  normalizeQuestion,
  randomizeChoices,
  availableQuestions,
  buildPokemonQuestion,
  resolveQuestionSelection,
  parseRunOverrides,
  renderQuestion,
  renderResult,
} = __testables;

describe("trivia helpers", () => {
  afterEach(() => vi.restoreAllMocks());
  it("awards one point for easy and two for medium or hard", () => {
    expect(pointsForDifficulty("easy")).toBe(1);
    expect(pointsForDifficulty("medium")).toBe(2);
    expect(pointsForDifficulty("hard")).toBe(2);
  });

  it("loads valid TPPC questions at every difficulty", () => {
    const questions = loadCuratedQuestions().filter((question) => question.category === "tppc");
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

  it("loads a varied Pokemon bank at every difficulty without silently dropping entries", () => {
    const raw = ["pokemon_trivia_questions.json", "pokemon_hard_trivia_questions.json", "opentdb_pokemon_questions.json"]
      .flatMap((file) => JSON.parse(fs.readFileSync(new URL(`../../data/${file}`, import.meta.url), "utf8")));
    const questions = loadCuratedQuestions().filter((question) => question.category === "pokemon");
    expect(questions.length).toBeGreaterThan(350);
    expect(questions).toHaveLength(raw.length);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    expect(new Set(questions.map((q) => q.question.toLowerCase())).size).toBe(questions.length);
    for (const row of raw) {
      expect(normalizeQuestion(row), row.id).not.toBeNull();
      expect(new URL(row.source.url).protocol).toBe("https:");
      if (row.source.referenceOnly) {
        expect(row.source.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        expect(row.source.license).toBeTruthy();
      }
      // Reversing a dual type's order must not create a second correct option.
      if (row.topic === "types") {
        expect(new Set(row.choices.map((choice) => choice.split("/").sort().join("/"))).size).toBe(4);
      }
    }
    for (const difficulty of ["easy", "medium", "hard"]) {
      const general = questions.filter((q) => q.difficulty === difficulty && q.topic !== "pokedex");
      expect(general.length).toBeGreaterThanOrEqual(difficulty === "hard" ? 100 : 50);
      expect(new Set(general.map((q) => q.topic)).size).toBeGreaterThanOrEqual(8);
    }
    for (const topic of ["characters", "trainers", "places", "games", "evolution", "items", "moves", "abilities", "anime"]) {
      expect(questions.some((q) => q.topic === topic)).toBe(true);
    }
  });

  it("adds a substantial hard pool with mechanics, historical rules, world details, and spin-offs", () => {
    const hard = JSON.parse(fs.readFileSync(new URL("../../data/pokemon_hard_trivia_questions.json", import.meta.url), "utf8"));
    expect(hard.length).toBeGreaterThanOrEqual(100);
    for (const q of hard) {
      expect(q).toMatchObject({ category: "pokemon", difficulty: "hard" });
      expect(q.topic).not.toBe("pokedex");
      expect(q.id).not.toMatch(/pokemon:(preevolution|gym-type)-/);
      expect(renderQuestion(q, 30_000).length, q.id).toBeLessThanOrEqual(2000);
      expect(renderResult({ question: q, winners: [], responseCount: 0 }).length, q.id).toBeLessThanOrEqual(2000);
    }
    for (const topic of ["battle-history", "moves", "abilities", "items", "evolution", "places", "games", "characters"]) {
      expect(hard.filter((q) => q.topic === topic).length).toBeGreaterThanOrEqual(2);
    }
    const correct = (id) => {
      const q = hard.find((q) => q.id === `pokemon:hard:${id}`);
      return q.choices[q.answerIndex];
    };
    expect(correct("psychup")).toBe("Focus Energy's critical-hit boost");
    expect(correct("punchingglove")).toBe("Punching Glove");
    expect(correct("ironball")).toBe("Neutral (1×)");
    expect(correct("rby-ghost-psychic")).toBe("It has no effect");
    expect(correct("emerald-registeel")).toBe("Flash");
    expect(correct("basculegion-recoil")).toBe("At least 294 HP");
  });

  it("restricts every dex question to its configured landmark and direction", () => {
    const dex = loadCuratedQuestions().filter((q) => q.topic === "pokedex");
    const expectedCount = Object.values(POKEMON_DEX_LANDMARKS)
      .flatMap((levels) => Object.values(levels)).reduce((total, ids) => total + ids.length, 0);
    expect(dex).toHaveLength(expectedCount);
    for (const q of dex) {
      expect(POKEMON_DEX_LANDMARKS[q.dexDirection][q.difficulty]).toContain(q.dexNumber);
    }
    for (const number of [67, 69, 100, 200, 300, 420, 666, 777]) {
      expect(dex.some((q) => q.dexDirection === "name" && q.dexNumber === number)).toBe(true);
    }
    for (const [number, name] of [[666, "Vivillon"], [777, "Togedemaru"], [1000, "Gholdengo"]]) {
      const q = dex.find((q) => q.dexDirection === "name" && q.dexNumber === number);
      expect(q.choices[q.answerIndex]).toBe(name);
    }
  });

  it("reserves only 15 percent of the Pokemon draw for dex landmarks", () => {
    expect(POKEMON_DEX_CHANCE).toBe(0.15);
    const random = vi.spyOn(Math, "random");
    for (const difficulty of ["easy", "medium", "hard"]) {
      random.mockReturnValue(0.149);
      expect(buildPokemonQuestion(difficulty).topic).toBe("pokedex");
      random.mockReturnValue(0.15);
      expect(buildPokemonQuestion(difficulty).topic).not.toBe("pokedex");
      expect(buildPokemonQuestion(difficulty)).toMatchObject({ category: "pokemon", difficulty });
    }
  });

  it("keeps the dex probability when either question group has exhausted its recent pool", () => {
    const random = vi.spyOn(Math, "random");
    for (const difficulty of ["easy", "medium", "hard"]) {
      const candidates = loadCuratedQuestions().filter((q) => q.category === "pokemon" && q.difficulty === difficulty);
      const generalHistory = candidates.filter((q) => q.topic !== "pokedex").map((q) => q.id);
      random.mockReturnValue(0.5);
      const general = buildPokemonQuestion(difficulty, generalHistory);
      expect(general.topic).not.toBe("pokedex");
      expect(general.id).not.toBe(generalHistory.at(-1));
      const dexHistory = candidates.filter((q) => q.topic === "pokedex").map((q) => q.id);
      random.mockReturnValue(0.1);
      const dex = buildPokemonQuestion(difficulty, dexHistory);
      expect(dex.topic).toBe("pokedex");
      expect(dex.id).not.toBe(dexHistory.at(-1));
    }
  });

  it("rates basic evolution and Gym specialities as easy across all generations", () => {
    const questions = loadCuratedQuestions();
    for (const q of questions.filter((q) => /pokemon:(preevolution|gym-type)-/.test(q.id))) {
      expect(q.difficulty, q.id).toBe("easy");
    }
    for (const q of questions.filter((q) => /pokemon:(badge|evolution-trade|regional-type)-/.test(q.id))) {
      expect(q.difficulty, q.id).toBe("medium");
    }
    expect(questions.find((q) => q.id === "pokemon:preevolution-461").difficulty).toBe("easy");
    expect(questions.find((q) => q.id === "pokemon:gym-type-grant").difficulty).toBe("easy");
    expect(questions.find((q) => q.id === "pokemon:evolution-stone-135").difficulty).toBe("easy");
    expect(questions.find((q) => q.id === "pokemon:hidden-ability-38").difficulty).toBe("medium");
  });

  it("keeps every non-dex topic reachable without weighting by bank size", () => {
    const random = vi.spyOn(Math, "random");
    for (const difficulty of ["easy", "medium", "hard"]) {
      const topics = [...new Set(loadCuratedQuestions()
        .filter((q) => q.category === "pokemon" && q.difficulty === difficulty && q.topic !== "pokedex")
        .map((q) => q.topic))];
      for (const [index, topic] of topics.entries()) {
        random.mockReturnValue(0.5).mockReturnValueOnce(0.9).mockReturnValueOnce((index + 0.5) / topics.length);
        expect(buildPokemonQuestion(difficulty).topic).toBe(topic);
      }
    }
  });

  it("avoids recent questions and gracefully cycles an exhausted filtered pool", () => {
    const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(availableQuestions(candidates, ["a", "b"])).toEqual([{ id: "c" }]);
    expect(availableQuestions(candidates, ["a", "b", "c"])).toEqual([{ id: "a" }, { id: "b" }]);
    expect(availableQuestions([{ id: "a" }], ["a"])).toEqual([{ id: "a" }]);
    expect(availableQuestions([], ["a"])).toEqual([]);
    for (const category of ["pokemon", "tppc"]) {
      const first = resolveQuestionSelection({ category, difficulty: "easy" });
      for (let i = 0; i < 20; i += 1) {
        expect(resolveQuestionSelection({ category, difficulty: "easy", recentIds: [first.id] }).id).not.toBe(first.id);
      }
    }
  });

  it("preserves correct answers when shuffling and rejects malformed choices or unrestricted dex entries", () => {
    for (const question of loadCuratedQuestions()) {
      const shuffled = randomizeChoices(question);
      expect(shuffled.choices[shuffled.answerIndex]).toBe(question.choices[question.answerIndex]);
    }
    const valid = loadCuratedQuestions()[0];
    expect(normalizeQuestion({ ...valid, choices: ["a", "A", "b", "c"] })).toBeNull();
    expect(normalizeQuestion({ ...valid, choices: ["a", " ", "b", "c"] })).toBeNull();
    expect(normalizeQuestion({ ...valid, category: "pokemon", topic: "pokedex", dexDirection: "name", dexNumber: 123 })).toBeNull();
    const ditto = loadCuratedQuestions().find((q) => q.id === "pokemon:hidden-ability-132");
    expect(ditto.choices[ditto.answerIndex]).toBe("Imposter");
    expect(ditto.choices).not.toContain("Impostor");
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

  it("credits adapted Open Trivia DB questions after the round", () => {
    const question = loadCuratedQuestions().find((q) => q.source?.name === "Open Trivia DB");
    expect(renderQuestion(question, 30_000)).not.toContain("Source:");
    const result = renderResult({ question, winners: [], responseCount: 0 });
    expect(result).toContain("[Open Trivia DB](https://opentdb.com/)");
    expect(result).toContain("adapted; [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)");
  });
});
