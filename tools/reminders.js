// tools/reminders.js
//
// /notifyme and /remindme (slash only).

import { MessageFlags } from "discord.js";
import { DateTime } from "luxon";
import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { includesWholePhrase, normalizeForMatch } from "../contests/helpers.js";
import { metrics } from "../shared/metrics.js";
import { sendDm } from "../shared/dm.js";
import { startTimeout, clearTimer } from "../shared/timer_utils.js";

const MAX_NOTIFY_PER_USER = 10;
const MAX_NOTIFY_IGNORED_USERS = 25;
const MAX_REMIND_PER_USER = 10;
const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
const MAX_TIMEOUT_MS = 2_000_000_000; // ~23 days (setTimeout limit safety)
const DEFAULT_REMINDME_TZ = "America/New_York";
const NOTIFY_SNIPPET_MAX_CHARS = 200;
const NOTIFY_SNIPPET_MAX_LINES = 3;

const TZ_ALIASES = new Map([
  ["UTC", "UTC"],
  ["GMT", "UTC"],
  ["ET", "America/New_York"],
  ["EST", "America/New_York"],
  ["EDT", "America/New_York"],
]);
const DATE_KEYWORDS = new Map([
  ["today", "today"],
  ["tdy", "today"],
  ["tomorrow", "tomorrow"],
  ["tomorow", "tomorrow"],
  ["tmr", "tomorrow"],
  ["tmoz", "tomorrow"],
  ["tomo", "tomorrow"],
]);

const notifyByGuild = new Map(); // guildId -> { loaded, items: [{ id, userId, phrase, key, targetUserId, ignoredUserIds }] }
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

function normalizeUserIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || "").trim()).filter(Boolean))]
    .filter((id) => /^\d{5,}$/.test(id))
    .sort((a, b) => a.localeCompare(b));
}

function parseUserIdsFromInput(raw) {
  const text = String(raw || "");
  const ids = new Set();
  for (const m of text.matchAll(/<@!?(\d{5,})>/g)) {
    ids.add(String(m[1]));
  }

  const cleaned = text.replace(/<@!?(\d{5,})>/g, " ").replace(/[,\n\r\t]/g, " ");
  for (const token of cleaned.split(" ").map((x) => x.trim()).filter(Boolean)) {
    if (/^\d{5,}$/.test(token)) ids.add(token);
  }

  return normalizeUserIds([...ids]);
}

function parseIgnoredUserIds(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return normalizeUserIds(parsed);
  } catch {
    return parseUserIdsFromInput(text);
  }
}

function serializeIgnoredUserIds(ids) {
  const normalized = normalizeUserIds(ids);
  return normalized.length ? JSON.stringify(normalized) : null;
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
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|mon|month|months|y|yr|yrs|year|years)$/
  );
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
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

function formatQuoteBlock(text) {
  const lines = String(text || "").split("\n");
  return lines.map((line) => `> ${line}`).join("\n");
}

function buildNotifySnippet(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";

  const lines = raw.split("\r").join("").split("\n");
  let truncated = false;
  if (lines.length > NOTIFY_SNIPPET_MAX_LINES) {
    lines.length = NOTIFY_SNIPPET_MAX_LINES;
    truncated = true;
  }

  let snippet = lines.join("\n");
  if (snippet.length > NOTIFY_SNIPPET_MAX_CHARS) {
    snippet = snippet.slice(0, NOTIFY_SNIPPET_MAX_CHARS);
    truncated = true;
  }

  if (truncated) {
    snippet = snippet.trimEnd() + "...";
  }

  return snippet;
}

function splitWhitespace(text) {
  const tokens = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isDigits(text) {
  if (!text) return false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch < "0" || ch > "9") return false;
  }
  return true;
}

function isOffsetToken(token) {
  if (!token || token.length < 3) return false;
  const sign = token[0];
  if (sign !== "+" && sign !== "-") return false;
  const rest = token.slice(1);
  const parts = rest.split(":");
  if (parts.length !== 2) return false;
  const [hh, mm] = parts;
  if (!isDigits(hh) || !isDigits(mm)) return false;
  const h = Number(hh);
  const m = Number(mm);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function normalizeTimezoneToken(token) {
  if (!token) return null;
  const upper = token.toUpperCase();
  if (TZ_ALIASES.has(upper)) return TZ_ALIASES.get(upper);
  if (isOffsetToken(token)) return token;
  return null;
}

function extractDateKeyword(tokens) {
  let keyword = null;
  const remaining = [];
  for (const token of tokens) {
    const mapped = DATE_KEYWORDS.get(String(token).toLowerCase());
    if (mapped && !keyword) {
      keyword = mapped;
      continue;
    }
    remaining.push(token);
  }
  return { keyword, tokens: remaining };
}

function parseTimeOnly(text, zone) {
  const formats = ["h:mm a", "h a", "h:mma", "ha", "H:mm", "HH:mm"];
  for (const fmt of formats) {
    const dt = DateTime.fromFormat(text, fmt, { zone });
    if (dt.isValid) {
      return { hour: dt.hour, minute: dt.minute };
    }
  }
  return null;
}

function parseAbsoluteDateTime(raw, { defaultZone = DEFAULT_REMINDME_TZ } = {}) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "Please provide a date and time." };

  const tokens = splitWhitespace(trimmed);
  if (!tokens.length) return { ok: false, error: "Please provide a date and time." };

  let zone = defaultZone;
  const last = tokens[tokens.length - 1];
  const tz = normalizeTimezoneToken(last);
  const explicitZone = Boolean(tz);
  if (tz) {
    zone = tz;
    tokens.pop();
  }

  const { keyword, tokens: remaining } = extractDateKeyword(tokens);
  const dateText = remaining.join(" ").trim();
  if (!dateText) {
    return { ok: false, error: "Please provide a time (e.g. `7:30 PM today`)." };
  }

  const normalized = dateText;
  const formats = [
    "yyyy-MM-dd HH:mm",
    "yyyy-MM-dd H:mm",
    "yyyy-MM-dd h:mm a",
    "MM/dd/yyyy HH:mm",
    "M/d/yyyy HH:mm",
    "MM/dd/yyyy h:mm a",
    "M/d/yyyy h:mm a",
    "LLL d yyyy h:mm a",
    "LLL d yyyy HH:mm",
    "yyyy-MM-dd'T'HH:mm",
    "yyyy-MM-dd'T'H:mm",
  ];

  for (const fmt of formats) {
    const dt = DateTime.fromFormat(normalized, fmt, { zone });
    if (dt.isValid) return { ok: true, dt, zone, explicitZone };
  }

  const iso = DateTime.fromISO(normalized, { zone });
  if (iso.isValid) return { ok: true, dt: iso, zone, explicitZone };

  const parsedTime = parseTimeOnly(normalized, zone);
  if (parsedTime) {
    const now = DateTime.now().setZone(zone);
    let base = now;
    if (keyword === "tomorrow") {
      base = now.plus({ days: 1 });
    }
    const dt = base
      .set({
        hour: parsedTime.hour,
        minute: parsedTime.minute,
        second: 0,
        millisecond: 0,
      })
      .setZone(zone);
    if (!keyword && dt <= now) {
      return { ok: true, dt: dt.plus({ days: 1 }), zone, explicitZone };
    }
    return { ok: true, dt, zone, explicitZone };
  }

  return {
    ok: false,
    error:
      "Please provide a valid date/time. Examples: `2026-01-18 19:30`, `01/18/2026 7:30 PM`, `Jan 18 2026 7:30 PM`, or `7am tomorrow` (optional tz like `UTC` or `-05:00`).",
  };
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
    `SELECT id, user_id, phrase, target_user_id, ignore_user_ids FROM notify_me WHERE guild_id = ?`,
    [String(guildId)]
  );
  state.items = (rows || []).map((row) => ({
    id: Number(row.id),
    userId: String(row.user_id),
    phrase: String(row.phrase || ""),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    ignoredUserIds: parseIgnoredUserIds(row.ignore_user_ids),
    key: phraseKey(row.phrase),
  }));
  state.loaded = true;
  return state;
}

async function addNotifyEntry({ guildId, userId, phrase, targetUserId, ignoredUserIds = [] }) {
  const db = getDb();
  const [result] = await db.execute(
    `INSERT INTO notify_me (guild_id, user_id, phrase, target_user_id, ignore_user_ids) VALUES (?, ?, ?, ?, ?)`,
    [
      String(guildId),
      String(userId),
      String(phrase),
      targetUserId ? String(targetUserId) : null,
      serializeIgnoredUserIds(ignoredUserIds),
    ]
  );
  const id = Number(result?.insertId);
  return Number.isFinite(id) ? id : null;
}

async function updateNotifyEntryIgnoredUsers({ id, userId, ignoredUserIds }) {
  const db = getDb();
  await db.execute(`UPDATE notify_me SET ignore_user_ids = ? WHERE id = ? AND user_id = ?`, [
    serializeIgnoredUserIds(ignoredUserIds),
    Number(id),
    String(userId),
  ]);
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
    `SELECT id, phrase, target_user_id, ignore_user_ids, created_at FROM notify_me WHERE guild_id = ? AND user_id = ? ORDER BY id ASC`,
    [String(guildId), String(userId)]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    phrase: String(row.phrase || ""),
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    ignoredUserIds: parseIgnoredUserIds(row.ignore_user_ids),
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

function formatSetTimestamp(fromMs) {
  if (!Number.isFinite(fromMs)) return "";
  return `<t:${Math.floor(fromMs / 1000)}:f>`;
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
    const setAt = formatSetTimestamp(reminder.createdAtMs);
    const suffix = setAt ? ` (set ${setAt})` : "";
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
  const indexed = (items || []).map((item, idx) => ({
    item,
    index: idx + 1,
  }));
  const filtered = indexed.filter(({ item }) => !q || item.phrase.toLowerCase().includes(q));
  return filtered.slice(0, 25).map(({ item, index }) => {
    const label = item.phrase.length > 84 ? `${item.phrase.slice(0, 81)}…` : item.phrase;
    return {
      name: `${index}. ${label}`,
      value: String(index),
    };
  });
}

function buildReminderChoices(items, focused) {
  const q = String(focused || "").toLowerCase();
  const indexed = (items || []).map((item, idx) => ({
    item,
    index: idx + 1,
  }));
  const filtered = indexed.filter(({ item }) => {
    const label = item.phrase || (item.messageId ? `Message ${item.messageId}` : "");
    return !q || label.toLowerCase().includes(q);
  });
  return filtered.slice(0, 25).map(({ item, index }) => {
    const label = (item.phrase || `Message ${item.messageId}`).slice(0, 84);
    return {
      name: `${index}. ${label}`,
      value: String(index),
    };
  });
}

function renderNotifyList(items) {
  if (!items.length) return "You have no active notifications.";
  const lines = items.map((x, idx) => {
    const suffixParts = [];
    if (x.targetUserId) suffixParts.push(`from ${mention(x.targetUserId)}`);
    if (x.ignoredUserIds?.length) {
      suffixParts.push(`ignore ${x.ignoredUserIds.map((id) => mention(id)).join(", ")}`);
    }
    const suffix = suffixParts.length ? ` (${suffixParts.join("; ")})` : "";
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
      if (item.ignoredUserIds?.includes(authorId)) return false;
      if (isBot && !item.targetUserId) return false;
      return includesWholePhrase(normalized, item.phrase);
    });
    if (!matches.length) return;

    const matchesByUser = new Map();
    for (const item of matches) {
      const list = matchesByUser.get(item.userId) || [];
      list.push(item);
      matchesByUser.set(item.userId, list);
    }

    for (const [userId, items] of matchesByUser.entries()) {
      try {
        const user = await message.client.users.fetch(userId);
        if (!user) continue;
        const link = formatLink({
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
        });
        const phrases = items.map((entry) => String(entry.phrase || "").trim()).filter(Boolean);
        const listBlock =
          phrases.length > 1
            ? `\n${phrases.map((phrase) => `• "${phrase}"`).join("\n")}`
            : "";
        const snippet = buildNotifySnippet(message.content);
        const quote = snippet ? `\n${formatQuoteBlock(snippet)}\n` : "\n";
        const header =
          phrases.length > 1
            ? `🔔 **NotifyMe**: ${phrases.length} phrases mentioned by ${mention(
                message.author?.id
              )} in <#${message.channelId}>.${listBlock}`
            : `🔔 **NotifyMe**: "${phrases[0]}" mentioned by ${mention(
                message.author?.id
              )} in <#${message.channelId}>.`;

        const res = await sendDm({
          user,
          payload:
            `${header}` +
            `${quote}${link}\n\nNotifyMe will continue to notify you of this phrase. To stop receiving notifications for this message, use \`/notifyme unset\` in the server.`,
          feature: "notifyme",
        });
        if (res.ok) {
          void metrics.increment("notifyme.trigger", { status: "ok" }, phrases.length || 1);
        } else if (res.code === 50007) {
          void metrics.increment("notifyme.trigger", { status: "blocked" }, phrases.length || 1);
        } else {
          void metrics.increment("notifyme.trigger", { status: "error" }, phrases.length || 1);
          console.warn("[notifyme] DM failed:", res.error);
        }
      } catch (err) {
        void metrics.increment("notifyme.trigger", { status: "error" }, items.length || 1);
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
            {
              type: 3,
              name: "ignore_users",
              description: "User mentions/IDs to ignore for this phrase (space/comma-separated)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "ignore",
          description: "Add ignored users for an existing watched phrase",
          options: [
            {
              type: 3,
              name: "phrase",
              description: "Existing phrase or phrase number from /notifyme list",
              required: true,
              autocomplete: true,
            },
            {
              type: 3,
              name: "users",
              description: "One or more user mentions/IDs (space/comma-separated)",
              required: true,
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
              description: "Number from /notifyme list (1-based)",
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
        const ignoreUsersRaw = norm(interaction.options?.getString?.("ignore_users"));
        const ignoredUserIds = ignoreUsersRaw ? parseUserIdsFromInput(ignoreUsersRaw) : [];
        if (!phrase) {
          await interaction.reply({
            content: "Please provide a phrase to watch for.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (ignoreUsersRaw && !ignoredUserIds.length) {
          await interaction.reply({
            content:
              "Please provide one or more valid @mentions/IDs in `ignore_users` (space or comma-separated).",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (ignoredUserIds.length > MAX_NOTIFY_IGNORED_USERS) {
          await interaction.reply({
            content: `You can ignore up to ${MAX_NOTIFY_IGNORED_USERS} users per phrase.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (targetUserId && ignoredUserIds.includes(targetUserId)) {
          await interaction.reply({
            content: "The `from_user` cannot also be in `ignore_users`.",
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
          ignoredUserIds,
        });
        if (!id) {
          await interaction.reply({
            content: "❌ Failed to save notification.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        state.items.push({ id, userId, phrase, key, targetUserId, ignoredUserIds });
        void metrics.increment("notifyme.set", { status: "ok" });
        const suffixParts = [];
        if (targetUserId) suffixParts.push(`from ${mention(targetUserId)}`);
        if (ignoredUserIds.length) {
          suffixParts.push(`ignoring ${ignoredUserIds.map((id) => mention(id)).join(", ")}`);
        }
        const suffix = suffixParts.length ? ` (${suffixParts.join("; ")})` : "";
        await interaction.reply({
          content: `✅ I’ll notify you when I see: "${phrase}"${suffix}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "ignore") {
        const phraseInput = norm(interaction.options?.getString?.("phrase"));
        const usersRaw = norm(interaction.options?.getString?.("users"));
        if (!phraseInput) {
          await interaction.reply({
            content: "Please provide an existing phrase from `/notifyme list`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const idsToIgnore = parseUserIdsFromInput(usersRaw);
        if (!idsToIgnore.length) {
          await interaction.reply({
            content: "Please provide one or more valid @mentions/IDs in `users`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (idsToIgnore.length > MAX_NOTIFY_IGNORED_USERS) {
          await interaction.reply({
            content: `You can add up to ${MAX_NOTIFY_IGNORED_USERS} ignored users per update.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        let matchPhrase = phraseInput;
        let matchKey = phraseKey(phraseInput);
        if (/^\d+$/.test(phraseInput)) {
          const index = Number(phraseInput);
          if (!Number.isInteger(index) || index < 1) {
            await interaction.reply({
              content: "Please provide a valid phrase number from `/notifyme list`.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const listed = await listNotifyEntries({
            guildId: interaction.guildId,
            userId,
          });
          const target = listed[index - 1];
          if (!target) {
            await interaction.reply({
              content: "No notification found with that number. Use `/notifyme list` to check.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          matchPhrase = target.phrase;
          matchKey = phraseKey(target.phrase);
        }

        const state = await loadNotifyGuild(interaction.guildId);
        const mine = state.items.filter((item) => item.userId === userId && item.key === matchKey);
        if (!mine.length) {
          await interaction.reply({
            content: `No existing notification found for phrase "${matchPhrase}". Use \`/notifyme list\` first.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        let updatedCount = 0;
        for (const item of mine) {
          const nextIgnored = normalizeUserIds([...(item.ignoredUserIds || []), ...idsToIgnore]);
          if (nextIgnored.length === (item.ignoredUserIds || []).length) continue;
          // eslint-disable-next-line no-await-in-loop
          await updateNotifyEntryIgnoredUsers({
            id: item.id,
            userId,
            ignoredUserIds: nextIgnored,
          });
          item.ignoredUserIds = nextIgnored;
          updatedCount += 1;
        }

        if (!updatedCount) {
          await interaction.reply({
            content: `All provided users are already ignored for "${phrase}".`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const mentions = idsToIgnore.map((id) => mention(id)).join(", ");
        void metrics.increment("notifyme.ignore", { status: "ok" });
        await interaction.reply({
          content: `✅ Updated ignore list for "${matchPhrase}" (${updatedCount} entr${
            updatedCount === 1 ? "y" : "ies"
          }). Added: ${mentions}`,
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
        const index = Number(idRaw);
        if (!Number.isInteger(index) || index < 1) {
          await interaction.reply({
            content: "Please provide a valid notification number from `/notifyme list`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const items = await listNotifyEntries({
          guildId: interaction.guildId,
          userId,
        });
        if (!items.length) {
          await interaction.reply({
            content: "You have no active notifications.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const target = items[index - 1];
        if (!target) {
          await interaction.reply({
            content: "No notification found with that number. Use `/notifyme list` to check.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deleteNotifyEntry({ id: target.id, userId });
        const state = await loadNotifyGuild(interaction.guildId);
        state.items = state.items.filter((item) => !(item.id === target.id && item.userId === userId));

        void metrics.increment("notifyme.unset", { status: "ok" });
        await interaction.reply({
          content: `✅ Notification #${index} removed.`,
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
        if (sub !== "unset" && sub !== "ignore") {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options?.getFocused?.() || "";
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.respond([]);
          return;
        }
        const userId = interaction.user?.id;
        const items = await listNotifyEntries({ guildId, userId });
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
              required: false,
            },
            {
              type: 3,
              name: "at",
              description: "Absolute date/time (e.g. 2026-01-18 7:30 PM ET)",
              required: false,
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
              description: "Number from /remindme list (1-based)",
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
        const atRaw = norm(interaction.options?.getString?.("at"));
        if ((phrase && messageId) || (!phrase && !messageId)) {
          await interaction.reply({
            content: "Please provide exactly one of `phrase` or `message_id`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if ((timeRaw && atRaw) || (!timeRaw && !atRaw)) {
          await interaction.reply({
            content: "Please provide exactly one of `time` or `at`.",
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

        let remindAtMs = null;
        let tzNote = "";
        if (timeRaw) {
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
          remindAtMs = Date.now() + seconds * 1000;
        } else {
          const parsed = parseAbsoluteDateTime(atRaw, { defaultZone: DEFAULT_REMINDME_TZ });
          if (!parsed.ok) {
            await interaction.reply({
              content: parsed.error,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          remindAtMs = parsed.dt.toMillis();
          if (!parsed.explicitZone) {
            tzNote = " (No timezone specified in input, assuming TPPC time (EST).)";
          }
          const deltaMs = remindAtMs - Date.now();
          if (deltaMs <= 0) {
            await interaction.reply({
              content: "Please provide a future date/time.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (deltaMs > MAX_DURATION_SECONDS * 1000) {
            await interaction.reply({
              content: "Reminders cannot exceed 1 year.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
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

        const whenLabel = `<t:${Math.floor(remindAtMs / 1000)}:f>`;
        void metrics.increment("remindme.set", { status: "ok" });
        await interaction.reply({
          content: `✅ Reminder set for ${whenLabel}.${tzNote}`,
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
        const index = Number(idRaw);
        if (!Number.isInteger(index) || index < 1) {
          await interaction.reply({
            content: "Please provide a valid reminder number from `/remindme list`.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const items = await listReminders({ userId });
        if (!items.length) {
          await interaction.reply({
            content: "You have no active reminders.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const target = items[index - 1];
        if (!target) {
          await interaction.reply({
            content: "No reminder found with that number. Use `/remindme list` to check.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deleteReminder({ id: target.id, userId });
        clearReminderTimeout(target.id);

        void metrics.increment("remindme.unset", { status: "ok" });
        await interaction.reply({
          content: `✅ Reminder #${index} removed.`,
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
