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
// Host commands (legacy, kept):
//   !dondopen <n>        -> open a DISCARDED box (never the kept box)
//   !dondstatus
//   !dondswitch          -> only when exactly 2 unopened boxes remain (kept + 1 other)
//   !dondend [deal|nodeal]
//   !dondcancel
//   !dondreveal          -> reveals last game's full box list
//   !dondoffer <text...> -> (optional) announce banker offer (any freeform offer)
//
// Framework QoL (added):
//   !dondhelp / !dondrules / !dondstatus
//   !canceldond / !enddond (hidden from global help)
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

import {
  createGameManager,
  createBoard,
  guardBoardInteraction,
  withGameSubcommands,
  makeGameQoL,
  reply,
  clampInt,
  requireActive,
  requireSameChannel,
  requireCanManage,
  mention,
  channelMention,
  nowMs,
} from "./framework.js";

const LAST_BY_GUILD = new Map(); // guildId -> snapshot

const MIN_BOXES = 2;
const MAX_BOXES = 25;

/* --------------------------------- helpers -------------------------------- */

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

function snapshotGame(game) {
  return {
    guildId: game.guildId,
    channelId: game.channelId,
    hostId: game.hostId,
    contestantId: game.contestantId,
    n: game.n,
    keptIndex: game.keptIndex,
    dealTaken: Boolean(game.dealTaken),
    endedAtMs: nowMs(),
    boxes: game.boxes.map((b) => ({ prize: b.prize, opened: b.opened })),
  };
}

function revealAllText(snap) {
  const lines = [];
  lines.push(`🧾 **Deal or No Deal — Full Reveal**`);
  lines.push(`Host: ${mention(snap.hostId)} • Contestant: ${mention(snap.contestantId)}`);
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

function boardText(game) {
  const lines = [];
  lines.push(
    `💼 **Deal or No Deal** — Host: ${mention(game.hostId)} • Contestant: ${mention(game.contestantId)}`
  );

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

/* --------------------------------- help/rules ----------------------------- */

function dondHelpText() {
  return [
    "**Deal or No Deal — help**",
    "",
    "**Start (slash):**",
    "• `/dond boxes:<2-25> contestant:@user`",
    "  – Opens a modal where the host pastes the prize list.",
    "  – One prize per line. Blank or `Empty` = empty box.",
    "",
    "**Contestant:**",
    "• Chooses ONE box to **keep** using the buttons on the board.",
    "",
    "**Host / Admin / Privileged:**",
    "• `!dondopen N` — open a **discarded** box (kept box is locked)",
    "• `!dondswitch` — only when 2 unopened boxes remain (kept + 1 other)",
    "• `!dondend [deal|nodeal]` — end the game",
    "• `!dondoffer <text>` — announce banker offer (freeform)",
    "• `!dondstatus` — show current board",
    "• `!dondcancel` — cancel the game",
    "",
    "**Reveal:**",
    "• `!dondreveal` — reveal all prizes from the last game",
    "",
    "**QoL:**",
    "• `!canceldond` / `!enddond` — framework aliases (host/admin)",
  ].join("\n");
}

function dondRulesText() {
  return [
    "**Deal or No Deal — rules (simple)**",
    "",
    "1) Host starts with `/dond` and pastes prizes (one per line).",
    "2) Contestant clicks ONE box to keep (it stays closed).",
    "3) Host opens discarded boxes with `!dondopen N` (never the kept box).",
    "4) When only two unopened boxes remain, host may `!dondswitch` and then `!dondend deal|nodeal`.",
    "",
    "Notes:",
    "• This game is **guild-scoped**, but commands are **bound to the start channel**.",
  ].join("\n");
}

/* --------------------------------- main ----------------------------------- */

export function registerDealOrNoDeal(register) {
  const id = "dond";
  const prettyName = "Deal or No Deal";

  const manager = createGameManager({ id, prettyName, scope: "guild" });

  function getBoard(game) {
    // We use framework board helper; message id field is "messageId"
    return createBoard(game, { messageIdField: "messageId" });
  }

  async function updateBoard(game, { disable = false } = {}) {
    const board = getBoard(game);
    await board.update({
      content: boardText(game),
      components: buildKeepButtons(game, { disabled: disable }),
    });
  }

  async function finalizeGame(game, { message = null, channel = null, mode = "ended", dealTaken = false } = {}) {
    game.phase = "ended";
    game.dealTaken = Boolean(dealTaken);

    const snap = snapshotGame(game);
    LAST_BY_GUILD.set(game.guildId, snap);

    // Disable board buttons
    await updateBoard(game, { disable: true });

    // Clear active state
    manager.stop({ guildId: game.guildId });

    const ch = channel || (message ? message.channel : null);
    if (!ch?.send) return;

    if (mode === "cancelled") {
      await ch.send("🛑 Cancelled. You can still run `!dondreveal` to show the snapshot prizes.");
      return;
    }

    if (dealTaken) {
      await ch.send(
        `🤝 **DEAL TAKEN!** Game ended.\n` +
          `Kept box **#${game.keptIndex + 1}** stays hidden.\n` +
          `Use \`!dondreveal\` to show every box afterwards.`
      );
      return;
    }

    // nodeal
    await ch.send(
      `🏁 **NO DEAL!** ${mention(game.contestantId)} kept **Box #${game.keptIndex + 1}** → **${
        game.boxes[game.keptIndex].prize
      }**\n` + `Use \`!dondreveal\` to show all boxes.`
    );
  }

  /* ------------------------------ slash: /dond ------------------------------ */

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

      if (manager.isActive({ interaction, guildId })) {
        const g = manager.getState({ interaction, guildId });
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: `⚠️ Deal or No Deal is already running in ${channelMention(g.channelId)}.`,
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
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content: "❌ Contestant must be a real user (not a bot).",
        });
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
        .setPlaceholder("One prize per line. Blank/Empty = empty box.");

      modal.addComponents(new ActionRowBuilder().addComponents(prizesInput));
      await interaction.showModal(modal);
    }
  );

  /* --------------------------- modal submit -> start -------------------------- */

  register.component("dond_modal:", async ({ interaction }) => {
    if (!interaction.isModalSubmit?.()) return;

    const gid = interaction.guildId;
    if (!gid) return;

    if (manager.isActive({ interaction, guildId: gid })) {
      const g = manager.getState({ interaction, guildId: gid });
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: `⚠️ Deal or No Deal is already running in ${channelMention(g.channelId)}.`,
      });
      return;
    }

    const idStr = String(interaction.customId || "");
    const parts = idStr.split(":"); // dond_modal:<n>:<contestantId>
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

    const init = {
      kind: "dond",
      client: interaction.client,
      guildId: gid,
      channelId: channel.id, // bind to this channel
      hostId: interaction.user.id,
      contestantId,
      n,
      boxes: prizes.map((p) => ({ prize: p, opened: false })),
      keptIndex: null,
      phase: "choose_keep", // choose_keep | running | final | ended
      dealTaken: false,
      messageId: null, // board message id (framework field)
      createdAtMs: nowMs(),
    };

    const started = manager.tryStart({ interaction, guildId: gid, channelId: channel.id }, init);
    if (!started.ok) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: started.errorText });
      return;
    }

    const game = started.state;
    const board = getBoard(game);

    const msg = await board.post(channel, {
      content: boardText(game),
      components: buildKeepButtons(game),
    });

    if (!msg?.id) {
      manager.stop({ guildId: gid });
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Failed to post the game board." });
      return;
    }

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content:
        `✅ Started Deal or No Deal in ${channelMention(channel.id)} for ${mention(contestantId)} with **${n}** boxes.\n` +
        `Contestant should pick a kept box using the buttons on the board.`,
    });
  });

  /* ------------------------------- buttons ---------------------------------- */

  register.component("dond:keep:", async ({ interaction }) => {
    if (!interaction.isButton?.()) return;

    const guarded = await guardBoardInteraction(interaction, {
      manager,
      messageIdField: "messageId",
      // Only contestant can click keep
      allowUserIds: [interaction.user?.id], // temp; we'll verify properly below with state
    });

    // guardBoardInteraction's allowUserIds check above isn't helpful yet because we don't know contestantId,
    // so we re-check properly here (keeping guard’s other protections).
    if (!guarded) return;

    const game = guarded.state;

    // Enforce start-channel binding + correct user
    if (!(await requireSameChannel({ interaction }, game, manager))) return;

    if (interaction.user.id !== game.contestantId) {
      try {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Only the contestant can pick the kept box." });
      } catch {}
      return;
    }

    if (game.phase !== "choose_keep") {
      try {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Kept box has already been chosen." });
      } catch {}
      return;
    }

    const idx = Number(String(interaction.customId).split(":").pop());
    if (!Number.isInteger(idx) || idx < 0 || idx >= game.n) {
      try {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Invalid box." });
      } catch {}
      return;
    }

    if (game.boxes[idx].opened) {
      try {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: "That box is already opened." });
      } catch {}
      return;
    }

    game.keptIndex = idx;
    game.phase = "running";

    try {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: `✅ You are keeping **Box #${idx + 1}**.` });
    } catch {}

    await updateBoard(game);

    try {
      await interaction.channel.send(
        `🔒 ${mention(game.contestantId)} is keeping **Box #${idx + 1}**.\n` +
          `Host: open **discarded** boxes with \`!dondopen N\` (kept box is locked).`
      );
    } catch {}
  });

  /* ------------------------------ framework QoL ----------------------------- */

  makeGameQoL(register, {
    manager,
    id,
    prettyName,
    helpText: dondHelpText(),
    rulesText: dondRulesText(),
    manageDeniedText: "Nope — only admins/privileged or the host can do that.",
    renderStatus: (game) => boardText(game),
    cancel: async (game, ctx) => {
      // Snapshot + disable + stop
      await updateBoard(game, { disable: true });
      const snap = snapshotGame(game);
      LAST_BY_GUILD.set(game.guildId, snap);
      manager.stop({ guildId: game.guildId });
      await reply(ctx, "🛑 Cancelled. You can still run `!dondreveal` to show the snapshot prizes.");
    },
    end: async (game, ctx) => {
      // Hidden hard-end (does NOT decide deal/nodeal; legacy !dondend still exists)
      await updateBoard(game, { disable: true });
      const snap = snapshotGame(game);
      LAST_BY_GUILD.set(game.guildId, snap);
      manager.stop({ guildId: game.guildId });
      await reply(ctx, "🏁 Deal or No Deal ended. Use `!dondreveal` if you want the full snapshot.");
    },
  });

  /* ------------------------------ bang commands ----------------------------- */

  // Primary: !dond supports "!dond help" / "!dond rules" via framework wrapper
  register(
    "!dond",
    withGameSubcommands({
      helpText: dondHelpText(),
      rulesText: dondRulesText(),
      // Keep legacy behavior for non-subcommands:
      onStart: async ({ message }) => {
        await reply(
          { message },
          "Start Deal or No Deal with the slash command:\n" +
            "• `/dond boxes:<2-25> contestant:@user`\n" +
            "Type `!dond help` for full rules."
        );
      },
      // Optional: status subcommand prints board or "no active"
      onStatus: async ({ message }) => {
        const game = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
        if (!game) return void (await reply({ message }, "No active Deal or No Deal game in this server."));
        if (!(await requireSameChannel({ message }, game, manager))) return;
        await reply({ message }, boardText(game));
      },
    }),
    "!dond — start via `/dond`. Type `!dond help` for rules.",
    { helpTier: "primary" }
  );

  register(
    "!dondoffer",
    async ({ message, rest }) => {
      const game = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!game) return void (await reply({ message }, "No active Deal or No Deal game."));
      if (!(await requireSameChannel({ message }, game, manager))) return;

      const ok = await requireCanManage(
        { message },
        game,
        { ownerField: "hostId", managerLabel: prettyName, deniedText: "Nope — only admins/privileged or the host can do that." }
      );
      if (!ok) return;

      const offer = String(rest ?? "").trim();
      if (!offer) return void (await reply({ message }, "Usage: `!dondoffer <banker offer text>`"));

      await message.channel.send(`📞 **BANKER OFFER:** ${offer}`);
    },
    "!dondoffer <text> — announce banker offer",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondopen",
    async ({ message, rest }) => {
      const game = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!game) return void (await reply({ message }, "No active Deal or No Deal game."));
      if (!(await requireSameChannel({ message }, game, manager))) return;

      const ok = await requireCanManage(
        { message },
        game,
        { ownerField: "hostId", managerLabel: prettyName, deniedText: "Nope — only admins/privileged or the host can do that." }
      );
      if (!ok) return;

      if (game.keptIndex == null) {
        await reply({ message }, "⚠️ Kept box not chosen yet. Contestant must pick a kept box first.");
        return;
      }

      const n = clampInt(String(rest ?? "").trim(), 1, game.n);
      if (!n) return void (await reply({ message }, `Usage: \`!dondopen <1-${game.n}>\` (opens a discarded box)`));
      const idx = n - 1;

      if (idx === game.keptIndex) {
        return void (await reply({ message }, `❌ Box #${idx + 1} is the contestant’s **kept** box. Open a **discarded** box instead.`));
      }
      if (game.boxes[idx].opened) return void (await reply({ message }, "That box is already opened."));

      game.boxes[idx].opened = true;
      await message.channel.send(`🗑️ Discarded **Box #${idx + 1}** opened → **${game.boxes[idx].prize}**`);

      const remaining = unopenedIndices(game);
      if (remaining.length === 2) game.phase = "final";

      await updateBoard(game);

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
      const game = await requireActive({ message, guildId: message.guildId, channelId: message.channelId }, manager);
      if (!game) return;
      if (!(await requireSameChannel({ message }, game, manager))) return;

      const ok = await requireCanManage(
        { message },
        game,
        { ownerField: "hostId", managerLabel: prettyName, deniedText: "Nope — only admins/privileged or the host can do that." }
      );
      if (!ok) return;

      if (game.keptIndex == null) return void (await reply({ message }, "Kept box not chosen yet."));
      const other = otherUnopenedIndex(game);
      if (other == null) {
        return void (await reply({ message }, "❌ Switch is only allowed when exactly 2 unopened boxes remain (kept + 1 other)."));
      }

      const prev = game.keptIndex;
      game.keptIndex = other;

      await updateBoard(game);
      await message.channel.send(`🔁 Switched kept box from **#${prev + 1}** to **#${game.keptIndex + 1}**.`);
    },
    "!dondswitch — swap kept box with the other final box",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!dondend",
    async ({ message, rest }) => {
      const game = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!game) return void (await reply({ message }, "No active Deal or No Deal game."));
      if (!(await requireSameChannel({ message }, game, manager))) return;

      const ok = await requireCanManage(
        { message },
        game,
        { ownerField: "hostId", managerLabel: prettyName, deniedText: "Nope — only admins/privileged or the host can do that." }
      );
      if (!ok) return;

      if (game.keptIndex == null) return void (await reply({ message }, "Kept box not chosen yet."));

      const mode = String(rest ?? "").trim().toLowerCase();
      if (mode !== "deal" && mode !== "nodeal") {
        await reply({ message }, "Usage: `!dondend deal` or `!dondend nodeal`");
        return;
      }

      const isDeal = mode === "deal";

      // Snapshot + stop + message outputs identical to legacy behavior
      const channel = message.channel;
      await finalizeGame(game, { message, channel, mode: "ended", dealTaken: isDeal });
    },
    "!dondend [deal|nodeal] — end Deal or No Deal",
    { admin: true, hideFromHelp: true }
  );

  // Legacy: !dondcancel (wrapper to canonical cancel logic)
  register(
    "!dondcancel",
    async ({ message }) => {
      const game = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!game) return void (await reply({ message }, "No active Deal or No Deal game."));
      if (!(await requireSameChannel({ message }, game, manager))) return;

      const ok = await requireCanManage(
        { message },
        game,
        { ownerField: "hostId", managerLabel: prettyName, deniedText: "Nope — only admins/privileged or the host can do that." }
      );
      if (!ok) return;

      // Keep legacy "cancelled by X" board content line
      await updateBoard(game, { disable: true });
      const snap = snapshotGame(game);
      LAST_BY_GUILD.set(game.guildId, snap);

      // Try to edit board content with the legacy cancelled header (without breaking buttons disable)
      const board = getBoard(game);
      await board.update({
        content: `🛑 **Deal or No Deal cancelled** by ${mention(message.author.id)}.\n\n` + boardText({ ...game, phase: "ended" }),
        components: buildKeepButtons(game, { disabled: true }),
      });

      manager.stop({ guildId: game.guildId });
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
        await reply({ message }, "No previous Deal or No Deal snapshot to reveal yet.");
        return;
      }
      await message.channel.send(revealAllText(snap));
    },
    "!dondreveal — reveal prizes from the last Deal or No Deal game",
    { hideFromHelp: true }
  );
}

export const __testables = {
  normalizePrizeLine,
  parsePrizesFromLines,
  unopenedIndices,
  otherUnopenedIndex,
  snapshotGame,
  revealAllText,
};
