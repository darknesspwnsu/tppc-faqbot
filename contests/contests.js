// contests/contests.js
//
// Central registry for all contest-ish modules.
// Add new contest modules by importing + appending to CONTEST_MODULES.

import { registerRng } from "./rng.js";
import { registerReactionContests } from "./reaction_contests.js";
import { registerWhispers } from "./whispers.js";

const CONTEST_MODULES = [
  { id: "rng", register: registerRng },
  { id: "reaction_contests", register: registerReactionContests },
  { id: "whispers", register: registerWhispers },
];

export function registerContests(register) {
  for (const m of CONTEST_MODULES) {
    try {
      m.register(register);
    } catch (e) {
      console.error(`[contests] failed to register ${m.id}:`, e);
    }
  }
}

export function listContests() {
  return CONTEST_MODULES.map((m) => m.id);
}
