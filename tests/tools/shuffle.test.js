import { describe, expect, it, vi } from "vitest";
import { parseShuffleItems, shuffleItems, registerShuffle } from "../../tools/shuffle.js";

describe("public list shuffle", () => {
  it("preserves multiword names, mentions, duplicates, and each input occurrence", () => {
    expect(parseShuffleItems("Alice Smith\nBob\nAlice Smith")).toEqual(["Alice Smith", "Bob", "Alice Smith"]);
    expect(parseShuffleItems("Alice Smith, <@123>, Bob")).toEqual(["Alice Smith", "<@123>", "Bob"]);
    expect(parseShuffleItems("1 2 3")).toEqual(["1", "2", "3"]);
    const input = ["Alice", "Alice", "Bob", "Charlie"];
    expect(shuffleItems(input, () => 0)).toEqual(["Alice", "Bob", "Charlie", "Alice"]);
    expect(input).toEqual(["Alice", "Alice", "Bob", "Charlie"]);
  });

  it("posts publicly without pinging and sends long results as a file", async () => {
    const register = { expose: vi.fn() };
    registerShuffle(register);
    const { handler } = register.expose.mock.calls[0][0];
    const message = { reply: vi.fn() };
    await handler({ message, rest: "<@123>, Bob", cmd: "?shuffle" });
    expect(message.reply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("<@123>"), allowedMentions: { parse: [], repliedUser: false } }));
    await handler({ message, rest: ["a".repeat(1100), "b".repeat(1100)].join("\n"), cmd: "!shuffle" });
    expect(message.reply.mock.lastCall[0].files[0].name).toBe("shuffled-list.txt");
    await handler({ message, rest: "one", cmd: "?shuffle" });
    expect(message.reply.mock.lastCall[0]).toContain("?shuffle");
  });
});
