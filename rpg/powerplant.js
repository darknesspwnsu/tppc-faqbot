// rpg/powerplant.js
//
// Cached status for TPPC Power Plant.

import { parse } from "node-html-parser";

import { RpgClient } from "./rpg_client.js";
import { getLeaderboard, upsertLeaderboard } from "./storage.js";

const POWER_PLANT_URL = "https://www.tppcrpg.net/power_plant.php";
const POWER_PLANT_TTL_MS = 6 * 60 * 60_000;

function getText(node) {
  if (!node) return "";
  return String(node.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePowerPlantController(html) {
  const root = parse(String(html || ""));
  const nodes = root.querySelectorAll("p.center");
  for (const node of nodes) {
    const text = getText(node).toLowerCase();
    if (!text.includes("power plant is currently controlled by")) continue;
    const strong = node.querySelector("strong");
    const team = getText(strong) || "";
    if (team) return team;
  }
  return null;
}

async function fetchAndStore(client) {
  const html = await client.fetchPage(POWER_PLANT_URL);
  const controller = parsePowerPlantController(html);
  await upsertLeaderboard({
    challenge: "powerplant",
    payload: { controller },
  });
  return controller;
}

async function getCachedOrFetch(client) {
  const cached = await getLeaderboard({ challenge: "powerplant" });
  const now = Date.now();
  const stale = !cached?.updatedAt || now - cached.updatedAt > POWER_PLANT_TTL_MS;
  if (!cached || stale || !cached.payload?.controller) {
    const controller = await fetchAndStore(client);
    return { controller };
  }
  return { controller: cached.payload.controller };
}

export function registerPowerPlant(register) {
  let client = null;
  const getClient = () => {
    if (!client) client = new RpgClient();
    return client;
  };

  register(
    "!powerplant",
    async ({ message }) => {
      if (!message.guildId) return;
      if (!process.env.RPG_USERNAME || !process.env.RPG_PASSWORD) {
        console.error("[rpg] RPG_USERNAME/RPG_PASSWORD not configured for !powerplant");
        await message.reply("❌ RPG power plant credentials are not configured.");
        return;
      }

      const res = await getCachedOrFetch(getClient());
      const team = res?.controller;
      if (!team) {
        await message.reply("No power plant controller data found.");
        return;
      }

      await message.reply(
        `Currently controlled by **${team}**! Type !faq pp for more information about Power Hour, etc`
      );
    },
    "!powerplant — show TPPC power plant control",
    { aliases: ["!pp"] }
  );
}

export const __testables = { parsePowerPlantController };
