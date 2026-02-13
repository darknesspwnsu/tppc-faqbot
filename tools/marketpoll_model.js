// tools/marketpoll_model.js
//
// Pure model/helpers for MarketPoll: parsing, tiering, matching, and scoring.

import { normalizeKey } from "../shared/pokename_utils.js";

const RATE_MULTIPLIERS = {
  x: 1,
  k: 1_000,
  kx: 1_000,
  m: 1_000_000,
  mx: 1_000_000,
};

export const GOLDMARKET_TIERS = [
  { id: "1-5kx", label: "1-5kx", min: 1_000, max: 5_000 },
  { id: "5-10kx", label: "5-10kx", min: 5_000, max: 10_000 },
  { id: "10-20kx", label: "10-20kx", min: 10_000, max: 20_000 },
  { id: "20-40kx", label: "20-40kx", min: 20_000, max: 40_000 },
  { id: "40-100kx", label: "40-100kx", min: 40_000, max: 100_000 },
  { id: "100-200kx", label: "100-200kx", min: 100_000, max: 200_000 },
  { id: "200-500kx", label: "200-500kx", min: 200_000, max: 500_000 },
  { id: "500-1000kx", label: "500-1000kx", min: 500_000, max: 1_000_000 },
  { id: "1mx-2mx", label: "1mx-2mx", min: 1_000_000, max: 2_000_000 },
  { id: "2mx-3mx", label: "2mx-3mx", min: 2_000_000, max: 3_000_000 },
  { id: "3mx+", label: "3mx+", min: 3_000_000, max: null },
];

function trimTrailingZeros(n) {
  return String(Number(n.toFixed(4)));
}

export function formatX(valueX) {
  const n = Number(valueX);
  if (!Number.isFinite(n)) return "0x";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimTrailingZeros(n / 1_000_000)}mx`;
  if (abs >= 1_000) return `${trimTrailingZeros(n / 1_000)}kx`;
  return `${trimTrailingZeros(n)}x`;
}

function parseCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuote = true;
      continue;
    }

    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur.trim());
  return out;
}

function normalizeGoldenName(nameRaw) {
  const raw = String(nameRaw || "").trim();
  if (!raw) return "";
  if (/^golden\s+/i.test(raw)) {
    return raw.replace(/^golden\s+/i, "Golden").replace(/\s+/g, " ").trim();
  }
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeGender(genderRaw) {
  const g = String(genderRaw || "").trim().toUpperCase();
  return ["M", "F", "?", "G"].includes(g) ? g : "";
}

export function normalizeAssetKey(assetKeyRaw) {
  const raw = String(assetKeyRaw || "").trim();
  if (!raw) return "";

  const parts = raw.split("|");
  if (parts.length !== 2) return "";

  const name = normalizeGoldenName(parts[0]);
  const gender = normalizeGender(parts[1]);
  if (!name || !gender) return "";

  return `${name}|${gender}`;
}

export function parseRateToken(raw, { fallbackMultiplier = null } = {}) {
  const token = String(raw || "").trim().toLowerCase();
  const m = token.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/i);
  if (!m) {
    return { ok: false, error: `Invalid rate token: ${raw}` };
  }

  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: `Invalid numeric amount: ${raw}` };
  }

  const unitRaw = String(m[2] || "").toLowerCase();
  if (!unitRaw) {
    if (!Number.isFinite(fallbackMultiplier)) {
      return { ok: false, needsUnit: true, amount };
    }
    return { ok: true, valueX: amount * fallbackMultiplier, multiplier: fallbackMultiplier };
  }

  const multiplier = RATE_MULTIPLIERS[unitRaw] ?? null;
  if (!Number.isFinite(multiplier)) {
    return { ok: false, error: `Unknown unit in rate token: ${raw}` };
  }

  return { ok: true, valueX: amount * multiplier, multiplier };
}

export function tierForMidX(midX) {
  const val = Number(midX);
  for (let i = 0; i < GOLDMARKET_TIERS.length; i += 1) {
    const tier = GOLDMARKET_TIERS[i];
    if (val < tier.min) continue;
    if (tier.max !== null && val >= tier.max) continue;
    return { ...tier, index: i };
  }
  const last = GOLDMARKET_TIERS[GOLDMARKET_TIERS.length - 1];
  return { ...last, index: GOLDMARKET_TIERS.length - 1 };
}

export function parseSeedRange(seedRangeRaw) {
  const raw = String(seedRangeRaw || "").trim();
  if (!raw) {
    return { ok: false, error: "Range cannot be empty." };
  }

  const parts = raw.split("-").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    return { ok: false, error: `Range must be "min-max": ${raw}` };
  }

  if (parts.length === 1) {
    // Single-value seed is allowed and interpreted as min=max.
    const single = parseRateToken(parts[0], { fallbackMultiplier: 1 });
    if (!single.ok) return single;

    const minX = Number(single.valueX);
    const maxX = Number(single.valueX);
    const midX = minX;
    const tier = tierForMidX(midX);

    return {
      ok: true,
      minX,
      maxX,
      midX,
      tierId: tier.id,
      tierLabel: tier.label,
      tierIndex: tier.index,
    };
  }

  let left = parseRateToken(parts[0]);
  let right = parseRateToken(parts[1]);

  if (!left.ok && !left.needsUnit) return left;
  if (!right.ok && !right.needsUnit) return right;

  if (left.needsUnit && right.needsUnit) {
    // If both units are omitted, default to raw x-values.
    left = parseRateToken(parts[0], { fallbackMultiplier: 1 });
    right = parseRateToken(parts[1], { fallbackMultiplier: 1 });
  }

  if (left.needsUnit) {
    left = parseRateToken(parts[0], { fallbackMultiplier: right.multiplier });
  }
  if (right.needsUnit) {
    right = parseRateToken(parts[1], { fallbackMultiplier: left.multiplier });
  }

  if (!left.ok) return left;
  if (!right.ok) return right;

  const minX = Number(left.valueX);
  const maxX = Number(right.valueX);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { ok: false, error: `Could not parse range: ${raw}` };
  }
  if (minX > maxX) {
    return { ok: false, error: `Range min is greater than max: ${raw}` };
  }

  const midX = (minX + maxX) / 2;
  const tier = tierForMidX(midX);

  return {
    ok: true,
    minX,
    maxX,
    midX,
    tierId: tier.id,
    tierLabel: tier.label,
    tierIndex: tier.index,
  };
}

export function parseGoldenGenderCsv(csvText) {
  const rows = [];
  const lines = String(csvText || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = String(raw || "").trim();
    if (!line || line.startsWith("#")) continue;
    if (/^name\s*,\s*genders\b/i.test(line)) continue;

    const cols = parseCsvRow(line);
    if (cols.length < 2) continue;

    const name = normalizeGoldenName(cols[0]);
    const genders = String(cols[1] || "")
      .split("/")
      .map((x) => normalizeGender(x))
      .filter(Boolean);

    if (!name || !genders.length) continue;
    rows.push({ name, genders: [...new Set(genders)] });
  }

  return rows;
}

export function buildAssetUniverse({ goldenGenderCsv, evolutionData }) {
  const parsed = parseGoldenGenderCsv(goldenGenderCsv);
  const baseByName = evolutionData?.base_by_name || {};

  const allAssetsByKey = new Map();
  const eligibleAssetsByKey = new Map();

  for (const row of parsed) {
    const bareName = row.name.replace(/^golden\s*/i, "").trim();
    const nameKey = bareName.toLowerCase();
    const baseName = String(baseByName[nameKey] || bareName);
    const isBase = baseName.toLowerCase() === nameKey;

    for (const gender of row.genders) {
      const assetKey = `${row.name}|${gender}`;
      const entry = {
        assetKey,
        name: row.name,
        bareName,
        gender,
        baseName,
        isBase,
        normalizedName: normalizeKey(row.name),
        normalizedBareName: normalizeKey(bareName),
      };
      allAssetsByKey.set(assetKey, entry);
      if (isBase) {
        eligibleAssetsByKey.set(assetKey, entry);
      }
    }
  }

  return {
    allAssetsByKey,
    eligibleAssetsByKey,
    eligibleAssets: Array.from(eligibleAssetsByKey.values()),
  };
}

export function parseSeedCsv(seedCsvText, { assetUniverse }) {
  const rows = [];
  const errors = [];
  const seen = new Set();

  const lines = String(seedCsvText || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const line = String(rawLine || "").trim();

    if (!line || line.startsWith("#")) continue;
    if (/^asset_key\s*,\s*seed_range\b/i.test(line)) continue;

    const cols = parseCsvRow(rawLine);
    if (cols.length < 2) {
      errors.push(`line ${lineNo}: expected 2 columns (asset_key,seed_range)`);
      continue;
    }

    const assetKey = normalizeAssetKey(cols[0]);
    const rangeRaw = String(cols[1] || "").trim();

    if (!assetKey) {
      errors.push(`line ${lineNo}: invalid asset_key`);
      continue;
    }

    // Allow partial seed files: blank ranges are treated as unseeded rows.
    if (!rangeRaw) continue;

    if (seen.has(assetKey)) {
      errors.push(`line ${lineNo}: duplicate asset_key ${assetKey}`);
      continue;
    }
    seen.add(assetKey);

    const known = assetUniverse?.allAssetsByKey?.get(assetKey) || null;
    if (!known) {
      errors.push(`line ${lineNo}: unknown asset ${assetKey}`);
      continue;
    }

    if (!known.isBase) {
      errors.push(
        `line ${lineNo}: evolved asset not allowed (${assetKey}); base is ${known.baseName}`
      );
      continue;
    }

    const parsedRange = parseSeedRange(rangeRaw);
    if (!parsedRange.ok) {
      errors.push(`line ${lineNo}: ${parsedRange.error}`);
      continue;
    }

    rows.push({
      assetKey,
      name: known.name,
      bareName: known.bareName,
      gender: known.gender,
      normalizedName: known.normalizedName,
      normalizedBareName: known.normalizedBareName,
      ...parsedRange,
    });
  }

  rows.sort((a, b) => a.assetKey.localeCompare(b.assetKey));

  if (!rows.length && !errors.length) {
    errors.push("No seed rows found in seed file.");
  }

  return { rows, errors };
}

function asMapLike(cooldowns) {
  if (cooldowns instanceof Map) {
    return {
      get: (key) => Number(cooldowns.get(key) || 0),
    };
  }
  const obj = cooldowns || {};
  return {
    get: (key) => Number(obj[key] || 0),
  };
}

function toBundleList(assetOrAssets) {
  if (Array.isArray(assetOrAssets)) {
    return assetOrAssets.map((x) => String(x || "").trim()).filter(Boolean);
  }
  const one = String(assetOrAssets || "").trim();
  return one ? [one] : [];
}

function uniqSortedStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function bundleFromKeys(keys, byKey) {
  const assetKeys = uniqSortedStrings(keys);
  if (!assetKeys.length) return null;

  const assets = assetKeys.map((k) => byKey.get(k)).filter(Boolean);
  if (assets.length !== assetKeys.length) return null;

  const minX = assets.reduce((sum, a) => sum + Number(a.minX || 0), 0);
  const maxX = assets.reduce((sum, a) => sum + Number(a.maxX || 0), 0);
  const midX = assets.reduce((sum, a) => sum + Number(a.midX || 0), 0);
  const tier = tierForMidX(midX);
  const genderSet = new Set(assets.map((a) => String(a.gender || "")));
  const gender = genderSet.size === 1 ? assets[0].gender : "";

  return {
    assetKeys,
    key: assetKeys.join(" + "),
    assets,
    minX,
    maxX,
    midX,
    tierId: tier.id,
    tierIndex: tier.index,
    gender,
  };
}

function sampleUniqueAssetKeys(keys, count, rng = Math.random, blocked = new Set()) {
  const need = Math.max(1, Number(count) || 1);
  const pool = keys.filter((k) => !blocked.has(k));
  if (pool.length < need) return null;

  const chosen = new Set();
  let guard = 0;
  while (chosen.size < need && guard < need * 20) {
    const r = Number(rng());
    const idx = Math.floor((Number.isFinite(r) ? Math.abs(r) : 0) * pool.length) % pool.length;
    chosen.add(pool[idx]);
    guard += 1;
  }

  if (chosen.size < need) {
    for (const k of pool) {
      chosen.add(k);
      if (chosen.size >= need) break;
    }
  }

  if (chosen.size < need) return null;
  return [...chosen].slice(0, need).sort((a, b) => a.localeCompare(b));
}

export function canonicalBundleKey(assetOrAssets) {
  const keys = uniqSortedStrings(toBundleList(assetOrAssets));
  return keys.join(" + ");
}

export function canonicalPairKey(assetA, assetB) {
  const [a, b] = [canonicalBundleKey(assetA), canonicalBundleKey(assetB)].sort((x, y) => x.localeCompare(y));
  return `${a}||${b}`;
}

function rangesOverlap(a, b) {
  return Math.min(Number(a.maxX), Number(b.maxX)) > Math.max(Number(a.minX), Number(b.minX));
}

export function selectCandidatePair({
  assets,
  cooldowns,
  openPairKeys,
  nowMs = Date.now(),
  preferSameGender = true,
  rng = Math.random,
}) {
  const seeded = Array.isArray(assets) ? assets : [];
  const open = openPairKeys instanceof Set ? openPairKeys : new Set(openPairKeys || []);
  const cd = asMapLike(cooldowns);

  const sameGender = [];
  const mixedGender = [];

  for (let i = 0; i < seeded.length; i += 1) {
    const a = seeded[i];
    for (let j = i + 1; j < seeded.length; j += 1) {
      const b = seeded[j];
      if (!a || !b) continue;
      if (a.assetKey === b.assetKey) continue;

      const pairKey = canonicalPairKey(a.assetKey, b.assetKey);
      if (open.has(pairKey)) continue;

      const nextEligibleAtMs = cd.get(pairKey);
      if (Number.isFinite(nextEligibleAtMs) && nextEligibleAtMs > nowMs) continue;

      const tierDiff = Math.abs(Number(a.tierIndex) - Number(b.tierIndex));
      if (tierDiff > 1) continue;
      if (tierDiff === 1 && !rangesOverlap(a, b)) continue;

      const entry = { left: a, right: b, pairKey };
      if (a.gender === b.gender) sameGender.push(entry);
      else mixedGender.push(entry);
    }
  }

  let pool = [];
  let usedFallbackGender = false;
  if (preferSameGender && sameGender.length) {
    pool = sameGender;
  } else {
    pool = [...sameGender, ...mixedGender];
    usedFallbackGender = preferSameGender && !sameGender.length && pool.length > 0;
  }

  if (!pool.length) return null;

  const pick = pool[Math.floor(Math.max(0, rng()) * pool.length) % pool.length];
  return {
    ...pick,
    usedFallbackGender,
  };
}

export function selectCandidateMatchup({
  assets,
  cooldowns,
  openPairKeys,
  nowMs = Date.now(),
  preferSameGender = true,
  maxSideSize = 2,
  sideSizeOptions = [1, 2],
  rng = Math.random,
  maxAttempts = 1500,
}) {
  const seeded = Array.isArray(assets) ? assets : [];
  if (seeded.length < 2) return null;

  const byKey = new Map(seeded.map((a) => [String(a.assetKey), a]));
  const allKeys = [...byKey.keys()];

  const open = openPairKeys instanceof Set ? openPairKeys : new Set(openPairKeys || []);
  const cd = asMapLike(cooldowns);
  const sizes = [...new Set((Array.isArray(sideSizeOptions) ? sideSizeOptions : [1]).map((n) => Math.trunc(Number(n))))]
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= Math.max(1, Number(maxSideSize) || 1));
  if (!sizes.length) return null;

  let usedFallbackGender = false;
  const passes = preferSameGender ? [true, false] : [false];

  for (const strictGender of passes) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const lr = Number(rng());
      const rr = Number(rng());
      const leftSize = sizes[Math.floor((Number.isFinite(lr) ? Math.abs(lr) : 0) * sizes.length) % sizes.length];
      const rightSize = sizes[Math.floor((Number.isFinite(rr) ? Math.abs(rr) : 0) * sizes.length) % sizes.length];

      const leftKeys = sampleUniqueAssetKeys(allKeys, leftSize, rng);
      if (!leftKeys) continue;
      const rightKeys = sampleUniqueAssetKeys(allKeys, rightSize, rng, new Set(leftKeys));
      if (!rightKeys) continue;

      const left = bundleFromKeys(leftKeys, byKey);
      const right = bundleFromKeys(rightKeys, byKey);
      if (!left || !right) continue;
      if (left.key === right.key) continue;

      if (strictGender) {
        if (!left.gender || !right.gender) continue;
        if (left.gender !== right.gender) continue;
      }

      const tierDiff = Math.abs(Number(left.tierIndex) - Number(right.tierIndex));
      if (tierDiff > 1) continue;
      if (tierDiff === 1 && !rangesOverlap(left, right)) continue;

      const pairKey = canonicalPairKey(left.assetKeys, right.assetKeys);
      if (open.has(pairKey)) continue;

      const nextEligibleAtMs = cd.get(pairKey);
      if (Number.isFinite(nextEligibleAtMs) && nextEligibleAtMs > nowMs) continue;

      return {
        left,
        right,
        pairKey,
        usedFallbackGender,
      };
    }
    if (strictGender) usedFallbackGender = true;
  }

  return null;
}

export function applyEloFromVotes({
  leftScore,
  rightScore,
  votesLeft,
  votesRight,
  minVotes = 5,
}) {
  const lScore = Number.isFinite(Number(leftScore)) ? Number(leftScore) : 1500;
  const rScore = Number.isFinite(Number(rightScore)) ? Number(rightScore) : 1500;
  const leftVotes = Math.max(0, Number(votesLeft) || 0);
  const rightVotes = Math.max(0, Number(votesRight) || 0);
  const totalVotes = leftVotes + rightVotes;

  const result = leftVotes > rightVotes ? "left" : leftVotes < rightVotes ? "right" : "tie";

  if (totalVotes < Math.max(1, Number(minVotes) || 1)) {
    return {
      leftScore: lScore,
      rightScore: rScore,
      totalVotes,
      result,
      affectsScore: false,
      kFactor: 0,
    };
  }

  const expectedLeft = 1 / (1 + 10 ** ((rScore - lScore) / 400));
  const expectedRight = 1 - expectedLeft;
  const actualLeft = leftVotes / totalVotes;
  const actualRight = rightVotes / totalVotes;
  const kFactor = 24 * Math.min(2, Math.sqrt(totalVotes / 5));

  const nextLeft = Number((lScore + kFactor * (actualLeft - expectedLeft)).toFixed(4));
  const nextRight = Number((rScore + kFactor * (actualRight - expectedRight)).toFixed(4));

  return {
    leftScore: nextLeft,
    rightScore: nextRight,
    totalVotes,
    result,
    affectsScore: true,
    kFactor,
  };
}

function scoreToQ(score) {
  const s = Number.isFinite(Number(score)) ? Number(score) : 1500;
  return 10 ** (s / 400);
}

export function applyEloFromVotesBundles({
  leftScores,
  rightScores,
  votesLeft,
  votesRight,
  minVotes = 5,
}) {
  const leftList = (Array.isArray(leftScores) ? leftScores : []).map((s) =>
    Number.isFinite(Number(s)) ? Number(s) : 1500
  );
  const rightList = (Array.isArray(rightScores) ? rightScores : []).map((s) =>
    Number.isFinite(Number(s)) ? Number(s) : 1500
  );

  const safeLeft = leftList.length ? leftList : [1500];
  const safeRight = rightList.length ? rightList : [1500];

  const leftQ = safeLeft.map(scoreToQ);
  const rightQ = safeRight.map(scoreToQ);
  const leftQSum = leftQ.reduce((a, b) => a + b, 0);
  const rightQSum = rightQ.reduce((a, b) => a + b, 0);

  const leftTeamScore = 400 * Math.log10(leftQSum);
  const rightTeamScore = 400 * Math.log10(rightQSum);

  const team = applyEloFromVotes({
    leftScore: leftTeamScore,
    rightScore: rightTeamScore,
    votesLeft,
    votesRight,
    minVotes,
  });

  if (!team.affectsScore) {
    return {
      ...team,
      leftScores: safeLeft,
      rightScores: safeRight,
      leftTeamScore: Number(leftTeamScore.toFixed(4)),
      rightTeamScore: Number(rightTeamScore.toFixed(4)),
    };
  }

  const leftTeamDelta = Number(team.leftScore) - leftTeamScore;
  const rightTeamDelta = Number(team.rightScore) - rightTeamScore;

  const nextLeft = safeLeft.map((s, i) => Number((s + leftTeamDelta * (leftQ[i] / leftQSum)).toFixed(4)));
  const nextRight = safeRight.map((s, i) => Number((s + rightTeamDelta * (rightQ[i] / rightQSum)).toFixed(4)));

  return {
    ...team,
    leftScores: nextLeft,
    rightScores: nextRight,
    leftTeamScore: Number(leftTeamScore.toFixed(4)),
    rightTeamScore: Number(rightTeamScore.toFixed(4)),
  };
}

export function resolveAssetQuery({ rows, queryName, gender }) {
  const list = Array.isArray(rows) ? rows : [];
  const qRaw = String(queryName || "").trim();
  const g = normalizeGender(gender);

  if (!qRaw) return { asset: null, matches: [] };

  const direct = normalizeAssetKey(qRaw);
  if (direct) {
    const hit = list.find((row) => row.assetKey === direct) || null;
    return { asset: hit, matches: hit ? [hit] : [] };
  }

  const qNorm = normalizeKey(qRaw);
  const withGoldenNorm = normalizeKey(/^golden/i.test(qRaw) ? qRaw : `Golden${qRaw}`);
  let matches = list.filter(
    (row) =>
      row.normalizedName === qNorm ||
      row.normalizedBareName === qNorm ||
      row.normalizedName === withGoldenNorm
  );

  if (g) {
    matches = matches.filter((row) => row.gender === g);
  }

  if (!matches.length) return { asset: null, matches: [] };
  if (matches.length === 1) return { asset: matches[0], matches };
  return { asset: null, matches };
}
