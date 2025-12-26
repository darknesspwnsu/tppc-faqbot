// trades.js
//
// Registers DB-backed "profile" commands:
// - !id
// - !ft (for trade)
// - !lf (looking for)

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
  // -------------------- !id --------------------
  register(
    "?id",
    async ({ message, rest }) => {
      if (!message.guild) return;
      if (!tradingAllowedInGuild(message)) return;

      const raw = normalizeCommandArg(rest);
      const lower = raw.toLowerCase();

      // !id del (silent)
      if (lower === "del") {
        await deleteSavedId({ guildId: message.guild.id, userId: message.author.id });
        return;
      }

      // !id add <number> (write: author, silent)
      if (lower.startsWith("add")) {
        const after = raw.slice(3).trim(); // remove "add"
        if (!/^\d+$/.test(after)) {
          await message.reply(
            "Invalid input. Use: `!id add <number>` where <number> is an integer 1–5000000."
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
        return; // silent
      }

      // !id @user1 @user2 ... (multi-read)
      const mentionedUsers = parseMentions(message);
      if (mentionedUsers.length >= 1) {
        const lines = [];

        for (const u of mentionedUsers) {
          const saved = await getSavedId({ guildId: message.guild.id, userId: u.id });
          if (saved == null) continue;
          lines.push(`${mention(u.id)} : ${saved}`);
        }

        if (lines.length === 0) return;
        await message.channel.send(lines.join("\n"));
        return;
      }

      // !id (read self)
      if (!raw) {
        const saved = await getSavedId({
          guildId: message.guild.id,
          userId: message.author.id
        });
        if (saved == null) return;
        await message.channel.send(`${mention(message.author.id)} ${saved}`);
        return;
      }

      // Anything else: do nothing (prevents accidental overwrites)
      return;
    },
    "?id add <number> | !id del | !id [@user...] — saves, shows, deletes, or looks up IDs"
  );

  // Shared handler for !ft and !lf
  function registerTextCommand(cmd, kind, label) {
    register(
      cmd,
      async ({ message, rest }) => {
        if (!message.guild) return;
        if (!tradingAllowedInGuild(message)) return;

        const raw = normalizeCommandArg(rest);
        const lower = raw.toLowerCase();

        // del (silent)
        if (lower === "del") {
          await deleteUserText({ guildId: message.guild.id, userId: message.author.id, kind });
          return;
        }

        // add <arbitrary text> (silent)
        if (lower.startsWith("add")) {
          const after = raw.slice(3); // remove "add"
          const text = stripLeadingMentions(after).trim();
          if (!text) return; // if they do "?ft add" with nothing, do nothing
          await setUserText({ guildId: message.guild.id, userId: message.author.id, kind, text });
          return;
        }

        // Mentions = read mentioned users (skip missing; if all missing -> show nothing)
        const mentionedUsers = parseMentions(message);
        if (mentionedUsers.length >= 1) {
          const lines = [];
          for (const u of mentionedUsers) {
            const text = await getUserText({ guildId: message.guild.id, userId: u.id, kind });
            if (!text) continue;
            lines.push(`${mention(u.id)} ${label}: ${text}`);
          }
          if (lines.length === 0) return;
          await message.channel.send(lines.join("\n"));
          return;
        }

        // No args => read self (silent if missing)
        if (!raw) {
          const text = await getUserText({
            guildId: message.guild.id,
            userId: message.author.id,
            kind
          });
          if (!text) return;
          await message.channel.send(`${mention(message.author.id)} ${label}: ${text}`);
          return;
        }

        // If they typed something else (like "?ft blah" without add), do nothing
        // (keeps behavior tight + avoids accidental saves)
        return;
      },
      `${cmd} add <text> | ${cmd} del | ${cmd} [@user...] — ${label.toLowerCase()} list`
    );
  }

  // !ft / !lf
  registerTextCommand("?ft", "ft", "is trading");
  registerTextCommand("?lf", "lf", "is looking for");
}
