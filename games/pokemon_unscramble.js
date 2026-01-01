// games/pokemon_unscramble.js
//
// Pokemon Unscramble:
// - One game active per guild, restricted to start channel
// - Start via /pokeunscramble (reaction join)
// - Fixed number of rounds (default 1)
// - Optional time limit per round
// - Word list provided by host (slash modal or list= on message command)

import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from "discord.js";
import {
  collectEntrantsByReactionsWithMax,
  assignContestRoleForEntrants,
  createGameManager,
  makeGameQoL,
  mention,
  nowMs,
  requireSameChannel,
  scheduleRoundCooldown,
  shuffleInPlace,
  withGameSubcommands,
} from "./framework.js";
import { validateJoinAndMaxForMode } from "./helpers.js";

const manager = createGameManager({ id: "pokemon_unscramble", prettyName: "Pokemon Unscramble", scope: "guild" });

const DEFAULT_TIME_SEC = 20;
const DEFAULT_JOIN_SEC = 15;
const DEFAULT_ROUND_COOLDOWN_MS = 5000;

const PENDING_MODAL = new Map(); // customId -> { guildId, channelId, hostId, opts }

function normalizeGuess(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function scrambleWord(word) {
  const letters = String(word ?? "").split("");
  if (letters.length <= 1) return word;

  let out = letters.join("");
  for (let i = 0; i < 10 && out === word; i++) {
    shuffleInPlace(letters);
    out = letters.join("");
  }
  return out;
}

function parseWordList(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const parts = text.split(/[\n,]+/g).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const norm = normalizeGuess(p);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function makeHelpText() {
  return [
    "**Pokemon Unscramble — Help**",
    "",
    "**Start:**",
    "• `/pokeunscramble` (opens a modal for the word list)",
    "",
    "**Options (slash):**",
    "• `time` — round time limit in seconds (default 20)",
    "• `rounds` — number of rounds (default 1)",
    "• `uniquewinners` — winners can only win one round",
    "• `join` / `max` — reaction join options",
    "",
    "**Play:**",
    "• Unscramble the Pokemon name and type it in chat.",
    "• Answers are case-insensitive and ignore spaces/punctuation.",
    "",
    "Tip: `!pokeunscramble help` and `!pokeunscramble rules` also work.",
  ].join("\n");
}

function makeRulesText() {
  return [
    "**Pokemon Unscramble — Rules (layman)**",
    "",
    "The host provides a list of Pokemon names.",
    "Each round, the bot scrambles a name.",
    "Players race to type the correct answer.",
    "",
    "• First correct answer wins the round.",
    "• Unique winners mode: a player can only win once.",
    "• The game ends after the configured number of rounds.",
  ].join("\n");
}

const HELP_TEXT = makeHelpText();
const RULES_TEXT = makeRulesText();


function validateTargets(roundsTarget, wordList) {
  const rounds = Number(roundsTarget ?? 1);
  if (!Number.isFinite(rounds) || rounds <= 0 || rounds > 50) {
    return { ok: false, err: "❌ `rounds=` must be a positive integer (1–50)." };
  }

  if (wordList && wordList.length < rounds) {
    return { ok: false, err: "❌ Word list must have at least as many entries as rounds." };
  }

  return { ok: true, roundsTarget: rounds };
}

function renderStatus(st) {
  const timeLeft =
    st.roundDeadlineMs && st.roundActive ? Math.max(0, Math.ceil((st.roundDeadlineMs - nowMs()) / 1000)) : null;

  const scoreLines = st.players.map((id) => `${mention(id)}: **${st.scores.get(id) || 0}**`);

  return [
    "🧩 **Pokemon Unscramble**",
    `Rounds: **${st.roundNumber} / ${st.roundsTarget}**`,
    timeLeft != null ? `Time left: **${timeLeft}s**` : `Time limit: **${st.timeLimitSec}s**`,
    "",
    `Scramble: **${st.currentScramble || "(none)"}**`,
    "",
    "Scores:",
    scoreLines.join("\n") || "(none)",
  ].join("\n");
}

async function endGame(st, channel) {
  manager.stop({ guildId: st.guildId });

  const lines = [];
  lines.push("🏁 **Pokemon Unscramble finished**");
  lines.push("");
  lines.push("Round results:");
  for (const r of st.roundResults) {
    const winnerLine = r.winnerId ? mention(r.winnerId) : "(no winner)";
    lines.push(`• Round ${r.round}: ${winnerLine} — **${r.word}**`);
  }

  await channel.send(lines.join("\n"));
}

async function startRound(st, channel) {
  st.timers.clearAll();
  st.roundActive = true;
  st.roundWinTimestamp = null;
  st.roundWinnerId = null;

  const nextWord = st.wordQueue.shift();
  st.currentWord = nextWord;
  st.currentScramble = scrambleWord(nextWord);
  st.roundDeadlineMs = nowMs() + st.timeLimitSec * 1000;

  await channel.send(
    `🧩 **Round ${st.roundNumber}** — Unscramble this Pokemon:\n` +
      `**${st.currentScramble}**\n` +
      `⏱️ Time limit: **${st.timeLimitSec}s**`
  );

  st.timers.setTimeout(async () => {
    const live = manager.getState({ guildId: st.guildId });
    if (!live || !live.roundActive) return;

    await finalizeRound(live, channel, null);
  }, st.timeLimitSec * 1000);
}

async function finalizeRound(st, channel, winnerId) {
  if (!st.roundActive) return;
  st.roundActive = false;
  st.timers.clearAll();

  if (winnerId) {
    st.scores.set(winnerId, (st.scores.get(winnerId) || 0) + 1);
    if (st.uniqueWinners) {
      st.roundWinners.add(winnerId);
    }
  }

  st.roundResults.push({
    round: st.roundNumber,
    word: st.currentWord,
    winnerId,
  });

  if (winnerId) {
    await channel.send(`✅ **Correct!** ${mention(winnerId)} guessed **${st.currentWord}**.`);
  } else {
    await channel.send(`⏱️ Time! No one guessed **${st.currentWord}**.`);
  }

  if (st.roundNumber >= st.roundsTarget) {
    await endGame(st, channel);
    return;
  }

  st.roundNumber += 1;
  const cooldownSec = Math.max(1, Math.round(DEFAULT_ROUND_COOLDOWN_MS / 1000));
  await scheduleRoundCooldown({
    state: st,
    manager,
    channel,
    delayMs: DEFAULT_ROUND_COOLDOWN_MS,
    message: `⏳ Next round in **${cooldownSec} seconds**...`,
    onStart: async (live) => {
      await startRound(live, channel);
    },
  });
}

function buildStartState({
  guildId,
  channelId,
  creatorId,
  players,
  timeLimitSec,
  roundsTarget,
  wordList,
  client,
  uniqueWinners,
}) {
  const scores = new Map();
  for (const id of players) scores.set(id, 0);

  return {
    guildId,
    channelId,
    client,
    creatorId,
    players,
    scores,
    timeLimitSec,
    roundsTarget,
    wordList,
    wordQueue: shuffleInPlace([...wordList]),
    roundNumber: 1,
    roundActive: false,
    roundDeadlineMs: null,
    roundWinTimestamp: null,
    roundWinnerId: null,
    roundResults: [],
    currentWord: null,
    currentScramble: null,
    uniqueWinners: Boolean(uniqueWinners),
    roundWinners: new Set(),
  };
}

function isMessageInGameChannel(st, message) {
  const channelId = message?.channelId || message?.channel?.id;
  if (!st?.channelId) return true;
  return st.channelId === channelId;
}

function shouldIgnoreGuess(st, userId) {
  if (!st.players.includes(userId)) return true;
  if (st.uniqueWinners && st.roundWinners?.has(userId)) return true;
  return false;
}


export function registerPokemonUnscramble(register) {
  makeGameQoL(register, {
    manager,
    id: "pokeunscramble",
    prettyName: "Pokemon Unscramble",
    helpText: HELP_TEXT,
    rulesText: RULES_TEXT,
    renderStatus,
    cancel: async (st) => {
      const channel = st?.client?.channels?.cache?.get?.(st.channelId);
      manager.stop({ guildId: st.guildId });
      if (channel?.send) await channel.send("🛑 Pokemon Unscramble cancelled.");
    },
  });

  register(
    "!pokeunscramble",
    withGameSubcommands({
      helpText: HELP_TEXT,
      rulesText: RULES_TEXT,
      onStart: async ({ message, rest }) => {
        if (!message.guild) return;
        await message.reply("Start Pokemon Unscramble with the slash command: `/pokeunscramble`.");
      },
    }),
    "!pokeunscramble [options] [@players] — start Pokemon Unscramble",
    { helpTier: "primary", aliases: ["!pokescramble", "!punscramble"] }
  );

  register.slash(
    {
      name: "pokeunscramble",
      description: "Start Pokemon Unscramble (reaction join).",
      options: [
        { type: 4, name: "time", description: "Round time limit in seconds (5–120).", required: false },
        { type: 4, name: "rounds", description: "Number of rounds (1–50).", required: false },
        { type: 4, name: "join", description: "Join window seconds (5–120).", required: false },
        { type: 4, name: "max", description: "Max players (1–50).", required: false },
        { type: 5, name: "uniquewinners", description: "Winners can only win one round.", required: false },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Use this in a server." });
        return;
      }

      const existing = manager.getState({ guildId });
      if (existing) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `⚠️ Pokemon Unscramble is already running in <#${existing.channelId}>.`,
        });
        return;
      }

      const channel = interaction.channel;
      if (!channel?.send) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Could not access this channel." });
        return;
      }

      const timeOpt = interaction.options?.getInteger?.("time");
      const roundsOpt = interaction.options?.getInteger?.("rounds");
      const joinOpt = interaction.options?.getInteger?.("join");
      const maxOpt = interaction.options?.getInteger?.("max");
      const uniqueOpt = interaction.options?.getBoolean?.("uniquewinners");

      const timeLimitSec = Number.isFinite(timeOpt) ? timeOpt : DEFAULT_TIME_SEC;
      if (!(timeLimitSec >= 5 && timeLimitSec <= 120)) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ `time` must be 5–120 seconds." });
        return;
      }

      const targets = validateTargets(roundsOpt, null);
      if (!targets.ok) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: targets.err });
        return;
      }

      const joinCheck = validateJoinAndMaxForMode({
        hasMentions: false,
        joinSeconds: joinOpt,
        maxPlayers: maxOpt,
        defaultJoinSeconds: DEFAULT_JOIN_SEC,
        joinMin: 5,
        joinMax: 120,
        maxMin: 1,
        maxMax: 50,
        mentionErrorText: null,
        joinErrorText: "❌ `join` must be 5–120 seconds.",
        maxErrorText: "❌ `max` must be 1–50.",
      });
      if (!joinCheck.ok) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: joinCheck.err });
        return;
      }

      const modalId = `pokeunscramble:setup:${interaction.id}`;
      PENDING_MODAL.set(modalId, {
        guildId,
        channelId: channel.id,
        hostId: interaction.user?.id || null,
        opts: {
          timeLimitSec,
          roundsTarget: targets.roundsTarget,
          joinSeconds: joinCheck.joinSeconds ?? DEFAULT_JOIN_SEC,
          maxPlayers: joinCheck.maxPlayers ?? null,
          uniqueWinners: Boolean(uniqueOpt),
        },
      });

      const modal = new ModalBuilder().setCustomId(modalId).setTitle("Pokemon Unscramble Word List");
      const listInput = new TextInputBuilder()
        .setCustomId("words")
        .setLabel("Word list (one per line or comma-separated)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(listInput));

      await interaction.showModal(modal);
    }
  );

  register.component("pokeunscramble:setup:", async ({ interaction }) => {
    if (!interaction.isModalSubmit?.()) return;

    let acknowledged = false;
    try {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "✅ Starting join window...",
      });
      acknowledged = true;
    } catch {}

    const modalId = interaction.customId ? String(interaction.customId) : "";
    const pending = PENDING_MODAL.get(modalId);
    if (!pending) {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ This setup request expired." });
        } catch {}
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ This setup request expired." });
      }
      return;
    }

    PENDING_MODAL.delete(modalId);

    if (interaction.guildId !== pending.guildId) {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Wrong server." });
        } catch {}
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Wrong server." });
      }
      return;
    }

    const wordRaw = interaction.fields?.getTextInputValue?.("words") ?? "";
    const wordList = parseWordList(wordRaw);
    if (!wordList.length) {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Word list must include at least one name." });
        } catch {}
      } else {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Word list must include at least one name." });
      }
      return;
    }

    if (wordList.length < pending.opts.roundsTarget) {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Word list must have at least as many entries as rounds." });
        } catch {}
      } else {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Word list must have at least as many entries as rounds.",
        });
      }
      return;
    }

    const channel =
      interaction.client?.channels?.cache?.get?.(pending.channelId) ||
      (interaction.client?.channels?.fetch
        ? await interaction.client.channels.fetch(pending.channelId).catch(() => null)
        : null);

    if (!channel?.send) {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Missing access to the game channel." });
        } catch {}
      } else {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Missing access to the game channel.",
        });
      }
      return;
    }

    let entrants;
    try {
      ({ entrants } = await collectEntrantsByReactionsWithMax({
        channel,
        promptText: `🧩 **Pokemon Unscramble** — react ✅ to join! (join window: ${pending.opts.joinSeconds}s)`,
        durationMs: pending.opts.joinSeconds * 1000,
        maxEntrants: pending.opts.maxPlayers,
        emoji: "✅",
        dispose: true,
        trackRemovals: true,
      }));
    } catch {
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Could not start join window in this channel." });
        } catch {}
      } else {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Could not start join window in this channel.",
        });
      }
      return;
    }

    if (!entrants.size) {
      await channel.send("❌ No players joined.");
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ No players joined." });
        } catch {}
      }
      return;
    }

    const players = [...entrants].filter(Boolean);
    if (pending.opts.uniqueWinners && players.length <= pending.opts.roundsTarget) {
      await channel.send("❌ Unique winners mode needs more players than rounds.");
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Unique winners mode needs more players than rounds." });
        } catch {}
      } else {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Unique winners mode needs more players than rounds.",
        });
      }
      return;
    }
    const res = manager.tryStart(
      { guildId: pending.guildId },
      buildStartState({
        guildId: pending.guildId,
        channelId: pending.channelId,
        creatorId: pending.hostId,
        players,
        timeLimitSec: pending.opts.timeLimitSec,
        roundsTarget: pending.opts.roundsTarget,
        wordList,
        client: interaction.client,
        uniqueWinners: pending.opts.uniqueWinners,
      })
    );

    if (!res.ok) {
      await channel.send(res.errorText);
      if (acknowledged) {
        try {
          await interaction.editReply({ content: "❌ Could not start the game." });
        } catch {}
      }
      return;
    }

    const { assignment } = await assignContestRoleForEntrants({ interaction }, entrants);
    if (assignment) res.state.contestRoleAssignment = assignment;

    await channel.send(
      `✅ **Pokemon Unscramble started!**\n` +
        `Players: ${players.map(mention).join(", ")}\n` +
        `Rounds: **${pending.opts.roundsTarget}**\n` +
        `Time limit: **${pending.opts.timeLimitSec}s**\n` +
        `Unique winners: **${pending.opts.uniqueWinners ? "on" : "off"}**`
    );

    await startRound(res.state, channel);
    if (acknowledged) {
      try {
        await interaction.editReply({ content: "✅ Game started." });
      } catch {}
    } else {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "✅ Game started." });
    }
  });

  register.onMessage(async ({ message }) => {
    if (!message.guildId) return;
    if (message.author?.bot) return;

    const st = manager.getState({ message });
    if (!st) return;

    if (!isMessageInGameChannel(st, message)) return;
    if (!st.roundActive) return;

    const uid = message.author.id;
    if (shouldIgnoreGuess(st, uid)) return;
    if (st.uniqueWinners && st.roundWinners?.has(uid)) return;

    const guess = normalizeGuess(message.content);
    if (!guess) return;

    if (guess !== st.currentWord) return;

    if (st.roundWinTimestamp == null) {
      st.roundWinTimestamp = message.createdTimestamp;
      st.roundWinnerId = uid;
      st.timers.clearAll();

      st.timers.setTimeout(async () => {
        const live = manager.getState({ guildId: st.guildId });
        if (!live) return;
        await finalizeRound(live, message.channel, live.roundWinnerId);
      }, 100);
      return;
    }

    if (message.createdTimestamp < st.roundWinTimestamp) {
      st.roundWinTimestamp = message.createdTimestamp;
      st.roundWinnerId = uid;
    }
  });
}

export const __testables = {
  normalizeGuess,
  scrambleWord,
  validateTargets,
  parseWordList,
  buildStartState,
  isMessageInGameChannel,
  shouldIgnoreGuess,
};
