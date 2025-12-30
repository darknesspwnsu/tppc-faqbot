// games/pokemon_unscramble.js
//
// Pokemon Unscramble:
// - One game active per guild, restricted to start channel
// - Start via !pokeunscramble (mentions or reaction join) or /pokeunscramble (reaction join)
// - Fixed number of rounds (default 1)
// - Optional time limit per round
// - Word list provided by host (slash modal or list= on message command)

import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from "discord.js";
import {
  collectEntrantsByReactionsWithMax,
  createGameManager,
  makeGameQoL,
  mention,
  nowMs,
  parseDurationSeconds,
  reply,
  requireSameChannel,
  shuffleInPlace,
  withGameSubcommands,
} from "./framework.js";
import { getMentionedUsers, validateJoinAndMaxForMode } from "./helpers.js";

const manager = createGameManager({ id: "pokemon_unscramble", prettyName: "Pokemon Unscramble", scope: "guild" });

const DEFAULT_TIME_SEC = 20;
const DEFAULT_JOIN_SEC = 15;

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
    "**Start (mentions):**",
    "• `!pokeunscramble list=PIKACHU,EEVEE @user1 @user2 ...`",
    "",
    "**Start (reaction join):**",
    "• `!pokeunscramble list=PIKACHU,EEVEE join=20 [max=8]`",
    "• `/pokeunscramble` (opens a modal for the word list)",
    "",
    "**Options:**",
    "• `time=NN` — round time limit in seconds (default 20)",
    "• `rounds=NN` — number of rounds (default 1)",
    "• `join=NN` / `max=NN` — reaction join only",
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
    "• The game ends after the configured number of rounds.",
  ].join("\n");
}

const HELP_TEXT = makeHelpText();
const RULES_TEXT = makeRulesText();

function parseOptions(tokens) {
  const opts = {
    timeSeconds: null,
    joinSeconds: null,
    maxPlayers: null,
    roundsTarget: null,
    listRaw: null,
  };

  for (const t of tokens) {
    const s = String(t ?? "").trim();
    if (!s) continue;

    if (s.startsWith("time=")) {
      const raw = s.slice(5);
      const sec = parseDurationSeconds(raw, null);
      if (sec != null) opts.timeSeconds = sec;
      continue;
    }

    if (s.startsWith("join=")) {
      const raw = s.slice(5);
      const sec = parseDurationSeconds(raw, null);
      if (sec != null) opts.joinSeconds = sec;
      continue;
    }

    if (s.startsWith("max=")) {
      const raw = s.slice(4);
      const n = Number(raw);
      if (Number.isFinite(n)) opts.maxPlayers = n;
      continue;
    }

    if (s.startsWith("rounds=")) {
      const raw = s.slice(7);
      const n = Number(raw);
      if (Number.isFinite(n)) opts.roundsTarget = n;
      continue;
    }

    if (s.startsWith("list=")) {
      opts.listRaw = s.slice(5);
      continue;
    }

    if (/^\d+$/.test(s) && opts.timeSeconds == null) {
      opts.timeSeconds = Number(s);
    }
  }

  return opts;
}

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
  st.timers.setTimeout(async () => {
    const live = manager.getState({ guildId: st.guildId });
    if (!live) return;
    await startRound(live, channel);
  }, 2000);
}

function buildStartState({ guildId, channelId, creatorId, players, timeLimitSec, roundsTarget, wordList, client }) {
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
  };
}

function buildWordListFromOptions(listRaw) {
  const words = parseWordList(listRaw);
  return words.length ? words : null;
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

        const existing = manager.getState({ guildId: message.guild.id });
        if (existing) {
          await message.reply(`⚠️ Pokemon Unscramble is already running in <#${existing.channelId}>.`);
          return;
        }

        const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
        const opts = parseOptions(tokens);
        const timeLimitSec = opts.timeSeconds ?? DEFAULT_TIME_SEC;

        if (!Number.isFinite(timeLimitSec) || timeLimitSec < 5 || timeLimitSec > 120) {
          await message.reply("❌ `time=` must be between 5 and 120 seconds.");
          return;
        }

        const wordList = buildWordListFromOptions(opts.listRaw);
        if (!wordList) {
          await message.reply("❌ Provide a word list with `list=` or use `/pokeunscramble`.");
          return;
        }

        const targets = validateTargets(opts.roundsTarget, wordList);
        if (!targets.ok) {
          await message.reply(targets.err);
          return;
        }

        const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
        const joinCheck = validateJoinAndMaxForMode({
          hasMentions,
          joinSeconds: opts.joinSeconds,
          maxPlayers: opts.maxPlayers,
          defaultJoinSeconds: DEFAULT_JOIN_SEC,
          joinMin: 5,
          joinMax: 120,
          maxMin: 1,
          maxMax: 50,
          mentionErrorText: "❌ `join=` and `max=` are only valid for reaction-join (no @mentions).",
          joinErrorText: "❌ `join=` must be between 5 and 120 seconds.",
          maxErrorText: "❌ `max=` must be between 1 and 50.",
        });
        if (!joinCheck.ok) {
          await message.reply(joinCheck.err);
          return;
        }

        if (!hasMentions) {
          const joinSeconds = joinCheck.joinSeconds ?? DEFAULT_JOIN_SEC;
          const { entrants } = await collectEntrantsByReactionsWithMax({
            channel: message.channel,
            promptText: `🧩 **Pokemon Unscramble** — react ✅ to join! (join window: ${joinSeconds}s)`,
            durationMs: joinSeconds * 1000,
            maxEntrants: joinCheck.maxPlayers ?? null,
            emoji: "✅",
            dispose: true,
            trackRemovals: true,
          });

          if (!entrants.size) {
            await message.channel.send("❌ No players joined.");
            return;
          }

          const players = [...entrants].filter(Boolean);
          const res = manager.tryStart(
            { guildId: message.guild.id },
            buildStartState({
              guildId: message.guild.id,
              channelId: message.channelId,
              creatorId: message.author?.id || null,
              players,
              timeLimitSec,
              roundsTarget: targets.roundsTarget,
              wordList,
              client: message.client,
            })
          );

          if (!res.ok) {
            await message.reply(res.errorText);
            return;
          }

          await message.channel.send(
            `✅ **Pokemon Unscramble started!**\n` +
              `Players: ${players.map(mention).join(", ")}\n` +
              `Rounds: **${targets.roundsTarget}**\n` +
              `Time limit: **${timeLimitSec}s**`
          );

          await startRound(res.state, message.channel);
          return;
        }

        const mentioned = getMentionedUsers(message);
        const players = mentioned.filter((u) => u?.id && !u.bot).map((u) => u.id);
        if (!players.length) {
          await message.reply("❌ You need to mention at least one player.");
          return;
        }

        const res = manager.tryStart(
          { guildId: message.guild.id },
          buildStartState({
            guildId: message.guild.id,
            channelId: message.channelId,
            creatorId: message.author?.id || null,
            players,
            timeLimitSec,
            roundsTarget: targets.roundsTarget,
            wordList,
            client: message.client,
          })
        );

        if (!res.ok) {
          await message.reply(res.errorText);
          return;
        }

        await message.channel.send(
          `✅ **Pokemon Unscramble started!**\n` +
            `Players: ${players.map(mention).join(", ")}\n` +
            `Rounds: **${targets.roundsTarget}**\n` +
            `Time limit: **${timeLimitSec}s**`
        );

        await startRound(res.state, message.channel);
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

    await channel.send(
      `✅ **Pokemon Unscramble started!**\n` +
        `Players: ${players.map(mention).join(", ")}\n` +
        `Rounds: **${pending.opts.roundsTarget}**\n` +
        `Time limit: **${pending.opts.timeLimitSec}s**`
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

    if (!(await requireSameChannel({ message }, st, manager))) return;
    if (!st.roundActive) return;

    const uid = message.author.id;
    if (!st.players.includes(uid)) return;

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
  parseOptions,
  validateTargets,
  parseWordList,
};
