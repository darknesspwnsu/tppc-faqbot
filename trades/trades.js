// trades/trades.js
//
// Central registry for trading modules.

import { registerTradeCommands } from "./trade_commands.js";
import { registerId } from "./id.js";

const TRADE_MODULES = [
  { id: "trade_commands", register: registerTradeCommands },
  { id: "id", register: registerId },
];

export function registerTrades(register) {
  for (const t of TRADE_MODULES) {
    try {
      t.register(register);
    } catch (e) {
      console.error(`[trades] failed to register ${t.id}:`, e);
    }
  }
}

export function listTrades() {
  return TRADE_MODULES.map((t) => t.id);
}
