import { describe, expect, test } from "vitest";

import { serializeItems, deserializeItems } from "../contests/whispers.js";

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
