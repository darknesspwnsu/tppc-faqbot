// games/safari_zone.js
//
// Safari Zone (grid prizes):
// - One game active per guild
// - Starter provides @mentions OR uses reaction-join (like your other games)
// - Grid NxN with X prizes hidden (X <= N^2)
// - On each turn, the current player picks a square (e.g., A1, C5)
// - Default 30s timer: if inactive, player is skipped (not kicked) and moved to back (fixed-order mode)
// - Turn order rules:
//   - If players <= squares: randomize ONCE, fixed rotation order
//   - If players > squares: choose a random player each turn, avoiding repeats (unique picks)
//
// Commands:
// - !sz / !safarizone [options...] [@players...]
// - !szpick <coord>
// - !safaristatus (optional)
// - !endsafari (admin)
//
// Options:
// - n=NN        grid size (2..12), default 5
// - prizes=X    number of prizes (1..N^2), default: min(N, N^2)
// - join=SS     join window seconds (5..120) [reaction-join only], default 15
// - max=NN      max players for join (2..50) [reaction-join only], optional
// - turn=SS     skip timer seconds (10..300), default 30
// - warn=SS     warn timer seconds (5..(turn-1)), default: floor(turn/2)
//
import { collectEntrantsByReactions } from "../contests.js";
import { isAdminOrPrivileged } from "../auth.js";

const activeGames = new Map(); // guildId -> game

const SZ_ALIASES = ["!safarizone", "!safari", "!sz"];
const PICK_ALIASES = ["!szpick", "!safaripick", "!picksz"];

const DEFAULTS = {
  n: 5,
  prizes: null,      // computed from N
  joinSeconds: 15,
  maxPlayers: null,
  turnSeconds: 30,
  warnSeconds: null, // computed from turn
};

function szHelpText() {
  return [
    "**Safari Zone — help**",
    "",
    "Hidden 🎁 prizes are scattered across a **NxN** grid.",
    "On your turn, pick a square like `A1`, `C5`, `E2`.",
    "",
    "**Start (taglist):**",
    "• `!sz @user1 @user2 ...`",
    "• `!sz n=6 prizes=10 turn=30 @a @b @c`",
    "",
    "**Start (reaction-join):**",
    "• `!sz` — opens a 15s join window (react ✅ to enter)",
    "• `!sz join=25 max=12 n=7 prizes=8 turn=30`",
    "",
    "**Play:**",
    "• `!szpick A1` — only the current player can pick",
    "",
    "**Timers:**",
    "• If you don’t pick in time, you’re skipped (not kicked).",
    "",
    "**End:**",
    "• `!endsafari` — admins only; force end",
  ].join("\n");
}

function parseMentionToken(token) {
  const m = /^<@!?(\d+)>$/.exec(String(token ?? "").trim());
  return m ? m[1] : null;
}

function getMentionedUsers(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function parseKVInt(token, key) {
  const re = new RegExp(`^${key}=(\\d+)$`, "i");
  const m = String(token ?? "").trim().match(re);
  return m ? Number(m[1]) : null;
}

function parseJoinToken(token) { return parseKVInt(token, "join"); }
function parseMaxToken(token) { return parseKVInt(token, "max"); }
function parseNToken(token) { return parseKVInt(token, "n"); }
function parsePrizesToken(token) {
  // allow prizes= or p=
  let v = parseKVInt(token, "prizes");
  if (v != null) return v;
  v = parseKVInt(token, "p");
  return v;
}
function parseTurnToken(token) { return parseKVInt(token, "turn"); }
function parseWarnToken(token) { return parseKVInt(token, "warn"); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clampInt(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  n = Math.floor(n);
  if (n < lo || n > hi) return null;
  return n;
}

function idxFromRC(n, r, c) {
  return r * n + c;
}

function rcFromIdx(n, idx) {
  const r = Math.floor(idx / n);
  const c = idx % n;
  return { r, c };
}

function parseCoord(raw, n) {
  const s = String(raw ?? "").trim().toUpperCase();
  // A1 .. L12 (since n<=12)
  const m = /^([A-Z])\s*(\d{1,2})$/.exec(s);
  if (!m) return null;

  const rowChar = m[1];
  const colNum = Number(m[2]);

  const r = rowChar.charCodeAt(0) - "A".charCodeAt(0);
  const c = colNum - 1;

  if (r < 0 || r >= n) return null;
  if (c < 0 || c >= n) return null;

  return { r, c };
}

function coordLabel(r, c) {
  return `${String.fromCharCode("A".charCodeAt(0) + r)}${c + 1}`;
}

function pickRandomUniqueIndices(total, k) {
  // Partial Fisher-Yates for k unique indices in [0..total-1]
  const arr = Array.from({ length: total }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (total - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return new Set(arr.slice(0, k));
}

function buildGridText(game) {
  const n = game.n;

  // header row: 1..n
  const colHeader = ["  "].concat(Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, " "))).join(" ");
  const lines = [colHeader];

  for (let r = 0; r < n; r++) {
    const rowLabel = String.fromCharCode("A".charCodeAt(0) + r);
    const rowCells = [];
    for (let c = 0; c < n; c++) {
      const idx = idxFromRC(n, r, c);

      if (!game.revealed[idx]) {
        rowCells.push("🟦"); // covered
      } else {
        // revealed: show 🎁 if prize else ⬛
        rowCells.push(game.prizes.has(idx) ? "🎁" : "⬛");
      }
    }
    lines.push(`${rowLabel}  ${rowCells.join(" ")}`);
  }

  return "```text\n" + lines.join("\n") + "\n```";
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

function remainingCovered(game) {
  return game.totalSquares - game.revealedCount;
}

function isFinished(game) {
  return game.revealedCount >= game.totalSquares;
}

function gameModeLabel(game) {
  return game.turnMode === "fixed" ? "fixed rotation" : "random (no repeats)";
}

function nextPickerId(game) {
  if (game.turnMode === "fixed") {
    const pid = game.players[game.currentIndex];
    return pid || null;
  }

  // random unique each turn
  if (!game.remainingTurnCandidates || game.remainingTurnCandidates.length === 0) {
    // This should not happen if we configured properly, but recover gracefully:
    game.remainingTurnCandidates = shuffle([...game.players]);
  }
  return game.remainingTurnCandidates[game.remainingTurnCandidates.length - 1] || null;
}

function advanceTurn(game, { skipped = false } = {}) {
  if (game.turnMode === "fixed") {
    if (skipped) {
      const pid = game.turnOwnerId || game.players[game.currentIndex];

      // move the *actual* turn owner to the back
      movePlayerToBack(game.players, pid);

      // Ensure currentIndex points to whoever is now at this slot
      if (game.currentIndex >= game.players.length) game.currentIndex = 0;

      // If somehow we still point at the same pid (edge cases), step forward once
      if (game.players[game.currentIndex] === pid && game.players.length > 1) {
        game.currentIndex = (game.currentIndex + 1) % game.players.length;
      }
      return;
    }

    game.currentIndex = (game.currentIndex + 1) % game.players.length;
    return;
  }

  // random mode: we pop from remainingTurnCandidates to ensure no repeats
  if (game.remainingTurnCandidates && game.remainingTurnCandidates.length > 0) {
    game.remainingTurnCandidates.pop();
  }
}

function movePlayerToBack(players, userId) {
  const i = players.indexOf(userId);
  if (i === -1) return false;
  const [p] = players.splice(i, 1);
  players.push(p);
  return true;
}

async function promptTurn(channel, game) {
  clearTurnTimers(game);

  if (isFinished(game)) {
    await finalizeGame(channel, game);
    return;
  }

  const pid = nextPickerId(game);
  game.turnOwnerId = pid; // <-- track who currently owns the turn
  if (!pid) {
    await channel.send("🏁 Game ended — no player available for the next turn.");
    endGame(game.guildId);
    return;
  }

  const remaining = remainingCovered(game);
  const tLeftPrizes = game.prizeCount - game.prizesFound;

  await channel.send(
    `🧭 **Safari Zone** — ${remaining} square${remaining === 1 ? "" : "s"} left • ` +
      `🎁 ${tLeftPrizes} prize${tLeftPrizes === 1 ? "" : "s"} unclaimed • ` +
      `Mode: **${gameModeLabel(game)}**\n` +
      `${buildGridText(game)}\n` +
      `👉 <@${pid}>, pick a square with \`!szpick A1\`.`
  );

  const warnAt = game.warnSeconds;
  const skipAt = game.turnSeconds;

  game.warnTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    const cur = g.turnOwnerId;
    if (cur !== pid) return;
    await channel.send(`⏳ <@${pid}>… hurry! The Safari Zone is closing soon!`);
  }, warnAt * 1000);

  game.skipTimeout = setTimeout(async () => {
    const g = activeGames.get(game.guildId);
    if (!g) return;
    const cur = g.turnOwnerId;
    if (cur !== pid) return;

    await channel.send(`😬 Skipping <@${pid}> for inactivity… (you’re not out, just moved back).`);

    // Count skip (optional stat)
    g.skips.set(pid, (g.skips.get(pid) || 0) + 1);

    // Advance turn with "skipped"
    advanceTurn(g, { skipped: true });
    await promptTurn(channel, g);
  }, skipAt * 1000);
}

async function finalizeGame(channel, game) {
  const total = game.totalSquares;
  const prizes = game.prizeCount;

  const foundLines = [];
  const entries = Array.from(game.prizeFinds.entries()); // [userId, count]
  entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));

  for (const [uid, cnt] of entries) {
    if (!cnt) continue;
    foundLines.push(`• <@${uid}>: 🎁 ${cnt}`);
  }

  const skipLines = [];
  const sk = Array.from(game.skips.entries()).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  for (const [uid, cnt] of sk) {
    if (!cnt) continue;
    skipLines.push(`• <@${uid}>: ⏳ ${cnt}`);
  }

  await channel.send(
    `🏁 **Safari Zone complete!**\n` +
      `🧩 Grid: **${game.n}x${game.n}** (${total} squares)\n` +
      `🎁 Prizes: **${prizes}**\n\n` +
      `${buildGridText(game)}\n` +
      (foundLines.length ? `**Prize finds:**\n${foundLines.join("\n")}\n\n` : "**Prize finds:** (none)\n\n") +
      (skipLines.length ? `**Inactivity skips:**\n${skipLines.join("\n")}` : "")
  );

  endGame(game.guildId);
}

async function resolvePick(channel, game, pickerId, coordRaw) {
  if (isFinished(game)) {
    await channel.send("🏁 The Safari Zone is already complete.");
    await finalizeGame(channel, game);
    return;
  }

  const expected = nextPickerId(game);
  if (expected !== pickerId) {
    await channel.send(`❌ Not your turn, <@${pickerId}>. Wait your turn!`);
    return;
  }

  const pos = parseCoord(coordRaw, game.n);
  if (!pos) {
    await channel.send(`❌ Invalid square. Use like \`A1\` .. \`${String.fromCharCode(64 + game.n)}${game.n}\`.`);
    return;
  }

  const idx = idxFromRC(game.n, pos.r, pos.c);
  if (game.revealed[idx]) {
    await channel.send(`❌ ${coordLabel(pos.r, pos.c)} is already uncovered. Pick another square.`);
    return;
  }

  clearTurnTimers(game);

  // Reveal
  game.revealed[idx] = true;
  game.revealedCount++;

  const isPrize = game.prizes.has(idx);
  if (isPrize) {
    game.prizesFound++;
    game.prizeFinds.set(pickerId, (game.prizeFinds.get(pickerId) || 0) + 1);
  }

  await channel.send(
    `🧺 <@${pickerId}> picked **${coordLabel(pos.r, pos.c)}**… ` +
      (isPrize ? "🎁 **PRIZE!**" : "⬛ nothing here.") +
      `\n${buildGridText(game)}`
  );

  // If finished, finalize
  if (isFinished(game)) {
    await finalizeGame(channel, game);
    return;
  }

  // Advance turn
  advanceTurn(game, { skipped: false });
  await promptTurn(channel, game);
}

/* ----------------------------- join collection ----------------------------- */
/**
 * Optional max-cap join collector (like your electrode one, but simpler)
 */
async function collectEntrantsByReactionsWithMax({ message, promptText, durationMs, maxEntrants }) {
  const joinMsg = await message.channel.send(promptText);
  const emoji = "✅";

  try { await joinMsg.react(emoji); } catch { return new Set(); }

  const entrants = new Set();
  const filter = (reaction, user) => !user.bot && reaction.emoji?.name === emoji;

  return new Promise((resolve) => {
    const collector = joinMsg.createReactionCollector({ filter, time: durationMs });

    collector.on("collect", (_reaction, user) => {
      entrants.add(user.id);
      if (maxEntrants && entrants.size >= maxEntrants) collector.stop("max");
    });

    collector.on("end", () => resolve(entrants));
  });
}

/* ------------------------------- start helpers ------------------------------ */

function validateAndBuildConfig(playersCount, opts) {
  const n = clampInt(opts.n ?? DEFAULTS.n, 2, 12);
  if (!n) return { ok: false, err: "❌ `n=` must be between 2 and 12." };

  const totalSquares = n * n;

  let prizes = opts.prizes ?? DEFAULTS.prizes;
  if (prizes == null) {
    // default: min(N, N^2) => N
    prizes = Math.min(n, totalSquares);
  }
  prizes = clampInt(prizes, 1, totalSquares);
  if (!prizes) return { ok: false, err: `❌ \`prizes=\` must be between 1 and ${totalSquares}.` };

  let turnSeconds = opts.turnSeconds ?? DEFAULTS.turnSeconds;
  turnSeconds = clampInt(turnSeconds, 10, 300);
  if (!turnSeconds) return { ok: false, err: "❌ `turn=` must be 10..300 seconds." };

  let warnSeconds = opts.warnSeconds ?? DEFAULTS.warnSeconds;
  if (warnSeconds == null) warnSeconds = Math.max(5, Math.floor(turnSeconds / 2));
  warnSeconds = clampInt(warnSeconds, 5, Math.max(5, turnSeconds - 1));
  if (!warnSeconds || warnSeconds >= turnSeconds) {
    return { ok: false, err: "❌ `warn=` must be >=5 and < `turn=`." };
  }

  // Determine turn mode based on your rule:
  // - players <= squares => fixed rotation
  // - players > squares => random each turn (no repeats)
  const turnMode = playersCount <= totalSquares ? "fixed" : "random";

  return {
    ok: true,
    config: { n, totalSquares, prizes, turnSeconds, warnSeconds, turnMode }
  };
}

async function startSafariZoneFromIds(message, idSet, parsedOpts) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  if (activeGames.has(guildId)) {
    await message.reply("⚠️ A Safari Zone game is already running!");
    return;
  }

  const players = Array.from(new Set([...idSet].filter(Boolean)));
  if (players.length < 2) {
    await message.reply("❌ You need at least 2 players to start.");
    return;
  }

  const v = validateAndBuildConfig(players.length, parsedOpts);
  if (!v.ok) {
    await message.reply(v.err);
    return;
  }

  const { n, totalSquares, prizes, turnSeconds, warnSeconds, turnMode } = v.config;

  // Setup hidden prizes
  const prizeSet = pickRandomUniqueIndices(totalSquares, prizes);

  // Setup revealed
  const revealed = Array.from({ length: totalSquares }, () => false);

  // Players: randomize once for fixed rotation
  const playersShuffled = shuffle([...players]);

  const game = {
    kind: "safari_zone",
    guildId,
    n,
    totalSquares,
    prizeCount: prizes,
    prizes: prizeSet,
    prizesFound: 0,
    revealed,
    revealedCount: 0,

    // turn logic
    turnMode,
    players: playersShuffled,
    currentIndex: 0,
    remainingTurnCandidates: turnMode === "random" ? shuffle([...playersShuffled]) : null,

    turnSeconds,
    warnSeconds,
    warnTimeout: null,
    skipTimeout: null,

    prizeFinds: new Map(), // userId -> count
    skips: new Map(),      // userId -> skips
    turnOwnerId: null,
  };

  activeGames.set(guildId, game);

  await message.channel.send(
    `🧭 **Safari Zone started!**\n` +
      `🧩 Grid: **${n}x${n}** (${totalSquares} squares)\n` +
      `🎁 Hidden prizes: **${prizes}**\n` +
      `⏳ Turn timers: warn **${warnSeconds}s**, skip **${turnSeconds}s**\n` +
      `👥 Players: ${playersShuffled.map((id) => `<@${id}>`).join(", ")}\n` +
      `🎮 Turn mode: **${gameModeLabel(game)}**`
  );

  await promptTurn(message.channel, game);
}

async function startSafariZoneFromMessageMentions(message, parsedOpts) {
  const mentioned = getMentionedUsers(message);
  const allowedIds = [];
  for (const u of mentioned) {
    if (!u?.id) continue;
    if (u.bot) continue;
    allowedIds.push(u.id);
  }
  await startSafariZoneFromIds(message, new Set(allowedIds), parsedOpts);
}

/* --------------------------------- parsing -------------------------------- */

function parseSzOptions(tokens) {
  const opts = {
    n: null,
    prizes: null,
    joinSeconds: null,
    maxPlayers: null,
    turnSeconds: null,
    warnSeconds: null,
  };

  for (const t of tokens) {
    const n = parseNToken(t);
    if (n != null) opts.n = n;

    const p = parsePrizesToken(t);
    if (p != null) opts.prizes = p;

    const j = parseJoinToken(t);
    if (j != null) opts.joinSeconds = j;

    const m = parseMaxToken(t);
    if (m != null) opts.maxPlayers = m;

    const turn = parseTurnToken(t);
    if (turn != null) opts.turnSeconds = turn;

    const warn = parseWarnToken(t);
    if (warn != null) opts.warnSeconds = warn;
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
  const j = clampInt(joinSeconds, 5, 120);
  if (!j) return { ok: false, err: "❌ `join=NN` must be between 5 and 120 seconds." };
  opts.joinSeconds = j;

  if (opts.maxPlayers != null) {
    const m = clampInt(opts.maxPlayers, 2, 50);
    if (!m) return { ok: false, err: "❌ `max=NN` must be 2..50." };
    opts.maxPlayers = m;
  }

  return { ok: true };
}

function computeConsumedTokens(tokens, opts) {
  const consumed = new Set();

  for (const t of tokens) {
    if (parseMentionToken(t)) { consumed.add(t); continue; }
    if (parseNToken(t) != null && opts.n === parseNToken(t)) consumed.add(t);

    const p = parsePrizesToken(t);
    if (p != null && opts.prizes === p) consumed.add(t);

    if (parseJoinToken(t) != null && opts.joinSeconds === parseJoinToken(t)) consumed.add(t);
    if (parseMaxToken(t) != null && opts.maxPlayers === parseMaxToken(t)) consumed.add(t);
    if (parseTurnToken(t) != null && opts.turnSeconds === parseTurnToken(t)) consumed.add(t);
    if (parseWarnToken(t) != null && opts.warnSeconds === parseWarnToken(t)) consumed.add(t);
  }

  return consumed;
}

/* ------------------------------- registrations ------------------------------ */

export function registerSafariZone(register) {
  // Start
  register(
    "!sz",
    async ({ message, rest }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      if (activeGames.has(guildId)) {
        await message.reply("⚠️ A Safari Zone game is already running!");
        return;
      }

      const tokens = rest.trim().split(/\s+/).filter(Boolean);

      if (tokens.length === 1 && ["help", "h", "?"].includes(tokens[0].toLowerCase())) {
        await message.reply(szHelpText());
        return;
      }

      const hasMentions = (message.mentions?.users?.size ?? 0) > 0;
      const opts = parseSzOptions(tokens);

      const v = validateJoinOptionsForMode(hasMentions, opts);
      if (!v.ok) {
        await message.reply(v.err);
        return;
      }

      // strict arg validation
      const consumed = computeConsumedTokens(tokens, opts);
      const extras = tokens.filter((t) => !consumed.has(t));
      if (extras.length > 0) {
        await message.reply(
          `❌ Unknown argument(s): ${extras.map((x) => `\`${x}\``).join(", ")}. Try \`!sz help\`.`
        );
        return;
      }

      // Taglist mode
      if (hasMentions) {
        await startSafariZoneFromMessageMentions(message, opts);
        return;
      }

      // Reaction-join mode
      const joinSeconds = opts.joinSeconds ?? DEFAULTS.joinSeconds;
      const maxPlayers = opts.maxPlayers ?? null;

      const prompt =
        `🧭 **Safari Zone** — React ✅ to join! (join window: ${joinSeconds}s` +
        (maxPlayers ? `, max ${maxPlayers}` : "") +
        `)\n` +
        `📌 When it’s your turn, pick a square with \`!szpick A1\`.\n`;

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

      await startSafariZoneFromIds(message, entrants, opts);
    },
    "!sz [options...] [@players...] — start Safari Zone (taglist or reaction-join). Use `!sz help`.",
    { helpTier: "primary", aliases: SZ_ALIASES.filter((a) => a !== "!sz") }
  );

  // Pick square
  register(
    "!szpick",
    async ({ message, rest }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game || game.kind !== "safari_zone") {
        await message.reply("❌ There is no active Safari Zone game.");
        return;
      }

      const coord = String(rest ?? "").trim();
      if (!coord) {
        await message.reply("Usage: `!szpick A1`");
        return;
      }

      await resolvePick(message.channel, game, message.author.id, coord);
    },
    "!szpick <A1..> — pick a square (only current player)",
    { hideFromHelp: true, aliases: PICK_ALIASES.filter((a) => a !== "!szpick") }
  );

  // (Optional) status
  register(
    "!safaristatus",
    async ({ message }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game || game.kind !== "safari_zone") {
        await message.reply("❌ There is no active Safari Zone game.");
        return;
      }

      await message.channel.send(
        `🧭 **Safari Zone status**\n` +
          `Mode: **${gameModeLabel(game)}** • Remaining squares: **${remainingCovered(game)}**\n` +
          `${buildGridText(game)}`
      );
    },
    "!safaristatus — shows current grid status",
    { hideFromHelp: true }
  );

  // End (admin)
  register(
    "!endsafari",
    async ({ message }) => {
      if (!message.guild) return;
      const guildId = message.guild.id;

      const game = activeGames.get(guildId);
      if (!game || game.kind !== "safari_zone") {
        await message.reply("❌ There is no active Safari Zone game.");
        return;
      }

      if (!isAdminOrPrivileged(message)) return;

      await message.channel.send("🧯 Safari Zone game ended by admin.");
      endGame(guildId);
    },
    "!endsafari — force end Safari Zone (admin)",
    { admin: true }
  );
}
