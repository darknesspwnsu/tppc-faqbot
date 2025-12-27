// games/games.js
//
// Central registry for all game modules.
// Add new games by importing + appending to GAME_MODULES.

import { registerExplodingVoltorbs } from "./exploding_voltorbs.js";
import { registerExplodingElectrode } from "./exploding_electrode.js";
import { registerSafariZone } from "./safari_zone.js";

const GAME_MODULES = [
  { id: "exploding_voltorbs", register: registerExplodingVoltorbs },
  { id: "exploding_electrode", register: registerExplodingElectrode },
  { id: "safari_zone", register: registerSafariZone },
];


export function registerGames(register) {
  for (const g of GAME_MODULES) {
    try {
      g.register(register);
    } catch (e) {
      console.error(`[games] failed to register ${g.id}:`, e);
    }
  }
}

export function listGames() {
  return GAME_MODULES.map((g) => g.id);
}
