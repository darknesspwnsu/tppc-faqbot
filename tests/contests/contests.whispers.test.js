import { describe, expect, test } from "vitest";

import { serializeItems, deserializeItems, removeWhisper } from "../../contests/whispers.js";

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

  test("removeWhisper deletes only the matching owner/phrase", () => {
    const state = {
      items: [
        { phrase: "tomato", ownerId: "1", prize: "" },
        { phrase: "tomato", ownerId: "2", prize: "prize" },
      ],
    };

    const res = removeWhisper(state, "tomato", "1");
    expect(res.ok).toBe(true);
    expect(state.items).toEqual([{ phrase: "tomato", ownerId: "2", prize: "prize" }]);
  });

  test("removeWhisper is case-insensitive", () => {
    const state = {
      items: [{ phrase: "Tomato", ownerId: "1", prize: "" }],
    };

    const res = removeWhisper(state, "tomato", "1");
    expect(res.ok).toBe(true);
    expect(state.items).toEqual([]);
  });
});
