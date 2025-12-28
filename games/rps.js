// games/rps.js
//
// Rock Paper Scissors (RPS)
//
// Command:
// - !rps [num_rounds] [@opponent]
//
// Modes:
// - Solo:  !rps [num_rounds]           => you vs bot
// - PvP:   !rps [num_rounds] @user     => you vs tagged user
//
// num_rounds = "first to N wins" (default 1).
// Ties redo the round (no score change).
//
// Input privacy:
// - Players choose via buttons in-channel
// - Each click is acknowledged ephemerally ("choice locked in")
// - Public message only shows who has locked in (not the choices) until reveal.
//
// Timeout:
// - 30s per round
// - If a player fails to pick by deadline, they forfeit the round.
//
// Commands:
// - !rpshelp
// - !rpscancel (admin or creator)
//
// One active game per guild, bound to the channel it started in.
//
// Uses component interactions via register.component("rps:", handler)

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";

const ACTIVE = new Map(); // guildId -> state

const CHOICES = ["rock", "paper", "scissors"];

function rpsHelp() {
  return [
    "**RPS — Help**",
    "",
    "**Start:**",
    "• `!rps [num_rounds] [@opponent]`",
    "  – `num_rounds` is **FIRST TO N WINS** (default `1`).",
    "  – Solo: `!rps 3` (you vs bot, first to 3 wins)",
    "  – PvP: `!rps 5 @user` (first to 5 wins)",
    "",
    "**Play:**",
    "• Click **Rock / Paper / Scissors** buttons to lock in your choice (private).",
    "• If both choose the same, it’s a **tie** and the round restarts.",
    "• **30s timer** each round — if you don’t pick, you forfeit the round.",
    "",
    "**Cancel:**",
    "• `!rpscancel` — admin or game creator only"
  ].join("\n");
}

function parseMentionIdsInOrder(text) {
  const s = String(text ?? "");
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(s)) !== null) ids.push(m[1]);
  return ids;
}

function isValidInt(n) {
  return Number.isFinite(n) && Number.isInteger(n);
}

function clampWins(n) {
  if (!isValidInt(n) || n <= 0) return null;
  if (n > 50) return null; // keep it sane
  return n;
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function nowMs() {
  return Date.now();
}

function msLeft(st) {
  return Math.max(0, st.deadlineMs - nowMs());
}

function fmtSeconds(ms) {
  return `${Math.ceil(ms / 1000)}s`;
}

function canManage(message, st) {
  if (!st) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === st.creatorId;
}

function inSameChannel(msgOrInteraction, st) {
  const guildId = msgOrInteraction.guildId || msgOrInteraction.guild?.id;
  const channelId = msgOrInteraction.channelId || msgOrInteraction.channel?.id;
  if (!guildId || !channelId) return false;
  return guildId === st.guildId && channelId === st.channelId;
}

function mkButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("rps:rock")
      .setLabel("Rock")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("rps:paper")
      .setLabel("Paper")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("rps:scissors")
      .setLabel("Scissors")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function playerTag(id) {
  return `<@${id}>`;
}

function lockLine(st) {
  const p1Locked = st.p1Choice ? "✅ locked" : "⏳ waiting";
  const p2Locked = st.mode === "solo" ? "🤖 ready" : st.p2Choice ? "✅ locked" : "⏳ waiting";
  const p2Name = st.mode === "solo" ? "Bot" : playerTag(st.p2Id);

  return `${playerTag(st.p1Id)}: ${p1Locked}  |  ${p2Name}: ${p2Locked}`;
}

function scoreLine(st) {
  const p2Name = st.mode === "solo" ? "Bot" : playerTag(st.p2Id);
  return `Score (first to **${st.targetWins}**): ${playerTag(st.p1Id)} **${st.score.p1}** — **${st.score.p2}** ${p2Name}`;
}

function headerLine(st) {
  const p2Name = st.mode === "solo" ? "🤖 Bot" : playerTag(st.p2Id);
  return `🪨📄✂️ **RPS** — ${playerTag(st.p1Id)} vs ${p2Name}`;
}

function roundLine(st) {
  // Round counter increments only on decisive (non-tie) rounds
  return `Round: **${st.roundNumber}**  |  Time left: **${fmtSeconds(msLeft(st))}**`;
}

function buildStatusText(st) {
  return [headerLine(st), scoreLine(st), roundLine(st), "", lockLine(st), "", "Pick your move:"].join("\n");
}

function outcome(p1, p2) {
  // returns: 0 tie, 1 p1 wins, 2 p2 wins
  if (p1 === p2) return 0;
  if (
    (p1 === "rock" && p2 === "scissors") ||
    (p1 === "paper" && p2 === "rock") ||
    (p1 === "scissors" && p2 === "paper")
  ) return 1;
  return 2;
}

function pretty(choice) {
  return choice === "rock" ? "Rock" : choice === "paper" ? "Paper" : "Scissors";
}

async function safeEditGameMessage(st, payload) {
  try {
    const ch = st.client?.channels?.cache?.get(st.channelId);
    if (!ch) return false;
    const msg = await ch.messages.fetch(st.messageId);
    if (!msg) return false;
    await msg.edit(payload);
    return true;
  } catch {
    return false;
  }
}

function clearTimers(st) {
  if (st.timer) clearTimeout(st.timer);
  if (st.warnTimer) clearTimeout(st.warnTimer);
  st.timer = null;
  st.warnTimer = null;
}

async function endGame(st, finalText) {
  clearTimers(st);
  ACTIVE.delete(st.guildId);
  await safeEditGameMessage(st, {
    content: finalText,
    components: [mkButtons(true)]
  });
}

function resetRound(st) {
  st.p1Choice = null;
  st.p2Choice = null;
  st.deadlineMs = nowMs() + 30_000;
}

function scheduleTimers(st) {
  clearTimers(st);

  // warning at ~10s left (20s after start), only if someone hasn't picked
  st.warnTimer = setTimeout(async () => {
    const live = ACTIVE.get(st.guildId);
    if (!live) return;
    if (!live.p1Choice || (live.mode === "pvp" && !live.p2Choice)) {
      // lightweight reminder; avoid spamming the channel repeatedly
      await safeEditGameMessage(live, {
        content: buildStatusText(live) + `\n\n⚠️ **Reminder:** ${fmtSeconds(msLeft(live))} remaining!`,
        components: [mkButtons(false)]
      });
    }
  }, 20_000);

  // hard deadline
  st.timer = setTimeout(async () => {
    const live = ACTIVE.get(st.guildId);
    if (!live) return;

    // Determine forfeits
    const p1Missing = !live.p1Choice;
    const p2Missing = live.mode === "pvp" ? !live.p2Choice : false;

    if (!p1Missing && !p2Missing) return; // already resolved elsewhere

    // If both missing in PvP, treat as tie redo (keeps it fair)
    if (live.mode === "pvp" && p1Missing && p2Missing) {
      resetRound(live);
      scheduleTimers(live);
      await safeEditGameMessage(live, {
        content: buildStatusText(live) + "\n\n⏱️ Both players missed the timer — round restarted.",
        components: [mkButtons(false)]
      });
      return;
    }

    // Otherwise, the missing player forfeits this round
    let forfeiter;
    if (p1Missing) forfeiter = "p1";
    else forfeiter = "p2"; // in solo mode, p2Missing is false so forfeiter won't be p2

    if (forfeiter === "p1") live.score.p2 += 1;
    else live.score.p1 += 1;

    live.roundNumber += 1;

    const p2Name = live.mode === "solo" ? "Bot" : playerTag(live.p2Id);
    const loserName = forfeiter === "p1" ? playerTag(live.p1Id) : p2Name;
    const winnerName = forfeiter === "p1" ? p2Name : playerTag(live.p1Id);

    // Check win condition
    if (live.score.p1 >= live.targetWins || live.score.p2 >= live.targetWins) {
      const winner =
        live.score.p1 >= live.targetWins ? playerTag(live.p1Id) : p2Name;
      await endGame(
        live,
        [
          "🏁 **RPS finished**",
          headerLine(live),
          scoreLine(live),
          "",
          `⏱️ ${loserName} did not pick in time — **forfeit**. ${winnerName} wins the round.`,
          "",
          `🏆 Winner: ${winner}`
        ].join("\n")
      );
      return;
    }

    // Continue to next round
    resetRound(live);
    scheduleTimers(live);
    await safeEditGameMessage(live, {
      content:
        [
          "⏱️ **Round forfeited**",
          headerLine(live),
          scoreLine(live),
          "",
          `${loserName} did not pick in time — ${winnerName} wins this round.`,
          "",
          buildStatusText(live)
        ].join("\n"),
      components: [mkButtons(false)]
    });
  }, 30_000);
}

async function resolveIfReady(st) {
  // In solo mode, bot picks only when player locks in.
  if (!st.p1Choice) return;

  if (st.mode === "solo") {
    st.p2Choice = randChoice(CHOICES);
  } else {
    if (!st.p2Choice) return;
  }

  // Both choices set -> resolve
  const p1 = st.p1Choice;
  const p2 = st.p2Choice;

  const result = outcome(p1, p2);

  // Tie: redo (no score change)
  if (result === 0) {
    resetRound(st);
    scheduleTimers(st);
    await safeEditGameMessage(st, {
      content:
        [
          "🤝 **Tie!** Round restarted.",
          headerLine(st),
          scoreLine(st),
          "",
          `Both chose **${pretty(p1)}**.`,
          "",
          buildStatusText(st)
        ].join("\n"),
      components: [mkButtons(false)]
    });
    return;
  }

  // Decisive: update score
  const p2Name = st.mode === "solo" ? "Bot" : playerTag(st.p2Id);
  const winner = result === 1 ? playerTag(st.p1Id) : p2Name;
  const loser = result === 1 ? p2Name : playerTag(st.p1Id);

  if (result === 1) st.score.p1 += 1;
  else st.score.p2 += 1;

  st.roundNumber += 1;

  // Check match win
  if (st.score.p1 >= st.targetWins || st.score.p2 >= st.targetWins) {
    await endGame(
      st,
      [
        "🏁 **RPS finished**",
        headerLine(st),
        scoreLine(st),
        "",
        `Reveal: ${playerTag(st.p1Id)} chose **${pretty(p1)}** — ${p2Name} chose **${pretty(p2)}**`,
        `✅ Round winner: ${winner}`,
        "",
        `🏆 Winner: ${winner}`
      ].join("\n")
    );
    return;
  }

  // Continue match
  resetRound(st);
  scheduleTimers(st);
  await safeEditGameMessage(st, {
    content:
      [
        "✅ **Round resolved**",
        headerLine(st),
        scoreLine(st),
        "",
        `Reveal: ${playerTag(st.p1Id)} chose **${pretty(p1)}** — ${p2Name} chose **${pretty(p2)}**`,
        `Winner: ${winner}  |  Loser: ${loser}`,
        "",
        buildStatusText(st)
      ].join("\n"),
    components: [mkButtons(false)]
  });
}

// ---------- Registration ----------

export function registerRPS(register) {
  // !rps
  register(
    "!rps",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      const guildId = message.guildId;

      const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && tokens[0].toLowerCase() === "help") {
        await message.reply(rpsHelp());
        return;
      }

      if (ACTIVE.has(guildId)) {
        const st = ACTIVE.get(guildId);
        await message.reply(`⚠️ RPS is already running in <#${st.channelId}>.`);
        return;
      }

      const mentionIds = parseMentionIdsInOrder(rest);
      const hasOpponent = mentionIds.length > 0;

      // Parse num_rounds:
      // Accept first token as number if it looks like one, regardless of whether an opponent is present.
      let targetWins = 1;
      if (tokens[0] && /^\d+$/.test(tokens[0])) {
        const n = clampWins(Number(tokens[0]));
        if (!n) {
          await message.reply("❌ `num_rounds` must be a positive integer (1–50).");
          return;
        }
        targetWins = n;
      } else if (tokens[0] && !hasOpponent) {
        // They typed something non-numeric with no opponent
        await message.reply("❌ Invalid input. Try `!rpshelp`.");
        return;
      }

      let mode = "solo";
      let p2Id = null;

      if (hasOpponent) {
        mode = "pvp";
        const id = mentionIds[0];
        const u = message.mentions?.users?.get(id);
        if (!u) {
          await message.reply("❌ Invalid opponent mention. Please re-tag the user.");
          return;
        }
        if (u.bot) {
          await message.reply("❌ You can’t challenge a bot.");
          return;
        }
        if (u.id === message.author.id) {
          await message.reply("❌ You can’t challenge yourself.");
          return;
        }
        p2Id = u.id;
      }

      const st = {
        guildId,
        channelId: message.channelId,
        creatorId: message.author.id,
        client: message.client,

        mode,
        p1Id: message.author.id,
        p2Id,

        targetWins,
        score: { p1: 0, p2: 0 },
        roundNumber: 1,

        p1Choice: null,
        p2Choice: null,

        deadlineMs: nowMs() + 30_000,
        timer: null,
        warnTimer: null,

        messageId: null
      };

      const sent = await message.channel.send({
        content: buildStatusText(st),
        components: [mkButtons(false)]
      });

      st.messageId = sent.id;
      ACTIVE.set(guildId, st);

      scheduleTimers(st);
    },
    "!rps [num_rounds] [@opponent] — Rock Paper Scissors (first to N wins). `!rpshelp`."
  );

  // !rpshelp
  register(
    "!rpshelp",
    async ({ message }) => {
      await message.reply(rpsHelp());
    },
    "!rpshelp — shows Rock Paper Scissors help"
  );

  // !rpscancel
  register(
    "!rpscancel",
    async ({ message }) => {
      if (!message.guildId) return;

      const st = ACTIVE.get(message.guildId);
      if (!st) {
        await message.reply("No active RPS game to cancel.");
        return;
      }

      if (!inSameChannel(message, st)) {
        await message.reply(`RPS is running in <#${st.channelId}>.`);
        return;
      }

      if (!canManage(message, st)) {
        await message.reply("Nope — only admins or the game creator can cancel.");
        return;
      }

      await endGame(st, `🛑 **RPS cancelled** by ${playerTag(message.author.id)}.`);
    },
    "!rpscancel — cancels RPS (admin or creator)",
    { admin: true }
  );

  // Buttons
  register.component("rps:", async ({ interaction }) => {
    if (!interaction?.guildId) return;

    const st = ACTIVE.get(interaction.guildId);
    if (!st) {
      try {
        await interaction.reply({ content: "No active RPS game.", ephemeral: true });
      } catch {}
      return;
    }

    if (!inSameChannel(interaction, st)) {
      try {
        await interaction.reply({ content: `RPS is running in <#${st.channelId}>.`, ephemeral: true });
      } catch {}
      return;
    }

    // Must be one of the allowed players
    const uid = interaction.user?.id;
    const isP1 = uid === st.p1Id;
    const isP2 = st.mode === "pvp" && uid === st.p2Id;

    if (!isP1 && !isP2) {
      try {
        await interaction.reply({ content: "Only the players in this match can use these buttons.", ephemeral: true });
      } catch {}
      return;
    }

    // Ensure clicks are on the current game message
    if (st.messageId && interaction.message?.id && interaction.message.id !== st.messageId) {
      try {
        await interaction.reply({ content: "These buttons aren’t for the current game message.", ephemeral: true });
      } catch {}
      return;
    }

    const cid = String(interaction.customId || "");
    const pick =
      cid === "rps:rock" ? "rock" :
      cid === "rps:paper" ? "paper" :
      cid === "rps:scissors" ? "scissors" :
      null;

    if (!pick) {
      try {
        await interaction.reply({ content: "Unknown choice.", ephemeral: true });
      } catch {}
      return;
    }

    // Lock the choice
    if (isP1) {
      st.p1Choice = pick;
    } else if (isP2) {
      st.p2Choice = pick;
    }

    // Ephemeral ack
    try {
      await interaction.reply({ content: `✅ Choice locked in: **${pretty(pick)}**`, ephemeral: true });
    } catch {
      // if reply fails (already replied), ignore
    }

    // Update public message to show lock status (not choices)
    await safeEditGameMessage(st, {
      content: buildStatusText(st),
      components: [mkButtons(false)]
    });

    // Resolve if both ready (or solo ready)
    await resolveIfReady(st);
  });
}
