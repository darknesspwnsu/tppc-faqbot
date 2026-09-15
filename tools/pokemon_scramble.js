// tools/pokemon_scramble.js
//
// Ambient Pokemon unscramble challenge with persisted guild settings and scores.

import fs from "node:fs";
import path from "node:path";

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { logger } from "../shared/logger.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { clearTimer, startInterval, startTimeout } from "../shared/timer_utils.js";
import { parseDurationSeconds } from "../shared/time_utils.js";

const POKEDEX_FILE = path.resolve("data/pokedex_map.json");

const DEFAULT_CADENCE_MINUTES = 120;
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_DELETE_FAILURE_SECONDS = 5;
const SCHEDULER_TICK_MS = 60_000;
const STARTUP_DELAY_MS = 5_000;
const MIN_CADENCE_MINUTES = 5;
const MAX_CADENCE_MINUTES = 7 * 24 * 60;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 120;
const MIN_POKEMON_LETTERS = 5;
const MAX_LEADERBOARD_LIMIT = 25;

const activeByGuild = new Map(); // guildId -> challenge state

let clientRef = null;
let schedulerBooted = false;
let schedulerTimer = null;
let startupTimer = null;
let tickInFlight = false;
let pokemonNameCache = null;

function normalizeGuess(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function shuffleLetters(letters) {
  for (let i = letters.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters;
}

function scrambleWord(word) {
  const original = String(word || "");
  const letters = original.split("");
  if (letters.length <= 1) return original;

  let out = original;
  for (let i = 0; i < 20 && normalizeGuess(out) === normalizeGuess(original); i += 1) {
    out = shuffleLetters([...letters]).join("");
  }
  return out;
}

function isEligiblePokemonName(name) {
  const s = String(name || "").trim();
  if (!s) return false;
  if (s.includes("(") || s.includes(")")) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z]+$/.test(s)) return false;
  const lowered = s.toLowerCase();
  if (lowered === "unown") return false;
  if (/^(shiny|dark|golden)/.test(lowered)) return false;
  return normalizeGuess(s).length >= MIN_POKEMON_LETTERS;
}

function loadPokemonNames() {
  if (pokemonNameCache) return pokemonNameCache;

  const raw = fs.readFileSync(POKEDEX_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const names = Object.keys(parsed)
    .filter(isEligiblePokemonName)
    .sort((a, b) => a.localeCompare(b));

  pokemonNameCache = names;
  return names;
}

function choosePokemonName() {
  const names = loadPokemonNames();
  if (!names.length) return null;
  return names[Math.floor(Math.random() * names.length)].toLowerCase();
}

function tokenizeArgs(input) {
  return String(input || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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
  const n = Number(String(raw || "").trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseMinutes(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const sec = /[a-z]/i.test(text) ? parseDurationSeconds(text, null) : Number(text) * 60;
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.round(sec / 60);
}

function parseSeconds(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const sec = /[a-z]/i.test(text) ? parseDurationSeconds(text, null) : Number(text);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.round(sec);
}

function buildCadencePatch({ minutes, enabled, nowMs = Date.now() }) {
  const patch = { cadenceMinutes: minutes };
  if (enabled) {
    patch.nextRunAtMs = Number(nowMs) + Number(minutes) * 60_000;
  }
  return patch;
}

function toSettings(row) {
  return {
    guildId: String(row.guild_id),
    channelId: row.channel_id ? String(row.channel_id) : null,
    enabled: Boolean(Number(row.enabled || 0)),
    cadenceMinutes: Number(row.cadence_minutes || DEFAULT_CADENCE_MINUTES),
    durationSeconds: Number(row.duration_seconds || DEFAULT_DURATION_SECONDS),
    nextRunAtMs: Number(row.next_run_at_ms || 0),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

async function ensureSettings({ guildId, channelId = null, updatedBy = "system" }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO pokemon_scramble_settings (
      guild_id, channel_id, enabled, cadence_minutes, duration_seconds, next_run_at_ms, updated_by
    ) VALUES (?, ?, 0, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)
    `,
    [
      String(guildId),
      channelId ? String(channelId) : null,
      DEFAULT_CADENCE_MINUTES,
      DEFAULT_DURATION_SECONDS,
      String(updatedBy || "system"),
    ]
  );
}

async function getSettings({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, duration_seconds, next_run_at_ms, updated_by
    FROM pokemon_scramble_settings
    WHERE guild_id = ?
    LIMIT 1
    `,
    [String(guildId)]
  );
  return rows?.[0] ? toSettings(rows[0]) : null;
}

async function updateSettings({ guildId, patch, updatedBy }) {
  await ensureSettings({ guildId, updatedBy });

  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const col = {
      channelId: "channel_id",
      enabled: "enabled",
      cadenceMinutes: "cadence_minutes",
      durationSeconds: "duration_seconds",
      nextRunAtMs: "next_run_at_ms",
    }[key];
    if (!col) continue;
    fields.push(`${col} = ?`);
    params.push(value);
  }
  fields.push("updated_by = ?");
  params.push(String(updatedBy || "system"));
  params.push(String(guildId));

  const db = getDb();
  await db.execute(
    `UPDATE pokemon_scramble_settings SET ${fields.join(", ")} WHERE guild_id = ?`,
    params
  );
  return getSettings({ guildId });
}

async function listDueSettings(nowMs) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, duration_seconds, next_run_at_ms, updated_by
    FROM pokemon_scramble_settings
    WHERE enabled = 1
      AND channel_id IS NOT NULL
      AND (next_run_at_ms = 0 OR next_run_at_ms <= ?)
    ORDER BY next_run_at_ms ASC
    LIMIT 20
    `,
    [Number(nowMs)]
  );
  return (rows || []).map(toSettings);
}

async function addScore({ guildId, userId, displayName }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO pokemon_scramble_scores (
      guild_id, user_id, display_name, score, last_win_at_ms
    ) VALUES (?, ?, ?, 1, ?)
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      score = score + 1,
      last_win_at_ms = VALUES(last_win_at_ms)
    `,
    [String(guildId), String(userId), String(displayName || userId), Date.now()]
  );
}

async function listScores({ guildId, limit = 10 }) {
  const db = getDb();
  const capped = Math.max(1, Math.min(MAX_LEADERBOARD_LIMIT, Number(limit || 10)));
  const [rows] = await db.execute(
    `
    SELECT user_id, display_name, score, last_win_at_ms
    FROM pokemon_scramble_scores
    WHERE guild_id = ?
    ORDER BY score DESC, last_win_at_ms ASC
    LIMIT ${capped}
    `,
    [String(guildId)]
  );
  return rows || [];
}

async function resetScores({ guildId }) {
  const db = getDb();
  const [result] = await db.execute(
    "DELETE FROM pokemon_scramble_scores WHERE guild_id = ?",
    [String(guildId)]
  );
  return Number(result?.affectedRows || 0);
}

function renderChallenge({ scramble, durationSeconds, endsAtMs = null }) {
  const endLine = endsAtMs
    ? `⏱️ Ends: <t:${Math.floor(Number(endsAtMs) / 1000)}:R>`
    : `⏱️ Time left: **${durationSeconds}s**`;
  return [
    `🧩 Unscramble this Pokemon: **${scramble}**`,
    endLine,
  ].join("\n");
}

function renderSuccess({ word, userId }) {
  return [
    "🧩 **Pokemon Unscramble Ended!**",
    `✅ The Pokemon was: **${word}**`,
    `🎉 <@${userId}> solved it and earned **1 point**!`,
  ].join("\n");
}

function renderFailure({ word }) {
  return [
    `❌ Nobody managed to unscramble the Pokemon **${word}** in time!`,
  ].join("\n");
}

async function clearActiveState(guildId) {
  const st = activeByGuild.get(String(guildId));
  if (!st) return;
  clearTimer(st.countdownTimer, `pokemon_scramble:${guildId}:countdown`);
  clearTimer(st.expireTimer, `pokemon_scramble:${guildId}:expire`);
  activeByGuild.delete(String(guildId));
}

async function finishChallenge(st, winnerMessage = null) {
  if (!st || st.finished) return;
  st.finished = true;
  clearTimer(st.countdownTimer, `pokemon_scramble:${st.guildId}:countdown`);
  clearTimer(st.expireTimer, `pokemon_scramble:${st.guildId}:expire`);
  activeByGuild.delete(String(st.guildId));

  if (winnerMessage) {
    const memberName = winnerMessage.member?.displayName || winnerMessage.author?.username || winnerMessage.author?.id;
    await addScore({
      guildId: st.guildId,
      userId: winnerMessage.author.id,
      displayName: memberName,
    });
    try {
      await st.message.edit(renderSuccess({ word: st.word, userId: winnerMessage.author.id }));
    } catch (err) {
      logger.warn("pokemon_scramble.success_edit_failed", { error: logger.serializeError(err) });
    }
    return;
  }

  try {
    await st.message.edit(renderFailure({ word: st.word }));
  } catch (err) {
    logger.warn("pokemon_scramble.failure_edit_failed", { error: logger.serializeError(err) });
  }

  startTimeout({
    label: `pokemon_scramble:${st.guildId}:delete_failure`,
    ms: DEFAULT_DELETE_FAILURE_SECONDS * 1000,
    fn: () => {
      void st.message.delete?.().catch(() => {});
    },
  });
}

async function postChallengeForSettings(setting, { reason = "scheduled" } = {}) {
  if (!clientRef) return { ok: false, reason: "missing_client" };
  if (activeByGuild.has(String(setting.guildId))) return { ok: false, reason: "already_active" };

  const channel = await clientRef.channels.fetch(setting.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    return { ok: false, reason: "invalid_channel" };
  }

  const word = choosePokemonName();
  if (!word) return { ok: false, reason: "no_words" };

  const scramble = scrambleWord(word);
  const durationSeconds = Math.max(
    MIN_DURATION_SECONDS,
    Math.min(MAX_DURATION_SECONDS, Number(setting.durationSeconds || DEFAULT_DURATION_SECONDS))
  );

  const endsAtMs = Date.now() + durationSeconds * 1000;
  const sent = await channel.send(renderChallenge({ scramble, durationSeconds, endsAtMs }));
  const st = {
    guildId: String(setting.guildId),
    channelId: String(setting.channelId),
    message: sent,
    word,
    answer: normalizeGuess(word),
    scramble,
    startedAtMs: Date.now(),
    endsAtMs,
    durationSeconds,
    finished: false,
    countdownTimer: null,
    expireTimer: null,
    reason,
  };

  st.expireTimer = startTimeout({
    label: `pokemon_scramble:${st.guildId}:expire`,
    ms: durationSeconds * 1000,
    fn: () => {
      const live = activeByGuild.get(st.guildId);
      if (!live || live.finished) return;
      void finishChallenge(live, null);
    },
  });

  activeByGuild.set(st.guildId, st);

  await updateSettings({
    guildId: setting.guildId,
    patch: { nextRunAtMs: Date.now() + Number(setting.cadenceMinutes || DEFAULT_CADENCE_MINUTES) * 60_000 },
    updatedBy: setting.updatedBy || "scheduler",
  });

  return { ok: true, word, messageId: String(sent.id) };
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const nowMs = Date.now();
    const due = await listDueSettings(nowMs);
    for (const setting of due) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postChallengeForSettings(setting, { reason: "scheduled" });
      if (!res.ok && res.reason !== "already_active") {
        // eslint-disable-next-line no-await-in-loop
        await updateSettings({
          guildId: setting.guildId,
          patch: { nextRunAtMs: nowMs + Number(setting.cadenceMinutes || DEFAULT_CADENCE_MINUTES) * 60_000 },
          updatedBy: setting.updatedBy || "scheduler",
        });
      }
    }
  } finally {
    tickInFlight = false;
  }
}

function runSchedulerTick() {
  void schedulerTick().catch((err) => {
    logger.error("pokemon_scramble.scheduler.tick_failed", { error: logger.serializeError(err) });
  });
}

function startScheduler(context = {}) {
  if (context.client) clientRef = context.client;
  if (schedulerBooted) return;
  schedulerBooted = true;
  schedulerTimer = startInterval({
    label: "pokemon_scramble:scheduler",
    ms: SCHEDULER_TICK_MS,
    fn: runSchedulerTick,
  });
  startupTimer = startTimeout({
    label: "pokemon_scramble:startup",
    ms: STARTUP_DELAY_MS,
    fn: runSchedulerTick,
  });
}

function stopScheduler() {
  schedulerBooted = false;
  clearTimer(schedulerTimer, "pokemon_scramble:scheduler");
  clearTimer(startupTimer, "pokemon_scramble:startup");
  schedulerTimer = null;
  startupTimer = null;
  for (const guildId of [...activeByGuild.keys()]) {
    void clearActiveState(guildId);
  }
}

function buildHelpText(prefix = "!") {
  return [
    "**Pokemon Scramble Commands**",
    `• \`${prefix}pokeword help\``,
    `• \`${prefix}pokeword status\``,
    `• \`${prefix}pokeword leaderboard [limit]\``,
    "",
    "**Admin/Privileged**",
    `• \`${prefix}pokeword config show\``,
    `• \`${prefix}pokeword config channel <#channel|channel_id>\``,
    `• \`${prefix}pokeword config enabled <on|off>\``,
    `• \`${prefix}pokeword config cadence <30m|2h|1d>\``,
    `• \`${prefix}pokeword config duration <30s>\``,
    `• \`${prefix}pokeword run now\``,
    `• \`${prefix}pokeword reset scores\``,
  ].join("\n");
}

async function handleStatus(message) {
  await ensureSettings({
    guildId: message.guildId,
    channelId: message.channelId,
    updatedBy: message.author?.id || "system",
  });
  const settings = await getSettings({ guildId: message.guildId });
  const active = activeByGuild.get(String(message.guildId));
  const nextRun =
    settings.nextRunAtMs && settings.enabled ? `<t:${Math.floor(settings.nextRunAtMs / 1000)}:R>` : "Not scheduled";

  await message.reply(
    [
      "**Pokemon Scramble Status**",
      `Enabled: **${settings.enabled ? "Yes" : "No"}**`,
      `Channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not set"}`,
      `Cadence: **${settings.cadenceMinutes} minutes**`,
      `Round Duration: **${settings.durationSeconds}s**`,
      `Next Run: **${nextRun}**`,
      `Active Challenge: **${active ? "Yes" : "No"}**`,
      `Eligible Names: **${loadPokemonNames().length}**`,
    ].join("\n")
  );
}

async function handleLeaderboard({ message, tokens }) {
  const limit = Math.min(MAX_LEADERBOARD_LIMIT, parsePositiveInt(tokens[0]) || 10);
  const rows = await listScores({ guildId: message.guildId, limit });
  if (!rows.length) {
    await message.reply("No Pokemon Scramble scores yet.");
    return;
  }

  const lines = ["**Pokemon Scramble Leaderboard**"];
  rows.forEach((row, idx) => {
    const name = row.display_name || `<@${row.user_id}>`;
    lines.push(`${idx + 1}. ${name} — **${row.score}**`);
  });
  await message.reply(lines.join("\n"));
}

async function handleConfig({ message, tokens }) {
  const field = String(tokens.shift() || "show").toLowerCase();
  await ensureSettings({
    guildId: message.guildId,
    channelId: message.channelId,
    updatedBy: message.author?.id || "system",
  });

  if (field === "show") {
    await handleStatus(message);
    return;
  }

  if (field === "channel") {
    const channelId = parseChannelId(tokens[0]);
    if (!channelId) {
      await message.reply("Usage: `!pokeword config channel <#channel|channel_id>`");
      return;
    }
    await updateSettings({
      guildId: message.guildId,
      patch: { channelId },
      updatedBy: message.author?.id,
    });
    await message.reply(`Pokemon Scramble channel set to <#${channelId}>.`);
    return;
  }

  if (field === "enabled") {
    const enabled = parseOnOff(tokens[0]);
    if (enabled == null) {
      await message.reply("Usage: `!pokeword config enabled <on|off>`");
      return;
    }
    const nextRunAtMs = enabled ? Date.now() + 30_000 : 0;
    await updateSettings({
      guildId: message.guildId,
      patch: { enabled: enabled ? 1 : 0, nextRunAtMs },
      updatedBy: message.author?.id,
    });
    await message.reply(`Pokemon Scramble is now **${enabled ? "enabled" : "disabled"}**.`);
    return;
  }

  if (field === "cadence") {
    const minutes = parseMinutes(tokens.join(" "));
    if (!minutes || minutes < MIN_CADENCE_MINUTES || minutes > MAX_CADENCE_MINUTES) {
      await message.reply("Cadence must be between 5 minutes and 7 days, e.g. `1h`, `2h`, or `1d`.");
      return;
    }
    const current = await getSettings({ guildId: message.guildId });
    const patch = buildCadencePatch({ minutes, enabled: current?.enabled });
    await updateSettings({
      guildId: message.guildId,
      patch,
      updatedBy: message.author?.id,
    });
    const nextLine = current?.enabled ? ` Next run: <t:${Math.floor(patch.nextRunAtMs / 1000)}:R>.` : "";
    await message.reply(`Pokemon Scramble cadence set to **${minutes} minutes**.${nextLine}`);
    return;
  }

  if (field === "duration") {
    const seconds = parseSeconds(tokens.join(" "));
    if (!seconds || seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
      await message.reply("Duration must be between 10 and 120 seconds, e.g. `30s`.");
      return;
    }
    await updateSettings({
      guildId: message.guildId,
      patch: { durationSeconds: seconds },
      updatedBy: message.author?.id,
    });
    await message.reply(`Pokemon Scramble round duration set to **${seconds}s**.`);
    return;
  }

  await message.reply("Unknown config field. Try `!pokeword help`.");
}

async function handleRunNow(message) {
  await ensureSettings({
    guildId: message.guildId,
    channelId: message.channelId,
    updatedBy: message.author?.id || "system",
  });
  const settings = await getSettings({ guildId: message.guildId });
  const setting = {
    ...settings,
    channelId: settings.channelId || message.channelId,
    updatedBy: message.author?.id || settings.updatedBy,
  };
  const res = await postChallengeForSettings(setting, { reason: "manual" });
  if (res.ok) {
    return;
  }
  if (res.reason === "already_active") {
    await message.reply("A Pokemon Scramble challenge is already active.");
    return;
  }
  await message.reply(`Could not start Pokemon Scramble (${res.reason || "unknown error"}).`);
}

function commandPrefix(cmd) {
  return String(cmd || "!").startsWith("?") ? "?" : "!";
}

export function registerPokemonScrambleScheduler() {
  registerScheduler(
    "pokemon_scramble",
    (context = {}) => {
      startScheduler(context);
    },
    () => {
      stopScheduler();
    }
  );
}

export function registerPokemonScramble(register) {
  register.listener?.(({ message }) => {
    if (!message?.guildId) return;
    if (message?.client && !clientRef) clientRef = message.client;
  });

  register.onMessage?.(async ({ message }) => {
    if (!message?.guildId || message.author?.bot) return;
    const st = activeByGuild.get(String(message.guildId));
    if (!st || st.finished) return;
    if (String(message.channelId || message.channel?.id) !== st.channelId) return;
    if (normalizeGuess(message.content) !== st.answer) return;
    await finishChallenge(st, message);
  });

  register.expose({
    logicalId: "pokemon_scramble.main",
    name: "pokeword",
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
        await handleStatus(message);
        return;
      }

      if (sub === "leaderboard" || sub === "lb") {
        await handleLeaderboard({ message, tokens });
        return;
      }

      if (sub === "config") {
        if (!isAdmin) {
          await message.reply("You do not have permission to configure Pokemon Scramble.");
          return;
        }
        await handleConfig({ message, tokens });
        return;
      }

      if (sub === "run") {
        if (!isAdmin) {
          await message.reply("You do not have permission to start Pokemon Scramble manually.");
          return;
        }
        const action = String(tokens.shift() || "").toLowerCase();
        if (action !== "now") {
          await message.reply(`Usage: \`${prefix}pokeword run now\``);
          return;
        }
        await handleRunNow(message);
        return;
      }

      if (sub === "reset") {
        if (!isAdmin) {
          await message.reply("You do not have permission to reset Pokemon Scramble scores.");
          return;
        }
        const target = String(tokens.shift() || "").toLowerCase();
        if (target !== "scores") {
          await message.reply(`Usage: \`${prefix}pokeword reset scores\``);
          return;
        }
        const count = await resetScores({ guildId: message.guildId });
        await message.reply(`Reset Pokemon Scramble scores for **${count}** player(s).`);
        return;
      }

      await message.reply(buildHelpText(prefix));
    },
    help: "!pokeword — Pokemon scramble leaderboard/config",
    opts: {
      aliases: ["pokemonword", "pword"],
      helpTier: "normal",
    },
  });
}

export const __testables = {
  normalizeGuess,
  scrambleWord,
  isEligiblePokemonName,
  loadPokemonNames,
  choosePokemonName,
  parseMinutes,
  parseSeconds,
  buildCadencePatch,
  renderChallenge,
  renderSuccess,
  renderFailure,
};
