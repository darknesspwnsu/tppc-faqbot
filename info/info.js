// info/info.js
//
// Registry for info-related modules (FAQ, wiki, help).

import { registerInfoCommands } from "./faq.js";
import { registerHelpbox } from "./helpbox.js";

export function registerInfo(register, { helpModel }) {
  registerInfoCommands(register);
  registerHelpbox(register, { helpModel });
}

export function registerInfoSchedulers() {}
