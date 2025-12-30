// contests/reaction_contests.js
//
// Reaction-based contest helper:
// - Command: !conteststart [mode] <time> [quota]
// - Modes: list | choose | elim
// - Guild + channel scoped to the start message
import { isAdminOrPrivileged } from "../auth.js";
import { stripEmojisAndSymbols } from "./helpers.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { chooseOne, runElimFromItems } from "./rng.js";

// messageId -> { guildId, channelId, endsAtMs, timeout, entrants:Set<string>, entrantReactionCounts:Map<string,number>, maxEntrants?, onDone? }
const activeCollectorsByMessage = new Map();

let reactionHooksInstalled = false;

function parseDurationToMs(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Preserve prior behavior: require explicit unit (e.g. 30sec, 5min).
  if (/^\d+$/.test(s)) return null;

  const sec = parseDurationSeconds(s, null);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
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
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;

  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
}

async function buildNameList(_client, guild, userIds) {
  const names = [];

  let bulk = null;
  try {
    if (guild?.members?.fetch && Array.isArray(userIds) && userIds.length) {
      bulk = await guild.members.fetch({ user: userIds });
    }
  } catch {}

  for (const id of userIds) {
    let member = bulk?.get?.(id) || guild?.members?.cache?.get?.(id) || null;
    if (!member && guild?.members?.fetch) {
      try {
        member = await guild.members.fetch(id).catch(() => null);
      } catch {}
    }

    let rawName =
      member?.displayName ||
      member?.user?.username ||
      "";

    rawName = stripEmojisAndSymbols(rawName);
    const name = camelizeIfNeeded(rawName);

    if (name) names.push(name);
  }

  return names;
}

async function finalizeCollector(messageId, reason = "timer") {
  const state = activeCollectorsByMessage.get(messageId);
  if (!state) return;

  activeCollectorsByMessage.delete(messageId);

  // Edit the original entry message like the old behavior
  try {
    const channel = await state.client.channels.fetch(state.channelId);
    if (channel?.isTextBased?.()) {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit("Entries have closed for this contest.");
    }
  } catch (e) {
    console.warn("Failed to edit contest message:", e);
  }

  const userIds = [...state.entrants];
  if (typeof state.onDone === "function") {
    try { state.onDone(new Set(userIds), reason); } catch {}
  }
}

// stripEmojisAndSymbols is shared in contests/helpers.js

function contestStartHelpText() {
  return [
    "**Contest Start — Help**",
    "",
    "**Start:**",
    "• `!conteststart <time> [quota]`",
    "• `!conteststart <mode> <time> [quota]`",
    "",
    "**Modes:**",
    "• `list` (default) — prints a space-separated list of entrants",
    "• `choose` — picks 1 winner",
    "• `elim` — runs elimination until 1 remains (2s between rounds)",
    "",
    "**Time:**",
    "• `30sec`, `5min`, `1hour`",
    "",
    "**Quota (optional):**",
    "• Ends early once N entrants have reacted",
    "",
    "**Examples:**",
    "• `!conteststart 2min`",
    "• `!conteststart list 1min 20`",
    "• `!conteststart choose 30sec`",
    "• `!conteststart elim 2min 10`",
    ""
  ].join("\n");
}

export function installReactionHooks(client) {
  if (reactionHooksInstalled) return;
  reactionHooksInstalled = true;

  async function resolveReaction(reaction) {
    if (!reaction) return null;
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch {
        return null;
      }
    }
    const msg = reaction.message;
    if (msg?.partial) {
      try {
        await msg.fetch();
      } catch {
        return null;
      }
    }
    return reaction;
  }

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    const full = await resolveReaction(reaction);
    if (!full) return;

    const msg = full.message;
    if (!msg?.guildId) return;

    const collector = activeCollectorsByMessage.get(msg.id);
    if (!collector) return;

    const counts = collector.entrantReactionCounts;
    const prev = counts.get(user.id) ?? 0;
    counts.set(user.id, prev + 1);
    collector.entrants.add(user.id);

    if (collector.maxEntrants && collector.entrants.size >= collector.maxEntrants) {
      try { clearTimeout(collector.timeout); } catch {}
      await finalizeCollector(msg.id, "max");
    }
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;

    const full = await resolveReaction(reaction);
    if (!full) return;

    const msg = full.message;
    if (!msg?.guildId) return;

    const collector = activeCollectorsByMessage.get(msg.id);
    if (!collector) return;

    const counts = collector.entrantReactionCounts;
    const prev = counts.get(user.id) ?? 0;
    const next = prev - 1;

    if (next <= 0) {
      counts.delete(user.id);
      collector.entrants.delete(user.id);
    } else {
      counts.set(user.id, next);
    }
  });
}

// Reusable: collect unique users who react to a message for a short window.
export async function collectEntrantsByReactions({
  message,
  promptText,
  durationMs,
  maxEntrants = null,
  emoji = "👍",
}) {
  installReactionHooks(message.client);

  const joinMsg = await message.channel.send(promptText);
  try { await joinMsg.react(emoji); } catch {}

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => finalizeCollector(joinMsg.id, "timer"), durationMs);

    activeCollectorsByMessage.set(joinMsg.id, {
      client: message.client,
      guildId: message.guildId,
      channelId: message.channelId,
      endsAtMs: Date.now() + durationMs,
      timeout,
      entrants: new Set(),
      entrantReactionCounts: new Map(),
      maxEntrants,
      onDone: (set) => resolve(set),
    });
  });
}

function canManageContest(message) {
  // Admin/privileged only to prevent spammy/misuse
  return isAdminOrPrivileged(message);
}

/**
 * !conteststart [mode choose|elim|list] <time> [quota]
 * - Backwards compatible: if first token is a duration => treated as list mode
 * - choose: picks one entrant
 * - elim: runs elimination on entrant usernames (default 2s between rounds)
 * - list: prints space-separated usernames
 */
export function registerReactionContests(register) {
  register(
    "!conteststart",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      const t = rest.trim().toLowerCase();
      if (!t || t === "help" || t === "h" || t === "?") {
        await message.reply(contestStartHelpText());
        return;
      }

      if (!canManageContest(message)) return;

      const tokens = rest.trim().split(/\s+/).filter(Boolean);

      let mode = "list";
      let timeTok = tokens[0] || "";
      let quotaTok = tokens[1];

      // If first token is a known mode, shift
      const modeMaybe = (tokens[0] || "").toLowerCase();
      if (["choose", "elim", "list"].includes(modeMaybe)) {
        mode = modeMaybe;
        timeTok = tokens[1] || "";
        quotaTok = tokens[2];
      }

      const ms = parseDurationToMs(timeTok);
      if (!ms) {
        await message.reply("Invalid time. Examples: `30sec`, `5min`, `1hour`. Usage: `!conteststart [choose|elim|list] <time> [quota]`");
        return;
      }

      let maxEntrants = null;
      if (quotaTok != null) {
        const n = Number(quotaTok);
        if (!Number.isInteger(n) || n <= 0 || n > 1000) {
          await message.reply("Invalid quota. Usage: `!conteststart [mode] <time> [quota]` (example: `!conteststart 2min 10`).");
          return;
        }
        maxEntrants = n;
      }

      const MAX_MS = 24 * 60 * 60_000;
      if (ms > MAX_MS) {
        await message.reply("Time too large. Max is 24 hours.");
        return;
      }

      const modeLabel = mode === "list" ? "list" : mode === "choose" ? "choose a winner" : "run an elimination";
      const maxNote = maxEntrants ? ` (max **${maxEntrants}** entrants — ends early if reached)` : "";
      const prompt = `React to this message to enter! I will **${modeLabel}** in **${humanDuration(ms)}**...${maxNote}`;

      const entrants = await collectEntrantsByReactions({
        message,
        promptText: prompt,
        durationMs: ms,
        maxEntrants,
        emoji: "👍",
      });

      const ids = [...entrants];
      const names = await buildNameList(message.client, message.guild, ids);

      if (!names.length) {
        await message.channel.send("No one reacted...");
        return;
      }

      if (mode === "list") {
        await message.channel.send(`━━━━━━━━━━━━━━\n${names.length} entrant(s):\n\n${names.join(" ")}`);
        return;
      }

      if (mode === "choose") {
        const pick = chooseOne(names);
        await message.channel.send(`━━━━━━━━━━━━━━\nWinner: **${pick}**\n\n(From ${names.length} entrant(s))`);
        return;
      }

      // mode === "elim"
      // Default: 2 seconds between rounds (keeps it snappy)
      const delaySec = 2;
      const delayMs = delaySec * 1000;

      await message.channel.send(`━━━━━━━━━━━━━━\nStarting elimination with **${names.length}** entrant(s)…`);
      const res = await runElimFromItems({
        message,
        delayMs,
        delaySec,
        items: names,
      });
      if (!res.ok) {
        await message.channel.send(`❌ Could not start elimination: ${res.error}`);
      }
    },
    "!conteststart [choose|elim|list] <time> [quota] — reaction contest using 👍",
    { aliases: ["!contest", "!startcontest"] }
  );
}
