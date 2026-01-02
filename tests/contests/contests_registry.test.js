import { describe, expect, it, vi } from "vitest";

vi.mock("../../contests/rng.js", () => ({ registerRng: vi.fn() }));
vi.mock("../../contests/reaction_contests.js", () => ({ registerReactionContests: vi.fn() }));
vi.mock("../../contests/whispers.js", () => ({ registerWhispers: vi.fn() }));
vi.mock("../../contests/reading.js", () => ({ registerReading: vi.fn() }));
vi.mock("../../contests/get_forum_list.js", () => ({ registerForumList: vi.fn() }));
vi.mock("../../contests/pollcontest.js", () => ({ registerPollContest: vi.fn() }));
vi.mock("../../contests/giveaway.js", () => ({ registerGiveaway: vi.fn() }));

import { registerContests, listContests } from "../../contests/contests.js";
import { registerRng } from "../../contests/rng.js";
import { registerReactionContests } from "../../contests/reaction_contests.js";
import { registerWhispers } from "../../contests/whispers.js";
import { registerReading } from "../../contests/reading.js";
import { registerForumList } from "../../contests/get_forum_list.js";
import { registerPollContest } from "../../contests/pollcontest.js";
import { registerGiveaway } from "../../contests/giveaway.js";

describe("contests registry", () => {
  it("lists contest modules in order", () => {
    expect(listContests()).toEqual([
      "rng",
      "reaction_contests",
      "whispers",
      "reading",
      "forum_list",
      "pollcontest",
      "giveaway",
    ]);
  });

  it("registers each contest module", () => {
    const register = vi.fn();
    registerContests(register);

    expect(registerRng).toHaveBeenCalledWith(register);
    expect(registerReactionContests).toHaveBeenCalledWith(register);
    expect(registerWhispers).toHaveBeenCalledWith(register);
    expect(registerReading).toHaveBeenCalledWith(register);
    expect(registerForumList).toHaveBeenCalledWith(register);
    expect(registerPollContest).toHaveBeenCalledWith(register);
    expect(registerGiveaway).toHaveBeenCalledWith(register);
  });

  it("logs errors and continues registering other modules", () => {
    const register = vi.fn();
    registerReactionContests.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    registerContests(register);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(registerRng).toHaveBeenCalled();
    expect(registerWhispers).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
