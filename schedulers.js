// schedulers.js
//
// Central scheduler wiring (self-registration by modules).

import { startAll } from "./shared/scheduler_registry.js";
import { registerToolSchedulers } from "./tools/tools.js";
import { registerRpgSchedulers } from "./rpg/rpg.js";
import { registerContestSchedulers } from "./contests/contests.js";
import { registerInfoSchedulers } from "./info/info.js";

export function registerSchedulers(context = {}) {
  registerToolSchedulers(context);
  registerRpgSchedulers(context);
  registerContestSchedulers(context);
  registerInfoSchedulers(context);
}

export function startSchedulers(context = {}) {
  registerSchedulers(context);
  startAll(context);
}
