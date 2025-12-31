// rpg/pokedex.js
//
// Lookup helpers for TPPC pokedex name -> key (e.g. "004-0").

import fs from "node:fs/promises";
import path from "node:path";

import { getSuggestionsFromIndex, normalizeKey, normalizeQueryVariants } from "../tools/rarity.js";

const POKEDEX_PATH = path.resolve("data/pokedex_map.json");

let pokedex = null; // { name: key }
let pokedexLower = null; // { lowerName: entry }
let pokedexNorm = null; // { normalizedKey: entry }

async function loadPokedexMap() {
  if (pokedex) return pokedex;
  const raw = await fs.readFile(POKEDEX_PATH, "utf8");
  pokedex = JSON.parse(raw);

  pokedexLower = {};
  pokedexNorm = {};

  for (const [name, key] of Object.entries(pokedex)) {
    const entry = { name, key };
    pokedexLower[name.toLowerCase()] = entry;
    const norm = normalizeKey(name);
    if (!pokedexNorm[norm]) pokedexNorm[norm] = entry;
  }

  return pokedex;
}

export async function findPokedexEntry(queryRaw) {
  if (!queryRaw) return { entry: null, suggestions: [] };
  await loadPokedexMap();

  const lower = String(queryRaw).toLowerCase();
  let entry = pokedexLower?.[lower] || null;
  if (entry) return { entry, suggestions: [] };

  const tries = normalizeQueryVariants(queryRaw);
  for (const t of tries) {
    entry = pokedexNorm?.[t] || null;
    if (entry) return { entry, suggestions: [] };
  }

  const suggestions = getSuggestionsFromIndex(pokedexNorm, queryRaw, 5);
  return { entry: null, suggestions };
}
