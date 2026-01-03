#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeKey } from "../shared/pokename_utils.js";

const EVOLUTION_URL = "https://coldsp33d.github.io/data/pokemon_evolution.json";
const POKEDEX_PATH = path.resolve("data/pokedex_map.json");
const OUT_PATH = path.resolve("data/pokemon_evolutions.json");

function formatEvolutionName(name, form) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (!form || form === "Normal") return trimmed;
  return `${trimmed} (${form})`;
}

function buildEvolutionIndex(data) {
  const names = data?.pokemon_name || {};
  const forms = data?.form || {};
  const evolutions = data?.evolutions || {};
  const nameByIndex = {};
  const formByIndex = {};
  const nameIndex = {};

  const setNameIndex = (key, idx) => {
    if (!key) return;
    if (nameIndex[key] == null) nameIndex[key] = String(idx);
  };

  for (const [idx, name] of Object.entries(names)) {
    nameByIndex[idx] = name;
    const form = forms?.[idx] || "Normal";
    formByIndex[idx] = form;

    setNameIndex(normalizeKey(name), idx);
    if (form && form !== "Normal") {
      setNameIndex(normalizeKey(`${name} (${form})`), idx);
    }
  }

  const parentByIndex = {};
  for (const [parentIdx, list] of Object.entries(evolutions)) {
    if (!Array.isArray(list)) continue;
    for (const evo of list) {
      const childName = evo?.pokemon_name;
      if (!childName) continue;
      const childForm = evo?.form || "Normal";
      const key = normalizeKey(
        childForm && childForm !== "Normal" ? `${childName} (${childForm})` : childName
      );
      const childIdx = nameIndex[key];
      if (childIdx != null && parentByIndex[childIdx] == null) {
        parentByIndex[childIdx] = String(parentIdx);
      }
    }
  }

  return { nameByIndex, formByIndex, parentByIndex };
}

async function main() {
  const pokedexRaw = JSON.parse(await fs.readFile(POKEDEX_PATH, "utf8"));
  const canonicalByNorm = {};
  for (const name of Object.keys(pokedexRaw)) {
    canonicalByNorm[normalizeKey(name)] = name;
  }

  const res = await fetch(EVOLUTION_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch evolution data: ${res.status}`);
  }
  const data = await res.json();

  const { nameByIndex, formByIndex, parentByIndex } = buildEvolutionIndex(data);
  const baseByName = {};

  for (const [idx, name] of Object.entries(nameByIndex)) {
    const form = formByIndex[idx] || "Normal";
    const formatted = formatEvolutionName(name, form);
    const canonical = canonicalByNorm[normalizeKey(formatted)];
    if (!canonical) continue;

    let cursor = idx;
    const seen = new Set();
    while (parentByIndex[cursor] != null && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentByIndex[cursor];
    }

    const baseName = nameByIndex[cursor];
    const baseForm = formByIndex[cursor] || "Normal";
    const baseFormatted = formatEvolutionName(baseName, baseForm);
    const baseCanonical = canonicalByNorm[normalizeKey(baseFormatted)] || canonical;

    baseByName[normalizeKey(canonical)] = baseCanonical;
  }

  const ordered = {};
  for (const key of Object.keys(baseByName).sort()) {
    ordered[key] = baseByName[key];
  }
  const output = { base_by_name: ordered };
  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`[evolutions] wrote ${Object.keys(baseByName).length} entries to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
