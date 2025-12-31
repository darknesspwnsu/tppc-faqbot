// games/exploding_voltorbs.js
//
// Exploding Voltorbs:
// - One game active per guild
// - Starter provides a taglist (mentions) OR uses reaction join
// - Default mode: suddendeath (first boom ends the game)
// - Optional mode: elim (boom eliminates holder; continues until one player remains)
// - Someone "holds" the Voltorb, can pass via mention (cannot pass to self)
// - Optional flag: nopingpong (prevents immediate pass-back while 3+ alive)
//
// UX improvements:
// - Cooloff between rounds (10-15s) before next holder announcement + scheduling
// - In elim mode: show remaining players after each explosion
// - End game cleanly to prevent “extra message after win”
// - Add spacing between successive bot messages by bundling round output into fewer sends
// - FIX: do not “tick” for next holder before "Next up" message (suppress scares during cooloff)

import {
  collectEntrantsByReactionsWithMax,
  createGameManager,
  withGameSubcommands,
  assignContestRoleForEntrants,
  scheduleRoundCooldown,
} from "./framework.js";
import { getMentionedUsers, parseMentionToken, registerHelpAndRules } from "./helpers.js";
import { isAdminOrPrivileged } from "../auth.js";

const manager = createGameManager({
  id: "exploding_voltorbs",
  prettyName: "Exploding Voltorbs",
  scope: "guild",
});

const scareMessages = [
  "⚡ The Voltorb crackles ominously...",
  "💣 You hear an unsettling *tick... tick... tick...*",
  "😈 The bot whispers: *it’s totally safe* (it isn’t).",
  "👀 Everyone stares at the Voltorb.",
  "🧨 The fuse looks... shorter than before."
];

const ROUND_COOLOFF_MIN_SEC = 10;
const ROUND_COOLOFF_MAX_SEC = 15;

function evHelpText() {
  return [
    "**Exploding Voltorbs — Help**",
    "",
    "**Start game:**",
    "• Using a list: `!ev [min-max] [mode] [nopingpong] @user1 @user2 ...`",
    "  – Example: `!ev 30-90s elim nopingpong @a @b @c`",
    "",
    "• Using reactions: `!ev [min-max] [mode] [nopingpong] [join_window]`",
    "  – Join window is between 10 to 120 seconds",
    "  – Example: `!ev 10-25s elim nopingpong 60s`",
    "",
    "**Modes:**",
    "• `elim` — exploding player is eliminated; game continues until one remains",
    "• `suddendeath` (or `sd`) — first person to explode loses; game ends",
    "",
    "**Optional flags:**",
    "• `nopingpong` — prevents immediate pass-back while 3+ players remain",
    "",
    "**During the game:**",
    "• `!pass @user` — the current holder can pass the Voltorb to a participant",
    "• `!endvoltorb` — admins only; force end",
    ""
  ].join("\n");
}

function evRulesText() {
  return [
    "**Exploding Voltorbs — Rules (layman)**",
    "",
    "A Voltorb is passed between players.",
    "After a random delay, it **explodes** on the current holder.",
    "",
    "**Modes:**",
    "• `suddendeath` — first explosion ends the game.",
    "• `elim` — exploded player is out; keep going until one remains.",
    "",
    "**Passing:**",
    "• Only the current holder can use `!pass @user`.",
    "• `nopingpong` prevents immediate pass-back while 3+ players remain.",
  ].join("\n");
}

const EV_HELP = evHelpText();
const EV_RULES = evRulesText();

function parseRangeToken(token) {
  if (!token) return null;
  const m = String(token).trim().match(/^(\d+)-(\d+)\s*(s|sec|secs|second|seconds)?$/i);
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2]) };
}

function parseModeToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  if (t === "elim" || t === "elimination") return "elim";
  if (t === "suddendeath" || t === "sd") return "suddendeath";
  return null;
}

function parseJoinWindowToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  if (t.includes("-")) return null;
  const m = /^(\d+)(s)?$/.exec(t);
  if (!m) return null;
  return Number(m[1]);
}

function parseFlagToken(token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  if (t === "nopingpong" || t === "nopong" || t === "antipong") return "nopingpong";
  return null;
}

function randChoiceFromSet(set) {
  const arr = Array.from(set);
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getStartChannel(game) {
  if (!game?.client || !game?.channelId) return null;
  const cached = game.client.channels?.cache?.get?.(game.channelId);
  if (cached) return cached;
  return await game.client.channels.fetch(game.channelId).catch(() => null);
}

async function sendToStartChannel(game, content) {
  const channel = await getStartChannel(game);
  if (!channel?.send) return false;
  await channel.send(content);
  return true;
}

function endGame(guildId) {
  return manager.stop({ guildId });
}

function formatRemainingList(aliveIds) {
  const ids = Array.from(aliveIds || []);
  if (!ids.length) return "(none)";
  return ids.map((id) => `<@${id}>`).join(", ");
}

function randCooloffMs() {
  const sec =
    Math.floor(Math.random() * (ROUND_COOLOFF_MAX_SEC - ROUND_COOLOFF_MIN_SEC + 1)) + ROUND_COOLOFF_MIN_SEC;
  return sec * 1000;
}

function scheduleExplosion(game) {
  const g = manager.getState({ guildId: game.guildId });
  if (!g) return;

  const explodeDelayMs =
    (Math.floor(Math.random() * (g.maxSeconds - g.minSeconds + 1)) + g.minSeconds) * 1000;

  g.timers.setTimeout(async () => {
    const live = manager.getState({ guildId: g.guildId });
    if (!live) return;

    const blownId = live.holderId;

    if (live.mode === "suddendeath") {
      const ended = endGame(live.guildId);
      if (!ended) return;

      await sendToStartChannel(
        ended,
        `💥 **BOOM!** <@${blownId}> was holding the Voltorb and got blown up!\n\n` +
          `🏁 **Game over!** (suddendeath)`
      );
      return;
    }

    // elim mode
    live.aliveIds.delete(blownId);

    // If game is now won, end cleanly BEFORE sending final
    if (live.aliveIds.size <= 1) {
      const winnerId = randChoiceFromSet(live.aliveIds);
      const ended = endGame(live.guildId);
      if (!ended) return;

      if (winnerId) {
        await sendToStartChannel(
          ended,
          `💥 **BOOM!** <@${blownId}> was holding the Voltorb and got blown up!\n\n` +
            `Remaining: ${formatRemainingList(new Set([winnerId]))}\n\n` +
            `🏆 <@${winnerId}> wins **Exploding Voltorbs**!`
        );
      } else {
        await sendToStartChannel(
          ended,
          `💥 **BOOM!** <@${blownId}> was holding the Voltorb and got blown up!\n\n` +
            `🏁 Game ended — no winner (everyone exploded?).`
        );
      }
      return;
    }

    // Round cooloff + next holder (FIX: do not set holderId until round begins)
    const remainingLine = `Remaining: ${formatRemainingList(live.aliveIds)}`;
    const cooloffMs = randCooloffMs();
    const cooloffSec = Math.round(cooloffMs / 1000);

    const nextHolderId = randChoiceFromSet(live.aliveIds);

    // Enter cooloff state; suppress scare ticks; hold next holder pending
    live.pendingHolderId = nextHolderId;
    live.coolingOff = true;

    // Reset pingpong memory each explosion (new "round" baseline)
    // This prevents weird edge cases where lastHolderId points to someone already eliminated.
    live.lastHolderId = null;

    const channel = await getStartChannel(live);
    await scheduleRoundCooldown({
      state: live,
      manager,
      channel,
      delayMs: cooloffMs,
      message:
        `💥 **BOOM!** <@${blownId}> was holding the Voltorb and got blown up!\n\n` +
        `${remainingLine}\n\n` +
        `⏳ Next round in **${cooloffSec}s**...`,
      onStart: async (still) => {
        // Round begins now
        if (still.pendingHolderId) {
          still.holderId = still.pendingHolderId;
        } else {
          // Fallback: should never happen, but stay safe
          still.holderId = randChoiceFromSet(still.aliveIds);
        }
        still.pendingHolderId = null;
        still.coolingOff = false;

        await sendToStartChannel(still, `🔄 Next up: <@${still.holderId}> is now holding the Voltorb!`);
        scheduleExplosion(still);
      },
    });
  }, explodeDelayMs);
}

function scheduleScares(game) {
  game.timers.setInterval(async () => {
    const g = manager.getState({ guildId: game.guildId });
    if (!g) return;

    // FIX: don't “tick” during the between-round cooloff
    if (g.coolingOff) return;

    if (Math.random() < 0.30) {
      const scare = scareMessages[Math.floor(Math.random() * scareMessages.length)];
      await sendToStartChannel(g, `${scare}\n\n👀 <@${g.holderId}> is holding the Voltorb.`);
    }
  }, 8000);
}

async function startGameFromIds(message, idSet, rangeArg, modeArg, flags = {}, { assignRole = false } = {}) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const existing = manager.getState({ guildId });
  if (existing) {
    message.reply("⚠️ Exploding Voltorbs is already running!");
    return;
  }

  const allowedIds = new Set([...idSet].filter(Boolean));
  const aliveIds = new Set(allowedIds);

  if (aliveIds.size < 2) {
    message.reply("❌ You need at least 2 players to start.");
    return;
  }

  const DEFAULT_MIN = 30;
  const DEFAULT_MAX = 90;
  const MAX_ALLOWED = 600;

  let minSeconds = DEFAULT_MIN;
  let maxSeconds = DEFAULT_MAX;

  if (rangeArg) {
    const parsed = parseRangeToken(rangeArg);
    if (!parsed) {
      message.reply("❌ Use `min-max` seconds (example: `30-90` or `30-90s`)");
      return;
    }

    minSeconds = parsed.min;
    maxSeconds = parsed.max;

    if (
      !Number.isFinite(minSeconds) ||
      !Number.isFinite(maxSeconds) ||
      minSeconds < 5 ||
      maxSeconds > MAX_ALLOWED ||
      minSeconds >= maxSeconds
    ) {
      message.reply(`❌ Range must be 5–${MAX_ALLOWED} seconds, min < max.`);
      return;
    }
  }

  const mode = modeArg || "suddendeath";
  const holderId = randChoiceFromSet(aliveIds);
  if (!holderId) {
    message.reply("❌ Could not choose a starting holder.");
    return;
  }

  const res = manager.tryStart(
    { guildId },
    {
      guildId,
      channelId: message.channelId,
      creatorId: message.author?.id || null,
      client: message.client,
      holderId,
      lastHolderId: null,
      allowedIds,
      aliveIds,
      mode,
      minSeconds,
      maxSeconds,
      noPingPong: !!flags.noPingPong,
      coolingOff: false,
      pendingHolderId: null,
    }
  );

  if (!res.ok) {
    message.reply("⚠️ Exploding Voltorbs is already running!");
    return;
  }

  if (assignRole) {
    const { assignment } = await assignContestRoleForEntrants({ message }, aliveIds);
    if (assignment) res.state.contestRoleAssignment = assignment;
  }

  const flagLine = flags.noPingPong ? "\n🚫 Ping-pong: **disabled** (3+ alive)" : "";

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
      `🎮 Mode: **${mode}**${flagLine}\n` +
      `⏱️ Explosion time: **${minSeconds}–${maxSeconds} seconds**\n` +
      `👥 Players: ${Array.from(aliveIds).map((id) => `<@${id}>`).join(", ")}\n\n` +
      `💣 <@${holderId}> is holding the Voltorb!`
  );

  scheduleScares(res.state);
  scheduleExplosion(res.state);

  return res.state;
}

export async function startExplodingVoltorbsFromIds(message, idSet, rangeArg, modeArg, flags = {}, options = {}) {
  return await startGameFromIds(message, idSet, rangeArg, modeArg, flags, options);
}

export async function startExplodingVoltorbs(message, rangeArg, modeArg, flags = {}) {
  const mentioned = getMentionedUsers(message);
  const allowedIds = new Set();
  for (const u of mentioned) {
    if (!u?.id) continue;
    if (u.bot) continue;
    allowedIds.add(u.id);
  }

  if (allowedIds.size < 2) {
    message.reply("❌ You need to tag at least 2 players to start.");
    return;
  }

  return await startGameFromIds(message, allowedIds, rangeArg, modeArg, flags);
}

export function passVoltorb(message) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = manager.getState({ guildId });
  if (!game) {
    message.reply("❌ No active Voltorb game.");
    return;
  }

  if (game.channelId && message.channelId !== game.channelId) {
    message.reply(`❌ This game is running in <#${game.channelId}>. Please use commands there.`);
    return;
  }

  // Only participants can interact with the game
  if (game.allowedIds && !game.allowedIds.has(message.author?.id)) {
    message.reply("❌ You are not in this Voltorb game.");
    return;
  }

  // Only the current holder can pass
  if (game.holderId !== message.author?.id) {
    message.reply(`❌ Only the current holder can pass. Current holder: <@${game.holderId}>.`);
    return;
  }

  const target = message.mentions?.users?.first?.();
  if (!target) {
    message.reply("❌ Mention someone to pass it to!");
    return;
  }

  if (target.bot) {
    message.reply("🤖 Bots cannot hold Voltorbs.");
    return;
  }

  if (target.id === message.author.id) {
    message.reply("❌ You can’t pass the Voltorb to yourself.");
    return;
  }

  if (game.allowedIds && !game.allowedIds.has(target.id)) {
    message.reply("❌ That player isn’t in the game.");
    return;
  }

  if (game.mode === "elim" && game.aliveIds && !game.aliveIds.has(target.id)) {
    message.reply("❌ That player has already been eliminated.");
    return;
  }

  // nopingpong: prevent immediate pass-back while 3+ active players remain (any mode)
  // ignored at 2 players, since ping-pong is unavoidable
  if (game.noPingPong && game.aliveIds?.size >= 3) {
    // lastHolderId is who passed it to the current holder on the previous pass
    if (game.lastHolderId && target.id === game.lastHolderId) {
      message.reply("🚫 No ping-pong! You can’t pass it straight back — pick someone else.");
      return;
    }
  }

  // Update pingpong memory + holder
  game.lastHolderId = message.author.id;
  game.holderId = target.id;

  message.channel.send(
    `🔁 <@${message.author.id}> passed the Voltorb to <@${target.id}>!\n\n` +
      `💣 The ticking continues...`
  );
}

export const __testables = {
  parseMentionToken,
  parseRangeToken,
  parseModeToken,
  parseJoinWindowToken,
  parseFlagToken,
  formatRemainingList,
};

export function endVoltorbGame(message, { reason = "ended" } = {}) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = manager.getState({ guildId });
  if (!game) {
    message.reply("❌ No active Voltorb game.");
    return;
  }

  if (game.channelId && message.channelId !== game.channelId) {
    message.reply(`❌ This game is running in <#${game.channelId}>. Please use commands there.`);
    return;
  }

  endGame(guildId);
  message.channel.send(`🧯 Voltorb game ${reason}.`);
}

/**
 * Command wiring for this game
 */
export function registerExplodingVoltorbs(register) {
  registerHelpAndRules(register, {
    id: "ev",
    label: "Exploding Voltorbs",
    helpText: EV_HELP,
    rulesText: EV_RULES,
  });

  register(
    "!ev",
    withGameSubcommands({
      helpText: EV_HELP,
      rulesText: EV_RULES,
      onStart: async ({ message, rest }) => {
        if (!message.guild) return;

        const tokens = rest.trim().split(/\s+/).filter(Boolean);

        if (tokens.length === 0) {
          await message.reply(
            "❌ Use: `!ev [min-max] [mode] [nopingpong] [@player list]/[join_window]`.\nType `!ev help` for more info."
          );
          return;
        }

        let rangeArg = null;
        let modeArg = null;
        let joinSeconds = null;
        let noPingPong = false;

        for (let i = 0; i < Math.min(tokens.length, 6); i++) {
          if (!rangeArg && parseRangeToken(tokens[i])) rangeArg = tokens[i];
          if (!modeArg && parseModeToken(tokens[i])) modeArg = parseModeToken(tokens[i]);

          const js = parseJoinWindowToken(tokens[i]);
          if (joinSeconds == null && js != null) joinSeconds = js;

          const fl = parseFlagToken(tokens[i]);
          if (fl === "nopingpong") noPingPong = true;
        }

        const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
        if (hasMentions && joinSeconds != null) {
          await message.reply("❌ Join window only works with reaction-join (no @mention list).");
          return;
        }

        if (joinSeconds != null) {
          if (!Number.isFinite(joinSeconds) || joinSeconds < 10 || joinSeconds > 120) {
            await message.reply("❌ Join window must be between 10 and 120 seconds.");
            return;
          }
        }

        // Validate tokens: apart from range/mode/flags/mentions/joinSeconds, no extras
        const consumed = new Set();
        for (const t of tokens) {
          if (rangeArg && t === rangeArg) consumed.add(t);

          const m = parseModeToken(t);
          if (m && modeArg === m) consumed.add(t);

          const fl = parseFlagToken(t);
          if (fl) consumed.add(t);

          const js = parseJoinWindowToken(t);
          if (js != null && joinSeconds === js) consumed.add(t);

          if (parseMentionToken(t)) consumed.add(t);
        }
        const extras = tokens.filter((t) => !consumed.has(t));
        if (extras.length > 0) {
          await message.reply(
            "❌ Use: `!ev [min-max] [mode] [nopingpong] [@player list]/[join_window]`.\nType `!ev help` for more info."
          );
          return;
        }

        const flags = { noPingPong };

        // Reaction-join path if no mentions
        if (!hasMentions) {
          const modeLabel = modeArg || "suddendeath";
          const modeLabelCapitalized = modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1);
          const rangeLabel = rangeArg ? ` • Range: **${rangeArg}**` : "";
          const flagLabel = noPingPong ? ` • Ping-pong: **OFF**` : "";
          const durationMs = (joinSeconds ?? 15) * 1000;

          const { entrants } = await collectEntrantsByReactionsWithMax({
            channel: message.channel,
            promptText:
              `React to join **Exploding Voltorbs**! (join window: ${joinSeconds ?? 15}s)\n` +
              `Mode: **${modeLabelCapitalized}**${rangeLabel}${flagLabel}`,
            durationMs,
            dispose: true,
            trackRemovals: true,
          });

          if (entrants.size < 2) {
            await message.channel.send("❌ Not enough players joined (need at least 2).");
            return;
          }

          await startExplodingVoltorbsFromIds(message, entrants, rangeArg, modeArg, flags, { assignRole: true });
          return;
        }

        // Mention-based start path
        await startExplodingVoltorbs(message, rangeArg, modeArg, flags);
      },
    }),
    "!ev [min-max[s|sec|seconds]] [elim|suddendeath] [nopingpong] @players — start Exploding Voltorbs (default 30-90s, default mode suddendeath). If no @players, uses reaction join.",
    { helpTier: "primary", aliases: ["!explodingvoltorbs", "!voltorb"] }
  );

  register(
    "!pass",
    async ({ message }) => {
      if (!message.guild) return;
      passVoltorb(message);
    },
    "!pass @user — pass the Voltorb (only holder can pass)",
    { hideFromHelp: true, aliases: ["!passvoltorb", "!pv", "!passv"] }
  );

  register(
    "!endvoltorb",
    async ({ message }) => {
      if (!message.guild) return;
      if (!isAdminOrPrivileged(message)) {
        await message.reply("Nope — only admins can end the Voltorb game.");
        return;
      }
      endVoltorbGame(message, { reason: "ended early" });
    },
    "!endvoltorb — force-end Exploding Voltorbs (admin)",
    { admin: true, aliases: ["!stopvoltorb", "!cancelvoltorb", "!endev", "!stopev", "!cancelev"] }
  );
}
