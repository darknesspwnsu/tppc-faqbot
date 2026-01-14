// contests/contests.js
//
// Central registry for all contest-ish modules.
// Add new contest modules by importing + appending to CONTEST_MODULES.

import { registerRng } from "./rng.js";
import { registerReactionContests } from "./reaction_contests.js";
import { registerWhispers } from "./whispers.js";
import { registerReading } from "./reading.js";
import { registerForumList } from "./get_forum_list.js";
import { registerPollContest } from "./pollcontest.js";
import { registerGiveaway } from "./giveaway.js";
import { registerLotto } from "./lotto.js";
import { logRegisterFailure } from "../shared/logging_helpers.js";

const CONTEST_MODULES = [
  { id: "rng", register: registerRng },
  { id: "reaction_contests", register: registerReactionContests },
  { id: "whispers", register: registerWhispers },
  { id: "reading", register: registerReading },
  { id: "forum_list", register: registerForumList },
  { id: "pollcontest", register: registerPollContest },
  { id: "giveaway", register: registerGiveaway },
  { id: "lotto", register: registerLotto },
];

export function registerContests(register) {
  for (const m of CONTEST_MODULES) {
    try {
      m.register(register);
    } catch (e) {
      logRegisterFailure("contests", m.id, e);
    }
  }
}

export function registerContestSchedulers(context = {}) {
  for (const m of CONTEST_MODULES) {
    if (typeof m.registerScheduler !== "function") continue;
    try {
      m.registerScheduler(context);
    } catch (e) {
      logRegisterFailure("contests.schedulers", m.id, e);
    }
  }
}

export function listContests() {
  return CONTEST_MODULES.map((m) => m.id);
}
