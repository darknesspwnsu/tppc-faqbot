// games/explodingVoltorbs.js
//
// Exploding Voltorbs:
// - One game active per guild
// - Starter provides a taglist (mentions). Only tagged players can play.
// - Default mode: suddendeath (first boom ends the game)
// - Optional mode: elim (boom eliminates holder; continues until one player remains)
// - Someone "holds" the Voltorb, can pass via mention (cannot pass to self)

import { collectEntrantsByReactions } from "../contests.js";
import { isAdminOrPrivileged } from "../auth.js";

const activeGames = new Map(); // guildId -> { holderId, aliveIds:Set, allowedIds:Set, mode, minSeconds, maxSeconds, explosionTimeout, scareInterval }

const scareMessages = [
  "⚡ The Voltorb crackles ominously...",
  "💣 You hear an unsettling *tick... tick... tick...*",
  "😈 The bot whispers: *it’s totally safe* (it isn’t).",
  "👀 Everyone stares at the Voltorb.",
  "🧨 The fuse looks... shorter than before."
];

function evHelpText() {
  return [
    "**Exploding Voltorbs — Help**",
    "",
    "**Start game:**",
    "• Using a list: `!ev [min-max] [mode] @user1 @user2 ...`",
    "  – Example: `!ev 30-90s elim @a @b @c`",
    "",
    "• Using reactions: `!ev [min-max] [mode] [join_window]`",
    "  – Join window is between 10 to 120 seconds",
    "  – Example: `!ev 10-25s elim 60s`",
    "",
    "**Modes:**",
    "• `elim` — exploding player is eliminated; game continues until one remains",
    "• `suddendeath` (or `sd`) — first person to explode loses; game ends",
    "",
    "**During the game:**",
    "• `!pass @user` — the current holder can pass the Voltorb to a participant",
    "• `!endvoltorb` — admins only; force end",
    ""
  ].join("\n");
}

function parseMentionToken(token) {
  // Discord mention tokens look like <@123> or <@!123>
  const m = /^<@!?(\d+)>$/.exec(String(token ?? "").trim());
  return m ? m[1] : null;
}

function getMentionedUsers(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

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

function randChoiceFromSet(set) {
  const arr = Array.from(set);
  return arr[Math.floor(Math.random() * arr.length)];
}

function clearGameTimers(game) {
  if (!game) return;
  try {
    if (game.explosionTimeout) clearTimeout(game.explosionTimeout);
  } catch {}
  try {
    if (game.scareInterval) clearInterval(game.scareInterval);
  } catch {}
}

function scheduleExplosion(message, guildId) {
  const game = activeGames.get(guildId);
  if (!game) return;

  try {
    if (game.explosionTimeout) clearTimeout(game.explosionTimeout);
  } catch {}

  const { minSeconds, maxSeconds } = game;
  const explodeDelayMs =
    (Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds) * 1000;

  game.explosionTimeout = setTimeout(async () => {
    const g = activeGames.get(guildId);
    if (!g) return;

    const blownId = g.holderId;

    await message.channel.send(
      `💥 **BOOM!** <@${blownId}> was holding the Voltorb and got blown up!`
    );

    if (g.mode === "suddendeath") {
      // End immediately after first boom
      clearGameTimers(g);
      activeGames.delete(guildId);
      return;
    }

    // Elim mode: remove blown player and continue until one remains
    g.aliveIds.delete(blownId);

    if (g.aliveIds.size <= 1) {
      const winnerId = randChoiceFromSet(g.aliveIds);
      if (winnerId) {
        await message.channel.send(`🏆 <@${winnerId}> wins **Exploding Voltorbs**!`);
      } else {
        await message.channel.send("🏁 Game ended — no winner (everyone exploded?).");
      }
      clearGameTimers(g);
      activeGames.delete(guildId);
      return;
    }

    // Choose next holder from remaining alive players
    g.holderId = randChoiceFromSet(g.aliveIds);

    await message.channel.send(
      `🔄 Next up: <@${g.holderId}> is now holding the Voltorb! (elim continues)`
    );

    // Schedule next explosion round
    scheduleExplosion(message, guildId);
  }, explodeDelayMs);
}

export function startExplodingVoltorbsFromIds(message, idSet, rangeArg, modeArg) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  if (activeGames.has(guildId)) {
    message.reply("⚠️ Exploding Voltorbs is already running!");
    return;
  }

  // Only players explicitly in idSet are enrolled (starter is NOT auto-enrolled).
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

  const mode = modeArg || "suddendeath"; // default per your preference

  // Pick random initial holder from enrolled players
  const holderId = randChoiceFromSet(aliveIds);
  if (!holderId) {
    message.reply("❌ Could not choose a starting holder.");
    return;
  }

  const scareInterval = setInterval(() => {
    const g = activeGames.get(guildId);
    if (!g) return;

    if (Math.random() < 0.35) {
      const scare = scareMessages[Math.floor(Math.random() * scareMessages.length)];
      message.channel.send(
        `${scare}\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `👀 <@${g.holderId}> is holding the Voltorb.\n` +
        `━━━━━━━━━━━━━━━━━━━`
      );
    }
  }, 8000);

  activeGames.set(guildId, {
    holderId,
    allowedIds,
    aliveIds,
    mode,
    minSeconds,
    maxSeconds,
    explosionTimeout: null,
    scareInterval
  });

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
      `🎮 Mode: **${mode}**\n` +
      `⏱️ Explosion time: **${minSeconds}–${maxSeconds} seconds**\n` +
      `👥 Players: ${Array.from(aliveIds).map((id) => `<@${id}>`).join(", ")}`
      `💣 <@${holderId}> is holding the Voltorb!`
  );

  scheduleExplosion(message, guildId);
}

export function startExplodingVoltorbs(message, rangeArg, modeArg) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  if (activeGames.has(guildId)) {
    message.reply("⚠️ Exploding Voltorbs is already running!");
    return;
  }

  // Mention-based enrollment: ONLY mentioned users are enrolled.
  // (Starter is NOT auto-enrolled unless they tag themselves.)
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

  const mode = modeArg || "suddendeath"; // default per your request

  const aliveIds = new Set(allowedIds);

  // Pick random initial holder from tagged players
  const holderId = randChoiceFromSet(aliveIds);
  if (!holderId) return;

  const scareInterval = setInterval(() => {
    const g = activeGames.get(guildId);
    if (!g) return;

    if (Math.random() < 0.35) {
      const scare = scareMessages[Math.floor(Math.random() * scareMessages.length)];
      message.channel.send(`${scare}\n👀 <@${g.holderId}> is holding the Voltorb.`);
    }
  }, 8000);

  activeGames.set(guildId, {
    holderId,
    allowedIds,
    aliveIds,
    mode,
    minSeconds,
    maxSeconds,
    explosionTimeout: null,
    scareInterval
  });

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
      `🎮 Mode: **${mode}**\n` +
      `⏱️ Explosion time: **${minSeconds}–${maxSeconds} seconds**\n` +
      `👥 Players: ${Array.from(aliveIds).map((id) => `<@${id}>`).join(", ")}\n` +
      `💣 <@${holderId}> is holding the Voltorb!`
  );

  // Schedule first explosion
  scheduleExplosion(message, guildId);
}

export function passVoltorb(message) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = activeGames.get(guildId);
  if (!game) {
    message.reply("❌ No active Voltorb game.");
    return;
  }

  // Only participants can interact with the game
  if (game.allowedIds && !game.allowedIds.has(message.author?.id)) {
    //message.reply("❌ You’re not in this game’s taglist.");
    return;
  }

  // Only the current holder can pass
  if (game.holderId !== message.author?.id) {
    //message.reply("❌ You’re not holding the Voltorb!");
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

  // In elim mode, cannot pass to someone already eliminated
  if (game.mode === "elim" && game.aliveIds && !game.aliveIds.has(target.id)) {
    message.reply("❌ That player has already been eliminated.");
    return;
  }

  game.holderId = target.id;

  message.channel.send(
    `🔁 <@${message.author.id}> passed the Voltorb to <@${target.id}>!\n` + `💣 The ticking continues...`
  );
}

export function endVoltorbGame(message, { reason = "ended" } = {}) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = activeGames.get(guildId);
  if (!game) {
    message.reply("❌ No active Voltorb game.");
    return;
  }

  clearGameTimers(game);
  activeGames.delete(guildId);

  message.channel.send(`🧯 Voltorb game ${reason}.`);
}

/**
 * Command wiring for this game
 */
export function registerExplodingVoltorbs(register) {
  register(
    "!ev",
    async ({ message, rest }) => {
      if (!message.guild) return;

      // Tokens can include optional range + optional mode, in either order.
      // Examples:
      //   !ev @a @b
      //   !ev elim @a @b
      //   !ev 10-30s @a @b
      //   !ev 10-30s elim @a @b
      //   !ev elim 10-30s @a @b

      const tokens = rest.trim().split(/\s+/).filter(Boolean);

      // `!ev` with no arguments
      if (tokens.length === 0) {
        await message.reply(
          "❌ Use: `!ev [min-max] [mode] [@player list]/[join_window]`.\nType `!ev help` for more info."
        );
        return;
      }

      // `!ev help`
      if (tokens.length === 1 && ["help", "h", "?"].includes(tokens[0].toLowerCase())) {
        await message.reply(evHelpText());
        return;
      }

      let rangeArg = null;
      let modeArg = null;
      let joinSeconds = null;

      for (let i = 0; i < Math.min(tokens.length, 5); i++) {
        if (!rangeArg && parseRangeToken(tokens[i])) rangeArg = tokens[i];
        if (!modeArg && parseModeToken(tokens[i])) modeArg = parseModeToken(tokens[i]);
        const js = parseJoinWindowToken(tokens[i]);
        if (joinSeconds == null && js != null) joinSeconds = js;
      }

      const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
      if (hasMentions && joinSeconds != null) {
        await message.reply(
          "❌ Join window only works with reaction-join (no @mention list)."
        );
        return;
      }

      if (joinSeconds != null) {
        if (!Number.isFinite(joinSeconds) || joinSeconds < 10 || joinSeconds > 120) {
          await message.reply("❌ Join window must be between 10 and 120 seconds.");
          return;
        }
      }

      // Validate: apart from range/mode/mentions, no extra garbage tokens.
      // This prevents "!ev blahblah" from silently starting a reaction join.
      const consumed = new Set();
      for (const t of tokens) {
        if (rangeArg && t === rangeArg) consumed.add(t);

        const m = parseModeToken(t);
        if (m && modeArg === m) consumed.add(t);

        const js = parseJoinWindowToken(t);
        if (js != null && joinSeconds === js) consumed.add(t);

        if (parseMentionToken(t)) consumed.add(t);
      }
      const extras = tokens.filter((t) => !consumed.has(t));

      // Reaction-join path only allows [range] [mode] (or nothing).
      // Mention-based path allows [range] [mode] + mentions only.
      if (extras.length > 0) {
        await message.reply(
          "❌ Use: `!ev [min-max] [mode] [@player list]/[join_window]`.\nType `!ev help` for more info."
        );
        return;
      }

      // If no taglist is provided, run a reaction-join window (like !conteststart)
      if (!hasMentions) {
        const modeLabel = modeArg || "suddendeath";
        const modeLabelCapitalized = modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1);
        const rangeLabel = rangeArg ? ` • Range: **${rangeArg}**` : "";
        const durationMs = (joinSeconds ?? 15) * 1000;

        const reactMessage = await collectEntrantsByReactions({
          message,
          promptText:
            `React to join **Exploding Voltorbs**! (join window: ${joinSeconds ?? 15}s)\n` +
            `Mode: **${modeLabelCapitalized}**${rangeLabel}`,
          durationMs
        });

       if (entrants.size < 2) {
          try {
            await reactMessage.edit(
              reactMessage.content + "\n❌ Not enough players joined (need at least 2)."
            );
          } catch {
            await message.channel.send("❌ Not enough players joined (need at least 2).");
          }
          return;
        }

        // Starter is NOT auto-enrolled. Only reactors are players.
        startExplodingVoltorbsFromIds(message, entrants, rangeArg, modeArg);
        return;
      }

      // Mention-based start path
      startExplodingVoltorbs(message, rangeArg, modeArg);
    },
    "!ev [min-max[s|sec|seconds]] [elim|suddendeath] @players — start Exploding Voltorbs (default 30-90s, default mode suddendeath). If no @players, uses reaction join.",
    { helpTier: "primary", aliases: ["!explodingvoltorbs", "!voltorb"] }
  );

  // Pass (canonical)
  register(
    "!pass",
    async ({ message }) => {
      if (!message.guild) return;
      passVoltorb(message);
    },
    "!pass @user — pass the Voltorb (only holder can pass)",
    { hideFromHelp: true, aliases: ["!passvoltorb", "!pv", "!passv"] }
  );

  // End (admin-only)
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
