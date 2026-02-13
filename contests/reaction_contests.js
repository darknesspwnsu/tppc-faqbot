// contests/reaction_contests.js
//
// Reaction contest utility:
// - Command: !conteststart [mode] <time> [quota] [winners]
// - Modes: list | choose | elim
// - Scope: guild + channel (bound to the start message)
import { MessageFlags } from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { CONTEST_TOGGLE_ROLE_BY_GUILD } from "../configs/contest_roles.js";
import { formatUserWithId, stripEmojisAndSymbols } from "./helpers.js";
import { sendDm } from "../shared/dm.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { startTimeout, clearTimer } from "../shared/timer_utils.js";
import { chooseOne, runElimFromItems } from "./rng.js";
import {
  buildEligibilityDm,
  checkEligibility,
  filterEligibleEntrants,
  getVerifiedRoleIds,
  resolveMember,
} from "./eligibility.js";

// messageId -> { guildId, channelId, creatorId, endsAtMs, timeout, entrants:Set<string>, entrantReactionCounts:Map<string,number>, maxEntrants?, onDone?, eligibility?, notifiedIneligible? }
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

function humanDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;

  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
}

function mention(id) {
  return `<@${id}>`;
}

function camelizeIfNeeded(name) {
  if (!name) return "";
  if (!name.includes(" ")) return name;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

async function buildContestDisplay({ guild, guildId, userIds }) {
  const ids = Array.isArray(userIds) ? userIds.map(String) : [];
  let bulk = null;
  if (guild?.members?.fetch && ids.length) {
    try {
      bulk = await guild.members.fetch({ user: ids });
    } catch {}
  }

  const entries = ids.map((id) => {
    const member = bulk?.get?.(id) || guild?.members?.cache?.get?.(id) || null;
    const rawName = member?.displayName || member?.user?.username || "";
    const cleaned = stripEmojisAndSymbols(rawName);
    const label = camelizeIfNeeded(cleaned) || member?.user?.username || id;
    return { id, label };
  });

  const winnerLabels = new Map();
  for (const entry of entries) {
    winnerLabels.set(entry.id, await formatUserWithId({ guildId, userId: entry.id }));
  }

  return {
    entries,
    displayNames: entries.map((entry) => entry.label),
    winnerLabels,
  };
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
    "**Eligibility (optional):**",
    "• `require=verified` — only verified users with a saved ID qualify",
    "",
    "**Examples:**",
    "• `!conteststart 2min`",
    "• `!conteststart list 1min 20`",
    "• `!conteststart choose 30sec`",
    "• `!conteststart choose 30sec winners=3`",
    "• `!conteststart choose 30sec prize=$$$ Shiny Klink!!!`",
    "• `!conteststart elim 2min 10`",
    "• `!conteststart list 1min require=verified`",
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
    "",
    "**Eligibility (optional):**",
    "• `require_verified` — only verified users with a saved ID qualify",
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

    if (collector.eligibility?.requireVerified && !collector.notifiedIneligible?.has(user.id)) {
      const member = await resolveMember({ guild: msg.guild, userId: user.id });
      const result = await checkEligibility({
        guild: msg.guild,
        guildId: msg.guildId,
        userId: user.id,
        member,
        requireVerified: true,
        allowAdminBypass: true,
      });
      if (!result.ok) {
        collector.notifiedIneligible?.add(user.id);
        await sendDm({
          user,
          payload: buildEligibilityDm({ guildName: msg.guild?.name, reasons: result.reasons }),
          feature: "reaction_contest.eligibility",
        });
      }
    }

    if (collector.maxEntrants && collector.entrants.size >= collector.maxEntrants) {
      clearTimer(collector.timeout, `reaction_contest:${msg.id}`);
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
  eligibility = null,
}) {
  installReactionHooks(message.client);

  const joinMsg = await message.channel.send(promptText);
  try { await joinMsg.react(emoji); } catch {}

  return await new Promise((resolve) => {
    const timeout = startTimeout({
      label: `reaction_contest:${joinMsg.id}`,
      ms: durationMs,
      fn: () => finalizeCollector(joinMsg.id, "timer"),
    });

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
      eligibility,
      notifiedIneligible: new Set(),
      onDone: (set, reason) => resolve({ entrants: set, reason, messageId: joinMsg.id }),
    });
  });
}

function canManageContest(message) {
  // Admin/privileged only to prevent spammy/misuse
  return isAdminOrPrivileged(message);
}

async function resolveGuildMember(message) {
  if (!message?.guildId || !message?.author?.id) return null;
  if (message.member?.roles?.cache?.has) return message.member;
  if (!message.guild?.members?.fetch) return null;
  try {
    return await message.guild.members.fetch(message.author.id);
  } catch {
    return null;
  }
}

async function cancelCollector({ messageId, canceledById }) {
  const state = activeCollectorsByMessage.get(messageId);
  if (!state) return false;
  clearTimer(state.timeout, `reaction_contest:${messageId}`);
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
        {
          type: 5, // BOOLEAN
          name: "require_verified",
          description: "Require verified role + saved ID",
          required: false,
        },
      ],
    },
    async ({ interaction }) => {
      if (!interaction.guildId || !interaction.channelId || !interaction.channel) {
        await interaction.reply({ content: "This command only works in a server channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (!canManageContest(interaction)) {
        await interaction.reply({ content: "You do not have permission to run this command.", flags: MessageFlags.Ephemeral });
        return;
      }

      const mode = (interaction.options?.getString?.("mode") || "list").toLowerCase();
      const timeTok = interaction.options?.getString?.("time") || "";
      const maxEntrantsRaw = interaction.options?.getInteger?.("quota");
      const winnersRaw = interaction.options?.getInteger?.("winners");
      const prizeRaw = interaction.options?.getString?.("prize") || "";
      const prize = prizeRaw.trim();
      const requireVerified = Boolean(interaction.options?.getBoolean?.("require_verified"));

      if (!timeTok) {
        await interaction.reply({ content: contestSlashHelpText(), flags: MessageFlags.Ephemeral });
        return;
      }

      const ms = parseDurationToMs(timeTok);
      if (!ms) {
        await interaction.reply({
          content: "Invalid time. Examples: `30sec`, `5min`, `1hour`. Use `/contest` to see help.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const existing = findCollectorForChannel(interaction.guildId, interaction.channelId);
      if (existing) {
        await interaction.reply({ content: "⚠️ A reaction contest is already running in this channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      let maxEntrants = maxEntrantsRaw ?? null;
      let winnerCount = Number.isInteger(winnersRaw) ? winnersRaw : 1;

      if (maxEntrants != null) {
        if (!Number.isInteger(maxEntrants) || maxEntrants <= 0 || maxEntrants > 1000) {
          await interaction.reply({ content: "Invalid quota. Use a positive number (max 1000).", flags: MessageFlags.Ephemeral });
          return;
        }
      }

      if (mode === "choose") {
        if (!Number.isInteger(winnerCount) || winnerCount <= 0 || winnerCount > 1000) {
          await interaction.reply({ content: "Invalid winners count. Use a positive integer (max 1000).", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        winnerCount = 1;
      }

      if (requireVerified) {
        const verifiedRoles = getVerifiedRoleIds(interaction.guildId);
        if (!verifiedRoles.length) {
          await interaction.reply({
            content: "❌ No verified roles are configured for this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      const MAX_MS = 24 * 60 * 60_000;
      if (ms > MAX_MS) {
        await interaction.reply({ content: "Time too large. Max is 24 hours.", flags: MessageFlags.Ephemeral });
        return;
      }

      const chooseLabel =
        mode === "choose"
          ? (winnerCount > 1 ? `choose ${winnerCount} winners` : "choose a winner")
          : null;
      const modeLabel = mode === "list" ? "list" : mode === "choose" ? chooseLabel : "run an elimination";
      const maxNote = maxEntrants ? ` (max **${maxEntrants}** entrants — ends early if reached)` : "";
      const eligibilityNote = requireVerified
        ? "\nEligibility: verified role + Spectreon ID required."
        : "";
      const prompt = `React to this message to enter! I will **${modeLabel}** in **${humanDuration(ms)}**...${maxNote}${eligibilityNote}`;

      await interaction.reply({
        content: `✅ Contest started in <#${interaction.channelId}>.`,
        flags: MessageFlags.Ephemeral,
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
        eligibility: requireVerified ? { requireVerified: true } : null,
      });
      if (reason === "cancel") return;

      let ids = [...entrants];
      if (requireVerified) {
        const filtered = await filterEligibleEntrants({
          guild: message.guild,
          guildId: message.guildId,
          userIds: ids,
          requireVerified: true,
        });
        ids = filtered.eligibleIds;
      }
      const { entries, displayNames, winnerLabels } = await buildContestDisplay({
        guild: message.guild,
        guildId: message.guildId,
        userIds: ids,
      });

      if (!displayNames.length) {
        await message.channel.send(requireVerified ? "No eligible entrants..." : "No one reacted...");
        return;
      }

      if (mode === "list") {
        await message.channel.send(`━━━━━━━━━━━━━━\n${displayNames.length} entrant(s):`);
        await message.channel.send(displayNames.join(" "));
        return;
      }

      if (mode === "choose") {
        if (winnerCount > displayNames.length) {
          await message.channel.send(
            `Not enough entrants to pick ${winnerCount} winners (only ${displayNames.length}).`
          );
          return;
        }

        const winnerList = entries.map((entry) => winnerLabels.get(entry.id) || entry.label);
        const picks = winnerCount > 1 ? chooseMany(winnerList, winnerCount) : [chooseOne(winnerList)];
        const label = winnerCount > 1 ? "Winners" : "Winner";
        const prizeLine = winnerCount === 1 && prize ? `\nPrize: **${prize}**` : "";
        await message.channel.send(
          `━━━━━━━━━━━━━━\nEntrant(s): ${displayNames.length}\n${label}: **${picks.join(", ")}**${prizeLine}`
        );
        return;
      }

      const delaySec = 2;
      const delayMs = delaySec * 1000;
      const winnerSuffix = prize ? `Prize: **${prize}**` : "";

      await message.channel.send(`━━━━━━━━━━━━━━\nStarting elimination with **${displayNames.length}** entrant(s)…`);
      const res = await runElimFromItems({
        message,
        delayMs,
        delaySec,
        items: entries,
        itemLabel: (entry) => entry.label,
        winnerLabel: (entry) => winnerLabels.get(entry.id) || entry.label,
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
    "!contest",
    async ({ message }) => {
      if (!message?.guildId || !message?.author?.id) return;

      const roleId = CONTEST_TOGGLE_ROLE_BY_GUILD[String(message.guildId)] || null;
      if (!roleId) {
        await message.reply("Contest role toggle is not configured for this server.");
        return;
      }

      const member = await resolveGuildMember(message);
      if (!member?.roles?.cache?.has || !member?.roles?.add || !member?.roles?.remove) {
        await message.reply("I could not resolve your server role state.");
        return;
      }

      try {
        const hasRole = Boolean(member.roles.cache.has(roleId));
        if (hasRole) {
          await member.roles.remove(roleId, "User toggled contest role via !contest");
          await message.reply("✅ Removed contest notifications role.");
          return;
        }

        await member.roles.add(roleId, "User toggled contest role via !contest");
        await message.reply("✅ Added contest notifications role.");
      } catch {
        await message.reply("❌ I couldn't update your contest role. Please contact staff.");
      }
    },
    "!contest — toggle contest notifications role for this server",
    { aliases: ["!contests"] }
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
      let requireVerified = false;

      for (const tok of extras) {
        const t = String(tok).trim();
        if (!t) continue;

        if (["require=verified", "require=eligible", "verified", "eligible"].includes(t.toLowerCase())) {
          requireVerified = true;
          continue;
        }

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

      if (requireVerified) {
        const verifiedRoles = getVerifiedRoleIds(message.guildId);
        if (!verifiedRoles.length) {
          await message.reply("❌ No verified roles are configured for this server.");
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
      const eligibilityNote = requireVerified
        ? "\nEligibility: verified role + Spectreon ID required."
        : "";
      const prompt = `React to this message to enter! I will **${modeLabel}** in **${humanDuration(ms)}**...${maxNote}${eligibilityNote}`;

      const { entrants, reason } = await collectEntrantsByReactions({
        message,
        promptText: prompt,
        durationMs: ms,
        maxEntrants,
        emoji: "👍",
        eligibility: requireVerified ? { requireVerified: true } : null,
      });
      if (reason === "cancel") return;

      let ids = [...entrants];
      if (requireVerified) {
        const filtered = await filterEligibleEntrants({
          guild: message.guild,
          guildId: message.guildId,
          userIds: ids,
          requireVerified: true,
        });
        ids = filtered.eligibleIds;
      }
      const { entries, displayNames, winnerLabels } = await buildContestDisplay({
        guild: message.guild,
        guildId: message.guildId,
        userIds: ids,
      });

      if (!displayNames.length) {
        await message.channel.send(requireVerified ? "No eligible entrants..." : "No one reacted...");
        return;
      }

      if (mode === "list") {
        await message.channel.send(`━━━━━━━━━━━━━━\n${displayNames.length} entrant(s):`);
        await message.channel.send(displayNames.join(" "));
        return;
      }

      if (mode === "choose") {
        if (winnerCount > displayNames.length) {
          await message.channel.send(
            `Not enough entrants to pick ${winnerCount} winners (only ${displayNames.length}).`
          );
          return;
        }

        const winnerList = entries.map((entry) => winnerLabels.get(entry.id) || entry.label);
        const picks = winnerCount > 1 ? chooseMany(winnerList, winnerCount) : [chooseOne(winnerList)];
        const label = winnerCount > 1 ? "Winners" : "Winner";
        const prizeLine = winnerCount === 1 && prize ? `\nPrize: **${prize}**` : "";
        await message.channel.send(
          `━━━━━━━━━━━━━━\nEntrant(s): ${displayNames.length}\n${label}: **${picks.join(", ")}**${prizeLine}`
        );
        return;
      }

      // mode === "elim"
      // Default: 2 seconds between rounds (keeps it snappy)
      const delaySec = 2;
      const delayMs = delaySec * 1000;
      const winnerSuffix = prize ? `Prize: **${prize}**` : "";

      await message.channel.send(`━━━━━━━━━━━━━━\nStarting elimination with **${displayNames.length}** entrant(s)…`);
      const res = await runElimFromItems({
        message,
        delayMs,
        delaySec,
        items: entries,
        itemLabel: (entry) => entry.label,
        winnerLabel: (entry) => winnerLabels.get(entry.id) || entry.label,
        winnerSuffix,
      });
      if (!res.ok) {
        await message.channel.send(`❌ Could not start elimination: ${res.error}`);
      }
    },
    "!conteststart [choose|elim|list] <time> [quota] [winners] — reaction contest using 👍",
    { aliases: ["!startcontest"] }
  );
}
