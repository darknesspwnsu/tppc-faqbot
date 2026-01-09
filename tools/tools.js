// tools/tools.js
//
// Central registry for tools modules.
// Add new tools by importing + appending to TOOL_MODULES.

import { registerCalculator } from "./calculator.js";
import { registerRarity, registerLevel4Rarity, registerRarityScheduler } from "./rarity.js";
import { registerLinks } from "./links.js";
import { registerPromo, registerPromoScheduler } from "./promo.js";
import { registerReminders } from "./reminders.js";
import { registerMessageCounts } from "./message_counts.js";
import { registerMetricsExport, registerMetricsExportScheduler } from "./metrics_export.js";
import { registerSortbox } from "./sortbox.js";
import { logRegisterFailure } from "../shared/logging_helpers.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { scheduleMetricsCleanup } from "../shared/metrics.js";

const TOOL_MODULES = [
  { id: "links", register: registerLinks },
  { id: "promo", register: registerPromo, registerScheduler: registerPromoScheduler },
  { id: "calculator", register: registerCalculator },
  { id: "rarity", register: registerRarity, registerScheduler: registerRarityScheduler },
  { id: "reminders", register: registerReminders },
  { id: "message_counts", register: registerMessageCounts },
  { id: "metrics_export", register: registerMetricsExport, registerScheduler: registerMetricsExportScheduler },
  { id: "sortbox", register: registerSortbox },
];

export function registerTools(register) {
  for (const t of TOOL_MODULES) {
    try {
      t.register(register);
    } catch (e) {
      logRegisterFailure("tools", t.id, e);
    }
  }

  registerLevel4Rarity(register, "Tools");
}

export function registerToolSchedulers(context = {}) {
  try {
    registerScheduler("metrics_cleanup", () => scheduleMetricsCleanup());
  } catch (e) {
    logRegisterFailure("tools.schedulers", "metrics_cleanup", e);
  }

  for (const t of TOOL_MODULES) {
    if (typeof t.registerScheduler !== "function") continue;
    try {
      t.registerScheduler(context);
    } catch (e) {
      logRegisterFailure("tools.schedulers", t.id, e);
    }
  }
}

export function listTools() {
  return TOOL_MODULES.map((t) => t.id);
}
