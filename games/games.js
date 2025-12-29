// games/games.js
//
// Central registry for all game modules.
// Add new games by importing + appending to GAME_MODULES.

import { registerExplodingVoltorbs } from "./exploding_voltorbs.js";
import { registerExplodingElectrode } from "./exploding_electrode.js";
import { registerSafariZone } from "./safari_zone.js";
import { registerBingo } from "./bingo.js";
import { registerBlackjack } from "./blackjack.js";
import { registerClosestRollWins } from "./closest_roll_wins.js";
import { registerHigherOrLower } from "./higher_or_lower.js";
import { registerRPS } from "./rps.js";
import { registerHangman } from "./hangman.js";
import { registerDealOrNoDeal } from "./deal_or_no_deal.js";
import { registerAuction } from "./auction.js";

const GAME_MODULES = [
  { id: "exploding_voltorbs", register: registerExplodingVoltorbs },
  { id: "exploding_electrode", register: registerExplodingElectrode },
  { id: "safari_zone", register: registerSafariZone },
  { id: "bingo", register: registerBingo },
  { id: "blackjack", register: registerBlackjack },
  { id: "closest_roll_wins", register: registerClosestRollWins },
  { id: "higher_or_lower", register: registerHigherOrLower },
  { id: "rps", register: registerRPS },
  { id: "hangman", register: registerHangman },
  { id: "deal_or_no_deal", register: registerDealOrNoDeal },
  { id: "auction", register: registerAuction }
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
