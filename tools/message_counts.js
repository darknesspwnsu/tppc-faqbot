// tools/message_counts.js
//
// Message count tracking for configured channels per guild.
// Includes helper for future data imports (not wired yet).

import fs from "node:fs/promises";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { MESSAGE_COUNT_CHANNELS_BY_GUILD } from "../configs/message_count_channels.js";

const TOP_LIMIT = 10;
const FLAREON_PATH = "data/user_message_counts_flareon_migration_data.json";
const RESET_PREFIX = "resetcount:";

let flareonCounts = null;
let flareonLoadAttempted = false;

function trackedChannelsForGuild(guildId) {
  const channels = MESSAGE_COUNT_CHANNELS_BY_GUILD?.[String(guildId || "")];
  return Array.isArray(channels) ? new Set(channels.map(String)) : new Set();
}

function mention(id) {
  return `<@${id}>`;
}

async function incrementMessageCount({ guildId, userId }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO message_counts (guild_id, user_id, count)
    VALUES (?, ?, 1)
    ON DUPLICATE KEY UPDATE count = count + 1
  `,
    [String(guildId), String(userId)]
  );
}

async function fetchMessageCount({ guildId, userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT count FROM message_counts WHERE guild_id = ? AND user_id = ? LIMIT 1`,
    [String(guildId), String(userId)]
  );
  const count = Number(rows?.[0]?.count || 0);
  return Number.isFinite(count) ? count : 0;
}

async function loadFlareonCountsOnce() {
  if (flareonLoadAttempted) return flareonCounts;
  flareonLoadAttempted = true;
  try {
    const raw = await fs.readFile(FLAREON_PATH, "utf8");
    const parsed = JSON.parse(raw || "{}");
    flareonCounts = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("[count] failed to load flareon data:", err);
    }
    flareonCounts = {};
  }
  return flareonCounts;
}

async function fetchFlareonCount({ guildId, userId }) {
  const data = await loadFlareonCountsOnce();
  const g = data?.[String(guildId)] || {};
  const count = Number(g?.[String(userId)] || 0);
  return Number.isFinite(count) ? count : 0;
}

async function fetchFlareonTopCounts({ guildId, limit = TOP_LIMIT }) {
  const data = await loadFlareonCountsOnce();
  const g = data?.[String(guildId)] || {};
  const rows = Object.entries(g)
    .map(([userId, count]) => ({
      userId: String(userId),
      count: Number(count || 0),
    }))
    .filter((row) => Number.isFinite(row.count) && row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Math.min(50, limit)));
  return rows;
}

async function fetchTopCounts({ guildId, limit = TOP_LIMIT }) {
  const db = getDb();
  const capped = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : TOP_LIMIT;
  const [rows] = await db.execute(
    `
    SELECT user_id, count
    FROM message_counts
    WHERE guild_id = ?
    ORDER BY count DESC
    LIMIT ${capped}
  `,
    [String(guildId)]
  );
  return (rows || []).map((row) => ({
    userId: String(row.user_id),
    count: Number(row.count || 0),
  }));
}

function mergeTopCounts(primary, extra) {
  const merged = new Map();
  for (const row of primary || []) {
    merged.set(row.userId, (merged.get(row.userId) || 0) + (row.count || 0));
  }
  for (const row of extra || []) {
    merged.set(row.userId, (merged.get(row.userId) || 0) + (row.count || 0));
  }
  return [...merged.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_LIMIT);
}

async function resolveDisplayNames(guild, rows) {
  const ids = rows.map((row) => row.userId);
  const names = new Map();
  if (!guild) return names;

  try {
    const members = await guild.members.fetch({ user: ids });
    members.forEach((member) => {
      const label = member.displayName || member.user?.username || member.id;
      names.set(member.id, label);
    });
  } catch {}

  for (const id of ids) {
    if (names.has(id)) continue;
    try {
      const user = await guild.client.users.fetch(id);
      names.set(id, user?.username || id);
    } catch {
      names.set(id, id);
    }
  }

  return names;
}

function renderLeaderboard(rows, names) {
  if (!rows.length) return "No message counts recorded yet.";
  const lines = rows.map((row, idx) => {
    const label = names.get(row.userId) || row.userId;
    const countLabel = row.count === 1 ? "message" : "messages";
    return `${idx + 1}. **${label}** with **${row.count}** ${countLabel}!`;
  });
  return `Top ${Math.min(TOP_LIMIT, rows.length)} highest message counts for this server:\n\n${lines.join("\n")}`;
}

/**
 * Helper for future migrations:
 * - Accepts a JSON map of { guildId: { userId: count } }
 * - Does not run automatically.
 */
export async function importMessageCountsFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw || "{}");
  const db = getDb();

  for (const [guildId, entries] of Object.entries(parsed || {})) {
    for (const [userId, count] of Object.entries(entries || {})) {
      const total = Number(count || 0);
      if (!Number.isFinite(total) || total <= 0) continue;
      await db.execute(
        `
        INSERT INTO message_counts (guild_id, user_id, count)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE count = VALUES(count)
      `,
        [String(guildId), String(userId), Math.floor(total)]
      );
    }
  }
}

async function resetSpectreonCounts({ guildId }) {
  const db = getDb();
  await db.execute(`DELETE FROM message_counts WHERE guild_id = ?`, [String(guildId)]);
}

export function registerMessageCounts(register) {
  register.listener(async ({ message, isCommand }) => {
    if (!message?.guildId) return;
    if (message.author?.bot) return;
    if (message.channel && message.channel.viewable === false) return;
    if (isCommand) return;

    const tracked = trackedChannelsForGuild(message.guildId);
    if (!tracked.size || !tracked.has(String(message.channelId))) return;

    await incrementMessageCount({
      guildId: message.guildId,
      userId: message.author.id,
    });
  });

  register(
    "!count",
    async ({ message, rest }) => {
      if (!message.guildId || !message.guild) {
        await message.reply("This command only works in servers.");
        return;
      }

      const raw = String(rest || "").trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      const wantsOverall = tokens.some((t) => t.toLowerCase() === "overall");
      const wantsLeaderboard = tokens.some((t) => t.toLowerCase() === "leaderboard");

      if (wantsLeaderboard) {
        const rows = await fetchTopCounts({ guildId: message.guildId, limit: TOP_LIMIT });
        const flareonRows = wantsOverall
          ? await fetchFlareonTopCounts({ guildId: message.guildId, limit: TOP_LIMIT })
          : [];
        const combined = wantsOverall ? mergeTopCounts(rows, flareonRows) : rows;
        const names = await resolveDisplayNames(message.guild, combined);
        await message.reply(renderLeaderboard(combined, names));
        return;
      }

      const target = message.mentions?.users?.first?.() || message.author;
      const spectreonCount = await fetchMessageCount({
        guildId: message.guildId,
        userId: target.id,
      });
      const flareonCount = wantsOverall
        ? await fetchFlareonCount({ guildId: message.guildId, userId: target.id })
        : 0;
      const total = wantsOverall ? spectreonCount + flareonCount : spectreonCount;
      const suffix = wantsOverall ? " (overall)" : "";
      const countLabel = total === 1 ? "message" : "messages";
      await message.reply(`${mention(target.id)} has a message count of **${total}** ${countLabel}!${suffix}`);
    },
    "!count [@user|leaderboard] [overall] — show message counts in tracked channels",
    { aliases: ["!activity", "!yap"] }
  );

  register.slash(
    {
      name: "resetcount",
      description: "Reset Spectreon message counts for this server",
    },
    async ({ interaction }) => {
      if (!isAdminOrPrivileged(interaction)) {
        await interaction.reply({
          content: "❌ You do not have permission to reset message counts.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${RESET_PREFIX}confirm`)
          .setLabel("YES")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${RESET_PREFIX}cancel`)
          .setLabel("CANCEL")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: "Confirm reset of Spectreon message counts for this server?",
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    },
    { admin: true }
  );

  register.component(RESET_PREFIX, async ({ interaction }) => {
    const action = interaction.customId?.slice(RESET_PREFIX.length) || "";
    if (!isAdminOrPrivileged(interaction)) {
      await interaction.reply({
        content: "❌ You do not have permission to reset message counts.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "cancel") {
      await interaction.update({
        content: "Reset cancelled.",
        components: [],
      });
      return;
    }

    if (action === "confirm") {
      await resetSpectreonCounts({ guildId: interaction.guildId });
      await interaction.update({
        content: "✅ Spectreon message counts reset for this server.",
        components: [],
      });
      return;
    }

    await interaction.reply({
      content: "Unknown action.",
      flags: MessageFlags.Ephemeral,
    });
  });
}

export const __testables = {
  trackedChannelsForGuild,
  renderLeaderboard,
};
