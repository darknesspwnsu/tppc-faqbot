// games/auction.js
//
// Discord Auction (MVP)
// - One auction per guild
// - In-memory only
// - Private bids via buttons + modal
// - Auto-finalize when all bids are in
// - Full summary on end

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";

/* =============================== STATE ================================= */

const ACTIVE = new Map(); // guildId -> auction session

/* ============================== HELPERS ================================ */

function parseDurationSeconds(raw, def) {
  if (!raw) return def;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);

  const m = s.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/
  );
  if (!m) return null;

  const v = Number(m[1]);
  const u = m[2];
  if (u.startsWith("s")) return v;
  if (u.startsWith("m")) return v * 60;
  if (u.startsWith("h")) return v * 3600;
  return null;
}

function canManage(message, auction) {
  if (!auction) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author.id === auction.hostId;
}

function inSameChannel(message, auction) {
  return (
    message.guild.id === auction.guildId &&
    message.channel.id === auction.channelId
  );
}

function now() {
  return Date.now();
}

function formatDuration(sec) {
  return sec ? `${sec}s` : "NONE";
}

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
  const modal = new ModalBuilder()
    .setCustomId("auction:bidmodal")
    .setTitle("Place Your Bid");

  const amount = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Bid amount")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(amount));
  return modal;
}

/* ============================ ROUND LOGIC =============================== */

async function disableRoundButtons(auction) {
  if (!auction.roundMessageId) return;
  try {
    const ch = await auction.client.channels.fetch(auction.channelId);
    const msg = await ch.messages.fetch(auction.roundMessageId);
    await msg.edit({ components: [buildBidRow(false)] });
  } catch {}
}

async function endRound(auction, channel) {
  await disableRoundButtons(auction);

  const bids = [...auction.bids.entries()]
    .map(([uid, b]) => ({ uid, ...b }))
    .sort((a, b) =>
      b.amount !== a.amount ? b.amount - a.amount : a.ts - b.ts
    );

  if (!bids.length) {
    await channel.send(`⏹️ **${auction.activeItem} — no bids placed.**`);
    auction.activeItem = null;
    auction.bids.clear();
    return;
  }

  const winner = bids[0];
  auction.players.get(winner.uid).balance -= winner.amount;

  auction.history.push({
    item: auction.activeItem,
    winnerId: winner.uid,
    amount: winner.amount,
  });

  await channel.send(
    `🏆 **${auction.activeItem} sold!**\n` +
      `Winner: <@${winner.uid}> — **${winner.amount}**`
  );

  auction.activeItem = null;
  auction.bids.clear();

  if (auction.timer) {
    clearTimeout(auction.timer);
    auction.timer = null;
  }
}

/* =========================== REGISTRATION =============================== */

export function registerAuction(register) {
  register(
    "!auction",
    async ({ message, rest }) => {
      if (!message.guild) return;

      const args = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (args.shift() || "").toLowerCase();
      const guildId = message.guild.id;

      /* ---------- ALWAYS AVAILABLE ---------- */

      if (sub === "help") {
        await message.reply(auctionHelpText());
        return;
      }

      if (sub === "rules") {
        await message.reply(auctionRulesText());
        return;
      }

      if (sub === "status") {
        const auction = ACTIVE.get(guildId);
        if (!auction) {
          await message.reply(
            "🪙 **Auction Status**\nNo active auction in this server."
          );
          return;
        }

        const players = [...auction.players.entries()]
          .map(([id, p]) => `• <@${id}> — ${p.balance}`)
          .join("\n");

        let out =
          `🪙 **Auction Status**\n` +
          `Host: <@${auction.hostId}>\n\n` +
          `Players (${auction.players.size}):\n${players}\n\n` +
          `Rounds completed: ${auction.history.length}\n`;

        if (auction.activeItem) {
          out +=
            `Current item: **${auction.activeItem}**\n` +
            `Bids: ${auction.bids.size}/${auction.players.size}`;
        } else {
          out += `Current round: none`;
        }

        await message.reply(out);
        return;
      }

      /* ---------- JOIN ---------- */

      if (sub === "join") {
        if (ACTIVE.has(guildId)) {
          await message.reply("⚠️ An auction is already running.");
          return;
        }

        const joinSeconds = parseDurationSeconds(args[0], 30);
        const maxPlayers = Number(args[1]) || null;
        const startMoney = Number(args[2]) || 500;

        const joinMsg = await message.channel.send(
          `🪙 **Auction starting!**\nReact ✅ to join (${joinSeconds}s)`
        );
        await joinMsg.react("✅");

        const players = new Map();
        const collector = joinMsg.createReactionCollector({
          time: joinSeconds * 1000,
          dispose: true,
          filter: (r, u) => r.emoji.name === "✅" && !u.bot,
        });

        collector.on("collect", (_, user) => {
          if (players.has(user.id)) return;
          players.set(user.id, { balance: startMoney });
          if (maxPlayers && players.size >= maxPlayers) {
            collector.stop("max");
          }
        });

        collector.on("remove", (_, user) => {
          players.delete(user.id);
        });

        collector.on("end", async (_c, reason) => {
          if (!players.size) {
            await message.channel.send("❌ Auction cancelled — no players.");
            return;
          }

          await joinMsg.edit({
            content:
              reason === "max"
                ? "🛑 **Auction entries are now closed (max players reached).**"
                : "🛑 **Auction entries are now closed.**",
            reactions: [],
          });

          ACTIVE.set(guildId, {
            guildId,
            channelId: message.channel.id,
            hostId: message.author.id,
            client: message.client,
            players,
            activeItem: null,
            bids: new Map(),
            timer: null,
            roundMessageId: null,
            history: [],
          });

          await message.channel.send(
            `✅ Auction created!\nPlayers: ${[...players.keys()]
              .map((id) => `<@${id}>`)
              .join(", ")}`
          );
        });
        return;
      }

      /* ---------- EVERYTHING BELOW REQUIRES AUCTION ---------- */

      const auction = ACTIVE.get(guildId);
      if (!auction) {
        await message.reply("No active auction.");
        return;
      }

      if (!inSameChannel(message, auction)) {
        await message.reply(`Auction is running in <#${auction.channelId}>.`);
        return;
      }

      /* ---------- START ROUND ---------- */

      if (sub === "start") {
        if (!canManage(message, auction)) return;

        let roundSeconds = null;
        let tokens = args;
        const maybe = parseDurationSeconds(args.at(-1), null);
        if (maybe != null) {
          roundSeconds = maybe;
          tokens = args.slice(0, -1);
        }

        const item = tokens.join(" ");
        if (!item) return;

        auction.activeItem = item;
        auction.bids.clear();

        const msg = await message.channel.send({
          content:
            `🔔 **Auction started!**\nItem: **${item}**\n` +
            `Round time: **${formatDuration(roundSeconds)}**`,
          components: [buildBidRow(true)],
        });

        auction.roundMessageId = msg.id;

        if (roundSeconds) {
          auction.timer = setTimeout(
            () => endRound(auction, message.channel),
            roundSeconds * 1000
          );
        }
        return;
      }

      /* ---------- END ROUND ---------- */

      if (sub === "endround") {
        if (!canManage(message, auction)) return;
        if (!auction.activeItem) return;
        await endRound(auction, message.channel);
        return;
      }

      /* ---------- END AUCTION ---------- */

      if (sub === "end") {
        if (!canManage(message, auction)) return;

        await disableRoundButtons(auction);

        if (auction.history.length) {
          const lines = auction.history.map(
            (r, i) =>
              `${i + 1}) **${r.item}** — <@${r.winnerId}> (${r.amount})`
          );
          await message.channel.send(
            `🪙 **Auction Summary**\n\n${lines.join("\n")}`
          );
        } else {
          await message.channel.send("🪙 **Auction ended. No items sold.**");
        }

        ACTIVE.delete(guildId);
        return;
      }

      await message.reply("Unknown subcommand. Try `!auction help`.");
    },
    "!auction — run a private bidding auction",
    { category: "Games", helpTier: "primary" }
  );

  /* ========================= COMPONENTS ================================ */

  register.component("auction:bid", async ({ interaction }) => {
    const auction = ACTIVE.get(interaction.guildId);
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
    const auction = ACTIVE.get(interaction.guildId);
    if (!auction || !auction.activeItem) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "No active round.",
      });
      return;
    }

    const amount = Number(interaction.fields.getTextInputValue("amount"));
    const player = auction.players.get(interaction.user.id);
    if (!player || amount < 1 || amount > player.balance) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Invalid bid.",
      });
      return;
    }

    auction.bids.set(interaction.user.id, { amount, ts: now() });

    if (auction.bids.size === auction.players.size) {
      if (auction.timer) clearTimeout(auction.timer);
      await endRound(auction, interaction.channel);
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `Bid set to **${amount}**.`,
    });
  });

  register.component("auction:mybid", async ({ interaction }) => {
    const auction = ACTIVE.get(interaction.guildId);
    const bid = auction?.bids.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: bid ? `Your bid: **${bid.amount}**` : "No bid placed.",
    });
  });

  register.component("auction:balance", async ({ interaction }) => {
    const auction = ACTIVE.get(interaction.guildId);
    const p = auction?.players.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: p ? `Balance: **${p.balance}**` : "Not in auction.",
    });
  });
}
