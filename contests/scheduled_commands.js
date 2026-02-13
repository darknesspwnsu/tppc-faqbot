// contests/scheduled_commands.js
//
// Admin/privileged scheduler for a small allowlist of contest bang commands.
// Slash-only:
// - /schedule create time:<relative> command:<!/?...>
// - /schedule list
// - /schedule cancel schedule_id:<id>
// - /schedule help

import { MessageFlags } from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { sendDm } from "../shared/dm.js";
import { logger } from "../shared/logger.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { clearTimer, startTimeout } from "../shared/timer_utils.js";
import { getVerifiedRoleIds } from "./eligibility.js";
import { parseSecondsToMs } from "./rng.js";

const MAX_SCHEDULE_SECONDS = 30 * 24 * 60 * 60;
const MAX_TIMEOUT_MS = 2_000_000_000; // setTimeout safety (~23 days)
const CONTESTSTART_MAX_MS = 24 * 60 * 60_000;
const MAX_PREVIEW_JOBS = 25;
const MAX_CMD_PREVIEW = 72;

const ALLOWED_LOGICAL_IDS = new Set([
  "rng.roll",
  "rng.choose",
  "rng.elim",
  "rng.awesome",
]);

const ALLOWED_CANONICAL = new Set([
  "!coinflip",
  "!conteststart",
  "!startreading",
  "!endreading",
]);

const timersById = new Map(); // id -> { job, timeout }
let booted = false;
let clientRef = null;

function trunc(text, max = MAX_CMD_PREVIEW) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

function parsePositiveInt(raw) {
  const n = Number(String(raw || "").trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function splitCommandText(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "Please provide a command to schedule." };
  if (!text.startsWith("!") && !text.startsWith("?")) {
    return { ok: false, error: "Scheduled commands must start with `!` or `?`." };
  }
  const spaceIdx = text.indexOf(" ");
  const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
  return { ok: true, text, cmd, rest };
}

function parseRelativeDelay(raw) {
  const original = String(raw || "").trim();
  if (!original) return { ok: false, error: "Please provide `time`." };

  const cleaned = original.replace(/\s+from\s+now$/i, "").trim();
  if (!/[a-z]/i.test(cleaned)) {
    return { ok: false, error: "Please include a time unit (for example `10m`, `2h`, `3d`)." };
  }

  const sec = parseDurationSeconds(cleaned, null);
  if (!Number.isFinite(sec) || sec <= 0) {
    return { ok: false, error: "Invalid `time`. Use formats like `10m`, `2h`, or `3d`." };
  }
  if (sec > MAX_SCHEDULE_SECONDS) {
    return { ok: false, error: "Scheduled time cannot exceed 30 days." };
  }

  return { ok: true, seconds: sec };
}

function parseContestDurationToMs(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return null;
  const sec = parseDurationSeconds(s, null);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

function validateRngRoll(rest) {
  const arg = String(rest || "").trim();
  const m = /^(\d+)d(\d+)(?:\s+(norepeat|nr))?$/i.exec(arg);
  if (!m) return { ok: false, error: "Invalid roll format. Use `NdM` (example: `1d100`)." };
  const noRepeat = Boolean(m[3]);
  const n = Number(m[1]);
  const sides = Number(m[2]);
  if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 1) {
    return { ok: false, error: "Invalid roll format. Use `NdM` (example: `1d100`)." };
  }
  if (noRepeat && n > sides) {
    return { ok: false, error: "Invalid roll: `norepeat` requires `N <= M`." };
  }
  return { ok: true };
}

function validateRngChoose(rest) {
  const options = String(rest || "").trim().split(/\s+/).filter(Boolean);
  if (options.length < 1) {
    return { ok: false, error: "Invalid choose format. Include at least one option." };
  }
  return { ok: true };
}

function validateRngElim(rest) {
  const parts = String(rest || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    return { ok: false, error: "Invalid elim format. Use `?elim <1-30s> <item1> <item2> [...]`." };
  }
  const parsed = parseSecondsToMs(parts[0]);
  if (parsed?.error) return { ok: false, error: parsed.error };
  return { ok: true };
}

function validateContestStart(rest, guildId) {
  const rawRest = String(rest || "");
  const t = rawRest.trim().toLowerCase();
  if (!t || t === "help" || t === "h" || t === "?") return { ok: true };

  let prize = "";
  let restSansPrize = rawRest;
  const prizeMatch = /(?:^|\s)prize=(.+)$/i.exec(rawRest);
  if (prizeMatch) {
    prize = prizeMatch[1].trim();
    restSansPrize = rawRest.replace(prizeMatch[0], "").trim();
  }

  const tokens = restSansPrize.trim().split(/\s+/).filter(Boolean);
  let mode = "list";
  let timeTok = tokens[0] || "";
  let extras = tokens.slice(1);

  const modeMaybe = (tokens[0] || "").toLowerCase();
  if (["choose", "elim", "list"].includes(modeMaybe)) {
    mode = modeMaybe;
    timeTok = tokens[1] || "";
    extras = tokens.slice(2);
  }

  const ms = parseContestDurationToMs(timeTok);
  if (!ms) {
    return {
      ok: false,
      error: "Invalid conteststart time. Use formats like `30sec`, `5min`, or `1hour`.",
    };
  }
  if (ms > CONTESTSTART_MAX_MS) {
    return { ok: false, error: "conteststart time cannot exceed 24 hours." };
  }

  let maxEntrants = null;
  let winnerCount = 1;
  let winnerExplicit = false;
  let requireVerified = false;

  for (const tok of extras) {
    const token = String(tok || "").trim();
    if (!token) continue;
    const lowered = token.toLowerCase();

    if (["require=verified", "require=eligible", "verified", "eligible"].includes(lowered)) {
      requireVerified = true;
      continue;
    }

    const winnerMatch = /^(winners?|pick|picks?)=(\d+)$/i.exec(token);
    if (winnerMatch) {
      winnerCount = Number(winnerMatch[2]);
      winnerExplicit = true;
      continue;
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (maxEntrants == null) {
        maxEntrants = n;
        continue;
      }
      if (mode === "choose" && !winnerExplicit) {
        winnerCount = n;
        winnerExplicit = true;
      }
    }
  }

  if (maxEntrants != null) {
    if (!Number.isInteger(maxEntrants) || maxEntrants <= 0 || maxEntrants > 1000) {
      return { ok: false, error: "Invalid conteststart quota. Use a positive integer up to 1000." };
    }
  }

  if (mode === "choose") {
    if (!Number.isInteger(winnerCount) || winnerCount <= 0 || winnerCount > 1000) {
      return { ok: false, error: "Invalid conteststart winners count (must be 1..1000)." };
    }
  }

  if (requireVerified && !getVerifiedRoleIds(guildId).length) {
    return { ok: false, error: "No verified roles are configured for this server." };
  }

  void prize; // parity with runtime parser shape
  return { ok: true };
}

function validateStrictCommandArgs({ preflight, cmd, rest, guildId }) {
  const logicalId = String(preflight?.exposeLogicalId || "");
  const canonical = String(preflight?.canonicalCmd || cmd || "").toLowerCase();

  if (logicalId === "rng.roll") return validateRngRoll(rest);
  if (logicalId === "rng.choose") return validateRngChoose(rest);
  if (logicalId === "rng.elim") return validateRngElim(rest);
  if (logicalId === "rng.awesome") return { ok: true };

  if (canonical === "!conteststart") return validateContestStart(rest, guildId);
  if (canonical === "!coinflip") return { ok: true };
  if (canonical === "!startreading") return { ok: true };
  if (canonical === "!endreading") return { ok: true };

  return { ok: false, error: "That command is not supported by `/schedule`." };
}

function isAllowedScheduledTarget(preflight) {
  const logicalId = String(preflight?.exposeLogicalId || "");
  if (logicalId && ALLOWED_LOGICAL_IDS.has(logicalId)) return true;
  const canonical = String(preflight?.canonicalCmd || "").toLowerCase();
  return ALLOWED_CANONICAL.has(canonical);
}

function preflightReasonText(result) {
  const reason = String(result?.reason || "unknown");
  if (reason === "unknown_command") return "Command not found.";
  if (reason === "wrong_prefix") return "That prefix is not allowed for this command in this server.";
  if (reason === "exposure_off") return "That command is disabled in this server.";
  if (reason === "channel_blocked") {
    return result?.notifyText || "That command is not allowed in this channel.";
  }
  if (reason === "handler_error") return "The command failed while running.";
  return "Command preflight failed.";
}

function scheduleHelpText() {
  return [
    "**/schedule help**",
    "",
    "**Subcommands:**",
    "• `/schedule create time:<10m|2h|3d> command:<!/...>`",
    "• `/schedule list`",
    "• `/schedule cancel schedule_id:<id>`",
    "",
    "**Rules:**",
    "• Admin/privileged only.",
    "• Time must be relative and <= 30 days.",
    "• Scheduled command must start with `!` or `?`.",
    "",
    "**Allowed commands:**",
    "• `!/?roll`, `!/?choose`, `!/?elim`, `!/?awesome`",
    "• `!coinflip`, `!conteststart`, `!startReading`, `!endReading`",
  ].join("\n");
}

function toUnix(ms) {
  return Math.max(0, Math.floor(Number(ms || 0) / 1000));
}

function rowToJob(row) {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    creatorUserId: String(row.creator_user_id),
    commandText: String(row.command_text || ""),
    executeAtMs: Number(row.execute_at_ms),
    createdAtMs: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

async function addScheduledCommand({ guildId, channelId, creatorUserId, commandText, executeAtMs }) {
  const db = getDb();
  const [result] = await db.execute(
    `INSERT INTO scheduled_contest_commands (
      guild_id, channel_id, creator_user_id, command_text, execute_at_ms
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      String(guildId),
      String(channelId),
      String(creatorUserId),
      String(commandText),
      Number(executeAtMs),
    ]
  );
  const id = Number(result?.insertId);
  return Number.isFinite(id) ? id : null;
}

async function listScheduledCommandsForGuild(guildId) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, guild_id, channel_id, creator_user_id, command_text, execute_at_ms, created_at
     FROM scheduled_contest_commands
     WHERE guild_id = ?
     ORDER BY execute_at_ms ASC`,
    [String(guildId)]
  );
  return (rows || []).map(rowToJob);
}

async function getScheduledCommandById({ guildId, id }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, guild_id, channel_id, creator_user_id, command_text, execute_at_ms, created_at
     FROM scheduled_contest_commands
     WHERE guild_id = ? AND id = ?
     LIMIT 1`,
    [String(guildId), Number(id)]
  );
  if (!rows?.length) return null;
  return rowToJob(rows[0]);
}

async function deleteScheduledCommandById({ guildId, id }) {
  const db = getDb();
  const [result] = await db.execute(
    `DELETE FROM scheduled_contest_commands WHERE guild_id = ? AND id = ?`,
    [String(guildId), Number(id)]
  );
  return Number(result?.affectedRows || 0);
}

async function loadAllScheduledCommands() {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, guild_id, channel_id, creator_user_id, command_text, execute_at_ms, created_at
     FROM scheduled_contest_commands`
  );
  return (rows || []).map(rowToJob);
}

function clearJobTimeout(id) {
  const key = Number(id);
  const existing = timersById.get(key);
  if (existing?.timeout) clearTimer(existing.timeout, `schedule:${key}`);
  timersById.delete(key);
}

async function notifyFailureDm(job, reason) {
  if (!clientRef) return;
  try {
    const user = await clientRef.users.fetch(job.creatorUserId);
    if (!user) return;
    const payload =
      `⚠️ Scheduled command #${job.id} failed.\n` +
      `Command: \`${job.commandText}\`\n` +
      `When: <t:${toUnix(job.executeAtMs)}:f>\n` +
      `Channel: <#${job.channelId}>\n` +
      `Reason: ${reason}`;
    const res = await sendDm({
      user,
      payload,
      feature: "schedule",
    });
    if (!res.ok && res.code !== 50007) {
      logger.warn("schedule.dm.failed", { id: job.id, reason, error: res.error || null });
    }
  } catch (err) {
    logger.warn("schedule.dm.failed", { id: job.id, reason, error: logger.serializeError(err) });
  }
}

function buildSyntheticMessage({
  client,
  guild,
  channel,
  guildId,
  channelId,
  userId,
  member,
  commandText,
  dryRun = false,
}) {
  const mentionMatches = [...String(commandText || "").matchAll(/<@!?(\d+)>/g)];
  const mentionUsers = mentionMatches.map((m) => ({ id: String(m[1]) }));

  return {
    __dryRun: Boolean(dryRun),
    content: String(commandText || ""),
    client,
    guild,
    guildId,
    channel,
    channelId,
    author: { id: String(userId || ""), bot: false },
    user: { id: String(userId || "") },
    member,
    mentions: {
      users: {
        first: () => mentionUsers[0] || null,
      },
    },
    reply: async (payload) => {
      if (!channel?.send) return null;
      return channel.send(payload);
    },
  };
}

async function executeScheduledCommand(job) {
  if (!clientRef) {
    await notifyFailureDm(job, "Bot client is not ready.");
    return;
  }

  const registry = clientRef.spectreonCommandRegistry;
  if (!registry?.dispatchMessage) {
    await notifyFailureDm(job, "Command registry is unavailable.");
    return;
  }

  const guild =
    clientRef.guilds?.cache?.get?.(job.guildId) ||
    (await clientRef.guilds.fetch(job.guildId).catch(() => null));
  if (!guild) {
    await notifyFailureDm(job, "Server is unavailable.");
    return;
  }

  const channel =
    clientRef.channels?.cache?.get?.(job.channelId) ||
    (await clientRef.channels.fetch(job.channelId).catch(() => null));
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    await notifyFailureDm(job, "Target channel is unavailable.");
    return;
  }

  const member = await guild.members.fetch(job.creatorUserId).catch(() => null);
  if (!member) {
    await notifyFailureDm(job, "Command creator is no longer in the server.");
    return;
  }

  const authLike = { guildId: job.guildId, member, author: { id: job.creatorUserId } };
  if (!isAdminOrPrivileged(authLike)) {
    await notifyFailureDm(job, "Creator no longer has admin/privileged permission.");
    return;
  }

  const split = splitCommandText(job.commandText);
  if (!split.ok) {
    await notifyFailureDm(job, split.error);
    return;
  }

  const dryRunMsg = buildSyntheticMessage({
    client: clientRef,
    guild,
    channel,
    guildId: job.guildId,
    channelId: job.channelId,
    userId: job.creatorUserId,
    member,
    commandText: split.text,
    dryRun: true,
  });
  const preflight = await registry.dispatchMessage(dryRunMsg);
  if (!preflight?.ok) {
    await notifyFailureDm(job, preflightReasonText(preflight));
    return;
  }

  if (!isAllowedScheduledTarget(preflight)) {
    await notifyFailureDm(job, "That command is no longer allowed by the scheduler.");
    return;
  }

  const strict = validateStrictCommandArgs({
    preflight,
    cmd: split.cmd,
    rest: split.rest,
    guildId: job.guildId,
  });
  if (!strict.ok) {
    await notifyFailureDm(job, strict.error || "Command arguments are no longer valid.");
    return;
  }

  const runMsg = buildSyntheticMessage({
    client: clientRef,
    guild,
    channel,
    guildId: job.guildId,
    channelId: job.channelId,
    userId: job.creatorUserId,
    member,
    commandText: split.text,
    dryRun: false,
  });
  const execRes = await registry.dispatchMessage(runMsg);
  if (!execRes?.ok) {
    await notifyFailureDm(job, preflightReasonText(execRes));
  }
}

async function finalizeJob(job) {
  clearJobTimeout(job.id);
  try {
    await executeScheduledCommand(job);
  } catch (err) {
    logger.error("schedule.execute.failed", { id: job.id, error: logger.serializeError(err) });
    await notifyFailureDm(job, "Unexpected scheduler error.");
  } finally {
    try {
      await deleteScheduledCommandById({ guildId: job.guildId, id: job.id });
    } catch (err) {
      logger.warn("schedule.delete.failed", { id: job.id, error: logger.serializeError(err) });
    }
  }
}

function scheduleJob(job) {
  if (!job || !Number.isFinite(job.executeAtMs) || !Number.isFinite(job.id)) return;
  clearJobTimeout(job.id);

  const delay = Number(job.executeAtMs) - Date.now();
  if (delay <= 0) {
    void finalizeJob(job);
    return;
  }

  const wait = Math.min(delay, MAX_TIMEOUT_MS);
  const timeout = startTimeout({
    label: `schedule:${job.id}`,
    ms: wait,
    fn: () => {
      const remaining = Number(job.executeAtMs) - Date.now();
      if (remaining > 0) {
        scheduleJob(job);
        return;
      }
      void finalizeJob(job);
    },
  });
  if (typeof timeout?.unref === "function") timeout.unref();
  timersById.set(Number(job.id), { job, timeout });
}

async function boot(client) {
  if (client) clientRef = client;
  if (booted) return;
  booted = true;
  try {
    const jobs = await loadAllScheduledCommands();
    for (const job of jobs) scheduleJob(job);
  } catch (err) {
    logger.error("schedule.boot.failed", { error: logger.serializeError(err) });
  }
}

function stopScheduler() {
  for (const [id, entry] of timersById.entries()) {
    clearTimer(entry?.timeout, `schedule:${id}`);
  }
  timersById.clear();
  booted = false;
}

async function ensureAdminOrPrivileged(interaction) {
  if (isAdminOrPrivileged(interaction)) return true;
  await interaction.reply({
    content: "❌ You do not have permission to use this command.",
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

export function registerScheduledCommandsScheduler(context = {}) {
  registerScheduler(
    "scheduled_contest_commands",
    (runtimeContext = {}) => {
      const nextClient = runtimeContext.client || context.client || null;
      if (nextClient) clientRef = nextClient;
      void boot(nextClient);
    },
    () => stopScheduler()
  );
}

export function registerScheduledCommands(register) {
  register.listener(({ message }) => {
    if (!message?.client) return;
    void boot(message.client);
  });

  register.slash(
    {
      name: "schedule",
      description: "Schedule approved contest commands",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "create",
          description: "Schedule a one-time command run",
          options: [
            {
              type: 3, // STRING
              name: "time",
              description: "Relative delay (e.g. 10m, 2h, 3d)",
              required: true,
            },
            {
              type: 3, // STRING
              name: "command",
              description: "Bang/q contest command to execute later",
              required: true,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "list",
          description: "List pending scheduled commands in this server",
        },
        {
          type: 1, // SUB_COMMAND
          name: "cancel",
          description: "Cancel a scheduled command by ID",
          options: [
            {
              type: 3, // STRING
              name: "schedule_id",
              description: "ID from /schedule list",
              required: true,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "help",
          description: "Show scheduler usage and allowed commands",
        },
      ],
    },
    async ({ interaction }) => {
      await boot(interaction.client);

      if (!interaction.guildId || !interaction.channelId || !interaction.guild || !interaction.channel) {
        await interaction.reply({
          content: "This command must be used in a server channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const allowed = await ensureAdminOrPrivileged(interaction);
      if (!allowed) return;

      const sub = interaction.options?.getSubcommand?.() || "";

      if (sub === "create") {
        const timeRaw = String(interaction.options?.getString?.("time") || "").trim();
        const commandRaw = String(interaction.options?.getString?.("command") || "").trim();

        const delay = parseRelativeDelay(timeRaw);
        if (!delay.ok) {
          await interaction.reply({
            content: `❌ ${delay.error}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const split = splitCommandText(commandRaw);
        if (!split.ok) {
          await interaction.reply({
            content: `❌ ${split.error}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const registry = interaction.client?.spectreonCommandRegistry;
        if (!registry?.dispatchMessage) {
          await interaction.reply({
            content: "❌ Scheduler is unavailable: command registry is missing.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const dryRunMsg = buildSyntheticMessage({
          client: interaction.client,
          guild: interaction.guild,
          channel: interaction.channel,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user?.id,
          member: interaction.member,
          commandText: split.text,
          dryRun: true,
        });
        const preflight = await registry.dispatchMessage(dryRunMsg);
        if (!preflight?.ok) {
          await interaction.reply({
            content: `❌ ${preflightReasonText(preflight)}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!isAllowedScheduledTarget(preflight)) {
          await interaction.reply({
            content: "❌ That command is not allowed by `/schedule`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const strict = validateStrictCommandArgs({
          preflight,
          cmd: split.cmd,
          rest: split.rest,
          guildId: interaction.guildId,
        });
        if (!strict.ok) {
          await interaction.reply({
            content: `❌ ${strict.error}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const executeAtMs = Date.now() + delay.seconds * 1000;
        const id = await addScheduledCommand({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          creatorUserId: interaction.user?.id,
          commandText: split.text,
          executeAtMs,
        });
        if (!id) {
          await interaction.reply({
            content: "❌ Failed to create schedule.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const job = {
          id,
          guildId: String(interaction.guildId),
          channelId: String(interaction.channelId),
          creatorUserId: String(interaction.user?.id || ""),
          commandText: split.text,
          executeAtMs,
          createdAtMs: Date.now(),
        };
        scheduleJob(job);

        await interaction.reply({
          content:
            `✅ Scheduled command **#${id}** for <t:${toUnix(executeAtMs)}:f> (<t:${toUnix(
              executeAtMs
            )}:R>).\n` + `Command: \`${split.text}\``,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const jobs = await listScheduledCommandsForGuild(interaction.guildId);
        if (!jobs.length) {
          await interaction.reply({
            content: "No scheduled commands found for this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = jobs.slice(0, MAX_PREVIEW_JOBS).map((job) => {
          return (
            `#${job.id} • <t:${toUnix(job.executeAtMs)}:R> • <#${job.channelId}> • ` +
            `<@${job.creatorUserId}> • \`${trunc(job.commandText)}\``
          );
        });
        if (jobs.length > MAX_PREVIEW_JOBS) {
          lines.push(`...and ${jobs.length - MAX_PREVIEW_JOBS} more.`);
        }

        await interaction.reply({
          content: `Scheduled commands (${jobs.length}):\n${lines.join("\n")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "cancel") {
        const rawId = String(interaction.options?.getString?.("schedule_id") || "").trim();
        const id = parsePositiveInt(rawId);
        if (!id) {
          await interaction.reply({
            content: "❌ Please provide a valid `schedule_id`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const existing = await getScheduledCommandById({ guildId: interaction.guildId, id });
        if (!existing) {
          await interaction.reply({
            content: "No scheduled command found with that ID in this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deleteScheduledCommandById({ guildId: interaction.guildId, id });
        clearJobTimeout(id);

        await interaction.reply({
          content: `✅ Cancelled scheduled command #${id}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "help") {
        await interaction.reply({
          content: scheduleHelpText(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: "Unknown subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    { admin: true, adminCategory: "Contests" }
  );
}

export const __testables = {
  parseRelativeDelay,
  splitCommandText,
  validateStrictCommandArgs,
  validateContestStart,
  isAllowedScheduledTarget,
  preflightReasonText,
  resetState: () => {
    for (const [id, entry] of timersById.entries()) {
      clearTimer(entry?.timeout, `schedule:${id}`);
    }
    timersById.clear();
    booted = false;
    clientRef = null;
  },
};
