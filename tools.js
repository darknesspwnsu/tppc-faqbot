// tools.js
//
// Collates tool-ish commands:
// - !calc (delegates to calculator.js)
// - !tools (wiki link)
// - !organizer / !boxorganizer (organizer link)

import { registerCalculator } from "./calculator.js";

export function registerTools(register) {
  // Link: organizer
  register(
    "!organizer",
    async ({ message }) => {
      await message.reply("https://coldsp33d.github.io/box_organizer");
    },
    "!organizer — returns the organizer page link",
    { aliases: ["!boxorganizer"] }
  );

  // Link: tools hub
  register(
    "!tools",
    async ({ message }) => {
      await message.reply("https://wiki.tppc.info/TPPC_Tools_and_Calculators");
    },
    "!tools — returns a wiki link to several helpful TPPC tools, calculators and other utilties."
  );

  // Delegate: calculator command family
  registerCalculator(register);
}
