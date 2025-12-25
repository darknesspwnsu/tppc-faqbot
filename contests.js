/**
 * contests.js
 *
 * Admin-only contest commands:
 *   !conteststart <time>
 *   !getlist
 *   !cancelcontest
 *   !closecontest
 *
 * Rules:
 * - Admin = Manage Server (ManageGuild permission)
 * - Only one contest at a time PER GUILD
 * - Users enter by reacting to the contest message with ANY emoji
 * - Bot auto-reacts with 👍 to make it easy for users to click
 * - We track entrants live via reaction add/remove events (more reliable than fetching at the end)
 * - After time, ping the contest creator with the UNIQUE list of people who reacted
 */

import { PermissionsBitField } from "discord.js";

// guildId -> {
//   client, guildId, channelId, messageId, creatorId, endsAtMs, timeout,
//   entrants:Set<string>,
//   entrantReactionCounts: Map<string, number>
// }
const activeByGuild = new Map();

let reactionHooksInstalled = false;

function isAdmin(message) {
  if (!message.member) return false;
  return (
    message.member.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    message.member.permissions?.has(PermissionsBitField.Flags.Administrator)
  );
}

function parseDurationToMs(raw) {
  const s = (raw ?? "").trim().toLowerCase();
  // tolerate: 30sec / 30 secs / 30s / 5min / 1hour / 1hr / 2h etc.
  const m =
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(
      s
    );
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = m[2];
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("m")) return n * 60_000;
  return n * 3_600_000; // hours
}

function fmtTime(raw) {
  return (raw ?? "").trim();
}

function camelizeIfNeeded(name) {
  if (!name) return "";
  if (!name.includes(" ")) return name;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

async function safeFetchReaction(reaction) {
  try {
    if (reaction?.partial && typeof reaction.fetch === "function") {
      await reaction.fetch();
    }
  } catch {}
}

async function safeFetchMessage(msg) {
  try {
    if (msg?.partial && typeof msg.fetch === "function") {
      await msg.fetch();
    }
  } catch {}
}

function installReactionHooks(client) {
  if (reactionHooksInstalled) return;
  reactionHooksInstalled = true;

  client.on("messageReactionAdd", async (reaction, user) => {
    console.log("[contest] reaction add:", user?.tag, "on", reaction?.message?.id);
    try {
      if (!user || user.bot) return;

      await safeFetchReaction(reaction);

      const msg = reaction?.message;
      if (!msg) return;

      await safeFetchMessage(msg);

      const guildId = msg.guildId;
      if (!guildId) return;

      const state = activeByGuild.get(guildId);
      if (!state) return;

      if (msg.id !== state.messageId) return;

      // Treat any reaction as entry.
      // Track count so removing one emoji doesn't remove the entrant if they still react with others.
      const counts = state.entrantReactionCounts;
      const prev = counts.get(user.id) ?? 0;
      counts.set(user.id, prev + 1);
      state.entrants.add(user.id);
    } catch (e) {
      console.warn("messageReactionAdd handler failed:", e);
    }
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    try {
      if (!user || user.bot) return;

      await safeFetchReaction(reaction);

      const msg = reaction?.message;
      if (!msg) return;

      await safeFetchMessage(msg);

      const guildId = msg.guildId;
      if (!guildId) return;

      const state = activeByGuild.get(guildId);
      if (!state) return;

      if (msg.id !== state.messageId) return;

      // Decrement per-user reaction count; only remove entrant if count hits 0.
      const counts = state.entrantReactionCounts;
      const prev = counts.get(user.id) ?? 0;
      const next = prev - 1;

      if (next <= 0) {
        counts.delete(user.id);
        state.entrants.delete(user.id);
      } else {
        counts.set(user.id, next);
      }
    } catch (e) {
      console.warn("messageReactionRemove handler failed:", e);
    }
  });
}

async function buildNameList(client, userIds) {
  const names = [];

  for (const id of userIds) {
    try {
      const u = await client.users.fetch(id);
      const name = camelizeIfNeeded(u?.username || "");
      if (name) names.push(name);
    } catch {
      // ignore fetch failures
    }
  }

  return names;
}

async function finalizeContest(guildId, reason = "timer") {
  const state = activeByGuild.get(guildId);
  if (!state) return;

  activeByGuild.delete(guildId);

  const { client, channelId, creatorId, endsAtMs } = state;

  try {
    const userIds = [...(state.entrants || new Set())];

    const nameList = await buildNameList(client, userIds);
    const total = nameList.length;

    const elapsedNote =
      reason === "close"
        ? "Closed early."
        : reason === "cancel"
        ? "Cancelled."
        : `Finished (ended at <t:${Math.floor(endsAtMs / 1000)}:t>).`;

    const body = total === 0 ? "No one reacted to enter." : nameList.join(" ");

    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      // Only ping the contest starter; do NOT ping entrants
      await channel.send(
        `<@${creatorId}> Contest entrants (${total}) — ${elapsedNote}\n\n${body}`
      );
    }
  } catch (e) {
    console.error("finalizeContest failed:", e);
    try {
      const channel = await state.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send(
          `<@${creatorId}> Contest finished, but I failed to build the entrant list (check logs).`
        );
      }
    } catch {}
  }
}

export function registerContests(register) {
  // !conteststart <time>
  register(
    "!conteststart",
    async ({ message, rest }) => {
      if (!isAdmin(message)) {
        await message.reply("Nope — admin only. (Manage Server / Administrator)");
        return;
      }

      if (!message.guildId) return;

      const existing = activeByGuild.get(message.guildId);
      if (existing) {
        await message.reply(
          "A contest is already running. Use `!getlist`, `!closecontest`, or `!cancelcontest`."
        );
        return;
      }

      // Install hooks once, on first contest use
      installReactionHooks(message.client);

      const timeRaw = rest.trim();
      const ms = parseDurationToMs(timeRaw);
      if (!ms) {
        await message.reply(
          "Invalid time. Examples: `30sec`, `5min`, `1hour` (also: s/sec/secs, m/min/mins, h/hr/hour/hours)."
        );
        return;
      }

      // Safety cap to prevent accidental huge timers
      const MAX_MS = 24 * 60 * 60_000; // 24 hours
      if (ms > MAX_MS) {
        await message.reply("Time too large. Max contest duration is 24 hours.");
        return;
      }

      const endsAtMs = Date.now() + ms;

      // ✅ Reserve the contest slot immediately to prevent double-start races
      activeByGuild.set(message.guildId, {
        client: message.client,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: null, // filled after we send
        creatorId: message.author.id,
        endsAtMs,
        timeout: null, // filled after we schedule
        entrants: new Set(),
        entrantReactionCounts: new Map()
      });

      let contestMsg;
      try {
        contestMsg = await message.channel.send(
          `React to this message to enter a contest! The list will be generated in **${fmtTime(
            timeRaw
          )}**...`
        );
      } catch (e) {
        // If we couldn't post, undo the reservation so another attempt can work
        activeByGuild.delete(message.guildId);
        throw e;
      }

      // Auto-react 👍 so users can just click it
      try {
        await contestMsg.react("👍");
      } catch (e) {
        console.warn("Failed to add 👍 reaction:", e);
      }

      const timeout = setTimeout(() => {
        finalizeContest(message.guildId, "timer");
      }, ms);

      // ✅ Fill in remaining state
      const state = activeByGuild.get(message.guildId);
      if (state) {
        state.messageId = contestMsg.id;
        state.timeout = timeout;
        // keep channelId as the channel where it was started (already set)
      }
    },
    "!conteststart <time> — starts a reaction contest (admin only)",
    { admin: true, aliases: ["!contest"] }
  );

  // !getlist
  register(
    "!getlist",
    async ({ message }) => {
      if (!isAdmin(message)) {
        await message.reply("Nope — admin only. (Manage Server / Administrator)");
        return;
      }
      if (!message.guildId) return;

      const state = activeByGuild.get(message.guildId);
      if (!state) {
        await message.reply("No active contest right now.");
        return;
      }

      const userIds = [...(state.entrants || new Set())];
      const nameList = await buildNameList(message.client, userIds);
      const total = nameList.length;

      const body = total === 0 ? "(none yet)" : nameList.join(" ");
      await message.reply(`Current entrants (${total}).\n\n${body}`);
    },
    "!getlist — shows the current contest entrant list (admin only)",
    { admin: true }
  );

  // !cancelcontest
  register(
    "!cancelcontest",
    async ({ message }) => {
      if (!isAdmin(message)) {
        await message.reply("Nope — admin only. (Manage Server / Administrator)");
        return;
      }
      if (!message.guildId) return;

      const state = activeByGuild.get(message.guildId);
      if (!state) {
        await message.reply("No active contest to cancel.");
        return;
      }

      clearTimeout(state.timeout);
      activeByGuild.delete(message.guildId);

      await message.channel.send("Contest cancelled.");
    },
    "!cancelcontest — cancels the active contest (admin only)",
    { admin: true }
  );

  // !closecontest
  register(
    "!closecontest",
    async ({ message }) => {
      if (!isAdmin(message)) {
        await message.reply("Nope — admin only. (Manage Server / Administrator)");
        return;
      }
      if (!message.guildId) return;

      const state = activeByGuild.get(message.guildId);
      if (!state) {
        await message.reply("No active contest to close.");
        return;
      }

      clearTimeout(state.timeout);
      await finalizeContest(message.guildId, "close");
    },
    "!closecontest — closes the contest immediately and posts the list (admin only)",
    { admin: true }
  );
}
