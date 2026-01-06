// rpg/radio_tower.js
//
// Radio Tower detection helpers for the Team Rocket takeover event.

import https from "node:https";
import http from "node:http";
import { parse } from "node-html-parser";

const RADIO_TOWER_URL = "https://www.tppcrpg.net/radio_tower.php";
const NEEDLE = /team rocket/i;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }

      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
  });
}

function extractInnerText(html) {
  const root = parse(String(html || ""));
  return String(root.text || "").replace(/\s+/g, " ").trim();
}

export async function detectRadioTower() {
  const html = await fetchText(RADIO_TOWER_URL);
  const text = extractInnerText(html);
  return NEEDLE.test(text);
}

export function buildRadioTowerMessage() {
  return (
    "🚨 **Team Rocket Takeover detected at the Radio Tower!**\n" +
    "The **Secret Key** is available (used to unlock Shaymin)."
  );
}

export const __testables = {
  extractInnerText,
};
