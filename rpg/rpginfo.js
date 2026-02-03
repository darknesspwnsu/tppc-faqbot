// rpg/rpginfo.js
//
// Fetch and cache RPG info helpers (SS Anne + Training Challenge).

import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "node-html-parser";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { createRpgClientFactory } from "./client_factory.js";
import { requireRpgCredentials, hasRpgCredentials } from "./credentials.js";
import { getLeaderboard, upsertLeaderboard } from "./storage.js";
import { findPokedexEntry, parsePokemonQuery } from "./pokedex.js";
import { normalizeKey } from "../shared/pokename_utils.js";
import {
  buildDidYouMeanButtons,
  buildDidYouMeanCustomId,
  splitDidYouMeanCustomId,
  enforceDidYouMeanUser,
} from "../shared/did_you_mean.js";
import { logger } from "../shared/logger.js";
import { registerScheduler } from "../shared/scheduler_registry.js";

const SS_ANNE_URL = "https://www.tppcrpg.net/ss_anne.php";
const TC_URL = "https://www.tppcrpg.net/training_challenge.php";
const SS_ANNE_KEY = "rpginfo:ssanne";
const TC_INELIGIBLE_KEY = "rpginfo:tc_ineligible";

const SS_ANNE_TTL_MS = 24 * 60 * 60_000;
const TC_INELIGIBLE_TTL_MS = 7 * 24 * 60 * 60_000;

const EVOLUTION_PATH = path.resolve("data/pokemon_evolutions.json");
const TRAINING_GYMS_PATH = path.resolve("data/training_gyms.json");

let evolutionBaseByName = null; // { normalizedName: normalizedBase }
let trainingGymsCache = null;

function getText(node) {
  if (!node) return "";
  return String(node.text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(name) {
  return normalizeKey(String(name || ""));
}

function buildRpgInfoRetryCustomId(baseRest, name, userId) {
  const enc = (s) => encodeURIComponent(String(s ?? "").slice(0, 120));
  const rest = `${baseRest} ${name}`.trim();
  return buildDidYouMeanCustomId("rpginfo_retry", userId, enc(rest));
}

function buildRpgInfoDidYouMeanButtons(suggestions, baseRest, userId) {
  return buildDidYouMeanButtons(suggestions, (name) => ({
    label: name,
    customId: buildRpgInfoRetryCustomId(baseRest, name, userId),
  }));
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

function isTppcDaytime(now = new Date()) {
  const easternTime = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const easternDate = new Date(easternTime);
  const hour = easternDate.getHours();
  return hour >= 6 && hour < 18;
}

function formatInt(value) {
  return Number(value).toLocaleString("en-US");
}

async function loadEvolutionMap() {
  if (evolutionBaseByName) return evolutionBaseByName;

  try {
    const raw = await fs.readFile(EVOLUTION_PATH, "utf8");
    const data = JSON.parse(raw);
    const baseByName = data?.base_by_name || {};
    const normalized = {};
    for (const [key, value] of Object.entries(baseByName)) {
      const normKey = normalizeName(key);
      if (!normKey) continue;
      normalized[normKey] = String(value || key);
    }
    evolutionBaseByName = normalized;
    return normalized;
  } catch (err) {
    console.error("[rpg] failed to load evolution data:", err);
    evolutionBaseByName = {};
    return evolutionBaseByName;
  }
}

async function loadTrainingGyms() {
  if (trainingGymsCache) return trainingGymsCache;
  try {
    const raw = await fs.readFile(TRAINING_GYMS_PATH, "utf8");
    const data = JSON.parse(raw);
    const rows = Array.isArray(data?.data) ? data.data : [];
    trainingGymsCache = rows
      .map((row) => ({
        name: String(row?.name ?? "").trim(),
        number: Number(row?.number),
        expDay: Number(row?.expDay),
        expNight: Number(row?.expNight),
        level: row?.level ? String(row.level).trim() : "",
      }))
      .filter(
        (row) =>
          row.name &&
          Number.isFinite(row.number) &&
          Number.isFinite(row.expDay) &&
          Number.isFinite(row.expNight)
      );
  } catch (err) {
    console.error("[rpg] failed to load training gyms:", err);
    trainingGymsCache = [];
  }
  return trainingGymsCache;
}

async function resolvePokemonName(raw) {
  const direct = await findPokedexEntry(raw);
  if (direct?.entry?.name) {
    return { name: direct.entry.name, variant: "", suggestions: [] };
  }

  const parsed = parsePokemonQuery(raw);
  const base = parsed.base || raw;
  const baseResult = base === raw ? direct : await findPokedexEntry(base);
  if (baseResult?.entry?.name) {
    return { name: baseResult.entry.name, variant: parsed.variant || "", suggestions: [] };
  }

  const suggestions = [];
  const seen = new Set();
  for (const list of [direct?.suggestions, baseResult?.suggestions]) {
    for (const name of list || []) {
      const key = String(name || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      suggestions.push(name);
      if (suggestions.length >= 5) break;
    }
    if (suggestions.length >= 5) break;
  }

  return { name: null, variant: parsed.variant || "", suggestions };
}

function isBaseEvolution(name, baseByName) {
  const norm = normalizeName(name);
  if (!norm) return true;
  const base = baseByName?.[norm];
  if (!base) return true;
  return base === norm;
}

function parseBattleThreshold(html) {
  const root = parse(String(html || ""));
  const text = getText(root);
  const match = /more than\s+([\d,]+)\s+battles/i.exec(text);
  if (!match) return null;
  const count = Number(String(match[1]).replace(/,/g, ""));
  if (!Number.isFinite(count)) return null;
  return count + 1;
}

function parseTrainingChallengeIneligible(html) {
  const root = parse(String(html || ""));
  const paragraphs = root.querySelectorAll("p");
  for (const p of paragraphs) {
    const text = getText(p);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!lower.includes("ineligible") || !lower.includes("training challenge")) continue;
    const idx = text.indexOf(":");
    if (idx === -1) continue;
    const listText = text.slice(idx + 1).trim();
    if (!listText) continue;
    return listText
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  return null;
}

function isStale(updatedAtMs, ttlMs) {
  if (!updatedAtMs) return true;
  return Date.now() - updatedAtMs > ttlMs;
}

async function getCachedPayload(key, ttlMs) {
  const cached = await getLeaderboard({ challenge: key });
  if (!cached?.payload) return null;
  if (ttlMs && isStale(cached.updatedAt, ttlMs)) return null;
  return { payload: cached.payload, updatedAt: cached.updatedAt };
}

async function fetchAndStoreSsAnne(client) {
  const html = await client.fetchPage(SS_ANNE_URL);
  const battles = parseBattleThreshold(html);
  if (!battles) throw new Error("SS Anne battle threshold not found.");
  await upsertLeaderboard({ challenge: SS_ANNE_KEY, payload: { battles } });
  return battles;
}

async function fetchAndStoreTrainingChallengeIneligible(client) {
  const html = await client.fetchPage(TC_URL);
  const list = parseTrainingChallengeIneligible(html);
  if (!list || !list.length) {
    throw new Error("Training Challenge ineligible list not found.");
  }
  await upsertLeaderboard({ challenge: TC_INELIGIBLE_KEY, payload: { list } });
  return list;
}

async function getSsAnneBattles(client) {
  const cached = await getCachedPayload(SS_ANNE_KEY, SS_ANNE_TTL_MS);
  if (cached?.payload?.battles) return cached.payload.battles;
  return await fetchAndStoreSsAnne(client);
}

async function getTrainingChallengeIneligible(client) {
  const cached = await getCachedPayload(TC_INELIGIBLE_KEY, TC_INELIGIBLE_TTL_MS);
  if (cached?.payload?.list?.length) return cached.payload.list;
  return await fetchAndStoreTrainingChallengeIneligible(client);
}

function getEtDateKey() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getEtHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? Number(hourPart.value) : null;
}

function scheduleTrainingChallengeIneligible(client) {
  let lastRunDate = null;

  async function tick() {
    const hour = getEtHour();
    if (hour == null || hour < 9) return;
    const dateKey = getEtDateKey();
    if (lastRunDate === dateKey) return;
    lastRunDate = dateKey;

    try {
      const cached = await getLeaderboard({ challenge: TC_INELIGIBLE_KEY });
      if (cached?.updatedAt && !isStale(cached.updatedAt, TC_INELIGIBLE_TTL_MS)) return;
      await fetchAndStoreTrainingChallengeIneligible(client);
    } catch (err) {
      logger.error("rpginfo.tc.refresh.error", { error: logger.serializeError(err) });
      console.error("[rpg] failed to refresh training challenge ineligible list:", err);
    }
  }

  tick();
  setInterval(tick, 10 * 60_000);
}

export function registerRpgInfo(register) {
  const cmd = "!rpginfo";
  const getClient = createRpgClientFactory();

  register(
    cmd,
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!requireRpgCredentials(cmd)) {
        await message.reply("❌ RPG credentials are not configured.");
        return;
      }

      const raw = String(rest || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = String(parts[0] || "").toLowerCase();

      if (!sub || sub === "help") {
        await message.reply(
          [
            "**RPG info options:**",
            `• \`${cmd} ssanne\` — SS Anne Golden Volcanion requirement`,
            `• \`${cmd} tc\` — Training Challenge ineligible list`,
            `• \`${cmd} tc iseligible <pokemon>\` — Check Training Challenge eligibility`,
            `• \`${cmd} tc eligible <pokemon>\` — Check Training Challenge eligibility`,
            `• \`${cmd} traininggyms [count]\` — Top training gyms by exp`,
          ].join("\n")
        );
        return;
      }

      if (sub === "traininggyms" || sub === "gyms") {
        const countRaw = parts[1];
        const requested = countRaw ? Number(countRaw) : 5;
        if (!Number.isFinite(requested) || requested <= 0) {
          await message.reply(`Usage: \`${cmd} traininggyms [count]\``);
          return;
        }
        const maxCount = 25;
        const count = Math.min(Math.floor(requested), maxCount);
        const gyms = await loadTrainingGyms();
        if (!gyms.length) {
          await message.reply("❌ Unable to load training gyms right now.");
          return;
        }

        const useNight = !isTppcDaytime();
        const expKey = useNight ? "expNight" : "expDay";
        const sorted = gyms
          .slice()
          .sort((a, b) => Number(b[expKey]) - Number(a[expKey]));
        const top = sorted.slice(0, Math.min(count, sorted.length));
        const timeLabel = useNight ? "NIGHT" : "DAY";
        const lines = [
          `**Top Training Gyms (TPPC ${timeLabel})** — showing ${top.length}`,
        ];
        for (const [idx, gym] of top.entries()) {
          const exp = formatInt(gym[expKey]);
          const levelSuffix = gym.level ? ` (Lvl ${gym.level})` : "";
          lines.push(
            `${idx + 1}. ${gym.name} (#${gym.number}) — ${exp} EXP/battle${levelSuffix}`
          );
        }
        await message.reply(lines.join("\n"));
        return;
      }

      if (sub === "ssanne") {
        try {
          const battles = await getSsAnneBattles(getClient());
          await message.reply(
            `Number of battles required to win GoldenVolcanion: ${battles.toLocaleString("en-US")}`
          );
        } catch (err) {
          logger.error("rpginfo.ssanne.error", { error: logger.serializeError(err) });
          console.error("[rpg] failed to load SS Anne info:", err);
          await message.reply("❌ Unable to load SS Anne info right now.");
        }
        return;
      }

      if (sub === "tc" || sub === "training" || sub === "trainingchallenge") {
        const tail = parts.slice(1);
        const tailLower = tail.map((t) => t.toLowerCase());
        const isEligibleIndex = tailLower.indexOf("iseligible");
        const eligibleIndex = tailLower.indexOf("eligible");
        const markerIndex = isEligibleIndex >= 0 ? isEligibleIndex : eligibleIndex;
        const client = getClient();

        try {
          if (markerIndex >= 0) {
            const nameTokens = tail.slice(markerIndex + 1);
            if (!nameTokens.length) {
              await message.reply(`Usage: \`${cmd} tc iseligible <pokemon>\``);
              return;
            }
            const nameRaw = nameTokens.join(" ").trim();
            const resolved = await resolvePokemonName(nameRaw);
            if (!resolved.name) {
              if (resolved.suggestions?.length) {
                const baseRest = `tc ${tail[markerIndex]}`;
                await message.reply({
                  content: `❌ Unknown Pokemon name: **${nameRaw}**.\nDid you mean:`,
                  components: buildRpgInfoDidYouMeanButtons(
                    resolved.suggestions,
                    baseRest,
                    message?.author?.id
                  ),
                });
              } else {
                await message.reply(`❌ Unknown Pokemon name: **${nameRaw}**.`);
              }
              return;
            }

            const baseByName = await loadEvolutionMap();
            const baseName = baseByName?.[normalizeName(resolved.name)] || resolved.name;

            const ineligible = await getTrainingChallengeIneligible(client);
            const bannedSet = new Set(ineligible.map(normalizeName));
            const normBase = normalizeName(baseName);
            const isBase = normalizeName(resolved.name) === normBase;
            const isBanned = bannedSet.has(normBase);

            if (!isBase) {
              if (isBanned) {
                await message.reply(
                  `No — **${resolved.name}**'s base evolution **${baseName}** is ineligible for this week's Training Challenge.`
                );
              } else {
                await message.reply(
                  `**${resolved.name}**'s base evolution **${baseName}** might be eligible for this week's Training Challenge if it either evolves through the Pokemon Center, or is a basic pokemon that does not evolve.`
                );
              }
              return;
            }

            if (isBanned) {
              await message.reply(
                `No — **${baseName}** is ineligible for this week's Training Challenge.`
              );
              return;
            }

            await message.reply(
              `**${baseName}** might be eligible for this week's Training Challenge if it either evolves through the Pokemon Center, or is a basic pokemon that does not evolve.`
            );
            return;
          }

          const list = await getTrainingChallengeIneligible(client);
          await message.reply(
            `Ineligible for this month's Training Challenge: ${list.join(", ")}`
          );
        } catch (err) {
          logger.error("rpginfo.tc.error", { error: logger.serializeError(err) });
          console.error("[rpg] failed to load Training Challenge info:", err);
          await message.reply("❌ Unable to load Training Challenge info right now.");
        }
        return;
      }

      await message.reply(
        `Usage: \`${cmd} ssanne|tc|trainingchallenge\` or \`${cmd} tc iseligible <pokemon>\``
      );
    },
    `${cmd} <topic> — show SS Anne or Training Challenge info`,
    { aliases: ["!info"] }
  );
}

export function registerRpgInfoScheduler() {
  registerScheduler("rpginfo_training_challenge", () => {
    if (!hasRpgCredentials()) return;
    const client = createRpgClientFactory()();
    scheduleTrainingChallengeIneligible(client);
  });
}

export async function handleRpgInfoInteraction(interaction) {
  if (!interaction?.isButton?.()) return false;

  const id = String(interaction.customId || "");
  const parsed = splitDidYouMeanCustomId("rpginfo_retry", id);
  if (!parsed) return false;
  if (!(await enforceDidYouMeanUser(interaction, parsed.userId))) return false;

  const rest = decodeURIComponent(parsed.payload || "");
  await disableInteractionButtons(interaction);
  return { cmd: "!rpginfo", rest };
}

export const __testables = {
  parseBattleThreshold,
  parseTrainingChallengeIneligible,
  isBaseEvolution,
  normalizeName,
};
