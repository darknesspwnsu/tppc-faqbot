// games/auction.js
//
// Discord Auction (MVP) — framework-aligned + safety fixes
// - One auction per guild
// - In-memory only
// - Private bids via buttons + modal
// - Auto-finalize when all bids are in
// - Full summary on end
//
// Safety fixes:
// - Use TimerBag (state.timers) for round timers (no ghost timeouts after stop)
// - Clear timers on round end / round start
// - Status enforces same-channel when active
// - Join uses framework reaction collector with removals tracking
// - Avoid invalid message edit fields; safely attempt to remove reactions

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";

import {
  createGameManager,
  withGameSubcommands,
  makeGameQoL,
  reply,
  requireSameChannel,
  requireCanManage,
  parseDurationSeconds,
  formatDurationSeconds,
  safeEditById,
  collectEntrantsByReactionsWithMax,
} from "./framework.js";

/* ============================== MANAGER ================================ */

const manager = createGameManager({ id: "auction", prettyName: "Auction", scope: "guild" });

/* ============================== TEXT =================================== */

function auctionHelpText() {
  return [
    "**Auction — Help**",
    "",
    "**Create / Join:**",
    "• `!auction join [seconds] [maxPlayers] [startMoney]`",
    "",
    "**Host Commands:**",
    "• `!auction start <item name> [roundSeconds]`",
    "• `!auction endround`",
    "• `!auction end`",
    "",
    "**Info:**",
    "• `!auction status`",
    "• `!auction rules`",
    "",
    "**Players:**",
    "• Use the **Place Bid** button to submit private bids.",
  ].join("\n");
}

function auctionRulesText() {
  return [
    "**Auction — Rules**",
    "",
    "• Players join an auction and receive virtual money.",
    "• The host starts items one at a time.",
    "• Each player submits a private bid per item.",
    "• You may change your bid until the round ends.",
    "• If everyone bids, the round ends immediately.",
    "• Highest bid wins and pays that amount.",
    "• The host ends the auction to show a summary.",
  ].join("\n");
}

/* ============================== UI ===================================== */

function buildBidRow(active) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("auction:bid")
      .setLabel("Place Bid")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId("auction:mybid")
      .setLabel("My Bid")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active),
    new ButtonBuilder()
      .setCustomId("auction:balance")
      .setLabel("Balance")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildBidModal() {
  const modal = new ModalBuilder().setCustomId("auction:bidmodal").setTitle("Place Your Bid");

  const amount = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Bid amount")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(amount));
  return modal;
}

/* ============================ ROUND LOGIC =============================== */

function now() {
  return Date.now();
}

async function disableRoundButtons(auction, channel) {
  if (!auction?.roundMessageId) return;
  await safeEditById(channel, auction.roundMessageId, { components: [buildBidRow(false)] });
}

function clearRoundTimers(auction) {
  // TimerBag is owned by the manager and cleared automatically on stop.
  // We still clear on round transitions to prevent overlap.
  try {
    auction?.timers?.clearAll?.();
  } catch {}
}

async function endRound(auction, channel) {
  if (!auction) return;
  if (!channel?.send) return;

  // ensure nothing else fires for this round
  clearRoundTimers(auction);

  await disableRoundButtons(auction, channel);

  const bids = [...auction.bids.entries()]
    .map(([uid, b]) => ({ uid, ...b }))
    .sort((a, b) => (b.amount !== a.amount ? b.amount - a.amount : a.ts - b.ts));

  if (!bids.length) {
    await channel.send(`⏹️ **${auction.activeItem} — no bids placed.**`);
    auction.activeItem = null;
    auction.bids.clear();
    return;
  }

  const winner = bids[0];
  const winnerPlayer = auction.players.get(winner.uid);

  // Defensive: if somehow winner isn’t in players map, treat as no-op
  if (winnerPlayer) {
    winnerPlayer.balance -= winner.amount;
  }

  auction.history.push({
    item: auction.activeItem,
    winnerId: winner.uid,
    amount: winner.amount,
  });

  await channel.send(`🏆 **${auction.activeItem} sold!**\nWinner: <@${winner.uid}> — **${winner.amount}**`);

  auction.activeItem = null;
  auction.bids.clear();
}

function renderStatus(auction) {
  const players = [...auction.players.entries()]
    .map(([id, p]) => `• <@${id}> — ${p.balance}`)
    .join("\n");

  let out =
    `🪙 **Auction Status**\n` +
    `Host: <@${auction.hostId}>\n\n` +
    `Players (${auction.players.size}):\n${players}\n\n` +
    `Rounds completed: ${auction.history.length}\n`;

  if (auction.activeItem) {
    out += `Current item: **${auction.activeItem}**\n` + `Bids: ${auction.bids.size}/${auction.players.size}`;
  } else {
    out += `Current round: none`;
  }
  return out;
}

async function postSummary(channel, auction) {
  if (!channel?.send) return;

  if (auction.history.length) {
    const lines = auction.history.map((r, i) => `${i + 1}) **${r.item}** — <@${r.winnerId}> (${r.amount})`);
    await channel.send(`🪙 **Auction Summary**\n\n${lines.join("\n")}`);
  } else {
    await channel.send("🪙 **Auction ended. No items sold.**");
  }
}

/* =========================== REGISTRATION =============================== */

export function registerAuction(register) {
  // Framework QoL: !auctionhelp, !auctionrules, !auctionstatus, !cancelauction
  // Cancel behaves like `!auction end` (summary + cleanup).
  makeGameQoL(register, {
    manager,
    id: "auction",
    prettyName: "Auction",
    helpText: auctionHelpText(),
    rulesText: auctionRulesText(),
    renderStatus: (st) => renderStatus(st),
    cancel: async (st, { message }) => {
      if (!(await requireSameChannel({ message }, st, manager))) return;

      // stop timers + disable buttons
      clearRoundTimers(st);
      await disableRoundButtons(st, message.channel);

      await postSummary(message.channel, st);

      manager.stop({ guildId: st.guildId });
    },
    // Keep same “manage” semantics: admin/privileged OR host
    manageDeniedText: null,
  });

  register(
    "!auction",
    withGameSubcommands({
      helpText: auctionHelpText(),
      rulesText: auctionRulesText(),
      allowStatusSubcommand: true,
      onStatus: async ({ message }) => {
        if (!message.guild) return;
        const guildId = message.guild.id;

        const st = manager.getState({ guildId });
        if (!st) {
          await reply({ message }, "🪙 **Auction Status**\nNo active auction in this server.");
          return;
        }

        if (!(await requireSameChannel({ message }, st, manager))) return;

        await reply({ message }, renderStatus(st));
      },
      onStart: async ({ message, rest }) => {
        if (!message.guild) return;

        const args = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
        const sub = (args.shift() || "").toLowerCase();
        const guildId = message.guild.id;

        /* ---------- JOIN ---------- */
        if (sub === "join") {
          const existing = manager.getState({ guildId });
          if (existing) {
            await message.reply("⚠️ An auction is already running.");
            return;
          }

          const joinSeconds = parseDurationSeconds(args[0], 30);
          const maxPlayers = Number(args[1]) || null;
          const startMoney = Number(args[2]) || 500;

          const { entrants, joinMsg, reason } = await collectEntrantsByReactionsWithMax({
            channel: message.channel,
            promptText: `🪙 **Auction starting!**\nReact ✅ to join (${joinSeconds}s)`,
            durationMs: joinSeconds * 1000,
            maxEntrants: maxPlayers,
            emoji: "✅",
            dispose: true, // preserve “unreact removes entrant”
            trackRemovals: true,
          });

          if (!entrants.size) {
            await message.channel.send("❌ Auction cancelled — no players.");
            return;
          }

          // Close entries message (keep prior text behavior)
          await joinMsg.edit({
            content:
              reason === "max"
                ? "🛑 **Auction entries are now closed (max players reached).**"
                : "🛑 **Auction entries are now closed.**",
          });

          // Best-effort cleanup of reactions (may fail without perms)
          try {
            await joinMsg.reactions.removeAll();
          } catch {}

          const players = new Map();
          for (const id of entrants) players.set(id, { balance: startMoney });

          const res = manager.tryStart(
            { guildId },
            {
              guildId,
              channelId: message.channel.id,
              client: message.client,
              hostId: message.author.id,
              players,
              activeItem: null,
              bids: new Map(),
              roundMessageId: null,
              history: [],
            }
          );

          if (!res.ok) {
            await message.channel.send(res.errorText);
            return;
          }

          await message.channel.send(
            `✅ Auction created!\nPlayers: ${[...players.keys()].map((id) => `<@${id}>`).join(", ")}`
          );
          return;
        }

        /* ---------- EVERYTHING BELOW REQUIRES AUCTION ---------- */

        const auction = manager.getState({ guildId });
        if (!auction) {
          await message.reply("No active auction.");
          return;
        }

        if (!(await requireSameChannel({ message }, auction, manager))) return;

        /* ---------- START ROUND ---------- */
        if (sub === "start") {
          const ok = await requireCanManage(
            { message },
            auction,
            { ownerField: "hostId", managerLabel: "auction", deniedText: null }
          );
          if (!ok) return;

          let roundSeconds = null;
          let tokens = args;
          const maybe = parseDurationSeconds(args.at(-1), null);
          if (maybe != null) {
            roundSeconds = maybe;
            tokens = args.slice(0, -1);
          }

          const item = tokens.join(" ");
          if (!item) return;

          // clear any prior round timers defensively
          clearRoundTimers(auction);

          auction.activeItem = item;
          auction.bids.clear();

          const msg = await message.channel.send({
            content:
              `🔔 **Auction started!**\nItem: **${item}**\n` +
              `Round time: **${formatDurationSeconds(roundSeconds)}**`,
            components: [buildBidRow(true)],
          });

          auction.roundMessageId = msg.id;

          if (roundSeconds) {
            // TimerBag-managed; auto-cleared on manager.stop()
            auction.timers.setTimeout(() => endRound(auction, message.channel), roundSeconds * 1000);
          }
          return;
        }

        /* ---------- END ROUND ---------- */
        if (sub === "endround") {
          const ok = await requireCanManage(
            { message },
            auction,
            { ownerField: "hostId", managerLabel: "auction", deniedText: null }
          );
          if (!ok) return;

          if (!auction.activeItem) return;

          await endRound(auction, message.channel);
          return;
        }

        /* ---------- END AUCTION ---------- */
        if (sub === "end") {
          const ok = await requireCanManage(
            { message },
            auction,
            { ownerField: "hostId", managerLabel: "auction", deniedText: null }
          );
          if (!ok) return;

          clearRoundTimers(auction);
          await disableRoundButtons(auction, message.channel);

          await postSummary(message.channel, auction);

          manager.stop({ guildId });
          return;
        }

        await message.reply("Unknown subcommand. Try `!auction help`.");
      },
    }),
    "!auction — run a private bidding auction",
    { category: "Games", helpTier: "primary" }
  );

  /* ========================= COMPONENTS ================================ */

  register.component("auction:bid", async ({ interaction }) => {
    const auction = manager.getState({ guildId: interaction.guildId });
    if (!auction || !auction.activeItem) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "No active round.",
      });
      return;
    }
    await interaction.showModal(buildBidModal());
  });

  register.component("auction:bidmodal", async ({ interaction }) => {
    const auction = manager.getState({ guildId: interaction.guildId });
    if (!auction || !auction.activeItem) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "No active round.",
      });
      return;
    }

    const amount = Number(interaction.fields.getTextInputValue("amount"));
    const player = auction.players.get(interaction.user.id);

    if (!player || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Invalid bid.",
      });
      return;
    }

    if (amount > player.balance) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Insufficient balance for that bid.",
      });
      return;
    }

    auction.bids.set(interaction.user.id, { amount, ts: now() });

    // Auto-finalize when all bids are in
    if (auction.bids.size === auction.players.size) {
      // stop any pending round timer
      clearRoundTimers(auction);
      await endRound(auction, interaction.channel);
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `Bid set to **${amount}**.`,
    });
  });

  register.component("auction:mybid", async ({ interaction }) => {
    const auction = manager.getState({ guildId: interaction.guildId });
    const bid = auction?.bids.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: bid ? `Your bid: **${bid.amount}**` : "No bid placed.",
    });
  });

  register.component("auction:balance", async ({ interaction }) => {
    const auction = manager.getState({ guildId: interaction.guildId });
    const p = auction?.players.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: p ? `Balance: **${p.balance}**` : "Not in auction.",
    });
  });
}

export const __testables = {
  renderStatus,
  buildBidRow,
  buildBidModal,
};
