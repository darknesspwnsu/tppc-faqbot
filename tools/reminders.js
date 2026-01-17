// tools/reminders.js
//
// /notifyme and /remindme (slash only).

import { MessageFlags } from "discord.js";
import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { includesWholePhrase, normalizeForMatch } from "../contests/helpers.js";
import { metrics } from "../shared/metrics.js";
import { sendDm } from "../shared/dm.js";
import { startTimeout, clearTimer } from "../shared/timer_utils.js";

const MAX_NOTIFY_PER_USER = 10;
const MAX_REMIND_PER_USER = 10;
const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
const MAX_TIMEOUT_MS = 2_000_000_000; // ~23 days (setTimeout limit safety)

const notifyByGuild = new Map(); // guildId -> { loaded, items: [{ id, userId, phrase, key }] }
const remindersById = new Map(); // reminderId -> { reminder, timeout }
let booted = false;

function mention(id) {
  return `<@${id}>`;
}

function norm(s) {
  return String(s ?? "").trim();
}

function phraseKey(phrase) {
  return normalizeForMatch(phrase);
}

function formatLink({ guildId, channelId, messageId }) {
  if (!guildId || !channelId || !messageId) return "";
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function parseDurationExtended(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);

  const m = s.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|mon|month|months|y|yr|yrs|year|years)$/
  );
  if (!m) return null;
  const v = Number(m[1]);
  const u = m[2];
  if (u.startsWith("s")) return v;
  if (u.startsWith("m") && u !== "mo" && u !== "mon" && !u.startsWith("month")) return v * 60;
  if (u.startsWith("h")) return v * 3600;
  if (u.startsWith("d")) return v * 86400;
  if (u.startsWith("w")) return v * 7 * 86400;
  if (u === "mo" || u === "mon" || u.startsWith("month")) return v * 30 * 86400;
  if (u.startsWith("y")) return v * 365 * 86400;
  return null;
}

async function ensureDmAvailable(user, feature) {
  const res = await sendDm({
    user,
    payload: "✅ I can DM you for reminders/notifications.",
    feature: feature || "reminders",
  });
  if (res.ok) return true;
  if (res.code === 50007) return false;
  throw res.error;
}

function getNotifyState(guildId) {
  const gid = String(guildId || "");
  if (!notifyByGuild.has(gid)) {
    notifyByGuild.set(gid, { loaded: false, items: [] });
  }
  return notifyByGuild.get(gid);
}

async function loadNotifyGuild(guildId) {
  const state = getNotifyState(guildId);
  if (state.loaded) return state;
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, user_id, phrase, target_user_id FROM notify_me WHERE guild_id = ?`,
    [String(guildId)]
  );
  state.items = (rows || []).map((row) => ({
    id: Number(row.id),
    userId: String(row.user_id),
    phrase: String(row.phrase || ""),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    key: phraseKey(row.phrase),
  }));
  state.loaded = true;
  return state;
}

async function addNotifyEntry({ guildId, userId, phrase, targetUserId }) {
  const db = getDb();
  const [result] = await db.execute(
    `INSERT INTO notify_me (guild_id, user_id, phrase, target_user_id) VALUES (?, ?, ?, ?)`,
    [String(guildId), String(userId), String(phrase), targetUserId ? String(targetUserId) : null]
  );
  const id = Number(result?.insertId);
  return Number.isFinite(id) ? id : null;
}

async function deleteNotifyEntry({ id, userId }) {
  const db = getDb();
  await db.execute(`DELETE FROM notify_me WHERE id = ? AND user_id = ?`, [
    Number(id),
    String(userId),
  ]);
}

async function clearNotifyEntries({ guildId, userId }) {
  const db = getDb();
  await db.execute(`DELETE FROM notify_me WHERE guild_id = ? AND user_id = ?`, [
    String(guildId),
    String(userId),
  ]);
}

async function listNotifyEntries({ guildId, userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, phrase, target_user_id, created_at FROM notify_me WHERE guild_id = ? AND user_id = ? ORDER BY id ASC`,
    [String(guildId), String(userId)]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    phrase: String(row.phrase || ""),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
  }));
}

async function countNotifyEntries({ userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM notify_me WHERE user_id = ?`,
    [String(userId)]
  );
  return Number(rows?.[0]?.total || 0);
}

async function listReminders({ userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, phrase, message_id, channel_id, guild_id, remind_at_ms
     FROM reminders
     WHERE user_id = ?
     ORDER BY remind_at_ms ASC`,
    [String(userId)]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    phrase: row.phrase ? String(row.phrase) : "",
    messageId: row.message_id ? String(row.message_id) : "",
    channelId: row.channel_id ? String(row.channel_id) : "",
    guildId: row.guild_id ? String(row.guild_id) : "",
    remindAtMs: Number(row.remind_at_ms),
  }));
}

async function addReminder({
  userId,
  guildId,
  channelId,
  messageId,
  phrase,
  remindAtMs,
}) {
  const db = getDb();
  const [result] = await db.execute(
    `INSERT INTO reminders (user_id, guild_id, channel_id, message_id, phrase, remind_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      String(userId),
      guildId ? String(guildId) : null,
      channelId ? String(channelId) : null,
      messageId ? String(messageId) : null,
      phrase ? String(phrase) : null,
      Number(remindAtMs),
    ]
  );
  const id = Number(result?.insertId);
  return Number.isFinite(id) ? id : null;
}

async function deleteReminder({ id, userId }) {
  const db = getDb();
  await db.execute(`DELETE FROM reminders WHERE id = ? AND user_id = ?`, [
    Number(id),
    String(userId),
  ]);
}

async function clearReminders({ userId }) {
  const db = getDb();
  await db.execute(`DELETE FROM reminders WHERE user_id = ?`, [String(userId)]);
}

async function loadAllReminders() {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, user_id, guild_id, channel_id, message_id, phrase, remind_at_ms
     , created_at
     FROM reminders`
  );
  for (const row of rows || []) {
    const reminder = {
      id: Number(row.id),
      userId: String(row.user_id),
      guildId: row.guild_id ? String(row.guild_id) : "",
      channelId: row.channel_id ? String(row.channel_id) : "",
      messageId: row.message_id ? String(row.message_id) : "",
      phrase: row.phrase ? String(row.phrase) : "",
      remindAtMs: Number(row.remind_at_ms),
      createdAtMs: row.created_at ? new Date(row.created_at).getTime() : null,
    };
    if (reminder.remindAtMs <= Date.now()) {
      void fireReminder(reminder);
    } else {
      scheduleReminder(reminder);
    }
  }
}

async function boot(client) {
  if (booted) return;
  booted = true;
  try {
    await loadAllReminders();
  } catch (err) {
    console.error("[reminders] failed to load reminders:", err);
  }
  // keep reference to client for reminder delivery
  if (client) {
    boot.client = client;
  }
}

function clearReminderTimeout(id) {
  const entry = remindersById.get(id);
  if (entry?.timeout) clearTimer(entry.timeout, `reminder:${id}`);
  remindersById.delete(id);
}

function scheduleReminder(reminder) {
  if (!reminder || !Number.isFinite(reminder.remindAtMs)) return;
  clearReminderTimeout(reminder.id);

  const delay = reminder.remindAtMs - Date.now();
  if (delay <= 0) {
    void fireReminder(reminder);
    return;
  }

  const wait = Math.min(delay, MAX_TIMEOUT_MS);
  const timeout = startTimeout({
    label: `reminder:${reminder.id}`,
    ms: wait,
    fn: () => {
    const remaining = reminder.remindAtMs - Date.now();
    if (remaining > 0) {
      scheduleReminder(reminder);
      return;
    }
    void fireReminder(reminder);
    },
  });

  remindersById.set(reminder.id, { reminder, timeout });
}

function formatAge(fromMs, nowMs = Date.now()) {
  if (!Number.isFinite(fromMs)) return "";
  const diff = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function fireReminder(reminder) {
  clearReminderTimeout(reminder.id);

  try {
    const client = boot.client;
    if (!client) return;
    const user = await client.users.fetch(reminder.userId);
    if (!user) return;
    const link = formatLink({
      guildId: reminder.guildId,
      channelId: reminder.channelId,
      messageId: reminder.messageId,
    });
    const ageLabel = formatAge(reminder.createdAtMs);
    const suffix = ageLabel ? ` (set ${ageLabel})` : "";
    let res = { ok: true };
    if (reminder.messageId && link) {
      res = await sendDm({
        user,
        payload: `⏰ **Reminder**: ${link}${suffix}`,
        feature: "remindme",
      });
    } else if (reminder.phrase) {
      res = await sendDm({
        user,
        payload: `⏰ **Reminder**: ${reminder.phrase}${suffix}`,
        feature: "remindme",
      });
    }
    void metrics.increment("remindme.trigger", { status: res.ok ? "ok" : "error" });
    if (!res.ok && res.code !== 50007) {
      console.warn("[reminders] failed to deliver reminder:", res.error);
    }
  } catch (err) {
    void metrics.increment("remindme.trigger", { status: "error" });
    console.warn("[reminders] failed to deliver reminder:", err);
  } finally {
    try {
      await deleteReminder({ id: reminder.id, userId: reminder.userId });
    } catch (err) {
      console.warn("[reminders] failed to delete reminder:", err);
    }
  }
}

function buildNotifyChoices(items, focused) {
  const q = String(focused || "").toLowerCase();
  const filtered = (items || []).filter((x) => !q || x.phrase.toLowerCase().includes(q));
  return filtered.slice(0, 25).map((x) => ({
    name: x.phrase.length > 90 ? `${x.phrase.slice(0, 87)}…` : x.phrase,
    value: String(x.id),
  }));
}

function buildReminderChoices(items, focused) {
  const q = String(focused || "").toLowerCase();
  const filtered = (items || []).filter((x) => {
    const label = x.phrase || (x.messageId ? `Message ${x.messageId}` : "");
    return !q || label.toLowerCase().includes(q);
  });
  return filtered.slice(0, 25).map((x) => ({
    name: (x.phrase || `Message ${x.messageId}`).slice(0, 90),
    value: String(x.id),
  }));
}

function renderNotifyList(items) {
  if (!items.length) return "You have no active notifications.";
  const lines = items.map((x, idx) => {
    const suffix = x.targetUserId ? ` (from ${mention(x.targetUserId)})` : "";
    return `${idx + 1}. ${x.phrase}${suffix}`;
  });
  return `Your notifications:\n${lines.join("\n")}`;
}

function renderRemindList(items) {
  if (!items.length) return "You have no active reminders.";
  const lines = items.map((x, idx) => {
    const label = x.phrase || `Message ${x.messageId}`;
    const when = x.remindAtMs ? `<t:${Math.floor(x.remindAtMs / 1000)}:R>` : "";
    return `${idx + 1}. ${label}${when ? ` — ${when}` : ""}`;
  });
  return `Your reminders:\n${lines.join("\n")}`;
}

export function registerReminders(register) {
  /**
   * /notifyme
   * - Guild-scoped phrase watcher: triggers only for messages in the same server.
   * - Case-insensitive whole-phrase matching.
   * - Optional target user to match only messages from that user (including bots).
   * - Limit: 10 notifications per user across all servers (admin/privileged exempt).
   * - /notifyme clear removes all notifications for the current server only.
   */
  register.listener(async ({ message }) => {
    if (!message?.guildId) return;
    await boot(message.client);

    const state = await loadNotifyGuild(message.guildId);
    if (!state.items.length) return;

    const normalized = normalizeForMatch(message.content || "");
    if (!normalized || normalized === " ") return;

    const authorId = message.author?.id || "";
    const isBot = !!message.author?.bot;
    const matches = state.items.filter((item) => {
      if (item.targetUserId && item.targetUserId !== authorId) return false;
      if (isBot && !item.targetUserId) return false;
      return includesWholePhrase(normalized, item.phrase);
    });
    if (!matches.length) return;

    for (const item of matches) {
      try {
        const user = await message.client.users.fetch(item.userId);
        if (!user) continue;
        const link = formatLink({
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
        });
        const res = await sendDm({
          user,
          payload:
            `🔔 **NotifyMe**: "${item.phrase}" mentioned by ${mention(message.author?.id)} in <#${message.channelId}>.\n${link}\n\nNotifyMe will continue to notify you of this phrase. To stop receiving notifications for this message, use \`/notifyme unset\` in the server.`,
          feature: "notifyme",
        });
        if (res.ok) {
          void metrics.increment("notifyme.trigger", { status: "ok" });
        } else if (res.code === 50007) {
          void metrics.increment("notifyme.trigger", { status: "blocked" });
        } else {
          void metrics.increment("notifyme.trigger", { status: "error" });
          console.warn("[notifyme] DM failed:", res.error);
        }
      } catch (err) {
        void metrics.increment("notifyme.trigger", { status: "error" });
        console.warn("[notifyme] DM failed:", err);
      }
    }
  });

  register.slash(
    {
      name: "notifyme",
      description: "Get a DM when a phrase is mentioned",
      options: [
        {
          type: 1,
          name: "set",
          description: "Add a phrase to watch (case-insensitive)",
          options: [
            {
              type: 3,
              name: "phrase",
              description: "Phrase to watch for",
              required: true,
            },
            {
              type: 6,
              name: "from_user",
              description: "Only notify when this user says the phrase",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List your notifications for this server",
        },
        {
          type: 1,
          name: "clear",
          description: "Clear all notifications for this server",
        },
        {
          type: 1,
          name: "unset",
          description: "Remove a notification",
          options: [
            {
              type: 3,
              name: "notify_id",
              description: "Notification to remove",
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
    async ({ interaction }) => {
      await boot(interaction.client);

      const sub = interaction.options?.getSubcommand?.() || "";
      const userId = interaction.user?.id;

      if (sub === "set") {
        const phrase = norm(interaction.options?.getString?.("phrase"));
        const targetUser = interaction.options?.getUser?.("from_user") || null;
        const targetUserId = targetUser?.id || null;
        if (!phrase) {
          await interaction.reply({
            content: "Please provide a phrase to watch for.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const dmOk = await ensureDmAvailable(interaction.user, "notifyme");
        if (!dmOk) {
          await interaction.reply({
            content: "❌ I couldn’t DM you. Please enable DMs from this server and try again.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const state = await loadNotifyGuild(interaction.guildId);
        const isExempt = isAdminOrPrivileged(interaction);
        const totalForUser = await countNotifyEntries({ userId });
        if (!isExempt && totalForUser >= MAX_NOTIFY_PER_USER) {
          await interaction.reply({
            content: `You can only have ${MAX_NOTIFY_PER_USER} notifications.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const key = phraseKey(phrase);
        const exists = state.items.some((item) => {
          if (item.userId !== userId) return false;
          if (item.key !== key) return false;
          return (item.targetUserId || null) === (targetUserId || null);
        });
        if (exists) {
          await interaction.reply({
            content: `You are already watching: "${phrase}"`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const id = await addNotifyEntry({
          guildId: interaction.guildId,
          userId,
          phrase,
          targetUserId,
        });
        if (!id) {
          await interaction.reply({
            content: "❌ Failed to save notification.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        state.items.push({ id, userId, phrase, key, targetUserId });
        void metrics.increment("notifyme.set", { status: "ok" });
        const suffix = targetUserId ? ` (from ${mention(targetUserId)})` : "";
        await interaction.reply({
          content: `✅ I’ll notify you when I see: "${phrase}"${suffix}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const items = await listNotifyEntries({
          guildId: interaction.guildId,
          userId,
        });
        void metrics.increment("notifyme.list", { status: "ok" });
        await interaction.reply({
          content: renderNotifyList(items),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "unset") {
        const idRaw = interaction.options?.getString?.("notify_id") || "";
        const id = Number(idRaw);
        if (!Number.isFinite(id)) {
          await interaction.reply({
            content: "Please choose a notification to remove.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deleteNotifyEntry({ id, userId });
        const state = await loadNotifyGuild(interaction.guildId);
        state.items = state.items.filter((item) => !(item.id === id && item.userId === userId));

        void metrics.increment("notifyme.unset", { status: "ok" });
        await interaction.reply({
          content: "✅ Notification removed.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "clear") {
        await clearNotifyEntries({ guildId: interaction.guildId, userId });
        const state = await loadNotifyGuild(interaction.guildId);
        state.items = state.items.filter((item) => item.userId !== userId);

        void metrics.increment("notifyme.clear", { status: "ok" });
        await interaction.reply({
          content: "✅ Cleared all notifications for this server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: "Unknown subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    {
      autocomplete: async ({ interaction }) => {
        const sub = interaction.options?.getSubcommand?.() || "";
        if (sub !== "unset") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options?.getFocused?.() || "";
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.respond([]);
          return;
        }
        const state = await loadNotifyGuild(guildId);
        const userId = interaction.user?.id;
        const items = state.items.filter((item) => item.userId === userId);
        await interaction.respond(buildNotifyChoices(items, focused));
      },
    }
  );

  /**
   * /remindme
   * - Personal reminders across servers and DMs (DMs supported for phrase reminders).
   * - Limit: 10 reminders per user total (admin/privileged exempt).
   * - message_id reminders only allowed when set in a server the bot is in.
   * - /remindme clear removes all reminders for the user across all contexts.
   */
  register.slash(
    {
      name: "remindme",
      description: "Set a reminder",
      options: [
        {
          type: 1,
          name: "set",
          description: "Set a reminder",
          options: [
            {
              type: 3,
              name: "time",
              description: "Duration (e.g. 10m, 2h, 3d, 2w, 1y)",
              required: true,
            },
            {
              type: 3,
              name: "phrase",
              description: "Reminder text",
              required: false,
            },
            {
              type: 3,
              name: "message_id",
              description: "Message ID to link",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List your reminders",
        },
        {
          type: 1,
          name: "clear",
          description: "Clear all reminders",
        },
        {
          type: 1,
          name: "unset",
          description: "Remove a reminder",
          options: [
            {
              type: 3,
              name: "reminder_id",
              description: "Reminder to remove",
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
    async ({ interaction }) => {
      await boot(interaction.client);

      const sub = interaction.options?.getSubcommand?.() || "";
      const userId = interaction.user?.id;

      if (sub === "set") {
        const phrase = norm(interaction.options?.getString?.("phrase"));
        const messageId = norm(interaction.options?.getString?.("message_id"));
        const timeRaw = norm(interaction.options?.getString?.("time"));
        if ((phrase && messageId) || (!phrase && !messageId)) {
          await interaction.reply({
            content: "Please provide exactly one of `phrase` or `message_id`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (messageId && !/^\d+$/.test(messageId)) {
          await interaction.reply({
            content: "Please provide a valid numeric message ID.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const seconds = parseDurationExtended(timeRaw);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          await interaction.reply({
            content: "Please provide a valid duration (e.g. 10m, 2h, 3d, 2w, 1y).",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (seconds > MAX_DURATION_SECONDS) {
          await interaction.reply({
            content: "Reminders cannot exceed 1 year.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const dmOk = await ensureDmAvailable(interaction.user, "remindme");
        if (!dmOk) {
          await interaction.reply({
            content: "❌ I couldn’t DM you. Please enable DMs from this server and try again.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const existing = await listReminders({ userId });
        const isExempt = isAdminOrPrivileged(interaction);
        if (!isExempt && existing.length >= MAX_REMIND_PER_USER) {
          await interaction.reply({
            content: `You can only have ${MAX_REMIND_PER_USER} reminders.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildId = interaction.guildId || "";
        if (messageId) {
          if (!guildId) {
            await interaction.reply({
              content: "Message ID reminders only work when set inside a server.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const inGuild = interaction.client?.guilds?.cache?.has?.(guildId);
          if (!inGuild) {
            await interaction.reply({
              content: "I can only link message IDs from servers I'm in.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        const remindAtMs = Date.now() + seconds * 1000;
        const id = await addReminder({
          userId,
          guildId: interaction.guildId || "",
          channelId: interaction.channelId || "",
          messageId: messageId || "",
          phrase: phrase || "",
          remindAtMs,
        });
        if (!id) {
          await interaction.reply({
            content: "❌ Failed to save reminder.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        scheduleReminder({
          id,
          userId,
          guildId,
          channelId: interaction.channelId || "",
          messageId: messageId || "",
          phrase: phrase || "",
          remindAtMs,
          createdAtMs: Date.now(),
        });

        void metrics.increment("remindme.set", { status: "ok" });
        await interaction.reply({
          content: "✅ Reminder set.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "list") {
        const items = await listReminders({ userId });
        void metrics.increment("remindme.list", { status: "ok" });
        await interaction.reply({
          content: renderRemindList(items),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "unset") {
        const idRaw = interaction.options?.getString?.("reminder_id") || "";
        const id = Number(idRaw);
        if (!Number.isFinite(id)) {
          await interaction.reply({
            content: "Please choose a reminder to remove.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deleteReminder({ id, userId });
        clearReminderTimeout(id);

        void metrics.increment("remindme.unset", { status: "ok" });
        await interaction.reply({
          content: "✅ Reminder removed.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "clear") {
        await clearReminders({ userId });
        void metrics.increment("remindme.clear", { status: "ok" });
        await interaction.reply({
          content: "✅ Cleared all reminders.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: "Unknown subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    {
      autocomplete: async ({ interaction }) => {
        const sub = interaction.options?.getSubcommand?.() || "";
        if (sub !== "unset") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options?.getFocused?.() || "";
        const items = await listReminders({
          userId: interaction.user?.id,
        });
        await interaction.respond(buildReminderChoices(items, focused));
      },
    }
  );
}

export const __testables = {
  parseDurationExtended,
  formatLink,
  scheduleReminder,
  fireReminder,
  phraseKey,
  renderNotifyList,
  renderRemindList,
  setBootClient: (client) => {
    boot.client = client;
  },
  resetState: () => {
    for (const entry of remindersById.values()) {
      clearTimer(entry?.timeout, "reminders.reset");
    }
    remindersById.clear();
    notifyByGuild.clear();
    booted = false;
    boot.client = null;
  },
};
