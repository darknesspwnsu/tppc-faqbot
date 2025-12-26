/**
 * contests.js
 *
 * Contest commands:
 *   !conteststart <time>
 *   !getlist
 *   !cancelcontest
 *   !closecontest
 *
 * Rules:
 * - Only one contest at a time PER GUILD
 * - Users enter by reacting to the contest message with ANY emoji
 * - Bot auto-reacts with 👍 to make it easy for users to click
 * - We track entrants live via reaction add/remove events
 * - After time, ping the contest creator with the UNIQUE list of people who reacted
 */

import { PermissionsBitField } from "discord.js";

// guildId -> {
//   client, guildId, channelId, messageId, creatorId, endsAtMs, timeout,
//   entrants:Set<string>,
//   entrantReactionCounts: Map<string, number>,
//   maxEntrants?: number
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

function canManageContest(message, state) {
  if (!state) return false;
  if (isAdmin(message)) return true;
  return message.author?.id && message.author.id === state.creatorId;
}

function parseDurationToMs(raw) {
  const s = (raw ?? "").trim().toLowerCase();
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
  return n * 3_600_000;
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

function humanDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
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
    try {
      if (!user || user.bot) return;

      await safeFetchReaction(reaction);
      const msg = reaction?.message;
      if (!msg) return;

      await safeFetchMessage(msg);

      const state = activeByGuild.get(msg.guildId);
      if (!state || msg.id !== state.messageId) return;

      const counts = state.entrantReactionCounts;
      const prev = counts.get(user.id) ?? 0;
      counts.set(user.id, prev + 1);
      state.entrants.add(user.id);

      // If we hit max unique entrants, end early
      if (state.maxEntrants && state.entrants.size >= state.maxEntrants) {
        try { clearTimeout(state.timeout); } catch {}
        await finalizeContest(msg.guildId, "max");
      }
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

      const state = activeByGuild.get(msg.guildId);
      if (!state || msg.id !== state.messageId) return;

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
    } catch {}
  }
  return names;
}

async function finalizeContest(guildId, reason = "timer") {
  const state = activeByGuild.get(guildId);
  if (!state) return;

  activeByGuild.delete(guildId);

  const { client, channelId, creatorId, endsAtMs } = state;

  const userIds = [...state.entrants];
  const nameList = await buildNameList(client, userIds);
  const total = nameList.length;

  const elapsedNote =
    reason === "max"
      ? "Closed early (max entrants reached)."
      : reason === "close"
      ? "Closed early."
      : reason === "cancel"
      ? "Cancelled."
      : `Finished (ended at <t:${Math.floor(endsAtMs / 1000)}:t>).`;

  const body = total === 0 ? "No one reacted to enter." : nameList.join(" ");

  const channel = await client.channels.fetch(channelId);
  if (channel?.isTextBased()) {
    await channel.send(
      `<@${creatorId}> Contest entrants (${total}) — ${elapsedNote}\n\n${body}`
    );
  }
}

export function registerContests(register) {
  register(
    "!conteststart",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      if (activeByGuild.has(message.guildId)) {
        await message.reply(
          "A contest is already running. Use `!getlist`, `!closecontest`, or `!cancelcontest`."
        );
        return;
      }

      installReactionHooks(message.client);

      const raw = rest.trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const timeRaw = parts[0] || "";
      const maxRaw = parts[1]; // optional

      const ms = parseDurationToMs(timeRaw);
      if (!ms) {
        await message.reply("Invalid time. Examples: `30sec`, `5min`, `1hour`.");
        return;
      }

      let maxEntrants = null;
      if (maxRaw != null) {
        const n = Number(maxRaw);
        if (!Number.isInteger(n) || n <= 0 || n > 1000) {
          await message.reply("Invalid max entrants. Usage: `!contest <time> [max]` (example: `!contest 2s 10`)");
          return;
        }
        maxEntrants = n;
      }

      const MAX_MS = 24 * 60 * 60_000;
      if (ms > MAX_MS) {
        await message.reply("Time too large. Max is 24 hours.");
        return;
      }

      const endsAtMs = Date.now() + ms;

      activeByGuild.set(message.guildId, {
        client: message.client,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: null,
        creatorId: message.author.id,
        endsAtMs,
        timeout: null,
        entrants: new Set(),
        entrantReactionCounts: new Map(),
        maxEntrants,
      });

      const maxNote = maxEntrants ? ` (max **${maxEntrants}** entrants — ends early if reached)` : "";
      const contestMsg = await message.channel.send(
        `React to this message to enter a contest! The list will be generated in **${humanDuration(ms)}**...${maxNote}`
      );

      try {
        await contestMsg.react("👍");
      } catch {}

      const timeout = setTimeout(
        () => finalizeContest(message.guildId, "timer"),
        ms
      );

      const state = activeByGuild.get(message.guildId);
      if (state) {
        state.messageId = contestMsg.id;
        state.timeout = timeout;
      }
    },
    "!conteststart <time> [quota] — starts a reaction contest",
    { aliases: ["!contest"] }
  );

  register("!getlist", async ({ message }) => {
    const state = activeByGuild.get(message.guildId);
    if (!state) {
      await message.reply("No active contest right now.");
      return;
    }

    if (!canManageContest(message, state)) {
      await message.reply("Nope — only admins or the contest starter can use that.");
      return;
    }

    const nameList = await buildNameList(
      message.client,
      [...state.entrants]
    );

    await message.reply(
      `Current entrants (${nameList.length}).\n\n${
        nameList.length ? nameList.join(" ") : "(none yet)"
      }`
    );
  });

  register("!cancelcontest", async ({ message }) => {
    const state = activeByGuild.get(message.guildId);
    if (!state) {
      await message.reply("No active contest to cancel.");
      return;
    }

    if (!canManageContest(message, state)) {
      await message.reply("Nope — only admins or the contest starter can use that.");
      return;
    }

    clearTimeout(state.timeout);
    activeByGuild.delete(message.guildId);
    await message.channel.send("Contest cancelled.");
  });

  register("!closecontest", async ({ message }) => {
    const state = activeByGuild.get(message.guildId);
    if (!state) {
      await message.reply("No active contest to close.");
      return;
    }

    if (!canManageContest(message, state)) {
      await message.reply("Nope — only admins or the contest starter can use that.");
      return;
    }

    clearTimeout(state.timeout);
    await finalizeContest(message.guildId, "close");
  });
}
