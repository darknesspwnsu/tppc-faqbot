// trades.js
//
// Registers DB-backed "profile" commands:
// - id   (exposable: !id or ?id depending on policy)
// - ft   (exposable: !ft or ?ft depending on policy) + shortcuts (?ftadd / ?ftdel)
// - lf   (exposable: !lf or ?lf depending on policy) + shortcuts (?lfadd / ?lfdel)

import {
  getSavedId,
  setSavedId,
  deleteSavedId,
  getUserText,
  setUserText,
  deleteUserText
} from "./db.js";

/* --------------------------------- helpers -------------------------------- */

function mention(id) {
  return `<@${id}>`;
}

function parseMentions(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function stripLeadingMentions(text) {
  return String(text ?? "")
    .replace(/^(\s*<@!?\d+>\s*)+/g, "")
    .trim();
}

function normalizeCommandArg(rest) {
  return String(rest ?? "").trim();
}

/* ----------------------------- handler builders ---------------------------- */

function makeIdHandler() {
  return async ({ message, rest }) => {
    if (!message.guild) return;

    const raw = normalizeCommandArg(rest);
    const lower = raw.toLowerCase();

    // id del
    if (lower === "del") {
      const existing = await getSavedId({
        guildId: message.guild.id,
        userId: message.author.id
      });

      if (existing == null) {
        await message.reply("Nothing to clear!");
        return;
      }

      await deleteSavedId({
        guildId: message.guild.id,
        userId: message.author.id
      });

      await message.reply("✅ ID cleared.");
      return;
    }

    // id add <number>
    if (lower.startsWith("add")) {
      const after = raw.slice(3).trim();
      if (!/^\d+$/.test(after)) {
        await message.reply(
          "Invalid input. Use: `?id add <number>` where <number> is an integer 1–5000000."
        );
        return;
      }

      const n = Number(after);
      if (!Number.isSafeInteger(n) || n < 1 || n > 5_000_000) {
        await message.reply("Invalid input. Number must be between 1 and 5000000.");
        return;
      }

      await setSavedId({
        guildId: message.guild.id,
        userId: message.author.id,
        savedId: n
      });

      await message.reply("✅ ID saved.");
      return;
    }

    // Mentions → read
    const mentionedUsers = parseMentions(message);
    if (mentionedUsers.length >= 1) {
      const lines = [];

      for (const u of mentionedUsers) {
        const saved = await getSavedId({
          guildId: message.guild.id,
          userId: u.id
        });

        if (saved == null) {
          lines.push(`${mention(u.id)} has not set an ID!`);
        } else {
          lines.push(`${mention(u.id)} : ${saved}`);
        }
      }

      if (lines.length) {
        await message.channel.send(lines.join("\n"));
      }
      return;
    }

    // id (read self)
    if (!raw) {
      const saved = await getSavedId({
        guildId: message.guild.id,
        userId: message.author.id
      });

      if (saved == null) {
        await message.reply(`${mention(message.author.id)} has not set an ID!`);
        return;
      }

      await message.channel.send(`${mention(message.author.id)} ${saved}`);
      return;
    }
  };
}

function makeTextListHandler(kind, label, opts = {}) {
  // opts:
  // - baseCmd: string (e.g. "?ft") used in usage messages; if omitted, uses ctx.cmd
  // - shortcutAdd: boolean
  // - shortcutDel: boolean
  const pretty = kind === "ft" ? "Trading" : "Looking-for";

  return async ({ message, rest, cmd }) => {
    if (!message.guild) return;

    const raw = normalizeCommandArg(rest);
    const lower = raw.toLowerCase();

    const isShortcutAdd = Boolean(opts.shortcutAdd);
    const isShortcutDel = Boolean(opts.shortcutDel);

    // IMPORTANT: preserve current behavior for existing commands,
    // but also be correct if this handler runs under !ft/!lf later.
    const baseCmd = opts.baseCmd || String(cmd || "").trim() || (kind === "ft" ? "?ft" : "?lf");

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
    const mentionedUsers = parseMentions(message);
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

export function registerTrades(register) {
  // -------------------- id (exposed per guild) --------------------
  register.expose({
    logicalId: "trading.id",
    name: "id",
    handler: makeIdHandler(),
    help: "?id add <number> | ?id del | ?id [@user...] — saves, shows, deletes, or looks up IDs"
  });

  // -------------------- ft / lf (exposed per guild) --------------------
  register.expose({
    logicalId: "trading.ft",
    name: "ft",
    handler: makeTextListHandler("ft", "is trading"),
    help: "?ft add <list> | ?ft del | ?ft [@user...] — is trading list"
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lf",
    handler: makeTextListHandler("lf", "is looking for"),
    help: "?lf add <list> | ?lf del | ?lf [@user...] — is looking for list"
  });

  // -------------------- shortcuts (MIRROR canonical prefix) --------------------
  register.expose({
    logicalId: "trading.ft",
    name: "ftadd",
    handler: makeTextListHandler("ft", "is trading", { shortcutAdd: true }),
    help: "?ftadd <text> — shortcut for ?ft add <text>",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.ft",
    name: "ftdel",
    handler: makeTextListHandler("ft", "is trading", { shortcutDel: true }),
    help: "?ftdel — shortcut for ?ft del",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lfadd",
    handler: makeTextListHandler("lf", "is looking for", { shortcutAdd: true }),
    help: "?lfadd <text> — shortcut for ?ft add <text>",
    opts: { hideFromHelp: true }
  });

  register.expose({
    logicalId: "trading.lf",
    name: "lfdel",
    handler: makeTextListHandler("lf", "is looking for", { shortcutDel: true }),
    help: "?lfdel — shortcut for ?lf del",
    opts: { hideFromHelp: true }
  });
}
