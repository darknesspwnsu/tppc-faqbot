import { describe, it, expect } from "vitest";

import { sanitizeSwapInput, normalizeSwapLookupKey, __testables } from "../../rpg/swap_status.js";

describe("swap_status helpers", () => {
  it("sanitizes level and gender suffixes", () => {
    expect(sanitizeSwapInput("ShinyPonyta (Galar) (?) (Level: 5) ♂")).toBe("ShinyPonyta (Galar)");
  });

  it("normalizes punctuation and spacing variants", () => {
    expect(normalizeSwapLookupKey("Mr Mime")).toBe(normalizeSwapLookupKey("MrMime"));
    expect(normalizeSwapLookupKey("Farfetch'd")).toBe(normalizeSwapLookupKey("Farfetchd"));
  });

  it("builds the same notes text used by swap-status", () => {
    const notes = __testables.buildNotes({
      currentSecretSwap: false,
      formerSecretSwap: true,
      currentMap: true,
      mapSources: ["Victory Path", "Ruins"],
    });

    expect(notes).toEqual([
      "pokemon was formerly obtained via secret swap",
      "this pokemon is obtainable via Victory Path and Ruins maps",
    ]);
  });

  it("builds the same summary text used by swap-status", () => {
    const summary = __testables.buildSummary({
      currentSecretSwap: true,
      formerSecretSwap: false,
      currentMap: true,
      mapSources: ["Victory Path"],
    });

    expect(summary).toBe(
      "Yes. This pokemon is currently obtainable via secret swap, and it is also obtainable via maps."
    );
  });
});
