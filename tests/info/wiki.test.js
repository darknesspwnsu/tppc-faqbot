import { describe, it, expect, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: fsMocks,
  readFileSync: fsMocks.readFileSync,
}));

import { createWikiService } from "../../info/wiki.js";

describe("wiki service", () => {
  it("searches titles and returns wiki urls", () => {
    fsMocks.readFileSync.mockReturnValueOnce(
      JSON.stringify(["Pokemon", "Pokemon Battle", "Trading", "PokeMart"])
    );

    const wiki = createWikiService({ maxResults: 5, titlesPath: "ignored.json" });
    const results = wiki.search("pokemon");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title.toLowerCase()).toContain("pokemon");
    expect(results[0].url).toContain("https://wiki.tppc.info/");
  });

  it("prefers exact matches and shorter titles", () => {
    fsMocks.readFileSync.mockReturnValueOnce(
      JSON.stringify(["Pokemon Battle", "Pokemon", "Pokemon Center"])
    );

    const wiki = createWikiService({ maxResults: 3, titlesPath: "ignored.json" });
    const results = wiki.search("Pokemon");

    expect(results[0].title).toBe("Pokemon");
  });
});
