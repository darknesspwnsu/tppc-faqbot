// rpg/pokedex.js
//
// Lookup helpers for TPPC pokedex name -> key (e.g. "004-0").

import fs from "node:fs/promises";
import path from "node:path";

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  getSuggestionsFromIndex,
  normalizeKey,
  normalizeQueryVariants,
  queryVariantPrefix,
} from "../shared/pokename_utils.js";
import { parse } from "node-html-parser";
import { RpgClient } from "./rpg_client.js";
import { getPokedexEntry, upsertPokedexEntry } from "./storage.js";

const POKEDEX_PATH = path.resolve("data/pokedex_map.json");
const POKEDEX_TTL_MS = 30 * 24 * 60 * 60_000;
const EVOLUTION_PATH = path.resolve("data/pokemon_evolutions.json");

let pokedex = null; // { name: key }
let pokedexLower = null; // { lowerName: entry }
let pokedexNorm = null; // { normalizedKey: entry }
let evolutionCache = null; // { baseByName }

function hasRpgCredentials() {
  return Boolean(process.env.RPG_USERNAME && process.env.RPG_PASSWORD);
}

async function ensureRpgCredentials(message, cmd) {
  if (hasRpgCredentials()) return true;
  console.error(`[rpg] RPG_USERNAME/RPG_PASSWORD not configured for ${cmd}`);
  await message.reply("❌ RPG credentials are not configured.");
  return false;
}

function getText(node) {
  if (!node) return "";
  return String(node.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpriteUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function parseSpriteUrl(styleText) {
  const text = String(styleText || "");
  const urlIndex = text.indexOf("url(");
  if (urlIndex < 0) return "";
  let start = urlIndex + 4;
  let end = text.indexOf(")", start);
  if (end < 0) return "";
  let url = text.slice(start, end).trim();
  if ((url.startsWith("'") && url.endsWith("'")) || (url.startsWith("\"") && url.endsWith("\""))) {
    url = url.slice(1, -1);
  }
  return normalizeSpriteUrl(url);
}

async function loadEvolutionMap() {
  if (evolutionCache?.baseByName) return evolutionCache.baseByName;

  try {
    const raw = await fs.readFile(EVOLUTION_PATH, "utf8");
    const data = JSON.parse(raw);
    const baseByName = data?.base_by_name || {};
    evolutionCache = { baseByName };
    return baseByName;
  } catch (err) {
    console.error("[rpg] failed to load evolution data:", err);
    return evolutionCache?.baseByName || null;
  }
}

function resolveBaseEvolutionName(name, baseByName) {
  if (!name || !baseByName) return null;
  const lower = String(name).toLowerCase();
  if (baseByName[lower]) return baseByName[lower];

  const { base } = parsePokemonQuery(name);
  if (base) {
    const baseLower = String(base).toLowerCase();
    if (baseByName[baseLower]) return baseByName[baseLower];
  }

  return name;
}
function parseStatsTable(table) {
  const rows = table?.querySelectorAll?.("tr") || [];
  let firstHeader = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const ths = rows[i].querySelectorAll?.("th") || [];
    const labels = ths.map((th) => getText(th).toLowerCase());
    if (labels.includes("hp") && labels.includes("attack") && labels.includes("defense")) {
      firstHeader = i;
      break;
    }
  }
  if (firstHeader < 0) return null;

  const row1 = rows[firstHeader + 1];
  const row2 = rows[firstHeader + 2];
  const row3 = rows[firstHeader + 3];
  if (!row1 || !row2 || !row3) return null;

  const baseVals = (row1.querySelectorAll?.("td") || []).map((td) => getText(td));
  const speedHeaders = (row2.querySelectorAll?.("th") || []).map((th) => getText(th).toLowerCase());
  const speedVals = (row3.querySelectorAll?.("td") || []).map((td) => getText(td));
  if (baseVals.length < 3 || speedVals.length < 3) return null;
  if (!speedHeaders.includes("speed") || !speedHeaders.includes("spec attack") || !speedHeaders.includes("spec defense")) {
    return null;
  }

  return {
    hp: baseVals[0],
    attack: baseVals[1],
    defense: baseVals[2],
    speed: speedVals[0],
    spAttack: speedVals[1],
    spDefense: speedVals[2],
  };
}

function parseTypeTable(table) {
  const rows = table?.querySelectorAll?.("tr") || [];
  if (rows.length < 2) return null;
  const headers = (rows[0].querySelectorAll?.("th") || []).map((th) => getText(th).toLowerCase());
  if (!headers.includes("type 1") || !headers.includes("type 2")) return null;
  const values = (rows[1].querySelectorAll?.("td") || []).map((td) => getText(td));
  if (values.length < 4) return null;
  return {
    type1: values[0],
    type2: values[1],
    group1: values[2],
    group2: values[3],
  };
}

function parsePokedexEntryHtml(html) {
  const root = parse(String(html || ""));
  const title = getText(root.querySelector("h3"));
  const tables = root.querySelectorAll("table");
  let stats = null;
  let types = null;
  for (const table of tables) {
    if (!stats) stats = parseStatsTable(table);
    if (!types) types = parseTypeTable(table);
    if (stats && types) break;
  }

  const sprites = {};
  const box = root.querySelector("td.iBox");
  const spriteNodes = box ? box.querySelectorAll("div") : [];
  for (const node of spriteNodes) {
    const url = parseSpriteUrl(node.getAttribute("style"));
    if (!url) continue;
    const labelNode = node.querySelector("p") || node.nextElementSibling;
    const labelText = labelNode?.rawTagName === "p" ? getText(labelNode).toLowerCase() : "";
    const labelBase = labelText.split(/\s+/)[0] || "";
    if (labelBase && !sprites[labelBase]) sprites[labelBase] = url;
    if (labelText && !sprites[labelText]) sprites[labelText] = url;
    if (!labelBase && !Object.keys(sprites).length) sprites.normal = url;
  }
  return { title, stats, types, sprites };
}

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

async function getCachedPokedexEntry({ cacheKey, url, client }) {
  const cached = await getPokedexEntry({ entryKey: cacheKey });
  const now = Date.now();
  const stale = !cached?.updatedAt || now - cached.updatedAt > POKEDEX_TTL_MS;
  const hasSprites = cached?.payload?.sprites && Object.keys(cached.payload.sprites).length > 0;
  if (!cached || stale || !cached.payload || !hasSprites) {
    const html = await client.fetchPage(url);
    const payload = parsePokedexEntryHtml(html);
    await upsertPokedexEntry({ entryKey: cacheKey, payload });
    return { payload, updatedAt: Date.now() };
  }
  return { payload: cached.payload, updatedAt: cached.updatedAt || null };
}

function parseEntryKey(entryKey) {
  const [idRaw, formRaw] = String(entryKey || "").split("-");
  const id = idRaw ? Number(idRaw) : null;
  const form = formRaw ? Number(formRaw) : 0;
  return { id, form };
}

function pickSpriteUrl(sprites, variant) {
  const key = String(variant || "normal").toLowerCase();
  if (!sprites) return "";
  if (sprites[key]) return sprites[key];
  const fallback = Object.entries(sprites).find(([label]) => label.startsWith(key));
  if (fallback?.[1]) return fallback[1];
  if (sprites.normal) return sprites.normal;
  const first = Object.values(sprites)[0];
  return first || "";
}

function statsToFields(stats, variant) {
  if (!stats) return [{ name: "Stats", value: "Unknown" }];
  const modifier = statBonusLabel(variant);
  const fmt = (value) => {
    const raw = String(value || "-");
    if (!modifier || raw === "-") return raw;
    return `${raw}(${modifier})`;
  };
  return [
    { name: "HP", value: fmt(stats.hp), inline: true },
    { name: "Atk", value: fmt(stats.attack), inline: true },
    { name: "Def", value: fmt(stats.defense), inline: true },
    { name: "Spd", value: fmt(stats.speed), inline: true },
    { name: "SpA", value: fmt(stats.spAttack), inline: true },
    { name: "SpD", value: fmt(stats.spDefense), inline: true },
  ];
}

function formatTypes(types) {
  if (!types) return "Unknown";
  const parts = [types.type1, types.type2].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Unknown";
}

function formatEggGroups(types) {
  if (!types) return "Unknown";
  const normalize = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "no eggs") return "None";
    return raw;
  };
  const parts = [normalize(types.group1), normalize(types.group2)].filter(Boolean);
  return parts.length ? parts.join(" / ") : "None";
}

function statBonusLabel(variant) {
  const key = String(variant || "normal").toLowerCase();
  if (key === "shiny") return "+5";
  if (key === "golden") return "+15";
  if (key === "dark") return "+15/-4";
  return "";
}

function sumBaseStats(stats) {
  if (!stats) return null;
  const values = [
    stats.hp,
    stats.attack,
    stats.defense,
    stats.spAttack,
    stats.spDefense,
    stats.speed,
  ].map((v) => Number(v));
  if (values.some((v) => !Number.isFinite(v))) return null;
  return values.reduce((a, b) => a + b, 0);
}

function formatEggTimeFromTotal(total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const toHms = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return [h, m, r].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const normal = toHms(total * 30);
  const pp = toHms(Math.floor(total / 2) * 30);
  return { normal, pp };
}
function buildPokedexEmbed({ title, url, stats, types, spriteUrl, variant }) {
  const embed = {
    title: title || "Pokedex Entry",
    url,
    color: 0x2b2d31,
    fields: [
      ...statsToFields(stats, variant),
      { name: "Type", value: formatTypes(types), inline: true },
      { name: "Egg Group", value: formatEggGroups(types), inline: true },
    ],
  };
  if (spriteUrl) {
    embed.thumbnail = { url: spriteUrl };
  }
  if (variant && variant !== "normal") {
    embed.footer = { text: `Sprite: ${variant.charAt(0).toUpperCase() + variant.slice(1)}` };
  }
  return embed;
}

function formatVariantLabel(variant) {
  if (!variant || variant === "normal") return "";
  return variant[0].toUpperCase() + variant.slice(1);
}

function formatVariantName(variant, name) {
  const prefix = formatVariantLabel(variant);
  if (!prefix) return name;
  const lower = String(name || "").toLowerCase();
  if (lower.startsWith(prefix.toLowerCase())) return name;
  return `${prefix}${name}`;
}

function buildPokedexSuggestions(suggestions, variant) {
  return suggestions.map((name) => {
    const label = formatVariantName(variant, name);
    return { label, query: label };
  });
}

function buildPokedexDidYouMeanButtons(suggestions) {
  const enc = (s) => encodeURIComponent(String(s ?? "").slice(0, 80));

  const row = new ActionRowBuilder().addComponents(
    suggestions.slice(0, 5).map(({ label, query }) =>
      new ButtonBuilder()
        .setCustomId(`pokedex_retry:${enc(query)}`)
        .setLabel(label.length > 80 ? label.slice(0, 77) + "…" : label)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return [row];
}

async function resolvePokedexEntryQuery(nameRaw, variant, message) {
  let lookup = nameRaw;
  let result = await findPokedexEntry(lookup);
  if (variant) {
    const parsed = parsePokemonQuery(nameRaw);
    lookup = parsed.base || nameRaw;
    result = await findPokedexEntry(lookup);
    if (!result.entry && variant) {
      const fallback = await findPokedexEntry(nameRaw);
      if (fallback.entry || fallback.suggestions.length) {
        result = fallback;
        if (fallback.entry) {
          variant = "normal";
        }
      }
    }
  }

  const { entry, suggestions } = result;
  if (!entry) {
    if (suggestions.length) {
      const refined = buildPokedexSuggestions(suggestions, variant);
      await message.reply({
        content: `❌ Unknown Pokemon name: **${nameRaw}**.\nDid you mean:`,
        components: buildPokedexDidYouMeanButtons(refined),
      });
    } else {
      await message.reply(`❌ Unknown Pokemon name: **${nameRaw}**.`);
    }
    return null;
  }

  return { entry, variant };
}

async function fetchPokedexPayload(entry, client) {
  const { id, form } = parseEntryKey(entry.key);
  if (!Number.isFinite(id)) {
    return { error: `❌ Could not parse Pokedex entry for **${entry.name}**.` };
  }
  const url = `https://www.tppcrpg.net/pokedex_entry.php?id=${id}&t=${Number.isFinite(form) ? form : 0}`;
  const cacheKey = `pokedex:${entry.key}`;
  const { payload } = await getCachedPokedexEntry({ cacheKey, url, client });
  return { payload, url };
}

async function fetchBasePayload(entry, payload, client) {
  const baseByName = await loadEvolutionMap();
  const baseName = resolveBaseEvolutionName(entry.name, baseByName);
  const baseLookup = baseName || entry.name;
  const baseResult = await findPokedexEntry(baseLookup);
  const baseEntry = baseResult?.entry || null;
  let basePayload = payload;
  if (baseEntry && baseEntry.key !== entry.key) {
    const { id: baseId, form: baseForm } = parseEntryKey(baseEntry.key);
    if (Number.isFinite(baseId)) {
      const baseUrl = `https://www.tppcrpg.net/pokedex_entry.php?id=${baseId}&t=${Number.isFinite(baseForm) ? baseForm : 0}`;
      const baseCacheKey = `pokedex:${baseEntry.key}`;
      const baseCached = await getCachedPokedexEntry({
        cacheKey: baseCacheKey,
        url: baseUrl,
        client,
      });
      basePayload = baseCached?.payload || basePayload;
    }
  }

  return { baseEntry, baseName, basePayload };
}

async function disableInteractionButtons(interaction) {
  const rows = interaction.message?.components || [];
  if (!rows.length) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const disabledRows = rows.map((row) => {
    const newRow = new ActionRowBuilder();
    for (const component of row.components || []) {
      let button = null;
      if (typeof ButtonBuilder.from === "function") {
        try {
          button = ButtonBuilder.from(component);
        } catch {}
      }
      if (!button || typeof button.setDisabled !== "function") {
        const customId = component?.customId ?? component?.custom_id ?? "";
        const label = component?.label ?? component?.data?.label ?? "";
        const style = component?.style ?? component?.data?.style ?? ButtonStyle.Secondary;
        button = new ButtonBuilder();
        if (customId) button.setCustomId(customId);
        if (label) button.setLabel(label);
        if (style) button.setStyle(style);
        if (component?.emoji) button.setEmoji(component.emoji);
      }
      if (typeof button.setDisabled === "function") {
        button.setDisabled(true);
      }
      newRow.addComponents(button);
    }
    return newRow;
  });

  await interaction.update({ components: disabledRows }).catch(async () => {
    await interaction.deferUpdate().catch(() => {});
  });
}

export function registerPokedex(register) {
  const primaryCmd = "!pokedex";
  const statsCmd = "!stats";
  const eggCmd = "!eggtime";
  let client = null;
  const getClient = () => {
    if (!client) client = new RpgClient();
    return client;
  };

  register(
    primaryCmd,
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!(await ensureRpgCredentials(message, primaryCmd))) return;

      const nameRaw = String(rest || "").trim();
      if (!nameRaw || nameRaw.toLowerCase() === "help") {
        await message.reply(`Usage: \`${primaryCmd} <pokemon name>\``);
        return;
      }

      let { variant } = parsePokemonQuery(nameRaw);
      if (!variant) variant = "normal";
      const resolved = await resolvePokedexEntryQuery(nameRaw, variant, message);
      if (!resolved) return;
      const { entry } = resolved;
      variant = resolved.variant;

      try {
        const { payload, url, error } = await fetchPokedexPayload(entry, getClient());
        if (error) {
          await message.reply(error);
          return;
        }
        const title = payload?.title || entry.name;
        const spriteUrl = pickSpriteUrl(payload?.sprites, variant);
        const embed = buildPokedexEmbed({
          title,
          url,
          stats: payload?.stats,
          types: payload?.types,
          spriteUrl,
          variant,
        });

        const { baseEntry, baseName, basePayload } = await fetchBasePayload(entry, payload, getClient());
        if (baseEntry) {
          const total = sumBaseStats(basePayload?.stats);
          const eggTime = formatEggTimeFromTotal(total);
          const eggGroup = formatEggGroups(payload?.types);
          const canBreed = eggGroup !== "None";
          let eggValue = !canBreed
            ? "Cannot breed"
            : eggTime
              ? `${eggTime.normal} (normal)\n${eggTime.pp} (Power Plant)`
              : "Unknown";
          if (typeof eggValue !== "string") eggValue = String(eggValue);
          const baseLabel = baseName && baseName !== entry.name ? ` (Base: ${baseName})` : "";
          embed.fields.push({ name: `Egg Time${baseLabel}`, value: eggValue });
        }
        await message.reply({ embeds: [embed] });
      } catch (err) {
        console.error("[rpg] pokedex fetch failed:", err);
        await message.reply("❌ Failed to fetch pokedex entry. Please try again later.");
      }
    },
    "!pokedex <pokemon> — show TPPC RPG pokedex details",
    { helpTier: "primary", category: "RPG" }
  );

  register(
    statsCmd,
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!(await ensureRpgCredentials(message, statsCmd))) return;

      const nameRaw = String(rest || "").trim();
      if (!nameRaw || nameRaw.toLowerCase() === "help") {
        await message.reply(`Usage: \`${statsCmd} <pokemon name>\``);
        return;
      }

      let { variant } = parsePokemonQuery(nameRaw);
      if (!variant) variant = "normal";
      const resolved = await resolvePokedexEntryQuery(nameRaw, variant, message);
      if (!resolved) return;
      const { entry } = resolved;
      variant = resolved.variant;

      try {
        const { payload, error } = await fetchPokedexPayload(entry, getClient());
        if (error) {
          await message.reply(error);
          return;
        }
        const fields = statsToFields(payload?.stats, variant);
        const total = sumBaseStats(payload?.stats);
        const label = formatVariantName(variant, entry.name);
        const lines = fields.map((field) => `${field.name}: ${field.value}`);
        if (Number.isFinite(total)) lines.push(`Total: ${total}`);
        await message.reply(`**${label}** stats:\n${lines.join("\n")}`);
      } catch (err) {
        console.error("[rpg] pokedex stats failed:", err);
        await message.reply("❌ Failed to fetch stats. Please try again later.");
      }
    },
    "!stats <pokemon> — show TPPC RPG base stats",
    { helpTier: "primary", category: "RPG" }
  );

  register(
    eggCmd,
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!(await ensureRpgCredentials(message, eggCmd))) return;

      const nameRaw = String(rest || "").trim();
      if (!nameRaw || nameRaw.toLowerCase() === "help") {
        await message.reply(`Usage: \`${eggCmd} <pokemon name>\``);
        return;
      }

      let { variant } = parsePokemonQuery(nameRaw);
      if (!variant) variant = "normal";
      const resolved = await resolvePokedexEntryQuery(nameRaw, variant, message);
      if (!resolved) return;
      const { entry } = resolved;

      try {
        const { payload, error } = await fetchPokedexPayload(entry, getClient());
        if (error) {
          await message.reply(error);
          return;
        }
        const { baseEntry, baseName, basePayload } = await fetchBasePayload(entry, payload, getClient());
        if (!baseEntry) {
          await message.reply("❌ Could not resolve base evolution for egg time.");
          return;
        }
        const total = sumBaseStats(basePayload?.stats);
        const eggTime = formatEggTimeFromTotal(total);
        const eggGroup = formatEggGroups(payload?.types);
        if (eggGroup === "None") {
          await message.reply("Cannot breed");
          return;
        }
        if (!eggTime) {
          await message.reply("Unknown egg time.");
          return;
        }
        const baseLabel = baseName && baseName !== entry.name ? baseName : entry.name;
        await message.reply(
          `Breeding times for ${entry.name} (Base evolution: ${baseLabel})\n` +
            `${eggTime.normal} (normal)\n` +
            `${eggTime.pp} (Power Plant)`
        );
      } catch (err) {
        console.error("[rpg] pokedex eggtime failed:", err);
        await message.reply("❌ Failed to fetch egg time. Please try again later.");
      }
    },
    "!eggtime <pokemon> — show TPPC RPG egg breeding time",
    { helpTier: "primary", category: "RPG", aliases: ["!egg", "!eggtimes", "!breedtime", "!breedtimes"] }
  );
}

export async function handlePokedexInteraction(interaction) {
  if (!interaction?.isButton?.()) return false;

  const id = String(interaction.customId || "");
  if (!id.startsWith("pokedex_retry:")) return false;

  const rest = decodeURIComponent(id.slice("pokedex_retry:".length));
  await disableInteractionButtons(interaction);

  return { cmd: "!pokedex", rest };
}

export const __testables = {
  parsePokemonQuery,
  parsePokedexEntryHtml,
  statsToFields,
  formatTypes,
  formatEggGroups,
  sumBaseStats,
  formatEggTimeFromTotal,
  resolveBaseEvolutionName,
  statBonusLabel,
  formatVariantName,
  buildPokedexSuggestions,
};
