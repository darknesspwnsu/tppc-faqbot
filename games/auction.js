// games/auction.js
//
// Discord Auction (MVP)
// - One auction per guild
// - Session created via !auction join
// - Private bids via button + modal
// - Optional timed rounds (auto-end)
// - Everything in-memory

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

/* ------------------------------- state ---------------------------------- */

const ACTIVE = new Map(); // guildId -> auction session

/* ------------------------------- helpers -------------------------------- */

function parseDurationSeconds(raw, defaultSeconds) {
  if (!raw) return defaultSeconds;

  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);

  const m = s.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/
  );
  if (!m) return null;

  const value = Number(m[1]);
  const unit = m[2];

  if (unit.startsWith("s")) return value;
  if (unit.startsWith("m")) return value * 60;
  if (unit.startsWith("h")) return value * 3600;

  return null;
}

function canManage(message, auction) {
  if (!auction) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === auction.hostId;
}

function inSameChannel(ctx, auction) {
  const gid = ctx.guildId || ctx.guild?.id;
  const cid = ctx.channelId || ctx.channel?.id;
  return gid === auction.guildId && cid === auction.channelId;
}

function now() {
  return Date.now();
}

function formatDuration(sec) {
  return sec ? `${sec}s` : "NONE";
}

/* ------------------------------- text ----------------------------------- */

function auctionHelpText() {
  return [
    "**Auction — Help**",
    "",
    "**Start & Join:**",
    "• `!auction join [seconds] [max] [startMoney]`",
    "",
    "**Host Commands:**",
    "• `!auction start <item name> [roundSeconds]`",
    "• `!auction endround`",
    "• `!auction status`",
    "• `!auction cancel`",
    "• `!auction end`",
    "",
    "**Players:**",
    "• Click **Place Bid** to submit a private bid",
    "",
    "Type `!auction rules` to learn how to play.",
  ].join("\n");
}

function auctionRulesText() {
  return [
    "**Auction — Rules**",
    "",
    "• The host opens an auction and players join.",
    "• Everyone gets virtual money for this session.",
    "• When an item starts, place a private bid using the button.",
    "• You may change your bid until the round ends.",
    "• Highest bid wins and pays that amount.",
    "• The host starts the next item and repeats.",
  ].join("\n");
}

/* ------------------------------- UI ------------------------------------- */

function buildBidRow({ active }) {
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
    .setRequired(true)
    .setPlaceholder("Enter a whole number");

  modal.addComponents(new ActionRowBuilder().addComponents(amount));
  return modal;
}

/* ------------------------------- round logic ---------------------------- */

async function disableRoundButtons(auction) {
  if (!auction.roundMessageId) return;

  try {
    const ch = await auction.client.channels.fetch(auction.channelId);
    const msg = await ch.messages.fetch(auction.roundMessageId);
    await msg.edit({
      components: [buildBidRow({ active: false })],
    });
  } catch {}
}

async function endRound(auction, channel) {
  await disableRoundButtons(auction);

  const bids = Array.from(auction.bids.entries())
    .map(([uid, b]) => ({ uid, ...b }))
    .sort((a, b) =>
      b.amount !== a.amount ? b.amount - a.amount : a.ts - b.ts
    );

  if (!bids.length) {
    await channel.send("⏹️ **Round ended — no bids were placed.**");
    auction.activeItem = null;
    auction.bids.clear();
    return;
  }

  const winner = bids[0];
  auction.players.get(winner.uid).balance -= winner.amount;

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

/* ------------------------------- registration --------------------------- */

export function registerAuction(register) {
  register(
    "!auction",
    async ({ message, rest }) => {
      if (!message.guild) return;

      const args = String(rest ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (args.shift() || "").toLowerCase();
      const guildId = message.guild.id;

      /* ---- help / rules ---- */

      if (sub === "help") {
        await message.reply(auctionHelpText());
        return;
      }

      if (sub === "rules") {
        await message.reply(auctionRulesText());
        return;
      }

      /* ---- join ---- */

      if (sub === "join") {
        if (ACTIVE.has(guildId)) {
          const a = ACTIVE.get(guildId);
          await message.reply(
            `⚠️ Auction already running in <#${a.channelId}>.`
          );
          return;
        }

        const joinSeconds = parseDurationSeconds(args[0], 30);
        if (joinSeconds == null || joinSeconds < 5 || joinSeconds > 3600) {
          await message.reply("❌ Invalid join duration.");
          return;
        }

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
          if (maxPlayers && players.size >= maxPlayers) {
            collector.stop("max");
            return;
          }
          players.set(user.id, { balance: startMoney });
        });

        collector.on("remove", (_, user) => {
          players.delete(user.id);
        });

        collector.on("end", async (_c, reason) => {
          if (players.size === 0) {
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
          });

          await message.channel.send(
            `✅ Auction created!\nPlayers: ${[...players.keys()]
              .map((id) => `<@${id}>`)
              .join(", ")}`
          );
        });

        return;
      }

      const auction = ACTIVE.get(guildId);
      if (!auction) {
        await message.reply("No active auction.");
        return;
      }

      if (!inSameChannel(message, auction)) {
        await message.reply(`Auction is running in <#${auction.channelId}>.`);
        return;
      }

      /* ---- status ---- */

      if (sub === "status") {
        const players = [...auction.players.entries()]
          .map(([id, p]) => `• <@${id}> — ${p.balance}`)
          .join("\n");

        await message.reply(
          `🪙 **Auction Status**\n` +
            `Host: <@${auction.hostId}>\n\n` +
            `Players:\n${players || "(none)"}\n\n` +
            `Item: ${auction.activeItem ?? "None"}\n` +
            `Bids: ${auction.bids.size}/${auction.players.size}`
        );
        return;
      }

      /* ---- start item ---- */

      if (sub === "start") {
        if (!canManage(message, auction)) {
          await message.reply("Only the host can start an item.");
          return;
        }

        if (auction.activeItem) {
          await message.reply("A round is already active.");
          return;
        }

        let roundSeconds = null;
        let itemTokens = args;

        const maybeDuration = parseDurationSeconds(args[args.length - 1], null);
        if (maybeDuration != null) {
          roundSeconds = maybeDuration;
          itemTokens = args.slice(0, -1);
        }

        const item = itemTokens.join(" ");
        if (!item) {
          await message.reply("Usage: `!auction start <item> [seconds]`");
          return;
        }

        auction.activeItem = item;
        auction.bids.clear();

        const msg = await message.channel.send({
          content:
            `🔔 **Auction started!**\n` +
            `Item: **${item}**\n` +
            `Round time: **${formatDuration(roundSeconds)}**`,
          components: [buildBidRow({ active: true })],
        });

        auction.roundMessageId = msg.id;

        if (roundSeconds) {
          auction.timer = setTimeout(() => {
            endRound(auction, message.channel);
          }, roundSeconds * 1000);
        }

        return;
      }

      /* ---- end round ---- */

      if (sub === "endround") {
        if (!canManage(message, auction)) {
          await message.reply("Only the host can end the round.");
          return;
        }
        if (!auction.activeItem) {
          await message.reply("No active round.");
          return;
        }
        await endRound(auction, message.channel);
        return;
      }

      /* ---- end / cancel ---- */

      if (sub === "end" || sub === "cancel") {
        if (!canManage(message, auction)) {
          await message.reply("Only the host can end the auction.");
          return;
        }

        await disableRoundButtons(auction);
        ACTIVE.delete(guildId);
        await message.channel.send("🛑 **Auction ended.**");
        return;
      }

      await message.reply("Unknown subcommand. Try `!auction help`.");
    },
    "!auction — run a private bidding auction",
    { category: "Games", helpTier: "primary" }
  );

  /* ------------------- components ------------------- */

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
    if (!Number.isInteger(amount) || amount < 1) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Bid must be a whole number ≥ 1.",
      });
      return;
    }

    const player = auction.players.get(interaction.user.id);
    if (!player || amount > player.balance) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Invalid bid or insufficient balance.",
      });
      return;
    }

    auction.bids.set(interaction.user.id, { amount, ts: now() });

    if (auction.bids.size === auction.players.size) {
      if (auction.timer) {
        clearTimeout(auction.timer);
        auction.timer = null;
      }
      await endRound(auction, interaction.channel);
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `Bid set to **${amount}**.`,
    });
  });

  register.component("auction:mybid", async ({ interaction }) => {
    const auction = ACTIVE.get(interaction.guildId);
    if (!auction || !auction.activeItem) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "No active round.",
      });
      return;
    }

    const bid = auction.bids.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: bid ? `Your bid: **${bid.amount}**` : "You have not bid yet.",
    });
  });

  register.component("auction:balance", async ({ interaction }) => {
    const auction = ACTIVE.get(interaction.guildId);
    const p = auction?.players.get(interaction.user.id);
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: p ? `Balance: **${p.balance}**` : "Not in this auction.",
    });
  });
}
