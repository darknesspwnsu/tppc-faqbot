// tools/trivia.js
//
// Scheduled multiple-choice Pokemon and TPPC trivia with independent scores.

import fs from "node:fs";
import path from "node:path";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { logger } from "../shared/logger.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { clearTimer, startInterval, startTimeout } from "../shared/timer_utils.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { POKEMON_DEX_CHANCE, POKEMON_DEX_LANDMARKS, TRIVIA_RECENT_QUESTION_LIMIT } from "../configs/trivia.js";

const CURATED_FILES = [
  "data/trivia_questions.json",
  "data/pokemon_trivia_questions.json",
  "data/pokemon_hard_trivia_questions.json",
  "data/opentdb_pokemon_questions.json",
].map((file) => path.resolve(file));

const DEFAULT_CADENCE_MINUTES = 180;
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CATEGORY = "all";
const DEFAULT_DIFFICULTY = "all";
const SCHEDULER_TICK_MS = 60_000;
const STARTUP_DELAY_MS = 5_000;
const MIN_CADENCE_MINUTES = 5;
const MAX_CADENCE_MINUTES = 7 * 24 * 60;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 120;
const MAX_LEADERBOARD_LIMIT = 25;

const CATEGORIES = new Set(["all", "pokemon", "tppc"]);
const DIFFICULTIES = new Set(["all", "easy", "medium", "hard"]);
const LETTERS = ["A", "B", "C", "D"];
const POINTS_BY_DIFFICULTY = { easy: 1, medium: 2, hard: 2 };

const activeByGuild = new Map();
const recentQuestionsByGuild = new Map();

let clientRef = null;
let schedulerBooted = false;
let schedulerTimer = null;
let startupTimer = null;
let tickInFlight = false;
let curatedCache = null;

function chooseOne(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

function parsePositiveInt(raw) {
  const value = Number(String(raw || "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseChannelId(raw) {
  const text = String(raw || "").trim();
  const mention = /^<#(\d+)>$/.exec(text);
  if (mention) return mention[1];
  return /^\d+$/.test(text) ? text : null;
}

function parseOnOff(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enabled"].includes(text)) return true;
  if (["off", "false", "0", "no", "disabled"].includes(text)) return false;
  return null;
}

function tokenizeArgs(raw) {
  return String(raw || "").trim().split(/\s+/).filter(Boolean);
}

function pointsForDifficulty(difficulty) {
  return POINTS_BY_DIFFICULTY[String(difficulty || "").toLowerCase()] || 1;
}

function normalizeQuestion(raw) {
  if (!raw || !Array.isArray(raw.choices) || raw.choices.length !== 4) return null;
  const answerIndex = Number(raw.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return null;
  const difficulty = String(raw.difficulty || "").toLowerCase();
  const category = String(raw.category || "").toLowerCase();
  if (!DIFFICULTIES.has(difficulty) || difficulty === "all") return null;
  if (!CATEGORIES.has(category) || category === "all") return null;
  if (!String(raw.question || "").trim()) return null;
  const choices = raw.choices.map((choice) => String(choice).trim());
  if (choices.some((choice) => !choice) || new Set(choices.map((choice) => choice.toLowerCase())).size !== 4) return null;
  const topic = String(raw.topic || "general");
  if (topic === "pokedex" && (category !== "pokemon" ||
      !POKEMON_DEX_LANDMARKS[raw.dexDirection]?.[difficulty]?.includes(raw.dexNumber))) return null;

  return {
    id: String(raw.id || `${category}:${difficulty}:${raw.question}`),
    category,
    difficulty,
    question: String(raw.question).trim(),
    choices,
    answerIndex,
    topic,
    ...(topic === "pokedex" ? { dexNumber: raw.dexNumber, dexDirection: raw.dexDirection } : {}),
    ...(raw.source ? { source: raw.source } : {}),
  };
}

function randomizeChoices(question) {
  const tagged = question.choices.map((choice, index) => ({
    choice,
    correct: index === question.answerIndex,
  }));
  const mixed = shuffle(tagged);
  return {
    ...question,
    choices: mixed.map((entry) => entry.choice),
    answerIndex: mixed.findIndex((entry) => entry.correct),
  };
}

function loadCuratedQuestions() {
  if (curatedCache) return curatedCache;
  curatedCache = CURATED_FILES.flatMap((file) => {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(parsed) ? parsed : []).map(normalizeQuestion).filter(Boolean);
  });
  return curatedCache;
}

function availableQuestions(candidates, recentIds = []) {
  const recent = new Set(recentIds);
  const fresh = candidates.filter((question) => !recent.has(question.id));
  if (fresh.length) return fresh;
  // Small filtered pools can run out; still avoid the immediately previous round.
  const withoutLast = candidates.filter((question) => question.id !== recentIds.at(-1));
  return withoutLast.length ? withoutLast : candidates;
}

function buildPokemonQuestion(difficulty, recentIds = []) {
  const candidates = loadCuratedQuestions().filter(
    (question) => question.category === "pokemon" && question.difficulty === difficulty
  );
  const dex = candidates.filter((question) => question.topic === "pokedex");
  const general = candidates.filter((question) => question.topic !== "pokedex");
  // Pick the group before filtering history: exhausting a small general pool
  // must not turn the next round into a guaranteed dex question.
  if (dex.length && (!general.length || Math.random() < POKEMON_DEX_CHANCE)) {
    return randomizeChoices(chooseOne(availableQuestions(dex, recentIds)));
  }
  if (!general.length) return null;
  const available = availableQuestions(general, recentIds);
  // A large trainer or type sub-pool must not drown out the other topics.
  const topic = chooseOne([...new Set(available.map((question) => question.topic))]);
  return randomizeChoices(chooseOne(available.filter((question) => question.topic === topic)));
}

function resolveQuestionSelection({ category = "all", difficulty = "all", recentIds = [] } = {}) {
  const selectedDifficulty = difficulty === "all"
    ? chooseOne(["easy", "medium", "hard"])
    : difficulty;
  const selectedCategory = category === "all"
    ? chooseOne(["pokemon", "tppc"])
    : category;

  if (selectedCategory === "pokemon") {
    return buildPokemonQuestion(selectedDifficulty, recentIds);
  }

  const candidates = loadCuratedQuestions().filter(
    (question) => question.category === "tppc" && question.difficulty === selectedDifficulty
  );
  const picked = chooseOne(availableQuestions(candidates, recentIds));
  return picked ? randomizeChoices(picked) : null;
}

function toSettings(row) {
  return {
    guildId: String(row.guild_id),
    channelId: row.channel_id ? String(row.channel_id) : null,
    enabled: Boolean(Number(row.enabled || 0)),
    cadenceMinutes: Number(row.cadence_minutes || DEFAULT_CADENCE_MINUTES),
    durationSeconds: Number(row.duration_seconds || DEFAULT_DURATION_SECONDS),
    category: CATEGORIES.has(String(row.category)) ? String(row.category) : DEFAULT_CATEGORY,
    difficulty: DIFFICULTIES.has(String(row.difficulty)) ? String(row.difficulty) : DEFAULT_DIFFICULTY,
    nextRunAtMs: Number(row.next_run_at_ms || 0),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

async function ensureSettings({ guildId, channelId = null, updatedBy = "system" }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO trivia_settings (
      guild_id, channel_id, enabled, cadence_minutes, duration_seconds,
      category, difficulty, next_run_at_ms, updated_by
    ) VALUES (?, ?, 0, ?, ?, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)
    `,
    [
      String(guildId),
      channelId ? String(channelId) : null,
      DEFAULT_CADENCE_MINUTES,
      DEFAULT_DURATION_SECONDS,
      DEFAULT_CATEGORY,
      DEFAULT_DIFFICULTY,
      String(updatedBy || "system"),
    ]
  );
}

async function getSettings({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, duration_seconds,
           category, difficulty, next_run_at_ms, updated_by
    FROM trivia_settings
    WHERE guild_id = ?
    LIMIT 1
    `,
    [String(guildId)]
  );
  return rows?.[0] ? toSettings(rows[0]) : null;
}

async function updateSettings({ guildId, patch, updatedBy }) {
  await ensureSettings({ guildId, updatedBy });
  const columns = {
    channelId: "channel_id",
    enabled: "enabled",
    cadenceMinutes: "cadence_minutes",
    durationSeconds: "duration_seconds",
    category: "category",
    difficulty: "difficulty",
    nextRunAtMs: "next_run_at_ms",
  };
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!columns[key]) continue;
    fields.push(`${columns[key]} = ?`);
    params.push(value);
  }
  fields.push("updated_by = ?");
  params.push(String(updatedBy || "system"), String(guildId));
  await getDb().execute(`UPDATE trivia_settings SET ${fields.join(", ")} WHERE guild_id = ?`, params);
  return getSettings({ guildId });
}

async function listDueSettings(nowMs) {
  const [rows] = await getDb().execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, duration_seconds,
           category, difficulty, next_run_at_ms, updated_by
    FROM trivia_settings
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

async function addScores({ guildId, winners, points }) {
  if (!winners.length) return;
  const placeholders = winners.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const params = [];
  const nowMs = Date.now();
  for (const winner of winners) {
    params.push(String(guildId), String(winner.userId), winner.displayName, Number(points), nowMs);
  }
  await getDb().execute(
    `
    INSERT INTO trivia_scores (guild_id, user_id, display_name, score, last_win_at_ms)
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      score = score + VALUES(score),
      last_win_at_ms = VALUES(last_win_at_ms)
    `,
    params
  );
}

async function listScores({ guildId, limit = 10 }) {
  const capped = Math.max(1, Math.min(MAX_LEADERBOARD_LIMIT, Number(limit || 10)));
  const [rows] = await getDb().execute(
    `
    SELECT user_id, display_name, score, last_win_at_ms
    FROM trivia_scores
    WHERE guild_id = ?
    ORDER BY score DESC, last_win_at_ms ASC
    LIMIT ${capped}
    `,
    [String(guildId)]
  );
  return rows || [];
}

async function resetScores(guildId) {
  const [result] = await getDb().execute("DELETE FROM trivia_scores WHERE guild_id = ?", [String(guildId)]);
  return Number(result?.affectedRows || 0);
}

function buildButtons({ token, disabled = false, answerIndex = null }) {
  const buttons = LETTERS.map((letter, index) => {
    const style = disabled && index === answerIndex ? ButtonStyle.Success : ButtonStyle.Primary;
    return new ButtonBuilder()
      .setCustomId(`trivia:answer:${token}:${index}`)
      .setLabel(letter)
      .setStyle(style)
      .setDisabled(disabled);
  });
  return new ActionRowBuilder().addComponents(buttons);
}

function renderQuestion(question, endsAtMs) {
  const points = pointsForDifficulty(question.difficulty);
  const lines = [
    "❓ **Pokemon Trivia**",
    `**${question.question}**`,
    "",
    ...question.choices.map((choice, index) => `**${LETTERS[index]}.** ${choice}`),
    "",
    `Difficulty: **${question.difficulty}** | Reward: **${points} point${points === 1 ? "" : "s"}**`,
    "Your first answer is final.",
    `⏱️ Ends: <t:${Math.floor(endsAtMs / 1000)}:R>`,
  ];
  return lines.join("\n");
}

function renderResult({ question, winners, responseCount }) {
  const answer = `${LETTERS[question.answerIndex]}. ${question.choices[question.answerIndex]}`;
  const points = pointsForDifficulty(question.difficulty);
  const lines = [
    "❓ **Pokemon Trivia Ended!**",
    `✅ The answer was: **${answer}**`,
  ];
  if (winners.length) {
    lines.push(
      `🎉 ${winners.map((winner) => `<@${winner.userId}>`).join(", ")} earned **${points} point${points === 1 ? "" : "s"}**!`
    );
  } else {
    lines.push("❌ Nobody answered correctly in time.");
  }
  lines.push(`Responses: **${responseCount}**`);
  if (question.source) {
    const { name, url, license } = question.source;
    lines.push(`Source: [${name}](${url})${license === "CC BY-SA 4.0" ? " (adapted; [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/))." : "."}`);
  }
  return lines.join("\n");
}

async function finishTrivia(state) {
  if (!state || state.finished) return;
  state.finished = true;
  clearTimer(state.expireTimer, `trivia:${state.guildId}:expire`);

  const winners = [...state.answers.entries()]
    .filter(([, answer]) => answer.choiceIndex === state.question.answerIndex)
    .map(([userId, answer]) => ({ userId, displayName: answer.displayName }));

  try {
    await addScores({
      guildId: state.guildId,
      winners,
      points: pointsForDifficulty(state.question.difficulty),
    });
  } catch (err) {
    logger.error("trivia.score.failed", { guildId: state.guildId, error: logger.serializeError(err) });
  }

  try {
    await state.message.edit({
      content: renderResult({
        question: state.question,
        winners,
        responseCount: state.answers.size,
      }),
      components: [buildButtons({
        token: state.token,
        disabled: true,
        answerIndex: state.question.answerIndex,
      })],
    });
  } catch (err) {
    logger.warn("trivia.result_edit.failed", { guildId: state.guildId, error: logger.serializeError(err) });
  } finally {
    activeByGuild.delete(String(state.guildId));
  }
}

async function postTrivia(setting, overrides = {}) {
  const guildId = String(setting.guildId);
  if (!clientRef) return { ok: false, reason: "missing_client" };
  if (activeByGuild.has(guildId)) return { ok: false, reason: "already_active" };

  const category = CATEGORIES.has(overrides.category) ? overrides.category : setting.category;
  const difficulty = DIFFICULTIES.has(overrides.difficulty) ? overrides.difficulty : setting.difficulty;
  const question = resolveQuestionSelection({ category, difficulty, recentIds: recentQuestionsByGuild.get(guildId) });
  if (!question) return { ok: false, reason: "no_question" };

  const channel = await clientRef.channels.fetch(setting.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    return { ok: false, reason: "invalid_channel" };
  }

  const durationSeconds = Math.max(
    MIN_DURATION_SECONDS,
    Math.min(MAX_DURATION_SECONDS, Number(setting.durationSeconds || DEFAULT_DURATION_SECONDS))
  );
  const endsAtMs = Date.now() + durationSeconds * 1000;
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let message;
  try {
    message = await channel.send({
      content: renderQuestion(question, endsAtMs),
      components: [buildButtons({ token })],
    });
  } catch (err) {
    logger.warn("trivia.send.failed", { guildId, error: logger.serializeError(err) });
    return { ok: false, reason: "send_failed" };
  }

  recentQuestionsByGuild.set(guildId, [...(recentQuestionsByGuild.get(guildId) || []), question.id].slice(-TRIVIA_RECENT_QUESTION_LIMIT));

  const state = {
    guildId,
    channelId: String(setting.channelId),
    token,
    question,
    answers: new Map(),
    message,
    endsAtMs,
    expireTimer: null,
    finished: false,
  };
  state.expireTimer = startTimeout({
    label: `trivia:${guildId}:expire`,
    ms: durationSeconds * 1000,
    fn: () => void finishTrivia(activeByGuild.get(guildId)),
  });
  activeByGuild.set(guildId, state);

  await updateSettings({
    guildId,
    patch: { nextRunAtMs: Date.now() + Number(setting.cadenceMinutes || DEFAULT_CADENCE_MINUTES) * 60_000 },
    updatedBy: setting.updatedBy || "scheduler",
  });
  return { ok: true, question };
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const nowMs = Date.now();
    const settings = await listDueSettings(nowMs);
    for (const setting of settings) {
      // eslint-disable-next-line no-await-in-loop
      const result = await postTrivia(setting);
      if (!result.ok && result.reason !== "already_active") {
        // eslint-disable-next-line no-await-in-loop
        await updateSettings({
          guildId: setting.guildId,
          patch: { nextRunAtMs: nowMs + setting.cadenceMinutes * 60_000 },
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
    logger.error("trivia.scheduler.failed", { error: logger.serializeError(err) });
  });
}

function startScheduler(context = {}) {
  if (context.client) clientRef = context.client;
  if (schedulerBooted) return;
  schedulerBooted = true;
  schedulerTimer = startInterval({ label: "trivia:scheduler", ms: SCHEDULER_TICK_MS, fn: runSchedulerTick });
  startupTimer = startTimeout({ label: "trivia:startup", ms: STARTUP_DELAY_MS, fn: runSchedulerTick });
}

function stopScheduler() {
  schedulerBooted = false;
  clearTimer(schedulerTimer, "trivia:scheduler");
  clearTimer(startupTimer, "trivia:startup");
  schedulerTimer = null;
  startupTimer = null;
  for (const state of activeByGuild.values()) {
    clearTimer(state.expireTimer, `trivia:${state.guildId}:expire`);
  }
  activeByGuild.clear();
}

function commandPrefix(cmd) {
  return String(cmd || "!").startsWith("?") ? "?" : "!";
}

function helpText(prefix) {
  return [
    "**Trivia Commands**",
    `• \`${prefix}trivia help\``,
    `• \`${prefix}trivia status\``,
    `• \`${prefix}trivia leaderboard [limit]\``,
    "",
    "**Admin/Privileged**",
    `• \`${prefix}trivia config channel <#channel|channel_id>\``,
    `• \`${prefix}trivia config enabled <on|off>\``,
    `• \`${prefix}trivia config cadence <30m|2h|1d>\``,
    `• \`${prefix}trivia config duration <30s>\``,
    `• \`${prefix}trivia config category <all|pokemon|tppc>\``,
    `• \`${prefix}trivia config difficulty <all|easy|medium|hard>\``,
    `• \`${prefix}trivia run now [category] [difficulty]\``,
    `• \`${prefix}trivia reset scores\``,
    "",
    "Easy questions award 1 point. Medium and hard questions award 2 points.",
    "Every correct participant within the answer window earns points.",
    "Your first answer is final. The default answer window is 30 seconds.",
  ].join("\n");
}

async function handleStatus(message) {
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  const settings = await getSettings({ guildId: message.guildId });
  const nextRun = settings.enabled && settings.nextRunAtMs
    ? `<t:${Math.floor(settings.nextRunAtMs / 1000)}:R>`
    : "Not scheduled";
  await message.reply([
    "**Trivia Status**",
    `Enabled: **${settings.enabled ? "Yes" : "No"}**`,
    `Channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not set"}`,
    `Cadence: **${settings.cadenceMinutes} minutes**`,
    `Answer Window: **${settings.durationSeconds}s**`,
    `Category: **${settings.category}**`,
    `Difficulty: **${settings.difficulty}**`,
    `Next Run: **${nextRun}**`,
    `Active Question: **${activeByGuild.has(String(message.guildId)) ? "Yes" : "No"}**`,
  ].join("\n"));
}

async function handleLeaderboard(message, tokens) {
  const limit = Math.min(MAX_LEADERBOARD_LIMIT, parsePositiveInt(tokens[0]) || 10);
  const rows = await listScores({ guildId: message.guildId, limit });
  if (!rows.length) {
    await message.reply("No trivia scores yet.");
    return;
  }
  const lines = ["**Trivia Leaderboard**"];
  rows.forEach((row, index) => lines.push(`${index + 1}. ${row.display_name || `<@${row.user_id}>`} — **${row.score}**`));
  await message.reply(lines.join("\n"));
}

async function handleConfig(message, tokens, prefix) {
  const field = String(tokens.shift() || "show").toLowerCase();
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  if (field === "show") return handleStatus(message);

  if (field === "channel") {
    const channelId = parseChannelId(tokens[0]);
    if (!channelId) return message.reply(`Usage: \`${prefix}trivia config channel <#channel|channel_id>\``);
    await updateSettings({ guildId: message.guildId, patch: { channelId }, updatedBy: message.author?.id });
    await message.reply(`Trivia channel set to <#${channelId}>.`);
    return;
  }

  if (field === "enabled") {
    const enabled = parseOnOff(tokens[0]);
    if (enabled == null) return message.reply(`Usage: \`${prefix}trivia config enabled <on|off>\``);
    await updateSettings({
      guildId: message.guildId,
      patch: { enabled: enabled ? 1 : 0, nextRunAtMs: enabled ? Date.now() + 30_000 : 0 },
      updatedBy: message.author?.id,
    });
    await message.reply(`Trivia is now **${enabled ? "enabled" : "disabled"}**.`);
    return;
  }

  if (field === "cadence") {
    const minutes = parseMinutes(tokens.join(" "));
    if (!minutes || minutes < MIN_CADENCE_MINUTES || minutes > MAX_CADENCE_MINUTES) {
      return message.reply("Cadence must be between 5 minutes and 7 days.");
    }
    const current = await getSettings({ guildId: message.guildId });
    const patch = { cadenceMinutes: minutes };
    if (current.enabled) patch.nextRunAtMs = Date.now() + minutes * 60_000;
    await updateSettings({ guildId: message.guildId, patch, updatedBy: message.author?.id });
    await message.reply(`Trivia cadence set to **${minutes} minutes**.`);
    return;
  }

  if (field === "duration") {
    const seconds = parseSeconds(tokens.join(" "));
    if (!seconds || seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
      return message.reply("Duration must be between 10 and 120 seconds.");
    }
    await updateSettings({ guildId: message.guildId, patch: { durationSeconds: seconds }, updatedBy: message.author?.id });
    await message.reply(`Trivia answer window set to **${seconds}s**.`);
    return;
  }

  if (field === "category") {
    const category = String(tokens[0] || "").toLowerCase();
    if (!CATEGORIES.has(category)) return message.reply("Category must be `all`, `pokemon`, or `tppc`.");
    await updateSettings({ guildId: message.guildId, patch: { category }, updatedBy: message.author?.id });
    await message.reply(`Trivia category set to **${category}**.`);
    return;
  }

  if (field === "difficulty") {
    const difficulty = String(tokens[0] || "").toLowerCase();
    if (!DIFFICULTIES.has(difficulty)) return message.reply("Difficulty must be `all`, `easy`, `medium`, or `hard`.");
    await updateSettings({ guildId: message.guildId, patch: { difficulty }, updatedBy: message.author?.id });
    await message.reply(`Trivia difficulty set to **${difficulty}**.`);
    return;
  }

  await message.reply(`Unknown config field. Try \`${prefix}trivia help\`.`);
}

function parseRunOverrides(tokens) {
  let category = null;
  let difficulty = null;
  for (const token of tokens.map((item) => String(item).toLowerCase())) {
    if (token === "all") {
      if (category == null) category = token;
      else if (difficulty == null) difficulty = token;
      else return { ok: false };
    } else if (CATEGORIES.has(token) && category == null) {
      category = token;
    } else if (DIFFICULTIES.has(token) && difficulty == null) {
      difficulty = token;
    } else {
      return { ok: false };
    }
  }
  return { ok: true, category, difficulty };
}

async function handleRunNow(message, tokens, prefix) {
  const overrides = parseRunOverrides(tokens);
  if (!overrides.ok) {
    await message.reply(`Usage: \`${prefix}trivia run now [all|pokemon|tppc] [all|easy|medium|hard]\``);
    return;
  }
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  const settings = await getSettings({ guildId: message.guildId });
  const result = await postTrivia(
    { ...settings, channelId: settings.channelId || message.channelId, updatedBy: message.author?.id },
    overrides
  );
  if (result.ok) return;
  const messages = {
    already_active: "A trivia question is already active.",
    invalid_channel: "The configured trivia channel is unavailable.",
    no_question: "No trivia question matched that category and difficulty.",
    send_failed: "Discord rejected the trivia message. Check the bot's channel permissions.",
  };
  await message.reply(messages[result.reason] || `Could not start trivia (${result.reason || "unknown error"}).`);
}

export function registerTriviaScheduler() {
  registerScheduler("trivia", startScheduler, stopScheduler);
}

export function registerTrivia(register) {
  register.listener?.(({ message }) => {
    if (message?.client && !clientRef) clientRef = message.client;
  });

  register.component("trivia:answer:", async ({ interaction }) => {
    if (!interaction.isButton?.() || !interaction.guildId) return;
    const parts = String(interaction.customId || "").split(":");
    const token = parts[2];
    const choiceIndex = Number(parts[3]);
    const state = activeByGuild.get(String(interaction.guildId));
    if (!state || state.token !== token || state.finished || Date.now() >= state.endsAtMs) {
      await interaction.reply({ content: "This trivia question has ended.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 3) return;

    const userId = String(interaction.user?.id || "");
    const existingAnswer = state.answers.get(userId);
    if (existingAnswer) {
      await interaction.reply({
        content: `Your answer is locked: **${LETTERS[existingAnswer.choiceIndex]}**. You cannot change it.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const displayName = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || userId;
    state.answers.set(userId, { choiceIndex, displayName: String(displayName) });
    await interaction.reply({
      content: `Answer recorded: **${LETTERS[choiceIndex]}**. Your answer is final.`,
      flags: MessageFlags.Ephemeral,
    });
  });

  register.expose({
    logicalId: "trivia.main",
    name: "trivia",
    handler: async ({ message, rest, cmd }) => {
      if (!message?.guildId) return;
      if (message.client && !clientRef) clientRef = message.client;
      const prefix = commandPrefix(cmd);
      const tokens = tokenizeArgs(rest);
      const sub = String(tokens.shift() || "help").toLowerCase();

      if (sub === "help") return message.reply(helpText(prefix));
      if (sub === "status") return handleStatus(message);
      if (sub === "leaderboard" || sub === "lb") return handleLeaderboard(message, tokens);

      if (!isAdminOrPrivileged(message)) {
        await message.reply("You do not have permission to manage trivia.");
        return;
      }
      if (sub === "config") return handleConfig(message, tokens, prefix);
      if (sub === "run") {
        if (String(tokens.shift() || "").toLowerCase() !== "now") {
          return message.reply(`Usage: \`${prefix}trivia run now [category] [difficulty]\``);
        }
        return handleRunNow(message, tokens, prefix);
      }
      if (sub === "reset") {
        if (String(tokens.shift() || "").toLowerCase() !== "scores") {
          return message.reply(`Usage: \`${prefix}trivia reset scores\``);
        }
        const count = await resetScores(message.guildId);
        await message.reply(`Reset trivia scores for **${count}** player(s).`);
        return;
      }
      await message.reply(helpText(prefix));
    },
    help: "!trivia — scheduled Pokemon and TPPC trivia",
    opts: { helpTier: "normal" },
  });
}

export const __testables = {
  pointsForDifficulty,
  normalizeQuestion,
  randomizeChoices,
  loadCuratedQuestions,
  availableQuestions,
  buildPokemonQuestion,
  resolveQuestionSelection,
  parseRunOverrides,
  renderQuestion,
  renderResult,
};
