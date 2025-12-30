// tools.js
//
// Collates tool-ish commands:
// - !calc (delegates to calculator.js)
// - !tools (wiki link)
// - !organizer / !boxorganizer (organizer link)
// - !promo / !setpromo (now persists to DB when DB is enabled; else in-memory)
//
// Tools do not read config directly.
// All gating (channels, env flags, permissions) is handled by the command registry.

import { registerCalculator } from "./calculator.js";
import { registerRarity, registerLevel4Rarity } from "./rarity.js";
import { isAdminOrPrivileged } from "./auth.js";
import { getUserText, setUserText } from "./db.js";

/* ------------------------------ promo storage ------------------------------ */

// Store promo as a guild-scoped text in user_texts using a sentinel user_id.
const PROMO_KIND = "promo";
const PROMO_USER_ID = "__guild__";

// Cache promos per guild to avoid DB hits on every call.
const promoCache = new Map(); // guildId -> string

async function getPromoForGuild(guildId) {
  if (!guildId) return "Not set";

  // Cache hit
  if (promoCache.has(guildId)) return promoCache.get(guildId);

  // DB path
  try {
    const t = await getUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND });
    const promo = (t && String(t).trim()) ? String(t).trim() : "Not set";
    promoCache.set(guildId, promo);
    return promo;
  } catch (e) {
    // If DB is misconfigured/unavailable, fall back safely to in-memory.
    const promo = "Not set";
    promoCache.set(guildId, promo);
    return promo;
  }

  // In-memory fallback (per guild)
  const promo = "Not set";
  promoCache.set(guildId, promo);
  return promo;
}

async function setPromoForGuild(guildId, promoText) {
  if (!guildId) return;

  const promo = String(promoText || "").trim() || "Not set";
  promoCache.set(guildId, promo);

  try {
    await setUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND, text: promo });
  } catch (e) {
    // Ignore DB failures; cache already updated, so bot still behaves.
  }
}

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

  // Promo commands (DB-backed when enabled; otherwise in-memory per guild)
  register(
    "!promo",
    async ({ message }) => {
      const guildId = message.guild?.id;
      const promo = await getPromoForGuild(guildId);
      await message.reply(`Current promo: ${promo}`);
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
      if (!isAdminOrPrivileged(message)) {
        await message.reply("You do not have permission to set the promo.");
        return;
      }

      const guildId = message.guild?.id;
      await setPromoForGuild(guildId, newPromo);

      const promo = await getPromoForGuild(guildId);
      await message.reply(`Promo updated to: ${promo}`);
    },
    "!setpromo <text> — sets the last promo (admin or privileged users only)"
  );

  registerCalculator(register);
  registerRarity(register);
  registerLevel4Rarity(register, "Tools");
}
