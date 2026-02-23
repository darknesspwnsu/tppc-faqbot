// tools/marketpoll.js
//
// MarketPoll (bang-only): base-golden seeded tiers + automated preference polls.

import fs from "node:fs/promises";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { normalizeKey } from "../shared/pokename_utils.js";
import { logger } from "../shared/logger.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { startInterval, clearTimer, startTimeout } from "../shared/timer_utils.js";
import { resolveRarityEntry } from "./rarity.js";
import {
  ensureMarketPollSettings,
  getMarketPollSettings,
  updateMarketPollSettings,
  listEnabledMarketPollSettings,
  insertMarketPollSchedulerLog,
  getLastMarketPollSchedulerRunMs,
  insertMarketPollRun,
  listDueMarketPollRuns,
  closeMarketPollRun,
  markMarketPollRunError,
  listOpenMarketPollPairKeys,
  getMarketPollCooldownMap,
  upsertMarketPollCooldown,
  getMarketPollScoresForAssets,
  upsertMarketPollScores,
  listMarketPollLeaderboard,
  listMarketPollHistory,
  countOpenMarketPolls,
  listMarketPollSeedOverrides,
  upsertMarketPollSeedOverride,
  deleteMarketPollSeedOverride,
  countMarketPollSeedOverrides,
} from "./marketpoll_store.js";
import {
  GOLDMARKET_TIERS,
  MARKETPOLL_MATCHUP_MODES,
  parseSeedCsv,
  parseSeedRange,
  normalizeAssetKey,
  buildAssetUniverse,
  selectCandidateMatchup,
  canonicalPairKey,
  applyEloFromVotesBundles,
  resolveAssetQuery,
  formatX,
  isSeedableKnownAsset,
} from "./marketpoll_model.js";

const SEED_FILE = path.resolve("data/marketpoll_seeds.csv");
const GOLDEN_GENDER_FILE = path.resolve("data/golden_pokemon_genders.csv");
const EVOLUTION_FILE = path.resolve("data/pokemon_evolutions.json");

const POLL_TICK_MS = 60_000;
const MAX_HISTORY_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 50;
const MAX_TIERS_LIMIT = 100;
const MAX_SIDE_ASSETS = 2;
const SIDE_SIZE_OPTIONS = [1, 2];
const MATCHUP_MODE_SET = new Set(MARKETPOLL_MATCHUP_MODES);
const SCORE_MODE_COUNTED = "counted";
const SCORE_MODE_EXHIBITION = "exhibition";

let clientRef = null;
let schedulerBooted = false;
let schedulerTimer = null;
let immediateTimer = null;
let tickInFlight = false;

let seedCache = {
  signature: "",
  valid: false,
  rows: [],
  errors: ["Seed cache not loaded yet."],
  universe: { allAssetsByKey: new Map(), eligibleAssetsByKey: new Map(), eligibleAssets: [] },
  loadedAtMs: 0,
};

function commandPrefix(cmd) {
  return String(cmd || "!").startsWith("?") ? "?" : "!";
}

function hasPermission(perms, flag) {
  try {
    return Boolean(perms?.has?.(flag));
  } catch {
    return false;
  }
}

function getMissingPollPermissions(channel, clientUser) {
  if (!channel || typeof channel.permissionsFor !== "function" || !clientUser) return [];

  let perms = null;
  try {
    perms = channel.permissionsFor(clientUser);
  } catch {
    perms = null;
  }
  if (!perms) return [];

  const missing = [];
  if (!hasPermission(perms, PermissionFlagsBits.ViewChannel)) missing.push("ViewChannel");

  const isThread = typeof channel.isThread === "function" ? channel.isThread() : false;
  if (isThread) {
    if (!hasPermission(perms, PermissionFlagsBits.SendMessagesInThreads)) {
      missing.push("SendMessagesInThreads");
    }
  } else if (!hasPermission(perms, PermissionFlagsBits.SendMessages)) {
    missing.push("SendMessages");
  }

  if (!hasPermission(perms, PermissionFlagsBits.SendPolls)) missing.push("SendPolls");
  return missing;
}

function summarizeSendError(err) {
  const parts = [];
  const code = Number(err?.code);
  const status = Number(err?.status);
  const raw = String(err?.rawError?.message || err?.message || "").trim();
  if (Number.isFinite(code)) parts.push(`Discord code ${code}`);
  if (Number.isFinite(status)) parts.push(`HTTP ${status}`);
  if (raw) parts.push(raw);
  return parts.join(" | ").slice(0, 240);
}

function tokenizeArgs(input) {
  const s = String(input || "").trim();
  if (!s) return [];

  const out = [];
  let cur = "";
  let quote = null;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}

function parseChannelId(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const mention = /^<#(\d+)>$/.exec(s);
  if (mention) return mention[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

function parseOnOff(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enabled"].includes(s)) return true;
  if (["off", "false", "0", "no", "disabled"].includes(s)) return false;
  return null;
}

function parsePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

function parseDurationMinutes(tokens) {
  const raw = Array.isArray(tokens) ? tokens.join(" ") : String(tokens || "");
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  const m = s.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/
  );
  if (!m) return null;

  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = String(m[2] || "m");
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) {
    return Math.round(amount * 60);
  }
  if (["d", "day", "days"].includes(unit)) {
    return Math.round(amount * 24 * 60);
  }
  return Math.round(amount);
}

function normalizeMatchupModes(rawModes) {
  const raw = Array.isArray(rawModes) ? rawModes : String(rawModes || "").split(/[,\s]+/);
  const deduped = [...new Set(raw.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
  const valid = deduped.filter((x) => MATCHUP_MODE_SET.has(x));
  if (!valid.length) return ["1v1"];
  return valid.sort(
    (a, b) => MARKETPOLL_MATCHUP_MODES.indexOf(a) - MARKETPOLL_MATCHUP_MODES.indexOf(b)
  );
}

function parseMatchupModesInput(tokens) {
  const joined = String(Array.isArray(tokens) ? tokens.join(" ") : tokens || "").trim().toLowerCase();
  if (!joined) {
    return {
      ok: false,
      error: "Usage: `!marketpoll config matchups <1v1,1v2,2v1,2v2|all|default>`",
    };
  }

  const parts = joined.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.includes("all")) {
    return { ok: true, modes: [...MARKETPOLL_MATCHUP_MODES] };
  }
  if (parts.includes("default") || parts.includes("reset")) {
    return { ok: true, modes: ["1v1"] };
  }

  const invalid = parts.filter((x) => !MATCHUP_MODE_SET.has(x));
  if (invalid.length) {
    return {
      ok: false,
      error: `Invalid matchup mode(s): ${invalid.join(", ")}. Allowed: ${MARKETPOLL_MATCHUP_MODES.join(", ")}.`,
    };
  }

  return { ok: true, modes: normalizeMatchupModes(parts) };
}

function genderToken(raw) {
  const rawVal = String(raw || "").trim();
  const v = rawVal === "(?)" ? "?" : rawVal.toUpperCase() === "U" ? "?" : rawVal.toUpperCase();
  return ["M", "F", "?", "G"].includes(v) ? v : "";
}

function chunkLines(lines, maxLen = 1800) {
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function replyChunked(message, lines) {
  const chunks = chunkLines(lines);
  if (!chunks.length) {
    await message.reply("(no data)");
    return;
  }

  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i += 1) {
    await message.channel.send(chunks[i]);
  }
}

function safeTierLabel(tierId) {
  const t = GOLDMARKET_TIERS.find((x) => x.id.toLowerCase() === String(tierId || "").toLowerCase());
  return t?.label || tierId;
}

function formatAssetDisplay(assetKey) {
  const [name, gender] = String(assetKey || "").split("|");
  const normalizedRaw = String(gender || "").toUpperCase();
  const normalizedGender = normalizedRaw === "?" || normalizedRaw === "U" ? "(?)" : normalizedRaw || "";
  return `${name || "Unknown"} ${normalizedGender}`.trim();
}

function normalizeAssetKeyList(keys, fallback = "") {
  const list = Array.isArray(keys) ? keys : [];
  const deduped = [...new Set(list.map((x) => String(x || "").trim()).filter(Boolean))];
  if (deduped.length) return deduped;
  const fb = String(fallback || "").trim();
  return fb ? [fb] : [];
}

function formatPollSide(assetKeys, fallback = "") {
  const keys = normalizeAssetKeyList(assetKeys, fallback);
  return keys.map((k) => formatAssetDisplay(k)).join(" + ");
}

function isGoldenPollOption(option) {
  const raw = String(option || "").trim();
  if (!raw) return false;
  const [name] = raw.split("|");
  return /^golden/i.test(String(name || "").trim());
}

function buildPollQuestionText({ leftAssetKeys, rightAssetKeys }) {
  const options = [...normalizeAssetKeyList(leftAssetKeys), ...normalizeAssetKeyList(rightAssetKeys)];
  return options.length > 0 && options.every((option) => isGoldenPollOption(option))
    ? "Which Golden do you prefer?"
    : "Which Pokemon do you prefer?";
}

function fileStatSignature(stat) {
  if (!stat) return "0:0";
  return `${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}`;
}

function toBoolean(value) {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function buildSeedRowFromOverride({ assetKey, known, parsedRange }) {
  const [name, gender] = String(assetKey || "").split("|");
  const bareName = String(name || "")
    .replace(/^golden\s*/i, "")
    .trim();

  return {
    assetKey,
    name: known?.name || name,
    bareName: known?.bareName || bareName,
    gender: known?.gender || gender,
    normalizedName: known?.normalizedName || normalizeKey(name),
    normalizedBareName: known?.normalizedBareName || normalizeKey(bareName),
    ...parsedRange,
  };
}

function applySeedOverrides({ baseRows, overrides, universe }) {
  const out = new Map((Array.isArray(baseRows) ? baseRows : []).map((row) => [row.assetKey, row]));
  const errors = [];

  for (const override of Array.isArray(overrides) ? overrides : []) {
    const assetKey = normalizeAssetKey(override?.assetKey || "");
    const rangeRaw = String(override?.seedRange || "").trim();
    const isProvisional = toBoolean(override?.isProvisional);
    if (!assetKey) {
      errors.push(`seed override has invalid asset_key: ${String(override?.assetKey || "").trim() || "(blank)"}`);
      continue;
    }

    const parsedRange = parseSeedRange(rangeRaw);
    if (!parsedRange.ok) {
      errors.push(`seed override ${assetKey}: ${parsedRange.error}`);
      continue;
    }

    const known = universe?.allAssetsByKey?.get(assetKey) || null;
    if (known && !isSeedableKnownAsset(known)) {
      errors.push(`seed override ${assetKey}: evolved asset not allowed; base is ${known.baseName}`);
      continue;
    }

    if (!known && !isProvisional) {
      errors.push(`seed override ${assetKey}: unknown asset requires provisional flag`);
      continue;
    }

    out.set(
      assetKey,
      buildSeedRowFromOverride({
        assetKey,
        known,
        parsedRange,
      })
    );
  }

  const rows = [...out.values()].sort((a, b) => a.assetKey.localeCompare(b.assetKey));
  return { rows, errors };
}

async function loadSeedState(force = false) {
  try {
    const [seedStat, goldStat, evoStat, overrideSignature] = await Promise.all([
      fs.stat(SEED_FILE),
      fs.stat(GOLDEN_GENDER_FILE),
      fs.stat(EVOLUTION_FILE),
      countMarketPollSeedOverrides(),
    ]);

    const dbSig = `${Number(overrideSignature?.total || 0)}:${Number(overrideSignature?.latestUpdatedAtMs || 0)}`;
    const signature = `${fileStatSignature(seedStat)}|${fileStatSignature(goldStat)}|${fileStatSignature(evoStat)}|${dbSig}`;
    if (!force && seedCache.signature === signature) return seedCache;

    const [seedCsv, goldenGenderCsv, evolutionJsonRaw, overrides] = await Promise.all([
      fs.readFile(SEED_FILE, "utf8"),
      fs.readFile(GOLDEN_GENDER_FILE, "utf8"),
      fs.readFile(EVOLUTION_FILE, "utf8"),
      listMarketPollSeedOverrides(),
    ]);

    const evolutionData = JSON.parse(evolutionJsonRaw);
    const universe = buildAssetUniverse({
      goldenGenderCsv,
      evolutionData,
    });

    const parsed = parseSeedCsv(seedCsv, { assetUniverse: universe });
    const merged = applySeedOverrides({
      baseRows: parsed.rows,
      overrides,
      universe,
    });
    const errors = [...parsed.errors, ...merged.errors];
    const valid = errors.length === 0;

    seedCache = {
      signature,
      valid,
      rows: merged.rows,
      errors,
      universe,
      loadedAtMs: Date.now(),
    };

    return seedCache;
  } catch (err) {
    seedCache = {
      signature: "",
      valid: false,
      rows: [],
      errors: [`Failed to load seed data: ${err?.message || String(err)}`],
      universe: { allAssetsByKey: new Map(), eligibleAssetsByKey: new Map(), eligibleAssets: [] },
      loadedAtMs: Date.now(),
    };
    return seedCache;
  }
}

function buildHelpText(prefix = "!") {
  return [
    "**MarketPoll Commands**",
    `• \`${prefix}marketpoll help\``,
    `• \`${prefix}marketpoll status\``,
    `• \`${prefix}marketpoll history [asset_or_name] [gender] [limit]\``,
    `• \`${prefix}marketpoll leaderboard [limit]\``,
    "",
    "**Admin/Privileged**",
    `• \`${prefix}marketpoll config show\``,
    `• \`${prefix}marketpoll config channel <channel_id_or_mention>\``,
    `• \`${prefix}marketpoll config enabled <on|off>\``,
    `• \`${prefix}marketpoll config cadence <hours>\``,
    `• \`${prefix}marketpoll config duration <duration>\``,
    `• \`${prefix}marketpoll config cooldown <days>\``,
    `• \`${prefix}marketpoll config minvotes <n>\``,
    `• \`${prefix}marketpoll config matchups <1v1,1v2,2v1,2v2|all|default>\``,
    `• \`${prefix}marketpoll seeds upsert <asset_key> <seed_range>\``,
    `• \`${prefix}marketpoll seeds unset <asset_key>\``,
    `• \`${prefix}marketpoll seeds get <asset_or_name> [gender]\``,
    `• \`${prefix}marketpoll tiers [tier] [gender] [limit]\``,
    `• \`${prefix}marketpoll poll now\``,
    `• \`${prefix}marketpoll poll now "<left>" vs "<right>" [counted] [force]\``,
    "",
    "Default matchup mode is `1v1`. Multi-asset modes stay off until explicitly enabled.",
    "Targeted polls default to exhibition mode (no Elo/cooldown updates).",
  ].join("\n");
}

function parseHistoryArgs(tokens) {
  const args = [...tokens];
  let limit = 10;
  let gender = "";

  if (args.length) {
    const maybeLimit = parsePositiveInt(args[args.length - 1]);
    if (maybeLimit !== null) {
      limit = Math.min(MAX_HISTORY_LIMIT, maybeLimit);
      args.pop();
    }
  }

  if (args.length) {
    const maybeGender = genderToken(args[args.length - 1]);
    if (maybeGender) {
      gender = maybeGender;
      args.pop();
    }
  }

  return {
    nameQuery: args.join(" ").trim(),
    gender,
    limit,
  };
}

function parseTiersArgs(tokens) {
  const args = [...tokens];
  let limit = 25;
  let gender = "";
  let tierId = "";

  if (args.length) {
    const maybeLimit = parsePositiveInt(args[args.length - 1]);
    if (maybeLimit !== null) {
      limit = Math.min(MAX_TIERS_LIMIT, maybeLimit);
      args.pop();
    }
  }

  if (args.length) {
    const maybeGender = genderToken(args[args.length - 1]);
    if (maybeGender) {
      gender = maybeGender;
      args.pop();
    }
  }

  if (args.length) {
    const rawTier = args.join(" ").toLowerCase();
    const found = GOLDMARKET_TIERS.find((tier) => tier.id.toLowerCase() === rawTier || tier.label.toLowerCase() === rawTier);
    if (found) tierId = found.id;
  }

  return { tierId, gender, limit };
}

function parsePollNowArgs(tokens) {
  const args = Array.isArray(tokens) ? [...tokens] : [];
  const usage =
    'Usage: `!marketpoll poll now` or `!marketpoll poll now "<left>" vs "<right>" [counted] [force]`';

  let force = false;
  let counted = false;
  while (args.length) {
    const tail = String(args[args.length - 1] || "").trim().toLowerCase();
    if (tail === "force") {
      force = true;
      args.pop();
      continue;
    }
    if (tail === "counted") {
      counted = true;
      args.pop();
      continue;
    }
    break;
  }

  if (!args.length) {
    if (force || counted) return { ok: false, error: usage };
    return { ok: true, targeted: false, scoreMode: SCORE_MODE_COUNTED, force: false };
  }

  const vsIndex = args.findIndex((x) => String(x || "").trim().toLowerCase() === "vs");
  if (vsIndex <= 0 || vsIndex >= args.length - 1) return { ok: false, error: usage };

  const leftRaw = args.slice(0, vsIndex).join(" ").trim();
  const rightRaw = args.slice(vsIndex + 1).join(" ").trim();
  if (!leftRaw || !rightRaw) return { ok: false, error: usage };

  return {
    ok: true,
    targeted: true,
    leftRaw,
    rightRaw,
    scoreMode: counted ? SCORE_MODE_COUNTED : SCORE_MODE_EXHIBITION,
    force,
  };
}

function splitPollSide(raw) {
  return String(raw || "")
    .split("+")
    .map((x) => x.trim())
    .filter(Boolean);
}

function tierIndexForMidX(midX) {
  const val = Number(midX);
  const first = GOLDMARKET_TIERS[0];
  if (!Number.isFinite(val) || val < first.min) return 0;

  for (let i = 0; i < GOLDMARKET_TIERS.length; i += 1) {
    const tier = GOLDMARKET_TIERS[i];
    if (val < tier.min) continue;
    if (tier.max !== null && val >= tier.max) continue;
    return i;
  }

  return GOLDMARKET_TIERS.length - 1;
}

function bundleFromSeedRows(seedRows) {
  const rows = Array.isArray(seedRows) ? seedRows : [];
  const minX = rows.reduce((sum, r) => sum + Number(r.minX || 0), 0);
  const maxX = rows.reduce((sum, r) => sum + Number(r.maxX || 0), 0);
  const midX = rows.reduce((sum, r) => sum + Number(r.midX || 0), 0);
  return {
    minX,
    maxX,
    midX,
    tierIndex: tierIndexForMidX(midX),
  };
}

function rangesOverlap(a, b) {
  return Math.min(Number(a.maxX), Number(b.maxX)) > Math.max(Number(a.minX), Number(b.minX));
}

async function resolveTargetedEntry({ rawEntry, seedByKey, scoreMode }) {
  const raw = String(rawEntry || "").trim();
  if (!raw) return { ok: false, error: "Poll sides cannot contain empty entries." };

  const maybeAssetKey = normalizeAssetKey(raw);
  if (maybeAssetKey) {
    const seeded = seedByKey.get(maybeAssetKey) || null;
    if (seeded) {
      return {
        ok: true,
        entry: {
          token: seeded.assetKey,
          seeded: true,
          seedRow: seeded,
          isGolden: true,
        },
      };
    }

    if (scoreMode === SCORE_MODE_COUNTED) {
      return {
        ok: false,
        error: `Counted targeted polls require seeded assets. Missing seed for \`${maybeAssetKey}\`.`,
      };
    }

    const rarity = await resolveRarityEntry(maybeAssetKey.split("|")[0]);
    if (!rarity.ok) {
      if (rarity.reason === "unavailable") {
        return {
          ok: false,
          error:
            "Rarity data is currently unavailable, so unseeded assets cannot be verified right now. Please retry shortly.",
        };
      }
      return { ok: false, error: `Could not verify unseeded asset \`${maybeAssetKey}\`.` };
    }

    return {
      ok: true,
      entry: {
        token: maybeAssetKey,
        seeded: false,
        seedRow: null,
        isGolden: /^golden/i.test(String(rarity.entry?.name || maybeAssetKey)),
      },
    };
  }

  if (scoreMode === SCORE_MODE_COUNTED) {
    return {
      ok: false,
      error: `Counted targeted polls only support seeded asset keys. Invalid entry: \`${raw}\`.`,
    };
  }

  const rarity = await resolveRarityEntry(raw);
  if (!rarity.ok) {
    if (rarity.reason === "unavailable") {
      return {
        ok: false,
        error:
          "Rarity data is currently unavailable, so plain-name entries cannot be verified right now. Please retry shortly.",
      };
    }
    return { ok: false, error: `Unknown Pokemon/asset: \`${raw}\`.` };
  }

  return {
    ok: true,
    entry: {
      token: String(rarity.entry?.name || raw),
      seeded: false,
      seedRow: null,
      isGolden: /^golden/i.test(String(rarity.entry?.name || raw)),
    },
  };
}

async function resolveTargetedSide({ raw, seedByKey, scoreMode, label }) {
  const items = splitPollSide(raw);
  if (!items.length) {
    return { ok: false, error: `${label} side is empty.` };
  }
  if (items.length > MAX_SIDE_ASSETS) {
    return { ok: false, error: `${label} side has too many entries. Maximum is ${MAX_SIDE_ASSETS}.` };
  }

  const entries = [];
  for (const rawEntry of items) {
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveTargetedEntry({ rawEntry, seedByKey, scoreMode });
    if (!resolved.ok) return resolved;
    entries.push(resolved.entry);
  }

  const unique = new Set(entries.map((e) => String(e.token || "").toLowerCase()));
  if (unique.size !== entries.length) {
    return { ok: false, error: `${label} side contains duplicate entries.` };
  }

  return {
    ok: true,
    side: {
      entries,
      assetKeys: entries.map((e) => e.token),
      seededRows: entries.map((e) => e.seedRow).filter(Boolean),
      allSeeded: entries.every((e) => e.seeded),
    },
  };
}

function validateStrictTargetedMatchup({
  left,
  right,
  pairKey,
  openPairKeys,
  cooldowns,
  nowMs,
  force = false,
}) {
  if (force) return { ok: true };
  if (!left.allSeeded || !right.allSeeded) return { ok: true };

  const tierIndexes = [...left.seededRows, ...right.seededRows]
    .map((row) => Number(row.tierIndex))
    .filter((n) => Number.isFinite(n));
  if (tierIndexes.length >= 2) {
    const spread = Math.max(...tierIndexes) - Math.min(...tierIndexes);
    if (spread > 3) {
      return { ok: false, error: "Targeted matchup rejected: asset tier spread is too large." };
    }
  }

  const leftBundle = bundleFromSeedRows(left.seededRows);
  const rightBundle = bundleFromSeedRows(right.seededRows);
  const tierDiff = Math.abs(Number(leftBundle.tierIndex) - Number(rightBundle.tierIndex));
  if (tierDiff > 1) {
    return { ok: false, error: "Targeted matchup rejected: sides are too far apart in tier." };
  }
  if (tierDiff === 1 && !rangesOverlap(leftBundle, rightBundle)) {
    return { ok: false, error: "Targeted matchup rejected: adjacent tiers must overlap in range." };
  }

  if (openPairKeys instanceof Set && openPairKeys.has(pairKey)) {
    return { ok: false, error: "Targeted matchup rejected: this pair already has an active poll." };
  }

  const nextEligibleAtMs = cooldowns instanceof Map ? Number(cooldowns.get(pairKey) || 0) : 0;
  if (Number.isFinite(nextEligibleAtMs) && nextEligibleAtMs > Number(nowMs || Date.now())) {
    return { ok: false, error: "Targeted matchup rejected: pair cooldown is still active." };
  }

  return { ok: true };
}

async function fetchAllVoters(answer) {
  const voters = new Map();
  let after = undefined;

  for (;;) {
    const batch = await answer.voters.fetch({ limit: 100, after });
    for (const user of batch.values()) {
      voters.set(String(user.id), user);
    }
    if (batch.size < 100) break;
    after = batch.last()?.id;
    if (!after) break;
  }

  return [...voters.values()];
}

function buildScoreRow(base, { elo, votesFor, votesAgainst, outcome }) {
  const row = {
    assetKey: base.assetKey,
    elo,
    wins: base.wins,
    losses: base.losses,
    ties: base.ties,
    pollsCount: base.pollsCount + 1,
    votesFor: base.votesFor + votesFor,
    votesAgainst: base.votesAgainst + votesAgainst,
    lastPollAtMs: Date.now(),
  };

  if (outcome === "win") row.wins += 1;
  if (outcome === "loss") row.losses += 1;
  if (outcome === "tie") row.ties += 1;
  return row;
}

async function finalizePollRun(run) {
  const nowMs = Date.now();
  const settings = await getMarketPollSettings({ guildId: run.guildId });

  if (!clientRef) {
    await markMarketPollRunError({ id: run.id, closedAtMs: nowMs });
    return;
  }

  try {
    const channel = await clientRef.channels.fetch(run.channelId);
    if (!channel?.isTextBased?.()) {
      await markMarketPollRunError({ id: run.id, closedAtMs: nowMs });
      return;
    }

    if (channel.messages?.endPoll) {
      try {
        await channel.messages.endPoll(run.messageId);
      } catch {}
    }

    const message = await channel.messages.fetch(run.messageId);
    const poll = message?.poll;
    const answers = [...(poll?.answers?.values?.() || [])];
    if (!poll || answers.length < 2) {
      await markMarketPollRunError({ id: run.id, closedAtMs: nowMs });
      return;
    }

    const leftVoters = await fetchAllVoters(answers[0]);
    const rightVoters = await fetchAllVoters(answers[1]);
    const votesLeft = leftVoters.length;
    const votesRight = rightVoters.length;
    const scoreMode =
      String(run.scoreMode || SCORE_MODE_COUNTED).toLowerCase() === SCORE_MODE_EXHIBITION
        ? SCORE_MODE_EXHIBITION
        : SCORE_MODE_COUNTED;

    if (scoreMode === SCORE_MODE_EXHIBITION) {
      const totalVotes = votesLeft + votesRight;
      const result = votesLeft > votesRight ? "left" : votesLeft < votesRight ? "right" : "tie";
      await closeMarketPollRun({
        id: run.id,
        votesLeft,
        votesRight,
        totalVotes,
        result,
        affectsScore: false,
        closedAtMs: nowMs,
      });
      return;
    }

    const leftAssetKeys = normalizeAssetKeyList(run.leftAssetKeys, run.leftAssetKey);
    const rightAssetKeys = normalizeAssetKeyList(run.rightAssetKeys, run.rightAssetKey);
    const allAssetKeys = [...new Set([...leftAssetKeys, ...rightAssetKeys])];

    const current = await getMarketPollScoresForAssets({
      assetKeys: allAssetKeys,
    });

    const baseFor = (assetKey) =>
      current.get(assetKey) || {
        assetKey,
        elo: 1500,
        wins: 0,
        losses: 0,
        ties: 0,
        pollsCount: 0,
        votesFor: 0,
        votesAgainst: 0,
        lastPollAtMs: 0,
      };

    const leftBaseRows = leftAssetKeys.map(baseFor);
    const rightBaseRows = rightAssetKeys.map(baseFor);

    const elo = applyEloFromVotesBundles({
      leftScores: leftBaseRows.map((x) => x.elo),
      rightScores: rightBaseRows.map((x) => x.elo),
      votesLeft,
      votesRight,
      minVotes: settings.minVotes,
    });

    const leftOutcome = elo.result === "left" ? "win" : elo.result === "right" ? "loss" : "tie";
    const rightOutcome = elo.result === "right" ? "win" : elo.result === "left" ? "loss" : "tie";

    const updates = [];
    leftBaseRows.forEach((base, idx) => {
      updates.push(
        buildScoreRow(base, {
          elo: elo.leftScores[idx] ?? base.elo,
          votesFor: votesLeft,
          votesAgainst: votesRight,
          outcome: leftOutcome,
        })
      );
    });
    rightBaseRows.forEach((base, idx) => {
      updates.push(
        buildScoreRow(base, {
          elo: elo.rightScores[idx] ?? base.elo,
          votesFor: votesRight,
          votesAgainst: votesLeft,
          outcome: rightOutcome,
        })
      );
    });

    await upsertMarketPollScores({ updates });

    const leftBundleKey = leftAssetKeys.join(" + ").slice(0, 128);
    const rightBundleKey = rightAssetKeys.join(" + ").slice(0, 128);
    const [aKey, bKey] = [leftBundleKey, rightBundleKey].sort((a, b) => a.localeCompare(b));
    await upsertMarketPollCooldown({
      pairKey: run.pairKey || canonicalPairKey(leftAssetKeys, rightAssetKeys),
      canonicalAKey: aKey,
      canonicalBKey: bKey,
      lastPolledAtMs: nowMs,
      nextEligibleAtMs: nowMs + settings.pairCooldownDays * 24 * 60 * 60_000,
    });

    await closeMarketPollRun({
      id: run.id,
      votesLeft,
      votesRight,
      totalVotes: elo.totalVotes,
      result: elo.result,
      affectsScore: elo.affectsScore,
      closedAtMs: nowMs,
    });
  } catch {
    await markMarketPollRunError({ id: run.id, closedAtMs: nowMs });
  }
}

async function processDuePollRuns() {
  const due = await listDueMarketPollRuns({ nowMs: Date.now(), limit: 30 });
  for (const run of due) {
    // Isolate each run so one failure does not block others.
    // eslint-disable-next-line no-await-in-loop
    await finalizePollRun(run);
  }
}

async function postAndTrackPoll({
  setting,
  channel,
  leftAssetKeys,
  rightAssetKeys,
  pairKey,
  scoreMode = SCORE_MODE_COUNTED,
  nowMs = Date.now(),
  reason = "manual",
  shouldLog = false,
}) {
  const questionText = buildPollQuestionText({ leftAssetKeys, rightAssetKeys });
  const pollPayload = {
    poll: {
      question: { text: questionText },
      answers: [{ text: formatPollSide(leftAssetKeys) }, { text: formatPollSide(rightAssetKeys) }],
      // Discord poll payload duration is hour-based; use a ceiling to avoid auto-closing
      // before our configured minute-based runtime closes it.
      duration: Math.max(1, Math.min(24, Math.ceil(Number(setting.pollMinutes || 1) / 60))),
      allowMultiselect: false,
    },
  };

  let pollMessage;
  try {
    pollMessage = await channel.send(pollPayload);
  } catch (err) {
    const detail = summarizeSendError(err);
    logger.warn("marketpoll.poll_send_failed", {
      guildId: setting.guildId,
      channelId: setting.channelId,
      error: logger.serializeError(err),
    });
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "error",
        reason: "send_failed",
      });
    }
    return { ok: false, reason: "send_failed", detail };
  }

  const endsAtMs = nowMs + setting.pollMinutes * 60_000;
  await insertMarketPollRun({
    guildId: setting.guildId,
    channelId: setting.channelId,
    messageId: String(pollMessage.id),
    pairKey,
    leftAssetKeys,
    rightAssetKeys,
    leftAssetKey: leftAssetKeys[0],
    rightAssetKey: rightAssetKeys[0],
    scoreMode,
    startedAtMs: nowMs,
    endsAtMs,
  });

  try {
    await channel.send(`⏰ MarketPoll poll closes in ${setting.pollMinutes} minute(s).`);
  } catch {}

  if (shouldLog) {
    await insertMarketPollSchedulerLog({
      guildId: setting.guildId,
      runAtMs: nowMs,
      status: reason === "scheduled" ? "posted" : "posted_manual",
      reason,
      pairKey,
      messageId: String(pollMessage.id),
    });
  }

  return { ok: true, messageId: String(pollMessage.id) };
}

async function postAutoPollForGuild({ setting, reason = "scheduled", shouldLog = true }) {
  const nowMs = Date.now();
  const seedState = await loadSeedState();

  if (!seedState.valid) {
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "skipped",
        reason: "seed_invalid",
      });
    }
    return { ok: false, reason: "seed_invalid" };
  }

  if (!seedState.rows.length) {
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "skipped",
        reason: "no_seed_rows",
      });
    }
    return { ok: false, reason: "no_seed_rows" };
  }

  if (!clientRef) {
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "error",
        reason: "missing_client",
      });
    }
    return { ok: false, reason: "missing_client" };
  }

  let channel;
  try {
    channel = await clientRef.channels.fetch(setting.channelId);
  } catch {
    channel = null;
  }

  if (!channel?.isTextBased?.()) {
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "error",
        reason: "invalid_channel",
      });
    }
    return { ok: false, reason: "invalid_channel" };
  }

  const missingPerms = getMissingPollPermissions(channel, clientRef.user);
  if (missingPerms.length) {
    const detail = `Missing channel permission(s): ${missingPerms.join(", ")}`;
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "error",
        reason: "missing_permissions",
      });
    }
    return { ok: false, reason: "missing_permissions", detail };
  }

  const openPairKeys = await listOpenMarketPollPairKeys({ guildId: setting.guildId });
  const cooldowns = await getMarketPollCooldownMap({ nowMs });

  const candidate = selectCandidateMatchup({
    assets: seedState.rows,
    cooldowns,
    openPairKeys,
    nowMs,
    preferSameGender: false,
    maxSideSize: MAX_SIDE_ASSETS,
    sideSizeOptions: SIDE_SIZE_OPTIONS,
    matchupModes: normalizeMatchupModes(setting.matchupModes),
  });

  if (!candidate) {
    if (shouldLog) {
      await insertMarketPollSchedulerLog({
        guildId: setting.guildId,
        runAtMs: nowMs,
        status: "skipped",
        reason: "no_eligible_pair",
      });
    }
    return { ok: false, reason: "no_eligible_pair" };
  }

  const flip = Math.random() < 0.5;
  const left = flip ? candidate.left : candidate.right;
  const right = flip ? candidate.right : candidate.left;
  const pairKey = canonicalPairKey(left.assetKeys, right.assetKeys);
  const posted = await postAndTrackPoll({
    setting,
    channel,
    leftAssetKeys: left.assetKeys,
    rightAssetKeys: right.assetKeys,
    pairKey,
    scoreMode: SCORE_MODE_COUNTED,
    nowMs,
    reason,
    shouldLog,
  });
  if (!posted.ok) return posted;
  return { ok: true, left, right, messageId: posted.messageId };
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;

  try {
    await processDuePollRuns();

    const enabled = await listEnabledMarketPollSettings();
    const nowMs = Date.now();

    for (const setting of enabled) {
      const lastRun = await getLastMarketPollSchedulerRunMs({ guildId: setting.guildId });
      const due = !Number.isFinite(lastRun) || nowMs - lastRun >= setting.cadenceMinutes * 60_000;
      if (!due) continue;

      // eslint-disable-next-line no-await-in-loop
      await postAutoPollForGuild({ setting, reason: "scheduled", shouldLog: true });
    }
  } finally {
    tickInFlight = false;
  }
}

function runSchedulerTick() {
  void schedulerTick().catch((err) => {
    logger.error("marketpoll.scheduler.tick_failed", { error: logger.serializeError(err) });
  });
}

function startScheduler(context = {}) {
  if (context.client) clientRef = context.client;
  if (schedulerBooted) return;

  schedulerBooted = true;
  schedulerTimer = startInterval({
    label: "marketpoll:scheduler",
    ms: POLL_TICK_MS,
    fn: () => {
      runSchedulerTick();
    },
  });

  immediateTimer = startTimeout({
    label: "marketpoll:startup",
    ms: 5_000,
    fn: () => {
      runSchedulerTick();
    },
  });
}

function stopScheduler() {
  schedulerBooted = false;
  clearTimer(schedulerTimer, "marketpoll:scheduler");
  clearTimer(immediateTimer, "marketpoll:startup");
  schedulerTimer = null;
  immediateTimer = null;
}

async function handleStatus({ message, isAdmin }) {
  await ensureMarketPollSettings({ guildId: message.guildId, updatedBy: message.author?.id || "system" });
  const [seedState, settings, openPolls] = await Promise.all([
    loadSeedState(),
    getMarketPollSettings({ guildId: message.guildId }),
    countOpenMarketPolls({ guildId: message.guildId }),
  ]);

  const lines = [
    "**MarketPoll Status**",
    `Enabled: **${settings.enabled ? "Yes" : "No"}**`,
    `Channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not set"}`,
    `Cadence: **${settings.cadenceMinutes} minutes**`,
    `Poll Duration: **${settings.pollMinutes} minutes**`,
    `Pair Cooldown: **${settings.pairCooldownDays} days**`,
    `Min Votes: **${settings.minVotes}**`,
    `Matchups: **${normalizeMatchupModes(settings.matchupModes).join(", ")}**`,
    `Base Golden Assets: **${seedState.universe?.eligibleAssets?.length || 0}**`,
    `Seeded Assets: **${seedState.rows.length}**`,
    `Open Polls (this guild): **${openPolls}**`,
  ];

  if (!seedState.valid) {
    lines.push("", "Seed Validation: **FAILED**");
    if (isAdmin) {
      for (const err of seedState.errors.slice(0, 15)) lines.push(`• ${err}`);
      if (seedState.errors.length > 15) lines.push(`• ...and ${seedState.errors.length - 15} more`);
    } else {
      lines.push("Admins can view detailed seed validation errors.");
    }
  } else {
    lines.push("", "Seed Validation: **OK**");
  }

  await replyChunked(message, lines);
}

async function handleHistory({ message, tokens }) {
  const { nameQuery, gender, limit } = parseHistoryArgs(tokens);
  const seedState = await loadSeedState();

  if (!nameQuery) {
    const rows = await listMarketPollHistory({ limit });
    if (!rows.length) {
      await message.reply("No poll history yet.");
      return;
    }

    const lines = ["**MarketPoll Poll History**"];
    for (const row of rows) {
      const stamp = row.closedAtMs ? `<t:${Math.floor(row.closedAtMs / 1000)}:R>` : "(pending)";
      const scoreTag = row.affectsScore ? "counted" : "no-score";
      lines.push(
        `${stamp} ${formatPollSide(row.leftAssetKeys, row.leftAssetKey)} vs ${formatPollSide(
          row.rightAssetKeys,
          row.rightAssetKey
        )} (${row.votesLeft}-${row.votesRight}, ${scoreTag})`
      );
    }

    await replyChunked(message, lines);
    return;
  }

  const resolved = resolveAssetQuery({ rows: seedState.rows, queryName: nameQuery, gender });
  if (!resolved.asset && resolved.matches.length > 1) {
    await message.reply(
      `Multiple assets match \`${nameQuery}\`. Please specify gender (M/F/?/G) or full asset key.`
    );
    return;
  }

  if (!resolved.asset) {
    await message.reply(`No seeded asset found for \`${nameQuery}\`.`);
    return;
  }

  const rows = await listMarketPollHistory({ assetKey: resolved.asset.assetKey, limit });
  if (!rows.length) {
    await message.reply(`No poll history found for \`${resolved.asset.assetKey}\`.`);
    return;
  }

  const lines = [`**History: ${resolved.asset.assetKey}**`];
  for (const row of rows) {
    const isLeft = (row.leftAssetKeys || []).includes(resolved.asset.assetKey);
    const myVotes = isLeft ? row.votesLeft : row.votesRight;
    const oppVotes = isLeft ? row.votesRight : row.votesLeft;
    const oppKeys = isLeft
      ? normalizeAssetKeyList(row.rightAssetKeys, row.rightAssetKey)
      : normalizeAssetKeyList(row.leftAssetKeys, row.leftAssetKey);
    const outcome = myVotes > oppVotes ? "W" : myVotes < oppVotes ? "L" : "T";
    const scoreTag = row.affectsScore ? "counted" : "no-score";
    const stamp = row.closedAtMs ? `<t:${Math.floor(row.closedAtMs / 1000)}:R>` : "(pending)";
    lines.push(`${stamp} vs ${formatPollSide(oppKeys)} (${myVotes}-${oppVotes}, ${outcome}, ${scoreTag})`);
  }

  await replyChunked(message, lines);
}

async function handleLeaderboard({ message, tokens }) {
  const maybeLimit = parsePositiveInt(tokens[0]);
  const limit = Math.min(MAX_LEADERBOARD_LIMIT, maybeLimit || 10);
  const rows = await listMarketPollLeaderboard({ limit });
  if (!rows.length) {
    await message.reply("No MarketPoll scores yet.");
    return;
  }

  const lines = ["**MarketPoll Preference Leaderboard**"];
  rows.forEach((row, idx) => {
    lines.push(
      `${idx + 1}. ${formatAssetDisplay(row.assetKey)} — Elo ${Number(row.elo).toFixed(2)} (W-L-T ${row.wins}-${row.losses}-${row.ties}, polls ${row.pollsCount})`
    );
  });

  await replyChunked(message, lines);
}

async function handleConfig({ message, tokens }) {
  const sub = String(tokens.shift() || "").toLowerCase();
  if (!sub || sub === "show") {
    const settings = await getMarketPollSettings({ guildId: message.guildId });
    await replyChunked(message, [
      "**MarketPoll Config**",
      `Enabled: **${settings.enabled ? "on" : "off"}**`,
      `Channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not set"}`,
      `Cadence: **${settings.cadenceMinutes} min**`,
      `Duration: **${settings.pollMinutes} min**`,
      `Cooldown: **${settings.pairCooldownDays} days**`,
      `Min Votes: **${settings.minVotes}**`,
      `Matchups: **${normalizeMatchupModes(settings.matchupModes).join(", ")}**`,
    ]);
    return;
  }

  if (sub === "channel") {
    const ch = parseChannelId(tokens[0]);
    if (!ch) {
      await message.reply("Usage: `!marketpoll config channel <channel_id_or_mention>`");
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { channelId: ch },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll channel set to <#${updated.channelId}>.`);
    return;
  }

  if (sub === "enabled") {
    const val = parseOnOff(tokens[0]);
    if (val === null) {
      await message.reply("Usage: `!marketpoll config enabled <on|off>`");
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { enabled: val },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll is now **${updated.enabled ? "on" : "off"}**.`);
    return;
  }

  if (sub === "cadence") {
    const hours = parsePositiveInt(tokens[0]);
    if (hours === null || hours < 1 || hours > 24) {
      await message.reply("Usage: `!marketpoll config cadence <hours>` (1-24)");
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { cadenceMinutes: hours * 60 },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll cadence set to **${updated.cadenceMinutes} minutes**.`);
    return;
  }

  if (sub === "duration") {
    const mins = parseDurationMinutes(tokens);
    if (mins === null || mins < 1 || mins > 24 * 60) {
      await message.reply(
        "Usage: `!marketpoll config duration <duration>` (e.g. `15m`, `2h`, `1 day`; min 1m, max 1d)"
      );
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { pollMinutes: mins },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll poll duration set to **${updated.pollMinutes} minute(s)**.`);
    return;
  }

  if (sub === "cooldown") {
    const days = parsePositiveInt(tokens[0]);
    if (days === null || days < 1 || days > 3650) {
      await message.reply("Usage: `!marketpoll config cooldown <days>` (1-3650)");
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { pairCooldownDays: days },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll pair cooldown set to **${updated.pairCooldownDays} days**.`);
    return;
  }

  if (sub === "minvotes") {
    const n = parsePositiveInt(tokens[0]);
    if (n === null || n < 1 || n > 100) {
      await message.reply("Usage: `!marketpoll config minvotes <n>` (1-100)");
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { minVotes: n },
      updatedBy: message.author?.id,
    });
    await message.reply(`MarketPoll minimum votes set to **${updated.minVotes}**.`);
    return;
  }

  if (sub === "matchups") {
    const parsed = parseMatchupModesInput(tokens);
    if (!parsed.ok) {
      await message.reply(parsed.error);
      return;
    }

    const updated = await updateMarketPollSettings({
      guildId: message.guildId,
      patch: { matchupModes: parsed.modes },
      updatedBy: message.author?.id,
    });
    await message.reply(
      `MarketPoll matchup modes set to **${normalizeMatchupModes(updated.matchupModes).join(", ")}**.`
    );
    return;
  }

  await message.reply("Unknown config option. Use `!marketpoll config show`.");
}

async function handleTiers({ message, tokens }) {
  const seedState = await loadSeedState();
  if (!seedState.valid) {
    await replyChunked(message, [
      "Seed validation failed. Fix `data/marketpoll_seeds.csv` first.",
      ...seedState.errors.slice(0, 20).map((e) => `• ${e}`),
    ]);
    return;
  }

  const { tierId, gender, limit } = parseTiersArgs(tokens);
  let rows = [...seedState.rows];
  if (tierId) rows = rows.filter((r) => r.tierId === tierId);
  if (gender) rows = rows.filter((r) => r.gender === gender);

  rows.sort((a, b) => {
    if (a.tierIndex !== b.tierIndex) return a.tierIndex - b.tierIndex;
    return b.midX - a.midX;
  });

  const sliced = rows.slice(0, limit);
  if (!sliced.length) {
    await message.reply("No seeded assets match those filters.");
    return;
  }

  const lines = ["**MarketPoll Tiers (Admin View)**"];
  for (const row of sliced) {
    lines.push(
      `${row.assetKey} — ${formatX(row.minX)}-${formatX(row.maxX)} (tier ${safeTierLabel(row.tierId)})`
    );
  }
  if (rows.length > sliced.length) {
    lines.push(`...showing ${sliced.length}/${rows.length}`);
  }

  await replyChunked(message, lines);
}

function isGoldenAssetKey(assetKey) {
  const [name] = String(assetKey || "").split("|");
  return /^golden/i.test(String(name || "").trim());
}

function parseSeedGetArgs(tokens) {
  const args = [...(Array.isArray(tokens) ? tokens : [])];
  let gender = "";
  if (args.length) {
    const maybeGender = genderToken(args[args.length - 1]);
    if (maybeGender) {
      gender = maybeGender;
      args.pop();
    }
  }
  return {
    nameQuery: args.join(" ").trim(),
    gender,
  };
}

function parseGoldenSeedAssetKeyInput(assetKeyInput) {
  const raw = String(assetKeyInput || "").trim();
  if (!raw) {
    return { ok: false, error: "Asset key is required in format `GoldenName|M/F/?/G`." };
  }

  const assetKey = normalizeAssetKey(raw);
  if (!assetKey) {
    return { ok: false, error: `Invalid asset key: \`${raw}\`. Expected \`GoldenName|M/F/?/G\`.` };
  }

  if (!isGoldenAssetKey(assetKey)) {
    return {
      ok: false,
      error: `Invalid MarketPoll seed asset key: \`${raw}\`. Asset key must begin with \`Golden\` and include gender \`M/F/?/G\`.`,
    };
  }

  return { ok: true, assetKey };
}

async function handleSeeds({ message, tokens }) {
  const sub = String(tokens.shift() || "").toLowerCase();
  if (!sub) {
    await message.reply(
      "Usage: `!marketpoll seeds <upsert|unset|get> ...`"
    );
    return;
  }

  if (sub === "upsert") {
    const assetKeyInput = String(tokens.shift() || "").trim();
    const seedRangeRaw = String(tokens.join(" ") || "").trim();
    const parsedKey = parseGoldenSeedAssetKeyInput(assetKeyInput);
    if (!seedRangeRaw) {
      await message.reply("Usage: `!marketpoll seeds upsert <asset_key> <seed_range>`");
      return;
    }
    if (!parsedKey.ok) {
      await message.reply(parsedKey.error);
      return;
    }
    const assetKey = parsedKey.assetKey;

    const parsedRange = parseSeedRange(seedRangeRaw);
    if (!parsedRange.ok) {
      await message.reply(`Invalid seed range: ${parsedRange.error}`);
      return;
    }

    const seedState = await loadSeedState();
    const known = seedState.universe?.allAssetsByKey?.get(assetKey) || null;
    let isProvisional = false;
    if (known) {
      if (!isSeedableKnownAsset(known)) {
        await message.reply(`Cannot seed evolved asset \`${assetKey}\`; base is \`${known.baseName}\`.`);
        return;
      }
    } else {
      const rarity = await resolveRarityEntry(assetKey.split("|")[0]);
      if (!rarity.ok) {
        if (rarity.reason === "unavailable") {
          await message.reply(
            "Rarity data is currently unavailable, so provisional seed validation cannot run right now. Please retry shortly."
          );
          return;
        }
        await message.reply(`Unknown Pokemon for provisional seed: \`${assetKey}\`.`);
        return;
      }

      const resolvedName = String(rarity.entry?.name || "");
      if (!/^golden/i.test(resolvedName)) {
        await message.reply("Only Golden assets are allowed for MarketPoll seeds.");
        return;
      }
      isProvisional = true;
    }

    await upsertMarketPollSeedOverride({
      assetKey,
      seedRange: seedRangeRaw,
      isProvisional,
      updatedBy: message.author?.id || "system",
    });
    await loadSeedState(true);

    const parsedLabel =
      Number(parsedRange.minX) === Number(parsedRange.maxX)
        ? formatX(parsedRange.minX)
        : `${formatX(parsedRange.minX)}-${formatX(parsedRange.maxX)}`;
    await message.reply(
      `Saved seed override: \`${assetKey}\` = **${parsedLabel}**${isProvisional ? " (provisional)" : ""}. Baseline CSV seeds are unchanged.`
    );
    return;
  }

  if (sub === "unset") {
    const assetKeyInput = String(tokens.join(" ") || "").trim();
    const parsedKey = parseGoldenSeedAssetKeyInput(assetKeyInput);
    if (!parsedKey.ok) {
      await message.reply(parsedKey.error);
      return;
    }
    const assetKey = parsedKey.assetKey;

    const overrides = await listMarketPollSeedOverrides();
    const exists = overrides.some((row) => row.assetKey === assetKey);
    if (!exists) {
      await message.reply(
        `No seed override exists for \`${assetKey}\`. Baseline CSV seeds are not removable via this command.`
      );
      return;
    }

    await deleteMarketPollSeedOverride({ assetKey });
    await loadSeedState(true);
    await message.reply(
      `Removed seed override for \`${assetKey}\`. Baseline CSV seeds are unchanged.`
    );
    return;
  }

  if (sub === "get") {
    const { nameQuery, gender } = parseSeedGetArgs(tokens);
    if (!nameQuery) {
      await message.reply("Usage: `!marketpoll seeds get <asset_or_name> [gender]`");
      return;
    }

    const seedState = await loadSeedState();
    const resolved = resolveAssetQuery({
      rows: seedState.rows,
      queryName: nameQuery,
      gender,
    });
    if (!resolved.asset && resolved.matches.length > 1) {
      await message.reply(
        `Multiple assets match \`${nameQuery}\`. Please include gender (M/F/?/G) or full asset key.`
      );
      return;
    }

    if (!resolved.asset) {
      await message.reply(`No seeded asset found for \`${nameQuery}\`.`);
      return;
    }

    const overrides = await listMarketPollSeedOverrides();
    const override = overrides.find((row) => row.assetKey === resolved.asset.assetKey) || null;
    const rangeLabel =
      override?.seedRange ||
      (Number(resolved.asset.minX) === Number(resolved.asset.maxX)
        ? formatX(resolved.asset.minX)
        : `${formatX(resolved.asset.minX)}-${formatX(resolved.asset.maxX)}`);
    const source = override
      ? `override${override.isProvisional ? " (provisional)" : ""}`
      : "baseline";
    await message.reply(
      `Seed for \`${resolved.asset.assetKey}\`: **${rangeLabel}** (source: ${source}).`
    );
    return;
  }

  await message.reply("Unknown seeds command. Use `!marketpoll seeds <upsert|unset|get>`.");
}

async function handlePollNow({ message, tokens }) {
  const settings = await getMarketPollSettings({ guildId: message.guildId });
  if (!settings.channelId) {
    await message.reply("MarketPoll channel is not configured. Use `!marketpoll config channel <id>`. ");
    return;
  }

  clientRef = message.client || clientRef;
  const parsed = parsePollNowArgs(tokens);
  if (!parsed.ok) {
    await message.reply(parsed.error);
    return;
  }

  if (!parsed.targeted) {
    const res = await postAutoPollForGuild({ setting: settings, reason: "manual", shouldLog: false });
    if (!res.ok) {
      const seedState = await loadSeedState();
      if (res.reason === "seed_invalid") {
        await replyChunked(message, [
          "Cannot run poll now because seed validation failed.",
          ...seedState.errors.slice(0, 10).map((e) => `• ${e}`),
        ]);
        return;
      }
      const detail = String(res.detail || "").trim();
      await message.reply(
        detail
          ? `Could not create poll now: ${res.reason}. ${detail}.`
          : `Could not create poll now: ${res.reason}.`
      );
      return;
    }

    await message.reply(
      `Posted MarketPoll poll: ${formatPollSide(res.left.assetKeys)} vs ${formatPollSide(res.right.assetKeys)}.`
    );
    return;
  }

  if (!clientRef) {
    await message.reply("Could not create poll now: missing_client.");
    return;
  }

  let channel;
  try {
    channel = await clientRef.channels.fetch(settings.channelId);
  } catch {
    channel = null;
  }
  if (!channel?.isTextBased?.()) {
    await message.reply("Could not create poll now: invalid_channel.");
    return;
  }

  const missingPerms = getMissingPollPermissions(channel, clientRef.user);
  if (missingPerms.length) {
    await message.reply(`Could not create poll now: missing_permissions. Missing channel permission(s): ${missingPerms.join(", ")}.`);
    return;
  }

  const nowMs = Date.now();
  const seedState = await loadSeedState();
  const seedByKey = new Map((seedState.rows || []).map((row) => [row.assetKey, row]));

  const leftResolved = await resolveTargetedSide({
    raw: parsed.leftRaw,
    seedByKey,
    scoreMode: parsed.scoreMode,
    label: "Left",
  });
  if (!leftResolved.ok) {
    await message.reply(leftResolved.error);
    return;
  }
  const rightResolved = await resolveTargetedSide({
    raw: parsed.rightRaw,
    seedByKey,
    scoreMode: parsed.scoreMode,
    label: "Right",
  });
  if (!rightResolved.ok) {
    await message.reply(rightResolved.error);
    return;
  }

  const left = leftResolved.side;
  const right = rightResolved.side;
  const overlap = new Set([...left.assetKeys, ...right.assetKeys].map((x) => String(x).toLowerCase()));
  if (overlap.size !== left.assetKeys.length + right.assetKeys.length) {
    await message.reply("Left and right sides must not contain duplicate entries.");
    return;
  }

  if (parsed.scoreMode === SCORE_MODE_COUNTED && (!left.allSeeded || !right.allSeeded)) {
    await message.reply("Counted targeted polls require all entries to be seeded asset keys.");
    return;
  }

  const pairKey = canonicalPairKey(left.assetKeys, right.assetKeys);
  const [openPairKeys, cooldowns] = await Promise.all([
    listOpenMarketPollPairKeys({ guildId: settings.guildId }),
    getMarketPollCooldownMap({ nowMs }),
  ]);

  const strict = validateStrictTargetedMatchup({
    left,
    right,
    pairKey,
    openPairKeys,
    cooldowns,
    nowMs,
    force: parsed.force,
  });
  if (!strict.ok) {
    await message.reply(`${strict.error}${parsed.force ? "" : " Add `force` to bypass this strict check."}`);
    return;
  }

  const posted = await postAndTrackPoll({
    setting: settings,
    channel,
    leftAssetKeys: left.assetKeys,
    rightAssetKeys: right.assetKeys,
    pairKey,
    scoreMode: parsed.scoreMode,
    nowMs,
    reason: "manual_targeted",
    shouldLog: false,
  });
  if (!posted.ok) {
    const detail = String(posted.detail || "").trim();
    await message.reply(
      detail
        ? `Could not create targeted poll now: ${posted.reason}. ${detail}.`
        : `Could not create targeted poll now: ${posted.reason}.`
    );
    return;
  }

  await message.reply(
    `Posted targeted MarketPoll (${parsed.scoreMode === SCORE_MODE_COUNTED ? "counted" : "exhibition"}): ${formatPollSide(
      left.assetKeys
    )} vs ${formatPollSide(right.assetKeys)}.`
  );
}

export function registerMarketPollScheduler() {
  registerScheduler(
    "marketpoll",
    (context = {}) => {
      startScheduler(context);
    },
    () => {
      stopScheduler();
    }
  );
}

export function registerMarketPoll(register) {
  register.listener?.(({ message }) => {
    if (message?.client && !clientRef) clientRef = message.client;
  });

  register.expose({
    logicalId: "marketpoll.main",
    name: "marketpoll",
    handler: async ({ message, rest, cmd }) => {
      if (!message?.guildId) return;
      if (message?.client && !clientRef) clientRef = message.client;

      const prefix = commandPrefix(cmd);
      const tokens = tokenizeArgs(rest);
      const sub = String(tokens.shift() || "help").toLowerCase();
      const isAdmin = isAdminOrPrivileged(message);

      if (sub === "help") {
        await message.reply(buildHelpText(prefix));
        return;
      }

      if (sub === "status") {
        await handleStatus({ message, isAdmin });
        return;
      }

      if (sub === "history") {
        await handleHistory({ message, tokens });
        return;
      }

      if (sub === "leaderboard") {
        await handleLeaderboard({ message, tokens });
        return;
      }

      if (sub === "config") {
        if (!isAdmin) {
          await message.reply("You do not have permission to configure MarketPoll.");
          return;
        }
        await handleConfig({ message, tokens });
        return;
      }

      if (sub === "seeds") {
        if (!isAdmin) {
          await message.reply("You do not have permission to edit MarketPoll seeds.");
          return;
        }
        await handleSeeds({ message, tokens });
        return;
      }

      if (sub === "tiers") {
        if (!isAdmin) {
          await message.reply("You do not have permission to view tier ranges.");
          return;
        }
        await handleTiers({ message, tokens });
        return;
      }

      if (sub === "poll" && String(tokens[0] || "").toLowerCase() === "now") {
        if (!isAdmin) {
          await message.reply("You do not have permission to run MarketPoll polls manually.");
          return;
        }
        await handlePollNow({ message, tokens: tokens.slice(1) });
        return;
      }

      await message.reply(buildHelpText(prefix));
    },
    help: "!marketpoll <help|status|history|leaderboard|config|seeds|tiers|poll now> — market poll tools",
    opts: {
      category: "Tools",
      aliases: ["market", "mp"],
    },
  });
}

export const __testables = {
  tokenizeArgs,
  parseOnOff,
  parsePositiveInt,
  parseDurationMinutes,
  parseMatchupModesInput,
  normalizeMatchupModes,
  parseChannelId,
  parseHistoryArgs,
  parseTiersArgs,
  parsePollNowArgs,
  formatAssetDisplay,
  buildPollQuestionText,
  loadSeedState,
  stopScheduler,
  startScheduler,
};
