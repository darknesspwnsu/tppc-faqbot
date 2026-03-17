import fs from "node:fs/promises";
import path from "node:path";

const SWAP_STATUS_PATH = path.resolve("data/swap_status.json");

let dbCache = null;
let loadFailed = false;

function stripDiacritics(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function sanitizeSwapInput(raw) {
  let out = String(raw || "").replace(/\u2642|\u2640/g, " ");
  out = out.replace(/\((?:level|lvl)\s*:?\s*\d+\)/gi, " ");
  out = out.replace(/\((?:\?|m|f|male|female|♂|♀)\)/gi, " ");
  out = out.replace(/\blevel\s*:?\s*\d+\b/gi, " ");
  out = out.replace(/\blvl\s*:?\s*\d+\b/gi, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function normalizeSwapLookupKey(raw) {
  const sanitized = stripDiacritics(sanitizeSwapInput(raw).toLowerCase());

  return sanitized
    .replace(/[’'`".,_:\-\/\\()[\]{}]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9!?]/g, "");
}

function joinMapSources(sources) {
  if (sources.length === 0) return "";
  if (sources.length === 1) return sources[0];
  if (sources.length === 2) return `${sources[0]} and ${sources[1]}`;
  return `${sources.slice(0, -1).join(", ")}, and ${sources[sources.length - 1]}`;
}

function buildNotes(entry) {
  const notes = [];

  if (!entry.currentSecretSwap && entry.formerSecretSwap) {
    notes.push("pokemon was formerly obtained via secret swap");
  }

  if (entry.currentMap) {
    const mapLabel = joinMapSources(entry.mapSources || []);
    if (mapLabel) {
      const mapWord = entry.mapSources.length === 1 ? "map" : "maps";
      notes.push(`this pokemon is obtainable via ${mapLabel} ${mapWord}`);
    } else {
      notes.push("this pokemon is obtainable via map");
    }
  }

  return notes;
}

function buildSummary(entry) {
  if (entry.currentSecretSwap && entry.currentMap) {
    return "Yes. This pokemon is currently obtainable via secret swap, and it is also obtainable via maps.";
  }

  if (entry.currentSecretSwap) {
    return "Yes. This pokemon is currently obtainable via secret swap.";
  }

  return "No. This pokemon is not currently obtainable via secret swap.";
}

function normalizeEntry(raw = {}) {
  const mapSources = Array.isArray(raw.mapSources)
    ? raw.mapSources.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  return {
    displayName: String(raw.displayName || "").trim(),
    species: String(raw.species || "").trim(),
    variant: String(raw.variant || "normal").trim(),
    currentSecretSwap: Boolean(raw.currentSecretSwap),
    formerSecretSwap: Boolean(raw.formerSecretSwap),
    currentMap: Boolean(raw.currentMap),
    mapSources,
  };
}

function normalizeDb(parsed) {
  const entriesRaw = parsed?.entries;
  if (!entriesRaw || typeof entriesRaw !== "object" || Array.isArray(entriesRaw)) {
    return { metadata: parsed?.metadata || {}, entries: {} };
  }

  const entries = {};
  for (const [rawKey, rawEntry] of Object.entries(entriesRaw)) {
    const key = normalizeSwapLookupKey(rawKey);
    if (!key) continue;
    entries[key] = normalizeEntry(rawEntry);
  }

  return {
    metadata: parsed?.metadata || {},
    entries,
  };
}

async function loadSwapStatusDb() {
  if (dbCache) return dbCache;
  if (loadFailed) return null;

  try {
    const raw = await fs.readFile(SWAP_STATUS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    dbCache = normalizeDb(parsed);
    return dbCache;
  } catch (err) {
    loadFailed = true;
    console.error("[rpg] failed to load swap status dataset:", err);
    return null;
  }
}

export function resetSwapStatusDbCache() {
  dbCache = null;
  loadFailed = false;
}

export async function lookupSwapStatus(input) {
  const cleanedInput = sanitizeSwapInput(input);
  if (!cleanedInput) {
    return {
      status: "empty",
      cleanedInput: "",
      normalizedKey: "",
      queryLabel: "",
      summary: "",
      notes: [],
    };
  }

  const normalizedKey = normalizeSwapLookupKey(cleanedInput);
  const db = await loadSwapStatusDb();
  if (!db) {
    return {
      status: "unavailable",
      cleanedInput,
      normalizedKey,
      queryLabel: cleanedInput,
      summary: "Swap status dataset is unavailable right now.",
      notes: [],
    };
  }

  if (!normalizedKey) {
    return {
      status: "not-found",
      cleanedInput,
      normalizedKey,
      queryLabel: cleanedInput,
      summary: "Pokemon not found in the swap/map dataset.",
      notes: [],
    };
  }

  const entry = db.entries[normalizedKey];
  if (!entry) {
    return {
      status: "not-found",
      cleanedInput,
      normalizedKey,
      queryLabel: cleanedInput,
      summary: "Pokemon not found in the swap/map dataset.",
      notes: [],
    };
  }

  return {
    status: "found",
    cleanedInput,
    normalizedKey,
    queryLabel: entry.displayName || cleanedInput,
    entry,
    summary: buildSummary(entry),
    notes: buildNotes(entry),
  };
}

export const __testables = {
  buildNotes,
  buildSummary,
};
