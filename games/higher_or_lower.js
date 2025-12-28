// games/higher_or_lower.js
//
// Higher Or Lower
//
// Commands:
// - !higherorlower <num_rounds> [min-max]   (default range 1-10)
// - !higherorlower help
// - !cancelhigherorlower                    (admin or creator)
//
// Aliases:
// - !hol
//
// Gameplay:
// - Single contestant: the creator (one player only)
// - Bot picks an initial number in range
// - Player clicks Higher / Lower buttons
// - Next roll must be strictly higher/lower than previous number
// - Ties are re-rolled internally (player never loses to an equal roll)
// - If player fails a guess, game ends. If they clear num_rounds correct guesses, they win.
//
// One game per guild, bound to starting channel.
// Uses component interactions via register.component("hol:", handler)

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";

const active = new Map(); // guildId -> state

// state = {
//   guildId,
//   channelId,
//   creatorId,
//   playerId,
//   roundsTotal,
//   roundsWon,
//   min,
//   max,
//   current,
//   messageId
// }

function holHelp() {
  return [
    "**HigherOrLower — Help**",
    "",
    "**Start:**",
    "• `!higherorlower <num_rounds> [min-max]`",
    "  – Example: `!higherorlower 5` (range 1-10)",
    "  – Example: `!higherorlower 8 1-20`",
    "• Alias: `!hol`",
    "",
    "**Play:**",
    "• Click **Higher** or **Lower** on your turn.",
    "• Next roll is guaranteed to be **different** (ties are re-rolled).",
    "• If you guess wrong, you’re out. Clear all rounds to win.",
    "",
    "**Cancel:**",
    "• `!cancelhigherorlower` — admin or game creator only"
  ].join("\n");
}

function parseRangeToken(token) {
  if (!token) return null;
  const m = String(token).trim().match(/^(\d+)\s*[-–—]\s*(\d+)$/);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2]) };
}

function isValidInt(n) {
  return Number.isFinite(n) && Number.isInteger(n);
}

function randIntInclusive(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function rollNotEqual(min, max, current) {
  // Since we enforce min < max, there are at least 2 possible values,
  // so a non-equal roll always exists.
  // Still, guard with a max-tries just in case.
  for (let i = 0; i < 50; i++) {
    const x = randIntInclusive(min, max);
    if (x !== current) return x;
  }
  // Fallback (deterministic): pick nearest alternative
  if (current !== min) return min;
  return max;
}

function mkButtons({ disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hol:hi")
      .setLabel("Higher")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("hol:lo")
      .setLabel("Lower")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
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

function statusLine(st) {
  return `Round: **${st.roundsWon} / ${st.roundsTotal}**`;
}

function headerLine(st) {
  return `🎲 **HigherOrLower** — <@${st.playerId}>`;
}

function rangeLine(st) {
  return `Range: **${st.min}-${st.max}**`;
}

function currentLine(st) {
  return `Current number: **${st.current}**`;
}

function startText(st) {
  return [
    headerLine(st),
    rangeLine(st),
    statusLine(st),
    "",
    currentLine(st),
    "",
    "Choose your guess:"
  ].join("\n");
}

function winText(st, next) {
  return [
    "🏆 **WIN!**",
    headerLine(st),
    rangeLine(st),
    `Final roll: **${next}** (from **${st.current}**)`,
    `You cleared **${st.roundsTotal}** correct guesses!`
  ].join("\n");
}

function loseText(st, guess, next) {
  const wanted = guess === "hi" ? "higher" : "lower";
  const got = next > st.current ? "higher" : "lower"; // never equal (ties rerolled)

  return [
    "💥 **OUT!**",
    headerLine(st),
    rangeLine(st),
    statusLine(st),
    "",
    `You guessed **${wanted}**.`,
    `Next roll: **${next}** (was **${st.current}**, got **${got}**)`,
    "",
    "Game over."
  ].join("\n");
}

export function registerHigherOrLower(register) {
  // !higherorlower (alias: !hol)
  register(
    "!higherorlower",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      const guildId = message.guildId;

      const tokens = String(rest ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      // help
      if (tokens.length === 0 || (tokens.length === 1 && tokens[0].toLowerCase() === "help")) {
        await message.reply(holHelp());
        return;
      }

      if (active.has(guildId)) {
        const st = active.get(guildId);
        await message.reply(`⚠️ HigherOrLower is already running in <#${st.channelId}>.`);
        return;
      }

      const rounds = Number(tokens[0]);
      if (!isValidInt(rounds) || rounds <= 0 || rounds > 100) {
        await message.reply("❌ `num_rounds` must be a positive integer (1–100).");
        return;
      }

      let min = 1;
      let max = 10;

      if (tokens[1]) {
        const r = parseRangeToken(tokens[1]);
        if (!r) {
          await message.reply("❌ Invalid range. Use `min-max` (example: `1-10`).");
          return;
        }
        min = r.min;
        max = r.max;

        if (!isValidInt(min) || !isValidInt(max) || min <= 0 || max <= 0 || min >= max) {
          await message.reply("❌ Range must be positive integers with `min < max`.");
          return;
        }
        if (max - min + 1 > 10_000) {
          await message.reply("❌ Range too large (max 10,000 numbers).");
          return;
        }
      }

      const st = {
        guildId,
        channelId: message.channelId,
        creatorId: message.author.id,
        playerId: message.author.id,
        roundsTotal: rounds,
        roundsWon: 0,
        min,
        max,
        current: randIntInclusive(min, max),
        messageId: null
      };

      const sent = await message.channel.send({
        content: startText(st),
        components: [mkButtons()]
      });

      st.messageId = sent.id;
      active.set(guildId, st);
    },
    "!higherorlower <num_rounds> [min-max] — single-player Higher/Lower (buttons). Type `!higherorlower help`.",
    { helpTier: "primary", aliases: ["!hol"] }
  );

  // Cancel
  register(
    "!cancelhigherorlower",
    async ({ message }) => {
      if (!message.guildId) return;
      const st = active.get(message.guildId);
      if (!st) {
        await message.reply("No active HigherOrLower game to cancel.");
        return;
      }
      if (!inSameChannel(message, st)) {
        await message.reply(`HigherOrLower is running in <#${st.channelId}>.`);
        return;
      }
      if (!canManage(message, st)) {
        await message.reply("Nope — only admins or the game creator can cancel.");
        return;
      }

      active.delete(message.guildId);
      await message.channel.send("🛑 **HigherOrLower cancelled.**");
    },
    "!cancelhigherorlower — cancels HigherOrLower (admin or creator)",
    { admin: true }
  );

  // Buttons: hol:hi / hol:lo
  register.component("hol:", async ({ interaction }) => {
    if (!interaction?.guildId) return;

    const st = active.get(interaction.guildId);
    if (!st) {
      try {
        await interaction.reply({ content: "No active HigherOrLower game.", ephemeral: true });
      } catch {}
      return;
    }

    // Channel binding
    if (!inSameChannel(interaction, st)) {
      try {
        await interaction.reply({
          content: `HigherOrLower is running in <#${st.channelId}>.`,
          ephemeral: true
        });
      } catch {}
      return;
    }

    // Only the participant can press
    if (interaction.user?.id !== st.playerId) {
      try {
        await interaction.reply({
          content: "Only the current contestant can use these buttons.",
          ephemeral: true
        });
      } catch {}
      return;
    }

    // Only accept clicks on the active game message
    if (st.messageId && interaction.message?.id && interaction.message.id !== st.messageId) {
      try {
        await interaction.reply({
          content: "These buttons aren’t for the current game message.",
          ephemeral: true
        });
      } catch {}
      return;
    }

    const id = String(interaction.customId || "");
    const guess = id.endsWith(":hi") ? "hi" : id.endsWith(":lo") ? "lo" : null;
    if (!guess) {
      try {
        await interaction.reply({ content: "Unknown button.", ephemeral: true });
      } catch {}
      return;
    }

    // Roll next, reroll on ties so the player never loses to equality
    const next = rollNotEqual(st.min, st.max, st.current);

    const correct =
      guess === "hi" ? next > st.current :
      guess === "lo" ? next < st.current :
      false;

    if (!correct) {
      const content = loseText(st, guess, next);
      active.delete(st.guildId);

      await interaction.update({
        content,
        components: [mkButtons({ disabled: true })]
      });
      return;
    }

    st.roundsWon += 1;

    if (st.roundsWon >= st.roundsTotal) {
      const content = winText(st, next);
      active.delete(st.guildId);

      await interaction.update({
        content,
        components: [mkButtons({ disabled: true })]
      });
      return;
    }

    st.current = next;

    await interaction.update({
      content: [
        headerLine(st),
        rangeLine(st),
        statusLine(st),
        "",
        `✅ Correct! New current number: **${st.current}**`,
        "",
        "Choose your next guess:"
      ].join("\n"),
      components: [mkButtons()]
    });
  });
}
