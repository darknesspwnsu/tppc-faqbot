// contests/custom_leaderboard.js
//
// Custom leaderboard helper (slash only).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { logger } from "../shared/logger.js";

const MAX_LEADERBOARDS_PER_GUILD = 5;
const MAX_CONFIRM_AGE_MS = 5 * 60_000;

const RESERVED_LEADERBOARD_NAMES = new Set([
  "ssanne",
  "ss",
  "anne",
  "tc",
  "training",
  "trainingchallenge",
  "safarizone",
  "safari",
  "sz",
  "speedtower",
  "speed",
  "roulette",
  "battleroulette",
  "br",
  "swarm",
  "trainers",
  "pokemon",
  "poke",
  "leaderboard",
  "leader",
  "lb",
  "ld",
]);

const pendingConfirms = new Map(); // token -> { action, userId, guildId, leaderboardId, changes, createdAtMs }

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidKey(value) {
  return Boolean(value) && !/\s/.test(value);
}

function trimOuterQuotes(value) {
  const v = String(value || "").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

function parseMentionId(value) {
  const match = /<@!?(\d+)>/.exec(String(value || "").trim());
  return match ? match[1] : null;
}

function extractTokens(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.includes(",")) {
    return text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map(trimOuterQuotes);
  }

  const tokens = [];
  const re = /"([^"]+)"|<@!?\d+>|\S+/g;
  let match;
  while ((match = re.exec(text))) {
    tokens.push(trimOuterQuotes(match[0]));
  }
  return tokens;
}

function parseScorePairs(raw, { allowDelta }) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "Provide one or more name:score entries." };

  const pairs = [];

  if (text.includes(",")) {
    const chunks = text.split(",").map((c) => c.trim()).filter(Boolean);
    for (const chunk of chunks) {
      const trimmed = trimOuterQuotes(chunk);
      const match = /^(.+?)\s*:\s*([+-]?\d+)$/.exec(trimmed);
      if (!match) {
        return { ok: false, error: `Invalid entry: "${chunk}"` };
      }
      const name = trimOuterQuotes(match[1]);
      const rawValue = match[2];
      pairs.push({ name, rawValue });
    }
  } else {
    const re = /(?:"([^"]+)"|<@!?\d+>|\S+)\s*:\s*[+-]?\d+/g;
    let match;
    let lastEnd = 0;
    while ((match = re.exec(text))) {
      const gap = text.slice(lastEnd, match.index);
      if (gap.trim()) {
        return { ok: false, error: "Invalid formatting between entries." };
      }
      const chunk = match[0];
      const parsed = /^(.+?)\s*:\s*([+-]?\d+)$/.exec(chunk);
      if (!parsed) {
        return { ok: false, error: `Invalid entry: "${chunk}"` };
      }
      const name = trimOuterQuotes(parsed[1]);
      const rawValue = parsed[2];
      pairs.push({ name, rawValue });
      lastEnd = re.lastIndex;
    }
    if (!pairs.length) {
      return { ok: false, error: "Provide one or more name:score entries." };
    }
    if (text.slice(lastEnd).trim()) {
      return { ok: false, error: "Invalid formatting after entries." };
    }
  }

  const items = [];
  for (const pair of pairs) {
    const value = Number(pair.rawValue);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return { ok: false, error: `Invalid score: "${pair.rawValue}"` };
    }
    if (!allowDelta && pair.rawValue.startsWith("+")) {
      return { ok: false, error: `Use a plain number for set: "${pair.rawValue}"` };
    }
    items.push({ name: pair.name, value });
  }

  return { ok: true, items };
}

function aggregateScoreUpdates(items) {
  const totals = new Map();
  for (const item of items) {
    const existing = totals.get(item.entry.id);
    if (existing) {
      existing.delta += item.delta;
      continue;
    }
    totals.set(item.entry.id, {
      entry: item.entry,
      delta: item.delta,
    });
  }
  return Array.from(totals.values());
}

async function fetchLeaderboardByName({ guildId, name }) {
  const db = getDb();
  const nameNorm = normalizeName(name);
  const [rows] = await db.execute(
    `SELECT id, guild_id, name, name_norm, metric, host_id
     FROM custom_leaderboards
     WHERE guild_id = ? AND name_norm = ?`,
    [String(guildId), nameNorm]
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    name: String(row.name),
    nameNorm: String(row.name_norm),
    metric: String(row.metric),
    hostId: String(row.host_id),
  };
}

async function fetchLeaderboardEntries({ leaderboardId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, participant_type, participant_key, name, name_norm, score
     FROM custom_leaderboard_entries
     WHERE leaderboard_id = ?
     ORDER BY score DESC, name ASC`,
    [Number(leaderboardId)]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    participantType: String(row.participant_type),
    participantKey: String(row.participant_key),
    name: String(row.name),
    nameNorm: String(row.name_norm),
    score: Number(row.score || 0),
  }));
}

async function fetchEntryByName({ leaderboardId, name }) {
  const db = getDb();
  const nameNorm = normalizeName(name);
  const [rows] = await db.execute(
    `SELECT id, participant_type, participant_key, name, name_norm, score
     FROM custom_leaderboard_entries
     WHERE leaderboard_id = ? AND participant_type = 'text' AND name_norm = ?`,
    [Number(leaderboardId), nameNorm]
  );
  return rows?.[0]
    ? {
        id: Number(rows[0].id),
        participantType: String(rows[0].participant_type),
        participantKey: String(rows[0].participant_key),
        name: String(rows[0].name),
        nameNorm: String(rows[0].name_norm),
        score: Number(rows[0].score || 0),
      }
    : null;
}

async function fetchEntryByDiscordId({ leaderboardId, userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, participant_type, participant_key, name, name_norm, score
     FROM custom_leaderboard_entries
     WHERE leaderboard_id = ? AND participant_type = 'discord' AND participant_key = ?`,
    [Number(leaderboardId), String(userId)]
  );
  return rows?.[0]
    ? {
        id: Number(rows[0].id),
        participantType: String(rows[0].participant_type),
        participantKey: String(rows[0].participant_key),
        name: String(rows[0].name),
        nameNorm: String(rows[0].name_norm),
        score: Number(rows[0].score || 0),
      }
    : null;
}

async function createLeaderboard({ guildId, name, metric, hostId }) {
  const db = getDb();
  const nameNorm = normalizeName(name);
  const [result] = await db.execute(
    `INSERT INTO custom_leaderboards (guild_id, name, name_norm, metric, host_id)
     VALUES (?, ?, ?, ?, ?)`,
    [String(guildId), String(name), nameNorm, String(metric), String(hostId)]
  );
  return Number(result?.insertId) || null;
}

async function deleteLeaderboard({ leaderboardId }) {
  const db = getDb();
  await db.execute(`DELETE FROM custom_leaderboard_entries WHERE leaderboard_id = ?`, [
    Number(leaderboardId),
  ]);
  await db.execute(`DELETE FROM custom_leaderboards WHERE id = ?`, [Number(leaderboardId)]);
}

async function countLeaderboardsForGuild({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS total FROM custom_leaderboards WHERE guild_id = ?`,
    [String(guildId)]
  );
  return Number(rows?.[0]?.total || 0);
}

async function listEntriesByIds(ids) {
  if (!ids.length) return [];
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, participant_type, participant_key, name, name_norm, score
     FROM custom_leaderboard_entries
     WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    participantType: String(row.participant_type),
    participantKey: String(row.participant_key),
    name: String(row.name),
    nameNorm: String(row.name_norm),
    score: Number(row.score || 0),
  }));
}

async function updateScores(changes) {
  const db = getDb();
  for (const change of changes) {
    await db.execute(`UPDATE custom_leaderboard_entries SET score = ? WHERE id = ?`, [
      Number(change.newScore),
      Number(change.entryId),
    ]);
  }
}

async function addParticipants({ leaderboardId, entries }) {
  const db = getDb();
  for (const entry of entries) {
    await db.execute(
      `INSERT INTO custom_leaderboard_entries
       (leaderboard_id, participant_type, participant_key, name, name_norm, score)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [
        Number(leaderboardId),
        entry.participantType,
        entry.participantKey,
        entry.name,
        entry.nameNorm,
      ]
    );
  }
}

async function removeParticipants({ leaderboardId, entries }) {
  if (!entries.length) return;
  const db = getDb();
  await db.execute(
    `DELETE FROM custom_leaderboard_entries
     WHERE leaderboard_id = ? AND id IN (${entries.map(() => "?").join(",")})`,
    [Number(leaderboardId), ...entries.map((e) => Number(e.id))]
  );
}

function isHostOrAdmin({ leaderboard, actorId, interaction }) {
  if (isAdminOrPrivileged(interaction)) return true;
  return leaderboard?.hostId === actorId;
}

function buildConfirmRow(token, yesLabel = "Yes", cancelLabel = "Cancel") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customlb:confirm:${token}:yes`)
      .setLabel(yesLabel)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`customlb:confirm:${token}:cancel`)
      .setLabel(cancelLabel)
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildDeleteRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customlb:confirm:${token}:yes`)
      .setLabel("Yes")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`customlb:confirm:${token}:no`)
      .setLabel("No")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`customlb:confirm:${token}:cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function createToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatEntryLabel(entry) {
  if (entry.participantType === "discord") {
    return `<@${entry.participantKey}>`;
  }
  return entry.name;
}

async function resolveDiscordNames(client, ids) {
  const names = new Map();
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      if (user) names.set(id, user.username);
    } catch {
      // ignore fetch failures; keep raw mention if needed
    }
  }
  return names;
}

async function parseParticipantList(raw, { client }) {
  const tokens = extractTokens(raw);
  if (!tokens.length) return { ok: false, error: "Provide one or more participants." };

  const mentions = [];
  const outputs = [];
  for (const token of tokens) {
    const mentionId = parseMentionId(token);
    if (mentionId) {
      mentions.push(mentionId);
      outputs.push({
        participantType: "discord",
        participantKey: mentionId,
        name: token,
        nameNorm: mentionId,
      });
      continue;
    }
    const name = trimOuterQuotes(token);
    if (!name) continue;
    outputs.push({
      participantType: "text",
      participantKey: normalizeName(name),
      name,
      nameNorm: normalizeName(name),
    });
  }

  if (mentions.length) {
    const nameMap = await resolveDiscordNames(client, mentions);
    for (const entry of outputs) {
      if (entry.participantType === "discord") {
        const resolved = nameMap.get(entry.participantKey);
        if (resolved) entry.name = resolved;
      }
    }
  }

  return { ok: true, entries: outputs };
}

async function resolveEntryByInput({ leaderboardId, input }) {
  const mentionId = parseMentionId(input);
  if (mentionId) {
    const entry = await fetchEntryByDiscordId({ leaderboardId, userId: mentionId });
    if (entry) return entry;
  }

  const trimmed = trimOuterQuotes(input);
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const entry = await fetchEntryByDiscordId({ leaderboardId, userId: trimmed });
    if (entry) return entry;
  }

  return fetchEntryByName({ leaderboardId, name: trimmed });
}

function buildHelpText() {
  return (
    "**Custom Leaderboards**\n" +
    "• `/customlb createlb <name> [metric]` — metric defaults to Points\n" +
    "• `/customlb deletelb <name>` — delete after confirmation\n" +
    "• `/customlb renamelb <old> <new> [metric]` — rename or update leaderboard name and/or metric name\n" +
    "• `/customlb participant add <name> <list>` — add participants\n" +
    "• `/customlb participant remove <name> <list>` — remove participants\n" +
    "• `/customlb score set <name> <name:score ...>`\n" +
    "• `/customlb score update <name> <name:+delta ...>`\n\n" +
    "Lists support spaces or commas. Names with spaces should be quoted.\n" +
    "Example: `\"The Triassic\":+2, Haunter:+1`"
  );
}

export function registerCustomLeaderboards(register) {
  register(
    "!customlb",
    async ({ message, rest }) => {
      if (!isAdminOrPrivileged(message)) return;
      const arg = String(rest || "").trim().toLowerCase();
      if (!arg || arg === "help") {
        await message.reply(buildHelpText());
        return;
      }
      await message.reply("❌ Use `/customlb help` for usage details.");
    },
    "!customlb help — show custom leaderboard usage",
    { admin: true, hideFromHelp: true, category: "Contests" }
  );

  register.component("customlb:confirm:", async ({ interaction }) => {
    const id = String(interaction.customId || "");
    const parts = id.split(":");
    const token = parts[2];
    const action = parts[3];
    const record = pendingConfirms.get(token);
    if (!record) {
      await interaction.reply({
        content: "❌ This confirmation has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (Date.now() - record.createdAtMs > MAX_CONFIRM_AGE_MS) {
      pendingConfirms.delete(token);
      await interaction.reply({
        content: "❌ This confirmation has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user?.id !== record.userId) {
      await interaction.reply({
        content: "❌ This confirmation isn’t for you.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "cancel" || action === "no") {
      pendingConfirms.delete(token);
      await interaction.update({ content: "Cancelled.", components: [] });
      return;
    }

    try {
      if (record.action === "delete") {
        await deleteLeaderboard({ leaderboardId: record.leaderboardId });
        pendingConfirms.delete(token);
        await interaction.update({ content: "✅ Leaderboard deleted.", components: [] });
        return;
      }

      if (record.action === "score_update") {
        await updateScores(record.changes || []);
        pendingConfirms.delete(token);
        await interaction.update({ content: "✅ Scores updated.", components: [] });
        return;
      }
    } catch (err) {
      logger.warn("customlb.confirm.failed", { error: logger.serializeError(err) });
      await interaction.update({ content: "❌ Unable to apply changes.", components: [] });
      return;
    }

    await interaction.update({ content: "❌ Unknown confirmation action.", components: [] });
  });

  register.slash(
    {
      name: "customlb",
      description: "Manage custom leaderboards (admin/host)",
      options: [
        {
          type: 1,
          name: "createlb",
          description: "Create a new custom leaderboard",
          options: [
            {
              type: 3,
              name: "name",
              description: "Leaderboard name (no spaces)",
              required: true,
            },
            {
              type: 3,
              name: "metric",
              description: "Metric label (default Points)",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "deletelb",
          description: "Delete a custom leaderboard",
          options: [
            {
              type: 3,
              name: "name",
              description: "Leaderboard name",
              required: true,
            },
          ],
        },
        {
          type: 2,
          name: "participant",
          description: "Add or remove participants",
          options: [
            {
              type: 1,
              name: "add",
              description: "Add participants",
              options: [
                {
                  type: 3,
                  name: "name",
                  description: "Leaderboard name",
                  required: true,
                },
                {
                  type: 3,
                  name: "participants",
                  description: "Comma/space list of participants",
                  required: true,
                },
              ],
            },
            {
              type: 1,
              name: "remove",
              description: "Remove participants",
              options: [
                {
                  type: 3,
                  name: "name",
                  description: "Leaderboard name",
                  required: true,
                },
                {
                  type: 3,
                  name: "participants",
                  description: "Comma/space list of participants",
                  required: true,
                },
              ],
            },
          ],
        },
        {
          type: 2,
          name: "score",
          description: "Set or update scores",
          options: [
            {
              type: 1,
              name: "set",
              description: "Set scores",
              options: [
                {
                  type: 3,
                  name: "name",
                  description: "Leaderboard name",
                  required: true,
                },
                {
                  type: 3,
                  name: "entries",
                  description: "List of name:score entries",
                  required: true,
                },
              ],
            },
            {
              type: 1,
              name: "update",
              description: "Increment or decrement scores",
              options: [
                {
                  type: 3,
                  name: "name",
                  description: "Leaderboard name",
                  required: true,
                },
                {
                  type: 3,
                  name: "entries",
                  description: "List of name:+delta or name:-delta entries",
                  required: true,
                },
              ],
            },
          ],
        },
        {
          type: 1,
          name: "help",
          description: "Show custom leaderboard help",
        },
        {
          type: 1,
          name: "renamelb",
          description: "Rename a custom leaderboard or update its metric",
          options: [
            {
              type: 3,
              name: "old_name",
              description: "Current leaderboard name",
              required: true,
            },
            {
              type: 3,
              name: "new_name",
              description: "New leaderboard name",
              required: true,
            },
            {
              type: 3,
              name: "metric",
              description: "New metric label",
              required: false,
            },
          ],
        },
      ],
    },
    async ({ interaction }) => {
      if (!interaction.guildId) return;
      if (!isAdminOrPrivileged(interaction)) {
        await interaction.reply({
          content: "❌ Only admins can use /customlb.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sub = interaction.options?.getSubcommand?.();
      const group = interaction.options?.getSubcommandGroup?.();
      const userId = interaction.user?.id;

      if (sub === "help") {
        await interaction.reply({
          content: buildHelpText(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "createlb") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "❌ Only admins can create custom leaderboards.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const name = String(interaction.options?.getString?.("name") || "").trim();
        const metricRaw = String(interaction.options?.getString?.("metric") || "").trim();
        const metric = metricRaw || "Points";

        if (!name) {
          await interaction.reply({ content: "❌ Provide a leaderboard name.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (!isValidKey(name)) {
          await interaction.reply({
            content: "❌ Leaderboard names cannot contain spaces. Use underscores instead.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (RESERVED_LEADERBOARD_NAMES.has(normalizeName(name))) {
          await interaction.reply({
            content: "❌ That leaderboard name conflicts with an existing command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const existing = await fetchLeaderboardByName({ guildId: interaction.guildId, name });
        if (existing) {
          await interaction.reply({
            content: "❌ A leaderboard with that name already exists.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const count = await countLeaderboardsForGuild({ guildId: interaction.guildId });
        if (count >= MAX_LEADERBOARDS_PER_GUILD) {
          await interaction.reply({
            content: `❌ This server already has ${MAX_LEADERBOARDS_PER_GUILD} custom leaderboards.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const id = await createLeaderboard({
          guildId: interaction.guildId,
          name,
          metric,
          hostId: userId,
        });
        if (!id) {
          await interaction.reply({
            content: "❌ Failed to create leaderboard.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: `✅ Created **${name}** (${metric}).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "deletelb") {
        const name = String(interaction.options?.getString?.("name") || "").trim();
        if (!name) {
          await interaction.reply({ content: "❌ Provide a leaderboard name.", flags: MessageFlags.Ephemeral });
          return;
        }

        const leaderboard = await fetchLeaderboardByName({ guildId: interaction.guildId, name });
        if (!leaderboard) {
          await interaction.reply({ content: "❌ Leaderboard not found.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction })) {
          await interaction.reply({ content: "❌ Only the host or admins can delete this leaderboard.", flags: MessageFlags.Ephemeral });
          return;
        }

        const token = createToken();
        pendingConfirms.set(token, {
          action: "delete",
          userId,
          guildId: interaction.guildId,
          leaderboardId: leaderboard.id,
          createdAtMs: Date.now(),
        });

        await interaction.reply({
          content: `Delete **${leaderboard.name}**?`,
          components: [buildDeleteRow(token)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (sub === "renamelb") {
        if (!isAdminOrPrivileged(interaction)) {
          await interaction.reply({
            content: "❌ Only admins can rename custom leaderboards.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const oldName = String(interaction.options?.getString?.("old_name") || "").trim();
        const newName = String(interaction.options?.getString?.("new_name") || "").trim();
        const metricRaw = String(interaction.options?.getString?.("metric") || "").trim();

        if (!oldName || !newName) {
          await interaction.reply({
            content: "❌ Provide both the old and new leaderboard names.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!isValidKey(newName)) {
          await interaction.reply({
            content: "❌ Leaderboard names cannot contain spaces. Use underscores instead.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (RESERVED_LEADERBOARD_NAMES.has(normalizeName(newName))) {
          await interaction.reply({
            content: "❌ That leaderboard name conflicts with an existing command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const existing = await fetchLeaderboardByName({ guildId: interaction.guildId, name: oldName });
        if (!existing) {
          await interaction.reply({ content: "❌ Leaderboard not found.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (normalizeName(oldName) !== normalizeName(newName)) {
          const collision = await fetchLeaderboardByName({
            guildId: interaction.guildId,
            name: newName,
          });
          if (collision) {
            await interaction.reply({
              content: "❌ A leaderboard with the new name already exists.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        const metric = metricRaw || existing.metric;
        try {
          const db = getDb();
          await db.execute(
            `UPDATE custom_leaderboards SET name = ?, name_norm = ?, metric = ? WHERE id = ?`,
            [newName, normalizeName(newName), metric, Number(existing.id)]
          );
        } catch (err) {
          logger.warn("customlb.rename.failed", { error: logger.serializeError(err) });
          await interaction.reply({
            content: "❌ Failed to update leaderboard.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: `✅ Updated leaderboard to **${newName}** (${metric}).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (group === "participant" && (sub === "add" || sub === "remove")) {
        const name = String(interaction.options?.getString?.("name") || "").trim();
        const listRaw = String(interaction.options?.getString?.("participants") || "").trim();

        if (!name || !listRaw) {
          await interaction.reply({
            content: "❌ Provide a leaderboard name and a participant list.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const leaderboard = await fetchLeaderboardByName({ guildId: interaction.guildId, name });
        if (!leaderboard) {
          await interaction.reply({ content: "❌ Leaderboard not found.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction })) {
          await interaction.reply({
            content: "❌ Only the host or admins can modify participants.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const parsed = await parseParticipantList(listRaw, { client: interaction.client });
        if (!parsed.ok) {
          await interaction.reply({ content: `❌ ${parsed.error}`, flags: MessageFlags.Ephemeral });
          return;
        }

        const entries = parsed.entries;
        if (!entries.length) {
          await interaction.reply({ content: "❌ Provide one or more participants.", flags: MessageFlags.Ephemeral });
          return;
        }

        const existing = await fetchLeaderboardEntries({ leaderboardId: leaderboard.id });
        const existingDiscord = new Set(
          existing.filter((e) => e.participantType === "discord").map((e) => e.participantKey)
        );
        const existingText = new Set(
          existing.filter((e) => e.participantType === "text").map((e) => e.nameNorm)
        );

        if (sub === "add") {
          const toAdd = [];
          const skipped = [];
          for (const entry of entries) {
            if (entry.participantType === "discord") {
              if (existingDiscord.has(entry.participantKey)) {
                skipped.push(entry);
                continue;
              }
              existingDiscord.add(entry.participantKey);
              toAdd.push(entry);
              continue;
            }
            if (existingText.has(entry.nameNorm)) {
              skipped.push(entry);
              continue;
            }
            existingText.add(entry.nameNorm);
            toAdd.push(entry);
          }

          if (!toAdd.length) {
            await interaction.reply({
              content: "❌ All provided participants already exist.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          await addParticipants({ leaderboardId: leaderboard.id, entries: toAdd });
          const addedLabel = toAdd.map(formatEntryLabel).join(", ");
          const skippedLabel = skipped.length ? `\nSkipped: ${skipped.map(formatEntryLabel).join(", ")}` : "";
          await interaction.reply({
            content: `✅ Added: ${addedLabel}${skippedLabel}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const toRemove = [];
        const missing = [];
        for (const entry of entries) {
          if (entry.participantType === "discord") {
            const found = existing.find(
              (e) => e.participantType === "discord" && e.participantKey === entry.participantKey
            );
            if (found) toRemove.push(found);
            else missing.push(entry);
          } else {
            const found = existing.find(
              (e) => e.participantType === "text" && e.nameNorm === entry.nameNorm
            );
            if (found) toRemove.push(found);
            else missing.push(entry);
          }
        }

        if (!toRemove.length) {
          await interaction.reply({
            content: "❌ None of those participants were found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await removeParticipants({ leaderboardId: leaderboard.id, entries: toRemove });
        const removedLabel = toRemove.map(formatEntryLabel).join(", ");
        const missingLabel = missing.length ? `\nMissing: ${missing.map(formatEntryLabel).join(", ")}` : "";
        await interaction.reply({
          content: `✅ Removed: ${removedLabel}${missingLabel}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (group === "score" && (sub === "set" || sub === "update")) {
        const name = String(interaction.options?.getString?.("name") || "").trim();
        const entriesRaw = String(interaction.options?.getString?.("entries") || "").trim();
        if (!name || !entriesRaw) {
          await interaction.reply({
            content: "❌ Provide a leaderboard name and score entries.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const leaderboard = await fetchLeaderboardByName({ guildId: interaction.guildId, name });
        if (!leaderboard) {
          await interaction.reply({ content: "❌ Leaderboard not found.", flags: MessageFlags.Ephemeral });
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction })) {
          await interaction.reply({
            content: "❌ Only the host or admins can update scores.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const parsed = parseScorePairs(entriesRaw, { allowDelta: sub === "update" });
        if (!parsed.ok) {
          await interaction.reply({ content: `❌ ${parsed.error}`, flags: MessageFlags.Ephemeral });
          return;
        }

        const changes = [];
        const missing = [];
        for (const item of parsed.items) {
          const entry = await resolveEntryByInput({ leaderboardId: leaderboard.id, input: item.name });
          if (!entry) {
            missing.push(item.name);
            continue;
          }
          if (sub === "update") {
            changes.push({ entry, delta: item.value });
          } else {
            changes.push({
              entryId: entry.id,
              name: entry.name,
              participantType: entry.participantType,
              participantKey: entry.participantKey,
              oldScore: entry.score,
              newScore: item.value,
            });
          }
        }

        if (missing.length) {
          await interaction.reply({
            content: `❌ Missing participants: ${missing.join(", ")}`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!changes.length) {
          await interaction.reply({
            content: "❌ No valid score updates found.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const resolvedChanges =
          sub === "update"
            ? aggregateScoreUpdates(changes).map((item) => ({
                entryId: item.entry.id,
                name: item.entry.name,
                participantType: item.entry.participantType,
                participantKey: item.entry.participantKey,
                oldScore: item.entry.score,
                newScore: item.entry.score + item.delta,
              }))
            : changes;

        const lines = resolvedChanges.map((change) => {
          const label =
            change.participantType === "discord"
              ? `<@${change.participantKey}>`
              : change.name;
          return `${label}: ${change.oldScore} → ${change.newScore}`;
        });
        const token = createToken();
        pendingConfirms.set(token, {
          action: "score_update",
          userId,
          guildId: interaction.guildId,
          leaderboardId: leaderboard.id,
          changes: resolvedChanges,
          createdAtMs: Date.now(),
        });

        await interaction.reply({
          content: `**Confirm updates**\n${lines.join("\n")}\n\nOk?`,
          components: [buildConfirmRow(token)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: "❌ Unknown subcommand.",
        flags: MessageFlags.Ephemeral,
      });
    },
    { category: "Contests", admin: true, adminCategory: "Admin" }
  );
}

export async function fetchCustomLeaderboardForGuild({ guildId, name }) {
  return fetchLeaderboardByName({ guildId, name });
}

export async function fetchCustomLeaderboardEntries({ leaderboardId }) {
  return fetchLeaderboardEntries({ leaderboardId });
}

export async function fetchCustomLeaderboardEntry({ leaderboardId, participantInput }) {
  return resolveEntryByInput({ leaderboardId, input: participantInput });
}

export const __testables = {
  parseScorePairs,
  extractTokens,
  parseParticipantList,
  normalizeName,
  aggregateScoreUpdates,
  buildHelpText,
};
