import { describe, it, expect } from "vitest";
import { __testables } from "../../games/pokemon_unscramble.js";

const { buildStartState, shouldIgnoreGuess, isMessageInGameChannel } = __testables;

describe("pokemon unscramble helpers", () => {
  it("buildStartState wires unique winners tracking", () => {
    const st = buildStartState({
      guildId: "g1",
      channelId: "c1",
      creatorId: "u1",
      players: ["u1", "u2"],
      timeLimitSec: 10,
      roundsTarget: 2,
      wordList: ["Pikachu", "Eevee"],
      client: null,
      uniqueWinners: true,
    });

    expect(st.uniqueWinners).toBe(true);
    expect(st.roundWinners).toBeInstanceOf(Set);
    expect(st.roundWinners.size).toBe(0);
  });

  it("shouldIgnoreGuess blocks non-players", () => {
    const st = buildStartState({
      guildId: "g1",
      channelId: "c1",
      creatorId: "u1",
      players: ["u1"],
      timeLimitSec: 10,
      roundsTarget: 1,
      wordList: ["Pikachu"],
      client: null,
      uniqueWinners: false,
    });

    expect(shouldIgnoreGuess(st, "u2")).toBe(true);
  });

  it("shouldIgnoreGuess blocks prior winners when unique winners is enabled", () => {
    const st = buildStartState({
      guildId: "g1",
      channelId: "c1",
      creatorId: "u1",
      players: ["u1", "u2"],
      timeLimitSec: 10,
      roundsTarget: 2,
      wordList: ["Pikachu", "Eevee"],
      client: null,
      uniqueWinners: true,
    });

    st.roundWinners.add("u2");
    expect(shouldIgnoreGuess(st, "u2")).toBe(true);
    expect(shouldIgnoreGuess(st, "u1")).toBe(false);
  });

  it("isMessageInGameChannel ignores off-channel messages", () => {
    const st = buildStartState({
      guildId: "g1",
      channelId: "c1",
      creatorId: "u1",
      players: ["u1"],
      timeLimitSec: 10,
      roundsTarget: 1,
      wordList: ["Pikachu"],
      client: null,
      uniqueWinners: false,
    });

    expect(isMessageInGameChannel(st, { channelId: "c1" })).toBe(true);
    expect(isMessageInGameChannel(st, { channelId: "c2" })).toBe(false);
  });
});
