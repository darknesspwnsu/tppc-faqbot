// trades/id.js
//
// Registers ID profile commands.

import { MessageFlags } from "discord.js";
import { getSavedId, setSavedId, deleteSavedId } from "../db.js";

function mention(id) {
  return `<@${id}>`;
}

function parseMentions(message) {
  return message.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}

function parseMentionIds(text) {
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function normalizeCommandArg(rest) {
  return String(rest ?? "").trim();
}

async function handleIdMessage({ message, rest }) {
  if (!message.guild) return;

  const raw = normalizeCommandArg(rest);
  const lower = raw.toLowerCase();

  if (lower === "del") {
    const existing = await getSavedId({
      guildId: message.guild.id,
      userId: message.author.id,
    });

    if (existing == null) {
      await message.reply("Nothing to clear!");
      return;
    }

    await deleteSavedId({
      guildId: message.guild.id,
      userId: message.author.id,
    });

    await message.reply("✅ ID cleared.");
    return;
  }

  if (lower.startsWith("add")) {
    const after = raw.slice(3).trim();
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
      savedId: n,
    });

    await message.reply("✅ ID saved.");
    return;
  }

  const mentionedUsers = parseMentions(message);
  if (mentionedUsers.length >= 1) {
    const lines = [];

    for (const u of mentionedUsers) {
      const saved = await getSavedId({
        guildId: message.guild.id,
        userId: u.id,
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

  if (!raw) {
    const saved = await getSavedId({
      guildId: message.guild.id,
      userId: message.author.id,
    });

    if (saved == null) {
      await message.reply(`${mention(message.author.id)} has not set an ID!`);
      return;
    }

    await message.channel.send(`${mention(message.author.id)} ${saved}`);
  }
}

function formatSilentLine(userId, savedId, interaction, user) {
  const display = user?.username || interaction.guild?.members?.cache?.get?.(userId)?.user?.username || userId;
  if (savedId == null) return `${display} has not set an ID!`;
  return `${display}: ${savedId}`;
}

async function handleIdSlash({ interaction }) {
  if (!interaction.guildId) return;

  const action = interaction.options?.getString?.("action")?.toLowerCase() || "";
  const value = interaction.options?.getInteger?.("value");
  const userOpt = interaction.options?.getUser?.("user") || null;
  const usersText = interaction.options?.getString?.("users") || "";

  if (action === "del") {
    const existing = await getSavedId({
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });

    if (existing == null) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Nothing to clear!" });
      return;
    }

    await deleteSavedId({
      guildId: interaction.guildId,
      userId: interaction.user.id,
    });

    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "✅ ID cleared." });
    return;
  }

  if (action === "add") {
    if (!Number.isSafeInteger(value)) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Invalid input. Use: `/id action:add value:<number>` where <number> is 1–5000000.",
      });
      return;
    }

    if (value < 1 || value > 5_000_000) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "Invalid input. Number must be between 1 and 5000000.",
      });
      return;
    }

    await setSavedId({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      savedId: value,
    });

    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "✅ ID saved." });
    return;
  }

  const ids = new Set();
  if (userOpt?.id) ids.add(userOpt.id);
  for (const id of parseMentionIds(usersText)) ids.add(id);
  if (ids.size === 0) ids.add(interaction.user.id);

  const lines = [];
  for (const id of ids) {
    const saved = await getSavedId({
      guildId: interaction.guildId,
      userId: id,
    });
    lines.push(formatSilentLine(id, saved, interaction, userOpt && userOpt.id === id ? userOpt : null));
  }

  await interaction.reply({ flags: MessageFlags.Ephemeral, content: lines.join("\n") });
}

export function registerId(register) {
  register.expose({
    logicalId: "trading.id",
    name: "id",
    handler: handleIdMessage,
    help: "?id add <number> | ?id del | ?id [@user...] — saves, shows, deletes, or looks up IDs",
  });

  register.slash(
    {
      name: "id",
      description: "Save or look up TPPC IDs.",
      options: [
        {
          type: 3,
          name: "action",
          description: "Optional action to perform.",
          required: false,
          choices: [
            { name: "add", value: "add" },
            { name: "del", value: "del" },
          ],
        },
        {
          type: 4,
          name: "value",
          description: "ID number to save.",
          required: false,
        },
        {
          type: 6,
          name: "user",
          description: "User to look up.",
          required: false,
        },
        {
          type: 3,
          name: "users",
          description: "Mention one or more users to look up.",
          required: false,
        },
      ],
    },
    handleIdSlash
  );
}
