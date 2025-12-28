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

import { isAdminOrPrivileged } from "./auth.js";

// guildId -> {
//   client, guildId, channelId, messageId, creatorId, endsAtMs, timeout,
//   entrants:Set<string>,
//   entrantReactionCounts: Map<string, number>,
//   maxEntrants?: number
// }
const activeByGuild = new Map();
// messageId -> { guildId, channelId, endsAtMs, timeout, entrants:Set<string>, entrantReactionCounts:Map<string,number>, maxEntrants?: number, onDone?: (set)=>void }
const activeCollectorsByMessage = new Map();
// guildId -> { timeout: NodeJS.Timeout, channelId: string }
const activeElimByGuild = new Map();


let reactionHooksInstalled = false;

// Channel allowlist for specific commands
// guildId -> array of allowed channelIds
const AWESOME_CHANNELS = {
  "329934860388925442": ["331114564966154240", "551243336187510784"]
};

function isAllowedChannel(message, allowedIds) {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) return true; // allow everywhere by default
  const cid = message?.channelId;
  return !!cid && allowedIds.includes(cid);
}

function canManageContest(message, state) {
  if (!state) return false;
  if (isAdminOrPrivileged(message)) return true;
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

function randIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
function targetUserId(message) {
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}
function mention(id) {
  return `<@${id}>`;
}
function parseSecondsToMs(raw) {
  const s = (raw ?? "").trim().toLowerCase();
  const m = /^(\d+)\s*s$/.exec(s);
  if (!m) return { error: "Delay must be specified in seconds, e.g. `2s` (1s–30s)." };

  const seconds = Number(m[1]);
  if (!Number.isInteger(seconds)) return { error: "Delay must be a whole number of seconds." };
  if (seconds < 1) return { error: "Delay must be at least 1 second." };
  if (seconds > 30) return { error: "Delay cannot exceed 30 seconds." };
  return { ms: seconds * 1000, seconds };
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

export function installReactionHooks(client) {
  if (reactionHooksInstalled) return;
  reactionHooksInstalled = true;

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    const msg = reaction.message;
    if (!msg?.guildId) return;

    // ---- 1) Contest tracking (per guild, single active contest) ----
    const contestState = activeByGuild.get(msg.guildId);
    if (contestState && msg.id === contestState.messageId) {
      const counts = contestState.entrantReactionCounts;
      const prev = counts.get(user.id) ?? 0;
      counts.set(user.id, prev + 1);
      contestState.entrants.add(user.id);

      if (
        contestState.maxEntrants &&
        contestState.entrants.size >= contestState.maxEntrants
      ) {
        try { clearTimeout(contestState.timeout); } catch {}
        await finalizeContest(msg.guildId, "max");
      }
      return;
    }

    // ---- 2) Generic collectors (per message) ----
    const collector = activeCollectorsByMessage.get(msg.id);
    if (!collector) return;

    const counts = collector.entrantReactionCounts;
    const prev = counts.get(user.id) ?? 0;
    counts.set(user.id, prev + 1);
    collector.entrants.add(user.id);

    if (
      collector.maxEntrants &&
      collector.entrants.size >= collector.maxEntrants
    ) {
      try { clearTimeout(collector.timeout); } catch {}
      await finalizeCollector(msg.id, "max");
    }
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    if (user.bot) return;

    const msg = reaction.message;
    if (!msg?.guildId) return;

    // ---- 1) Contest tracking ----
    const contestState = activeByGuild.get(msg.guildId);
    if (contestState && msg.id === contestState.messageId) {
      const counts = contestState.entrantReactionCounts;
      const prev = counts.get(user.id) ?? 0;
      const next = prev - 1;

      if (next <= 0) {
        counts.delete(user.id);
        contestState.entrants.delete(user.id);
      } else {
        counts.set(user.id, next);
      }
      return;
    }

    // ---- 2) Generic collectors ----
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

  const { client, channelId, messageId, creatorId, endsAtMs } = state;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel?.isTextBased() && messageId) {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit("Entries have closed for this contest.");
    }
  } catch (e) {
    console.warn("Failed to edit contest message:", e);
  }

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
      : `(ended <t:${Math.floor(endsAtMs / 1000)}:t>):`;

  const body = total === 0 ? "No one reacted..." : nameList.join(" ");

  const channel = await client.channels.fetch(channelId);
  if (channel?.isTextBased()) {
    await channel.send(
      `━━━━━━━━━━━━━━\n<@${creatorId}> ${total} entrant(s) ${elapsedNote}\n\n${body}`
    );
  }
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
    { aliases: ["!contest", "!startcontest"] }
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

  register("?roll", async ({ message, rest }) => {
    const arg = rest.trim();
    const m = /^(\d+)d(\d+)(?:\s+(norepeat|nr))?$/i.exec(arg);

    if (!m) {
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    const noRepeat = !!m[3];
    const n = Number(m[1]);
    const sides = Number(m[2]);

    if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 0) {
      // sides=0 is allowed (then only result is 0)
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    if (noRepeat && n > (sides + 1)) {
      await message.channel.send(`Impossible with norepeat: you asked for ${n} unique rolls but range is only 0..${sides} (${sides + 1} unique values).`);
      return;
    }

    const uid = targetUserId(message);
    let rolls;

    if (!noRepeat) {
      rolls = Array.from({ length: n }, () => randIntInclusive(0, sides));
    } else {
      // Unique sampling from integers [0..sides]
      // Strategy:
      // - If n is a large fraction of the range, do a partial Fisher-Yates shuffle (faster than rejection).
      // - Else use a Set with rejection sampling (simple and fast when n << range).
      const rangeSize = sides + 1;

      if (n > rangeSize * 0.6) {
        // Partial shuffle: build 0..sides and shuffle first n positions.
        const arr = Array.from({ length: rangeSize }, (_, i) => i);
        for (let i = 0; i < n; i++) {
          const j = randIntInclusive(i, rangeSize - 1);
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
        rolls = arr.slice(0, n);
      } else {
        const seen = new Set();
        while (seen.size < n) {
          seen.add(randIntInclusive(0, sides));
        }
        rolls = Array.from(seen);
      }
    }

    const suffix = noRepeat ? " (norepeat mode: ON)" : "";
    const out = `${mention(uid)} ${rolls.join(", ")}${suffix}`;

    // Discord message content hard limit ~2000 chars
    if (out.length > 1900) {
      await message.channel.send(
        `${mention(uid)} Rolled ${n}d${sides}${noRepeat ? " norepeat" : ""}. Output too long to display (${out.length} chars). Try a smaller N.`
      );
      return;
    }

    await message.channel.send(out);
  }, "?roll NdM — rolls N numbers from 0..M (example: ?roll 1d100)");

  register("?choose", async ({ message, rest }) => {
    const options = rest.trim().split(/\s+/).filter(Boolean);
    if (options.length < 1) {
      await message.channel.send("Usage: `!choose option1 option2 ...`");
      return;
    }
    const pick = options[randIntInclusive(0, options.length - 1)];
    await message.channel.send(pick);
  }, "?choose a b c — randomly chooses one option");

  register(
    "?elim",
    async ({ message, rest }) => {
      if (!message.guild) return;
      // Only one elim at a time per guild
      if (activeElimByGuild.has(message.guildId)) {
        await message.reply("An elimination is already running, please wait for it to finish!");
        return;
      }

      const parts = rest.trim().split(/\s+/).filter(Boolean);

      if (parts.length < 3) {
        await message.reply("Usage: `?elim <seconds> <item1> <item2> [...]`");
        return;
      }

      const delayRaw = parts[0];
      const parsed = parseSecondsToMs(delayRaw);

      if (parsed.error) {
        await message.reply(parsed.error);
        return;
      }

      const delayMs = parsed.ms;
      const delaySec = parsed.seconds;

      let remaining = parts.slice(1);
      if (remaining.length < 2) {
        await message.reply("You need at least 2 items to run an elimination.");
        return;
      }

      await message.channel.send(
        `Setting up elimination with ${delaySec}s between rounds... are you ready?`
      );

      remaining = [...remaining];

      const finish = async () => {
        // Clear lock
        const st = activeElimByGuild.get(message.guildId);
        if (st?.timeout) {
          try { clearTimeout(st.timeout); } catch {}
        }
        activeElimByGuild.delete(message.guildId);

        // Winner immediately (no extra delay)
        if (remaining.length === 1) {
          await message.channel.send(`${remaining[0]} wins!`);
        } else {
          await message.channel.send("Elimination ended with no winner.");
        }
      };

      const runRound = async () => {
        if (!message.channel) return;

        // If only one remains, declare winner NOW (no extra waiting)
        if (remaining.length === 1) {
          await finish();
          return;
        }

        const idx = Math.floor(Math.random() * remaining.length);
        const eliminated = remaining.splice(idx, 1)[0];

        await message.channel.send(
          `${eliminated} has been eliminated! Remaining: ${remaining.join(", ")}\n______________________`
        );

        // ✅ If we just reached a single remaining entry, declare winner NOW (no extra delay)
        if (remaining.length === 1) {
          await finish(); // finish() should send "<winner> wins!" and clear the lock
          return;
        }

        // Otherwise schedule the next round as usual
        const t = setTimeout(runRound, delayMs);
        const st = activeElimByGuild.get(message.guildId);
        if (st) st.timeout = t;
      };

      // Acquire lock *right before* starting
      activeElimByGuild.set(message.guildId, { timeout: null, channelId: message.channelId });

      // Start immediately (first elimination happens after delayMs, as before)
      const t0 = setTimeout(runRound, delayMs);
      activeElimByGuild.set(message.guildId, { timeout: t0, channelId: message.channelId, creatorId: message.author.id });

    },
    "?elim <1–30s> <items...> — randomly eliminates one item per round"
  );
  
  register(
    "?cancelelim",
    async ({ message }) => {
      if (!message.guildId) return;
  
      const state = activeElimByGuild.get(message.guildId);
      if (!state) {
        await message.reply("No elimination is currently running.");
        return;
      }
  
      if (!isAdminOrPrivileged(message) && message.author.id !== state.creatorId) {
        await message.reply("Only the elimination starter or an admin can cancel it.");
        return;
      }
  
      if (state.timeout) {
        try { clearTimeout(state.timeout); } catch {}
      }
      
      activeElimByGuild.delete(message.guildId);
  
      await message.channel.send("Elimination has been cancelled!");
    },
    "?cancelelim — cancels the currently running elimination",
    { aliases: ["?stopelim", "?endelim"] }
  );

  register("!awesome", async ({ message }) => {
    if (!isAllowedChannel(message, AWESOME_CHANNELS)) {
      return;
    }

    const uid = targetUserId(message);
    const x = randIntInclusive(0, 101);
    await message.channel.send(`${mention(uid)} is ${x}% awesome!`);
  }, "!awesome — tells you how awesome someone is (0–101%)");

  // !coinflip — heads/tails (rare side!)
  register(
    "!coinflip",
    async ({ message }) => {
      const uid = targetUserId(message);
      const roll = Math.random(); // [0,1)
      // Probability breakdown:
      //  - 0.5%  chance → coin lands on its side
      //  - 49.75% chance → Heads
      //  - 49.75% chance → Tails
      //
      // IMPORTANT: thresholds are CUMULATIVE.
      // We carve the [0,1) range like this:
      //
      //   [0.0000 ── 0.0050)   = Side      (0.5%)
      //   [0.0050 ── 0.5025)   = Heads     (49.75%)
      //   [0.5025 ── 1.0000)   = Tails     (49.75%)
      //
      // Heads cutoff is 0.005 + 0.4975 = 0.5025 (not 0.4975!)
      let result;
      if (roll < 0.005) {
        const sideMessages = [
          "🪙 landed on its side! Physics is confused.",
          "🪙 balanced perfectly on its edge. RNGesus is watching.",
          "🪙 landed on its side. Buy a lottery ticket.",
          "🪙 stands upright. Reality briefly glitches.",
        ];
        result = sideMessages[Math.floor(Math.random() * sideMessages.length)];
      } else if (roll < 0.5025) {
        result = "Heads!";
      } else {
        result = "Tails!";
      }

      await message.channel.send(`${mention(uid)} ${result}`);
    },
    "!coinflip — flips a coin (Heads/Tails)",
    { aliases: ["!flip", "!coin"] }
  );
}
