// tools/marketpoll_store.js
//
// DB access layer for MarketPoll.

import { getDb } from "../db.js";

export const MARKETPOLL_DEFAULTS = {
  enabled: false,
  channelId: null,
  cadenceMinutes: 180,
  pollMinutes: 15,
  pairCooldownDays: 90,
  minVotes: 5,
};

function normalizeLimit(limit, { fallback = 25, max = 500 } = {}) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.trunc(n);
  if (int < 1) return 1;
  return Math.min(int, max);
}

function normalizeAssetKeyList(keys, fallback = null) {
  const src = Array.isArray(keys) ? keys : [];
  const out = [...new Set(src.map((x) => String(x || "").trim()).filter(Boolean))];
  if (out.length) return out;
  const fb = String(fallback || "").trim();
  return fb ? [fb] : [];
}

function parseAssetKeyList(raw, fallback = null) {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return normalizeAssetKeyList(parsed, fallback);
  } catch {
    return normalizeAssetKeyList([], fallback);
  }
}

function mapPollRunRow(row) {
  const leftAssetKeys = parseAssetKeyList(row.left_assets_json, row.left_asset_key);
  const rightAssetKeys = parseAssetKeyList(row.right_assets_json, row.right_asset_key);
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: String(row.message_id),
    pairKey: String(row.pair_key),
    leftAssetKey: String(row.left_asset_key),
    rightAssetKey: String(row.right_asset_key),
    leftAssetKeys,
    rightAssetKeys,
    votesLeft: Number(row.votes_left || 0),
    votesRight: Number(row.votes_right || 0),
    totalVotes: Number(row.total_votes || 0),
    result: String(row.result || "error"),
    affectsScore: Boolean(row.affects_score),
    startedAtMs: Number(row.started_at_ms || 0),
    endsAtMs: Number(row.ends_at_ms || 0),
    closedAtMs: Number(row.closed_at_ms || 0),
  };
}

function toSetting(row, guildId) {
  if (!row) {
    return {
      guildId: String(guildId || ""),
      ...MARKETPOLL_DEFAULTS,
    };
  }

  return {
    guildId: String(row.guild_id),
    enabled: Boolean(row.enabled),
    channelId: row.channel_id ? String(row.channel_id) : null,
    cadenceMinutes: Number(row.cadence_minutes || MARKETPOLL_DEFAULTS.cadenceMinutes),
    pollMinutes: Number(row.poll_minutes || MARKETPOLL_DEFAULTS.pollMinutes),
    pairCooldownDays: Number(row.pair_cooldown_days || MARKETPOLL_DEFAULTS.pairCooldownDays),
    minVotes: Number(row.min_votes || MARKETPOLL_DEFAULTS.minVotes),
  };
}

export async function ensureMarketPollSettings({ guildId, updatedBy = "system" }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO goldmarket_settings (
      guild_id,
      channel_id,
      enabled,
      cadence_minutes,
      poll_minutes,
      pair_cooldown_days,
      min_votes,
      updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)
  `,
    [
      String(guildId),
      MARKETPOLL_DEFAULTS.channelId,
      MARKETPOLL_DEFAULTS.enabled ? 1 : 0,
      MARKETPOLL_DEFAULTS.cadenceMinutes,
      MARKETPOLL_DEFAULTS.pollMinutes,
      MARKETPOLL_DEFAULTS.pairCooldownDays,
      MARKETPOLL_DEFAULTS.minVotes,
      String(updatedBy || "system"),
    ]
  );
}

export async function getMarketPollSettings({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, poll_minutes, pair_cooldown_days, min_votes
    FROM goldmarket_settings
    WHERE guild_id = ?
    LIMIT 1
  `,
    [String(guildId)]
  );

  if (!rows?.[0]) {
    await ensureMarketPollSettings({ guildId });
    return { guildId: String(guildId), ...MARKETPOLL_DEFAULTS };
  }

  return toSetting(rows[0], guildId);
}

export async function updateMarketPollSettings({ guildId, patch, updatedBy }) {
  await ensureMarketPollSettings({ guildId, updatedBy });

  const allowed = new Map([
    ["channelId", "channel_id"],
    ["enabled", "enabled"],
    ["cadenceMinutes", "cadence_minutes"],
    ["pollMinutes", "poll_minutes"],
    ["pairCooldownDays", "pair_cooldown_days"],
    ["minVotes", "min_votes"],
  ]);

  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(patch || {})) {
    const col = allowed.get(key);
    if (!col) continue;
    sets.push(`${col} = ?`);

    if (key === "enabled") params.push(value ? 1 : 0);
    else if (key === "channelId") params.push(value ? String(value) : null);
    else params.push(Number(value));
  }

  if (!sets.length) {
    return getMarketPollSettings({ guildId });
  }

  sets.push("updated_by = ?");
  params.push(String(updatedBy || "system"));
  params.push(String(guildId));

  const db = getDb();
  await db.execute(
    `
    UPDATE goldmarket_settings
    SET ${sets.join(", ")}
    WHERE guild_id = ?
  `,
    params
  );

  return getMarketPollSettings({ guildId });
}

export async function listEnabledMarketPollSettings() {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, channel_id, enabled, cadence_minutes, poll_minutes, pair_cooldown_days, min_votes
    FROM goldmarket_settings
    WHERE enabled = 1
      AND channel_id IS NOT NULL
  `
  );

  return (rows || []).map((row) => toSetting(row, row.guild_id));
}

export async function insertMarketPollSchedulerLog({
  guildId,
  runAtMs = Date.now(),
  status,
  reason,
  pairKey = null,
  messageId = null,
}) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO goldmarket_scheduler_log (
      guild_id,
      run_at_ms,
      status,
      reason,
      pair_key,
      message_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
    [
      String(guildId),
      Number(runAtMs),
      String(status || "unknown"),
      String(reason || ""),
      pairKey ? String(pairKey) : null,
      messageId ? String(messageId) : null,
    ]
  );
}

export async function getLastMarketPollSchedulerRunMs({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT run_at_ms
    FROM goldmarket_scheduler_log
    WHERE guild_id = ?
    ORDER BY run_at_ms DESC
    LIMIT 1
  `,
    [String(guildId)]
  );

  if (!rows?.[0]) return null;
  const n = Number(rows[0].run_at_ms);
  return Number.isFinite(n) ? n : null;
}

export async function insertMarketPollRun({
  guildId,
  channelId,
  messageId,
  pairKey,
  leftAssetKeys,
  rightAssetKeys,
  leftAssetKey,
  rightAssetKey,
  startedAtMs,
  endsAtMs,
}) {
  const db = getDb();
  const safeLeftKeys = normalizeAssetKeyList(leftAssetKeys, leftAssetKey);
  const safeRightKeys = normalizeAssetKeyList(rightAssetKeys, rightAssetKey);
  const safeLeftPrimary = String(safeLeftKeys[0] || leftAssetKey || "");
  const safeRightPrimary = String(safeRightKeys[0] || rightAssetKey || "");

  const [result] = await db.execute(
    `
    INSERT INTO goldmarket_poll_runs (
      guild_id,
      channel_id,
      message_id,
      pair_key,
      left_asset_key,
      left_assets_json,
      right_asset_key,
      right_assets_json,
      started_at_ms,
      ends_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      String(guildId),
      String(channelId),
      String(messageId),
      String(pairKey),
      safeLeftPrimary,
      JSON.stringify(safeLeftKeys),
      safeRightPrimary,
      JSON.stringify(safeRightKeys),
      Number(startedAtMs),
      Number(endsAtMs),
    ]
  );

  return Number(result?.insertId || 0);
}

export async function listDueMarketPollRuns({ nowMs = Date.now(), limit = 25 }) {
  const db = getDb();
  const safeLimit = normalizeLimit(limit, { fallback: 25, max: 500 });
  const [rows] = await db.execute(
    `
    SELECT
      id,
      guild_id,
      channel_id,
      message_id,
      pair_key,
      left_asset_key,
      left_assets_json,
      right_asset_key,
      right_assets_json,
      started_at_ms,
      ends_at_ms
    FROM goldmarket_poll_runs
    WHERE closed_at_ms IS NULL
      AND ends_at_ms <= ?
    ORDER BY ends_at_ms ASC
    LIMIT ${safeLimit}
  `,
    [Number(nowMs)]
  );

  return (rows || []).map((row) => mapPollRunRow(row));
}

export async function closeMarketPollRun({
  id,
  votesLeft,
  votesRight,
  totalVotes,
  result,
  affectsScore,
  closedAtMs = Date.now(),
}) {
  const db = getDb();
  await db.execute(
    `
    UPDATE goldmarket_poll_runs
    SET votes_left = ?,
        votes_right = ?,
        total_votes = ?,
        result = ?,
        affects_score = ?,
        closed_at_ms = ?
    WHERE id = ?
  `,
    [
      Number(votesLeft || 0),
      Number(votesRight || 0),
      Number(totalVotes || 0),
      String(result || "error"),
      affectsScore ? 1 : 0,
      Number(closedAtMs),
      Number(id),
    ]
  );
}

export async function markMarketPollRunError({ id, closedAtMs = Date.now() }) {
  return closeMarketPollRun({
    id,
    votesLeft: 0,
    votesRight: 0,
    totalVotes: 0,
    result: "error",
    affectsScore: false,
    closedAtMs,
  });
}

export async function listOpenMarketPollPairKeys({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT pair_key
    FROM goldmarket_poll_runs
    WHERE guild_id = ?
      AND closed_at_ms IS NULL
  `,
    [String(guildId)]
  );

  return new Set((rows || []).map((row) => String(row.pair_key)));
}

export async function getMarketPollCooldownMap({ nowMs = Date.now() } = {}) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT pair_key, next_eligible_at_ms
    FROM goldmarket_pair_cooldowns
    WHERE next_eligible_at_ms > ?
  `,
    [Number(nowMs)]
  );

  const out = new Map();
  for (const row of rows || []) {
    out.set(String(row.pair_key), Number(row.next_eligible_at_ms || 0));
  }
  return out;
}

export async function upsertMarketPollCooldown({
  pairKey,
  canonicalAKey,
  canonicalBKey,
  lastPolledAtMs,
  nextEligibleAtMs,
}) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO goldmarket_pair_cooldowns (
      pair_key,
      canonical_a_key,
      canonical_b_key,
      last_polled_at_ms,
      next_eligible_at_ms,
      poll_count
    ) VALUES (?, ?, ?, ?, ?, 1)
    ON DUPLICATE KEY UPDATE
      canonical_a_key = VALUES(canonical_a_key),
      canonical_b_key = VALUES(canonical_b_key),
      last_polled_at_ms = VALUES(last_polled_at_ms),
      next_eligible_at_ms = VALUES(next_eligible_at_ms),
      poll_count = poll_count + 1
  `,
    [
      String(pairKey),
      String(canonicalAKey),
      String(canonicalBKey),
      Number(lastPolledAtMs),
      Number(nextEligibleAtMs),
    ]
  );
}

export async function getMarketPollScoresForAssets({ assetKeys }) {
  const keys = Array.isArray(assetKeys) ? assetKeys.filter(Boolean).map((x) => String(x)) : [];
  if (!keys.length) return new Map();

  const db = getDb();
  const placeholders = keys.map(() => "?").join(",");
  const [rows] = await db.execute(
    `
    SELECT
      asset_key,
      elo,
      wins,
      losses,
      ties,
      polls_count,
      votes_for,
      votes_against,
      last_poll_at_ms
    FROM goldmarket_scores
    WHERE asset_key IN (${placeholders})
  `,
    keys
  );

  const out = new Map();
  for (const row of rows || []) {
    out.set(String(row.asset_key), {
      assetKey: String(row.asset_key),
      elo: Number(row.elo || 1500),
      wins: Number(row.wins || 0),
      losses: Number(row.losses || 0),
      ties: Number(row.ties || 0),
      pollsCount: Number(row.polls_count || 0),
      votesFor: Number(row.votes_for || 0),
      votesAgainst: Number(row.votes_against || 0),
      lastPollAtMs: Number(row.last_poll_at_ms || 0),
    });
  }
  return out;
}

export async function upsertMarketPollScores({ updates }) {
  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return;

  const db = getDb();
  for (const row of list) {
    await db.execute(
      `
      INSERT INTO goldmarket_scores (
        asset_key,
        elo,
        wins,
        losses,
        ties,
        polls_count,
        votes_for,
        votes_against,
        last_poll_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        elo = VALUES(elo),
        wins = VALUES(wins),
        losses = VALUES(losses),
        ties = VALUES(ties),
        polls_count = VALUES(polls_count),
        votes_for = VALUES(votes_for),
        votes_against = VALUES(votes_against),
        last_poll_at_ms = VALUES(last_poll_at_ms)
    `,
      [
        String(row.assetKey),
        Number(row.elo),
        Number(row.wins || 0),
        Number(row.losses || 0),
        Number(row.ties || 0),
        Number(row.pollsCount || 0),
        Number(row.votesFor || 0),
        Number(row.votesAgainst || 0),
        Number(row.lastPollAtMs || 0),
      ]
    );
  }
}

export async function listMarketPollLeaderboard({ limit = 10 }) {
  const db = getDb();
  const safeLimit = normalizeLimit(limit, { fallback: 10, max: 200 });
  const [rows] = await db.execute(
    `
    SELECT asset_key, elo, wins, losses, ties, polls_count
    FROM goldmarket_scores
    ORDER BY elo DESC, polls_count DESC, asset_key ASC
    LIMIT ${safeLimit}
  `
  );

  return (rows || []).map((row) => ({
    assetKey: String(row.asset_key),
    elo: Number(row.elo || 1500),
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    ties: Number(row.ties || 0),
    pollsCount: Number(row.polls_count || 0),
  }));
}

export async function listMarketPollHistory({ assetKey = null, limit = 10 }) {
  const db = getDb();
  const safeLimit = normalizeLimit(limit, { fallback: 10, max: 200 });
  if (assetKey) {
    const target = String(assetKey || "");
    const expandedLimit = Math.min(1000, safeLimit * 25);
    const [rows] = await db.execute(
      `
      SELECT
        id,
        guild_id,
        channel_id,
        message_id,
        pair_key,
        left_asset_key,
        left_assets_json,
        right_asset_key,
        right_assets_json,
        votes_left,
        votes_right,
        total_votes,
        result,
        affects_score,
        started_at_ms,
        ends_at_ms,
        closed_at_ms
      FROM goldmarket_poll_runs
      WHERE closed_at_ms IS NOT NULL
      ORDER BY closed_at_ms DESC
      LIMIT ${expandedLimit}
    `
    );

    return (rows || [])
      .map((row) => mapPollRunRow(row))
      .filter((row) => row.leftAssetKeys.includes(target) || row.rightAssetKeys.includes(target))
      .slice(0, safeLimit);
  }

  const [rows] = await db.execute(
    `
    SELECT
      id,
      guild_id,
      channel_id,
      message_id,
      pair_key,
      left_asset_key,
      left_assets_json,
      right_asset_key,
      right_assets_json,
      votes_left,
      votes_right,
      total_votes,
      result,
      affects_score,
      started_at_ms,
      ends_at_ms,
      closed_at_ms
    FROM goldmarket_poll_runs
    WHERE closed_at_ms IS NOT NULL
    ORDER BY closed_at_ms DESC
    LIMIT ${safeLimit}
  `
  );

  return (rows || []).map((row) => mapPollRunRow(row));
}

export async function countOpenMarketPolls({ guildId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT COUNT(*) AS total
    FROM goldmarket_poll_runs
    WHERE guild_id = ?
      AND closed_at_ms IS NULL
  `,
    [String(guildId)]
  );

  return Number(rows?.[0]?.total || 0);
}
