import { describe, it, expect } from "vitest";
import { __testables } from "../games/deal_or_no_deal.js";

const { normalizePrizeLine, parsePrizesFromLines, unopenedIndices, otherUnopenedIndex, snapshotGame, revealAllText } =
  __testables;

describe("deal_or_no_deal helpers", () => {
  it("normalizePrizeLine handles empty and literal Empty", () => {
    expect(normalizePrizeLine("")).toBe("(empty)");
    expect(normalizePrizeLine("Empty")).toBe("(empty)");
    expect(normalizePrizeLine(" $5 ")).toBe("$5");
  });

  it("parsePrizesFromLines fills blanks as empty", () => {
    const prizes = parsePrizesFromLines("A\n\nB", 3);
    expect(prizes).toEqual(["A", "(empty)", "B"]);
  });

  it("unopenedIndices returns unopened boxes", () => {
    const game = { n: 3, boxes: [{ opened: false }, { opened: true }, { opened: false }] };
    expect(unopenedIndices(game)).toEqual([0, 2]);
  });

  it("otherUnopenedIndex finds the non-kept unopened box", () => {
    const game = {
      n: 3,
      boxes: [{ opened: false }, { opened: false }, { opened: true }],
      keptIndex: 0,
    };
    expect(otherUnopenedIndex(game)).toBe(1);
  });

  it("snapshotGame copies fields needed for reveal", () => {
    const game = {
      guildId: "g",
      channelId: "c",
      hostId: "h",
      contestantId: "p",
      n: 2,
      keptIndex: 1,
      dealTaken: true,
      boxes: [{ prize: "$1", opened: false }, { prize: "$2", opened: true }],
    };
    const snap = snapshotGame(game);
    expect(snap.hostId).toBe("h");
    expect(snap.boxes).toEqual([
      { prize: "$1", opened: false },
      { prize: "$2", opened: true },
    ]);
  });

  it("revealAllText returns a string", () => {
    const snap = {
      hostId: "h",
      contestantId: "p",
      n: 2,
      keptIndex: 0,
      dealTaken: false,
      boxes: [{ prize: "$1", opened: false }, { prize: "$2", opened: true }],
    };
    const text = revealAllText(snap);
    expect(typeof text).toBe("string");
  });
});
