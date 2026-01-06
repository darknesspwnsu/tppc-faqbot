// events/events.js
//
// RPG events + special day announcements + subscriptions.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from "discord.js";
import { getDb } from "../db.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { sendDm } from "../shared/dm.js";
import { registerScheduler } from "../shared/scheduler_registry.js";
import { RPG_EVENT_CHANNELS_BY_GUILD } from "../configs/rpg_event_channels.js";
import { RPG_EVENTS, RPG_EVENT_TIMEZONE, computeEventWindow, computeNextStart, startOfDayInZone } from "./rpg_events.js";
import { loadSpecialDays, computeSpecialDayWindow } from "./special_days.js";
import { detectRadioTower, buildRadioTowerMessage } from "../rpg/radio_tower.js";

const EVENT_SUB_LIMIT = 1000;
const EVENT_NOTIFY_DELAY_MS = 1000;
const MAX_TIMEOUT_MS = 2_000_000_000; // setTimeout limit safety

function mention(id) {
  return `<@${id}>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleTimeout(fn, delayMs) {
  const delay = Number.isFinite(delayMs) ? delayMs : 0;
  const safeDelay = delay > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : Math.max(0, delay);
  setTimeout(fn, safeDelay);
}

async function listSubscriptions(userId) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT event_id FROM event_subscriptions WHERE user_id = ? ORDER BY event_id ASC`,
    [String(userId)]
  );
  return (rows || []).map((row) => String(row.event_id));
}

async function addSubscription(userId, eventId) {
  const db = getDb();
  await db.execute(
    `
    INSERT IGNORE INTO event_subscriptions (user_id, event_id)
    VALUES (?, ?)
  `,
    [String(userId), String(eventId)]
  );
}

async function removeSubscription(userId, eventId) {
  const db = getDb();
  await db.execute(
    `DELETE FROM event_subscriptions WHERE user_id = ? AND event_id = ?`,
    [String(userId), String(eventId)]
  );
}

async function clearSubscriptions(userId) {
  const db = getDb();
  await db.execute(`DELETE FROM event_subscriptions WHERE user_id = ?`, [String(userId)]);
}

async function listSubscribers(eventId) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT user_id FROM event_subscriptions WHERE event_id = ?`,
    [String(eventId)]
  );
  return (rows || []).map((row) => String(row.user_id));
}

async function recordOccurrence({ eventId, startMs, endMs, source }) {
  const db = getDb();
  await db.execute(
    `
    INSERT IGNORE INTO event_occurrences (event_id, start_ms, end_ms, source)
    VALUES (?, ?, ?, ?)
  `,
    [String(eventId), Number(startMs), Number(endMs), String(source || "scheduled")]
  );
}

async function getLatestOccurrence(eventId) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT start_ms, end_ms FROM event_occurrences WHERE event_id = ? ORDER BY start_ms DESC LIMIT 1`,
    [String(eventId)]
  );
  if (!rows?.length) return null;
  const row = rows[0];
  return {
    start: new Date(Number(row.start_ms)),
    end: new Date(Number(row.end_ms)),
  };
}

async function hasOccurrence(eventId, startMs) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT 1 FROM event_occurrences WHERE event_id = ? AND start_ms = ? LIMIT 1`,
    [String(eventId), Number(startMs)]
  );
  return !!rows?.length;
}

async function wasNotified({ eventId, startMs, targetType, targetId, channelId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT 1 FROM event_notifications
    WHERE event_id = ?
      AND start_ms = ?
      AND target_type = ?
      AND target_id = ?
      AND (channel_id <=> ?)
    LIMIT 1
  `,
    [String(eventId), Number(startMs), String(targetType), String(targetId), channelId ? String(channelId) : null]
  );
  return !!rows?.length;
}

async function recordNotification({ eventId, startMs, targetType, targetId, guildId, channelId }) {
  const db = getDb();
  await db.execute(
    `
    INSERT IGNORE INTO event_notifications
      (event_id, start_ms, target_type, target_id, guild_id, channel_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    [
      String(eventId),
      Number(startMs),
      String(targetType),
      String(targetId),
      guildId ? String(guildId) : null,
      channelId ? String(channelId) : null,
    ]
  );
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  if (total <= 0) return "0s";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function buildEventMessage(event, start, end) {
  const duration = end && start ? `Duration: **${formatDuration(end - start)}**.` : "";
  return `📣 **${event.name}** has begun.\n${event.description || ""}\n${duration}`.trim();
}

function describeEventId(id) {
  const entry = RPG_EVENTS.find((event) => event.id === id);
  if (!entry) return `• \`${id}\``;
  const desc = entry.description || entry.name;
  return `• \`${id}\` — ${desc}`;
}

function getAnnouncementChannels(client) {
  const entries = Object.entries(RPG_EVENT_CHANNELS_BY_GUILD || {});
  const output = [];
  for (const [guildId, channelIds] of entries) {
    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) continue;
    const list = Array.isArray(channelIds) ? channelIds : [];
    if (!list.length) continue;
    for (const channelId of list) {
      output.push({ guildId: String(guildId), channelId: String(channelId) });
    }
  }
  return output;
}

async function notifySubscribers({ client, event, start, end }) {
  const subscribers = await listSubscribers(event.id);
  for (const userId of subscribers) {
    try {
      const already = await wasNotified({
        eventId: event.id,
        startMs: start.getTime(),
        targetType: "user",
        targetId: userId,
      });
      if (already) continue;

      const user = await client.users.fetch(userId);
      if (!user) continue;
      const res = await sendDm({
        user,
        payload: buildEventMessage(event, start, end),
        feature: "events",
      });
      await recordNotification({
        eventId: event.id,
        startMs: start.getTime(),
        targetType: "user",
        targetId: userId,
      });
      if (!res.ok && res.code !== 50007) {
        logger.warn("events.dm.failed", { eventId: event.id, userId, error: res.error });
      }
      await sleep(EVENT_NOTIFY_DELAY_MS);
    } catch (err) {
      logger.warn("events.dm.failed", { eventId: event.id, userId, error: logger.serializeError(err) });
    }
  }
}

async function notifyChannels({ client, event, start, end }) {
  const channels = getAnnouncementChannels(client);
  if (!channels.length) return;
  const content = buildEventMessage(event, start, end);

  for (const { guildId, channelId } of channels) {
    try {
      const already = await wasNotified({
        eventId: event.id,
        startMs: start.getTime(),
        targetType: "channel",
        targetId: channelId,
        channelId,
      });
      if (already) continue;
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== "function") continue;
      await channel.send(content);
      await recordNotification({
        eventId: event.id,
        startMs: start.getTime(),
        targetType: "channel",
        targetId: channelId,
        guildId,
        channelId,
      });
    } catch (err) {
      logger.warn("events.channel.failed", {
        eventId: event.id,
        guildId,
        channelId,
        error: logger.serializeError(err),
      });
    }
  }
}

async function announceEvent({ client, event, start, end, source }) {
  await recordOccurrence({ eventId: event.id, startMs: start.getTime(), endMs: end.getTime(), source });
  await notifySubscribers({ client, event, start, end });
  await notifyChannels({ client, event, start, end });
}

async function checkScheduledEvents(client, reason = "scheduled") {
  const now = new Date();
  for (const event of RPG_EVENTS) {
    if (event.kind === "radio_tower") continue;
    const window = computeEventWindow(event, now);
    if (!window) continue;
    const { start, end } = window;
    if (now.getTime() < start.getTime() || now.getTime() >= end.getTime()) continue;
    const exists = await hasOccurrence(event.id, start.getTime());
    if (exists) continue;
    await announceEvent({ client, event, start, end, source: reason });
  }
  void metrics.incrementSchedulerRun("rpg_events", "ok");
}

async function checkRadioTowerEvent(client, reason = "scheduled") {
  try {
    const hit = await detectRadioTower();
    if (!hit) {
      void metrics.incrementSchedulerRun("radio_tower_event", "ok");
      return;
    }
    const now = new Date();
    const start = startOfDayInZone(now, RPG_EVENT_TIMEZONE);
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const event = {
      id: "team_rocket",
      name: "Team Rocket Takeover",
      description: buildRadioTowerMessage(),
    };
    const exists = await hasOccurrence(event.id, start.getTime());
    if (!exists) {
      await announceEvent({ client, event, start, end, source: reason });
    }
    void metrics.incrementSchedulerRun("radio_tower_event", "ok");
  } catch (err) {
    void metrics.incrementSchedulerRun("radio_tower_event", "error");
    logger.warn("radio_tower_event.failed", { error: logger.serializeError(err) });
  }
}

async function checkSpecialDays(client, reason = "scheduled") {
  const now = new Date();
  const { defaults, days } = await loadSpecialDays();
  for (const day of days) {
    const window = computeSpecialDayWindow(day, defaults, now);
    if (!window) continue;
    const { start, end } = window;
    if (now.getTime() < start.getTime() || now.getTime() >= end.getTime()) continue;
    const eventId = `special_${day.id}`;
    const exists = await hasOccurrence(eventId, start.getTime());
    if (exists) continue;
    const event = {
      id: eventId,
      name: day.name,
      description: day.message,
    };
    await announceEvent({ client, event, start, end, source: reason });
  }
  void metrics.incrementSchedulerRun("special_days", "ok");
}

function computeNextEventTick(now = new Date()) {
  const starts = [];
  for (const event of RPG_EVENTS) {
    if (event.kind === "radio_tower") continue;
    const next = computeNextStart(event, now);
    if (next) starts.push(next.getTime());
  }
  if (!starts.length) return new Date(now.getTime() + 24 * 60 * 60_000);
  const min = Math.min(...starts);
  return new Date(min);
}

function nextMidnightEt(now = new Date()) {
  const start = startOfDayInZone(now, RPG_EVENT_TIMEZONE);
  if (start.getTime() > now.getTime()) return start;
  return new Date(start.getTime() + 24 * 60 * 60_000);
}

async function computeNextSpecialDayTick(now = new Date()) {
  const { defaults, days } = await loadSpecialDays();
  const starts = [];
  for (const day of days) {
    const window = computeSpecialDayWindow(day, defaults, now);
    if (!window) continue;
    if (window.start.getTime() > now.getTime()) {
      starts.push(window.start.getTime());
    } else {
      // Next year occurrence.
      const future = new Date(now.getTime() + 370 * 24 * 60 * 60_000);
      const nextWindow = computeSpecialDayWindow(day, defaults, future);
      if (nextWindow) starts.push(nextWindow.start.getTime());
    }
  }
  if (!starts.length) return new Date(now.getTime() + 24 * 60 * 60_000);
  return new Date(Math.min(...starts));
}

function scheduleEventLoop(client) {
  const now = new Date();
  const next = computeNextEventTick(now);
  let delay = next.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 0) delay = 60_000;

  scheduleTimeout(async function tick() {
    await checkScheduledEvents(client, "scheduled");
    const n = computeNextEventTick(new Date());
    let nextDelay = n.getTime() - Date.now();
    if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 60_000;
    scheduleTimeout(tick, nextDelay);
  }, delay);
}

export function registerEventSchedulers({ client } = {}) {
  registerScheduler("rpg_events", () => {
    void checkScheduledEvents(client, "startup");
    scheduleEventLoop(client);
  });

  registerScheduler("radio_tower_event", () => {
    void checkRadioTowerEvent(client, "startup");
    const now = new Date();
    const next = nextMidnightEt(now);
    let delay = next.getTime() - now.getTime();
    if (!Number.isFinite(delay) || delay < 0) delay = 60_000;
    scheduleTimeout(function tick() {
      void checkRadioTowerEvent(client, "scheduled");
      const nextRun = nextMidnightEt(new Date());
      let nextDelay = nextRun.getTime() - Date.now();
      if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 60_000;
      scheduleTimeout(tick, nextDelay);
    }, delay);
  });

  registerScheduler("special_days", () => {
    void checkSpecialDays(client, "startup");
    const now = new Date();
    void (async () => {
      const next = await computeNextSpecialDayTick(now);
      let delay = next.getTime() - now.getTime();
      if (!Number.isFinite(delay) || delay < 0) delay = 60_000;
      scheduleTimeout(async function tick() {
        void checkSpecialDays(client, "scheduled");
        const nextRun = await computeNextSpecialDayTick(new Date());
        let nextDelay = nextRun.getTime() - Date.now();
        if (!Number.isFinite(nextDelay) || nextDelay < 0) nextDelay = 60_000;
        scheduleTimeout(tick, nextDelay);
      }, delay);
    })();
  });
}

function buildEventsEmbed({ active, upcoming }) {
  const embed = new EmbedBuilder().setTitle("TPPC Events");

  const activeLines = active.length
    ? active.map((e) => `• **${e.name}** — ends <t:${Math.floor(e.end.getTime() / 1000)}:R> \`(${e.id})\``)
    : ["(none)"];
  const upcomingLines = upcoming.length
    ? upcoming.map((e) => `• **${e.name}** — starts <t:${Math.floor(e.start.getTime() / 1000)}:R> \`(${e.id})\``)
    : ["(none)"];

  embed.addFields(
    { name: "Active", value: activeLines.join("\n"), inline: false },
    { name: "Upcoming", value: upcomingLines.join("\n"), inline: false }
  );
  return embed;
}

async function listAllEventIds() {
  return RPG_EVENTS.map((e) => e.id);
}

async function resolveEventsForList(now = new Date(), { includeAll = false } = {}) {
  const active = [];
  const upcoming = [];
  const limit = new Date(now.getTime());
  limit.setMonth(limit.getMonth() + 2);

  for (const event of RPG_EVENTS) {
    if (event.kind === "radio_tower") continue;
    const window = computeEventWindow(event, now);
    if (!window) continue;
    if (now >= window.start && now < window.end) {
      active.push({ ...event, start: window.start, end: window.end });
    } else {
      const next = computeNextStart(event, now);
      if (next && (includeAll || next.getTime() <= limit.getTime())) {
        upcoming.push({ ...event, start: next });
      }
    }
  }

  const rocket = await getLatestOccurrence("team_rocket");
  if (rocket && now >= rocket.start && now < rocket.end) {
    active.push({ id: "team_rocket", name: "Team Rocket Takeover", start: rocket.start, end: rocket.end });
  } else if (includeAll) {
    upcoming.push({
      id: "team_rocket",
      name: "Team Rocket Takeover (random)",
      start: now,
    });
  }

  upcoming.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { active, upcoming };
}

function parseEventIds(raw) {
  const tokens = String(raw || "")
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

export function registerEvents(register) {
  register(
    "!events",
    async ({ message }) => {
      const tokens = String(message.content || "").trim().split(/\s+/).slice(1);
      const includeAll = tokens.some((t) => t.toLowerCase() === "all");
      const { active, upcoming } = await resolveEventsForList(new Date(), { includeAll });
      const embed = buildEventsEmbed({ active, upcoming });
      await message.reply({ embeds: [embed] });
    },
    "!events — show active and upcoming TPPC events"
  );

  register.slash(
    {
      name: "events",
      description: "Show active and upcoming TPPC events",
      options: [
        {
          type: 5,
          name: "all",
          description: "Include all upcoming events",
          required: false,
        },
      ],
    },
    async ({ interaction }) => {
      const includeAll = interaction.options?.getBoolean?.("all") || false;
      const { active, upcoming } = await resolveEventsForList(new Date(), { includeAll });
      const embed = buildEventsEmbed({ active, upcoming });
      await interaction.reply({ embeds: [embed] });
    }
  );

  register.slash(
    {
      name: "subscriptions",
      description: "Manage RPG event subscriptions",
      options: [
        {
          type: 1,
          name: "subscribe",
          description: "Subscribe to one or more event IDs",
          options: [
            {
              type: 3,
              name: "event_ids",
              description: "Comma-separated event IDs or 'all'",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "unsubscribe",
          description: "Unsubscribe from one or more event IDs",
          options: [
            {
              type: 3,
              name: "event_ids",
              description: "Comma-separated event IDs",
              required: true,
            },
          ],
        },
        {
          type: 1,
          name: "unsub_all",
          description: "Unsubscribe from all events",
        },
        {
          type: 1,
          name: "list",
          description: "List your subscriptions",
        },
      ],
    },
    async ({ interaction }) => {
      const sub = interaction.options?.getSubcommand?.() || "";
      const userId = interaction.user?.id;
      if (!userId) return;

      if (sub === "list") {
        const ids = await listSubscriptions(userId);
        const content = ids.length
          ? `You are subscribed to:\n${ids.map((id) => describeEventId(id)).join("\n")}`
          : "You have no event subscriptions.";
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "unsub_all") {
        await clearSubscriptions(userId);
        await interaction.reply({ content: "✅ Unsubscribed from all events.", flags: MessageFlags.Ephemeral });
        return;
      }

      const raw = interaction.options?.getString?.("event_ids") || "";
      const ids = parseEventIds(raw);
      if (!ids.length) {
        await interaction.reply({ content: "Please provide one or more event IDs.", flags: MessageFlags.Ephemeral });
        return;
      }

      const all = await listAllEventIds();
      const targetIds = ids.includes("all") ? all : ids;
      const unknown = targetIds.filter((id) => !all.includes(id));
      if (unknown.length) {
        await interaction.reply({
          content: `Unknown event IDs: ${unknown.map((id) => `\`${id}\``).join(", ")}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (targetIds.length > EVENT_SUB_LIMIT) {
        await interaction.reply({ content: "Too many event IDs provided.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "subscribe") {
        for (const id of targetIds) {
          await addSubscription(userId, id);
        }
        await interaction.reply({
          content: `✅ Subscribed to ${targetIds.length} event(s).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "unsubscribe") {
        for (const id of targetIds) {
          await removeSubscription(userId, id);
        }
        await interaction.reply({
          content: `✅ Unsubscribed from ${targetIds.length} event(s).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
    }
  );
}

export const __testables = {
  parseEventIds,
  formatDuration,
  buildEventMessage,
  resolveEventsForList,
};
