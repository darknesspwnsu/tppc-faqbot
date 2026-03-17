// rpg/radio_tower.js
//
// Radio Tower detection helpers for the Team Rocket takeover event.

import { parse } from "node-html-parser";
import { createRpgClientFactory } from "./client_factory.js";

const RADIO_TOWER_URL = "https://www.tppcrpg.net/radio_tower.php";
const NEEDLE = /rocket/i;
const getRpgClient = createRpgClientFactory();

function extractInnerText(html) {
  const root = parse(String(html || ""));
  return String(root.text || "").replace(/\s+/g, " ").trim();
}

function isRadioTowerHit(text) {
  return NEEDLE.test(String(text || ""));
}

export async function detectRadioTower() {
  const html = await getRpgClient().fetchPage(RADIO_TOWER_URL);
  const text = extractInnerText(html);
  return isRadioTowerHit(text);
}

export function buildRadioTowerMessage() {
  return (
    "🚨 **Team Rocket Takeover detected at the Radio Tower!**\n" +
    "The **Secret Key** is available (used to unlock Shaymin)."
  );
}

export const __testables = {
  extractInnerText,
  isRadioTowerHit,
};
