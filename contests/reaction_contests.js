// contests/reaction_contests.js
//
// Reaction contest utility:
// - Command: !conteststart [mode] <time> [quota] [winners]
// - Modes: list | choose | elim
// - Scope: guild + channel (bound to the start message)
import { isAdminOrPrivileged } from "../auth.js";
import { stripEmojisAndSymbols } from "./helpers.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { chooseOne, runElimFromItems } from "./rng.js";

// messageId -> { guildId, channelId, creatorId, endsAtMs, timeout, entrants:Set<string>, entrantReactionCounts:Map<string,number>, maxEntrants?, onDone? }
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

function mention(id) {
  return `<@${id}>`;
}

function chooseMany(arr, count) {
  const pool = Array.isArray(arr) ? arr.slice() : [];
  const picks = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function findCollectorForChannel(guildId, channelId) {
  for (const [messageId, st] of activeCollectorsByMessage.entries()) {
    if (st.guildId === guildId && st.channelId === channelId) {
      return { messageId, state: st };
    }
  }
  return null;
}

async function finalizeCollector(messageId, reason = "timer", finalText = "Entries have closed for this contest.") {
  const state = activeCollectorsByMessage.get(messageId);
  if (!state) return;

  activeCollectorsByMessage.delete(messageId);

  // Edit the original entry message like the old behavior
  try {
    const channel = await state.client.channels.fetch(state.channelId);
    if (channel?.isTextBased?.()) {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(finalText);
    }
  } catch (e) {
    console.warn("Failed to edit contest message:", e);
  }

  const userIds = [...state.entrants];
  if (typeof state.onDone === "function") {
    try { state.onDone(new Set(userIds), reason); } catch {}
  }
}


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
    "• `choose` — picks N winners (default 1)",
    "• `elim` — runs elimination until 1 remains (2s between rounds)",
    "",
    "**Time:**",
    "• `30sec`, `5min`, `1hour`",
    "",
    "**Quota (optional):**",
    "• Ends early once N entrants have reacted",
    "",
    "**Winners (choose mode only):**",
    "• `winners=<n>` (default 1)",
    "",
    "**Prize (choose 1 / elim only):**",
    "• `prize=<text>` (text can include spaces/symbols)",
    "",
    "**Examples:**",
    "• `!conteststart 2min`",
    "• `!conteststart list 1min 20`",
    "• `!conteststart choose 30sec`",
    "• `!conteststart choose 30sec winners=3`",
    "• `!conteststart choose 30sec prize=$$$ Shiny Klink!!!`",
    "• `!conteststart elim 2min 10`",
    ""
  ].join("\n");
}

function contestSlashHelpText() {
  return [
    "**/contest — Help**",
    "",
    "**Modes:**",
    "• `list` (default) — prints a space-separated list of entrants",
    "• `choose` — picks N winners (default 1)",
    "• `elim` — runs elimination until 1 remains (2s between rounds)",
    "",
    "**Time:**",
    "• `30sec`, `5min`, `1hour`",
    "",
    "**Quota (optional):**",
    "• Ends early once N entrants have reacted",
    "",
    "**Winners (choose mode only):**",
    "• Number of winners (default 1)",
    "",
    "**Prize (choose 1 / elim only):**",
    "• Prize text shown alongside the winner",
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
      creatorId: message.author?.id || null,
      endsAtMs: Date.now() + durationMs,
      timeout,
      entrants: new Set(),
      entrantReactionCounts: new Map(),
      maxEntrants,
      onDone: (set, reason) => resolve({ entrants: set, reason, messageId: joinMsg.id }),
    });
  });
}

function canManageContest(message) {
  // Admin/privileged only to prevent spammy/misuse
  return isAdminOrPrivileged(message);
}

async function cancelCollector({ messageId, canceledById }) {
  const state = activeCollectorsByMessage.get(messageId);
  if (!state) return false;
  if (state.timeout) {
    try { clearTimeout(state.timeout); } catch {}
  }
  await finalizeCollector(
    messageId,
    "cancel",
    `🛑 This contest was cancelled by ${mention(canceledById)}.`
  );
  return true;
}

/**
 * !conteststart [mode choose|elim|list] <time> [quota] [winners]
 * - Backwards compatible: if first token is a duration => treated as list mode
 * - choose: picks N entrants (default 1)
 * - elim: runs elimination on entrant usernames (default 2s between rounds)
 * - list: prints space-separated usernames
 */
export function registerReactionContests(register) {
  register.slash(
    {
      name: "contest",
      description: "Start a reaction contest (same as !conteststart)",
      options: [
        {
          type: 3, // STRING
          name: "mode",
          description: "Contest mode",
          required: false,
          choices: [
            { name: "list", value: "list" },
            { name: "choose", value: "choose" },
            { name: "elim", value: "elim" },
          ],
        },
        {
          type: 3, // STRING
          name: "time",
          description: "Duration (e.g., 30sec, 5min, 1hour)",
          required: false,
        },
        {
          type: 4, // INTEGER
          name: "quota",
          description: "End early once N entrants have reacted",
          required: false,
        },
        {
          type: 4, // INTEGER
          name: "winners",
          description: "Number of winners (choose mode only)",
          required: false,
        },
        {
          type: 3, // STRING
          name: "prize",
          description: "Prize text (choose one or elim only)",
          required: false,
        },
      ],
    },
    async ({ interaction }) => {
      if (!interaction.guildId || !interaction.channelId || !interaction.channel) {
        await interaction.reply({ content: "This command only works in a server channel.", ephemeral: true });
        return;
      }

      if (!canManageContest(interaction)) {
        await interaction.reply({ content: "You do not have permission to run this command.", ephemeral: true });
        return;
      }

      const mode = (interaction.options?.getString?.("mode") || "list").toLowerCase();
      const timeTok = interaction.options?.getString?.("time") || "";
      const maxEntrantsRaw = interaction.options?.getInteger?.("quota");
      const winnersRaw = interaction.options?.getInteger?.("winners");
      const prizeRaw = interaction.options?.getString?.("prize") || "";
      const prize = prizeRaw.trim();

      if (!timeTok) {
        await interaction.reply({ content: contestSlashHelpText(), ephemeral: true });
        return;
      }

      const ms = parseDurationToMs(timeTok);
      if (!ms) {
        await interaction.reply({
          content: "Invalid time. Examples: `30sec`, `5min`, `1hour`. Use `/contest` to see help.",
          ephemeral: true,
        });
        return;
      }

      const existing = findCollectorForChannel(interaction.guildId, interaction.channelId);
      if (existing) {
        await interaction.reply({ content: "⚠️ A reaction contest is already running in this channel.", ephemeral: true });
        return;
      }

      let maxEntrants = maxEntrantsRaw ?? null;
      let winnerCount = Number.isInteger(winnersRaw) ? winnersRaw : 1;

      if (maxEntrants != null) {
        if (!Number.isInteger(maxEntrants) || maxEntrants <= 0 || maxEntrants > 1000) {
          await interaction.reply({ content: "Invalid quota. Use a positive number (max 1000).", ephemeral: true });
          return;
        }
      }

      if (mode === "choose") {
        if (!Number.isInteger(winnerCount) || winnerCount <= 0 || winnerCount > 1000) {
          await interaction.reply({ content: "Invalid winners count. Use a positive integer (max 1000).", ephemeral: true });
          return;
        }
      } else {
        winnerCount = 1;
      }

      const MAX_MS = 24 * 60 * 60_000;
      if (ms > MAX_MS) {
        await interaction.reply({ content: "Time too large. Max is 24 hours.", ephemeral: true });
        return;
      }

      const chooseLabel =
        mode === "choose"
          ? (winnerCount > 1 ? `choose ${winnerCount} winners` : "choose a winner")
          : null;
      const modeLabel = mode === "list" ? "list" : mode === "choose" ? chooseLabel : "run an elimination";
      const maxNote = maxEntrants ? ` (max **${maxEntrants}** entrants — ends early if reached)` : "";
      const prompt = `React to this message to enter! I will **${modeLabel}** in **${humanDuration(ms)}**...${maxNote}`;

      await interaction.reply({
        content: `✅ Contest started in <#${interaction.channelId}>.`,
        ephemeral: true,
      });

      const message = {
        client: interaction.client,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        channel: interaction.channel,
        author: interaction.user,
        guild: interaction.guild,
      };

      const { entrants, reason } = await collectEntrantsByReactions({
        message,
        promptText: prompt,
        durationMs: ms,
        maxEntrants,
        emoji: "👍",
      });
      if (reason === "cancel") return;

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
        if (winnerCount > names.length) {
          await message.channel.send(
            `Not enough entrants to pick ${winnerCount} winners (only ${names.length}).`
          );
          return;
        }

        const picks = winnerCount > 1 ? chooseMany(names, winnerCount) : [chooseOne(names)];
        const label = winnerCount > 1 ? "Winners" : "Winner";
        const prizeLine = winnerCount === 1 && prize ? `\nPrize: **${prize}**` : "";
        await message.channel.send(
          `━━━━━━━━━━━━━━\n${label}: **${picks.join(", ")}**${prizeLine}\n\n(From ${names.length} entrant(s))`
        );
        return;
      }

      const delaySec = 2;
      const delayMs = delaySec * 1000;
      const winnerSuffix = prize ? `Prize: **${prize}**` : "";

      await message.channel.send(`━━━━━━━━━━━━━━\nStarting elimination with **${names.length}** entrant(s)…`);
      const res = await runElimFromItems({
        message,
        delayMs,
        delaySec,
        items: names,
        winnerSuffix,
      });
      if (!res.ok) {
        await message.channel.send(`❌ Could not start elimination: ${res.error}`);
      }
    }
  );

  register(
    "!cancelcontest",
    async ({ message }) => {
      if (!message.guildId) return;

      const found = findCollectorForChannel(message.guildId, message.channelId);
      if (!found) {
        await message.reply("No active contest to cancel in this channel.");
        return;
      }

      const isOwner = found.state.creatorId && message.author?.id === found.state.creatorId;
      if (!isOwner && !isAdminOrPrivileged(message)) {
        await message.reply("Nope — only the contest host or an admin can cancel.");
        return;
      }

      const ok = await cancelCollector({ messageId: found.messageId, canceledById: message.author?.id });
      if (ok) await message.reply("🛑 Contest cancelled.");
    },
    "!cancelcontest — cancel an active reaction contest in this channel",
    { hideFromHelp: true, aliases: ["!endcontest", "!stopcontest"] }
  );

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

      const existing = findCollectorForChannel(message.guildId, message.channelId);
      if (existing) {
        await message.reply("⚠️ A reaction contest is already running in this channel.");
        return;
      }

      let prize = "";
      let restSansPrize = rest;
      const prizeMatch = /(?:^|\s)prize=(.+)$/i.exec(rest);
      if (prizeMatch) {
        prize = prizeMatch[1].trim();
        restSansPrize = rest.replace(prizeMatch[0], "").trim();
      }

      const tokens = restSansPrize.trim().split(/\s+/).filter(Boolean);

      let mode = "list";
      let timeTok = tokens[0] || "";
      let extras = tokens.slice(1);

      // If first token is a known mode, shift
      const modeMaybe = (tokens[0] || "").toLowerCase();
      if (["choose", "elim", "list"].includes(modeMaybe)) {
        mode = modeMaybe;
        timeTok = tokens[1] || "";
        extras = tokens.slice(2);
      }

      const ms = parseDurationToMs(timeTok);
      if (!ms) {
        await message.reply("Invalid time. Examples: `30sec`, `5min`, `1hour`. Usage: `!conteststart [choose|elim|list] <time> [quota] [winners]`");
        return;
      }

      let maxEntrants = null;
      let winnerCount = 1;
      let winnerExplicit = false;

      for (const tok of extras) {
        const t = String(tok).trim();
        if (!t) continue;

        const winnerMatch = /^(winners?|pick|picks?)=(\d+)$/i.exec(t);
        if (winnerMatch) {
          winnerCount = Number(winnerMatch[2]);
          winnerExplicit = true;
          continue;
        }

        if (/^\d+$/.test(t)) {
          const n = Number(t);
          if (maxEntrants == null) {
            maxEntrants = n;
            continue;
          }
          if (mode === "choose" && !winnerExplicit) {
            winnerCount = n;
            winnerExplicit = true;
            continue;
          }
        }
      }

      if (maxEntrants != null) {
        if (!Number.isInteger(maxEntrants) || maxEntrants <= 0 || maxEntrants > 1000) {
          await message.reply("Invalid quota. Usage: `!conteststart [mode] <time> [quota]` (example: `!conteststart 2min 10`).");
          return;
        }
      }

      if (mode === "choose") {
        if (!Number.isInteger(winnerCount) || winnerCount <= 0 || winnerCount > 1000) {
          await message.reply("Invalid winners count. Use `winners=<n>` with a positive integer.");
          return;
        }
      }

      const MAX_MS = 24 * 60 * 60_000;
      if (ms > MAX_MS) {
        await message.reply("Time too large. Max is 24 hours.");
        return;
      }

      const chooseLabel =
        mode === "choose"
          ? (winnerCount > 1 ? `choose ${winnerCount} winners` : "choose a winner")
          : null;
      const modeLabel = mode === "list" ? "list" : mode === "choose" ? chooseLabel : "run an elimination";
      const maxNote = maxEntrants ? ` (max **${maxEntrants}** entrants — ends early if reached)` : "";
      const prompt = `React to this message to enter! I will **${modeLabel}** in **${humanDuration(ms)}**...${maxNote}`;

      const { entrants, reason } = await collectEntrantsByReactions({
        message,
        promptText: prompt,
        durationMs: ms,
        maxEntrants,
        emoji: "👍",
      });
      if (reason === "cancel") return;

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
        if (winnerCount > names.length) {
          await message.channel.send(
            `Not enough entrants to pick ${winnerCount} winners (only ${names.length}).`
          );
          return;
        }

        const picks = winnerCount > 1 ? chooseMany(names, winnerCount) : [chooseOne(names)];
        const label = winnerCount > 1 ? "Winners" : "Winner";
        const prizeLine = winnerCount === 1 && prize ? `\nPrize: **${prize}**` : "";
        await message.channel.send(
          `━━━━━━━━━━━━━━\n${label}: **${picks.join(", ")}**${prizeLine}\n\n(From ${names.length} entrant(s))`
        );
        return;
      }

      // mode === "elim"
      // Default: 2 seconds between rounds (keeps it snappy)
      const delaySec = 2;
      const delayMs = delaySec * 1000;
      const winnerSuffix = prize ? `Prize: **${prize}**` : "";

      await message.channel.send(`━━━━━━━━━━━━━━\nStarting elimination with **${names.length}** entrant(s)…`);
      const res = await runElimFromItems({
        message,
        delayMs,
        delaySec,
        items: names,
        winnerSuffix,
      });
      if (!res.ok) {
        await message.channel.send(`❌ Could not start elimination: ${res.error}`);
      }
    },
    "!conteststart [choose|elim|list] <time> [quota] [winners] — reaction contest using 👍",
    { aliases: ["!contest", "!startcontest"] }
  );
}
