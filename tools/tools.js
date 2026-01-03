// tools/tools.js
//
// Central registry for tools modules.
// Add new tools by importing + appending to TOOL_MODULES.

import { registerCalculator } from "./calculator.js";
import { registerRarity, registerLevel4Rarity } from "./rarity.js";
import { registerLinks } from "./links.js";
import { registerPromo } from "./promo.js";
import { registerReminders } from "./reminders.js";

const TOOL_MODULES = [
  { id: "links", register: registerLinks },
  { id: "promo", register: registerPromo },
  { id: "calculator", register: registerCalculator },
  { id: "rarity", register: registerRarity },
  { id: "reminders", register: registerReminders },
];

export function registerTools(register) {
  for (const t of TOOL_MODULES) {
    try {
      t.register(register);
    } catch (e) {
      console.error(`[tools] failed to register ${t.id}:`, e);
    }
  }

  registerLevel4Rarity(register, "Tools");
}

export function listTools() {
  return TOOL_MODULES.map((t) => t.id);
}
