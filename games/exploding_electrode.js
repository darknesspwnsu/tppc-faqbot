// games/exploding_electrode.js
//
// Exploding Electrode (Russian Roulette):
// - One game active per guild (guild-scoped)
// - Game is bound to the **start channel** for gameplay commands (pick/end/etc)
// - Starter provides a taglist (mentions) OR uses reaction-join
// - Turn-based: current player must type !pick (alias !p)
// - Bag has N pokeballs, K of which are Electrodes
// - If player picks an Electrode -> eliminated
// - If bag empties with >1 alive -> mode decides outcome
//
// Commands (framework-aligned):
// - !ee (primary) supports: !ee help / !ee rules / !ee status
// - !eehelp, !eerules, !eestatus, !cancelee (framework QoL bundle)
// - !pick (turn action; kept legacy)
// - !endelectrode (legacy admin wrapper)
// - !endee (framework hidden hard-end)
//
// Options (same behavior as before):
// - join=NN   (reaction join only; default 15; 5–120)
// - max=NN    (reaction join only; end join early when reached; 2–50)
// - balls=NN  (total pokeballs; default players+2; >= players; <= players*3)
// - e=K       (# electrodes; default 1; 1..min(5, players-1))
// - turn=W/S  (warn/skip seconds; default 15/30; W>=5; S>W; S<=300)
// - mode=last|survivors  (default last)

import {
  createGameManager,
  withGameSubcommands,
  makeGameQoL,
  requireActive,
  requireSameChannel,
  requireCanManage,
  reply,
  mention,
  channelMention,
  clampInt,
  cleanRest,
  parseMentionIdsInOrder,
  shuffleInPlace,
  collectEntrantsByReactionsWithMax,
} from "./framework.js";

const DEFAULTS = {
  joinSeconds: 15,
  maxPlayers: null,
  electrodes: 1,
  turnWarn: 15,
  turnSkip: 30,
  mode: "last",
};

const EE_ALIASES = ["!explodingelectrode", "!electrode", "!ee"];
const PICK_ALIASES = ["!pick", "!p"];

/* --------------------------------- text ---------------------------------- */

function eeHelpText(id = "ee") {
  return [
    "**Exploding Electrode — help**",
    "",
    "Exploding Electrode is **Russian roulette** with a bag of Poké Balls.",
    "One (or more) contains an **Electrode**. On your turn, type `!pick`.",
    "",
    "**Start a game (taglist):**",
    `• \`!${id} @user1 @user2 ...\``,
    `• \`!${id} [balls=NN] [e=K] [turn=W/S] [mode=last|survivors] @user1 @user2 ...\``,
    "  – Example: `!ee balls=12 e=2 turn=10/20 @a @b @c @d`",
    "",
    "**Start a game (reaction join):**",
    `• \`!${id}\` — opens a 15s join window (react ✅ to enter)`,
    `• \`!${id} [join=NN] [max=NN] [balls=NN] [e=K] [turn=W/S] [mode=last|survivors]\``,
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
    `• \`!cancel${id}\` — host/admin cancel`,
    "• `!endelectrode` — admins only; force end (legacy)",
    "",
    "Tip: `!ee help` and `!eehelp` both work.",
  ].join("\n");
}

function eeRulesText(id = "ee") {
  return [
    "**Exploding Electrode — rules (simple)**",
    "",
    `1) Start with \`!${id}\` (reaction join) or \`!${id} @players...\` (taglist).`,
    "2) The bot makes a bag of Poké Balls. Some are **Electrodes**.",
    "3) Players take turns. When it’s your turn, type `!pick`.",
    "4) If you pull an Electrode, you’re out.",
    "5) If only one player remains, they win.",
    "",
    "**If the bag empties:**",
    "• `mode=survivors`: everyone still alive wins.",
    "• `mode=last`: survivors are listed (no single winner if multiple remain).",
    "",
    "Notes:",
    "• This game is **guild-scoped** (one per server), but gameplay commands must be used in the **start channel**.",
  ].join("\n");
}

/* -------------------------------- parsing -------------------------------- */

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

function parseEeOptions(tokens) {
  const opts = {
    joinSeconds: null,
    maxPlayers: null,
    balls: null,
    electrodes: null,
    turnWarn: null,
    turnSkip: null,
    mode: null,
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

  if (opts.turnWarn != null || opts.turnSkip != null) {
    const w = opts.turnWarn ?? DEFAULTS.turnWarn;
    const s = opts.turnSkip ?? DEFAULTS.turnSkip;
    if (!Number.isFinite(w) || w < 5 || !Number.isFinite(s) || s <= w || s > 300) {
      return { ok: false, err: "❌ `turn=W/S` must be like `turn=15/30` with 5<=W<S<=300." };
    }
  }

  if (opts.mode && !["last", "survivors"].includes(opts.mode)) {
    return { ok: false, err: "❌ `mode=` must be `mode=last` or `mode=survivors`." };
  }

  return { ok: true };
}

function computeConsumedTokens(tokens, opts) {
  const consumed = new Set();

  for (const t of tokens) {
    // Mentions are not reliably tokenized; we handle them via mention parsing
    if (parseJoinToken(t) != null && opts.joinSeconds === parseJoinToken(t)) consumed.add(t);
    if (parseMaxToken(t) != null && opts.maxPlayers === parseMaxToken(t)) consumed.add(t);
    if (parseBallsToken(t) != null && opts.balls === parseBallsToken(t)) consumed.add(t);
    if (parseElectrodesToken(t) != null && opts.electrodes === parseElectrodesToken(t)) consumed.add(t);

    const tr = parseTurnToken(t);
    if (tr && opts.turnWarn === tr.warn && opts.turnSkip === tr.skip) consumed.add(t);

    const mo = parseModeToken(t);
    if (mo && opts.mode === mo) consumed.add(t);

    // Mentions: allow any "<@...>" token through validation (same strictness as before)
    if (/^<@!?\d+>$/.test(String(t))) consumed.add(t);
  }

  return consumed;
}

/* ------------------------------ game helpers ------------------------------ */

function nextAliveIndex(players, aliveSet, startIdx) {
  if (!players.length) return -1;
  for (let step = 1; step <= players.length; step++) {
    const idx = (startIdx + step) % players.length;
    if (aliveSet.has(players[idx])) return idx;
  }
  return -1;
}

function computeDefaultBalls(playerCount) {
  return Math.max(playerCount, playerCount + 2);
}

function validateAndBuildGameConfig(playerCount, opts) {
  let electrodes = opts.electrodes ?? DEFAULTS.electrodes;
  if (!Number.isFinite(electrodes) || electrodes < 1) electrodes = DEFAULTS.electrodes;

  const eMax = Math.min(5, Math.max(1, playerCount - 1));
  if (electrodes > eMax) {
    return { ok: false, err: `❌ \`e=\` is too high. Max for ${playerCount} players is ${eMax}.` };
  }

  const mode = opts.mode || DEFAULTS.mode;

  let turnWarn = opts.turnWarn ?? DEFAULTS.turnWarn;
  let turnSkip = opts.turnSkip ?? DEFAULTS.turnSkip;
  if (!Number.isFinite(turnWarn) || turnWarn < 5) turnWarn = DEFAULTS.turnWarn;
  if (!Number.isFinite(turnSkip) || turnSkip <= turnWarn || turnSkip > 300) turnSkip = DEFAULTS.turnSkip;

  const baseBalls = computeDefaultBalls(playerCount);
  let balls = opts.balls ?? baseBalls;
  if (!Number.isFinite(balls)) balls = baseBalls;

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
  for (let i = electrodes; i < balls; i++) bag.push("B");
  shuffleInPlace(bag);
  return bag;
}

function clearTurnTimers(game) {
  if (!game?.timers?.clearAll) return;
  // We clear everything and re-arm for each turn (simple + safe).
  game.timers.clearAll();
}

async function promptTurn(channel, manager, game) {
  clearTurnTimers(game);

  const pid = game.players[game.currentIndex];
  const remaining = game.bag.length;
  const aliveCount = game.aliveIds.size;

  await channel.send(
    `🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} remaining** • ` +
      `👥 **${aliveCount}** player${aliveCount === 1 ? "" : "s"} still standing\n` +
      `👉 ${mention(pid)}, pick a Poké Ball with \`!pick\`.`
  );

  // Warn then skip if no response
  game.timers.setTimeout(async () => {
    const g = manager.getState({ guildId: game.guildId });
    if (!g) return;
    if (g.players[g.currentIndex] !== pid) return;
    await channel.send(`⏳ ${mention(pid)}… hurry! What if **Team Rocket** comes back? 🚀`);
  }, game.turnWarn * 1000);

  game.timers.setTimeout(async () => {
    const g = manager.getState({ guildId: game.guildId });
    if (!g) return;
    if (g.players[g.currentIndex] !== pid) return;

    await channel.send(`😬 We can’t wait forever… We’ll have to continue **without ${mention(pid)}**.`);

    const nextIdx = nextAliveIndex(g.players, g.aliveIds, g.currentIndex);
    if (nextIdx === -1) {
      await channel.send("🏁 Game ended — no one left to pick.");
      manager.stop({ guildId: g.guildId });
      return;
    }

    g.currentIndex = nextIdx;
    await promptTurn(channel, manager, g);
  }, game.turnSkip * 1000);
}

async function finalizeIfNeeded(channel, manager, game) {
  if (game.bag.length > 0) return;

  if (game.mode === "survivors") {
    const survivors = Array.from(game.aliveIds);
    if (!survivors.length) {
      await channel.send("🏁 The bag is empty… and nobody is left standing. 💀");
    } else {
      await channel.send(
        `🎒 The bag is empty! Everyone still standing wins:\n` + survivors.map((id) => `🏆 ${mention(id)}`).join("\n")
      );
    }
    manager.stop({ guildId: game.guildId });
    return;
  }

  const alive = Array.from(game.aliveIds);
  if (alive.length === 1) {
    await channel.send(`🏆 ${mention(alive[0])} wins **Exploding Electrode**!`);
  } else if (alive.length > 1) {
    await channel.send(`🎒 The bag is empty! Nobody exploded at the end.\nSurvivors:\n` + alive.map((id) => `✅ ${mention(id)}`).join("\n"));
  } else {
    await channel.send("🏁 The bag is empty… and nobody is left standing. 💀");
  }

  manager.stop({ guildId: game.guildId });
}

async function resolvePick(channel, manager, game, pickerId) {
  if (!game.aliveIds.has(pickerId)) {
    await channel.send(`❌ ${mention(pickerId)} is already out.`);
    return;
  }
  if (game.players[game.currentIndex] !== pickerId) {
    await channel.send(`❌ Not your turn, ${mention(pickerId)}. Wait your turn!`);
    return;
  }

  clearTurnTimers(game);

  if (game.bag.length <= 0) {
    await channel.send("🎒 The bag is empty! Nothing left to pick.");
    await finalizeIfNeeded(channel, manager, game);
    return;
  }

  const draw = game.bag.pop();
  const remaining = game.bag.length;

  await channel.send(`🫳 ${mention(pickerId)} picked up a Poké Ball…`);

  if (draw === "E") {
    await channel.send(
      `🔴 …it’s an **Electrode**!\n` +
        `💥 **Electrode used EXPLOSION!** 💥\n` +
        `💥 **BLAMMO** 💥\n` +
        `☠️ ${mention(pickerId)} **whited out!**`
    );

    game.aliveIds.delete(pickerId);

    if (game.aliveIds.size <= 1) {
      const winnerId = Array.from(game.aliveIds)[0];
      if (winnerId) {
        await channel.send(`🏆 ${mention(winnerId)} wins **Exploding Electrode**! The Poké Balls are returned safely. 🚀`);
      } else {
        await channel.send("🏁 Everyone exploded… nobody wins. Team Rocket laughs in the distance. 🚀");
      }
      manager.stop({ guildId: game.guildId });
      return;
    }

    if (remaining === 0) {
      await finalizeIfNeeded(channel, manager, game);
      return;
    }

    const nextIdx = nextAliveIndex(game.players, game.aliveIds, game.currentIndex);
    if (nextIdx === -1) {
      await channel.send("🏁 Game ended — no one left.");
      manager.stop({ guildId: game.guildId });
      return;
    }

    game.currentIndex = nextIdx;
    await channel.send(
      `🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} remaining.** Next up: ${mention(game.players[game.currentIndex])}`
    );
    await promptTurn(channel, manager, game);
    return;
  }

  await channel.send(`🟢 …it’s empty. 😮‍💨\n🎒 **${remaining} Poké Ball${remaining === 1 ? "" : "s"} left.**`);

  if (remaining === 0) {
    await finalizeIfNeeded(channel, manager, game);
    return;
  }

  const nextIdx = nextAliveIndex(game.players, game.aliveIds, game.currentIndex);
  if (nextIdx === -1) {
    await channel.send("🏁 Game ended — no one left.");
    manager.stop({ guildId: game.guildId });
    return;
  }

  game.currentIndex = nextIdx;
  await channel.send(`👉 Next up: ${mention(game.players[game.currentIndex])}`);
  await promptTurn(channel, manager, game);
}

/* ------------------------------- start logic ------------------------------ */

async function startFromIds(message, manager, idSet, parsedOpts) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const players = Array.from(new Set([...idSet].filter(Boolean)));
  if (players.length < 2) {
    await reply({ message }, "❌ You need at least 2 players to start.");
    return;
  }

  const v = validateAndBuildGameConfig(players.length, parsedOpts);
  if (!v.ok) {
    await reply({ message }, v.err);
    return;
  }

  const { electrodes, balls, turnWarn, turnSkip, mode } = v.config;
  const bag = buildBag(balls, electrodes);
  const startIdx = Math.floor(Math.random() * players.length);

  const init = {
    kind: "electrode",
    guildId,
    channelId: message.channel.id,
    creatorId: message.author.id,
    players,
    aliveIds: new Set(players),
    currentIndex: startIdx,
    bag,
    electrodes,
    balls,
    turnWarn,
    turnSkip,
    mode,
  };

  const started = manager.tryStart({ message, guildId, channelId: message.channel.id }, init);
  if (!started.ok) {
    await reply({ message }, started.errorText);
    return;
  }

  const game = started.state;

  await message.channel.send(
    `⚡ **Exploding Electrode started!**\n` +
      `🚀 Team Rocket is blasting off again! They dropped a heavy bag of Poké Balls…\n` +
      `🎒 Bag size: **${balls}** • Electrodes: **${electrodes}** • Mode: **${mode}**\n` +
      `⏳ Turn timers: warn **${turnWarn}s**, skip **${turnSkip}s**\n` +
      `👥 Players: ${players.map((id) => mention(id)).join(", ")}\n\n` +
      `👉 First up: ${mention(players[startIdx])} — type \`!pick\``
  );

  await promptTurn(message.channel, manager, game);
}

async function startFromMentions(message, manager, parsedOpts) {
  const ids = parseMentionIdsInOrder(message.content);
  const filtered = ids.filter((id) => id && id !== message.client?.user?.id); // ignore bot mention if any
  await startFromIds(message, manager, new Set(filtered), parsedOpts);
}

/* ------------------------------ main register ----------------------------- */

export function registerExplodingElectrode(register) {
  const id = "ee";
  const prettyName = "Exploding Electrode";
  const manager = createGameManager({ id, prettyName, scope: "guild" });

  // QoL bundle: !eehelp !eerules !eestatus !cancelee + hidden !endee
  makeGameQoL(register, {
    manager,
    id,
    prettyName,
    helpText: eeHelpText(id),
    rulesText: eeRulesText(id),
    manageDeniedText: "Nope — only admins/privileged or the starter can manage Exploding Electrode.",
    renderStatus: (g) => {
      const alive = g.aliveIds?.size ?? 0;
      const remaining = g.bag?.length ?? 0;
      const cur = g.players?.[g.currentIndex] || null;
      return (
        `⚡ **Exploding Electrode is running**\n` +
        `Channel: ${channelMention(g.channelId)}\n` +
        `Players: ${g.players.map((pid) => mention(pid)).join(", ")}\n` +
        `Alive: **${alive}** • Balls left: **${remaining}** • Mode: **${g.mode}**\n` +
        (cur ? `Current turn: ${mention(cur)} (use \`!pick\`)` : "")
      );
    },
    cancel: async (g, ctx) => {
      manager.stop({ guildId: g.guildId });
      await reply(ctx, "🛑 Exploding Electrode cancelled.");
    },
    end: async (g, ctx) => {
      manager.stop({ guildId: g.guildId });
      await reply(ctx, "🧯 Exploding Electrode ended early.");
    },
  });

  // Primary command: !ee (supports "!ee help" and "!ee rules" and "!ee status")
  register(
    "!ee",
    withGameSubcommands({
      helpText: eeHelpText(id),
      rulesText: eeRulesText(id),
      onStatus: async ({ message }) => {
        const g = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
        if (!g) return void (await reply({ message }, manager.noActiveText()));
        if (!(await requireSameChannel({ message }, g, manager))) return;
        await reply({ message }, `✅ ${prettyName} is running.\nTry \`!eestatus\` for details.`);
        await reply({ message }, `\n${eeHelpText(id)}`); // keep status lightweight but helpful
      },
      onStart: async ({ message, rest }) => {
        if (!message.guild) return;

        // Prevent start if active (framework text)
        if (manager.isActive({ message, guildId: message.guild.id })) {
          const existing = manager.getState({ message, guildId: message.guild.id });
          await reply({ message }, manager.alreadyRunningText(existing));
          return;
        }

        const raw = cleanRest(rest);
        const tokens = raw ? raw.split(/\s+/).filter(Boolean) : [];

        // Keep strict validation like before:
        const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
        const opts = parseEeOptions(tokens);

        const v = validateJoinOptionsForMode(hasMentions, opts);
        if (!v.ok) {
          await reply({ message }, v.err);
          return;
        }

        const consumed = computeConsumedTokens(tokens, opts);
        const extras = tokens.filter((t) => !consumed.has(t));
        if (extras.length > 0) {
          await reply({ message }, `❌ Unknown argument(s): ${extras.map((x) => `\`${x}\``).join(", ")}. Try \`!ee help\`.`);
          return;
        }

        // Mention/taglist mode
        if (hasMentions) {
          await startFromMentions(message, manager, opts);
          return;
        }

        // Reaction join mode
        const joinSeconds = clampInt(opts.joinSeconds ?? DEFAULTS.joinSeconds, 5, 120) ?? DEFAULTS.joinSeconds;
        const maxPlayers = opts.maxPlayers != null ? clampInt(opts.maxPlayers, 2, 50) : null;

        const prompt =
          `⚡ **Exploding Electrode** — React ✅ to join! (join window: ${joinSeconds}s` +
          (maxPlayers ? `, max ${maxPlayers}` : "") +
          `)\n📌 When it’s your turn, type \`!pick\`.\n`;

        const { entrants } = await collectEntrantsByReactionsWithMax({
          channel: message.channel,
          promptText: prompt,
          durationMs: joinSeconds * 1000,
          maxEntrants: maxPlayers,
          emoji: "✅",
          dispose: false,
          trackRemovals: false,
        });

        if (!entrants || entrants.size < 2) {
          await message.channel.send("❌ Not enough players joined (need at least 2).");
          return;
        }

        await startFromIds(message, manager, entrants, opts);
      },
    }),
    "!ee [options...] [@players...] — start Exploding Electrode (taglist or reaction-join). Use `!ee help`.",
    { helpTier: "primary", aliases: EE_ALIASES.filter((a) => a !== "!ee") }
  );

  // Pick command (legacy; kept). Must be in the start channel.
  register(
    "!pick",
    async ({ message }) => {
      if (!message.guild) return;

      const game = await requireActive({ message, guildId: message.guild.id, channelId: message.channel.id }, manager);
      if (!game) return;

      if (!(await requireSameChannel({ message }, game, manager))) return;
      await resolvePick(message.channel, manager, game, message.author.id);
    },
    "!pick — pick a Poké Ball (only on your turn)",
    { hideFromHelp: true, aliases: ["!p"] }
  );

  // Legacy admin-only force-end wrapper (kept for muscle memory)
  register(
    "!endelectrode",
    async ({ message }) => {
      if (!message.guild) return;

      const game = manager.getState({ message, guildId: message.guild.id, channelId: message.channel.id });
      if (!game) return void (await reply({ message }, "❌ There is no active Exploding Electrode game."));

      // Keep legacy behavior: admin/privileged only (not just host)
      const ok = await requireCanManage(
        { message },
        game,
        {
          ownerField: "__no_owner__", // effectively forces admin/privileged check
          managerLabel: prettyName,
          deniedText: "Nope — only admins can end the Electrode game.",
        }
      );

      // requireCanManage checks owner/admin; to force admin-only, we just re-check with privileged list:
      // framework’s canManageCtx uses isAdminOrPrivileged(message) for message ctx, so ownerField mismatch is enough.
      if (!ok) return;

      manager.stop({ guildId: message.guild.id });
      await message.channel.send("🧯 Exploding Electrode game ended early.");
    },
    "!endelectrode — force-end Exploding Electrode (admin)",
    { admin: true, aliases: ["!stopelectrode"] }
  );
}
