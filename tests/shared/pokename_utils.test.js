import { describe, it, expect } from "vitest";

import {
  getSuggestionsFromIndex,
  normalizeKey,
  normalizeQueryVariants,
  queryVariantPrefix,
} from "../../shared/pokename_utils.js";

describe("pokename_utils", () => {
  it("normalizes keys consistently", () => {
    expect(normalizeKey("Flabébé")).toBe("flabebe");
    expect(normalizeKey("Shiny Gourgeist (Large)")).toBe("shinygourgeistlarge");
  });

  it("normalizes variant queries", () => {
    expect(normalizeQueryVariants("g.heracross")).toContain("goldenheracross");
    expect(normalizeQueryVariants("shiny charmander")).toContain("shinycharmander");
    expect(normalizeQueryVariants("schar")).toContain("shinychar");
  });

  it("detects variant prefixes", () => {
    expect(queryVariantPrefix("g.heracross")).toBe("golden");
    expect(queryVariantPrefix("dark heracross")).toBe("dark");
    expect(queryVariantPrefix("heracross")).toBe("");
  });

  it("suggests names based on normalized index", () => {
    const index = {
      charmander: { name: "Charmander" },
      shinycharmander: { name: "Shiny Charmander" },
      heracross: { name: "Heracross" },
      goldenheracross: { name: "Golden Heracross" },
    };

    expect(getSuggestionsFromIndex(index, "charmander", 3)).toContain("Charmander");
    expect(getSuggestionsFromIndex(index, "g.heracross", 3)).toContain("Golden Heracross");
  });
});
