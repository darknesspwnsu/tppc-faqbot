// games/rps.js
//
// Rock Paper Scissors (RPS)

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  createBoard,
  createGameManager,
  guardBoardInteraction,
  makeGameQoL,
  parseMentionIdsInOrder,
  scheduleRoundCooldown,
  requireCanManage,
  requireSameChannel,
  withGameSubcommands,
} from "./framework.js";

const manager = createGameManager({ id: "rps", prettyName: "RPS", scope: "guild" });
const CHOICES = ["rock", "paper", "scissors"];
const DEFAULT_ROUND_COOLDOWN_MS = 3000;

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
    "• Ties restart the round.",
    "• **30s timer** each round — if you don’t pick, you forfeit the round.",
    "",
    "**Cancel:**",
    "• `!cancelrps` — admin or game creator only",
  ].join("\n");
}

function rpsRules() {
  return [
    "**RPS — Rules (layman)**",
    "",
    "Two players (or you vs bot) pick **Rock**, **Paper**, or **Scissors** each round.",
    "• Rock beats Scissors",
    "• Scissors beats Paper",
    "• Paper beats Rock",
    "",
    "If both pick the same, it’s a tie and the round restarts.",
    `First to **N wins** wins the match (default N = 1).`,
    "",
    "Each round has a **30s timer**. If you don’t pick in time, you forfeit that round.",
  ].join("\n");
}

const RPS_HELP = rpsHelp();
const RPS_RULES = rpsRules();

const isInt = (n) => Number.isFinite(n) && Number.isInteger(n);
const clampWins = (n) => (!isInt(n) || n <= 0 || n > 50 ? null : n);
const randChoice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pretty = (c) => (c === "rock" ? "Rock" : c === "paper" ? "Paper" : "Scissors");
const fmtSeconds = (ms) => `${Math.ceil(ms / 1000)}s`;
const msLeft = (st) => Math.max(0, (st.deadlineMs || 0) - Date.now());
const tag = (id) => `<@${id}>`;

function mkButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("rps:rock").setLabel("Rock").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId("rps:paper").setLabel("Paper").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("rps:scissors")
      .setLabel("Scissors")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function headerLine(st) {
  const p2 = st.mode === "solo" ? "🤖 Bot" : tag(st.p2Id);
  return `🪨📄✂️ **RPS** — ${tag(st.p1Id)} vs ${p2}`;
}

function scoreLine(st) {
  const p2 = st.mode === "solo" ? "Bot" : tag(st.p2Id);
  return `Score (first to **${st.targetWins}**): ${tag(st.p1Id)} **${st.score.p1}** — **${st.score.p2}** ${p2}`;
}

function lockLine(st) {
  const p1Locked = st.p1Choice ? "✅ locked" : "⏳ waiting";
  const p2Locked = st.mode === "solo" ? "🤖 ready" : st.p2Choice ? "✅ locked" : "⏳ waiting";
  const p2Name = st.mode === "solo" ? "Bot" : tag(st.p2Id);
  return `${tag(st.p1Id)}: ${p1Locked}  |  ${p2Name}: ${p2Locked}`;
}

function buildStatusText(st) {
  return [
    headerLine(st),
    scoreLine(st),
    `Round: **${st.roundNumber}**  |  Time left: **${fmtSeconds(msLeft(st))}**`,
    "",
    lockLine(st),
    "",
    "Pick your move:",
  ].join("\n");
}

function outcome(p1, p2) {
  if (p1 === p2) return 0;
  if (
    (p1 === "rock" && p2 === "scissors") ||
    (p1 === "paper" && p2 === "rock") ||
    (p1 === "scissors" && p2 === "paper")
  ) return 1;
  return 2;
}

function resetRound(st) {
  st.p1Choice = null;
  st.p2Choice = null;
  st.deadlineMs = Date.now() + 30_000;
}

async function endGame(st, board, finalText) {
  manager.stop({ guildId: st.guildId });
  await board.update({ content: finalText, components: [mkButtons(true)] });
}

function scheduleTimers(st, board) {
  st.timers?.clearAll?.();

  st.timers.setTimeout(async () => {
    const live = manager.getState({ guildId: st.guildId });
    if (!live) return;

    if (!live.p1Choice || (live.mode === "pvp" && !live.p2Choice)) {
      await board.update({
        content: buildStatusText(live) + `\n\n⚠️ **Reminder:** ${fmtSeconds(msLeft(live))} remaining!`,
        components: [mkButtons(false)],
      });
    }
  }, 20_000);

  st.timers.setTimeout(async () => {
    const live = manager.getState({ guildId: st.guildId });
    if (!live) return;

    const p1Missing = !live.p1Choice;
    const p2Missing = live.mode === "pvp" ? !live.p2Choice : false;
    if (!p1Missing && !p2Missing) return;

    if (live.mode === "pvp" && p1Missing && p2Missing) {
      resetRound(live);
      scheduleTimers(live, board);
      await board.update({
        content: buildStatusText(live) + "\n\n⏱️ Both players missed the timer — round restarted.",
        components: [mkButtons(false)],
      });
      return;
    }

    const forfeiter = p1Missing ? "p1" : "p2";
    if (forfeiter === "p1") live.score.p2 += 1;
    else live.score.p1 += 1;
    live.roundNumber += 1;

    const p2Name = live.mode === "solo" ? "Bot" : tag(live.p2Id);
    const loserName = forfeiter === "p1" ? tag(live.p1Id) : p2Name;
    const winnerName = forfeiter === "p1" ? p2Name : tag(live.p1Id);

    if (live.score.p1 >= live.targetWins || live.score.p2 >= live.targetWins) {
      const winner = live.score.p1 >= live.targetWins ? tag(live.p1Id) : p2Name;
      await endGame(
        live,
        board,
        [
          "🏁 **RPS finished**",
          headerLine(live),
          scoreLine(live),
          "",
          `⏱️ ${loserName} did not pick in time — **forfeit**. ${winnerName} wins the round.`,
          "",
          `🏆 Winner: ${winner}`,
        ].join("\n")
      );
      return;
    }

    resetRound(live);
    await board.update({
      content: [
        "⏱️ **Round forfeited**",
        headerLine(live),
        scoreLine(live),
        "",
        `${loserName} did not pick in time — ${winnerName} wins this round.`,
        "",
        buildStatusText(live),
      ].join("\n"),
      components: [mkButtons(false)],
    });

    const cooldownSec = Math.max(1, Math.round(DEFAULT_ROUND_COOLDOWN_MS / 1000));
    await scheduleRoundCooldown({
      state: live,
      manager,
      channel: board,
      delayMs: DEFAULT_ROUND_COOLDOWN_MS,
      message: `⏳ Next round in **${cooldownSec} seconds**...`,
      onStart: async (still) => {
        scheduleTimers(still, board);
        await board.update({ content: buildStatusText(still), components: [mkButtons(false)] });
      },
    });
  }, 30_000);
}

async function resolveIfReady(st, board) {
  if (!st.p1Choice) return;
  if (st.mode === "solo") st.p2Choice = randChoice(CHOICES);
  else if (!st.p2Choice) return;

  const p1 = st.p1Choice;
  const p2 = st.p2Choice;
  const result = outcome(p1, p2);

  if (result === 0) {
    resetRound(st);
    await board.update({
      content: [
        "🤝 **Tie!** Round restarted.",
        headerLine(st),
        scoreLine(st),
        "",
        `Both chose **${pretty(p1)}**.`,
        "",
        buildStatusText(st),
      ].join("\n"),
      components: [mkButtons(false)],
    });

    const cooldownSec = Math.max(1, Math.round(DEFAULT_ROUND_COOLDOWN_MS / 1000));
    await scheduleRoundCooldown({
      state: st,
      manager,
      channel: board,
      delayMs: DEFAULT_ROUND_COOLDOWN_MS,
      message: `⏳ Next round in **${cooldownSec} seconds**...`,
      onStart: async (live) => {
        scheduleTimers(live, board);
        await board.update({ content: buildStatusText(live), components: [mkButtons(false)] });
      },
    });
    return;
  }

  const p2Name = st.mode === "solo" ? "Bot" : tag(st.p2Id);
  const winner = result === 1 ? tag(st.p1Id) : p2Name;
  const loser = result === 1 ? p2Name : tag(st.p1Id);

  if (result === 1) st.score.p1 += 1;
  else st.score.p2 += 1;
  st.roundNumber += 1;

  if (st.score.p1 >= st.targetWins || st.score.p2 >= st.targetWins) {
    await endGame(
      st,
      board,
      [
        "🏁 **RPS finished**",
        headerLine(st),
        scoreLine(st),
        "",
        `Reveal: ${tag(st.p1Id)} chose **${pretty(p1)}** — ${p2Name} chose **${pretty(p2)}**`,
        `✅ Round winner: ${winner}`,
        "",
        `🏆 Winner: ${winner}`,
      ].join("\n")
    );
    return;
  }

  resetRound(st);
  await board.update({
    content: [
      "✅ **Round resolved**",
      headerLine(st),
      scoreLine(st),
      "",
      `Reveal: ${tag(st.p1Id)} chose **${pretty(p1)}** — ${p2Name} chose **${pretty(p2)}**`,
      `Winner: ${winner}  |  Loser: ${loser}`,
      "",
      buildStatusText(st),
    ].join("\n"),
    components: [mkButtons(false)],
  });

  const cooldownSec = Math.max(1, Math.round(DEFAULT_ROUND_COOLDOWN_MS / 1000));
  await scheduleRoundCooldown({
    state: st,
    manager,
    channel: board,
    delayMs: DEFAULT_ROUND_COOLDOWN_MS,
    message: `⏳ Next round in **${cooldownSec} seconds**...`,
    onStart: async (live) => {
      scheduleTimers(live, board);
      await board.update({ content: buildStatusText(live), components: [mkButtons(false)] });
    },
  });
}

export const __testables = {
  outcome,
  clampWins,
  pretty,
  fmtSeconds,
};

export function registerRPS(register) {
  makeGameQoL(register, {
    manager,
    id: "rps",
    prettyName: "RPS",
    helpText: RPS_HELP,
    rulesText: RPS_RULES,
    renderStatus: (st) => buildStatusText(st),
    cancel: async (st, { message }) => {
      const ok = await requireCanManage(
        { message },
        st,
        { ownerField: "creatorId", managerLabel: "RPS", deniedText: "Nope — only admins or the game creator can cancel." }
      );
      if (!ok) return;

      const board = createBoard(st);
      await endGame(st, board, `🛑 **RPS cancelled** by ${tag(message.author.id)}.`);
    },
  });

  // Back-compat alias for old cancel command
  register(
    "!rpscancel",
    async ({ message }) => {
      const st = manager.getState({ guildId: message.guildId, channelId: message.channelId });
      if (!st) return void (await message.reply(manager.noActiveText()));
      if (!(await requireSameChannel({ message }, st, manager))) return;

      const ok = await requireCanManage(
        { message },
        st,
        { ownerField: "creatorId", managerLabel: "RPS", deniedText: "Nope — only admins or the game creator can cancel." }
      );
      if (!ok) return;

      const board = createBoard(st);
      await endGame(st, board, `🛑 **RPS cancelled** by ${tag(message.author.id)}.`);
    },
    "!rpscancel — (alias) cancels RPS (admin or creator)",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!rps",
    withGameSubcommands({
      helpText: RPS_HELP,
      rulesText: RPS_RULES,
      onStart: async ({ message, rest }) => {
        if (!message.guildId) return;

        const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 1 && tokens[0].toLowerCase() === "help") return void (await message.reply(rpsHelp()));

        const res = manager.tryStart(
          { message, guildId: message.guildId, channelId: message.channelId },
          { guildId: message.guildId, channelId: message.channelId, creatorId: message.author.id, client: message.client }
        );
        if (!res.ok) return void (await message.reply(res.errorText));

        const st = res.state;
        const mentionIds = parseMentionIdsInOrder(rest);
        const hasOpponent = mentionIds.length > 0;

        let targetWins = 1;
        if (tokens[0] && /^\d+$/.test(tokens[0])) {
          const n = clampWins(Number(tokens[0]));
          if (!n) {
            manager.stop({ guildId: message.guildId });
            return void (await message.reply("❌ `num_rounds` must be a positive integer (1–50)."));
          }
          targetWins = n;
        } else if (tokens[0] && !hasOpponent) {
          manager.stop({ guildId: message.guildId });
          return void (await message.reply("❌ Invalid input. Try `!rpshelp`."));
        }

        let mode = "solo";
        let p2Id = null;

        if (hasOpponent) {
          mode = "pvp";
          const id = mentionIds[0];
          const u = message.mentions?.users?.get(id);
          if (!u || u.bot || u.id === message.author.id) {
            manager.stop({ guildId: message.guildId });
            return void (await message.reply("❌ Invalid opponent mention."));
          }
          p2Id = u.id;
        }

        Object.assign(st, {
          mode,
          p1Id: message.author.id,
          p2Id,
          targetWins,
          score: { p1: 0, p2: 0 },
          roundNumber: 1,
          p1Choice: null,
          p2Choice: null,
          deadlineMs: Date.now() + 30_000,
          messageId: null,
        });

        const board = createBoard(st);
        await board.post(message.channel, { content: buildStatusText(st), components: [mkButtons(false)] });

        resetRound(st);
        scheduleTimers(st, board);
      },
    }),
    "!rps [num_rounds] [@opponent] — Rock Paper Scissors (first to N wins). `!rpshelp`.",
    { helpTier: "primary" }
  );

  register.component("rps:", async ({ interaction }) => {
    if (!interaction?.guildId) return;

    const guarded = await guardBoardInteraction(interaction, { manager, messageIdField: "messageId" });
    if (!guarded) return;

    const { state: st, board } = guarded;

    const uid = interaction.user?.id;
    const isP1 = uid === st.p1Id;
    const isP2 = st.mode === "pvp" && uid === st.p2Id;
    if (!isP1 && !isP2) {
      try {
        await interaction.reply({ content: "Only the players in this match can use these buttons.", ephemeral: true });
      } catch {}
      return;
    }

    const cid = String(interaction.customId || "");
    const pick =
      cid === "rps:rock" ? "rock" : cid === "rps:paper" ? "paper" : cid === "rps:scissors" ? "scissors" : null;
    if (!pick) {
      try {
        await interaction.reply({ content: "Unknown choice.", ephemeral: true });
      } catch {}
      return;
    }

    if (isP1) st.p1Choice = pick;
    else st.p2Choice = pick;

    try {
      await interaction.reply({ content: `✅ Choice locked in: **${pretty(pick)}**`, ephemeral: true });
    } catch {}

    await board.update({ content: buildStatusText(st), components: [mkButtons(false)] });
    await resolveIfReady(st, board);
  });
}
