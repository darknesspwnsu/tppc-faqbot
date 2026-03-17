#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SOURCE_URL =
  "https://raw.githubusercontent.com/darknesspwnsu/tppc-tools/main/public/data/swap_status.json";
const OUT_PATH = path.resolve("data/swap_status.json");

function parseArgs(argv) {
  const sourceUrl = String(argv[0] || process.env.SWAP_STATUS_SOURCE_URL || DEFAULT_SOURCE_URL).trim();
  if (!sourceUrl) {
    throw new Error("Missing source URL for swap status JSON.");
  }
  return { sourceUrl };
}

function assertSwapStatusShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("swap status payload must be an object with metadata and entries.");
  }

  const entries = payload.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("swap status payload.entries must be an object map.");
  }

  const first = Object.values(entries)[0];
  if (first && typeof first === "object") {
    const required = ["displayName", "currentSecretSwap", "formerSecretSwap", "currentMap", "mapSources"];
    for (const key of required) {
      if (!(key in first)) {
        throw new Error(`swap status entry is missing required field: ${key}`);
      }
    }
  }

  return entries;
}

async function fetchWithTimeout(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { sourceUrl } = parseArgs(process.argv.slice(2));

  const response = await fetchWithTimeout(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download swap status data (${response.status}) from ${sourceUrl}`);
  }

  const text = await response.text();
  const parsed = JSON.parse(text);
  const entries = assertSwapStatusShape(parsed);

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  const count = Object.keys(entries).length;
  const generatedAt = parsed?.metadata?.generatedAt ? ` (generatedAt=${parsed.metadata.generatedAt})` : "";
  console.log(`[swap-status] wrote ${count.toLocaleString("en-US")} entries to ${OUT_PATH}${generatedAt}`);
  console.log(`[swap-status] source: ${sourceUrl}`);
}

main().catch((err) => {
  console.error("[swap-status] sync failed:", err?.message || err);
  process.exit(1);
});
