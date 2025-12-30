// games/bingo.js
//
// Guild-scoped Bingo (range draw bingo):
// - One bingo game per guild (NOT channel-scoped)
// - Start/resume:   !bingo <min-max> [optional drawn list]
// - Draw next:      !bingodraw   (alias: !draw, hidden)
// - Show list:      !bingolist   (alias: !getbingolist, hidden)
// - Cancel:         !cancelbingo (and framework aliases !bingostatus/!bingohelp/!bingorules etc)
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
// - If all numbers are already drawn, the game auto-ends
// - Commands can be used from ANY channel in the guild (by design)

import {
  createGameManager,
  withGameSubcommands,
  makeGameQoL,
  reply,
  mention,
  channelMention,
  nowMs,
  clampInt,
  requireActive,
  requireCanManage,
} from "./framework.js";

/* --------------------------------- parsing -------------------------------- */

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
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x));
}

function fmtList(arr) {
  if (!arr || arr.length === 0) return "(none yet)";
  return arr.join(", ");
}

function buildRemainingArray(state) {
  const out = [];
  for (let n = state.min; n <= state.max; n++) {
    if (!state.drawnSet.has(n)) out.push(n);
  }
  return out;
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* --------------------------------- text ---------------------------------- */

function helpText(id) {
  return (
    `**Bingo help**\n` +
    `• \`!${id} <min-max> [optional drawnlist]\` — start/resume (example: \`!${id} 1-151 5,12,77\`)\n` +
    `• \`!${id}draw\` — draw a new number (no repeats)\n` +
    `• \`!${id}list\` — show drawn list\n` +
    `• \`!${id}status\` — show current game info\n` +
    `• \`!end${id}\` — end immediately (host/admin)\n\n` +
    `• \`!cancel${id}\` — cancel (host/admin)\n\n` +
    `Shortcuts:\n` +
    `• \`!${id} help\`, \`!${id} rules\` also work`
  );
}

export const __testables = {
  parseRangeToken,
  parseDrawList,
  fmtList,
  buildRemainingArray,
};

function rulesText(id) {
  return (
    `**Bingo rules (simple)**\n` +
    `1) Start a game with a number range, like \`!${id} 1-151\`.\n` +
    `2) Each time you run \`!${id}draw\`, the bot picks a random number in that range that hasn’t been drawn yet.\n` +
    `3) The bot keeps a running list of everything drawn.\n` +
    `4) When all numbers are drawn, the game ends automatically.\n\n` +
    `Notes:\n` +
    `• This bingo is **guild-scoped**, not channel-scoped — you can draw in one channel and post the list in another.\n` +
    `• Host/admin can cancel anytime with \`!cancel${id}\`.`
  );
}

/* --------------------------------- game ---------------------------------- */

export function registerBingo(register) {
  const id = "bingo";
  const prettyName = "Bingo";

  // Guild-scoped (one per server). Not channel-scoped by design.
  const manager = createGameManager({ id, prettyName, scope: "guild" });

  // IMPORTANT: we intentionally do NOT enforce same-channel usage for Bingo.
  // The framework QoL helpers call requireSameChannel internally, so we override
  // the manager channel guard to always allow.
  manager.isSameChannel = () => true;

  async function endGame(ctx, state, reason) {
    manager.stop(ctx);
    await reply(ctx, `🏁 **Bingo ended** (${reason}).\nDrawn (${state.drawn.length}/${state.size}): ${fmtList(state.drawn)}`);
  }

  async function drawNext({ message }) {
    const st = await requireActive({ message, guildId: message.guildId, channelId: message.channelId }, manager);
    if (!st) return;

    const remainingArr = buildRemainingArray(st);
    if (remainingArr.length === 0) {
      await endGame({ message, guildId: message.guildId }, st, "no numbers left to draw");
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
      await endGame({ message, guildId: message.guildId }, st, "no numbers left to draw");
    }
  }

  async function showList({ message }) {
    const st = manager.getState({ message, guildId: message.guildId });
    if (!st) {
      await reply({ message }, manager.noActiveText());
      return;
    }
    await reply({ message }, `Drawn (${st.drawn.length}/${st.size}): ${fmtList(st.drawn)}`);
  }

  async function startOrResume({ message, rest }) {
    if (!message.guildId) return;

    const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      await reply({ message }, `Usage: \`!${id} <min-max> [optional drawnlist]\`\nTry: \`!${id}help\``);
      return;
    }

    const range = parseRangeToken(tokens[0]);
    if (!range) {
      await reply({ message }, "❌ Invalid range. Use `min-max` (example: `1-151`).");
      return;
    }

    const min = clampInt(range.min, 1, 1_000_000_000);
    const max = clampInt(range.max, 1, 1_000_000_000);
    if (min == null || max == null) {
      await reply({ message }, "❌ Range values must be **positive integers**.");
      return;
    }
    if (min >= max) {
      await reply({ message }, "❌ Invalid range. Must be `min < max` (example: `1-151`).");
      return;
    }

    const size = max - min + 1;
    if (size > 50_000) {
      await reply({ message }, "❌ Range too large (max 50,000 numbers).");
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
        await reply({ message }, "❌ Resume list contains a non-integer value.");
        return;
      }
      if (x < min || x > max) {
        await reply({ message }, `❌ Resume list value \`${x}\` is out of range (${min}-${max}).`);
        return;
      }
      if (drawnSet.has(x)) {
        await reply({ message }, `❌ Resume list contains a duplicate: \`${x}\`.`);
        return;
      }
      drawnSet.add(x);
      drawn.push(x);
    }

    if (drawn.length > size) {
      await reply({ message }, "❌ Resume list cannot be larger than the range size.");
      return;
    }

    const start = manager.tryStart(
      { message, guildId: message.guildId, channelId: message.channelId },
      {
        guildId: message.guildId,
        startChannelId: message.channelId,
        creatorId: message.author.id,
        min,
        max,
        size,
        drawn,
        drawnSet,
        createdAtMs: nowMs(),
      }
    );

    if (!start.ok) {
      await reply({ message }, start.errorText);
      return;
    }

    const st = start.state;

    // Auto-end if already complete
    if (st.drawn.length === st.size) {
      await endGame({ message, guildId: message.guildId }, st, "all numbers already drawn (resume complete)");
      return;
    }

    const remaining = st.size - st.drawn.length;
    const resumeNote = st.drawn.length ? ` (resumed with ${st.drawn.length} already drawn)` : "";
    const startCh = st.startChannelId ? channelMention(st.startChannelId) : "(unknown channel)";

    await message.channel.send(
      `✅ **Bingo started** — Range: **${st.min}-${st.max}** (${st.size} total)${resumeNote}\n` +
        `Host: ${mention(st.creatorId)} • Started in: ${startCh}\n` +
        `Remaining: **${remaining}**\n` +
        `Draw with \`!${id}draw\`. View list with \`!${id}list\`. Cancel with \`!cancel${id}\`.`
    );
  }

  /* ------------------------------ registrations ------------------------------ */

  // Framework-standard QoL commands: !bingohelp/!bingorules/!bingostatus/!cancelbingo (+ !endbingo hidden)
  makeGameQoL(register, {
    manager,
    id,
    prettyName,
    helpText: helpText(id),
    rulesText: rulesText(id),
    manageDeniedText: "Nope — only admins or the bingo starter can use that.",
    renderStatus: (st) => {
      const started = st.startChannelId ? channelMention(st.startChannelId) : "(unknown channel)";
      const remaining = st.size - st.drawn.length;
      return (
        `✅ **Bingo is running** (guild-scoped)\n` +
        `Range: **${st.min}-${st.max}** (${st.size} total)\n` +
        `Drawn: **${st.drawn.length}** • Remaining: **${remaining}**\n` +
        `Host: ${mention(st.creatorId)} • Started in: ${started}\n` +
        `Commands can be used from **any channel** in this server.`
      );
    },
    cancel: async (st, ctx) => {
      await endGame({ message: ctx.message, guildId: ctx.message.guildId }, st, "cancelled");
    },
    end: async (st, ctx) => {
      await endGame({ message: ctx.message, guildId: ctx.message.guildId }, st, "ended");
    },
  });

  // Primary command: !bingo (supports "!bingo help" and "!bingo rules")
  register(
    `!${id}`,
    withGameSubcommands({
      helpText: helpText(id),
      rulesText: rulesText(id),
      onStart: startOrResume,
      onStatus: async ({ message }) => {
        // Route to the framework status command behavior for consistent output.
        const st = manager.getState({ message, guildId: message.guildId });
        if (!st) {
          await reply({ message }, manager.noActiveText());
          return;
        }
        const remaining = st.size - st.drawn.length;
        const started = st.startChannelId ? channelMention(st.startChannelId) : "(unknown channel)";
        await reply(
          { message },
          `✅ **Bingo is running** (guild-scoped)\n` +
            `Range: **${st.min}-${st.max}** (${st.size} total)\n` +
            `Drawn: **${st.drawn.length}** • Remaining: **${remaining}**\n` +
            `Host: ${mention(st.creatorId)} • Started in: ${started}`
        );
      },
    }),
    `!${id} <min-max> [drawnlist] — start/resume Bingo (example: \`!${id} 1-151 5,12,77\`)`,
    { helpTier: "primary" }
  );

  // Namespaced commands (visible)
  register(
    `!${id}draw`,
    async ({ message }) => {
      await drawNext({ message });
    },
    `• !${id}draw — draw a new number (no repeats)`,
    { helpTier: "normal" }
  );

  register(
    `!${id}list`,
    async ({ message }) => {
      await showList({ message });
    },
    `• !${id}list — show drawn numbers`,
    { helpTier: "normal" }
  );
}
