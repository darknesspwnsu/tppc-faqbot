// contests/giveaway.js
//
// Giveaway system:
// - /giveaway create opens a modal to configure a giveaway
// - Entries via 🎉 button with join/leave flow
// - /giveaway end ends early, /giveaway reroll rerolls winners, /giveaway delete cancels, /giveaway list shows active

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { isAdminOrPrivileged } from "../auth.js";
import { getDb } from "../db.js";
import { sendDm } from "../shared/dm.js";
import { parseDurationSeconds } from "../shared/time_utils.js";
import { startTimeout, clearTimer } from "../shared/timer_utils.js";
import { stripEmojisAndSymbols, formatUserWithId, formatUsersWithIds } from "./helpers.js";
import {
  buildEligibilityDm,
  checkEligibility,
  filterEligibleEntrants,
  getVerifiedRoleIds,
} from "./eligibility.js";

const MAX_DURATION_SECONDS = 3 * 24 * 60 * 60;
const MAX_WINNERS = 50;

const activeGiveaways = new Map();
let booted = false;
let clientRef = null;

function ensureClient(client) {
  if (!clientRef && client) clientRef = client;
}

function mention(id) {
  return `<@${id}>`;
}

function formatTimestamp(ms, style) {
  const epoch = Math.max(0, Math.floor(ms / 1000));
  return `<t:${epoch}:${style}>`;
}

function parseIntSafe(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v > 0 ? v : null;
}

function chooseMany(arr, count) {
  const pool = Array.isArray(arr) ? arr.slice() : [];
  const picks = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function serializeIds(ids) {
  const list = Array.isArray(ids) ? ids : [...ids];
  return JSON.stringify(list.map((id) => String(id)));
}

function parseJsonIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

async function saveGiveawayRecord(record) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO giveaways (
      message_id,
      guild_id,
      channel_id,
      host_id,
      prize,
      description,
      winners_count,
      ends_at_ms,
      require_verified,
      entrants_json,
      winners_json,
      ended_at_ms,
      summary_message_id,
      canceled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      prize = VALUES(prize),
      description = VALUES(description),
      winners_count = VALUES(winners_count),
      ends_at_ms = VALUES(ends_at_ms),
      require_verified = VALUES(require_verified),
      entrants_json = VALUES(entrants_json),
      winners_json = VALUES(winners_json),
      ended_at_ms = VALUES(ended_at_ms),
      summary_message_id = VALUES(summary_message_id),
      canceled = VALUES(canceled)
    `,
    [
      String(record.messageId),
      String(record.guildId),
      String(record.channelId),
      String(record.hostId),
      String(record.prize || ""),
      String(record.description || ""),
      Number(record.winnersCount),
      Number(record.endsAtMs),
      record.requireVerified ? 1 : 0,
      serializeIds(record.entrants || []),
      serializeIds(record.winners || []),
      record.endedAtMs == null ? null : Number(record.endedAtMs),
      record.summaryMessageId ? String(record.summaryMessageId) : null,
      record.canceled ? 1 : 0,
    ]
  );
}

async function updateGiveawayFields(messageId, fields) {
  const db = getDb();
  const sets = [];
  const values = [];

  const mapping = {
    entrants_json: "entrants_json",
    winners_json: "winners_json",
    ended_at_ms: "ended_at_ms",
    summary_message_id: "summary_message_id",
    canceled: "canceled",
    require_verified: "require_verified",
  };

  for (const [key, col] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${col} = ?`);
      values.push(fields[key]);
    }
  }

  if (!sets.length) return;
  values.push(String(messageId));
  await db.execute(`UPDATE giveaways SET ${sets.join(", ")} WHERE message_id = ?`, values);
}

async function deleteGiveawayRecord(messageId) {
  const db = getDb();
  await db.execute("DELETE FROM giveaways WHERE message_id = ?", [String(messageId)]);
}

async function loadActiveGiveaways() {
  const db = getDb();
  const [rows] = await db.execute(
    "SELECT * FROM giveaways WHERE canceled = 0 AND ended_at_ms IS NULL"
  );
  return Array.isArray(rows) ? rows : [];
}

async function fetchGiveawayRecord(messageId) {
  const db = getDb();
  const [rows] = await db.execute(
    "SELECT * FROM giveaways WHERE message_id = ? LIMIT 1",
    [String(messageId)]
  );
  return rows?.[0] || null;
}

function buildGiveawayEmbed(record, { ended = false, canceled = false, winners = [], winnerLabels = null } = {}) {
  const entriesCount = record.entrants ? record.entrants.size : Number(record.entries || 0);
  const timeMs = ended || canceled ? record.endedAtMs || Date.now() : record.endsAtMs;
  const timeLabel = canceled ? "Cancelled" : ended ? "Ended" : "Ends";
  const winnersLine = ended
    ? winnerLabels?.length
      ? winnerLabels.join(", ")
      : winners.length
        ? winners.map((id) => mention(id)).join(", ")
        : "No valid entries."
    : String(record.winnersCount);

  const metaLines = [
    `${timeLabel}: ${formatTimestamp(timeMs, "R")} (${formatTimestamp(timeMs, "F")})`,
    `Hosted by: ${mention(record.hostId)}`,
    `Entries: ${entriesCount}`,
    `Winners: ${winnersLine}`,
  ];

  if (record.requireVerified) {
    metaLines.push("Eligibility: verified role + Spectreon ID required.");
  }

  if (canceled) {
    metaLines.splice(1, 0, "Status: Cancelled");
  }

  const description = record.description ? String(record.description).trim() : "";
  const details = metaLines.join("\n");
  const body = description ? `${description}\n\n${details}` : details;

  return {
    title: String(record.prize || "Giveaway"),
    description: body,
    color: canceled ? 0xed4245 : 0x5865f2,
  };
}

function buildJoinRow(messageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway:join:${messageId}`)
      .setEmoji("🎉")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildLeaveRow(messageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway:leave:${messageId}`)
      .setLabel("Leave Giveaway")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildSummaryRow(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Giveaway Summary")
      .setStyle(ButtonStyle.Link)
      .setURL(url)
  );
}

function buildGiveawaySelectRow(action, rows) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`giveaway:pick:${action}`)
    .setPlaceholder("Select a giveaway...");

  for (const row of rows) {
    const label = String(row.prize || "Giveaway").slice(0, 100);
    const endsAt = Number(row.ends_at_ms);
    const desc = Number.isFinite(endsAt) ? `Ends ${formatTimestamp(endsAt, "R")}` : "Ends unknown";
    menu.addOptions({
      label,
      value: String(row.message_id),
      description: desc.slice(0, 100),
    });
  }

  return new ActionRowBuilder().addComponents(menu);
}

function formatAutocompleteLabel(row) {
  const prize = String(row.prize || "Giveaway");
  let label = prize;
  if (label.length > 100) label = `${label.slice(0, 97)}...`;
  return label;
}

function formatRemainingTime(seconds) {
  const sec = Math.max(0, Math.floor(seconds));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const remSeconds = sec % 60;
  const parts = [];

  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (!parts.length || remSeconds) {
    parts.push(`${remSeconds} second${remSeconds === 1 ? "" : "s"}`);
  }

  return parts.join(", ");
}

async function respondGiveawayAutocomplete(interaction) {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  if (!isAdminOrPrivileged(interaction)) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options?.getFocused?.() || "").toLowerCase();
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT message_id, prize, ends_at_ms
    FROM giveaways
    WHERE canceled = 0 AND ended_at_ms IS NULL AND guild_id = ?
    ORDER BY ends_at_ms ASC
    LIMIT 25
    `,
    [String(interaction.guildId)]
  );

  const list = Array.isArray(rows) ? rows : [];
  const filtered = focused
    ? list.filter((row) => {
        const prize = String(row.prize || "").toLowerCase();
        const id = String(row.message_id || "");
        return prize.includes(focused) || id.includes(focused);
      })
    : list;

  await interaction.respond(
    filtered.slice(0, 25).map((row) => ({
      name: formatAutocompleteLabel(row),
      value: String(row.message_id),
    }))
  );
}

async function buildNameList(guild, userIds) {
  const names = [];
  const ids = Array.isArray(userIds) ? userIds : [];

  let bulk = null;
  try {
    if (guild?.members?.fetch && ids.length) {
      bulk = await guild.members.fetch({ user: ids });
    }
  } catch {}

  for (const id of ids) {
    let member = bulk?.get?.(id) || guild?.members?.cache?.get?.(id) || null;
    if (!member && guild?.members?.fetch) {
      try {
        member = await guild.members.fetch(id).catch(() => null);
      } catch {}
    }

    let rawName = member?.displayName || member?.user?.username || "";
    rawName = stripEmojisAndSymbols(rawName);
    const name = rawName || id;
    names.push({ id, name });
  }

  return names;
}

async function postSummary(channel, record, winners, endedAtMs) {
  const entrants = [...record.entrants];
  const guild = channel?.guild || null;
  const names = await buildNameList(guild, entrants);
  const winnerSet = new Set(winners.map((id) => String(id)));

  const winnerLabels = await formatUsersWithIds({ guildId: record.guildId, userIds: winners });
  const lines = [
    "Giveaway Summary",
    "",
    `Prize: ${record.prize}`,
    `Hosted by: ${mention(record.hostId)}`,
    `Ended: ${formatTimestamp(endedAtMs, "F")} (${formatTimestamp(endedAtMs, "R")})`,
    `Entries: ${entrants.length}`,
    `Winners: ${winnerLabels.length ? winnerLabels.join(", ") : "None"}`,
    "",
    "Entrants:",
  ];

  if (!names.length) {
    lines.push("(none)");
  } else {
    for (const entry of names) {
      const winnerMark = winnerSet.has(String(entry.id)) ? " (winner)" : "";
      lines.push(`- ${entry.name} (${entry.id})${winnerMark}`);
    }
  }

  const payload = lines.join("\n");
  const message = await channel.send({
    content: `Giveaway Summary: **${record.prize}**`,
    files: [
      {
        attachment: Buffer.from(payload, "utf8"),
        name: "giveaway-summary.txt",
      },
    ],
  });

  return message;
}

function scheduleGiveaway(record) {
  const msgId = String(record.messageId);
  if (activeGiveaways.has(msgId)) return;

  const delayMs = Math.max(0, Number(record.endsAtMs) - Date.now());
  const timeout = startTimeout({
    label: `giveaway:${msgId}`,
    ms: delayMs,
    fn: () => finalizeGiveaway(msgId),
  });
  activeGiveaways.set(msgId, { ...record, timeout });
}

function clearGiveawayTimer(messageId) {
  const existing = activeGiveaways.get(messageId);
  if (existing?.timeout) {
    clearTimer(existing.timeout, `giveaway:${messageId}`);
  }
  activeGiveaways.delete(messageId);
}

async function finalizeGiveaway(messageId) {
  const record = activeGiveaways.get(messageId);
  if (!record) return;

  if (!clientRef) {
    record.timeout = startTimeout({
      label: `giveaway:${messageId}`,
      ms: 5000,
      fn: () => finalizeGiveaway(messageId),
    });
    return;
  }

  clearGiveawayTimer(messageId);

  let channel = null;
  let giveawayMessage = null;
  try {
    channel = await clientRef.channels.fetch(record.channelId);
    if (!channel?.isTextBased?.()) throw new Error("Channel not text-based");
    giveawayMessage = await channel.messages.fetch(record.messageId);
  } catch (err) {
    if (err?.code === 10008 || err?.status === 404) {
      await deleteGiveawayRecord(record.messageId);
    }
    return;
  }

  const entrants = [...record.entrants];
  let eligibleEntrants = entrants;
  if (record.requireVerified) {
    const filtered = await filterEligibleEntrants({
      guild: channel?.guild || null,
      guildId: record.guildId,
      userIds: entrants,
      requireVerified: true,
      allowAdminBypass: true,
    });
    eligibleEntrants = filtered.eligibleIds;
  }

  const winners = chooseMany(eligibleEntrants, record.winnersCount);
  const endedAtMs = Date.now();
  record.endedAtMs = endedAtMs;
  record.winners = winners;
  const winnerLabels = winners.length
    ? await formatUsersWithIds({ guildId: record.guildId, userIds: winners })
    : [];

  let summaryMessageId = null;
  try {
    const summaryMessage = await postSummary(channel, record, winners, endedAtMs);
    summaryMessageId = summaryMessage?.id || null;
    const summaryUrl = summaryMessage?.url || null;
    const embed = buildGiveawayEmbed(record, { ended: true, winners, winnerLabels });
    const components = summaryUrl ? [buildSummaryRow(summaryUrl)] : [];
    await giveawayMessage.edit({ embeds: [embed], components });
  } catch (err) {
    console.warn("[giveaway] failed to post summary or edit giveaway:", err);
  }

  await updateGiveawayFields(record.messageId, {
    winners_json: serializeIds(winners),
    ended_at_ms: endedAtMs,
    summary_message_id: summaryMessageId,
  });

  if (channel?.send) {
    if (winners.length) {
      await channel.send(
        `Congratulations ${winnerLabels.join(", ")}! You won the **${record.prize}**!`
      );
    } else {
      const emptyNote = record.requireVerified
        ? `No eligible entries for **${record.prize}**.`
        : `No valid entries for **${record.prize}**.`;
      await channel.send(emptyNote);
    }
  }
}

async function cancelGiveaway(messageId) {
  const record = activeGiveaways.get(messageId);
  if (!record) return { ok: false, reason: "not_found" };

  if (!clientRef) {
    record.timeout = startTimeout({
      label: `giveaway:cancel-retry:${messageId}`,
      ms: 3000,
      fn: () => cancelGiveaway(messageId),
    });
    return { ok: false, reason: "retry" };
  }

  clearGiveawayTimer(messageId);

  record.canceled = true;
  record.endedAtMs = Date.now();

  try {
    const channel = await clientRef.channels.fetch(record.channelId);
    if (channel?.isTextBased?.()) {
      const message = await channel.messages.fetch(record.messageId);
      const embed = buildGiveawayEmbed(record, { canceled: true });
      await message.edit({ embeds: [embed], components: [] });
      await channel.send(`🛑 Giveaway ${record.messageId} was cancelled.`);
    }
  } catch (err) {
    console.warn("[giveaway] failed to cancel giveaway:", err);
  }

  await updateGiveawayFields(record.messageId, {
    canceled: 1,
    ended_at_ms: record.endedAtMs,
  });

  return { ok: true };
}

async function rerollGiveaway(messageId) {
  try {
    const record = await fetchGiveawayRecord(messageId);
    if (!record) return { ok: false, reason: "not_found" };
    if (record.canceled) return { ok: false, reason: "canceled" };
    if (!record.ended_at_ms) return { ok: false, reason: "not_ended" };

    if (!clientRef) {
      return { ok: false, reason: "no_client" };
    }

    const channel = await clientRef.channels.fetch(record.channel_id);
    if (!channel?.isTextBased?.()) throw new Error("Channel not text-based");

    const requireVerified = Boolean(Number(record.require_verified));
    const entrants = parseJsonIds(record.entrants_json);
    let eligibleEntrants = entrants;
    if (requireVerified) {
      const filtered = await filterEligibleEntrants({
        guild: channel?.guild || null,
        guildId: record.guild_id,
        userIds: entrants,
        requireVerified: true,
        allowAdminBypass: true,
      });
      eligibleEntrants = filtered.eligibleIds;
    }

    const prevWinners = new Set(parseJsonIds(record.winners_json));
    const pool = eligibleEntrants.filter((id) => !prevWinners.has(String(id)));
    const winners = chooseMany(
      pool.length ? pool : eligibleEntrants,
      Number(record.winners_count)
    );

    const giveawayState = {
      messageId: record.message_id,
      channelId: record.channel_id,
      hostId: record.host_id,
      prize: record.prize,
      description: record.description,
      winnersCount: Number(record.winners_count),
      endsAtMs: Number(record.ends_at_ms),
      endedAtMs: Number(record.ended_at_ms),
      entrants: new Set(entrants),
      requireVerified,
    };

    const message = await channel.messages.fetch(record.message_id);
    const summaryUrl = message?.components?.[0]?.components?.[0]?.url || null;
    const winnerLabels = winners.length
      ? await formatUsersWithIds({ guildId: record.guild_id, userIds: winners })
      : [];
    const embed = buildGiveawayEmbed(giveawayState, { ended: true, winners, winnerLabels });
    const components = summaryUrl ? [buildSummaryRow(summaryUrl)] : [];
    await message.edit({ embeds: [embed], components });
    if (channel?.send) {
      if (winners.length) {
        const hostLabel = await formatUserWithId({ guildId: record.guild_id, userId: giveawayState.hostId });
        await channel.send(
          `${hostLabel} rerolled the giveaway. Congratulations ${winnerLabels.join(", ")}!`
        );
      } else {
        const emptyNote = giveawayState.requireVerified
          ? `No eligible entries to reroll for **${giveawayState.prize}**.`
          : `No valid entries to reroll for **${giveawayState.prize}**.`;
        await channel.send(emptyNote);
      }
    }

    await updateGiveawayFields(record.message_id, {
      winners_json: serializeIds(winners),
    });

    return { ok: true, winners };
  } catch (err) {
    console.warn("[giveaway] failed to reroll giveaway:", err);
    return { ok: false, reason: "error" };
  }
}

async function boot(client) {
  if (booted) {
    ensureClient(client);
    return;
  }
  booted = true;
  ensureClient(client);

  try {
    const rows = await loadActiveGiveaways();
    for (const row of rows) {
      const endsAtMs = Number(row.ends_at_ms);
      const record = {
        messageId: row.message_id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        hostId: row.host_id,
        prize: row.prize,
        description: row.description,
        winnersCount: Number(row.winners_count),
        endsAtMs,
        requireVerified: Boolean(Number(row.require_verified)),
        entrants: new Set(parseJsonIds(row.entrants_json)),
        winners: parseJsonIds(row.winners_json),
        notifiedIneligible: new Set(),
      };

      if (endsAtMs <= Date.now()) {
        scheduleGiveaway(record);
        finalizeGiveaway(record.messageId);
        continue;
      }

      scheduleGiveaway(record);
    }
  } catch (err) {
    console.error("[giveaway] failed to load giveaways:", err);
  }
}

export function registerGiveaway(register) {
  register.listener(({ message }) => {
    if (!message?.client) return;
    boot(message.client);
  });

  register(
    "!giveaway",
    async ({ message, rest }) => {
      const arg = String(rest || "").trim().toLowerCase();
      if (arg !== "help") return;
      await message.reply(
        "Use `/giveaway create` to start a giveaway (modal). " +
          "Optional: set `require_verified` to require verified role + saved ID. " +
          "Manage with `/giveaway list`, `/giveaway end message_id:<id>`, " +
          "`/giveaway delete message_id:<id>`, or `/giveaway reroll message_id:<id>`."
      );
    },
    "!giveaway help — show /giveaway usage",
    { hideFromHelp: true }
  );

  register.slash(
    {
      name: "giveaway",
      description: "Manage giveaways",
      options: [
        {
          type: 1,
          name: "create",
          description: "Create a giveaway (modal)",
          options: [
            {
              type: 5,
              name: "require_verified",
              description: "Require verified role + saved ID",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "list",
          description: "List active giveaways in this server",
        },
        {
          type: 1,
          name: "end",
          description: "End a giveaway early",
          options: [
            {
              type: 3,
              name: "message_id",
              description: "Message ID of the giveaway",
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: 1,
          name: "delete",
          description: "Cancel a giveaway",
          options: [
            {
              type: 3,
              name: "message_id",
              description: "Message ID of the giveaway",
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: 1,
          name: "reroll",
          description: "Reroll winners for a giveaway",
          options: [
            {
              type: 3,
              name: "message_id",
              description: "Message ID of the giveaway",
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
    async ({ interaction }) => {
      ensureClient(interaction.client);
      await boot(interaction.client);

      if (!interaction.guildId) {
        await interaction.reply({
          content: "Giveaways must be managed in a server channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sub = interaction.options?.getSubcommand?.() || "";

      if (sub === "create") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "You do not have permission to run this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const requireVerified = Boolean(interaction.options?.getBoolean?.("require_verified"));
        if (requireVerified) {
          const verifiedRoles = getVerifiedRoleIds(interaction.guildId);
          if (!verifiedRoles.length) {
            await interaction.reply({
              content: "❌ No verified roles are configured for this server.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        const modal = new ModalBuilder()
          .setCustomId(`giveaway:modal:${interaction.id}${requireVerified ? ":verified" : ""}`)
          .setTitle("Create a Giveaway");

        const durationInput = new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Ex: 10 minutes");

        const winnersInput = new TextInputBuilder()
          .setCustomId("winners")
          .setLabel("Number of Winners")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("1");

        const prizeInput = new TextInputBuilder()
          .setCustomId("prize")
          .setLabel("Prize")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const descInput = new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(winnersInput),
          new ActionRowBuilder().addComponents(prizeInput),
          new ActionRowBuilder().addComponents(descInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (sub === "list") {
        const db = getDb();
        const [rows] = await db.execute(
          `
          SELECT message_id, channel_id, guild_id, prize, ends_at_ms, winners_count, host_id
          FROM giveaways
          WHERE canceled = 0 AND ended_at_ms IS NULL AND guild_id = ?
          ORDER BY ends_at_ms ASC
          `,
          [String(interaction.guildId)]
        );

        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
          await interaction.reply({
            content: "No active giveaways found.",
          });
          return;
        }

        const channelNames = new Map();
        await Promise.all(
          list.map(async (row) => {
            const channelId = String(row.channel_id || "");
            if (!channelId || channelNames.has(channelId)) return;
            try {
              const channel = await interaction.client.channels.fetch(channelId);
              if (channel?.name) channelNames.set(channelId, channel.name);
            } catch {}
          })
        );

        const lines = list.map((row) => {
          const channelId = String(row.channel_id || "");
          const channelName = channelNames.get(channelId) || "unknown";
          const winnersCount = Number(row.winners_count);
          const winnersLabel = `${winnersCount} winner${winnersCount === 1 ? "" : "s"}`;
          const prize = row.prize || "Giveaway";
          const host = row.host_id ? mention(row.host_id) : "Unknown";
          const endsAt = Number(row.ends_at_ms);
          const remaining = Number.isFinite(endsAt)
            ? formatRemainingTime((endsAt - Date.now()) / 1000)
            : "unknown";
          const url = `https://discord.com/channels/${row.guild_id}/${row.channel_id}/${row.message_id}`;
          const idLink = `[${row.message_id}](${url})`;
          return `${idLink} | ${channelName} | ${winnersLabel} | Prize: ${prize} | Host: ${host} | Ends in ${remaining}`;
        });

        await interaction.reply({
          content: lines.join("\n"),
        });
        return;
      }

      if (sub === "end") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "You do not have permission to run this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const messageId = String(interaction.options?.getString?.("message_id") || "").trim();
        if (!messageId) {
          const db = getDb();
          const [rows] = await db.execute(
            `
            SELECT message_id, prize, ends_at_ms
            FROM giveaways
            WHERE canceled = 0 AND ended_at_ms IS NULL AND guild_id = ?
            ORDER BY ends_at_ms ASC
            LIMIT 25
            `,
            [String(interaction.guildId)]
          );

          const list = Array.isArray(rows) ? rows : [];
          if (!list.length) {
            await interaction.reply({
              content: "No active giveaways found.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.reply({
            content: "Select a giveaway to end:",
            components: [buildGiveawaySelectRow("end", list)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!activeGiveaways.has(messageId)) {
          await interaction.reply({
            content: "That giveaway is not active or could not be found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: `Ending giveaway ${messageId}...`,
          flags: MessageFlags.Ephemeral,
        });

        await finalizeGiveaway(messageId);
        return;
      }

      if (sub === "delete") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "You do not have permission to run this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const messageId = String(interaction.options?.getString?.("message_id") || "").trim();
        if (!messageId) {
          const db = getDb();
          const [rows] = await db.execute(
            `
            SELECT message_id, prize, ends_at_ms
            FROM giveaways
            WHERE canceled = 0 AND ended_at_ms IS NULL AND guild_id = ?
            ORDER BY ends_at_ms ASC
            LIMIT 25
            `,
            [String(interaction.guildId)]
          );

          const list = Array.isArray(rows) ? rows : [];
          if (!list.length) {
            await interaction.reply({
              content: "No active giveaways found.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await interaction.reply({
            content: "Select a giveaway to cancel:",
            components: [buildGiveawaySelectRow("delete", list)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const result = await cancelGiveaway(messageId);
        if (!result.ok) {
          await interaction.reply({
            content: "That giveaway is not active or could not be found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: `Giveaway ${messageId} cancelled.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "reroll") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "You do not have permission to run this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const messageId = String(interaction.options?.getString?.("message_id") || "").trim();
        if (!messageId) {
          await interaction.reply({
            content: "Please provide a valid giveaway message ID.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const result = await rerollGiveaway(messageId);
        if (!result.ok) {
          let note = "That giveaway could not be rerolled.";
          if (result.reason === "not_found") note = "That giveaway could not be found.";
          if (result.reason === "not_ended") note = "That giveaway has not ended yet.";
          if (result.reason === "canceled") note = "That giveaway was cancelled.";
          if (result.reason === "error") {
            note = "💥 An error occurred when trying to reroll the giveaway.";
          }
          await interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.reply({
          content: `Rerolled giveaway ${messageId}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: "Unknown giveaway subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    {
      autocomplete: async ({ interaction }) => {
        const sub = interaction.options?.getSubcommand?.() || "";
        if (!["end", "delete", "reroll"].includes(sub)) {
          await interaction.respond([]);
          return;
        }
        await respondGiveawayAutocomplete(interaction);
      },
    }
  );

  register.component("giveaway:", async ({ interaction }) => {
    if (
      !interaction.isModalSubmit?.() &&
      !interaction.isButton?.() &&
      !interaction.isStringSelectMenu?.()
    ) {
      return;
    }

    ensureClient(interaction.client);
    await boot(interaction.client);

    if (!interaction.guildId) {
      await interaction.reply({
        content: "Giveaways must be created in a server channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isModalSubmit?.()) {
      if (!isAdminOrPrivileged(interaction)) {
        await interaction.reply({
          content: "You do not have permission to run this command.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const customId = String(interaction.customId || "");
      if (!customId.startsWith("giveaway:modal:")) {
        return;
      }
      const requireVerified = customId.split(":").includes("verified");

      const durationRaw = interaction.fields?.getTextInputValue?.("duration");
      const winnersRaw = interaction.fields?.getTextInputValue?.("winners");
      const prize = String(interaction.fields?.getTextInputValue?.("prize") || "").trim();
      const description = String(interaction.fields?.getTextInputValue?.("description") || "").trim();

      if (requireVerified) {
        const verifiedRoles = getVerifiedRoleIds(interaction.guildId);
        if (!verifiedRoles.length) {
          await interaction.reply({
            content: "❌ No verified roles are configured for this server.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      const durationSeconds = parseDurationSeconds(durationRaw, null);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        await interaction.reply({
          content: "Please provide a valid duration (e.g. 10m, 2h, 1d).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (durationSeconds > MAX_DURATION_SECONDS) {
        await interaction.reply({
          content: "Giveaway duration cannot exceed 3 days.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const winnersCount = parseIntSafe(winnersRaw);
      if (!winnersCount || winnersCount > MAX_WINNERS) {
        await interaction.reply({
          content: `Number of winners must be between 1 and ${MAX_WINNERS}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!prize) {
        await interaction.reply({
          content: "Please provide a prize.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const endsAtMs = Date.now() + durationSeconds * 1000;
      const record = {
        messageId: null,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        hostId: interaction.user?.id,
        prize,
        description,
        winnersCount,
        endsAtMs,
        requireVerified,
        entrants: new Set(),
        winners: [],
        endedAtMs: null,
        canceled: false,
        notifiedIneligible: new Set(),
      };

      if (!interaction.channel?.send) {
        await interaction.reply({
          content: "Could not access this channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = buildGiveawayEmbed(record, { ended: false });
      const giveawayMessage = await interaction.channel.send({ embeds: [embed] });

      record.messageId = giveawayMessage.id;
      const updatedEmbed = buildGiveawayEmbed(record, { ended: false });
      await giveawayMessage.edit({
        embeds: [updatedEmbed],
        components: [buildJoinRow(record.messageId)],
      });

      await saveGiveawayRecord(record);
      scheduleGiveaway(record);

      await interaction.reply({
        content: `The giveaway was successfully created! ID: ${record.messageId}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton?.()) {
      const customId = String(interaction.customId || "");
      const parts = customId.split(":");
      const action = parts[1];
      const messageId = parts[2];

      const record = activeGiveaways.get(messageId);
      if (!record) {
        await interaction.reply({
          content: "This giveaway is no longer active.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === "join") {
        if (record.entrants.has(interaction.user?.id)) {
          await interaction.reply({
            content: "You have already entered this giveaway!",
            components: [buildLeaveRow(messageId)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        record.entrants.add(interaction.user?.id);
        if (record.requireVerified) {
          record.notifiedIneligible = record.notifiedIneligible || new Set();
          const result = await checkEligibility({
            guild: interaction.guild,
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            member: interaction.member || null,
            requireVerified: true,
            allowAdminBypass: true,
          });
          if (!result.ok && !record.notifiedIneligible.has(interaction.user?.id)) {
            record.notifiedIneligible.add(interaction.user?.id);
            await sendDm({
              user: interaction.user,
              payload: buildEligibilityDm({
                guildName: interaction.guild?.name,
                reasons: result.reasons,
              }),
              feature: "giveaway.eligibility",
            });
          }
        }
        await updateGiveawayFields(messageId, {
          entrants_json: serializeIds(record.entrants),
        });

        const embed = buildGiveawayEmbed(record, { ended: false });
        const targetMessage = interaction.message?.id === messageId ? interaction.message : null;
        try {
          if (targetMessage?.edit) {
            await targetMessage.edit({
              embeds: [embed],
              components: [buildJoinRow(messageId)],
            });
          } else {
            const channel = await interaction.client.channels.fetch(record.channelId);
            if (channel?.isTextBased?.()) {
              const msg = await channel.messages.fetch(messageId);
              await msg.edit({ embeds: [embed], components: [buildJoinRow(messageId)] });
            }
          }
        } catch {}

        await interaction.reply({
          content: "You have entered the giveaway!",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === "leave") {
        if (!record.entrants.has(interaction.user?.id)) {
          await interaction.reply({
            content: "You are not entered in this giveaway.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        record.entrants.delete(interaction.user?.id);
        await updateGiveawayFields(messageId, {
          entrants_json: serializeIds(record.entrants),
        });

        const embed = buildGiveawayEmbed(record, { ended: false });
        const targetMessage = interaction.message?.id === messageId ? interaction.message : null;
        try {
          if (targetMessage?.edit) {
            await targetMessage.edit({
              embeds: [embed],
              components: [buildJoinRow(messageId)],
            });
          } else {
            const channel = await interaction.client.channels.fetch(record.channelId);
            if (channel?.isTextBased?.()) {
              const msg = await channel.messages.fetch(messageId);
              await msg.edit({ embeds: [embed], components: [buildJoinRow(messageId)] });
            }
          }
        } catch {}

        await interaction.reply({
          content: "You have left the giveaway.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (interaction.isStringSelectMenu?.()) {
      const customId = String(interaction.customId || "");
      if (!customId.startsWith("giveaway:pick:")) return;
      const action = customId.split(":")[2];
      const messageId = String(interaction.values?.[0] || "");
      if (!messageId) return;

      if (!isAdminOrPrivileged(interaction)) {
        await interaction.reply({
          content: "You do not have permission to run this command.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === "end") {
        if (!activeGiveaways.has(messageId)) {
          await interaction.update({
            content: "That giveaway is not active or could not be found.",
            components: [],
          });
          return;
        }

        await interaction.update({
          content: `Ending giveaway ${messageId}...`,
          components: [],
        });
        await finalizeGiveaway(messageId);
        return;
      }

      if (action === "delete") {
        const result = await cancelGiveaway(messageId);
        if (!result.ok) {
          await interaction.update({
            content: "That giveaway is not active or could not be found.",
            components: [],
          });
          return;
        }
        await interaction.update({
          content: `Giveaway ${messageId} cancelled.`,
          components: [],
        });
      }
    }
  });
}

export const _test = {
  resetState: () => {
    activeGiveaways.clear();
    booted = false;
    clientRef = null;
  },
};
