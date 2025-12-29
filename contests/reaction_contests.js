// contests/reaction_contests.js
import { isAdminOrPrivileged } from "../auth.js";
import { chooseOne, runElimFromItems } from "./rng.js";

// messageId -> { guildId, channelId, endsAtMs, timeout, entrants:Set<string>, entrantReactionCounts:Map<string,number>, maxEntrants?, onDone? }
const activeCollectorsByMessage = new Map();

let reactionHooksInstalled = false;

function parseDurationToMs(raw) {
  const s = (raw ?? "").trim().toLowerCase();
  const m =
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(s);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = m[2];
  if (unit.startsWith("s")) return n * 1000;
  if (unit.startsWith("m")) return n * 60_000;
  return n * 3_600_000;
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

async function finalizeCollector(messageId, reason = "timer") {
  const state = activeCollectorsByMessage.get(messageId);
  if (!state) return;

  activeCollectorsByMessage.delete(messageId);

  const userIds = [...state.entrants];
  if (typeof state.onDone === "function") {
    try { state.onDone(new Set(userIds), reason); } catch {}
  }
}

export function installReactionHooks(client) {
  if (reactionHooksInstalled) return;
  reactionHooksInstalled = true;

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    const msg = reaction.message;
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

    const msg = reaction.message;
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
  // reaction contests are ephemeral to the command itself, but keep admin gate for future-proofing
  return isAdminOrPrivileged(message) || !!message.author?.id;
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
      const names = await buildNameList(message.client, ids);

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
