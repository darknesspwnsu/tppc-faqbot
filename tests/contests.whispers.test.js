import { describe, expect, test } from "vitest";

import {
  normalizeForMatch,
  includesWholePhrase,
  serializeItems,
  deserializeItems,
} from "../contests/whispers.js";

describe("whispers text normalization", () => {
  test("normalizeForMatch pads words and strips punctuation", () => {
    expect(normalizeForMatch("Hello, WORLD!!")).toBe(" hello world ");
  });

  test("includesWholePhrase matches whole words only", () => {
    const msg = normalizeForMatch("gold medal");
    expect(includesWholePhrase(msg, "old")).toBe(false);
    expect(includesWholePhrase(msg, "gold")).toBe(true);
  });
});

describe("whispers serialization", () => {
  test("serialize/deserialize round trip", () => {
    const items = [
      { phrase: "hello world", ownerId: "1", prize: "candy" },
      { phrase: "secret", ownerId: "2", prize: "" },
    ];

    const text = serializeItems(items);
    const back = deserializeItems(text);
    expect(back).toEqual(items);
  });
});
