// games/higher_or_lower.js
//
// Higher Or Lower
//
// Commands:
// - !higherorlower <num_rounds> [min-max]   (default range 1-10)
// - !higherorlower help
// - !cancelhigherorlower
// Aliases:
// - !hol
//
// One game per guild, bound to starting channel.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import {
  createBoard,
  createGameManager,
  guardBoardInteraction,
  makeGameQoL,
  withGameSubcommands,
} from "./framework.js";
import { parseMinMaxRangeToken } from "./helpers.js";

const manager = createGameManager({ id: "higherorlower", prettyName: "HigherOrLower", scope: "guild" });

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
    "• Click **Higher** or **Lower**.",
    "• Ties are re-rolled internally.",
    "• Guess wrong and the game ends; clear all rounds to win.",
    "",
    "**Cancel:**",
    "• `!cancelhigherorlower` — admin or game creator only",
  ].join("\n");
}

function holRules() {
  return [
    "**HigherOrLower — Rules (layman)**",
    "",
    "You start with a number in a range (default **1–10**).",
    "Each round you guess whether the **next** number will be **Higher** or **Lower**.",
    "",
    "• If you guess correctly, you advance to the next round.",
    "• If you guess wrong, the game ends immediately.",
    "• Ties are re-rolled internally (you won’t see an equal number).",
    "",
    "Win by clearing all rounds you started with.",
  ].join("\n");
}

const HOL_HELP = holHelp();
const HOL_RULES = holRules();

const isInt = (n) => Number.isFinite(n) && Number.isInteger(n);

function parseRangeToken(token) {
  return parseMinMaxRangeToken(token);
}

const randIntInclusive = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function rollNotEqual(min, max, current) {
  for (let i = 0; i < 50; i++) {
    const x = randIntInclusive(min, max);
    if (x !== current) return x;
  }
  return current !== min ? min : max;
}

function mkButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("hol:hi").setLabel("Higher").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId("hol:lo").setLabel("Lower").setStyle(ButtonStyle.Danger).setDisabled(disabled)
  );
}

const headerLine = (st) => `🎲 **HigherOrLower** — <@${st.playerId}>`;
const rangeLine = (st) => `Range: **${st.min}-${st.max}**`;
const statusLine = (st) => `Round: **${st.roundsWon} / ${st.roundsTotal}**`;
const currentLine = (st) => `Current number: **${st.current}**`;

function liveText(st, midLine = null) {
  return [
    headerLine(st),
    rangeLine(st),
    statusLine(st),
    "",
    midLine || currentLine(st),
    "",
    "Choose your guess:",
  ].join("\n");
}

function winText(st, next) {
  return [
    "🏆 **WIN!**",
    headerLine(st),
    rangeLine(st),
    `Final roll: **${next}** (from **${st.current}**)`,
    `You cleared **${st.roundsTotal}** correct guesses!`,
  ].join("\n");
}

function loseText(st, guess, next) {
  const wanted = guess === "hi" ? "higher" : "lower";
  const got = next > st.current ? "higher" : "lower";
  return [
    "💥 **OUT!**",
    headerLine(st),
    rangeLine(st),
    statusLine(st),
    "",
    `You guessed **${wanted}**.`,
    `Next roll: **${next}** (was **${st.current}**, got **${got}**)`,
    "",
    "Game over.",
  ].join("\n");
}

export function registerHigherOrLower(register) {
  makeGameQoL(register, {
    manager,
    id: "higherorlower",
    prettyName: "HigherOrLower",
    helpText: HOL_HELP,
    rulesText: HOL_RULES,
    renderStatus: (st) => liveText(st),

    // Framework will enforce owner/admin and print this text on deny
    manageDeniedText: "Nope — only admins or the game creator can cancel.",

    cancel: async (st) => {
      // Caller already passed requireSameChannel + requireCanManage via makeGameQoL
      // Optional extra nicety: try to disable the board buttons (not required, but reduces confusion)
      const board = createBoard(st);
      manager.stop({ guildId: st.guildId });
      await board.update({ content: "🛑 **HigherOrLower cancelled.**", components: [mkButtons(true)] });
    },
  });

  register(
    "!higherorlower",
    withGameSubcommands({
      helpText: HOL_HELP,
      rulesText: HOL_RULES,
      onStart: async ({ message, rest }) => {
        if (!message.guildId) return;

        const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0 || (tokens.length === 1 && tokens[0].toLowerCase() === "help")) {
          await message.reply(holHelp());
          return;
        }

        const res = manager.tryStart(
          { message, guildId: message.guildId, channelId: message.channelId },
          {
            guildId: message.guildId,
            channelId: message.channelId,
            creatorId: message.author.id,
            playerId: message.author.id,
            client: message.client,
          }
        );
        if (!res.ok) return void (await message.reply(res.errorText));

        const rounds = Number(tokens[0]);
        if (!isInt(rounds) || rounds <= 0 || rounds > 100) {
          manager.stop({ guildId: message.guildId });
          return void (await message.reply("❌ `num_rounds` must be a positive integer (1–100)."));
        }

        let min = 1, max = 10;
        if (tokens[1]) {
          const r = parseRangeToken(tokens[1]);
          if (!r || !isInt(r.min) || !isInt(r.max) || r.min <= 0 || r.max <= 0 || r.min >= r.max) {
            manager.stop({ guildId: message.guildId });
            return void (await message.reply("❌ Invalid range. Use `min-max` (example: `1-10`)."));
          }
          if (r.max - r.min + 1 > 10_000) {
            manager.stop({ guildId: message.guildId });
            return void (await message.reply("❌ Range too large (max 10,000 numbers)."));
          }
          min = r.min;
          max = r.max;
        }

        const st = res.state;
        Object.assign(st, {
          roundsTotal: rounds,
          roundsWon: 0,
          min,
          max,
          current: randIntInclusive(min, max),
          messageId: null,
        });

        const board = createBoard(st);
        await board.post(message.channel, { content: liveText(st), components: [mkButtons(false)] });
      },
    }),
    "!higherorlower <num_rounds> [min-max] — single-player Higher/Lower (buttons). Type `!higherorlower help`.",
    { helpTier: "primary", aliases: ["!hol"] }
  );

  register.component("hol:", async ({ interaction }) => {
    if (!interaction?.guildId) return;

    const guarded = await guardBoardInteraction(interaction, {
      manager,
      messageIdField: "messageId",
      allowUserIds: null, // we validate player below
    });
    if (!guarded) return;

    const { state: st } = guarded;

    if (interaction.user?.id !== st.playerId) {
      try {
        await interaction.reply({ content: "Only the current contestant can use these buttons.", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }

    const id = String(interaction.customId || "");
    const guess = id.endsWith(":hi") ? "hi" : id.endsWith(":lo") ? "lo" : null;
    if (!guess) {
      try {
        await interaction.reply({ content: "Unknown button.", flags: MessageFlags.Ephemeral });
      } catch {}
      return;
    }

    const next = rollNotEqual(st.min, st.max, st.current);
    const correct = guess === "hi" ? next > st.current : next < st.current;

    if (!correct) {
      manager.stop({ guildId: st.guildId });
      await interaction.update({ content: loseText(st, guess, next), components: [mkButtons(true)] });
      return;
    }

    st.roundsWon += 1;

    if (st.roundsWon >= st.roundsTotal) {
      manager.stop({ guildId: st.guildId });
      await interaction.update({ content: winText(st, next), components: [mkButtons(true)] });
      return;
    }

    st.current = next;

    await interaction.update({
      content: liveText(st, `✅ Correct! New current number: **${st.current}**`),
      components: [mkButtons(false)],
    });
  });
}

export const __testables = {
  parseRangeToken,
  rollNotEqual,
};
