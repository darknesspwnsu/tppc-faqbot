// games/hangman.js
//
// Hangman (slash-start + reaction-join + chat guesses)
// - One game active per guild
// - Starter begins via /hangman with an ephemeral word option
// - Join step: react ✅ in the same channel to enter (like your other games)
// - Bot randomly selects ONE entrant each turn; only that player’s chat messages count
// - Player may guess:
//   - a single letter (a-z)
//   - OR the full word (normalized) — if correct, game ends immediately
// - 7 mistakes max
//
// Normalization rule (per your spec):
// - lowercase
// - dash "-" becomes space
// - everything else removed (keep only [a-z ])
// - collapse whitespace
//
// Help visibility:
// - `!hangman` is the "primary" help entry in Games, points to /hangman
// - `!cancelhangman` admin/creator, admin-only help-hidden

import { MessageFlags } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";

const activeGames = new Map(); // guildId -> game state

const DEFAULTS = {
  joinSeconds: 15,
  maxPlayers: null, // 2..50 optional
  turnWarn: 20,     // seconds (reminder)
  turnSkip: 30,     // seconds (forfeit a life)
  maxMistakes: 7,
};

function hangmanHelpText() {
  return [
    "**Hangman — help**",
    "",
    "**Start (slash):**",
    "• `/hangman word:<secret> join:<seconds?> max:<players?>`",
    "  – The secret word is entered privately (ephemeral).",
    "  – Players join by reacting ✅ in the channel during the join window.",
    "",
    "**How to play:**",
    "• Each turn, the bot randomly selects one player.",
    "• Only that player’s message counts:",
    "  – Type a single letter (`a`–`z`), OR",
    "  – Guess the full word in chat.",
    "• If someone who isn’t selected tries to guess, it’s ignored.",
    "",
    "**Rules:**",
    `• You lose after **${DEFAULTS.maxMistakes}** wrong guesses (mistakes).`,
    "• Dashes are treated as spaces; punctuation is removed for matching.",
    "",
    "**Cancel:**",
    "• `!cancelhangman` — admins or the contest starter can cancel.",
  ].join("\n");
}

function normalizeWord(raw) {
  let s = String(raw ?? "").toLowerCase();
  s = s.replace(/-/g, " ");
  s = s.replace(/[^a-z ]+/g, "");  // remove everything else
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function isLetterGuess(msg) {
  const s = String(msg ?? "").trim().toLowerCase();
  return /^[a-z]$/.test(s);
}

function prettyMask(game) {
  // Display with spaced underscores, spaces preserved
  const out = [];
  for (const ch of game.wordNorm) {
    if (ch === " ") {
      out.push("  ");
    } else if (game.revealed.has(ch)) {
      out.push(ch.toUpperCase());
      out.push(" ");
    } else {
      out.push("_ ");
    }
  }
  return out.join("").trimEnd();
}

function uniqueLettersNeeded(wordNorm) {
  const set = new Set();
  for (const ch of wordNorm) {
    if (ch >= "a" && ch <= "z") set.add(ch);
  }
  return set;
}

function clearTurnTimers(game) {
  if (!game) return;
  try { if (game.warnTimeout) clearTimeout(game.warnTimeout); } catch {}
  try { if (game.skipTimeout) clearTimeout(game.skipTimeout); } catch {}
  game.warnTimeout = null;
  game.skipTimeout = null;
}

function endGame(guildId) {
  const game = activeGames.get(guildId);
  if (!game) return;
  clearTurnTimers(game);
  activeGames.delete(guildId);
}

function canManage(message, game) {
  if (!game) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === game.creatorId;
}

async function collectEntrantsByReactionsWithMax({ channel, promptText, durationMs, maxEntrants }) {
  const joinMsg = await channel.send(promptText);
  const emoji = "✅";

  try {
    await joinMsg.react(emoji);
  } catch {
    return { entrants: new Set(), joinMsg };
  }

  const entrants = new Set();
  const filter = (reaction, user) => !user.bot && reaction.emoji?.name === emoji;

  return new Promise((resolve) => {
    const collector = joinMsg.createReactionCollector({ filter, time: durationMs });

    collector.on("collect", (_reaction, user) => {
      entrants.add(user.id);
      if (maxEntrants && entrants.size >= maxEntrants) collector.stop("max");
    });

    collector.on("end", () => resolve({ entrants, joinMsg }));
  });
}

function pickNextPlayer(game) {
  if (!game.players.length) return null;
  if (game.players.length === 1) return game.players[0];

  // Avoid picking the same person twice in a row when possible
  let pid = null;
  for (let tries = 0; tries < 10; tries++) {
    const cand = game.players[Math.floor(Math.random() * game.players.length)];
    if (cand !== game.lastTurnPlayerId) {
      pid = cand;
      break;
    }
  }
  if (!pid) pid = game.players[Math.floor(Math.random() * game.players.length)];
  return pid;
}

function hangmanStage(mistakes) {
  // 0..7 (8 stages including final). Keep it compact for Discord.
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

function buildStatus(game) {
  const guessed = [...game.guessed].sort().map((c) => c.toUpperCase()).join(", ") || "(none)";
  const remaining = Math.max(0, game.maxMistakes - game.mistakes);

  return [
    `🪓 **Hangman** — Starter: <@${game.creatorId}>`,
    `👥 Players: ${game.players.map((id) => `<@${id}>`).join(", ")}`,
    "",
    hangmanStage(game.mistakes),
    `Word: \`${prettyMask(game)}\``,
    `Guessed: ${guessed}`,
    `Mistakes: **${game.mistakes}/${game.maxMistakes}** (remaining: **${remaining}**)`,
  ].join("\n");
}

async function promptTurn(game) {
  clearTurnTimers(game);

  const channel = game.channel;
  if (!channel) return;

  const pid = pickNextPlayer(game);
  if (!pid) {
    await channel.send("🏁 Game ended — no players available.");
    endGame(game.guildId);
    return;
  }

  game.turnPlayerId = pid;
  game.lastTurnPlayerId = pid;

  await channel.send(
    buildStatus(game) +
      `\n\n🎯 It’s <@${pid}>’s turn — type a **letter** (a–z) or guess the **full word**.`
  );

  // Warn then forfeit (counts as a mistake) on inactivity
  game.warnTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    if (g.turnPlayerId !== pid) return;
    await channel.send(`⏳ <@${pid}>… 10s left!`);
  }, DEFAULTS.turnWarn * 1000);

  game.skipTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    if (g.turnPlayerId !== pid) return;

    g.mistakes += 1;

    await channel.send(`😬 <@${pid}> didn’t answer — that counts as a mistake.`);

    if (g.mistakes >= g.maxMistakes) {
      await channel.send(
        buildStatus(g) +
          `\n\n💀 **Game over!** The word was: **${g.wordDisplay}**`
      );
      endGame(g.guildId);
      return;
    }

    // Next turn
    g.turnPlayerId = null;
    await promptTurn(g);
  }, DEFAULTS.turnSkip * 1000);
}

/* ------------------------------ registrations ------------------------------ */

export function registerHangman(register) {
  // Bridge bang command for Games help (since /hangman won't appear in bang help list)
  register(
    "!hangman",
    async ({ message, rest }) => {
      const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 1 && ["help", "h", "?"].includes(tokens[0].toLowerCase())) {
        await message.reply(hangmanHelpText());
        return;
      }

      await message.reply(
        "Start Hangman with the slash command:\n" +
          "• `/hangman word:<secret> join:<seconds?> max:<players?>`\n" +
          "Type `!hangman help` for full rules."
      );
    },
    "!hangman — start via `/hangman`. Type `!hangman help` for rules.",
    { helpTier: "primary" }
  );

  // Cancel (admin or creator)
  register(
    "!cancelhangman",
    async ({ message }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game) {
        await message.reply("No active Hangman game to cancel.");
        return;
      }

      if (message.channelId !== game.channelId) {
        await message.reply(`Hangman is running in <#${game.channelId}>.`);
        return;
      }

      if (!canManage(message, game)) {
        await message.reply("Nope — only admins or the contest starter can cancel.");
        return;
      }

      await message.channel.send(`🛑 **Hangman cancelled** by <@${message.author.id}>.`);
      endGame(guildId);
    },
    "!cancelhangman — cancel Hangman (admin or starter)",
    { admin: true }
  );

  // Slash start: /hangman
  register.slash(
    {
      name: "hangman",
      description: "Start a Hangman game (word is private; players join via ✅ reaction)",
      options: [
        {
          type: 3, // STRING
          name: "word",
          description: "Secret word (entered privately)",
          required: true,
        },
        {
          type: 4, // INTEGER
          name: "join",
          description: "Join window seconds (5–120). Default 15.",
          required: false,
        },
        {
          type: 4, // INTEGER
          name: "max",
          description: "Max players (2–50). Optional.",
          required: false,
        }
      ]
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Hangman can only be used in a server." });
        return;
      }

      if (activeGames.has(guildId)) {
        const g = activeGames.get(guildId);
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `⚠️ Hangman is already running in <#${g.channelId}>.`
        });
        return;
      }

      const channel = interaction.channel;
      if (!channel?.send) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Could not access this channel." });
        return;
      }

      const rawWord = interaction.options?.getString?.("word") ?? "";
      const join = interaction.options?.getInteger?.("join");
      const max = interaction.options?.getInteger?.("max");

      const wordNorm = normalizeWord(rawWord);
      if (!wordNorm || wordNorm.length < 2) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Word is too short after normalization. Try a longer Pokémon name."
        });
        return;
      }

      const needed = uniqueLettersNeeded(wordNorm);
      if (needed.size === 0) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Word has no letters after normalization."
        });
        return;
      }

      let joinSeconds = Number.isFinite(join) ? Math.floor(join) : DEFAULTS.joinSeconds;
      if (!(joinSeconds >= 5 && joinSeconds <= 120)) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ `join` must be between 5 and 120 seconds."
        });
        return;
      }

      let maxPlayers = null;
      if (max != null) {
        maxPlayers = Math.floor(max);
        if (!(maxPlayers >= 2 && maxPlayers <= 50)) {
          await interaction.reply({
            flags: MessageFlags.Ephemeral,
            content: "❌ `max` must be between 2 and 50."
          });
          return;
        }
      }

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `✅ Hangman starting. I’ll open a ✅ join window for ${joinSeconds}s in this channel.`
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
        maxEntrants: maxPlayers
      });

      if (!entrants || entrants.size < 1) {
        await channel.send("❌ Nobody joined Hangman. Game not started.");
        return;
      }

      const players = Array.from(entrants).filter(Boolean);

      const game = {
        kind: "hangman",
        guildId,
        channelId: channel.id,
        channel,

        creatorId: interaction.user?.id,

        // Word
        wordNorm,
        wordDisplay: wordNorm.split(" ").map((w) => (w ? (w[0].toUpperCase() + w.slice(1)) : "")).join(" "),
        neededLetters: needed,

        // Progress
        guessed: new Set(),
        revealed: new Set(), // correct letters
        mistakes: 0,
        maxMistakes: DEFAULTS.maxMistakes,

        // Players
        players,
        turnPlayerId: null,
        lastTurnPlayerId: null,

        // Timers
        warnTimeout: null,
        skipTimeout: null,
      };

      activeGames.set(guildId, game);

      await channel.send(
        `✅ **Hangman started!**\n` +
          `Starter: <@${game.creatorId}>\n` +
          `Players (${players.length}): ${players.map((id) => `<@${id}>`).join(", ")}\n` +
          `Mistakes allowed: **${game.maxMistakes}**\n`
      );

      await promptTurn(game);
    }
  );

  // Message hook: consume guesses
  register.onMessage(async ({ message }) => {
    if (!message.guild) return;
    if (message.author?.bot) return;

    const guildId = message.guild.id;
    const game = activeGames.get(guildId);
    if (!game || game.kind !== "hangman") return;

    // Channel-bound
    if (message.channelId !== game.channelId) return;

    // Only current turn player counts
    const uid = message.author.id;
    if (!game.turnPlayerId || uid !== game.turnPlayerId) return;

    const raw = String(message.content ?? "").trim();
    if (!raw) return;

    // If it's a single-letter guess:
    if (isLetterGuess(raw)) {
      const letter = raw.toLowerCase();

      // already guessed
      if (game.guessed.has(letter)) {
        // ignore quietly (avoid spam)
        return;
      }

      clearTurnTimers(game);
      game.guessed.add(letter);

      if (game.wordNorm.includes(letter)) {
        game.revealed.add(letter);

        // Win if all needed letters revealed
        let all = true;
        for (const ch of game.neededLetters) {
          if (!game.revealed.has(ch)) { all = false; break; }
        }

        if (all) {
          await message.channel.send(
            buildStatus(game) +
              `\n\n🏆 <@${uid}> completed the word! **${game.wordDisplay}**`
          );
          endGame(guildId);
          return;
        }

        await message.channel.send(`✅ <@${uid}> guessed **${letter.toUpperCase()}** — correct!`);
        game.turnPlayerId = null;
        await promptTurn(game);
        return;
      }

      // Wrong letter
      game.mistakes += 1;

      await message.channel.send(
        `❌ <@${uid}> guessed **${letter.toUpperCase()}** — wrong! (mistakes: ${game.mistakes}/${game.maxMistakes})`
      );

      if (game.mistakes >= game.maxMistakes) {
        await message.channel.send(
          buildStatus(game) +
            `\n\n💀 **Game over!** The word was: **${game.wordDisplay}**`
        );
        endGame(guildId);
        return;
      }

      game.turnPlayerId = null;
      await promptTurn(game);
      return;
    }

    // Otherwise: treat as full word guess (normalized)
    const guessNorm = normalizeWord(raw);
    if (!guessNorm) return;

    clearTurnTimers(game);

    if (guessNorm === game.wordNorm) {
      await message.channel.send(
        `🏆 <@${uid}> guessed the word: **${game.wordDisplay}**\n` +
          `✅ Hangman complete!`
      );
      endGame(guildId);
      return;
    }

    // Wrong full guess counts as a mistake
    game.mistakes += 1;
    await message.channel.send(
      `❌ <@${uid}> guessed the word — wrong! (mistakes: ${game.mistakes}/${game.maxMistakes})`
    );

    if (game.mistakes >= game.maxMistakes) {
      await message.channel.send(
        buildStatus(game) +
          `\n\n💀 **Game over!** The word was: **${game.wordDisplay}**`
      );
      endGame(guildId);
      return;
    }

    game.turnPlayerId = null;
    await promptTurn(game);
  });
}
