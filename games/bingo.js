// games/bingo.js
//
// Kanto Region Bingo (generic range bingo):
// - One bingo game active for the whole bot (global singleton)
// - !bingo <min-max> [optional drawn list]  -> start/resume
// - !draw                                  -> draw next number (no repeats) + show list
// - !getbingolist                           -> show drawn numbers (comma-separated)
// - !cancelbingo                            -> admin or starter only
//
// Resume format examples:
//   !bingo 1-151
//   !bingo 1-151 5,12,77
//   !bingo 1-151 5, 12, 77
//   !bingo 1-151 5 12 77
//
// Notes:
// - Range must be positive integers, min < max
// - Draw list must be unique, within range, and cannot exceed range size
// - If all numbers are already drawn, the game auto-ends.

import { isAdminOrPrivileged } from "../auth.js";

const ACTIVE = {
  // global singleton (only one bingo at a time)
  state: null
  // state = {
  //   guildId, channelId, creatorId,
  //   min, max, size,
  //   drawn: number[],        // in draw order
  //   drawnSet: Set<number>,  // fast checks
  // }
};

function parseRangeToken(token) {
  // Accept "1-151" (also allow en-dash/em-dash)
  const m = String(token ?? "")
    .trim()
    .match(/^(\d+)\s*[-–—]\s*(\d+)$/);
  if (!m) return null;

  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  return { min, max };
}

function parseDrawList(raw) {
  // Accept comma-separated and/or whitespace separated numbers.
  // Examples:
  //  "1,2,3" / "1, 2, 3" / "1 2 3" / "1,2 3"
  const s = String(raw ?? "").trim();
  if (!s) return [];

  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x));
}

function canManageBingo(message, state) {
  if (!state) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id && message.author.id === state.creatorId;
}

function gameLocationLine(state) {
  return `Started by <@${state.creatorId}> in <#${state.channelId}>`;
}

function fmtList(arr) {
  if (!arr || arr.length === 0) return "(none yet)";
  return arr.join(", ");
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildRemainingArray(state) {
  const out = [];
  for (let n = state.min; n <= state.max; n++) {
    if (!state.drawnSet.has(n)) out.push(n);
  }
  return out;
}

async function endGame(message, reason) {
  const st = ACTIVE.state;
  ACTIVE.state = null;
  if (st) {
    await message.channel.send(
      `🏁 **Bingo ended** (${reason}).\nDrawn (${st.drawn.length}/${st.size}): ${fmtList(st.drawn)}`
    );
  } else {
    await message.channel.send(`🏁 **Bingo ended** (${reason}).`);
  }
}

export function registerBingo(register) {
  // !bingo <min-max> [optional drawn list]
  register(
    "!bingo",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);

      if (tokens.length === 0 || tokens[0].toLowerCase() === "help") {
        await message.reply(
          "**Bingo help**\n" +
          "`!bingo <min-max> [optional drawnlist]` — start/resume\n" +
          "Examples: `!bingo 1-151` | `!bingo 1-151 5,12,77`\n" +
          "`!draw` — draw a new number\n" +
          "`!getbingolist` — show drawn list\n" +
          "`!cancelbingo` — cancel (admin/starter)"
        );
        return;
      }

      const rangeTok = tokens[0];
      const range = parseRangeToken(rangeTok);
      if (!range) {
        await message.reply("❌ Invalid range. Use `min-max` (example: `1-151`).");
        return;
      }

      const { min, max } = range;

      if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max <= 0) {
        await message.reply("❌ Range values must be **positive integers**.");
        return;
      }
      if (min >= max) {
        await message.reply("❌ Invalid range. Must be `min < max` (example: `1-151`).");
        return;
      }

      const size = max - min + 1;
      if (size <= 0) {
        await message.reply("❌ Invalid range size.");
        return;
      }
      if (size > 50_000) {
        await message.reply("❌ Range too large (max 50,000 numbers).");
        return;
      }

      // If a game is active, block starting a new one.
      // (This is your “only one game at a time” rule, global singleton.)
      const existing = ACTIVE.state;
      if (existing) {
        await message.reply(
          `⚠️ A bingo game is already running.\n` +
            `${gameLocationLine(existing)}\n` +
            `Use \`!draw\`, \`!getbingolist\`, or \`!cancelbingo\`.`
        );
        return;
      }

      // Optional drawn list is everything after the range token
      const drawnRaw = tokens.slice(1).join(" ").trim();
      const drawnNums = parseDrawList(drawnRaw);

      // Validate drawn list
      const drawn = [];
      const drawnSet = new Set();

      for (const x of drawnNums) {
        if (!Number.isFinite(x) || !Number.isInteger(x)) {
          await message.reply("❌ Resume list contains a non-integer value.");
          return;
        }
        if (x < min || x > max) {
          await message.reply(`❌ Resume list value \`${x}\` is out of range (${min}-${max}).`);
          return;
        }
        if (drawnSet.has(x)) {
          await message.reply(`❌ Resume list contains a duplicate: \`${x}\`.`);
          return;
        }
        drawnSet.add(x);
        drawn.push(x);
      }

      if (drawn.length > size) {
        await message.reply("❌ Resume list cannot be larger than the range size.");
        return;
      }

      // Create state
      ACTIVE.state = {
        guildId: message.guildId,
        channelId: message.channelId,
        creatorId: message.author.id,
        min,
        max,
        size,
        drawn,
        drawnSet
      };

      // Auto-end if already complete
      if (drawn.length === size) {
        await endGame(message, "all numbers already drawn (resume complete)");
        return;
      }

      const remaining = size - drawn.length;
      const resumeNote = drawn.length ? ` (resumed with ${drawn.length} already drawn)` : "";
      await message.channel.send(
        `✅ **Bingo started** — Range: **${min}-${max}** (${size} total)${resumeNote}\n` +
          `Remaining: **${remaining}**\n` +
          `Draw with \`!draw\`. View list with \`!getbingolist\`. Cancel with \`!cancelbingo\`.`
      );
    },
    "!bingo <min-max> [drawnlist] — starts/resumes a bingo draw (example: `!bingo 1-151 5,12,77`)",
    { helpTier: "primary" }
  );

  // !draw
  register(
    "!draw",
    async ({ message }) => {
      const st = ACTIVE.state;
      if (!st) {
        await message.reply("No active bingo game. Start one with `!bingo 1-151`.");
        return;
      }

      // Restrict draws to same guild (since state stores channel/guild)
      if (message.guildId !== st.guildId) {
        await message.reply(`A bingo game is running elsewhere. ${gameLocationLine(st)}.`);
        return;
      }

      const remainingArr = buildRemainingArray(st);
      if (remainingArr.length === 0) {
        await endGame(message, "no numbers left to draw");
        return;
      }

      const pick = randChoice(remainingArr);
      st.drawn.push(pick);
      st.drawnSet.add(pick);

      const remaining = st.size - st.drawn.length;

      await message.channel.send(
        `🎲 **Draw:** **${pick}**\n` +
          `Drawn (${st.drawn.length}/${st.size}): ${fmtList(st.drawn)}\n` +
          `Remaining: **${remaining}**`
      );

      if (remaining <= 0) {
        await endGame(message, "no numbers left to draw");
      }
    },
    "!draw — draws a new number and prints the draw list",
    { hideFromHelp: true }
  );

  // !getbingolist
  register(
    "!getbingolist",
    async ({ message }) => {
      const st = ACTIVE.state;
      if (!st) {
        await message.reply("No active bingo game.");
        return;
      }
      if (message.guildId !== st.guildId) {
        await message.reply(`A bingo game is running elsewhere. ${gameLocationLine(st)}.`);
        return;
      }

      await message.reply(`Drawn (${st.drawn.length}/${st.size}): ${fmtList(st.drawn)}`);
    },
    "!getbingolist — prints the drawn numbers in order",
    { hideFromHelp: true }
  );

  // !cancelbingo (admin or starter)
  register(
    "!cancelbingo",
    async ({ message }) => {
      const st = ACTIVE.state;
      if (!st) {
        await message.reply("No active bingo game to cancel.");
        return;
      }
      if (message.guildId !== st.guildId) {
        await message.reply(`A bingo game is running elsewhere. ${gameLocationLine(st)}.`);
        return;
      }

      if (!canManageBingo(message, st)) {
        await message.reply("Nope — only admins or the bingo starter can use that.");
        return;
      }

      await endGame(message, "cancelled");
    },
    "!cancelbingo — cancels the current bingo (admin or starter)",
    { admin: true }
  );
}
