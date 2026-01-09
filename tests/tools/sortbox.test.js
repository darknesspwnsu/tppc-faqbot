import { describe, it, expect } from "vitest";
import { __testables } from "../../tools/sortbox.js";

const {
  organize,
  buildLegendSet,
  shouldFilterAsJunk,
  buildOrganizerEntries,
  parseIdList,
} = __testables;

describe("sortbox helpers", () => {
  it("parseIdList accepts commas/spaces and removes duplicates", () => {
    const ids = parseIdList("123, 456 789 456 123 001");
    expect(ids).toEqual([123, 456, 789, 1]);
  });

  it("parseIdList ignores invalid entries", () => {
    const ids = parseIdList("abc 10x -5 0 42.9");
    expect(ids).toEqual([42]);
  });

  it("buildLegendSet uses defaults when empty and respects overrides", () => {
    const defaults = buildLegendSet("");
    expect(defaults.has("mew")).toBe(true);

    const custom = buildLegendSet("Foo\nBar\n");
    expect(custom.has("foo")).toBe(true);
    expect(custom.has("mew")).toBe(false);
  });

  it("buildOrganizerEntries applies variants and preserves unknown/gender", () => {
    const input = [
      { name: "Pikachu", level: "10", gender: "♂", unknown: true, variant: "G" },
      { name: "ShinyEevee", level: "20", gender: "", unknown: false, variant: "S" },
      { name: "DarkEevee", level: "30", gender: "♀", unknown: false, variant: "D" },
    ];
    const out = buildOrganizerEntries(input);
    expect(out).toEqual([
      { name: "GoldenPikachu (?) ♂", levelNum: 10 },
      { name: "ShinyEevee", levelNum: 20 },
      { name: "DarkEevee ♀", levelNum: 30 },
    ]);
  });

  it("shouldFilterAsJunk honors filters and thresholds", () => {
    const lists = {
      mapsSet: new Set(["testmon"]),
      swapsSet: new Set(["swapmon"]),
      genderlessSet: new Set(["genderlessmon"]),
    };

    const opts = { filterJunk: true };

    expect(
      shouldFilterAsJunk({ name: "Testmon ♂", levelNum: 10 }, opts, lists)
    ).toBe(true);
    expect(
      shouldFilterAsJunk({ name: "Swapmon ♀", levelNum: 999 }, opts, lists)
    ).toBe(true);

    expect(
      shouldFilterAsJunk({ name: "Testmon ♂", levelNum: 1000 }, opts, lists)
    ).toBe(false);
    expect(
      shouldFilterAsJunk({ name: "Testmon ♂", levelNum: 4 }, opts, lists)
    ).toBe(false);
    expect(
      shouldFilterAsJunk({ name: "Genderlessmon", levelNum: 10 }, opts, lists)
    ).toBe(false);
    expect(
      shouldFilterAsJunk({ name: "Genderlessmon ♂", levelNum: 10 }, opts, lists)
    ).toBe(false);
    expect(
      shouldFilterAsJunk({ name: "Testmon (?) ♂", levelNum: 10 }, opts, lists)
    ).toBe(false);
  });

  it("organize creates expected sections", () => {
    const entries = [
      { name: "GoldenPikachu", levelNum: 10 },
      { name: "ShinyEevee", levelNum: 5 },
      { name: "DarkEevee", levelNum: 6 },
      { name: "Bulbasaur", levelNum: 4 },
    ];
    const legendSet = new Set();
    const opts = {
      combine: false,
      dupeDesc: false,
      plainLevel: false,
      combineSD: false,
      dedicatedUnknown: false,
      dedicatedLegends: false,
      keepGoldsInGolden: false,
      filterJunk: false,
    };
    const colors = { gold: "", shiny: "", dark: "", normal: "" };
    const out = organize(entries, legendSet, opts, colors, new Set());

    expect(out).toContain("[b]Golden[/b]");
    expect(out).toContain("[b]Shiny[/b]");
    expect(out).toContain("[b]Dark[/b]");
    expect(out).toContain("[b]Normal[/b]");
    expect(out).toContain("Bulbasaur");
  });

  it("organize combines shiny/dark when requested", () => {
    const entries = [
      { name: "ShinyEevee", levelNum: 5 },
      { name: "DarkEevee", levelNum: 6 },
    ];
    const legendSet = new Set();
    const opts = {
      combine: false,
      dupeDesc: false,
      plainLevel: false,
      combineSD: true,
      dedicatedUnknown: false,
      dedicatedLegends: false,
      keepGoldsInGolden: false,
      filterJunk: false,
    };
    const colors = { gold: "", shiny: "", dark: "", normal: "" };
    const out = organize(entries, legendSet, opts, colors, new Set());

    expect(out).toContain("[b]Shiny / Dark[/b]");
    expect(out).not.toContain("[b]Shiny[/b]\n[code]");
    expect(out).not.toContain("[b]Dark[/b]\n[code]");
  });
});
