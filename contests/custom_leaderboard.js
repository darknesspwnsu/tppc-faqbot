// contests/custom_leaderboard.js
//
// Custom leaderboard helper (bang + button confirmations).

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { getDb } from "../db.js";
import { isAdminOrPrivileged } from "../auth.js";
import { logger } from "../shared/logger.js";
import { parseMentionIdFromText } from "../shared/mentions.js";

const MAX_LEADERBOARDS_PER_GUILD = 5;
const MAX_CONFIRM_AGE_MS = 5 * 60_000;
const MAX_LEADERBOARD_NAME_LEN = 64;
const MAX_METRIC_NAME_LEN = 64;
const MAX_PARTICIPANT_NAME_LEN = 128;

const USER_MENTION_ONLY = { allowedMentions: { parse: ["users"] } };

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

function replyWithUserMentions(message, payload) {
  if (typeof payload === "string") {
    return message.reply({ content: payload, ...USER_MENTION_ONLY });
  }
  return message.reply({ ...payload, ...USER_MENTION_ONLY });
}

function trimOuterQuotes(value) {
  const v = String(value || "").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

function consumeToken(raw) {
  const text = String(raw || "").trim();
  if (!text) return { token: "", rest: "", quoted: false };
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end === -1) return { error: "missing_quote" };
    const token = text.slice(1, end);
    const rest = text.slice(end + 1).trim();
    return { token, rest, quoted: true };
  }
  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) return { token: "", rest: "", quoted: false };
  return { token: match[1], rest: (match[2] || "").trim(), quoted: false };
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

function tokenizeScoreList(raw) {
  const cleaned = String(raw || "").replace(/,/g, " ");
  const tokens = [];
  const re = /"([^"]+)"|<@!?\d+>|\S+/g;
  let match;
  while ((match = re.exec(cleaned))) {
    tokens.push(trimOuterQuotes(match[0]));
  }
  return tokens.filter(Boolean);
}

function parseScoreValue(raw, { allowImplicitPlus }) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const normalized = !/^[+-]/.test(value) && allowImplicitPlus ? `+${value}` : value;
  if (!/^[+-]?\d+$/.test(normalized)) return null;
  return Number(normalized);
}

function parseScoreUpdates(raw) {
  const tokens = tokenizeScoreList(raw);
  if (!tokens.length) {
    return {
      ok: false,
      error: "Provide one or more name/score pairs.",
    };
  }
  if (tokens.length % 2 !== 0) {
    return {
      ok: false,
      error:
        "Each score update must include a name and a score. Use quotes for names with spaces or replace spaces with underscores.",
    };
  }

  const items = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const name = tokens[i];
    const scoreRaw = tokens[i + 1];
    const value = parseScoreValue(scoreRaw, { allowImplicitPlus: true });
    if (value === null) {
      return { ok: false, error: `Invalid score: "${scoreRaw}"` };
    }
    items.push({ name, value });
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

async function fetchLeaderboardsForGuild({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT id, guild_id, name, name_norm, metric, host_id
     FROM custom_leaderboards
     WHERE guild_id = ?
     ORDER BY name ASC`,
    [String(guildId)]
  );
  return (rows || []).map((row) => ({
    id: Number(row.id),
    guildId: String(row.guild_id),
    name: String(row.name),
    nameNorm: String(row.name_norm),
    metric: String(row.metric),
    hostId: String(row.host_id),
  }));
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
    const mentionId = parseMentionIdFromText(token);
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
    if (name.length > MAX_PARTICIPANT_NAME_LEN) {
      return {
        ok: false,
        error: `Participant name must be ${MAX_PARTICIPANT_NAME_LEN} characters or fewer.`,
      };
    }
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
  const mentionId = parseMentionIdFromText(input);
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
    "• `!customlb create <lb_name> [metric]` — metric defaults to Points\n" +
    "• `!customlb list` — list active custom leaderboards\n" +
    "• `!customlb delete|del <lb_name>` — delete after confirmation\n" +
    "• `!customlb rename <old> <new> [metric]` — rename and optionally update the metric\n" +
    "• `!customlb entrant add <lb_name> <list>` — add entrants (score starts at 0)\n" +
    "• `!customlb entrant delete <lb_name> <list>` — remove entrants\n" +
    "• `!customlb score set <lb_name> <name> <score>` — set a single score\n" +
    "• `!customlb score update <lb_name> <name> <delta> [name delta ...]`\n\n" +
    "Lists support spaces or commas. Names with spaces should be quoted or use underscores.\n" +
    "Score updates accept +/- values; missing signs default to +.\n" +
    "Example: `!customlb score update \"Haunter Shop\" \"The Triassic\" +2 Haunter +1`"
  );
}

export function registerCustomLeaderboards(register) {
  register(
    "!customlb",
    async ({ message, rest }) => {
      if (!message.guildId) return;
      const raw = String(rest || "").trim();
      const isAdmin = isAdminOrPrivileged(message);
      const userId = message.author?.id || null;
      if (!userId) return;
      const reply = (payload) => replyWithUserMentions(message, payload);
      if (!raw || raw.toLowerCase() === "help") {
        if (!isAdmin) return;
        await reply(buildHelpText());
        return;
      }

      const parsedAction = consumeToken(raw);
      if (parsedAction.error) {
        if (!isAdmin) return;
        await reply(
          "❌ Missing closing quote. Wrap names with spaces in quotes or use underscores."
        );
        return;
      }

      const action = String(parsedAction.token || "").toLowerCase();
      const restAfterAction = parsedAction.rest;
      if (!action) {
        if (!isAdmin) return;
        await reply("❌ Provide a subcommand. Use `!customlb help`.");
        return;
      }

      if (action === "list") {
        if (!isAdmin) return;
        if (restAfterAction) {
          await reply("❌ `!customlb list` does not take any arguments.");
          return;
        }

        const leaderboards = await fetchLeaderboardsForGuild({ guildId: message.guildId });
        if (!leaderboards.length) {
          await reply("No custom leaderboards found.");
          return;
        }

        const lines = leaderboards.map((lb) => `• **${lb.name}** — ${lb.metric}`);
        await reply(
          `**Active custom leaderboards (${leaderboards.length})**\n${lines.join("\n")}`
        );
        return;
      }

      if (action === "create") {
        if (!isAdmin) return;

        const nameToken = consumeToken(restAfterAction);
        if (nameToken.error) {
          await reply(
            "❌ Missing closing quote for the leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!nameToken.token) {
          await reply("❌ Provide a leaderboard name.");
          return;
        }

        const name = nameToken.token;
        const metric = trimOuterQuotes(nameToken.rest) || "Points";
        if (name.length > MAX_LEADERBOARD_NAME_LEN) {
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }
        if (metric.length > MAX_METRIC_NAME_LEN) {
          await reply(`❌ Metric name must be 1-${MAX_METRIC_NAME_LEN} characters.`);
          return;
        }

        if (RESERVED_LEADERBOARD_NAMES.has(normalizeName(name))) {
          await reply("❌ That leaderboard name conflicts with an existing command.");
          return;
        }

        const existing = await fetchLeaderboardByName({ guildId: message.guildId, name });
        if (existing) {
          await reply("❌ A leaderboard with that name already exists.");
          return;
        }

        const count = await countLeaderboardsForGuild({ guildId: message.guildId });
        if (count >= MAX_LEADERBOARDS_PER_GUILD) {
          await reply(
            `❌ This server already has ${MAX_LEADERBOARDS_PER_GUILD} custom leaderboards.`
          );
          return;
        }

        const id = await createLeaderboard({
          guildId: message.guildId,
          name,
          metric,
          hostId: userId,
        });
        if (!id) {
          await reply("❌ Failed to create leaderboard.");
          return;
        }

        await reply(`✅ Created **${name}** (${metric}).`);
        return;
      }

      if (action === "delete" || action === "del") {
        const nameToken = consumeToken(restAfterAction);
        if (nameToken.error) {
          if (!isAdmin) return;
          await reply(
            "❌ Missing closing quote for the leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!nameToken.token) {
          if (!isAdmin) return;
          await reply("❌ Provide a leaderboard name.");
          return;
        }
        if (nameToken.token.length > MAX_LEADERBOARD_NAME_LEN) {
          if (!isAdmin) return;
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }
        if (nameToken.rest) {
          if (!isAdmin) return;
          await reply(
            "❌ Too many arguments. If the leaderboard name contains spaces, wrap it in quotes or use underscores."
          );
          return;
        }

        const leaderboard = await fetchLeaderboardByName({
          guildId: message.guildId,
          name: nameToken.token,
        });
        if (!leaderboard) {
          if (!isAdmin) return;
          await reply("❌ Leaderboard not found.");
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction: message })) return;

        const token = createToken();
        pendingConfirms.set(token, {
          action: "delete",
          userId,
          guildId: message.guildId,
          leaderboardId: leaderboard.id,
          createdAtMs: Date.now(),
        });

        await reply({
          content: `Delete **${leaderboard.name}**?`,
          components: [buildDeleteRow(token)],
        });
        return;
      }

      if (action === "rename") {
        const oldToken = consumeToken(restAfterAction);
        if (oldToken.error) {
          if (!isAdmin) return;
          await reply(
            "❌ Missing closing quote for the old leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!oldToken.token) {
          if (!isAdmin) return;
          await reply("❌ Provide the old leaderboard name.");
          return;
        }
        if (oldToken.token.length > MAX_LEADERBOARD_NAME_LEN) {
          if (!isAdmin) return;
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }

        const newToken = consumeToken(oldToken.rest);
        if (newToken.error) {
          if (!isAdmin) return;
          await reply(
            "❌ Missing closing quote for the new leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!newToken.token) {
          if (!isAdmin) return;
          await reply("❌ Provide the new leaderboard name.");
          return;
        }
        if (newToken.token.length > MAX_LEADERBOARD_NAME_LEN) {
          if (!isAdmin) return;
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }

        const existing = await fetchLeaderboardByName({
          guildId: message.guildId,
          name: oldToken.token,
        });
        if (!existing) {
          if (!isAdmin) return;
          await reply("❌ Leaderboard not found.");
          return;
        }

        if (!isHostOrAdmin({ leaderboard: existing, actorId: userId, interaction: message })) return;

        const newName = newToken.token;
        if (RESERVED_LEADERBOARD_NAMES.has(normalizeName(newName))) {
          await reply("❌ That leaderboard name conflicts with an existing command.");
          return;
        }

        if (normalizeName(existing.name) !== normalizeName(newName)) {
          const collision = await fetchLeaderboardByName({
            guildId: message.guildId,
            name: newName,
          });
          if (collision) {
            await reply("❌ A leaderboard with the new name already exists.");
            return;
          }
        }

        const metric = trimOuterQuotes(newToken.rest) || existing.metric;
        if (metric.length > MAX_METRIC_NAME_LEN) {
          await reply(`❌ Metric name must be 1-${MAX_METRIC_NAME_LEN} characters.`);
          return;
        }
        try {
          const db = getDb();
          await db.execute(
            `UPDATE custom_leaderboards SET name = ?, name_norm = ?, metric = ? WHERE id = ?`,
            [newName, normalizeName(newName), metric, Number(existing.id)]
          );
        } catch (err) {
          logger.warn("customlb.rename.failed", { error: logger.serializeError(err) });
          await reply("❌ Failed to update leaderboard.");
          return;
        }

        await reply(`✅ Updated leaderboard to **${newName}** (${metric}).`);
        return;
      }

      if (action === "entrant") {
        const subToken = consumeToken(restAfterAction);
        if (subToken.error) {
          if (!isAdmin) return;
          await reply("❌ Missing closing quote. Use quotes for names with spaces.");
          return;
        }

        const sub = String(subToken.token || "").toLowerCase();
        let mode = null;
        if (sub === "add") {
          mode = "add";
        } else if (sub === "delete" || sub === "del" || sub === "remove") {
          mode = "delete";
        }
        if (!mode) {
          if (!isAdmin) return;
          await reply("❌ Use `!customlb entrant add|delete <lb_name> <list>`.");
          return;
        }

        const nameToken = consumeToken(subToken.rest);
        if (nameToken.error) {
          if (!isAdmin) return;
          await reply(
            "❌ Missing closing quote for the leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!nameToken.token) {
          if (!isAdmin) return;
          await reply("❌ Provide a leaderboard name and a participant list.");
          return;
        }
        if (nameToken.token.length > MAX_LEADERBOARD_NAME_LEN) {
          if (!isAdmin) return;
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }

        const listRaw = String(nameToken.rest || "").trim();
        if (!listRaw) {
          if (!isAdmin) return;
          await reply("❌ Provide one or more participants.");
          return;
        }

        const leaderboard = await fetchLeaderboardByName({
          guildId: message.guildId,
          name: nameToken.token,
        });
        if (!leaderboard) {
          if (!isAdmin) return;
          await reply("❌ Leaderboard not found.");
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction: message })) return;

        const parsed = await parseParticipantList(listRaw, { client: message.client });
        if (!parsed.ok) {
          await reply(`❌ ${parsed.error}`);
          return;
        }

        const entries = parsed.entries;
        if (!entries.length) {
          await reply("❌ Provide one or more participants.");
          return;
        }

        const existing = await fetchLeaderboardEntries({ leaderboardId: leaderboard.id });
        const existingDiscord = new Set(
          existing.filter((e) => e.participantType === "discord").map((e) => e.participantKey)
        );
        const existingText = new Set(
          existing.filter((e) => e.participantType === "text").map((e) => e.nameNorm)
        );

        if (mode === "add") {
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
            await reply("❌ All provided participants already exist.");
            return;
          }

          await addParticipants({ leaderboardId: leaderboard.id, entries: toAdd });
          const addedLabel = toAdd.map(formatEntryLabel).join(", ");
          const skippedLabel = skipped.length ? `\nSkipped: ${skipped.map(formatEntryLabel).join(", ")}` : "";
          await reply(`✅ Added: ${addedLabel}${skippedLabel}`);
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
          await reply("❌ None of those participants were found.");
          return;
        }

        await removeParticipants({ leaderboardId: leaderboard.id, entries: toRemove });
        const removedLabel = toRemove.map(formatEntryLabel).join(", ");
        const missingLabel = missing.length ? `\nMissing: ${missing.map(formatEntryLabel).join(", ")}` : "";
        await reply(`✅ Removed: ${removedLabel}${missingLabel}`);
        return;
      }

      if (action === "score") {
        const subToken = consumeToken(restAfterAction);
        if (subToken.error) {
          if (!isAdmin) return;
          await reply("❌ Missing closing quote. Use quotes for names with spaces.");
          return;
        }

        const sub = String(subToken.token || "").toLowerCase();
        if (sub !== "set" && sub !== "update") {
          if (!isAdmin) return;
          await reply("❌ Use `!customlb score set|update <lb_name> <entries>`.");
          return;
        }

        const nameToken = consumeToken(subToken.rest);
        if (nameToken.error) {
          if (!isAdmin) return;
          await reply(
            "❌ Missing closing quote for the leaderboard name. Use quotes or underscores."
          );
          return;
        }
        if (!nameToken.token) {
          if (!isAdmin) return;
          await reply("❌ Provide a leaderboard name and score entries.");
          return;
        }
        if (nameToken.token.length > MAX_LEADERBOARD_NAME_LEN) {
          if (!isAdmin) return;
          await reply(`❌ Leaderboard name must be 1-${MAX_LEADERBOARD_NAME_LEN} characters.`);
          return;
        }

        const entriesRaw = String(nameToken.rest || "").trim();
        if (!entriesRaw) {
          if (!isAdmin) return;
          await reply("❌ Provide one or more score entries.");
          return;
        }

        const leaderboard = await fetchLeaderboardByName({
          guildId: message.guildId,
          name: nameToken.token,
        });
        if (!leaderboard) {
          if (!isAdmin) return;
          await reply("❌ Leaderboard not found.");
          return;
        }

        if (!isHostOrAdmin({ leaderboard, actorId: userId, interaction: message })) return;

        const parsed = parseScoreUpdates(entriesRaw);
        if (!parsed.ok) {
          await reply(`❌ ${parsed.error}`);
          return;
        }

        if (sub === "set" && parsed.items.length !== 1) {
          await reply("❌ Score set expects a single name and score.");
          return;
        }

        const missing = [];
        const changes = [];
        for (const item of parsed.items) {
          const entry = await resolveEntryByInput({
            leaderboardId: leaderboard.id,
            input: item.name,
          });
          if (!entry) {
            missing.push(item.name);
            continue;
          }

          if (sub === "update") {
            changes.push({ entry, delta: item.value });
            continue;
          }

          changes.push({
            entryId: entry.id,
            name: entry.name,
            participantType: entry.participantType,
            participantKey: entry.participantKey,
            oldScore: entry.score,
            newScore: item.value,
          });
        }

        if (missing.length) {
          await reply(`❌ Missing participants: ${missing.join(", ")}`);
          return;
        }

        if (!changes.length) {
          await reply("❌ No valid score updates found.");
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
          guildId: message.guildId,
          leaderboardId: leaderboard.id,
          changes: resolvedChanges,
          createdAtMs: Date.now(),
        });

        await reply({
          content: `**Confirm updates**\n${lines.join("\n")}\n\nOk?`,
          components: [buildConfirmRow(token)],
        });
        return;
      }

      if (!isAdmin) return;
      await reply("❌ Unknown subcommand. Use `!customlb help`.");
    },
    "!customlb help — manage custom leaderboards",
    { admin: true, adminCategory: "Admin" }
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
  parseScoreUpdates,
  extractTokens,
  parseParticipantList,
  normalizeName,
  aggregateScoreUpdates,
  buildHelpText,
};
