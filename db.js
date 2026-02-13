// db.js (ESM)
import mysql from "mysql2/promise";
import "dotenv/config";
import { logger } from "./shared/logger.js";

let pool;

/**
 * Get a singleton MySQL pool.
 * Uses env vars so it works the same locally + in production.
 */
export function getDb() {
  if (pool) return pool;

  const {
    DB_HOST,
    DB_PORT,
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_CONNECTION_LIMIT
  } = process.env;

  if (!DB_HOST || !DB_USER || !DB_NAME) {
    logger.error("db.config.missing", {
      hasHost: Boolean(DB_HOST),
      hasUser: Boolean(DB_USER),
      hasName: Boolean(DB_NAME),
    });
    throw new Error(
      "Missing DB env vars. Required: DB_HOST, DB_USER, DB_NAME (and usually DB_PASSWORD)."
    );
  }

  console.log("[DB] connecting:", {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    database: process.env.DB_NAME
  });

  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT ? Number(DB_PORT) : 3306,
    user: DB_USER,
    password: DB_PASSWORD ?? "",
    database: DB_NAME,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: DB_CONNECTION_LIMIT ? Number(DB_CONNECTION_LIMIT) : 10,
    queueLimit: 0
  });

  return pool;
}

async function execDb(db, sql, params, label) {
  try {
    return await db.execute(sql, params);
  } catch (err) {
    logger.error("db.execute.error", {
      label,
      error: logger.serializeError(err),
    });
    throw err;
  }
}

export async function initDb() {
  const db = getDb();
  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS user_ids (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      saved_id INT UNSIGNED NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    )
  `,
    [],
    "init.user_ids"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS user_texts (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      kind     VARCHAR(8)  NOT NULL,
      text     TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, kind)
    )
  `,
    [],
    "init.user_texts"
  );
  await execDb(
    db,
    `
    ALTER TABLE user_texts
    CONVERT TO CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci
  `,
    [],
    "init.user_texts_charset"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS rpg_leaderboards (
      challenge VARCHAR(32) NOT NULL,
      payload   TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge)
    )
  `,
    [],
    "init.rpg_leaderboards"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS rpg_pokedex (
      entry_key VARCHAR(32) NOT NULL,
      payload   TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (entry_key)
    )
  `,
    [],
    "init.rpg_pokedex"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS rpg_leaderboard_history (
      challenge VARCHAR(32) NOT NULL,
      trainer_id VARCHAR(64) NOT NULL,
      trainer_name VARCHAR(64) NULL,
      wins INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge, trainer_id)
    )
  `,
    [],
    "init.rpg_leaderboard_history"
  );

  await execDb(
    db,
    `
    ALTER TABLE rpg_leaderboard_history
      MODIFY COLUMN trainer_id VARCHAR(64) NOT NULL
  `,
    [],
    "alter.rpg_leaderboard_history.trainer_id"
  );

  const [historyCols] = await execDb(
    db,
    `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND column_name = ?
  `,
    ["rpg_leaderboard_history", "trainer_name"],
    "check.rpg_leaderboard_history.trainer_name"
  );

  if (!historyCols?.length) {
    await execDb(
      db,
      `
      ALTER TABLE rpg_leaderboard_history
        ADD COLUMN trainer_name VARCHAR(64) NULL
    `,
      [],
      "alter.rpg_leaderboard_history.trainer_name"
    );
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS poll_contests (
      message_id VARCHAR(32) NOT NULL,
      guild_id   VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      owner_id   VARCHAR(32) NOT NULL,
      ends_at_ms BIGINT UNSIGNED NOT NULL,
      run_choose TINYINT(1) NOT NULL,
      get_lists  TINYINT(1) NOT NULL,
      winners_only TINYINT(1) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS poll_untracked (
      message_id VARCHAR(32) NOT NULL,
      untracked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id)
    )
  `);

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS goldmarket_settings (
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32),
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      cadence_minutes INT UNSIGNED NOT NULL DEFAULT 180,
      poll_minutes INT UNSIGNED NOT NULL DEFAULT 15,
      pair_cooldown_days INT UNSIGNED NOT NULL DEFAULT 90,
      min_votes INT UNSIGNED NOT NULL DEFAULT 5,
      updated_by VARCHAR(32),
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id),
      KEY goldmarket_enabled_idx (enabled),
      KEY goldmarket_channel_idx (channel_id)
    )
  `,
    [],
    "init.goldmarket_settings"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS goldmarket_poll_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32) NOT NULL,
      pair_key VARCHAR(300) NOT NULL,
      left_asset_key VARCHAR(128) NOT NULL,
      right_asset_key VARCHAR(128) NOT NULL,
      votes_left INT UNSIGNED NOT NULL DEFAULT 0,
      votes_right INT UNSIGNED NOT NULL DEFAULT 0,
      total_votes INT UNSIGNED NOT NULL DEFAULT 0,
      result VARCHAR(16) NOT NULL DEFAULT 'error',
      affects_score TINYINT(1) NOT NULL DEFAULT 0,
      started_at_ms BIGINT UNSIGNED NOT NULL,
      ends_at_ms BIGINT UNSIGNED NOT NULL,
      closed_at_ms BIGINT UNSIGNED,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY goldmarket_poll_message_idx (message_id),
      KEY goldmarket_poll_due_idx (closed_at_ms, ends_at_ms),
      KEY goldmarket_poll_pair_idx (pair_key),
      KEY goldmarket_poll_guild_open_idx (guild_id, closed_at_ms)
    )
  `,
    [],
    "init.goldmarket_poll_runs"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS goldmarket_pair_cooldowns (
      pair_key VARCHAR(300) NOT NULL,
      canonical_a_key VARCHAR(128) NOT NULL,
      canonical_b_key VARCHAR(128) NOT NULL,
      last_polled_at_ms BIGINT UNSIGNED NOT NULL,
      next_eligible_at_ms BIGINT UNSIGNED NOT NULL,
      poll_count INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (pair_key),
      KEY goldmarket_pair_next_idx (next_eligible_at_ms)
    )
  `,
    [],
    "init.goldmarket_pair_cooldowns"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS goldmarket_scores (
      asset_key VARCHAR(128) NOT NULL,
      elo DECIMAL(10,4) NOT NULL DEFAULT 1500.0000,
      wins INT UNSIGNED NOT NULL DEFAULT 0,
      losses INT UNSIGNED NOT NULL DEFAULT 0,
      ties INT UNSIGNED NOT NULL DEFAULT 0,
      polls_count INT UNSIGNED NOT NULL DEFAULT 0,
      votes_for INT UNSIGNED NOT NULL DEFAULT 0,
      votes_against INT UNSIGNED NOT NULL DEFAULT 0,
      last_poll_at_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (asset_key),
      KEY goldmarket_scores_elo_idx (elo)
    )
  `,
    [],
    "init.goldmarket_scores"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS goldmarket_scheduler_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id VARCHAR(32) NOT NULL,
      run_at_ms BIGINT UNSIGNED NOT NULL,
      status VARCHAR(32) NOT NULL,
      reason VARCHAR(128) NOT NULL,
      pair_key VARCHAR(300),
      message_id VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY goldmarket_sched_guild_run_idx (guild_id, run_at_ms)
    )
  `,
    [],
    "init.goldmarket_scheduler_log"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS giveaways (
      message_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      host_id VARCHAR(32) NOT NULL,
      prize TEXT NOT NULL,
      description TEXT NOT NULL,
      winners_count INT UNSIGNED NOT NULL,
      ends_at_ms BIGINT UNSIGNED NOT NULL,
      require_verified TINYINT(1) NOT NULL DEFAULT 0,
      entrants_json LONGTEXT NOT NULL,
      winners_json LONGTEXT NOT NULL,
      ended_at_ms BIGINT UNSIGNED,
      summary_message_id VARCHAR(32),
      canceled TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id)
    )
  `,
    [],
    "init.giveaways"
  );
  {
    const { DB_NAME } = process.env;
    const [rows] = await execDb(
      db,
      `
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'giveaways'
        AND COLUMN_NAME = 'require_verified'
    `,
      [DB_NAME],
      "init.giveaways_require_verified_check"
    );
    const total = Number(rows?.[0]?.total || 0);
    if (!total) {
      await execDb(
        db,
        `
        ALTER TABLE giveaways
        ADD COLUMN require_verified TINYINT(1) NOT NULL DEFAULT 0
      `,
        [],
        "init.giveaways_require_verified"
      );
    }
  }

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS lotto_tracking (
      guild_id VARCHAR(32) NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 0,
      thread_url TEXT,
      start_post_id INT UNSIGNED,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id)
    )
  `,
    [],
    "init.lotto_tracking"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS custom_leaderboards (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id VARCHAR(32) NOT NULL,
      name VARCHAR(64) NOT NULL,
      name_norm VARCHAR(64) NOT NULL,
      metric VARCHAR(64) NOT NULL,
      host_id VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY custom_leaderboard_name_idx (guild_id, name_norm)
    )
  `,
    [],
    "init.custom_leaderboards"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS custom_leaderboard_entries (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      leaderboard_id BIGINT UNSIGNED NOT NULL,
      participant_type VARCHAR(16) NOT NULL,
      participant_key VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      name_norm VARCHAR(128) NOT NULL,
      score BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY custom_lb_entries_lb_idx (leaderboard_id),
      UNIQUE KEY custom_lb_entries_key_idx (leaderboard_id, participant_type, participant_key),
      UNIQUE KEY custom_lb_entries_name_idx (leaderboard_id, participant_type, name_norm)
    )
  `,
    [],
    "init.custom_leaderboard_entries"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS notify_me (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      phrase TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY notify_guild_idx (guild_id),
      KEY notify_user_idx (user_id)
    )
  `,
    [],
    "init.notify_me"
  );
  {
    const { DB_NAME } = process.env;
    const [rows] = await execDb(
      db,
      `
      SELECT COUNT(*) AS total
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'notify_me'
        AND COLUMN_NAME = 'target_user_id'
    `,
      [DB_NAME],
      "init.notify_me_target_user_check"
    );
    const total = Number(rows?.[0]?.total || 0);
    if (!total) {
      await execDb(
        db,
        `
        ALTER TABLE notify_me
        ADD COLUMN target_user_id VARCHAR(32)
      `,
        [],
        "init.notify_me_target_user"
      );
    }
  }

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS forum_thread_subscriptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id VARCHAR(32) NOT NULL,
      thread_id INT UNSIGNED NOT NULL,
      thread_url VARCHAR(255) NOT NULL,
      thread_title VARCHAR(255) NOT NULL,
      thread_op VARCHAR(64) NULL,
      filter_mode VARCHAR(8) NOT NULL DEFAULT 'any',
      filter_user VARCHAR(64) NULL,
      last_seen_post_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_thread (user_id, thread_id),
      KEY idx_user (user_id),
      KEY idx_thread (thread_id)
    )
  `,
    [],
    "init.forum_thread_subscriptions"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS reminders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32),
      channel_id VARCHAR(32),
      message_id VARCHAR(32),
      phrase TEXT,
      remind_at_ms BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY reminder_user_idx (user_id),
      KEY reminder_time_idx (remind_at_ms)
    )
  `,
    [],
    "init.reminders"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS message_counts (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      count BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id),
      KEY message_counts_guild_idx (guild_id)
    )
  `,
    [],
    "init.message_counts"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      user_id VARCHAR(32) NOT NULL,
      event_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, event_id),
      KEY event_sub_event_idx (event_id)
    )
  `,
    [],
    "init.event_subscriptions"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS event_occurrences (
      event_id VARCHAR(64) NOT NULL,
      start_ms BIGINT UNSIGNED NOT NULL,
      end_ms BIGINT UNSIGNED NOT NULL,
      source VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, start_ms)
    )
  `,
    [],
    "init.event_occurrences"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS event_notifications (
      event_id VARCHAR(64) NOT NULL,
      start_ms BIGINT UNSIGNED NOT NULL,
      target_type VARCHAR(16) NOT NULL,
      target_id VARCHAR(64) NOT NULL,
      guild_id VARCHAR(32),
      channel_id VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, start_ms, target_type, target_id, channel_id),
      KEY event_notify_target_idx (target_type, target_id)
    )
  `,
    [],
    "init.event_notifications"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS metrics_counters (
      bucket_ts DATETIME NOT NULL,
      metric VARCHAR(64) NOT NULL,
      tags_hash CHAR(64) NOT NULL,
      tags_json TEXT NOT NULL,
      count BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (bucket_ts, metric, tags_hash),
      KEY metrics_metric_idx (metric),
      KEY metrics_bucket_idx (bucket_ts)
    )
  `,
    [],
    "init.metrics_counters"
  );

  await execDb(
    db,
    `
    CREATE TABLE IF NOT EXISTS welcome_dms (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    )
  `,
    [],
    "init.welcome_dms"
  );
}

/**
 * Upsert saved_id for (guild_id, user_id)
 */
export async function setSavedId({ guildId, userId, savedId }) {
  const db = getDb();
  await execDb(
    db,
    `
    INSERT INTO user_ids (guild_id, user_id, saved_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE saved_id = VALUES(saved_id)
    `,
    [String(guildId), String(userId), savedId],
    "setSavedId"
  );
}

/**
 * Get saved_id for (guild_id, user_id). Returns null if none.
 */
export async function getSavedId({ guildId, userId }) {
  const db = getDb();
  const [rows] = await execDb(
    db,
    `SELECT saved_id FROM user_ids WHERE guild_id = ? AND user_id = ? LIMIT 1`,
    [String(guildId), String(userId)],
    "getSavedId"
  );
  return rows?.[0]?.saved_id ?? null;
}

export async function deleteSavedId({ guildId, userId }) {
  const db = getDb();
  await execDb(
    db,
    `DELETE FROM user_ids WHERE guild_id = ? AND user_id = ?`,
    [String(guildId), String(userId)],
    "deleteSavedId"
  );
}

export async function setUserText({ guildId, userId, kind, text }) {
  const db = getDb();
  await execDb(
    db,
    `
    INSERT INTO user_texts (guild_id, user_id, kind, text)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE text = VALUES(text)
    `,
    [String(guildId), String(userId), String(kind), String(text)],
    "setUserText"
  );
}

export async function getUserText({ guildId, userId, kind }) {
  const db = getDb();
  const [rows] = await execDb(
    db,
    `SELECT text FROM user_texts WHERE guild_id = ? AND user_id = ? AND kind = ? LIMIT 1`,
    [String(guildId), String(userId), String(kind)],
    "getUserText"
  );
  return rows?.[0]?.text ?? null;
}

export async function getUserTextRow({ guildId, userId, kind }) {
  const db = getDb();
  const [rows] = await execDb(
    db,
    `SELECT text, updated_at FROM user_texts WHERE guild_id = ? AND user_id = ? AND kind = ? LIMIT 1`,
    [String(guildId), String(userId), String(kind)],
    "getUserTextRow"
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    text: row.text ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
  };
}

export async function deleteUserText({ guildId, userId, kind }) {
  const db = getDb();
  await execDb(
    db,
    `DELETE FROM user_texts WHERE guild_id = ? AND user_id = ? AND kind = ?`,
    [String(guildId), String(userId), String(kind)],
    "deleteUserText"
  );
}
