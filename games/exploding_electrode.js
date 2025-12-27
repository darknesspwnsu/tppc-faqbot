// games/explodingElectrode.js
//
// Exploding Electrode (Russian Roulette):
// - One game active per guild
// - Starter provides a taglist (mentions) OR uses reaction-join
// - Turn-based: current player must type !pick
// - Bag has N pokeballs, K of which are Electrodes
// - If player picks an Electrode -> eliminated (whited out)
// - If bag empties with >1 alive -> survivors win (or last-alive mode, see mode option)
//
// Commands:
// - !ee / !explodingelectrode [options...] [@players...]
// - !pick
// - !ee help
// - !endelectrode (admin)
//
// Options (similar spirit to !ev):
// - join=NN   (reaction join only; default 15; 5–120)
// - max=NN    (reaction join only; end join early when reached; 2–50)
// - balls=NN  (total pokeballs in bag; default players+2; >= players; <= players*3)
// - e=K       (# electrodes; default 1; 1..min(5, players-1))
// - turn=W/S  (warn/skip seconds; default 15/30; W>=5; S>W; S<=300)
// - mode=last|survivors  (default last)
//
// Flavor inspiration: your Team Rocket lines.

import { collectEntrantsByReactions } from "../contests.js";

const activeGames = new Map(); // guildId -> game state

const DEFAULTS = {
  joinSeconds: 15,
  maxPlayers: null,
  electrodes: 1,
  turnWarn: 15,
  turnSkip: 30,
  mode: "last"
};

const PICK_CMD_ALIASES = new Set(["!pick", "!p"]);
const EE_ALIASES = ["!explodingelectrode", "!electrode", "!ee"];

function eeHelpText() {
  return [
    "**Exploding Electrode — help**",
    "",
    "Exploding Electrode is **Russian roulette** with a bag of Poké Balls.",
    "One (or more) contains an **Electrode**. On your turn, type `!pick`.",
    "",
    "**Start a game (taglist):**",
    "• `!ee @user1 @user2 ...`",
    "• `!ee [balls=NN] [e=K] [turn=W/S] [mode=last|survivors] @user1 @user2 ...`",
    "  – Example: `!ee balls=12 e=2 turn=10/20 @a @b @c @d`",
    "",
    "**Start a game (reaction join):**",
    "• `!ee` — opens a 15s join window (react to enter)",
    "• `!ee [join=NN] [max=NN] [balls=NN] [e=K] [turn=W/S] [mode=last|survivors]`",
    "  – Example: `!ee join=20 max=8 balls=14 e=1`",
    "",
    "**Options:**",
    "• `join=NN` — join window in seconds (5–120). **Reaction-join only**",
    "• `max=NN` — max players (2–50). Ends join early. **Reaction-join only**",
    "• `balls=NN` — total Poké Balls in the bag (default: players+2; min players; max players*3)",
    "• `e=K` — number of Electrodes in the bag (default: 1; max: min(5, players-1))",
    "• `turn=W/S` — warn after W seconds, skip after S seconds (default 15/30)",
    "• `mode=last` — last alive wins (default)",
    "• `mode=survivors` — if the bag empties, everyone still alive wins",
    "",
    "**During the game:**",
    "• `!pick` — take a Poké Ball (only the current player can pick)",
    "• `!endelectrode` — admins only; force end",
    "",
    "Tip: If you type `!ee blahblah` by mistake, it will error — use `!ee help`."
  ].join("\n");
}

function parseMentionToken(token) {
  const m = /^<@!?(\d+)>$/.exec(String(token ?? "").trim());
  return m ? m[1] : null;
}

function getMentionedUsers(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function isAdminMember(message) {
  return (
    message.member?.permissions?.has("Administrator") ||
    message.member?.permissions?.has("ManageGuild")
  );
}

function parseJoinToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^join=(\d+)(s)?$/);
  return m ? Number(m[1]) : null;
}

function parseMaxToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^max=(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseBallsToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^balls=(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseElectrodesToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^e=(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseTurnToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^turn=(\d+)\/(\d+)$/);
  return m ? { warn: Number(m[1]), skip: Number(m[2]) } : null;
}

function parseModeToken(token) {
  const m = String(token ?? "").trim().toLowerCase().match(/^mode=(last|survivors)$/);
  return m ? m[1] : null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextAliveIndex(players, aliveSet, startIdx) {
  if (!players.length) return -1;
  for (let step = 1; step <= players.length; step++) {
    const idx = (startIdx + step) % players.length;
    if (aliveSet.has(players[idx])) return idx;
  }
  return -1;
}

function clearTurnTimers(game) {
  if (!game) return;
  try { if (game.warnTimeout) clearTimeout(game.warnTimeout); } catch {}
  try { if (game.skipTimeout) clearTimeout(game.skipTimeout); } catch {}
}

function clearAllTimers(game) {
  clearTurnTimers(game);
}

function endGame(guildId) {
  const game = activeGames.get(guildId);
  if (!game) return;
  clearAllTimers(game);
  activeGames.delete(guildId);
}

function computeDefaultsForPlayers(playerCount) {
  // Default bag size: players + 2 (sweet spot)
  const balls = Math.max(playerCount, playerCount + 2);
  return { balls };
}

async function promptTurn(channel, game) {
  clearTurnTimers(game);

  const pid = game.players[game.currentIndex];
  const remaining = game.bag.length;
  const aliveCount = game.aliveIds.size;

  await channel.send(
    `🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} remaining** • ` +
      `👥 **${aliveCount}** player${aliveCount === 1 ? "" : "s"} still standing\n` +
      `👉 <@${pid}>, pick a Poké Ball with \`!pick\`.`
  );

  // Warn then skip if no response
  game.warnTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    if (g.players[g.currentIndex] !== pid) return; // already advanced
    await channel.send(`⏳ <@${pid}>… hurry! What if **Team Rocket** comes back? 🚀`);
  }, game.turnWarn * 1000);

  game.skipTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    if (g.players[g.currentIndex] !== pid) return; // already advanced

    await channel.send(
      `😬 We can’t wait forever… We’ll have to continue **without <@${pid}>**.`
    );

    // Skip (not eliminated)
    const nextIdx = nextAliveIndex(g.players, g.aliveIds, g.currentIndex);
    if (nextIdx === -1) {
      // Shouldn't happen unless no alive
      await channel.send("🏁 Game ended — no one left to pick.");
      endGame(g.guildId);
      return;
    }

    g.currentIndex = nextIdx;
    await promptTurn(channel, g);
  }, game.turnSkip * 1000);
}

async function resolvePick(channel, game, pickerId) {
  if (!game.aliveIds.has(pickerId)) {
    await channel.send(`❌ <@${pickerId}> is already out.`);
    return;
  }

  if (game.players[game.currentIndex] !== pickerId) {
    await channel.send(`❌ Not your turn, <@${pickerId}>. Wait your turn!`);
    return;
  }

  clearTurnTimers(game);

  if (game.bag.length <= 0) {
    await channel.send("🎒 The bag is empty! Nothing left to pick.");
    await finalizeIfNeeded(channel, game);
    return;
  }

  // Draw one
  const draw = game.bag.pop(); // last element
  const remaining = game.bag.length;

  await channel.send(`🫳 <@${pickerId}> picked up a Poké Ball…`);

  if (draw === "E") {
    // Explosion!
    await channel.send(
      `🔴 …it’s an **Electrode**!\n` +
        `💥 **Electrode used EXPLOSION!** 💥\n` +
        `💥 **BLAMMO** 💥\n` +
        `☠️ <@${pickerId}> **whited out!**`
    );

    game.aliveIds.delete(pickerId);

    // If only one left, winner
    if (game.aliveIds.size <= 1) {
      const winnerId = Array.from(game.aliveIds)[0];
      if (winnerId) {
        await channel.send(
          `🏆 <@${winnerId}> wins **Exploding Electrode**! The Poké Balls are returned safely. 🚀`
        );
      } else {
        await channel.send("🏁 Everyone exploded… nobody wins. Team Rocket laughs in the distance. 🚀");
      }
      endGame(game.guildId);
      return;
    }

    // If bag empty after explosion, handle per mode
    if (remaining === 0) {
      await finalizeIfNeeded(channel, game);
      return;
    }

    // Advance turn to next alive after current index
    const nextIdx = nextAliveIndex(game.players, game.aliveIds, game.currentIndex);
    if (nextIdx === -1) {
      await channel.send("🏁 Game ended — no one left.");
      endGame(game.guildId);
      return;
    }
    game.currentIndex = nextIdx;

    await channel.send(
      `🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} remaining.** Next up: <@${game.players[game.currentIndex]}>`
    );

    await promptTurn(channel, game);
    return;
  }

  // Safe draw
  await channel.send(
    `🟢 …it’s empty. 😮‍💨\n` +
      `🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} left.**`
  );

  // If bag empty after safe draw, finalize
  if (remaining === 0) {
    await finalizeIfNeeded(channel, game);
    return;
  }

  // Next player's turn
  const nextIdx = nextAliveIndex(game.players, game.aliveIds, game.currentIndex);
  if (nextIdx === -1) {
    await channel.send("🏁 Game ended — no one left.");
    endGame(game.guildId);
    return;
  }
  game.currentIndex = nextIdx;

  await channel.send(`👉 Next up: <@${game.players[game.currentIndex]}>`);
  await promptTurn(channel, game);
}

async function finalizeIfNeeded(channel, game) {
  // Bag empty
  if (game.bag.length > 0) return;

  if (game.mode === "survivors") {
    const survivors = Array.from(game.aliveIds);
    if (!survivors.length) {
      await channel.send("🏁 The bag is empty… and nobody is left standing. 💀");
    } else {
      await channel.send(
        `🎒 The bag is empty! Everyone still standing wins:\n` +
          survivors.map((id) => `🏆 <@${id}>`).join("\n")
      );
    }
    endGame(game.guildId);
    return;
  }

  // mode=last: if more than one remains and bag empties, pick a "most survived" winner?
  // Keeping it simple: if bag empties and multiple alive, all are "survivors", but no single winner.
  const alive = Array.from(game.aliveIds);
  if (alive.length === 1) {
    await channel.send(`🏆 <@${alive[0]}> wins **Exploding Electrode**!`);
  } else if (alive.length > 1) {
    await channel.send(
      `🎒 The bag is empty! Nobody exploded at the end.\n` +
        `Survivors:\n` +
        alive.map((id) => `✅ <@${id}>`).join("\n")
    );
  } else {
    await channel.send("🏁 The bag is empty… and nobody is left standing. 💀");
  }

  endGame(game.guildId);
}

/* ----------------------------- join collection ----------------------------- */
/**
 * Your existing collectEntrantsByReactions() does not guarantee early-stop at max.
 * For Exploding Electrode, we implement a small local collector so:
 * - join ends at timeout OR when max is reached
 */
async function collectEntrantsByReactionsWithMax({ message, promptText, durationMs, maxEntrants }) {
  const joinMsg = await message.channel.send(promptText);
  const emoji = "✅";

  try {
    await joinMsg.react(emoji);
  } catch {
    // If react fails (missing perms), fallback to no entrants
    return new Set();
  }

  const entrants = new Set();
  const filter = (reaction, user) => {
    if (user.bot) return false;
    return reaction.emoji?.name === emoji;
  };

  return new Promise((resolve) => {
    const collector = joinMsg.createReactionCollector({ filter, time: durationMs });

    collector.on("collect", (_reaction, user) => {
      entrants.add(user.id);
      if (maxEntrants && entrants.size >= maxEntrants) {
        collector.stop("max");
      }
    });

    collector.on("end", () => resolve(entrants));
  });
}

/* ------------------------------- start helpers ------------------------------ */

function validateAndBuildGameConfig(playerCount, opts) {
  // electrodes
  let electrodes = opts.electrodes ?? DEFAULTS.electrodes;
  if (!Number.isFinite(electrodes) || electrodes < 1) electrodes = DEFAULTS.electrodes;

  const eMax = Math.min(5, Math.max(1, playerCount - 1));
  if (electrodes > eMax) {
    return { ok: false, err: `❌ \`e=\` is too high. Max for ${playerCount} players is ${eMax}.` };
  }

  // mode
  const mode = opts.mode || DEFAULTS.mode;

  // turn timers
  let turnWarn = opts.turnWarn ?? DEFAULTS.turnWarn;
  let turnSkip = opts.turnSkip ?? DEFAULTS.turnSkip;
  if (!Number.isFinite(turnWarn) || turnWarn < 5) turnWarn = DEFAULTS.turnWarn;
  if (!Number.isFinite(turnSkip) || turnSkip <= turnWarn || turnSkip > 300) turnSkip = DEFAULTS.turnSkip;

  // balls default
  const base = computeDefaultsForPlayers(playerCount).balls;
  let balls = opts.balls ?? base;
  if (!Number.isFinite(balls)) balls = base;

  const minBalls = playerCount;
  const maxBalls = playerCount * 3;

  if (balls < minBalls) {
    return { ok: false, err: `❌ \`balls=\` must be at least the number of players (${minBalls}).` };
  }
  if (balls > maxBalls) {
    return { ok: false, err: `❌ \`balls=\` too large. Max for ${playerCount} players is ${maxBalls}.` };
  }
  if (electrodes >= balls) {
    return { ok: false, err: `❌ Too many electrodes for the bag. Need \`e < balls\`.` };
  }

  return { ok: true, config: { electrodes, balls, turnWarn, turnSkip, mode } };
}

function buildBag(balls, electrodes) {
  const bag = [];
  for (let i = 0; i < electrodes; i++) bag.push("E");
  for (let i = electrodes; i < balls; i++) bag.push("B"); // safe ball
  shuffle(bag);
  return bag;
}

async function startExplodingElectrodeFromIds(message, idSet, parsedOpts) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  if (activeGames.has(guildId)) {
    await message.reply("⚠️ An Exploding Electrode game is already running!");
    return;
  }

  const players = Array.from(new Set([...idSet].filter(Boolean)));
  if (players.length < 2) {
    await message.reply("❌ You need at least 2 players to start.");
    return;
  }

  const v = validateAndBuildGameConfig(players.length, parsedOpts);
  if (!v.ok) {
    await message.reply(v.err);
    return;
  }

  const { electrodes, balls, turnWarn, turnSkip, mode } = v.config;
  const bag = buildBag(balls, electrodes);

  // pick a random starting player
  const startIdx = Math.floor(Math.random() * players.length);

  const aliveIds = new Set(players);

  const game = {
    kind: "electrode",
    guildId,
    players,
    aliveIds,
    currentIndex: startIdx,
    bag,
    electrodes,
    balls,
    turnWarn,
    turnSkip,
    mode,
    warnTimeout: null,
    skipTimeout: null
  };

  activeGames.set(guildId, game);

  await message.channel.send(
    `⚡ **Exploding Electrode started!**\n` +
      `🚀 Team Rocket is blasting off again! They dropped a heavy bag of Poké Balls…\n` +
      `🎒 Bag size: **${balls}** • Electrodes: **${electrodes}** • Mode: **${mode}**\n` +
      `⏳ Turn timers: warn **${turnWarn}s**, skip **${turnSkip}s**\n` +
      `👥 Players: ${players.map((id) => `<@${id}>`).join(", ")}\n` +
      `\n👉 First up: <@${players[startIdx]}> — type \`!pick\``
  );

  await promptTurn(message.channel, game);
}

async function startExplodingElectrodeFromMessageMentions(message, parsedOpts) {
  const mentioned = getMentionedUsers(message);
  const allowedIds = [];
  for (const u of mentioned) {
    if (!u?.id) continue;
    if (u.bot) continue;
    allowedIds.push(u.id);
  }
  await startExplodingElectrodeFromIds(message, new Set(allowedIds), parsedOpts);
}

/* --------------------------------- parsing -------------------------------- */

function parseEeOptions(tokens) {
  const opts = {
    joinSeconds: null,
    maxPlayers: null,
    balls: null,
    electrodes: null,
    turnWarn: null,
    turnSkip: null,
    mode: null
  };

  for (const t of tokens) {
    const j = parseJoinToken(t);
    if (j != null) opts.joinSeconds = j;

    const m = parseMaxToken(t);
    if (m != null) opts.maxPlayers = m;

    const b = parseBallsToken(t);
    if (b != null) opts.balls = b;

    const e = parseElectrodesToken(t);
    if (e != null) opts.electrodes = e;

    const tr = parseTurnToken(t);
    if (tr) {
      opts.turnWarn = tr.warn;
      opts.turnSkip = tr.skip;
    }

    const mo = parseModeToken(t);
    if (mo) opts.mode = mo;
  }

  return opts;
}

function validateJoinOptionsForMode(hasMentions, opts) {
  if (hasMentions) {
    if (opts.joinSeconds != null || opts.maxPlayers != null) {
      return { ok: false, err: "❌ `join=` and `max=` are only valid for reaction-join (no @mentions)." };
    }
    return { ok: true };
  }

  // reaction join validations
  const joinSeconds = opts.joinSeconds ?? DEFAULTS.joinSeconds;
  if (!Number.isFinite(joinSeconds) || joinSeconds < 5 || joinSeconds > 120) {
    return { ok: false, err: "❌ `join=NN` must be between 5 and 120 seconds (example: `!ee join=20`)." };
  }

  if (opts.maxPlayers != null) {
    const maxPlayers = opts.maxPlayers;
    if (!Number.isFinite(maxPlayers) || maxPlayers < 2 || maxPlayers > 50) {
      return { ok: false, err: "❌ `max=NN` must be between 2 and 50 (example: `!ee max=8`)." };
    }
  }

  // turn token sanity (optional, but useful to catch typos)
  if (opts.turnWarn != null || opts.turnSkip != null) {
    const w = opts.turnWarn ?? DEFAULTS.turnWarn;
    const s = opts.turnSkip ?? DEFAULTS.turnSkip;
    if (!Number.isFinite(w) || w < 5 || !Number.isFinite(s) || s <= w || s > 300) {
      return { ok: false, err: "❌ `turn=W/S` must be like `turn=15/30` with 5<=W<S<=300." };
    }
  }

  // mode sanity
  if (opts.mode && !["last", "survivors"].includes(opts.mode)) {
    return { ok: false, err: "❌ `mode=` must be `mode=last` or `mode=survivors`." };
  }

  // balls/e will be validated once we know player count
  return { ok: true };
}

function computeConsumedTokens(tokens, opts) {
  const consumed = new Set();

  for (const t of tokens) {
    if (parseMentionToken(t)) {
      consumed.add(t);
      continue;
    }
    if (parseJoinToken(t) != null && opts.joinSeconds === parseJoinToken(t)) consumed.add(t);
    if (parseMaxToken(t) != null && opts.maxPlayers === parseMaxToken(t)) consumed.add(t);
    if (parseBallsToken(t) != null && opts.balls === parseBallsToken(t)) consumed.add(t);
    if (parseElectrodesToken(t) != null && opts.electrodes === parseElectrodesToken(t)) consumed.add(t);

    const tr = parseTurnToken(t);
    if (tr && opts.turnWarn === tr.warn && opts.turnSkip === tr.skip) consumed.add(t);

    const mo = parseModeToken(t);
    if (mo && opts.mode === mo) consumed.add(t);
  }

  return consumed;
}

/* ------------------------------- registrations ------------------------------ */

export function registerExplodingElectrode(register) {
  // Start game
  register(
    "!ee",
    async ({ message, rest }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      if (activeGames.has(guildId)) {
        await message.reply("⚠️ An Exploding Electrode game is already running!");
        return;
      }

      const tokens = rest.trim().split(/\s+/).filter(Boolean);

      if (tokens.length === 1 && ["help", "h", "?"].includes(tokens[0].toLowerCase())) {
        await message.reply(eeHelpText());
        return;
      }

      const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
      const opts = parseEeOptions(tokens);

      // Validate join/max vs start mode (mentions vs reaction)
      const v = validateJoinOptionsForMode(hasMentions, opts);
      if (!v.ok) {
        await message.reply(v.err);
        return;
      }

      // Strict arg validation: if token isn't recognized, error out (like !ev)
      const consumed = computeConsumedTokens(tokens, opts);
      const extras = tokens.filter((t) => !consumed.has(t));
      if (extras.length > 0) {
        await message.reply(
          `❌ Unknown argument(s): ${extras.map((x) => `\`${x}\``).join(", ")}. Try \`!ee help\`.`
        );
        return;
      }

      // Mention/taglist mode
      if (hasMentions) {
        await startExplodingElectrodeFromMessageMentions(message, opts);
        return;
      }

      // Reaction join mode
      const joinSeconds = opts.joinSeconds ?? DEFAULTS.joinSeconds;
      const maxPlayers = opts.maxPlayers ?? null;

      const prompt =
        `⚡ **Exploding Electrode** — React to join! (join window: ${joinSeconds}s` +
        (maxPlayers ? `, max ${maxPlayers}` : "") +
        `)\n` +
        `📌 When it’s your turn, type \`!pick\`.\n`;

      // If maxPlayers is set, use the early-stop collector; otherwise, you can reuse your existing helper.
      let entrants;
      if (maxPlayers) {
        entrants = await collectEntrantsByReactionsWithMax({
          message,
          promptText: prompt,
          durationMs: joinSeconds * 1000,
          maxEntrants: maxPlayers
        });
      } else {
        entrants = await collectEntrantsByReactions({
          message,
          promptText: prompt,
          durationMs: joinSeconds * 1000
        });
      }

      if (!entrants || entrants.size < 2) {
        await message.channel.send("❌ Not enough players joined (need at least 2).");
        return;
      }

      await startExplodingElectrodeFromIds(message, entrants, opts);
    },
    "!ee [options...] [@players...] — start Exploding Electrode (taglist or reaction-join). Use `!ee help`.",
    { aliases: EE_ALIASES.filter((a) => a !== "!ee") }
  );

  // Pick command
  register(
    "!pick",
    async ({ message }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game) {
        await message.reply("❌ There is no active Exploding Electrode game.");
        return;
      }

      await resolvePick(message.channel, game, message.author.id);
    },
    "!pick — pick a Poké Ball (only on your turn)"
  );

  // End (admin-only)
  register(
    "!endelectrode",
    async ({ message }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game) {
        await message.reply("❌ There is no active Exploding Electrode game.");
        return;
      }

      if (!isAdminMember(message)) {
        await message.reply("Nope — only admins can end the Electrode game.");
        return;
      }

      endGame(guildId);
      await message.channel.send("🧯 Exploding Electrode game ended early.");
    },
    "!endelectrode — force-end Exploding Electrode (admin)",
    { admin: true, aliases: ["!stopelectrode"] }
  );
}

// Optional helper if you want to route aliases to the same handler in a message router.
// Your registry already supports aliases, so this is just here for clarity.
export const EXPLODING_ELECTRODE_ALIASES = EE_ALIASES;

// Small helper if you ever want to intercept raw message content for !pick aliases
export function isPickCommand(content) {
  return PICK_CMD_ALIASES.has(String(content || "").trim().toLowerCase());
}
