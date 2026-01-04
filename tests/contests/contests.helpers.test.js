import { describe, expect, test, vi } from "vitest";

vi.mock("../../db.js", () => ({
  getSavedId: vi.fn(async () => null),
}));

import {
  normalizeForMatch,
  includesWholePhrase,
  stripEmojisAndSymbols,
  sendChunked,
  dmChunked,
} from "../../contests/helpers.js";

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

describe("contests helpers misc utilities", () => {
  test("stripEmojisAndSymbols removes punctuation and trims", () => {
    expect(stripEmojisAndSymbols(" Hello!! 123 ")).toBe("Hello 123");
  });

  test("sendChunked sends once when under limit", async () => {
    const send = vi.fn(async () => {});
    await sendChunked({ send, header: "Header", lines: ["Line 1", "Line 2"], limit: 200 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Header\n\nLine 1\nLine 2");
  });

  test("sendChunked splits output and keeps header separate when over limit", async () => {
    const send = vi.fn(async () => {});
    await sendChunked({ send, header: "Header", lines: ["LineOne", "LineTwo"], limit: 10 });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(1, "Header");
    expect(send).toHaveBeenNthCalledWith(2, "LineOne");
    expect(send).toHaveBeenNthCalledWith(3, "LineTwo");
  });

  test("dmChunked splits messages by limit", async () => {
    const dmSend = vi.fn(async () => {});
    const user = { send: dmSend };

    await dmChunked(user, "Header", ["a"], 6);
    expect(dmSend).toHaveBeenCalledTimes(2);
    expect(dmSend).toHaveBeenNthCalledWith(1, { content: "Header" });
    expect(dmSend).toHaveBeenNthCalledWith(2, { content: "a" });
  });
});
