import { describe, expect, test } from "vitest";

import { normalizeForMatch, includesWholePhrase } from "../../contests/helpers.js";

describe("contests helpers text normalization", () => {
  test("normalizeForMatch pads words and strips punctuation", () => {
    expect(normalizeForMatch("Hello, WORLD!!")).toBe(" hello world ");
  });

  test("includesWholePhrase matches whole words only", () => {
    const msg = normalizeForMatch("gold medal");
    expect(includesWholePhrase(msg, "old")).toBe(false);
    expect(includesWholePhrase(msg, "gold")).toBe(true);
  });
});
