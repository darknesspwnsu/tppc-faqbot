import { describe, it, expect } from "vitest";
import { __testables } from "../../contests/custom_leaderboard.js";

const { parseScorePairs, aggregateScoreUpdates, extractTokens, buildHelpText } = __testables;

describe("custom leaderboard parsing", () => {
  it("builds help text for customlb help", () => {
    const help = buildHelpText();
    expect(help).toContain("/customlb createlb");
    expect(help).toContain("/customlb score update");
  });

  it("extracts tokens with quotes and mentions", () => {
    const tokens = extractTokens('"The Triassic" @User1 trainer2');
    expect(tokens).toEqual(["The Triassic", "@User1", "trainer2"]);
  });

  it("extracts tokens with commas", () => {
    const tokens = extractTokens('Haunter, "The Triassic", trainer2');
    expect(tokens).toEqual(["Haunter", "The Triassic", "trainer2"]);
  });

  it("accepts update entries without explicit sign", () => {
    const parsed = parseScorePairs("user1:1 user2:+2 user3:-1", { allowDelta: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([
      { name: "user1", value: 1 },
      { name: "user2", value: 2 },
      { name: "user3", value: -1 },
    ]);
  });

  it("rejects set entries with plus sign", () => {
    const parsed = parseScorePairs("user1:+3", { allowDelta: false });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Use a plain number for set");
  });

  it("rejects invalid score entries", () => {
    const parsed = parseScorePairs("user1:abc", { allowDelta: true });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Provide one or more");
  });

  it("parses comma-separated score entries", () => {
    const parsed = parseScorePairs('Haunter:+1, "The Triassic":-2', { allowDelta: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([
      { name: "Haunter", value: 1 },
      { name: "The Triassic", value: -2 },
    ]);
  });

  it("aggregates duplicate updates", () => {
    const entry = { id: 1, name: "User1", participantType: "text", participantKey: "user1", score: 5 };
    const aggregated = aggregateScoreUpdates([
      { entry, delta: 1 },
      { entry, delta: 2 },
    ]);
    expect(aggregated).toEqual([{ entry, delta: 3 }]);
  });
});
