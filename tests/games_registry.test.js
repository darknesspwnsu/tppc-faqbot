import { describe, it, expect } from "vitest";
import { listGames } from "../games/games.js";

describe("games registry", () => {
  it("lists known game ids without duplicates", () => {
    const ids = listGames();
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
    expect(ids).toContain("exploding_voltorbs");
    expect(ids).toContain("exploding_electrode");
    expect(ids).toContain("safari_zone");
    expect(ids).toContain("bingo");
    expect(ids).toContain("blackjack");
    expect(ids).toContain("closest_roll_wins");
    expect(ids).toContain("higher_or_lower");
    expect(ids).toContain("rps");
    expect(ids).toContain("hangman");
    expect(ids).toContain("deal_or_no_deal");
    expect(ids).toContain("auction");
  });
});
