// rpg/rpg.js
//
// Central registry for RPG modules.

import { registerLeaderboard } from "./leaderboard.js";
import { registerPowerPlant } from "./powerplant.js";
import { registerFindMyId } from "./findmyid.js";
import { registerViewbox } from "./viewbox.js";
import { registerPokedex } from "./pokedex.js";

const RPG_MODULES = [
  { id: "leaderboard", register: registerLeaderboard },
  { id: "powerplant", register: registerPowerPlant },
  { id: "findmyid", register: registerFindMyId },
  { id: "viewbox", register: registerViewbox },
  { id: "pokedex", register: registerPokedex },
];

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
