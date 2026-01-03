// shared/pokename_utils.js
//
// Shared Pokemon name normalization + suggestions.

function stripDiacritics(s) {
  // NFKD splits letters + accents; remove accent marks.
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeKey(s) {
  // Lowercase, remove diacritics, drop all non-alphanumerics.
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeQueryVariants(qRaw) {
  // Returns normalized lookup keys to try (in priority order).
  const raw = String(qRaw ?? "").trim();
  if (!raw) return [];

  const q = raw.toLowerCase().trim();
  const candidates = new Set([normalizeKey(q)]);

  // Accept s.charmander / d.charmander / g.charmander
  const mDot = q.match(/^([sdg])\.(.+)$/);
  if (mDot) {
    const letter = mDot[1];
    const rest = mDot[2].trim();
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
  }

  const parts = q.split(/\s+/).filter(Boolean);

  // Accept "s charmander" / "d charmander" / "g charmander"
  if (parts.length >= 2 && ["s", "d", "g"].includes(parts[0])) {
    const letter = parts[0];
    const rest = parts.slice(1).join(" ");
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
  }

  // Accept "shiny charmander" / "dark charmander" / "golden charmander"
  if (parts.length >= 2 && ["shiny", "dark", "golden"].includes(parts[0])) {
    candidates.add(normalizeKey(parts.join(" ")));
  }

  // Accept "gpichu" / "spichu" / "dpichu" (NO dot, NO space)
  const mStuck = q.match(/^([sdg])([a-z0-9].+)$/);
  if (mStuck && !q.includes(".") && !q.includes(" ")) {
    const letter = mStuck[1];
    const rest = mStuck[2].trim();
    const prefix = letter === "s" ? "shiny" : letter === "d" ? "dark" : "golden";
    candidates.add(normalizeKey(prefix + rest));
    candidates.add(normalizeKey(prefix + " " + rest));
  }

  return Array.from(candidates);
}

function queryVariantPrefix(qRaw) {
  const q = String(qRaw ?? "").trim().toLowerCase();

  if (q.startsWith("shiny") || q.startsWith("s.") || q.startsWith("s ")) return "shiny";
  if (q.startsWith("dark") || q.startsWith("d.") || q.startsWith("d ")) return "dark";
  if (q.startsWith("golden") || q.startsWith("g.") || q.startsWith("g ")) return "golden";

  return "";
}

function bigrams(s) {
  s = String(s);
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function diceCoeff(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const A = bigrams(a);
  const B = bigrams(b);

  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;

  for (const v of A.values()) sizeA += v;
  for (const v of B.values()) sizeB += v;

  for (const [g, av] of A.entries()) {
    const bv = B.get(g);
    if (bv) inter += Math.min(av, bv);
  }

  return (2 * inter) / (sizeA + sizeB);
}

const SUGGEST_MIN_SCORE = Number(process.env.RARITY_SUGGEST_MIN_SCORE ?? 0.55);
const SUGGEST_MAX_LEN_DIFF = Number(process.env.RARITY_SUGGEST_MAX_LEN_DIFF ?? 12);

function getSuggestionsFromIndex(normIndex, queryRaw, limit = 5, opts = {}) {
  if (!normIndex) return [];

  const qKeys = normalizeQueryVariants(queryRaw);
  if (!qKeys.length) return [];

  let pref = opts.ignoreVariantPrefix ? "" : queryVariantPrefix(queryRaw);

  // If user used "gpichu"/"spichu"/"dpichu" and it doesn't directly exist,
  // treat it as variant intent for suggestions.
  if (!pref && !opts.ignoreVariantPrefix) {
    const q = String(queryRaw ?? "").trim().toLowerCase();
    const mStuck = q.match(/^([sdg])([a-z0-9].+)$/);
    if (mStuck && !q.includes(".") && !q.includes(" ")) {
      const directKey = normalizeKey(q);
      if (!normIndex[directKey]) {
        pref = mStuck[1] === "s" ? "shiny" : mStuck[1] === "d" ? "dark" : "golden";
      }
    }
  }

  const scored = [];
  for (const [nk, entry] of Object.entries(normIndex)) {
    if (pref) {
      if (!nk.startsWith(pref)) continue;
    } else {
      if (nk.startsWith("shiny") || nk.startsWith("dark") || nk.startsWith("golden")) {
        continue;
      }
    }

    let best = 0;
    for (const q of qKeys) {
      if (Math.abs(nk.length - q.length) > SUGGEST_MAX_LEN_DIFF) continue;
      const s = diceCoeff(q, nk);
      if (s > best) best = s;
    }

    if (best >= SUGGEST_MIN_SCORE) scored.push([best, entry.name]);
  }

  scored.sort((a, b) => b[0] - a[0]);

  const seen = new Set();
  const out = [];
  for (const [, name] of scored) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

export { normalizeKey, normalizeQueryVariants, queryVariantPrefix, getSuggestionsFromIndex };
