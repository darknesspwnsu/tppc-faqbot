// games/deal_or_no_deal.js
//
// Deal or No Deal (host-driven)
//
// Flow:
//   /dond boxes:<int> contestant:@user
//     -> opens a Modal where the host pastes a line-separated prize list
//        - blank lines or "Empty" mean the box is empty
//        - fewer prizes than boxes => remaining boxes are empty
//
//   Contestant picks a KEPT box via buttons.
//   Host then opens/discards boxes via bang commands.
//   "Unopened boxes remaining" includes the kept box (it is unopened, just reserved).
//
// Host commands:
//   !dondopen <n>        -> open a DISCARDED box (never the kept box)
//   !dondstatus
//   !dondswitch          -> only when exactly 2 unopened boxes remain (kept + 1 other)
//   !dondend [deal|nodeal]
//   !dondcancel
//   !dondreveal          -> reveals last game's full box list
//   !dondoffer <text...> -> (optional) announce banker offer (any freeform offer)
//
// One active game per guild. Game is bound to the start channel.

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

const ACTIVE = new Map();        // guildId -> game
const LAST_BY_GUILD = new Map(); // guildId -> snapshot

const MIN_BOXES = 2;
const MAX_BOXES = 25;

function clampInt(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x) || !Number.isInteger(x)) return null;
  if (x < lo || x > hi) return null;
  return x;
}

function canManage(message, game) {
  if (!game) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === game.hostId;
}

function inSameChannel(msgOrInteraction, game) {
  const gid = msgOrInteraction.guildId || msgOrInteraction.guild?.id;
  const cid = msgOrInteraction.channelId || msgOrInteraction.channel?.id;
  return Boolean(gid && cid && gid === game.guildId && cid === game.channelId);
}

function normalizePrizeLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return "(empty)";
  if (s.toLowerCase() === "empty") return "(empty)";
  return s;
}

function parsePrizesFromLines(raw, n) {
  const text = String(raw ?? "");
  const lines = text.split(/\r?\n/);
  const prizes = [];
  for (let i = 0; i < n; i++) prizes.push(normalizePrizeLine(lines[i]));
  return prizes;
}

function unopenedIndices(game) {
  // NOTE: includes the kept box because it is still unopened.
  const out = [];
  for (let i = 0; i < game.n; i++) {
    if (!game.boxes[i].opened) out.push(i);
  }
  return out;
}

function otherUnopenedIndex(game) {
  // Only valid when exactly 2 unopened remain: kept + 1 other.
  const un = unopenedIndices(game);
  if (un.length !== 2) return null;
  if (game.keptIndex == null) return null;
  return un[0] === game.keptIndex ? un[1] : un[0];
}

function boardText(game) {
  const lines = [];
  lines.push(`💼 **Deal or No Deal** — Host: <@${game.hostId}> • Contestant: <@${game.contestantId}>`);

  if (game.phase === "choose_keep") {
    lines.push(`🎯 Contestant: choose a box to **KEEP** (buttons below).`);
  } else {
    lines.push(`🔒 Kept box: ${game.keptIndex != null ? `**#${game.keptIndex + 1}**` : "(not chosen yet)"}`);
    lines.push(`🗑️ Host opens **discarded** boxes using \`!dondopen N\`.`);
  }

  const un = unopenedIndices(game).length;
  lines.push(`📦 Unopened boxes remaining (includes kept box): **${un}/${game.n}**`);
  if (game.dealTaken) lines.push(`🤝 Deal taken: **YES** (kept prize hidden unless revealed)`);
  lines.push("");

  // Compact line: opened=❌, kept=🔒, unopened=🟦
  const cells = [];
  for (let i = 0; i < game.n; i++) {
    const b = game.boxes[i];
    const isKept = game.keptIndex === i;
    const mark = b.opened ? "❌" : isKept ? "🔒" : "🟦";
    cells.push(`${mark}${String(i + 1).padStart(2, " ")}`);
  }
  lines.push(cells.join("  "));
  lines.push("");
  lines.push(`Help: \`!dondhelp\``);

  return lines.join("\n");
}

function buildKeepButtons(game, { disabled = false } = {}) {
  const rows = [];
  const perRow = 5;
  const totalRows = Math.ceil(game.n / perRow);

  for (let r = 0; r < totalRows; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < perRow; c++) {
      const idx = r * perRow + c;
      if (idx >= game.n) break;

      const b = game.boxes[idx];
      const isKept = game.keptIndex === idx;

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`dond:keep:${idx}`)
          .setLabel(String(idx + 1))
          .setStyle(isKept ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(disabled || b.opened || game.phase !== "choose_keep")
      );
    }
    rows.push(row);
  }
  return rows;
}

async function safeEditBoard(game, payload) {
  try {
    const ch = game.client?.channels?.cache?.get(game.channelId);
    if (!ch) return false;
    const msg = await ch.messages.fetch(game.boardMessageId);
    if (!msg) return false;
    await msg.edit(payload);
    return true;
  } catch {
    return false;
  }
}

function snapshotGame(game) {
  return {
    guildId: game.guildId,
    channelId: game.channelId,
    hostId: game.hostId,
    contestantId: game.contestantId,
    n: game.n,
    keptIndex: game.keptIndex,
    dealTaken: Boolean(game.dealTaken),
    endedAtMs: Date.now(),
    boxes: game.boxes.map((b) => ({ prize: b.prize, opened: b.opened })),
  };
}

function revealAllText(snap) {
  const lines = [];
  lines.push(`🧾 **Deal or No Deal — Full Reveal**`);
  lines.push(`Host: <@${snap.hostId}> • Contestant: <@${snap.contestantId}>`);
  if (snap.keptIndex != null) lines.push(`Kept box: **#${snap.keptIndex + 1}**`);
  lines.push(`Deal taken: **${snap.dealTaken ? "YES" : "NO"}**`);
  lines.push("");

  for (let i = 0; i < snap.n; i++) {
    const b = snap.boxes[i];
    const kept = snap.keptIndex === i ? " 🔒(kept)" : "";
    lines.push(`• Box #${i + 1}${kept}: ${b.prize}`);
  }
  return lines.join("\n");
}

export function registerDealOrNoDeal(register) {
  // /dond -> open modal (prize list only)
  register.slash(
    {
      name: "dond",
      description: "Start Deal or No Deal (modal prize list; host opens discarded boxes)",
      options: [
        { type: 4, name: "boxes", description: `Number of boxes (${MIN_BOXES}–${MAX_BOXES})`, required: true },
        { type: 6, name: "contestant", description: "Contestant who will play", required: true },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "This can only be used in a server." });
        return;
      }

      if (ACTIVE.has(guildId)) {
        const g = ACTIVE.get(guildId);
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `⚠️ Deal or No Deal is already running in <#${g.channelId}>.`,
        });
        return;
      }

      const boxesRaw = interaction.options?.getInteger?.("boxes");
      const contestant = interaction.options?.getUser?.("contestant");

      const n = clampInt(boxesRaw, MIN_BOXES, MAX_BOXES);
      if (!n) {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `❌ boxes must be an integer ${MIN_BOXES}–${MAX_BOXES}.`,
        });
        return;
      }

      if (!contestant?.id || contestant.bot) {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Contestant must be a real user (not a bot)." });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`dond_modal:${n}:${contestant.id}`)
        .setTitle("Deal or No Deal — Prize List");

      const prizesInput = new TextInputBuilder()
        .setCustomId("prizes")
        .setLabel("Prizes (one per line, Box 1..N)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder(
          [
            "One prize per line (Box 1..N):",
            "- Blank line or 'Empty' = empty box",
            "",
            "$1",
            "$5",
            "Golden Shiny Pikachu",
            "Empty",
            "...",
          ].join("\n")
        );

      modal.addComponents(new ActionRowBuilder().addComponents(prizesInput));
      await interaction.showModal(modal);
    }
  );

  // Modal submit -> create game + board
  register.component("dond_modal:", async ({ interaction }) => {
    if (!interaction.isModalSubmit?.()) return;

    const gid = interaction.guildId;
    if (!gid) return;

    if (ACTIVE.has(gid)) {
      const g = ACTIVE.get(gid);
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `⚠️ Deal or No Deal is already running in <#${g.channelId}>.`,
      });
      return;
    }

    const id = String(interaction.customId || "");
    const parts = id.split(":"); // dond_modal:<n>:<contestantId>
    if (parts.length !== 3) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Invalid modal payload." });
      return;
    }

    const n = clampInt(parts[1], MIN_BOXES, MAX_BOXES);
    const contestantId = parts[2];
    if (!n || !contestantId) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "❌ Invalid modal payload." });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.send) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Could not access this channel." });
      return;
    }

    const raw = interaction.fields?.getTextInputValue?.("prizes") ?? "";
    const prizes = parsePrizesFromLines(raw, n);

    const game = {
      kind: "dond",
      client: interaction.client,
      guildId: gid,
      channelId: channel.id,
      hostId: interaction.user.id,
      contestantId,
      n,
      boxes: prizes.map((p) => ({ prize: p, opened: false })),
      keptIndex: null,
      phase: "choose_keep", // choose_keep | running | final | ended
      dealTaken: false,
      boardMessageId: null,
    };

    const board = await channel.send({
      content: boardText(game),
      components: buildKeepButtons(game),
    });

    game.boardMessageId = board.id;
    ACTIVE.set(gid, game);

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content:
        `✅ Started Deal or No Deal in <#${channel.id}> for <@${contestantId}> with **${n}** boxes.\n` +
        `Contestant should pick a kept box using the buttons on the board.`,
    });
  });

  // Buttons: contestant picks kept box
  register.component("dond:keep:", async ({ interaction }) => {
    if (!interaction.isButton?.()) return;

    const gid = interaction.guildId;
    if (!gid) return;

    const game = ACTIVE.get(gid);
    if (!game) return;

    if (!inSameChannel(interaction, game)) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: `This game is running in <#${game.channelId}>.` });
      return;
    }

    if (interaction.user.id !== game.contestantId) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Only the contestant can pick the kept box." });
      return;
    }

    if (game.phase !== "choose_keep") {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Kept box has already been chosen." });
      return;
    }

    const idx = Number(String(interaction.customId).split(":").pop());
    if (!Number.isInteger(idx) || idx < 0 || idx >= game.n) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Invalid box." });
      return;
    }

    if (game.boxes[idx].opened) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That box is already opened." });
      return;
    }

    game.keptIndex = idx;
    game.phase = "running";

    await interaction.reply({ flags: MessageFlags.Ephemeral, content: `✅ You are keeping **Box #${idx + 1}**.` });

    await safeEditBoard(game, { content: boardText(game), components: buildKeepButtons(game) });

    try {
      await interaction.channel.send(
        `🔒 <@${game.contestantId}> is keeping **Box #${idx + 1}**.\n` +
          `Host: open **discarded** boxes with \`!dondopen N\` (kept box is locked).`
      );
    } catch {}
  });

  // ---- Bang commands ----

  register(
    "!dondhelp",
    async ({ message }) => {
      await message.reply(
        [
          "**Deal or No Deal — Commands**",
          "",
          "**Start:**",
          "• `/dond boxes:<2-25> contestant:@user` → opens modal for prize list",
          "",
          "**Contestant:**",
          "• Picks a kept box using the board buttons",
          "",
          "**Host/Admin:**",
          "• `!dondopen N` — open a **discarded** box (cannot open kept box)",
          "• `!dondstatus` — show board state",
          "• `!dondswitch` — only when 2 unopened remain (kept + 1 other)",
          "• `!dondend [deal|nodeal]` — end game (deal hides kept prize until reveal)",
          "• `!dondreveal` — reveal all prizes from last game snapshot",
          "• `!dondcancel` — cancel current game",
          "• `!dondoffer <text...>` — announce banker offer (any freeform offer)",
        ].join("\n")
      );
    },
    "!dondhelp — help for Deal or No Deal",
    { hideFromHelp: false }
  );

  register(
    "!dondstatus",
    async ({ message }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game in this server."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Deal or No Deal is running in <#${game.channelId}>.`));
      await message.reply(boardText(game));
    },
    "!dondstatus — show Deal or No Deal board",
    { hideFromHelp: true }
  );

  register(
    "!dondoffer",
    async ({ message, rest }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Running in <#${game.channelId}>.`));
      if (!canManage(message, game)) return void (await message.reply("Nope — only admins/privileged or the host can do that."));

      const offer = String(rest ?? "").trim();
      if (!offer) return void (await message.reply("Usage: `!dondoffer <banker offer text>`"));

      await message.channel.send(`📞 **BANKER OFFER:** ${offer}`);
    },
    "!dondoffer <text> — announce banker offer",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondopen",
    async ({ message, rest }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Running in <#${game.channelId}>.`));
      if (!canManage(message, game)) return void (await message.reply("Nope — only admins/privileged or the host can do that."));

      if (game.keptIndex == null) {
        await message.reply("⚠️ Kept box not chosen yet. Contestant must pick a kept box first.");
        return;
      }

      const n = clampInt(String(rest ?? "").trim(), 1, game.n);
      if (!n) return void (await message.reply(`Usage: \`!dondopen <1-${game.n}>\` (opens a discarded box)`));
      const idx = n - 1;

      if (idx === game.keptIndex) {
        return void (await message.reply(`❌ Box #${idx + 1} is the contestant’s **kept** box. Open a **discarded** box instead.`));
      }
      if (game.boxes[idx].opened) return void (await message.reply("That box is already opened."));

      game.boxes[idx].opened = true;
      await message.channel.send(`🗑️ Discarded **Box #${idx + 1}** opened → **${game.boxes[idx].prize}**`);

      const remaining = unopenedIndices(game);
      if (remaining.length === 2) game.phase = "final";

      await safeEditBoard(game, { content: boardText(game), components: buildKeepButtons(game) });

      if (game.phase === "final") {
        const other = otherUnopenedIndex(game);
        await message.channel.send(
          `🏁 **FINAL ROUND** — 2 unopened boxes left (**kept + 1 other**).\n` +
            `Kept: **#${game.keptIndex + 1}** vs Other: **#${other + 1}**\n` +
            `Host can use \`!dondswitch\` then \`!dondend [deal|nodeal]\`.`
        );
      }
    },
    "!dondopen <box#> — open a discarded box",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondswitch",
    async ({ message }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Running in <#${game.channelId}>.`));
      if (!canManage(message, game)) return void (await message.reply("Nope — only admins/privileged or the host can do that."));

      if (game.keptIndex == null) return void (await message.reply("Kept box not chosen yet."));
      const other = otherUnopenedIndex(game);
      if (other == null) {
        return void (await message.reply("❌ Switch is only allowed when exactly 2 unopened boxes remain (kept + 1 other)."));
      }

      const prev = game.keptIndex;
      game.keptIndex = other;

      await safeEditBoard(game, { content: boardText(game), components: buildKeepButtons(game) });
      await message.channel.send(`🔁 Switched kept box from **#${prev + 1}** to **#${game.keptIndex + 1}**.`);
    },
    "!dondswitch — swap kept box with the other final box",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondend",
    async ({ message, rest }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Running in <#${game.channelId}>.`));
      if (!canManage(message, game)) return void (await message.reply("Nope — only admins/privileged or the host can do that."));

      if (game.keptIndex == null) return void (await message.reply("Kept box not chosen yet."));

      const mode = String(rest ?? "").trim().toLowerCase();
      const isDeal = mode === "deal";

      game.phase = "ended";
      game.dealTaken = isDeal;

      const snap = snapshotGame(game);
      LAST_BY_GUILD.set(game.guildId, snap);
      ACTIVE.delete(game.guildId);

      await safeEditBoard(game, {
        content: boardText(game),
        components: buildKeepButtons(game, { disabled: true }),
      });

      if (isDeal) {
        await message.channel.send(
          `🤝 **DEAL TAKEN!** Game ended.\n` +
            `Kept box **#${game.keptIndex + 1}** stays hidden.\n` +
            `Use \`!dondreveal\` to show every box afterwards.`
        );
      } else {
        await message.channel.send(
          `🏁 **NO DEAL!** <@${game.contestantId}> kept **Box #${game.keptIndex + 1}** → **${game.boxes[game.keptIndex].prize}**\n` +
            `Use \`!dondreveal\` to show all boxes.`
        );
      }
    },
    "!dondend [deal|nodeal] — end Deal or No Deal",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondcancel",
    async ({ message }) => {
      const game = ACTIVE.get(message.guildId);
      if (!game) return void (await message.reply("No active Deal or No Deal game."));
      if (!inSameChannel(message, game)) return void (await message.reply(`Running in <#${game.channelId}>.`));
      if (!canManage(message, game)) return void (await message.reply("Nope — only admins/privileged or the host can do that."));

      const snap = snapshotGame(game);
      LAST_BY_GUILD.set(game.guildId, snap);
      ACTIVE.delete(game.guildId);

      await safeEditBoard(game, {
        content: `🛑 **Deal or No Deal cancelled** by <@${message.author.id}>.\n\n` + boardText({ ...game, phase: "ended" }),
        components: buildKeepButtons(game, { disabled: true }),
      });

      await message.channel.send("🛑 Cancelled. You can still run `!dondreveal` to show the snapshot prizes.");
    },
    "!dondcancel — cancel Deal or No Deal",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondreveal",
    async ({ message }) => {
      const snap = LAST_BY_GUILD.get(message.guildId);
      if (!snap) {
        await message.reply("No previous Deal or No Deal snapshot to reveal yet.");
        return;
      }
      await message.channel.send(revealAllText(snap));
    },
    "!dondreveal — reveal prizes from the last Deal or No Deal game",
    { hideFromHelp: true }
  );
}
