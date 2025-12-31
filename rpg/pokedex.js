// rpg/pokedex.js
//
// Lookup helpers for TPPC pokedex name -> key (e.g. "004-0").

import fs from "node:fs/promises";
import path from "node:path";

import {
  getSuggestionsFromIndex,
  normalizeKey,
  normalizeQueryVariants,
  queryVariantPrefix,
} from "../shared/pokename_utils.js";

const POKEDEX_PATH = path.resolve("data/pokedex_map.json");

let pokedex = null; // { name: key }
let pokedexLower = null; // { lowerName: entry }
let pokedexNorm = null; // { normalizedKey: entry }

function parsePokemonQuery(raw) {
  const q = String(raw || "").trim();
  if (!q) return { base: "", variant: "" };

  const lower = q.toLowerCase();
  let variant = queryVariantPrefix(lower);
  let base = q;

  const mDot = lower.match(/^([sdg])\.(.+)$/);
  if (mDot) {
    variant = variant || (mDot[1] === "s" ? "shiny" : mDot[1] === "d" ? "dark" : "golden");
    base = q.slice(2).trim();
    return { base, variant };
  }

  const mSpace = lower.match(/^([sdg])\s+(.+)$/);
  if (mSpace) {
    variant = variant || (mSpace[1] === "s" ? "shiny" : mSpace[1] === "d" ? "dark" : "golden");
    base = q.slice(2).trim();
    return { base, variant };
  }

  const mWord = lower.match(/^(shiny|dark|golden)\s+(.+)$/);
  if (mWord) {
    variant = variant || mWord[1];
    base = q.slice(mWord[1].length).trim();
    return { base, variant };
  }

  const mPrefix = lower.match(/^(shiny|dark|golden)([a-z0-9].+)$/);
  if (mPrefix) {
    variant = variant || mPrefix[1];
    base = q.slice(mPrefix[1].length).trim();
    return { base, variant };
  }

  const mStuck = lower.match(/^([sdg])([a-z0-9].+)$/);
  if (mStuck) {
    variant = variant || (mStuck[1] === "s" ? "shiny" : mStuck[1] === "d" ? "dark" : "golden");
    base = q.slice(1).trim();
    return { base, variant };
  }

  return { base: q, variant };
}

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

export { parsePokemonQuery };

export const __testables = { parsePokemonQuery };
