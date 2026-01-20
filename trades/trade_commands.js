// trades/trade_commands.js
//
// Registers DB-backed trading list commands:
// - ft   (exposable: !ft or ?ft depending on policy) + shortcuts (!ftadd / !ftdel)
// - lf   (exposable: !lf or ?lf depending on policy) + shortcuts (!lfadd / !lfdel)

import {
  getUserText,
  setUserText,
  deleteUserText
} from "../db.js";
import { getMentionedUsers } from "../shared/mentions.js";

/* --------------------------------- helpers -------------------------------- */

function mention(id) {
  return `<@${id}>`;
}

function stripLeadingMentions(text) {
  return String(text ?? "")
    .replace(/^(\s*<@!?\d+>\s*)+/g, "")
    .trim();
}

function normalizeCommandArg(rest) {
  return String(rest ?? "").trim();
}

function appendListText(existing, addition) {
  const base = String(existing ?? "").trim();
  if (!base) return addition;
  const separator = base.includes("\n") ? "\n" : ", ";
  return `${base}${separator}${addition}`;
}

/* ----------------------------- handler builders ---------------------------- */

function makeTextListHandler(kind, label, opts = {}) {
  // opts:
  // - baseCmd: string (e.g. "!ft") used in usage messages; if omitted, uses ctx.cmd
  // - shortcutAdd: boolean
  // - shortcutDel: boolean
  const pretty = kind === "ft" ? "Trading" : "Looking-for";
  const helpLine =
    kind === "ft"
      ? "!ft add <list> | !ft append <list> | !ft del | !ft [@user...] — is trading list"
      : "!lf add <list> | !lf append <list> | !lf del | !lf [@user...] — is looking for list";
  const shortcutAddLine =
    kind === "ft"
      ? "!ftadd <text> — shortcut for !ft add <text>"
      : "!lfadd <text> — shortcut for !lf add <text>";
  const shortcutDelLine =
    kind === "ft"
      ? "!ftdel — shortcut for !ft del"
      : "!lfdel — shortcut for !lf del";

  return async ({ message, rest, cmd }) => {
    if (!message.guild) return;

    const raw = normalizeCommandArg(rest);
    const lower = raw.toLowerCase();

    const isShortcutAdd = Boolean(opts.shortcutAdd);
    const isShortcutDel = Boolean(opts.shortcutDel);

    // IMPORTANT: preserve current behavior for existing commands,
    // but also be correct if this handler runs under !ft/!lf later.
    const baseCmd = opts.baseCmd || String(cmd || "").trim() || (kind === "ft" ? "?ft" : "?lf");

    // help
    if (lower === "help") {
      const prefix = String(baseCmd || "").trim()[0] || "?";
      const line = (isShortcutAdd ? shortcutAddLine : isShortcutDel ? shortcutDelLine : helpLine)
        .replace(/[!?]f[tl]\b/g, (m) => `${prefix}${m.slice(1)}`)
        .replace(/[!?]f(t|l)(add|del)\b/g, (m) => `${prefix}${m.slice(1)}`);
      await message.reply(line);
      return;
    }

    // del
    if (isShortcutDel || lower === "del") {
      const existing = await getUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind
      });

      if (!existing) {
        await message.reply("Nothing to clear!");
        return;
      }

      await deleteUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind
      });

      await message.reply(`✅ ${pretty} list cleared.`);
      return;
    }

    // append
    if (lower.startsWith("append")) {
      const after = raw.slice("append".length);
      const text = stripLeadingMentions(after).trim();

      if (!text) {
        await message.reply(`Usage: \`${baseCmd} append <list>\``);
        return;
      }

      const existing = await getUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind
      });

      const nextText = appendListText(existing, text);
      await setUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind,
        text: nextText
      });

      await message.reply(`✅ ${pretty} list updated. Use \`${baseCmd}\` to view it.`);
      return;
    }

    // add
    if (isShortcutAdd || lower.startsWith("add")) {
      const after = isShortcutAdd ? raw : raw.slice(3);
      const text = stripLeadingMentions(after).trim();

      if (!text) {
        await message.reply(`Usage: \`${baseCmd} add <list>\``);
        return;
      }

      await setUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind,
        text
      });

      await message.reply(`✅ ${pretty} list saved. Use \`${baseCmd}\` to view it.`);
      return;
    }

    // Mentions → read
    const mentionedUsers = getMentionedUsers(message);
    if (mentionedUsers.length >= 1) {
      const lines = [];

      for (const u of mentionedUsers) {
        const text = await getUserText({
          guildId: message.guild.id,
          userId: u.id,
          kind
        });

        if (!text) {
          lines.push(`${mention(u.id)} has not set a list!`);
        } else {
          lines.push(`${mention(u.id)} ${label}: ${text}`);
        }
      }

      if (lines.length) {
        await message.channel.send(lines.join("\n"));
      }
      return;
    }

    // No args → read self
    if (!raw) {
      const text = await getUserText({
        guildId: message.guild.id,
        userId: message.author.id,
        kind
      });

      if (!text) {
        await message.reply(
          `You have not set a list! Set your list using \`${baseCmd} add <pokemon or thread>\``
        );
        return;
      }

      await message.channel.send(`${mention(message.author.id)} ${label}: ${text}`);
      return;
    }
  };
}

/* -------------------------------- registry -------------------------------- */

export function registerTradeCommands(register) {
  // -------------------- ft / lf (exposed per guild) --------------------
  register.expose({
    logicalId: "trading.ft",
    name: "ft",
    handler: makeTextListHandler("ft", "is trading"),
    help: "!ft add <list> | !ft del | !ft [@user...] — is trading list"
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lf",
    handler: makeTextListHandler("lf", "is looking for"),
    help: "!lf add <list> | !lf del | !lf [@user...] — is looking for list"
  });

  // -------------------- shortcuts (MIRROR canonical prefix) --------------------
  register.expose({
    logicalId: "trading.ft",
    name: "ftadd",
    handler: makeTextListHandler("ft", "is trading", { shortcutAdd: true }),
    help: "!ftadd <text> — shortcut for !ft add <text>",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.ft",
    name: "ftdel",
    handler: makeTextListHandler("ft", "is trading", { shortcutDel: true }),
    help: "!ftdel — shortcut for !ft del",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lfadd",
    handler: makeTextListHandler("lf", "is looking for", { shortcutAdd: true }),
    help: "!lfadd <text> — shortcut for !lf add <text>",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lfdel",
    handler: makeTextListHandler("lf", "is looking for", { shortcutDel: true }),
    help: "!lfdel — shortcut for !lf del",
    opts: { hideFromHelp: true }
  });
}
