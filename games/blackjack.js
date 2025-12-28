// games/blackjack.js
//
// Minimal Discord blackjack (public hands), one active game per guild.
//
// Commands:
// - !blackjack @p1 @p2 ...   (tag-only, strict; rejects invalid input)
// - !hit                     (current player only)
// - !stand                   (current player only)
// - !bjstatus                (public status)
// - !cancelblackjack         (admin or starter)
//
// Dealer rules: S17 (stand on all 17s, including soft 17)

import { isAdminOrPrivileged } from "../auth.js";

const GAMES = new Map(); // guildId -> state

// ---------- Card / Deck helpers ----------

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) deck.push({ r, s });
  }
  shuffle(deck);
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function cardValueRank(r) {
  if (r === "A") return 11;
  if (r === "K" || r === "Q" || r === "J") return 10;
  return Number(r);
}

function fmtCard(c) {
  return `${c.r}${c.s}`;
}

function fmtHand(hand) {
  return hand.map(fmtCard).join(" ");
}

function handValue(hand) {
  // Returns best total <= 21 if possible; also indicates whether it's "soft"
  // (i.e., at least one Ace is counted as 11 in the final total).
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    const v = cardValueRank(c.r);
    total += v;
    if (c.r === "A") aces++;
  }

  // Reduce Aces from 11 to 1 as needed
  let soft = aces > 0; // soft until we reduce all aces
  while (total > 21 && aces > 0) {
    total -= 10; // turning an Ace from 11 to 1
    aces--;
  }
  // If we reduced all aces, no ace remains as 11
  if (hand.some((c) => c.r === "A")) {
    // soft if there exists at least one Ace still counted as 11
    // That happens when original aces > reductions; equivalently total + 10 <= 21 for some ace,
    // but easiest is to recompute: treat all aces as 1 then try upgrade one.
    const base = hand.reduce((sum, c) => sum + (c.r === "A" ? 1 : cardValueRank(c.r)), 0);
    soft = hand.some((c) => c.r === "A") && base + 10 <= 21;
  } else {
    soft = false;
  }

  return { total, soft };
}

function isBlackjack(hand) {
  if (!hand || hand.length !== 2) return false;
  const v1 = cardValueRank(hand[0].r);
  const v2 = cardValueRank(hand[1].r);
  return (v1 === 11 && v2 === 10) || (v2 === 11 && v1 === 10);
}

function parseMentionIdsInOrder(text) {
  // preserves order typed: <@123> or <@!123>
  const s = String(text ?? "");
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(s)) !== null) ids.push(m[1]);
  return ids;
}

// ---------- State helpers ----------

function gameLocationLine(st) {
  return `Started by <@${st.creatorId}> in <#${st.channelId}>`;
}

function inSamePlace(message, st) {
  if (!message.guildId) return false;
  if (message.guildId !== st.guildId) return false;
  // Keep it simple and avoid cross-channel confusion:
  return message.channelId === st.channelId;
}

function canManage(message, st) {
  if (!st) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === st.creatorId;
}

function currentPlayer(st) {
  return st.players[st.turnIndex] ?? null;
}

function advanceTurn(st) {
  // Move to next player who is still "playing"
  for (let i = st.turnIndex + 1; i < st.players.length; i++) {
    if (st.players[i].status === "playing") {
      st.turnIndex = i;
      return true;
    }
  }
  // No players left to act
  st.turnIndex = st.players.length; // sentinel
  return false;
}

function allPlayersDone(st) {
  return st.players.every((p) => p.status !== "playing");
}

function dealerUpCardLine(st) {
  // Show up-card only during player turns
  const up = st.dealerHand[0];
  return `Dealer: **${fmtCard(up)}** + [hidden]`;
}

function fullDealerLine(st) {
  const { total } = handValue(st.dealerHand);
  return `Dealer: ${fmtHand(st.dealerHand)}  (**${total}**)`;
}

function playerLine(p) {
  const { total } = handValue(p.hand);
  let suffix = "";
  if (p.status === "busted") suffix = " — **BUST**";
  else if (p.status === "stood") suffix = " — stood";
  else if (p.status === "blackjack") suffix = " — **BLACKJACK**";
  return `<@${p.userId}>: ${fmtHand(p.hand)}  (**${total}**)${suffix}`;
}

function statusText(st, revealDealer = false) {
  const lines = [];
  lines.push(revealDealer ? fullDealerLine(st) : dealerUpCardLine(st));
  lines.push("");
  for (const p of st.players) lines.push(playerLine(p));
  if (!revealDealer) {
    const cp = currentPlayer(st);
    if (cp) lines.push(`\nTurn: <@${cp.userId}>`);
  }
  return lines.join("\n");
}

// ---------- Dealer play / resolve ----------

function dealerShouldHit_S17(hand) {
  // S17: hit if total < 17; stand on all 17s (soft or hard)
  const { total } = handValue(hand);
  return total < 17;
}

function settleGame(st) {
  const dealerBJ = isBlackjack(st.dealerHand);
  const dealerVal = handValue(st.dealerHand).total;
  const dealerBust = dealerVal > 21;

  const results = [];
  for (const p of st.players) {
    const pVal = handValue(p.hand).total;
    const pBJ = isBlackjack(p.hand);

    let outcome = "push";
    if (p.status === "busted") {
      outcome = "lose";
    } else if (dealerBust) {
      outcome = "win";
    } else if (pBJ && !dealerBJ) {
      outcome = "win";
    } else if (!pBJ && dealerBJ) {
      outcome = "lose";
    } else {
      if (pVal > dealerVal) outcome = "win";
      else if (pVal < dealerVal) outcome = "lose";
      else outcome = "push";
    }

    results.push({ userId: p.userId, outcome, pVal, pBJ });
  }

  return results;
}

async function endGame(message, guildId, reason, finalText) {
  GAMES.delete(guildId);
  if (finalText) {
    await message.channel.send(finalText);
  } else {
    await message.channel.send(`🏁 **Blackjack ended** (${reason}).`);
  }
}

// ---------- Registration ----------

export function registerBlackjack(register) {
  // !blackjack @p1 @p2 ...
  register(
    "!blackjack",
    async ({ message, rest }) => {
      if (!message.guildId) return;

      const guildId = message.guildId;

      if (GAMES.has(guildId)) {
        const st = GAMES.get(guildId);
        await message.reply(
          `⚠️ A blackjack game is already running.\n${gameLocationLine(st)}`
        );
        return;
      }

      const mentionIds = parseMentionIdsInOrder(rest);
      const arg = String(rest ?? "").trim();
      if (!arg || arg.toLowerCase() === "help") {
        await message.reply(
          "**Blackjack help** (Dealer: S17)\n" +
          "`!blackjack @p1 @p2 ...` — start round (tag-only)\n" +
          "`!hit` — draw a card (current player)\n" +
          "`!stand` — stand (current player)\n" +
          "`!bjstatus` — show table status\n" +
          "`!cancelblackjack` — cancel (admin/starter)"
        );
        return;
      }

      if (mentionIds.length === 0) {
        await message.reply("❌ Tag at least 1 player.\nUsage: `!blackjack @p1 @p2 ...`");
        return;
      }

      // Resolve mentioned users from Discord message mentions.
      // Enforce strictness: every id must exist in mentions.users.
      const mentionedUsers = message.mentions?.users;
      if (!mentionedUsers) {
        await message.reply("❌ Could not read mentions. Try again by tagging users normally.");
        return;
      }

      const seen = new Set();
      const players = [];

      for (const id of mentionIds) {
        if (seen.has(id)) {
          await message.reply("❌ Duplicate player in tag list. Each player can only appear once.");
          return;
        }
        const u = mentionedUsers.get(id);
        if (!u) {
          await message.reply("❌ Invalid mention in tag list. Please re-tag players cleanly.");
          return;
        }
        if (u.bot) {
          await message.reply("❌ Bots can’t play blackjack. Remove bot mentions from the tag list.");
          return;
        }
        seen.add(id);
        players.push({
          userId: id,
          hand: [],
          status: "playing", // playing | stood | busted | blackjack
        });
      }

      // Build state
      const st = {
        guildId,
        channelId: message.channelId,
        creatorId: message.author.id,
        deck: buildDeck(),
        players,
        dealerHand: [],
        turnIndex: 0,
      };

      // Deal initial cards: 2 each, then dealer 2
      for (let round = 0; round < 2; round++) {
        for (const p of st.players) p.hand.push(st.deck.pop());
      }
      st.dealerHand.push(st.deck.pop());
      st.dealerHand.push(st.deck.pop());

      // Auto-mark player blackjacks
      for (const p of st.players) {
        if (isBlackjack(p.hand)) p.status = "blackjack";
      }

      // Set first active player
      st.turnIndex = 0;
      while (st.turnIndex < st.players.length && st.players[st.turnIndex].status !== "playing") {
        st.turnIndex++;
      }

      GAMES.set(guildId, st);

      // If everyone is done immediately (all blackjack), go straight to dealer reveal/settle
      if (allPlayersDone(st)) {
        // Reveal dealer and settle (dealer doesn't need to draw; but we should still check dealer blackjack etc.)
        const results = settleGame(st);
        const lines = [];
        lines.push("🃏 **Blackjack** — Initial deal complete.");
        lines.push(statusText(st, true));
        lines.push("");
        lines.push("**Results:**");
        for (const r of results) {
          const emoji = r.outcome === "win" ? "✅" : r.outcome === "lose" ? "❌" : "➖";
          const label = r.outcome === "win" ? "WIN" : r.outcome === "lose" ? "LOSE" : "PUSH";
          lines.push(`${emoji} <@${r.userId}> — **${label}**`);
        }
        await endGame(message, guildId, "round complete", lines.join("\n"));
        return;
      }

      await message.channel.send(
        `🃏 **Blackjack started** (Dealer: **S17**)\n` +
          `${dealerUpCardLine(st)}\n\n` +
          st.players.map(playerLine).join("\n") +
          `\n\nTurn: <@${currentPlayer(st).userId}>\n` +
          `Use \`!hit\`, \`!stand\`, \`!bjstatus\`, or \`!cancelblackjack\`.`
      );
    },
    "!blackjack @p1 @p2 ... — starts a blackjack round (tag-only, in order)",
    { helpTier: "primary" }
  );

  // !bjstatus
  register(
    "!bjstatus",
    async ({ message }) => {
      const st = GAMES.get(message.guildId);
      if (!st) return void (await message.reply("No active blackjack game in this server."));

      if (message.channelId !== st.channelId) {
        await message.reply(`Blackjack is running in <#${st.channelId}>. ${gameLocationLine(st)}`);
        return;
      }

      await message.reply(statusText(st, false));
    },
    "!bjstatus — shows current public blackjack status",
    { hideFromHelp: true }
  );

  // !hit
  register(
    "!hit",
    async ({ message }) => {
      const st = GAMES.get(message.guildId);
      if (!st) return void (await message.reply("No active blackjack game in this server."));

      if (!inSamePlace(message, st)) {
        await message.reply(`Blackjack is running in <#${st.channelId}>. ${gameLocationLine(st)}`);
        return;
      }

      const cp = currentPlayer(st);
      if (!cp) {
        await message.reply("No active player turn. (Dealer may be playing / round is ending.)");
        return;
      }

      if (message.author.id !== cp.userId) {
        await message.reply(`Not your turn. Current turn: <@${cp.userId}>`);
        return;
      }

      // Draw
      cp.hand.push(st.deck.pop());

      const { total } = handValue(cp.hand);
      if (total > 21) {
        cp.status = "busted";
      }

      // If busted, advance; if not, player continues until stand/bust
      let msg =
        `🃏 **Hit** — <@${cp.userId}> drew **${fmtCard(cp.hand[cp.hand.length - 1])}**\n` +
        `${playerLine(cp)}`;

      if (cp.status === "busted") {
        const hasNext = advanceTurn(st);
        if (hasNext) {
          msg += `\n\nNext: <@${currentPlayer(st).userId}>`;
        } else {
          msg += `\n\nAll players done — dealer’s turn...`;
        }
      } else {
        msg += `\n\nStill your turn, <@${cp.userId}>. (\`!hit\` / \`!stand\`)`;
      }

      await message.channel.send(msg);

      // If all done, run dealer and settle
      if (allPlayersDone(st)) {
        await runDealerAndFinish(message, st);
      }
    },
    "!hit — draw a card (current player only)",
    { hideFromHelp: true }
  );

  // !stand
  register(
    "!stand",
    async ({ message }) => {
      const st = GAMES.get(message.guildId);
      if (!st) return void (await message.reply("No active blackjack game in this server."));

      if (!inSamePlace(message, st)) {
        await message.reply(`Blackjack is running in <#${st.channelId}>. ${gameLocationLine(st)}`);
        return;
      }

      const cp = currentPlayer(st);
      if (!cp) {
        await message.reply("No active player turn. (Dealer may be playing / round is ending.)");
        return;
      }

      if (message.author.id !== cp.userId) {
        await message.reply(`Not your turn. Current turn: <@${cp.userId}>`);
        return;
      }

      // Stand
      cp.status = "stood";

      const hasNext = advanceTurn(st);
      let msg = `🛑 **Stand** — <@${cp.userId}> stands.\n${playerLine(cp)}`;

      if (hasNext) msg += `\n\nNext: <@${currentPlayer(st).userId}>`;
      else msg += `\n\nAll players done — dealer’s turn...`;

      await message.channel.send(msg);

      if (allPlayersDone(st)) {
        await runDealerAndFinish(message, st);
      }
    },
    "!stand — stand (current player only)",
    { hideFromHelp: true }
  );

  // !cancelblackjack
  register(
    "!cancelblackjack",
    async ({ message }) => {
      const st = GAMES.get(message.guildId);
      if (!st) return void (await message.reply("No active blackjack game to cancel."));

      if (message.guildId !== st.guildId) return; // paranoia

      if (message.channelId !== st.channelId) {
        await message.reply(`Blackjack is running in <#${st.channelId}>. ${gameLocationLine(st)}`);
        return;
      }

      if (!canManage(message, st)) {
        await message.reply("Nope — only admins or the blackjack starter can use that.");
        return;
      }

      const finalText =
        `🏁 **Blackjack cancelled**.\n` +
        `${dealerUpCardLine(st)}\n\n` +
        st.players.map(playerLine).join("\n");

      await endGame(message, message.guildId, "cancelled", finalText);
    },
    "!cancelblackjack — cancels blackjack (admin or starter)",
    { admin: true }
  );
}

async function runDealerAndFinish(message, st) {
  const guildId = st.guildId;

  // If everyone busted, dealer just reveals; no need to draw
  const anyAlive = st.players.some((p) => p.status !== "busted");
  if (anyAlive) {
    // Dealer draws with S17
    while (dealerShouldHit_S17(st.dealerHand)) {
      st.dealerHand.push(st.deck.pop());
      const { total } = handValue(st.dealerHand);
      if (total > 21) break;
    }
  }

  const results = settleGame(st);

  const lines = [];
  lines.push("🎴 **Dealer reveals**");
  lines.push(statusText(st, true));
  lines.push("");
  lines.push("**Results:**");
  for (const r of results) {
    const emoji = r.outcome === "win" ? "✅" : r.outcome === "lose" ? "❌" : "➖";
    const label = r.outcome === "win" ? "WIN" : r.outcome === "lose" ? "LOSE" : "PUSH";
    lines.push(`${emoji} <@${r.userId}> — **${label}**`);
  }

  await endGame(message, guildId, "round complete", lines.join("\n"));
}
