// trades.js
//
// Registers DB-backed "profile" commands:
// - ?id
// - ?ft (for trade) + shortcuts (?ftadd / ?ftdel)
// - ?lf (looking for) + shortcuts (?lfadd / ?lfdel)

import {
  getSavedId,
  setSavedId,
  deleteSavedId,
  getUserText,
  setUserText,
  deleteUserText
} from "./db.js";

// Helpers (kept local so commands.js doesn't need to own them)
function targetUserId(message) {
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}

function mention(id) {
  return `<@${id}>`;
}

function parseMentions(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function stripLeadingMentions(text) {
  // Removes leading mention tokens like "<@123>" or "<@!123>" repeatedly, then trims.
  return String(text ?? "")
    .replace(/^(\s*<@!?\d+>\s*)+/g, "")
    .trim();
}

function normalizeCommandArg(rest) {
  return String(rest ?? "").trim();
}

function getTradingGuildAllowlist() {
  return (process.env.TRADING_GUILD_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function tradingAllowedInGuild(message) {
  if (!message.guild) return false; // your bot already ignores DMs, but keep this safe
  const allow = getTradingGuildAllowlist();
  if (allow.length === 0) return false;
  return allow.includes(message.guild.id);
}

export function registerTrades(register) {
  // -------------------- ?id --------------------
  register(
    "?id",
    async ({ message, rest }) => {
      if (!message.guild) return;
      if (!tradingAllowedInGuild(message)) return;

      const raw = normalizeCommandArg(rest);
      const lower = raw.toLowerCase();

      // ?id del
      if (lower === "del") {
        await deleteSavedId({ guildId: message.guild.id, userId: message.author.id });
        await message.reply("✅ ID cleared.");
        return;
      }

      // ?id add <number>
      if (lower.startsWith("add")) {
        const after = raw.slice(3).trim(); // remove "add"
        if (!/^\d+$/.test(after)) {
          await message.reply("Invalid input. Use: `?id add <number>` where <number> is an integer 1–5000000.");
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

      // ?id 3451651 (bare number) -> helpful usage
      if (/^\d+$/.test(raw)) {
        await message.reply("Correct usage is `?id add <number>`.");
        return;
      }

      // ?id @user1 @user2 ... (read)
      const mentionedUsers = parseMentions(message);
      if (mentionedUsers.length >= 1) {
        const lines = [];

        for (const u of mentionedUsers) {
          const saved = await getSavedId({ guildId: message.guild.id, userId: u.id });
          if (saved == null) {
            lines.push(`${mention(u.id)} has not set an ID!`);
          } else {
            lines.push(`${mention(u.id)} : ${saved}`);
          }
        }

        if (lines.length === 0) return;
        await message.channel.send(lines.join("\n"));
        return;
      }

      // ?id (read self)
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

      // Anything else: do nothing (prevents accidental overwrites)
      return;
    },
    "?id add <number> | ?id del | ?id [@user...] — saves, shows, deletes, or looks up IDs"
  );

  // -------------------- ?ft / ?lf --------------------
  function registerTextCommand(cmd, kind, label, opts = {}) {
    const baseCmd = opts.baseCmd || cmd; // for usage strings ("?ft" even if invoked via "?ftadd")
    const pretty = kind === "ft" ? "Trading" : "Looking-for";

    register(
      cmd,
      async ({ message, rest }) => {
        if (!message.guild) return;
        if (!tradingAllowedInGuild(message)) return;

        const raw = normalizeCommandArg(rest);
        const lower = raw.toLowerCase();

        const isShortcutAdd = Boolean(opts.shortcutAdd);
        const isShortcutDel = Boolean(opts.shortcutDel);

        // del
        if (isShortcutDel || lower === "del") {
          await deleteUserText({ guildId: message.guild.id, userId: message.author.id, kind });
          await message.reply(`✅ ${pretty} list cleared.`);
          return;
        }

        // add
        if (isShortcutAdd || lower.startsWith("add")) {
          const after = isShortcutAdd ? raw : raw.slice(3); // remove "add" for normal form
          const text = stripLeadingMentions(after).trim();

          if (!text) {
            await message.reply(`Usage: \`${baseCmd} add <list>\``);
            return;
          }

          await setUserText({ guildId: message.guild.id, userId: message.author.id, kind, text });
          await message.reply(`✅ ${pretty} list saved. Use \`${baseCmd}\` to view it.`);
          return;
        }

        // Mentions = read mentioned users (do not skip missing)
        const mentionedUsers = parseMentions(message);
        if (mentionedUsers.length >= 1) {
          const lines = [];

          for (const u of mentionedUsers) {
            const text = await getUserText({ guildId: message.guild.id, userId: u.id, kind });

            if (!text) {
              lines.push(`${mention(u.id)} has not set a list!`);
            } else {
              lines.push(`${mention(u.id)} ${label}: ${text}`);
            }
          }

          if (lines.length === 0) return;
          await message.channel.send(lines.join("\n"));
          return;
        }

        // No args => read self
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

        // If they typed something else (like "?ft blah" without add), do nothing
        // (keeps behavior tight + avoids accidental saves)
        return;
      },
      opts.help ??
        `${baseCmd} add <list> | ${baseCmd} del | ${baseCmd} [@user...] — ${label.toLowerCase()} list`
    );
  }

  // ?ft / ?lf canonical
  registerTextCommand("?ft", "ft", "is trading");
  registerTextCommand("?lf", "lf", "is looking for");

  // Shortcuts (kept out of help by passing empty help)
  // They behave the same as "?ft add ..." / "?ft del" (and likewise for lf),
  // and now also produce the same success messages.
  registerTextCommand("?ftadd", "ft", "is trading", {
    shortcutAdd: true,
    baseCmd: "?ft",
    help: "?ftadd <text> — shortcut for ?ft add <text>"
  });
  registerTextCommand("?ftdel", "ft", "is trading", {
    shortcutDel: true,
    baseCmd: "?ft",
    help: "?ftdel — shortcut for ?ft del"
  });

  registerTextCommand("?lfadd", "lf", "is looking for", {
    shortcutAdd: true,
    baseCmd: "?lf",
    help: "?lfadd <text> — shortcut for ?lf add <text>"
  });
  registerTextCommand("?lfdel", "lf", "is looking for", {
    shortcutDel: true,
    baseCmd: "?lf",
    help: "?lfdel — shortcut for ?lf del"
  });
}
