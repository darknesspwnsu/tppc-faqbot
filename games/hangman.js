// games/hangman.js
//
// Framework-aligned Hangman — FIXED TIMER BEHAVIOR
//
// Core behavior preserved:
// - Start via /hangman (word is private/ephemeral)
// - Join via ✅ reaction window
// - Randomly picks ONE player each turn; only that player’s message counts
// - Single letter or full word guess
// - Warn + skip timers; skip counts as a mistake
// - Max mistakes: 7
//
// Fixes:
// - ALL timers go through state.timers (TimerBag) so manager.stop() reliably cancels them.
// - On every turn start + every processed guess, we clear the TimerBag to prevent timer overlap.
//
// QoL:
// - !hangman help / !hangmanhelp
// - !hangman rules / !hangmanrules (layman text, distinct from help)
// - !hangman status / !hangmanstatus
// - !cancelhangman

import { MessageFlags } from "discord.js";
import {
  createGameManager,
  collectEntrantsByReactionsWithMax,
  makeGameQoL,
  reply,
  requireSameChannel,
  requireCanManage,
  withGameSubcommands,
} from "./framework.js";

const manager = createGameManager({ id: "hangman", prettyName: "Hangman", scope: "guild" });

const DEFAULTS = {
  joinSeconds: 15,
  turnWarn: 20, // seconds
  turnSkip: 30, // seconds
  maxMistakes: 7,
};

function hangmanHelpText() {
  return [
    "**Hangman — Help (commands & setup)**",
    "",
    "**Start (slash):**",
    "• `/hangman word:<secret> join:<seconds?> max:<players?>`",
    "  – The secret word is entered privately (ephemeral).",
    "  – Players join by reacting ✅ during the join window.",
    "",
    "**During play:**",
    "• The bot announces whose turn it is.",
    "• Only that player’s message counts:",
    "  – Type a single letter (`a`–`z`), OR",
    "  – Guess the full word in chat.",
    "",
    "**Other commands:**",
    "• `!hangman status` / `!hangmanstatus` — show the board",
    "• `!cancelhangman` — admins or the starter can cancel",
    "",
    "For the simple explanation: `!hangman rules`.",
  ].join("\n");
}

function hangmanRulesText() {
  return [
    "**Hangman — Rules (layman)**",
    "",
    "• A host secretly chooses a word (you can’t see it).",
    "• Players join by reacting ✅.",
    "• Each turn, the bot picks **one player** to guess.",
    "• On your turn you can guess **one letter** or guess the **whole word**.",
    `• You can make up to **${DEFAULTS.maxMistakes}** mistakes total. After that: game over.`,
    "• If you don’t answer in time, it counts as a mistake.",
    "",
    "**Word matching:**",
    "• `-` counts as a space.",
    "• Punctuation/symbols are ignored for matching.",
  ].join("\n");
}

function normalizeWord(raw) {
  let s = String(raw ?? "").toLowerCase();
  s = s.replace(/-/g, " ");
  s = s.replace(/[^a-z ]+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function isLetterGuess(msg) {
  const s = String(msg ?? "").trim().toLowerCase();
  return /^[a-z]$/.test(s);
}

function uniqueLettersNeeded(wordNorm) {
  const set = new Set();
  for (const ch of wordNorm) if (ch >= "a" && ch <= "z") set.add(ch);
  return set;
}

function prettyMask(st) {
  const out = [];
  for (const ch of st.wordNorm) {
    if (ch === " ") out.push("  ");
    else if (st.revealed.has(ch)) out.push(ch.toUpperCase(), " ");
    else out.push("_ ");
  }
  return out.join("").trimEnd();
}

function hangmanStage(mistakes) {
  const stages = [
    "```\n +---+\n |   |\n     |\n     |\n     |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n     |\n     |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n |   |\n     |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n/|   |\n     |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n/|\\  |\n     |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n/|\\  |\n/    |\n     |\n=======\n```",
    "```\n +---+\n |   |\n O   |\n/|\\  |\n/ \\  |\n     |\n=======\n```",
    "```\n +---+\n |   |\n X   |\n/|\\  |\n/ \\  |\n     |\n=======\n```",
  ];
  const idx = Math.max(0, Math.min(stages.length - 1, mistakes));
  return stages[idx];
}

function buildStatus(st) {
  const guessed = [...st.guessed].sort().map((c) => c.toUpperCase()).join(", ") || "(none)";
  const remaining = Math.max(0, st.maxMistakes - st.mistakes);

  return [
    `🪓 **Hangman** — Starter: <@${st.creatorId}>`,
    `👥 Players: ${st.players.map((id) => `<@${id}>`).join(", ")}`,
    "",
    hangmanStage(st.mistakes),
    `Word: \`${prettyMask(st)}\``,
    `Guessed: ${guessed}`,
    `Mistakes: **${st.mistakes}/${st.maxMistakes}** (remaining: **${remaining}**)`,
  ].join("\n");
}

function pickNextPlayer(st) {
  if (!st.players.length) return null;
  if (st.players.length === 1) return st.players[0];

  let pid = null;
  for (let tries = 0; tries < 10; tries++) {
    const cand = st.players[Math.floor(Math.random() * st.players.length)];
    if (cand !== st.lastTurnPlayerId) {
      pid = cand;
      break;
    }
  }
  if (!pid) pid = st.players[Math.floor(Math.random() * st.players.length)];
  return pid;
}

async function getChannel(st) {
  const cached = st.client.channels?.cache?.get?.(st.channelId);
  if (cached) return cached;
  return await st.client.channels.fetch(st.channelId).catch(() => null);
}

function stopGame(guildId) {
  // manager.stop() clears TimerBag automatically (this is why we use it exclusively)
  manager.stop({ guildId });
}

async function promptTurn(st) {
  // CRITICAL: prevent overlap — wipe any existing turn timers before scheduling new ones
  st.timers.clearAll();

  const channel = await getChannel(st);
  if (!channel?.send) return;

  const pid = pickNextPlayer(st);
  if (!pid) {
    await channel.send("🏁 Game ended — no players available.");
    stopGame(st.guildId);
    return;
  }

  st.turnPlayerId = pid;
  st.lastTurnPlayerId = pid;

  await channel.send(
    buildStatus(st) +
      `\n\n🎯 It’s <@${pid}>’s turn — type a **letter** (a–z) or guess the **full word**.`
  );

  // Warn timer
  st.timers.setTimeout(async () => {
    const g = manager.getState({ guildId: st.guildId });
    if (!g) return;
    if (g.turnPlayerId !== pid) return;

    const ch = await getChannel(g);
    if (!ch?.send) return;
    await ch.send(`⏳ <@${pid}>… 10s left!`);
  }, DEFAULTS.turnWarn * 1000);

  // Skip timer
  st.timers.setTimeout(async () => {
    const g = manager.getState({ guildId: st.guildId });
    if (!g) return;
    if (g.turnPlayerId !== pid) return;

    const ch = await getChannel(g);
    if (!ch?.send) return;

    g.mistakes += 1;
    await ch.send(`😬 <@${pid}> didn’t answer — that counts as a mistake.`);

    if (g.mistakes >= g.maxMistakes) {
      await ch.send(buildStatus(g) + `\n\n💀 **Game over!** The word was: **${g.wordDisplay}**`);
      stopGame(g.guildId); // also cancels any remaining TimerBag timers
      return;
    }

    g.turnPlayerId = null;
    await promptTurn(g);
  }, DEFAULTS.turnSkip * 1000);
}

async function handleLetterGuess(st, channel, uid, letter) {
  if (st.guessed.has(letter)) return false; // ignore quietly (no turn consumed)

  // CRITICAL: cancel this turn’s pending timers as soon as we accept a guess
  st.timers.clearAll();

  st.guessed.add(letter);

  if (st.wordNorm.includes(letter)) {
    st.revealed.add(letter);

    let all = true;
    for (const ch of st.neededLetters) {
      if (!st.revealed.has(ch)) {
        all = false;
        break;
      }
    }

    if (all) {
      await channel.send(buildStatus(st) + `\n\n🏆 <@${uid}> completed the word! **${st.wordDisplay}**`);
      stopGame(st.guildId);
      return true;
    }

    await channel.send(`✅ <@${uid}> guessed **${letter.toUpperCase()}** — correct!`);
    st.turnPlayerId = null;
    await promptTurn(st);
    return true;
  }

  st.mistakes += 1;
  await channel.send(
    `❌ <@${uid}> guessed **${letter.toUpperCase()}** — wrong! (mistakes: ${st.mistakes}/${st.maxMistakes})`
  );

  if (st.mistakes >= st.maxMistakes) {
    await channel.send(buildStatus(st) + `\n\n💀 **Game over!** The word was: **${st.wordDisplay}**`);
    stopGame(st.guildId);
    return true;
  }

  st.turnPlayerId = null;
  await promptTurn(st);
  return true;
}

async function handleWordGuess(st, channel, uid, raw) {
  const guessNorm = normalizeWord(raw);
  if (!guessNorm) return false;

  // CRITICAL: cancel this turn’s pending timers as soon as we accept a guess
  st.timers.clearAll();

  if (guessNorm === st.wordNorm) {
    await channel.send(buildStatus(st) + `\n\n🏆 <@${uid}> guessed the word! **${st.wordDisplay}**`);
    stopGame(st.guildId);
    return true;
  }

  st.mistakes += 1;
  await channel.send(
    `❌ <@${uid}> guessed the word — wrong! (mistakes: ${st.mistakes}/${st.maxMistakes})`
  );

  if (st.mistakes >= st.maxMistakes) {
    await channel.send(buildStatus(st) + `\n\n💀 **Game over!** The word was: **${st.wordDisplay}**`);
    stopGame(st.guildId);
    return true;
  }

  st.turnPlayerId = null;
  await promptTurn(st);
  return true;
}

/* ------------------------------ registrations ------------------------------ */

export function registerHangman(register) {
  makeGameQoL(register, {
    manager,
    id: "hangman",
    prettyName: "Hangman",
    helpText: hangmanHelpText(),
    rulesText: hangmanRulesText(),
    renderStatus: (st) => buildStatus(st),

    manageDeniedText: "Nope — only admins or the contest starter can cancel.",
    cancel: async (st, { message }) => {
      const ok = await requireCanManage(
        { message },
        st,
        { ownerField: "creatorId", managerLabel: "Hangman", deniedText: "Nope — only admins or the contest starter can cancel." }
      );
      if (!ok) return;

      const channel = await getChannel(st);
      if (channel?.send) await channel.send(`🛑 **Hangman cancelled** by <@${message.author.id}>.`);
      stopGame(st.guildId);
    },
  });

  register(
    "!hangman",
    withGameSubcommands({
      helpText: hangmanHelpText(),
      rulesText: hangmanRulesText(),
      onStart: async ({ message }) => {
        await message.reply(
          "Start Hangman with the slash command:\n" +
            "• `/hangman word:<secret> join:<seconds?> max:<players?>`\n" +
            "Type `!hangman help` (commands) or `!hangman rules` (simple rules)."
        );
      },
      allowStatusSubcommand: true,
      onStatus: async ({ message }) => {
        const st = manager.getState({ message });
        if (!st) return void (await reply({ message }, "No active Hangman game."));
        if (!(await requireSameChannel({ message }, st, manager))) return;
        await reply({ message }, buildStatus(st));
      },
    }),
    "!hangman — start via `/hangman`",
    { helpTier: "primary" }
  );

  register.slash(
    {
      name: "hangman",
      description: "Start a Hangman game (word is private; players join via ✅ reaction)",
      options: [
        { type: 3, name: "word", description: "Secret word (entered privately)", required: true },
        { type: 4, name: "join", description: "Join window seconds (5–120). Default 15.", required: false },
        { type: 4, name: "max", description: "Max players (2–50). Optional.", required: false },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Hangman can only be used in a server." });
        return;
      }

      const existing = manager.getState({ guildId });
      if (existing) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `⚠️ Hangman is already running in <#${existing.channelId}>.`,
        });
        return;
      }

      const channel = interaction.channel;
      if (!channel?.send) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Could not access this channel." });
        return;
      }

      const rawWord = interaction.options?.getString?.("word") ?? "";
      const joinOpt = interaction.options?.getInteger?.("join");
      const maxOpt = interaction.options?.getInteger?.("max");

      const wordNorm = normalizeWord(rawWord);
      if (!wordNorm || wordNorm.length < 2) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Word is too short after normalization." });
        return;
      }

      const neededLetters = uniqueLettersNeeded(wordNorm);
      if (neededLetters.size === 0) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Word has no letters after normalization." });
        return;
      }

      let joinSeconds = Number.isFinite(joinOpt) ? Math.floor(joinOpt) : DEFAULTS.joinSeconds;
      if (!(joinSeconds >= 5 && joinSeconds <= 120)) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ `join` must be between 5 and 120 seconds." });
        return;
      }

      let maxPlayers = null;
      if (maxOpt != null) {
        maxPlayers = Math.floor(maxOpt);
        if (!(maxPlayers >= 2 && maxPlayers <= 50)) {
          await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ `max` must be between 2 and 50." });
          return;
        }
      }

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ Hangman starting. I’ll open a ✅ join window for ${joinSeconds}s in this channel.`,
      });

      const prompt =
        `🪓 **Hangman** — React ✅ to join! (join window: ${joinSeconds}s` +
        (maxPlayers ? `, max ${maxPlayers}` : "") +
        `)\n` +
        `📌 The bot will randomly pick one player each turn to guess.\n`;

      const { entrants } = await collectEntrantsByReactionsWithMax({
        channel,
        promptText: prompt,
        durationMs: joinSeconds * 1000,
        maxEntrants: maxPlayers,
      });

      const players = Array.from(entrants || []).filter(Boolean);
      if (players.length < 1) {
        await channel.send("❌ Nobody joined Hangman. Game not started.");
        return;
      }

      const wordDisplay = wordNorm
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ");

      const res = manager.tryStart(
        { interaction, guildId, channelId: channel.id },
        {
          kind: "hangman",
          guildId,
          channelId: channel.id,
          client: interaction.client,
          creatorId: interaction.user?.id,

          wordNorm,
          wordDisplay,
          neededLetters,

          guessed: new Set(),
          revealed: new Set(),
          mistakes: 0,
          maxMistakes: DEFAULTS.maxMistakes,

          players,
          turnPlayerId: null,
          lastTurnPlayerId: null,
        }
      );

      if (!res.ok) {
        await channel.send(res.errorText);
        return;
      }

      const st = res.state;

      await channel.send(
        `✅ **Hangman started!**\n` +
          `Starter: <@${st.creatorId}>\n` +
          `Players (${players.length}): ${players.map((id) => `<@${id}>`).join(", ")}\n` +
          `Mistakes allowed: **${st.maxMistakes}**\n`
      );

      await promptTurn(st);
    }
  );

  register.onMessage(async ({ message }) => {
    if (!message.guildId) return;
    if (message.author?.bot) return;

    const st = manager.getState({ message });
    if (!st) return;

    if (!(await requireSameChannel({ message }, st, manager))) return;

    const uid = message.author.id;
    if (!st.turnPlayerId || uid !== st.turnPlayerId) return;

    const raw = String(message.content ?? "").trim();
    if (!raw) return;

    if (isLetterGuess(raw)) {
      await handleLetterGuess(st, message.channel, uid, raw.toLowerCase());
      return;
    }

    await handleWordGuess(st, message.channel, uid, raw);
  });
}

export const __testables = {
  normalizeWord,
  isLetterGuess,
  uniqueLettersNeeded,
  prettyMask,
  hangmanStage,
};
