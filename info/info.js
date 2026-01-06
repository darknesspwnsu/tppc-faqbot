// info/info.js
//
// Registry for info-related modules (FAQ, wiki, help).

import { registerInfoCommands } from "./faq.js";
import { registerHelpbox } from "./helpbox.js";
import { registerEvents, registerEventSchedulers } from "../events/events.js";

export function registerInfo(register, { helpModel }) {
  registerInfoCommands(register);
  registerHelpbox(register, { helpModel });
  registerEvents(register);
}

export function registerInfoSchedulers(context = {}) {
  registerEventSchedulers(context);
}
