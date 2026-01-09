// tools/sortbox.js
//
// /sortbox - fetch TPPC box contents, sort them, and DM BBCode as text files.

import fs from "node:fs/promises";

import { sendDmBatch } from "../shared/dm.js";
import { fetchFindMyIdMatches } from "../rpg/findmyid.js";
import { createRpgClientFactory } from "../rpg/client_factory.js";
import { requireRpgCredentials } from "../rpg/credentials.js";
import { getSavedId, getUserText } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { __testables as viewboxTestables } from "../rpg/viewbox.js";

const DATA_DIR = new URL("./sortbox_data/", import.meta.url);
const SORTBOX_FEATURE = "sortbox";
const VIEWBOX_URL = "https://www.tppcrpg.net/profile.php";
const IDS_KIND = "ids";
const COOLDOWN_MS = 60_000;

const userCooldowns = new Map(); // userId -> lastMs

const { parseViewboxEntries } = viewboxTestables;

// Gen 7 Legends & Mythicals + Zeraora (matches organizer defaults)
const DEFAULT_LEGENDS_MYTHICALS_GEN7 = [
  "Articuno","Zapdos","Moltres","Mewtwo","Mew",
  "Raikou","Entei","Suicune","Lugia","Ho-oh","Celebi",
  "Regirock","Regice","Registeel","Latias","Latios","Kyogre","Groudon","Rayquaza","Jirachi","Deoxys",
  "Mesprit","Uxie","Azelf","Dialga","Palkia","Heatran","Regigigas","Giratina","Cresselia",
  "Phione","Manaphy","Darkrai","Shaymin","Arceus",
  "Victini","Cobalion","Terrakion","Virizion","Tornadus","Thundurus","Reshiram","Zekrom","Landorus","Kyurem",
  "Keldeo","Meloetta","Genesect",
  "Xerneas","Yveltal","Zygarde","Diancie","Hoopa","Volcanion",
  "Tapu Koko","Tapu Lele","Tapu Bulu","Tapu Fini",
  "Cosmog","Cosmoem","Solgaleo","Lunala","Necrozma",
  "Magearna","Marshadow",
  "Zeraora"
];

const RE_GOLD_PREFIX = /^Golden(?=[A-Z])/;
const RE_SHINY_PREFIX = /^Shiny(?=[A-Z])/;
const RE_DARK_PREFIX = /^Dark(?=[A-Z])/;

let ueugSet = null;
let mapsSet = null;
let swapsSet = null;
let genderlessSet = null;

async function loadTextSet(filename) {
  try {
    const raw = await fs.readFile(new URL(filename, DATA_DIR), "utf8");
    return new Set(
      raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

async function loadUEUGSet() {
  if (!ueugSet) ueugSet = await loadTextSet("ueug_list.txt");
  return ueugSet;
}

async function loadJunkSets() {
  if (!mapsSet) mapsSet = await loadTextSet("maps.txt");
  if (!swapsSet) swapsSet = await loadTextSet("secret_swaps.txt");
  if (!genderlessSet) genderlessSet = await loadTextSet("genderless.txt");
  return { mapsSet, swapsSet, genderlessSet };
}

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function parseIntLoose(n) {
  const cleaned = String(n).replace(/[^\d]/g, "");
  return cleaned ? parseInt(cleaned, 10) : null;
}

function fmtLevel(n) {
  return Number(n).toLocaleString("en-US");
}

function hasGenderSymbol(name) {
  return name.includes("♂") || name.includes("♀");
}

function extractGender(name) {
  if (name.includes("♀")) return "♀";
  if (name.includes("♂")) return "♂";
  return "";
}

function isUnknown(name) {
  return /\(\s*\?\s*\)/.test(name);
}

function stripGender(name) {
  return name.replace(/\s*[♂♀]\s*/g, " ").replace(/\s+/g, " ").trim();
}

function stripPrefix(name) {
  return name
    .replace(/^Shiny(?=[A-Z])/, "")
    .replace(/^Dark(?=[A-Z])/, "")
    .replace(/^Golden(?=[A-Z])/, "")
    .trim();
}

function baseSpeciesName(name) {
  const withoutPrefix = stripPrefix(name);
  const withoutGender = stripGender(withoutPrefix);
  return withoutGender.split(" (")[0].trim();
}

function normalizeUEUGCandidateName(name) {
  return name.replace(/\(\s*\?\s*\)/g, "").trim().toLowerCase();
}

function canonicalNoGender(name) {
  return stripGender(name).trim().toLowerCase();
}

function dupeGroupKey(name) {
  return stripGender(name).toLowerCase();
}

function stripLeadingShinyDarkPrefixOnce(name) {
  if (/^Shiny(?=[A-Z])/.test(name)) return name.replace(/^Shiny(?=[A-Z])/, "");
  if (/^Dark(?=[A-Z])/.test(name)) return name.replace(/^Dark(?=[A-Z])/, "");
  return name;
}

function combinedSDKey(name) {
  return stripGender(stripLeadingShinyDarkPrefixOnce(name)).toLowerCase();
}

function shinyDarkRank(entry) {
  if (entry.category === "shiny") return 0;
  if (entry.category === "dark") return 1;
  return 2;
}

function compareEntries(a, b, dupeDesc, useCombinedSD = false) {
  const ak = useCombinedSD ? combinedSDKey(a.name) : dupeGroupKey(a.name);
  const bk = useCombinedSD ? combinedSDKey(b.name) : dupeGroupKey(b.name);

  if (ak < bk) return -1;
  if (ak > bk) return 1;

  const al = a.levelNum ?? 0;
  const bl = b.levelNum ?? 0;
  if (al !== bl) return dupeDesc ? (bl - al) : (al - bl);

  const rankGender = (g) => (g === "♀" ? 0 : (g === "♂" ? 1 : 2));
  const arG = rankGender(extractGender(a.name));
  const brG = rankGender(extractGender(b.name));
  if (arG !== brG) return arG - brG;

  if (useCombinedSD) {
    const ar = shinyDarkRank(a);
    const br = shinyDarkRank(b);
    if (ar !== br) return ar - br;
  }

  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function parseSavedIds(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => ({
        id: Number(entry?.id),
        label: entry?.label ? String(entry.label) : null,
        addedAt: Number(entry?.addedAt) || 0,
      }))
      .filter((entry) => Number.isSafeInteger(entry.id));
  } catch {
    return [];
  }
}

async function loadUserIds({ guildId, userId }) {
  const text = await getUserText({ guildId, userId, kind: IDS_KIND });
  const entries = parseSavedIds(text);
  if (entries.length) return entries;

  const legacy = await getSavedId({ guildId, userId });
  if (legacy == null) return [];

  return [{ id: Number(legacy), label: null, addedAt: 0 }];
}

function parseIdList(raw) {
  const list = String(raw || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(list.map((n) => Math.floor(n)))];
}

function applyVariantPrefix(name, variant) {
  if (RE_GOLD_PREFIX.test(name) || RE_SHINY_PREFIX.test(name) || RE_DARK_PREFIX.test(name)) {
    return name;
  }
  if (variant === "G") return `Golden${name}`;
  if (variant === "S") return `Shiny${name}`;
  if (variant === "D") return `Dark${name}`;
  return name;
}

function buildOrganizerEntries(viewboxEntries) {
  return viewboxEntries.map((entry) => {
    const base = applyVariantPrefix(entry.name, entry.variant);
    const unknown = entry.unknown ? " (?)" : "";
    const gender = entry.gender ? ` ${entry.gender}` : "";
    const name = `${base}${unknown}${gender}`;
    const levelNum = parseIntLoose(entry.level);
    return { name, levelNum };
  }).filter((entry) => entry.name && entry.levelNum !== null);
}

function combineEntries(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = `${e.name}|||${e.levelNum}`;
    const prev = map.get(key);
    if (!prev) map.set(key, { ...e, count: 1 });
    else prev.count += 1;
  }
  return Array.from(map.values());
}

function colorizeName(name, color) {
  const c = (color || "").trim();
  if (!c) return name;
  return `[color=${c}]${name}[/color]`;
}

function formatLine(e, opts, color) {
  const nm = colorizeName(e.name, color);
  const lvl = fmtLevel(e.levelNum);
  return opts.plainLevel ? `${nm} ${lvl}` : `${nm} (Level: ${lvl})`;
}

function formatCombinedLine(e, opts, color) {
  const base = formatLine(e, opts, color);
  return (e.count && e.count > 1) ? `${base} x${e.count}` : base;
}

function makeSubheader(label) {
  return `[b]${label}[/b]\n`;
}

function makeSection(title, body) {
  const b = (body || "").trimEnd();
  if (!b) return "";
  return `[b]${title}[/b]\n[code]\n${b}\n[/code]\n`;
}

function splitUnknown(list) {
  const unknown = [];
  const rest = [];
  for (const e of list) (isUnknown(e.name) ? unknown : rest).push(e);
  return { unknown, rest };
}

function splitLegends(list, legendSet) {
  const legends = [];
  const rest = [];
  for (const e of list) {
    const base = baseSpeciesName(e.name);
    if (legendSet.has(normalize(base))) legends.push(e);
    else rest.push(e);
  }
  return { legends, rest };
}

function splitUEUG(list, ueugLoaded) {
  const ueug = [];
  const non = [];
  for (const e of list) {
    const key = normalizeUEUGCandidateName(e.name);
    if (ueugLoaded.has(key)) ueug.push(e);
    else non.push(e);
  }
  return { ueug, non };
}

function isTypicalGenderForFiltering(entry, genderlessSetLoaded) {
  if (isUnknown(entry.name)) return false;

  const core = canonicalNoGender(entry.name);
  const isGenderlessSpecies = genderlessSetLoaded.has(core);

  if (isGenderlessSpecies) return !hasGenderSymbol(entry.name);
  return hasGenderSymbol(entry.name);
}

function shouldFilterAsJunk(entry, opts, lists) {
  if (!opts.filterJunk) return false;

  if (entry.levelNum === 4) return false;
  if (entry.levelNum >= 1000) return false;
  if (!isTypicalGenderForFiltering(entry, lists.genderlessSet)) return false;

  const core = canonicalNoGender(entry.name);
  const isMap = lists.mapsSet.has(core);
  const isSwap = lists.swapsSet.has(core);
  return isMap || isSwap;
}

function sortAndLines(list, opts, colorPicker, useCombinedSD = false) {
  const arr = list.slice().sort((a, b) => compareEntries(a, b, opts.dupeDesc, useCombinedSD));
  return arr.map((e) => {
    const color = colorPicker(e);
    return opts.combine
      ? formatCombinedLine(e, opts, color)
      : formatLine(e, opts, color);
  }).join("\n");
}

function sectionForCategory(cat) {
  if (cat === "gold") return "Golden";
  if (cat === "shiny") return "Shiny";
  if (cat === "dark") return "Dark";
  return "Normal";
}

function organize(entries, legendSet, opts, colors, ueugLoaded) {
  const catsAll = { gold: [], shiny: [], dark: [], normal: [] };

  for (const e0 of entries) {
    const e = { ...e0, category: "normal" };
    if (RE_GOLD_PREFIX.test(e.name)) e.category = "gold";
    else if (RE_SHINY_PREFIX.test(e.name)) e.category = "shiny";
    else if (RE_DARK_PREFIX.test(e.name)) e.category = "dark";
    else e.category = "normal";
    catsAll[e.category].push(e);
  }

  const colorPicker = (e) => {
    if (e.category === "gold") return colors.gold;
    if (e.category === "shiny") return colors.shiny;
    if (e.category === "dark") return colors.dark;
    return colors.normal;
  };

  let cats = {
    gold: catsAll.gold.slice(),
    shiny: catsAll.shiny.slice(),
    dark: catsAll.dark.slice(),
    normal: catsAll.normal.slice(),
  };

  const applyDedicatedUnknownFor = (cat) => (cat !== "gold" || !opts.keepGoldsInGolden) && opts.dedicatedUnknown;
  const applyDedicatedLegendsFor = (cat) => (cat !== "gold" || !opts.keepGoldsInGolden) && opts.dedicatedLegends;

  let dedU = { gold: [], shiny: [], dark: [], normal: [] };
  for (const cat of ["gold", "shiny", "dark", "normal"]) {
    if (applyDedicatedUnknownFor(cat)) {
      const split = splitUnknown(cats[cat]);
      dedU[cat] = split.unknown;
      cats[cat] = split.rest;
    }
  }

  let dedL = { gold: [], shiny: [], dark: [], normal: [] };
  for (const cat of ["gold", "shiny", "dark", "normal"]) {
    if (applyDedicatedLegendsFor(cat)) {
      const split = splitLegends(cats[cat], legendSet);
      dedL[cat] = split.legends;
      cats[cat] = split.rest;
    }
  }

  let localU = { gold: [], shiny: [], dark: [], normal: [] };
  for (const cat of ["gold", "shiny", "dark", "normal"]) {
    if (!applyDedicatedUnknownFor(cat)) {
      const split = splitUnknown(cats[cat]);
      localU[cat] = split.unknown;
      cats[cat] = split.rest;
    }
  }

  let localL = { gold: [], shiny: [], dark: [], normal: [] };
  for (const cat of ["gold", "shiny", "dark", "normal"]) {
    if (!applyDedicatedLegendsFor(cat)) {
      const split = splitLegends(cats[cat], legendSet);
      localL[cat] = split.legends;
      cats[cat] = split.rest;
    }
  }

  const maybeCombine = (list) => (opts.combine ? combineEntries(list) : list);
  for (const cat of ["gold", "shiny", "dark", "normal"]) {
    cats[cat] = maybeCombine(cats[cat]);
    localU[cat] = maybeCombine(localU[cat]);
    localL[cat] = maybeCombine(localL[cat]);
    dedU[cat] = maybeCombine(dedU[cat]);
    dedL[cat] = maybeCombine(dedL[cat]);
  }

  function renderNormalUngenderedBlock(listUnknownNormal) {
    if (!listUnknownNormal.length) return { ueug: "", non: "" };

    const { ueug, non } = splitUEUG(listUnknownNormal, ueugLoaded);
    const ueugLines = sortAndLines(ueug, opts, colorPicker);
    const nonLines = sortAndLines(non, opts, colorPicker);

    return {
      ueug: ueugLines ? makeSubheader("Unevolved / Ungoldenized") + ueugLines : "",
      non: nonLines ? makeSubheader("Evolved / Goldenized") + nonLines : "",
    };
  }

  const buildCategorySection = (cat) => {
    const title = sectionForCategory(cat);
    let body = "";

    const mainLines = sortAndLines(cats[cat], opts, colorPicker);
    if (mainLines) body += mainLines;

    const shouldShowLocalU = (!applyDedicatedUnknownFor(cat)) || (cat === "gold" && opts.keepGoldsInGolden);
    const shouldShowLocalL = (!applyDedicatedLegendsFor(cat)) || (cat === "gold" && opts.keepGoldsInGolden);

    if (shouldShowLocalU && localU[cat].length) {
      if (body) body += "\n\n";

      if (cat === "normal") {
        const blocks = renderNormalUngenderedBlock(localU[cat]);
        if (blocks.ueug) body += blocks.ueug + "\n\n";
        if (blocks.non) body += blocks.non;
      } else {
        body += makeSubheader("Ungendered");
        body += sortAndLines(localU[cat], opts, colorPicker);
      }
    }

    if (shouldShowLocalL && localL[cat].length) {
      if (body) body += "\n\n";
      body += makeSubheader("Legends / Mythicals");
      body += sortAndLines(localL[cat], opts, colorPicker);
    }

    return makeSection(title, body);
  };

  const buildDedicatedUnknownSection = () => {
    if (!opts.dedicatedUnknown) return "";
    let body = "";

    const addSub = (label, list, useCombinedSD = false) => {
      if (!list.length) return;
      body += makeSubheader(label);
      body += sortAndLines(list, opts, colorPicker, useCombinedSD) + "\n\n";
    };

    if (!opts.keepGoldsInGolden) addSub("Golden", dedU.gold);

    let egBlock = "";
    if (dedU.normal.length) {
      const blocks = renderNormalUngenderedBlock(dedU.normal);
      if (blocks.ueug) body += blocks.ueug + "\n\n";
      egBlock = blocks.non;
    }

    if (opts.combineSD) {
      const merged = dedU.shiny.concat(dedU.dark);
      addSub("Shiny / Dark", merged, true);
    } else {
      addSub("Shiny", dedU.shiny);
      addSub("Dark", dedU.dark);
    }

    if (egBlock) body += egBlock + "\n\n";

    return makeSection("Ungendered", body.trimEnd());
  };

  const buildDedicatedLegendsSection = () => {
    if (!opts.dedicatedLegends) return "";
    let body = "";

    const addSub = (label, list, useCombinedSD = false) => {
      if (!list.length) return;
      body += makeSubheader(label);
      body += sortAndLines(list, opts, colorPicker, useCombinedSD) + "\n\n";
    };

    if (!opts.keepGoldsInGolden) addSub("Golden", dedL.gold);

    if (opts.combineSD) {
      const merged = dedL.shiny.concat(dedL.dark);
      addSub("Shiny / Dark", merged, true);
    } else {
      addSub("Shiny", dedL.shiny);
      addSub("Dark", dedL.dark);
    }

    addSub("Normal", dedL.normal);

    return makeSection("Legends / Mythicals", body.trimEnd());
  };

  let out = "";

  out += buildCategorySection("gold");
  out += buildDedicatedUnknownSection();
  out += buildDedicatedLegendsSection();

  if (opts.combineSD) {
    const mergedMain = cats.shiny.concat(cats.dark);
    const mergedU = localU.shiny.concat(localU.dark);
    const mergedL = localL.shiny.concat(localL.dark);

    let body = "";

    const mainLines = sortAndLines(mergedMain, opts, colorPicker, true);
    if (mainLines) body += mainLines;

    if (!opts.dedicatedUnknown && mergedU.length) {
      if (body) body += "\n\n";
      body += makeSubheader("Ungendered");
      body += sortAndLines(mergedU, opts, colorPicker, true);
    }

    if (!opts.dedicatedLegends && mergedL.length) {
      if (body) body += "\n\n";
      body += makeSubheader("Legends / Mythicals");
      body += sortAndLines(mergedL, opts, colorPicker, true);
    }

    out += makeSection("Shiny / Dark", body);
  } else {
    out += buildCategorySection("shiny");
    out += buildCategorySection("dark");
  }

  out += buildCategorySection("normal");
  return out.trimEnd();
}

function buildLegendSet(rawText) {
  const text = String(rawText || "").trim();
  const lines = text
    ? text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    : DEFAULT_LEGENDS_MYTHICALS_GEN7;
  return new Set(lines.map(normalize));
}

async function fetchViewboxEntries(client, id) {
  const url = `${VIEWBOX_URL}?id=${encodeURIComponent(String(id))}&View=All`;
  const html = await client.fetchPage(url);
  return parseViewboxEntries(html);
}

async function sendSortboxDm({ user, outputs }) {
  const messages = outputs.map(({ label, output, filename }) => ({
    content: label ? `✅ Sorted box BBCode for ${label}.` : "✅ Sorted box BBCode attached.",
    files: [
      {
        attachment: Buffer.from(output, "utf8"),
        name: filename || "sorted-box.txt",
      },
    ],
  }));
  return sendDmBatch({ user, messages, feature: SORTBOX_FEATURE });
}

export function registerSortbox(register) {
  register(
    "!sortbox",
    async ({ message }) => {
      await message.reply("Use `/sortbox` to sort a trainer box and get BBCode via DM.");
    },
    "!sortbox — sort a trainer box and DM BBCode via /sortbox",
    { hideFromHelp: true }
  );

  register.slash(
    {
      name: "sortbox",
      description: "Sort a TPPC trainer box and DM BBCode",
      options: [
        {
          type: 3, // STRING
          name: "id",
          description: "Trainer ID",
          required: false,
        },
        {
          type: 3, // STRING
          name: "ids",
          description: "Comma/space-separated trainer IDs (e.g., 123, 456 789)",
          required: false,
        },
        {
          type: 6, // USER
          name: "user",
          description: "Discord user to look up their saved IDs",
          required: false,
        },
        {
          type: 3, // STRING
          name: "rpgusername",
          description: "RPG username to search for",
          required: false,
        },
        {
          type: 5, // BOOLEAN
          name: "all_saved",
          description: "Use all saved IDs when multiple are on file",
          required: false,
        },
        { type: 5, name: "combine", description: "Combine identical entries", required: false },
        { type: 5, name: "dupe_desc", description: "Sort dupes by level descending", required: false },
        { type: 5, name: "plain_level", description: "Use plain levels instead of (Level: X)", required: false },
        { type: 5, name: "combine_sd", description: "Combine Shiny/Dark into one section", required: false },
        { type: 5, name: "dedicated_unknown", description: "Dedicated (?) section", required: false },
        { type: 5, name: "dedicated_legends", description: "Dedicated Legends/Mythicals section", required: false },
        { type: 5, name: "keep_golds_in_golden", description: "Keep golds in Golden section", required: false },
        { type: 5, name: "filter_junk", description: "Filter maps/swaps (unless level >= 1000)", required: false },
        { type: 5, name: "split_outputs", description: "Send separate files for each ID", required: false },
        { type: 3, name: "gold_color", description: "BBCode color for gold names", required: false },
        { type: 3, name: "shiny_color", description: "BBCode color for shiny names", required: false },
        { type: 3, name: "dark_color", description: "BBCode color for dark names", required: false },
        { type: 3, name: "normal_color", description: "BBCode color for normal names", required: false },
        { type: 3, name: "legends", description: "Override Legends/Mythicals list (one per line)", required: false },
      ],
    },
    async ({ interaction }) => {
      async function ensureDeferred() {
        if (interaction.deferred || interaction.replied) return;
        await interaction.deferReply({ ephemeral: true });
      }

      async function editResponse(payload) {
        await ensureDeferred();
        const next = { ...(payload || {}) };
        delete next.ephemeral;
        delete next.flags;
        return interaction.editReply(next);
      }

      await ensureDeferred();

      if (!requireRpgCredentials("/sortbox")) {
        await editResponse({ content: "❌ RPG credentials are not configured." });
        return;
      }

      const userId = interaction.user?.id;
      const now = Date.now();
      const last = userCooldowns.get(userId) || 0;
      const bypassCooldown = isAdminOrPrivileged({
        member: interaction.member,
        author: interaction.user,
        guildId: interaction.guildId,
      });
      if (!bypassCooldown && now - last < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        await editResponse({
          content: `⚠️ This command is on cooldown for another ${remaining}s!`,
        });
        return;
      }
      if (!bypassCooldown) {
        userCooldowns.set(userId, now);
      }

      const opts = {
        combine: Boolean(interaction.options?.getBoolean?.("combine")),
        dupeDesc: Boolean(interaction.options?.getBoolean?.("dupe_desc")),
        plainLevel: Boolean(interaction.options?.getBoolean?.("plain_level")),
        combineSD: Boolean(interaction.options?.getBoolean?.("combine_sd")),
        dedicatedUnknown: Boolean(interaction.options?.getBoolean?.("dedicated_unknown")),
        dedicatedLegends: Boolean(interaction.options?.getBoolean?.("dedicated_legends")),
        keepGoldsInGolden: Boolean(interaction.options?.getBoolean?.("keep_golds_in_golden")),
        filterJunk: Boolean(interaction.options?.getBoolean?.("filter_junk")),
      };
      const splitOutputs = Boolean(interaction.options?.getBoolean?.("split_outputs"));

      const colors = {
        gold: String(interaction.options?.getString?.("gold_color") || ""),
        shiny: String(interaction.options?.getString?.("shiny_color") || ""),
        dark: String(interaction.options?.getString?.("dark_color") || ""),
        normal: String(interaction.options?.getString?.("normal_color") || ""),
      };

      const legendText = String(interaction.options?.getString?.("legends") || "");
      const legendSet = buildLegendSet(legendText);

      const idRaw = String(interaction.options?.getString?.("id") || "").trim();
      const idsRaw = String(interaction.options?.getString?.("ids") || "").trim();
      const rpgUsername = String(interaction.options?.getString?.("rpgusername") || "").trim();
      const targetUser = interaction.options?.getUser?.("user") || null;
      const allSaved = Boolean(interaction.options?.getBoolean?.("all_saved"));
      const getClient = createRpgClientFactory();

      let resolvedIds = [];
      if (idRaw || idsRaw) {
        resolvedIds = parseIdList([idRaw, idsRaw].filter(Boolean).join(" "));
      } else if (rpgUsername) {
        const matches = await fetchFindMyIdMatches(getClient(), rpgUsername);
        if (!matches.length) {
          await editResponse({ content: `❌ No trainer matches found for "${rpgUsername}".` });
          return;
        }
        if (matches.length > 1) {
          const lines = matches.map((m) => `• ${m.name} — ${m.id}`);
          await editResponse({
            content:
              `⚠️ Multiple trainer matches found for "${rpgUsername}". ` +
              "Please refine your search or use the `ids` option.\n" +
              lines.join("\n"),
          });
          return;
        }
        resolvedIds = [matches[0].id];
      } else {
        const resolvedUser = targetUser || interaction.user;
        const savedIds = await loadUserIds({
          guildId: interaction.guildId,
          userId: resolvedUser.id,
        });

        if (!savedIds.length) {
          await editResponse({ content: `❌ <@${resolvedUser.id}> has not set an ID.` });
          return;
        }

        if (savedIds.length > 1 && !allSaved) {
          const labels = savedIds.map((entry) =>
            entry.label ? `${entry.id} (${entry.label})` : String(entry.id)
          );
          await editResponse({
            content:
              `⚠️ Multiple saved IDs found for <@${resolvedUser.id}>.\n` +
              `Use \`ids\` to select specific IDs or set \`all_saved: true\`.\n` +
              labels.map((l) => `• ${l}`).join("\n"),
          });
          return;
        }

        resolvedIds = savedIds.map((entry) => entry.id);
      }

      if (!resolvedIds.length) {
        await editResponse({ content: "❌ No valid IDs provided." });
        return;
      }

      const ueugLoaded = await loadUEUGSet();
      const junkLists = opts.filterJunk ? await loadJunkSets() : null;

      let combinedEntries = [];
      const perIdOutputs = [];
      const failures = [];

      for (const id of resolvedIds) {
        try {
          const rawEntries = await fetchViewboxEntries(getClient(), id);
          if (!rawEntries.length) {
            failures.push({ id, reason: "no Pokemon found" });
            continue;
          }

          let entries = buildOrganizerEntries(rawEntries);
          if (opts.filterJunk && junkLists) {
            entries = entries.filter((e) => !shouldFilterAsJunk(e, opts, junkLists));
          }

          if (!entries.length) {
            failures.push({ id, reason: "no entries after filtering" });
            continue;
          }

          if (splitOutputs) {
            const output = organize(entries, legendSet, opts, colors, ueugLoaded);
            if (!output) {
              failures.push({ id, reason: "no output generated" });
              continue;
            }
            perIdOutputs.push({
              label: `ID ${id}`,
              output,
              filename: `sorted-box-${id}.txt`,
            });
          } else {
            combinedEntries = combinedEntries.concat(entries);
          }
        } catch {
          failures.push({ id, reason: "fetch failed" });
        }
      }

      if (!splitOutputs && !combinedEntries.length) {
        const details = failures.length
          ? failures.map((f) => `• ${f.id}: ${f.reason}`).join("\n")
          : "";
        await editResponse({
          content: `❌ Failed to generate output.${details ? `\n${details}` : ""}`,
        });
        return;
      }

      if (splitOutputs && !perIdOutputs.length) {
        const details = failures.length
          ? failures.map((f) => `• ${f.id}: ${f.reason}`).join("\n")
          : "";
        await editResponse({
          content: `❌ Failed to generate output.${details ? `\n${details}` : ""}`,
        });
        return;
      }

      let outputs;
      let label;
      if (splitOutputs) {
        outputs = perIdOutputs;
        label = `${perIdOutputs.length} ID(s)`;
      } else {
        const output = organize(combinedEntries, legendSet, opts, colors, ueugLoaded);
        if (!output) {
          await editResponse({ content: "❌ No output was generated from those IDs." });
          return;
        }
        const multiple = resolvedIds.length > 1;
        label = multiple ? `${resolvedIds.length} IDs` : `ID ${resolvedIds[0]}`;
        const filename = multiple ? "sorted-box.txt" : `sorted-box-${resolvedIds[0]}.txt`;
        outputs = [{ label, output, filename }];
      }

      const res = await sendSortboxDm({
        user: interaction.user,
        outputs,
      });
      if (!res.ok) {
        if (res.code === 50007) {
          await editResponse({
            content: "❌ I couldn't DM you. Please enable DMs from server members and try again.",
          });
          return;
        }
        await editResponse({ content: "❌ Failed to DM your sorted box output." });
        return;
      }

      const failNote = failures.length
        ? `\n⚠️ Skipped: ${failures.map((f) => `${f.id} (${f.reason})`).join(", ")}`
        : "";
      await editResponse({
        content: `✅ Sent sorted BBCode via DM for ${label}.${failNote}`,
      });
    }
  );
}

export const __testables = {
  organize,
  buildLegendSet,
  shouldFilterAsJunk,
  buildOrganizerEntries,
  parseIdList,
};
