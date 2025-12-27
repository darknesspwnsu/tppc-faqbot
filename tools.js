// tools.js
//
// Collates tool-ish commands:
// - !calc (delegates to calculator.js)
// - !tools (wiki link)
// - !organizer / !boxorganizer (organizer link)
// - !promo / !setpromo (now persists to DB when DB is enabled; else in-memory)

import { registerCalculator } from "./calculator.js";
import { registerRarity, registerLevel4Rarity } from "./rarity.js";
import { isAdminOrPrivileged } from "./auth.js";
import { getUserText, setUserText } from "./db.js";

/* --------------------------------- config -------------------------------- */

const RARITY_GUILD_ALLOWLIST = (process.env.RARITY_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RARITY_ENABLED_ANYWHERE = RARITY_GUILD_ALLOWLIST.length > 0;

// DB enablement in your bot is currently tied to TRADING_GUILD_ALLOWLIST.
// If that list is empty, bot.js skips initDb entirely.
// We mirror the same intent here: only use DB when TRADING is enabled AND this guild is allowed.
const TRADING_GUILD_ALLOWLIST = (process.env.TRADING_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DB_ENABLED_ANYWHERE = TRADING_GUILD_ALLOWLIST.length > 0;

function dbEnabledForGuild(guildId) {
  if (!DB_ENABLED_ANYWHERE) return false;
  if (!guildId) return false;
  // If you want “DB enabled for all guilds when TRADING_GUILD_ALLOWLIST is non-empty”,
  // replace this with: return true;
  return TRADING_GUILD_ALLOWLIST.includes(String(guildId));
}

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
  if (dbEnabledForGuild(guildId)) {
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

  if (dbEnabledForGuild(guildId)) {
    try {
      await setUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND, text: promo });
    } catch (e) {
      // Ignore DB failures; cache already updated, so bot still behaves.
    }
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

  // Delegate: calculator command family
  registerCalculator(register);

  // Rarity: gated by RARITY_GUILD_ALLOWLIST inside rarity.js
  // Level 4 rarity: available everywhere
  if (RARITY_ENABLED_ANYWHERE) {
    registerRarity(register);
  }
  registerLevel4Rarity(register, "Tools");
}
