// tools/loot.js
//
// Scheduled loot claims with first, random, and all-winner modes.

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

const DEFAULT_CADENCE_MINUTES = 180;
const DEFAULT_CLAIM_SECONDS = 30;
const DEFAULT_MODE = "random";
const SCHEDULER_TICK_MS = 60_000;
const STARTUP_DELAY_MS = 5_000;
const MIN_CADENCE_MINUTES = 5;
const MAX_CADENCE_MINUTES = 7 * 24 * 60;
const MIN_CLAIM_SECONDS = 10;
const MAX_CLAIM_SECONDS = 120;
const MAX_LEADERBOARD_LIMIT = 25;
const MODES = new Set(["random", "first", "all"]);

const activeByGuild = new Map();

let clientRef = null;
let schedulerBooted = false;
let schedulerTimer = null;
let startupTimer = null;
let tickInFlight = false;

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

function chooseLootWinners({ mode, claimants, random = Math.random }) {
  const entries = Array.isArray(claimants) ? claimants : [];
  if (!entries.length) return [];
  if (mode === "all") return [...entries];
  if (mode === "first") return [entries[0]];
  const index = Math.min(entries.length - 1, Math.floor(random() * entries.length));
  return [entries[index]];
}

function toSettings(row) {
  const mode = String(row.mode || DEFAULT_MODE).toLowerCase();
  return {
    guildId: String(row.guild_id),
    channelId: row.channel_id ? String(row.channel_id) : null,
    enabled: Boolean(Number(row.enabled || 0)),
    cadenceMinutes: Number(row.cadence_minutes || DEFAULT_CADENCE_MINUTES),
    claimSeconds: Number(row.claim_seconds || DEFAULT_CLAIM_SECONDS),
    mode: MODES.has(mode) ? mode : DEFAULT_MODE,
    nextRunAtMs: Number(row.next_run_at_ms || 0),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

async function ensureSettings({ guildId, channelId = null, updatedBy = "system" }) {
  await getDb().execute(
    `
    INSERT INTO loot_settings (
      guild_id, channel_id, enabled, cadence_minutes, claim_seconds,
      mode, next_run_at_ms, updated_by
    ) VALUES (?, ?, 0, ?, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)
    `,
    [
      String(guildId),
      channelId ? String(channelId) : null,
      DEFAULT_CADENCE_MINUTES,
      DEFAULT_CLAIM_SECONDS,
      DEFAULT_MODE,
      String(updatedBy || "system"),
    ]
  );
}

async function getSettings({ guildId }) {
  const [rows] = await getDb().execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, claim_seconds,
           mode, next_run_at_ms, updated_by
    FROM loot_settings
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
    claimSeconds: "claim_seconds",
    mode: "mode",
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
  await getDb().execute(`UPDATE loot_settings SET ${fields.join(", ")} WHERE guild_id = ?`, params);
  return getSettings({ guildId });
}

async function listDueSettings(nowMs) {
  const [rows] = await getDb().execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, claim_seconds,
           mode, next_run_at_ms, updated_by
    FROM loot_settings
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

async function addScores({ guildId, winners }) {
  if (!winners.length) return;
  const placeholders = winners.map(() => "(?, ?, ?, 1, ?)").join(", ");
  const params = [];
  const nowMs = Date.now();
  for (const winner of winners) {
    params.push(String(guildId), String(winner.userId), winner.displayName, nowMs);
  }
  await getDb().execute(
    `
    INSERT INTO loot_scores (guild_id, user_id, display_name, score, last_win_at_ms)
    VALUES ${placeholders}
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      score = score + 1,
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
    FROM loot_scores
    WHERE guild_id = ?
    ORDER BY score DESC, last_win_at_ms ASC
    LIMIT ${capped}
    `,
    [String(guildId)]
  );
  return rows || [];
}

async function resetScores(guildId) {
  const [result] = await getDb().execute("DELETE FROM loot_scores WHERE guild_id = ?", [String(guildId)]);
  return Number(result?.affectedRows || 0);
}

function modeDescription(mode) {
  if (mode === "first") return "The first person to claim wins.";
  if (mode === "all") return "Everyone who claims in time wins.";
  return "One claimant will be selected at random.";
}

function buildClaimButton({ token, disabled = false }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`loot:claim:${token}`)
      .setLabel("Claim Loot")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
}

function renderDrop({ mode, endsAtMs }) {
  return [
    "🎁 **Loot Drop!**",
    modeDescription(mode),
    "Claiming successfully awards **1 loot point**.",
    `⏱️ Claim period ends: <t:${Math.floor(endsAtMs / 1000)}:R>`,
  ].join("\n");
}

function renderResult({ mode, winners, claimCount }) {
  const lines = ["🎁 **Loot Drop Ended!**"];
  if (winners.length) {
    lines.push(`🏆 ${winners.map((winner) => `<@${winner.userId}>`).join(", ")} earned **1 loot point**!`);
  } else {
    lines.push("❌ Nobody claimed the loot in time.");
  }
  if (mode === "random") lines.push(`Eligible claims: **${claimCount}**`);
  return lines.join("\n");
}

async function finishLoot(state, firstWinner = null) {
  if (!state || state.finished) return;
  state.finished = true;
  clearTimer(state.expireTimer, `loot:${state.guildId}:expire`);

  const claimants = [...state.claimants.values()];
  const winners = firstWinner
    ? [firstWinner]
    : chooseLootWinners({ mode: state.mode, claimants });

  try {
    await addScores({ guildId: state.guildId, winners });
  } catch (err) {
    logger.error("loot.score.failed", { guildId: state.guildId, error: logger.serializeError(err) });
  }

  try {
    await state.message.edit({
      content: renderResult({ mode: state.mode, winners, claimCount: claimants.length }),
      components: [buildClaimButton({ token: state.token, disabled: true })],
    });
  } catch (err) {
    logger.warn("loot.result_edit.failed", { guildId: state.guildId, error: logger.serializeError(err) });
  } finally {
    activeByGuild.delete(String(state.guildId));
  }
}

async function postLoot(setting, { mode: modeOverride = null } = {}) {
  const guildId = String(setting.guildId);
  if (!clientRef) return { ok: false, reason: "missing_client" };
  if (activeByGuild.has(guildId)) return { ok: false, reason: "already_active" };

  const mode = MODES.has(modeOverride) ? modeOverride : setting.mode;
  const channel = await clientRef.channels.fetch(setting.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    return { ok: false, reason: "invalid_channel" };
  }

  const claimSeconds = Math.max(
    MIN_CLAIM_SECONDS,
    Math.min(MAX_CLAIM_SECONDS, Number(setting.claimSeconds || DEFAULT_CLAIM_SECONDS))
  );
  const endsAtMs = Date.now() + claimSeconds * 1000;
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let message;
  try {
    message = await channel.send({
      content: renderDrop({ mode, endsAtMs }),
      components: [buildClaimButton({ token })],
    });
  } catch (err) {
    logger.warn("loot.send.failed", { guildId, error: logger.serializeError(err) });
    return { ok: false, reason: "send_failed" };
  }

  const state = {
    guildId,
    channelId: String(setting.channelId),
    token,
    mode,
    claimants: new Map(),
    message,
    endsAtMs,
    expireTimer: null,
    finished: false,
  };
  state.expireTimer = startTimeout({
    label: `loot:${guildId}:expire`,
    ms: claimSeconds * 1000,
    fn: () => void finishLoot(activeByGuild.get(guildId)),
  });
  activeByGuild.set(guildId, state);

  await updateSettings({
    guildId,
    patch: { nextRunAtMs: Date.now() + Number(setting.cadenceMinutes || DEFAULT_CADENCE_MINUTES) * 60_000 },
    updatedBy: setting.updatedBy || "scheduler",
  });
  return { ok: true };
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const nowMs = Date.now();
    const settings = await listDueSettings(nowMs);
    for (const setting of settings) {
      // eslint-disable-next-line no-await-in-loop
      const result = await postLoot(setting);
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
    logger.error("loot.scheduler.failed", { error: logger.serializeError(err) });
  });
}

function startScheduler(context = {}) {
  if (context.client) clientRef = context.client;
  if (schedulerBooted) return;
  schedulerBooted = true;
  schedulerTimer = startInterval({ label: "loot:scheduler", ms: SCHEDULER_TICK_MS, fn: runSchedulerTick });
  startupTimer = startTimeout({ label: "loot:startup", ms: STARTUP_DELAY_MS, fn: runSchedulerTick });
}

function stopScheduler() {
  schedulerBooted = false;
  clearTimer(schedulerTimer, "loot:scheduler");
  clearTimer(startupTimer, "loot:startup");
  schedulerTimer = null;
  startupTimer = null;
  for (const state of activeByGuild.values()) clearTimer(state.expireTimer, `loot:${state.guildId}:expire`);
  activeByGuild.clear();
}

function commandPrefix(cmd) {
  return String(cmd || "!").startsWith("?") ? "?" : "!";
}

function helpText(prefix) {
  return [
    "**Loot Commands**",
    `• \`${prefix}loot help\``,
    `• \`${prefix}loot status\``,
    `• \`${prefix}loot leaderboard [limit]\``,
    "",
    "**Admin/Privileged**",
    `• \`${prefix}loot config channel <#channel|channel_id>\``,
    `• \`${prefix}loot config enabled <on|off>\``,
    `• \`${prefix}loot config cadence <30m|2h|1d>\``,
    `• \`${prefix}loot config claim <30s>\``,
    `• \`${prefix}loot config mode <random|first|all>\``,
    `• \`${prefix}loot run now [random|first|all]\``,
    `• \`${prefix}loot reset scores\``,
    "",
    "Each successful loot claim awards 1 loot point.",
  ].join("\n");
}

async function handleStatus(message) {
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  const settings = await getSettings({ guildId: message.guildId });
  const nextRun = settings.enabled && settings.nextRunAtMs
    ? `<t:${Math.floor(settings.nextRunAtMs / 1000)}:R>`
    : "Not scheduled";
  await message.reply([
    "**Loot Status**",
    `Enabled: **${settings.enabled ? "Yes" : "No"}**`,
    `Channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not set"}`,
    `Cadence: **${settings.cadenceMinutes} minutes**`,
    `Claim Period: **${settings.claimSeconds}s**`,
    `Mode: **${settings.mode}**`,
    `Next Run: **${nextRun}**`,
    `Active Drop: **${activeByGuild.has(String(message.guildId)) ? "Yes" : "No"}**`,
  ].join("\n"));
}

async function handleLeaderboard(message, tokens) {
  const limit = Math.min(MAX_LEADERBOARD_LIMIT, parsePositiveInt(tokens[0]) || 10);
  const rows = await listScores({ guildId: message.guildId, limit });
  if (!rows.length) return message.reply("No loot scores yet.");
  const lines = ["**Loot Leaderboard**"];
  rows.forEach((row, index) => lines.push(`${index + 1}. ${row.display_name || `<@${row.user_id}>`} — **${row.score}**`));
  await message.reply(lines.join("\n"));
}

async function handleConfig(message, tokens, prefix) {
  const field = String(tokens.shift() || "show").toLowerCase();
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  if (field === "show") return handleStatus(message);

  if (field === "channel") {
    const channelId = parseChannelId(tokens[0]);
    if (!channelId) return message.reply(`Usage: \`${prefix}loot config channel <#channel|channel_id>\``);
    await updateSettings({ guildId: message.guildId, patch: { channelId }, updatedBy: message.author?.id });
    await message.reply(`Loot channel set to <#${channelId}>.`);
    return;
  }

  if (field === "enabled") {
    const enabled = parseOnOff(tokens[0]);
    if (enabled == null) return message.reply(`Usage: \`${prefix}loot config enabled <on|off>\``);
    await updateSettings({
      guildId: message.guildId,
      patch: { enabled: enabled ? 1 : 0, nextRunAtMs: enabled ? Date.now() + 30_000 : 0 },
      updatedBy: message.author?.id,
    });
    await message.reply(`Loot is now **${enabled ? "enabled" : "disabled"}**.`);
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
    await message.reply(`Loot cadence set to **${minutes} minutes**.`);
    return;
  }

  if (field === "claim" || field === "duration") {
    const seconds = parseSeconds(tokens.join(" "));
    if (!seconds || seconds < MIN_CLAIM_SECONDS || seconds > MAX_CLAIM_SECONDS) {
      return message.reply("Claim period must be between 10 and 120 seconds.");
    }
    await updateSettings({ guildId: message.guildId, patch: { claimSeconds: seconds }, updatedBy: message.author?.id });
    await message.reply(`Loot claim period set to **${seconds}s**.`);
    return;
  }

  if (field === "mode") {
    const mode = String(tokens[0] || "").toLowerCase();
    if (!MODES.has(mode)) return message.reply("Mode must be `random`, `first`, or `all`.");
    await updateSettings({ guildId: message.guildId, patch: { mode }, updatedBy: message.author?.id });
    await message.reply(`Loot mode set to **${mode}**.`);
    return;
  }

  await message.reply(`Unknown config field. Try \`${prefix}loot help\`.`);
}

async function handleRunNow(message, tokens, prefix) {
  const rawMode = String(tokens[0] || "").toLowerCase();
  if (rawMode && !MODES.has(rawMode)) {
    await message.reply(`Usage: \`${prefix}loot run now [random|first|all]\``);
    return;
  }
  await ensureSettings({ guildId: message.guildId, channelId: message.channelId, updatedBy: message.author?.id });
  const settings = await getSettings({ guildId: message.guildId });
  const result = await postLoot(
    { ...settings, channelId: settings.channelId || message.channelId, updatedBy: message.author?.id },
    { mode: rawMode || null }
  );
  if (result.ok) return;
  const messages = {
    already_active: "A loot drop is already active.",
    invalid_channel: "The configured loot channel is unavailable.",
    send_failed: "Discord rejected the loot message. Check the bot's channel permissions.",
  };
  await message.reply(messages[result.reason] || `Could not start loot (${result.reason || "unknown error"}).`);
}

export function registerLootScheduler() {
  registerScheduler("loot", startScheduler, stopScheduler);
}

export function registerLoot(register) {
  register.listener?.(({ message }) => {
    if (message?.client && !clientRef) clientRef = message.client;
  });

  register.component("loot:claim:", async ({ interaction }) => {
    if (!interaction.isButton?.() || !interaction.guildId) return;
    const token = String(interaction.customId || "").split(":")[2];
    const state = activeByGuild.get(String(interaction.guildId));
    if (!state || state.token !== token || state.finished || Date.now() >= state.endsAtMs) {
      await interaction.reply({ content: "This loot drop has ended.", flags: MessageFlags.Ephemeral });
      return;
    }

    const userId = String(interaction.user?.id || "");
    if (state.claimants.has(userId)) {
      await interaction.reply({ content: "You already claimed this loot drop.", flags: MessageFlags.Ephemeral });
      return;
    }
    const displayName = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || userId;
    const claimant = { userId, displayName: String(displayName) };
    state.claimants.set(userId, claimant);

    if (state.mode === "first") {
      await interaction.reply({ content: "You claimed the loot first!", flags: MessageFlags.Ephemeral });
      await finishLoot(state, claimant);
      return;
    }
    await interaction.reply({
      content: state.mode === "all" ? "Loot claimed!" : "You entered the random loot draw!",
      flags: MessageFlags.Ephemeral,
    });
  });

  register.expose({
    logicalId: "loot.main",
    name: "loot",
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
        await message.reply("You do not have permission to manage loot.");
        return;
      }
      if (sub === "config") return handleConfig(message, tokens, prefix);
      if (sub === "run") {
        if (String(tokens.shift() || "").toLowerCase() !== "now") {
          return message.reply(`Usage: \`${prefix}loot run now [random|first|all]\``);
        }
        return handleRunNow(message, tokens, prefix);
      }
      if (sub === "reset") {
        if (String(tokens.shift() || "").toLowerCase() !== "scores") {
          return message.reply(`Usage: \`${prefix}loot reset scores\``);
        }
        const count = await resetScores(message.guildId);
        await message.reply(`Reset loot scores for **${count}** player(s).`);
        return;
      }
      await message.reply(helpText(prefix));
    },
    help: "!loot — scheduled loot claims and leaderboard",
    opts: { helpTier: "normal" },
  });
}

export const __testables = {
  chooseLootWinners,
  modeDescription,
  renderDrop,
  renderResult,
};
