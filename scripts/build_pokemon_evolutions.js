#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { normalizeKey } from "../shared/pokename_utils.js";

const EVOLUTION_URL = "https://coldsp33d.github.io/data/pokemon_evolution.json";
const SPECIES_URL = "https://pokeapi.co/api/v2/pokemon-species/";
const POKEDEX_PATH = path.resolve("data/pokedex_map.json");
const OUT_PATH = path.resolve("data/pokemon_evolutions.json");

function formatEvolutionName(name, form) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "";
  if (!form || form === "Normal") return trimmed;
  return `${trimmed} (${form})`;
}

function normalizeEvolutionKey(raw) {
  return normalizeKey(String(raw || "").replace(/\u2640/g, "f").replace(/\u2642/g, "m"));
}

function canonicalizeName(raw, canonicalByNorm) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) return null;
  const withGender = cleaned.replace(/\u2640/g, "F").replace(/\u2642/g, "M");
  const noForm = cleaned.replace(/\s*\([^)]*\)/g, "").trim();
  const withGenderNoForm = withGender.replace(/\s*\([^)]*\)/g, "").trim();
  const hyphen = cleaned.replace(/-/g, " ");
  const hyphenNoForm = hyphen.replace(/\s*\([^)]*\)/g, "").trim();
  const candidates = [
    cleaned,
    withGender,
    hyphen,
    noForm,
    withGenderNoForm,
    hyphenNoForm,
  ];

  for (const candidate of candidates) {
    const norm = normalizeKey(candidate);
    const canonical = canonicalByNorm[norm];
    if (canonical) return canonical;
  }

  return null;
}

function stripForm(name) {
  return String(name || "").replace(/\s*\([^)]*\)/g, "").trim();
}

function coerceBaseNameForForm(sourceName, baseName, canonicalByNorm) {
  if (!sourceName || !baseName) return baseName;
  const sourceFormMatch = String(sourceName).match(/\(([^)]+)\)/);
  const sourceFormRaw = sourceFormMatch ? sourceFormMatch[1] : "";
  const sourceFormLower = sourceFormRaw.toLowerCase();
  const sourceSpecies = normalizeKey(stripForm(sourceName));
  const baseSpecies = normalizeKey(stripForm(baseName));

  if (sourceFormLower.includes("mega")) {
    const speciesName = stripForm(sourceName);
    if (sourceSpecies && baseSpecies && sourceSpecies !== baseSpecies) {
      return baseName;
    }
    return canonicalizeName(speciesName, canonicalByNorm) || baseName;
  }

  if (sourceFormRaw && sourceSpecies && baseSpecies && sourceSpecies !== baseSpecies) {
    let formLabel = null;
    if (/(alola|alolan)/i.test(sourceFormRaw)) formLabel = "Alola";
    else if (/(galar|galarian)/i.test(sourceFormRaw)) formLabel = "Galar";
    else if (/(hisui|hisuian)/i.test(sourceFormRaw)) formLabel = "Hisui";
    else if (/(paldea|paldean)/i.test(sourceFormRaw)) formLabel = "Paldea";
    if (formLabel) {
      const baseWithForm = `${stripForm(baseName)} (${formLabel})`;
      return canonicalizeName(baseWithForm, canonicalByNorm) || baseName;
    }
  }

  if (sourceSpecies && baseSpecies && sourceSpecies === baseSpecies) {
    if (sourceFormRaw) {
      return canonicalizeName(sourceName, canonicalByNorm) || baseName;
    }
    const speciesName = stripForm(sourceName);
    return canonicalizeName(speciesName, canonicalByNorm) || baseName;
  }

  return baseName;
}

function buildEvolutionIndex(data) {
  const names = data?.pokemon_name || {};
  const forms = data?.form || {};
  const evolutions = data?.evolutions || {};
  const nameIndex = {};
  const parentByIndex = {};
  const nameByIndex = {};
  const formByIndex = {};

  const setNameIndex = (key, idx) => {
    if (!key) return;
    if (nameIndex[key] == null) nameIndex[key] = String(idx);
  };

  for (const [idx, name] of Object.entries(names)) {
    nameByIndex[idx] = name;
    const form = forms?.[idx] || "Normal";
    formByIndex[idx] = form;

    setNameIndex(normalizeEvolutionKey(name), idx);
    if (form && form !== "Normal") {
      setNameIndex(normalizeEvolutionKey(`${name} (${form})`), idx);
    }
  }

  for (const [parentIdx, list] of Object.entries(evolutions)) {
    if (!Array.isArray(list)) continue;
    for (const evo of list) {
      const childName = evo?.pokemon_name;
      if (!childName) continue;
      const childForm = evo?.form || "Normal";
      const key = normalizeEvolutionKey(
        childForm && childForm !== "Normal" ? `${childName} (${childForm})` : childName
      );
      const childIdx = nameIndex[key];
      if (childIdx != null && parentByIndex[childIdx] == null) {
        parentByIndex[childIdx] = String(parentIdx);
      }
    }
  }

  return { nameIndex, parentByIndex, nameByIndex, formByIndex };
}

function buildEvolutionLookupCandidates(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const noMega = raw.replace(/\s*\(mega[^)]*\)/gi, "").trim();
  const noForm = raw.replace(/\s*\([^)]*\)/g, "").trim();
  return Array.from(new Set([raw, noMega, noForm].filter(Boolean)));
}

function resolveBaseNameFromIndex(name, index) {
  const candidates = buildEvolutionLookupCandidates(name);
  let idx = null;
  for (const candidate of candidates) {
    const key = normalizeEvolutionKey(candidate);
    if (index.nameIndex[key] != null) {
      idx = index.nameIndex[key];
      break;
    }
  }
  if (idx == null) return null;

  const visited = new Set();
  while (index.parentByIndex[idx] && !visited.has(idx)) {
    visited.add(idx);
    idx = index.parentByIndex[idx];
  }

  const baseName = index.nameByIndex[idx] || "";
  const form = index.formByIndex[idx] || "Normal";
  return formatEvolutionName(baseName, form);
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
  const index = buildEvolutionIndex(data);

  const baseByName = {};
  const unresolvedById = new Map();
  for (const [name, keyRaw] of Object.entries(pokedexRaw)) {
    const key = String(name).toLowerCase();
    if (TPPC_BREEDING_OVERRIDES[key]) {
      baseByName[key] = TPPC_BREEDING_OVERRIDES[key];
      continue;
    }
    if (MANUAL_BASE_OVERRIDES[key]) {
      baseByName[key] = MANUAL_BASE_OVERRIDES[key];
      continue;
    }
    const resolved = resolveBaseNameFromIndex(name, index);
    let baseName = resolved;
    if (resolved) {
      baseName = canonicalizeName(baseName, canonicalByNorm) || baseName;
      baseName = coerceBaseNameForForm(name, baseName, canonicalByNorm);
    } else {
      baseName = name;
      const id = Number(String(keyRaw).split("-")[0]);
      if (Number.isFinite(id)) {
        if (!unresolvedById.has(id)) unresolvedById.set(id, []);
        unresolvedById.get(id).push(name);
      }
    }
    baseByName[key] = baseName;
  }

  const baseById = {};
  const chainCache = new Map();
  const missingIds = [...unresolvedById.keys()];
  let resolvedFromApi = 0;
  for (const id of missingIds) {
    try {
      const res = await fetch(`${SPECIES_URL}${id}/`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const species = await res.json();
      const chainUrl = species?.evolution_chain?.url;
      if (!chainUrl) throw new Error("Missing evolution chain");
      let baseName = chainCache.get(chainUrl);
      if (!baseName) {
        const chainRes = await fetch(chainUrl);
        if (!chainRes.ok) throw new Error(`Chain HTTP ${chainRes.status}`);
        const chain = await chainRes.json();
        baseName = chain?.chain?.species?.name || "";
        if (baseName) chainCache.set(chainUrl, baseName);
      }
      if (!baseName) throw new Error("Missing base species");
      const canonical = canonicalizeName(baseName, canonicalByNorm);
      if (canonical) {
        baseById[id] = canonical;
        resolvedFromApi += 1;
      }
    } catch (err) {
      console.warn(`[evolutions] failed to resolve id ${id}: ${err?.message || err}`);
    }
  }

  if (resolvedFromApi) {
    for (const [id, names] of unresolvedById.entries()) {
      const base = baseById[id];
      if (!base) continue;
      for (const name of names) {
        const adjusted = coerceBaseNameForForm(name, base, canonicalByNorm);
        baseByName[String(name).toLowerCase()] = adjusted;
      }
    }
  }

  const ordered = {};
  for (const key of Object.keys(baseByName).sort()) {
    ordered[key] = baseByName[key];
  }
  const output = { base_by_name: ordered };
  await fs.writeFile(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`[evolutions] wrote ${Object.keys(baseByName).length} entries to ${OUT_PATH}`);
  if (unresolvedById.size) {
    console.log(`[evolutions] unresolved ids from source: ${unresolvedById.size}`);
    console.log(`[evolutions] resolved via PokeAPI: ${resolvedFromApi}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
const MANUAL_BASE_OVERRIDES = {
  "arceus (dragon)": "Arceus (Dragon)",
  "arceus (electric)": "Arceus (Electric)",
  "arceus (fairy)": "Arceus (Fairy)",
  "arceus (fighting)": "Arceus (Fighting)",
  "arceus (flying)": "Arceus (Flying)",
  "arceus (ghost)": "Arceus (Ghost)",
  "arceus (ground)": "Arceus (Ground)",
  "arceus (normal)": "Arceus (Normal)",
  basculegion: "Basculin (Blue-Striped)",
  "basculin (blue-striped)": "Basculin (Blue-Striped)",
  "basculin (red-striped)": "Basculin (Red-Striped)",
  "eiscue (ice)": "Eiscue (Ice)",
  "eiscue (noice)": "Eiscue (Noice)",
  "gastrodon (east sea)": "Shellos (East Sea)",
  "gastrodon (west sea)": "Shellos (West Sea)",
  "giratina (altered)": "Giratina (Altered)",
  "giratina (origin)": "Giratina (Origin)",
  "gourgeist (average)": "Pumpkaboo (Average)",
  "gourgeist (large)": "Pumpkaboo (Large)",
  "gourgeist (small)": "Pumpkaboo (Small)",
  "gourgeist (super)": "Pumpkaboo (Super)",
  "goodra (hisui)": "Goomy",
  "hoopa (confined)": "Hoopa (Confined)",
  "hoopa (unbound)": "Hoopa (Unbound)",
  "morpeko (full belly)": "Morpeko (Full Belly)",
  "morpeko (hangry)": "Morpeko (Hangry)",
  mothim: "Burmy (Plant)",
  perrserker: "Meowth (Galar)",
  "slowbro (mega)": "Slowpoke",
  sirfetchd: "Farfetchd (Galar)",
  sneasler: "Sneasel (Hisui)",
  cursola: "Corsola (Galar)",
  obstagoon: "Zigzagoon (Galar)",
  runerigus: "Yamask (Galar)",
  "sliggoo (hisui)": "Goomy",
  "articuno (galar)": "Articuno (Galar)",
  "moltres (galar)": "Moltres (Galar)",
  "zapdos (galar)": "Zapdos (Galar)",
  "oricorio (baile)": "Oricorio (Baile)",
  "oricorio (pa'u)": "Oricorio (Pa'u)",
  "oricorio (pom-pom)": "Oricorio (Pom-Pom)",
  "oricorio (sensu)": "Oricorio (Sensu)",
  "sawsbuck (autumn)": "Deerling (Autumn)",
  "sawsbuck (spring)": "Deerling (Spring)",
  "sawsbuck (summer)": "Deerling (Summer)",
  "sawsbuck (winter)": "Deerling (Winter)",
  "wormadam (plant)": "Burmy (Plant)",
  "wormadam (sandy)": "Burmy (Sandy)",
  "wormadam (trash)": "Burmy (Trash)",
  "zacian (crowned)": "Zacian (Crowned)",
  "zacian (hero)": "Zacian (Hero)",
  "zamazenta (crowned)": "Zamazenta (Crowned)",
  "zamazenta (hero)": "Zamazenta (Hero)",
  "zygarde (10%)": "Zygarde (10%)",
  "zygarde (50%)": "Zygarde (50%)",
  "zygarde (complete)": "Zygarde (Complete)",
};

const TPPC_BREEDING_OVERRIDES = {
  chimecho: "Chimecho",
  chansey: "Chansey",
  blissey: "Chansey",
  "mr. mime": "Mr. Mime",
  mrmime: "Mr. Mime",
  mrrime: "Mr. Mime",
  mantine: "Mantine",
};
