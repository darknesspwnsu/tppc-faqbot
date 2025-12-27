// tools.js
//
// Collates tool-ish commands:
// - !calc (delegates to calculator.js)
// - !tools (wiki link)
// - !organizer / !boxorganizer (organizer link)

import { registerCalculator } from "./calculator.js";
import { registerRarity, registerLevel4Rarity } from "./rarity.js";

/* --------------------------------- config -------------------------------- */

const RARITY_GUILD_ALLOWLIST = (process.env.RARITY_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RARITY_ENABLED_ANYWHERE = RARITY_GUILD_ALLOWLIST.length > 0;

/* -------------------------------- registry -------------------------------- */

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

   // Promo commands
  let lastPromo = "Not set";
  const ALLOWED_PROMO_SETTERS = new Set([".dkns", "haunter07"]);

  register(
    "!promo",
    async ({ message }) => {
      await message.reply(`Current promo: ${lastPromo}`);
    },
    "!promo — shows the last promo",
    { aliases: ["!p"] }
  );

  register(
    "!setpromo",
    async ({ message, rest }) => {
      const newPromo = rest.trim();
      if (!newPromo) {
        await message.reply("Usage: !setpromo <promo text>");
        return;
      }
      const username = message.author.username;
      const isAdmin = message.author.admin;
      if (!isAdmin && !ALLOWED_PROMO_SETTERS.has(username)) {
        await message.reply("You do not have permission to set the promo.");
        return;
      }
      lastPromo = newPromo;
      await message.reply(`Promo updated to: ${lastPromo}`);
    },
    "!setpromo <text> — sets the last promo (admin or allowed users only)"
  );

  // Delegate: calculator command family
  registerCalculator(register);
  // Rarity: gated by RARITY_GUILD_ALLOWLIST inside rarity.js
  // Level 4 rarity: available everywhere
  // Rarity commands behind allowlist (but L4 is available everywhere)
  if (RARITY_ENABLED_ANYWHERE) {
    registerRarity(register);
  }
  registerLevel4Rarity(register, "Tools");
}