// tools/promo.js
//
// Promo commands (DB-backed when enabled; otherwise in-memory per guild).

import { isAdminOrPrivileged } from "../auth.js";
import { getUserText, setUserText } from "../db.js";

// Store promo as a guild-scoped text in user_texts using a sentinel user_id.
const PROMO_KIND = "promo";
const PROMO_USER_ID = "__guild__";

// Cache promos per guild to avoid DB hits on every call.
const promoCache = new Map(); // guildId -> string

async function getPromoForGuild(guildId) {
  if (!guildId) return "Not set";

  if (promoCache.has(guildId)) return promoCache.get(guildId);

  try {
    const t = await getUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND });
    const promo = t && String(t).trim() ? String(t).trim() : "Not set";
    promoCache.set(guildId, promo);
    return promo;
  } catch {
    const promo = "Not set";
    promoCache.set(guildId, promo);
    return promo;
  }
}

async function setPromoForGuild(guildId, promoText) {
  if (!guildId) return;

  const promo = String(promoText || "").trim() || "Not set";
  promoCache.set(guildId, promo);

  try {
    await setUserText({ guildId, userId: PROMO_USER_ID, kind: PROMO_KIND, text: promo });
  } catch {
    // Ignore DB failures; cache already updated.
  }
}

export function registerPromo(register) {
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
    "!setpromo <text> — sets the last promo (admin or privileged users only)",
    { admin: true }
  );
}
