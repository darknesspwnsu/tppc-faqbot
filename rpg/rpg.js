// rpg/rpg.js
//
// Central registry for RPG modules.

import { registerLeaderboard } from "./leaderboard.js";

const RPG_MODULES = [{ id: "leaderboard", register: registerLeaderboard }];

export function registerRpg(register) {
  for (const m of RPG_MODULES) {
    try {
      m.register(register);
    } catch (e) {
      console.error(`[rpg] failed to register ${m.id}:`, e);
    }
  }
}

export function listRpgModules() {
  return RPG_MODULES.map((m) => m.id);
}
