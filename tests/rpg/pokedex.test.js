import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from "node:fs/promises";

const POKEDEX_JSON = JSON.stringify({
  Heracross: "214-0",
  "Golden Heracross": "214-1",
  Latios: "381-0",
});

describe("rpg/pokedex", () => {
  beforeEach(() => {
    vi.resetModules();
    fs.readFile.mockResolvedValue(POKEDEX_JSON);
  });

  it("finds entries by exact or normalized names", async () => {
    const { findPokedexEntry } = await import("../../rpg/pokedex.js");
    const res = await findPokedexEntry("heracross");
    expect(res.entry?.name).toBe("Heracross");
  });

  it("finds variant entries via normalized query variants", async () => {
    const { findPokedexEntry } = await import("../../rpg/pokedex.js");
    const res = await findPokedexEntry("g.heracross");
    expect(res.entry?.name).toBe("Golden Heracross");
  });

  it("returns suggestions when an entry is not found", async () => {
    const { findPokedexEntry } = await import("../../rpg/pokedex.js");
    const res = await findPokedexEntry("heracros");
    expect(res.entry).toBeNull();
    expect(res.suggestions).toContain("Heracross");
  });

  it("parses pokemon queries into base + variant", async () => {
    const { parsePokemonQuery } = await import("../../rpg/pokedex.js");
    expect(parsePokemonQuery("g.heracross")).toEqual({
      base: "heracross",
      variant: "golden",
    });
    expect(parsePokemonQuery("golden Heracross")).toEqual({
      base: "Heracross",
      variant: "golden",
    });
  });
});
