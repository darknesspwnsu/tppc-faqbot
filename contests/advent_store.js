import { getDb } from "../db.js";
import { ADVENT_DEFAULTS, ADVENT_BY_GUILD } from "../configs/advent.js";

const SETTINGS_COLUMNS = { roleId: "role_id", channelId: "channel_id", hostId: "host_id" };

export async function getAdventSettings(guildId) {
  const defaults = { ...ADVENT_DEFAULTS, ...ADVENT_BY_GUILD[String(guildId)] };
  const [rows] = await getDb().execute(
    "SELECT role_id, channel_id, host_id FROM advent_settings WHERE guild_id = ?",
    [String(guildId)]
  );
  const row = rows[0];
  return row ? { roleId: row.role_id, channelId: row.channel_id, hostId: row.host_id } : defaults;
}

export async function updateAdventSettings({ guildId, settings, patch, updatedBy }) {
  const keys = Object.keys(SETTINGS_COLUMNS).filter((key) => patch[key] != null);
  if (!keys.length) return;
  const next = { ...settings, ...patch };
  // Only patch the requested fields on an existing row, preserving concurrent
  // changes to other settings. Column names come from the fixed allowlist above.
  await getDb().execute(
    `INSERT INTO advent_settings (guild_id, role_id, channel_id, host_id, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ${keys.map((key) => `${SETTINGS_COLUMNS[key]} = VALUES(${SETTINGS_COLUMNS[key]})`).join(", ")},
       updated_by = VALUES(updated_by)`,
    [String(guildId), next.roleId, next.channelId, next.hostId, String(updatedBy)]
  );
}

export async function insertAdventClaim({ guildId, date, userId, username, displayName, claimedAtMs, channelId, sourceId }) {
  try {
    await getDb().execute(
      `INSERT INTO advent_claims
       (guild_id, claim_date, user_id, username, display_name, claimed_at_ms, channel_id, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(guildId), date, String(userId), username, displayName, claimedAtMs, String(channelId), String(sourceId)]
    );
    return true;
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") return false;
    throw err;
  }
}

export async function getAdventClaims({ guildId, date }) {
  const [rows] = await getDb().execute(
    `SELECT user_id, username, display_name, claimed_at_ms, channel_id, source_id
     FROM advent_claims WHERE guild_id = ? AND claim_date = ?
     ORDER BY claimed_at_ms, user_id`,
    [String(guildId), date]
  );
  return rows;
}
