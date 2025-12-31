// db.js (ESM)
import mysql from "mysql2/promise";
import "dotenv/config";

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
    waitForConnections: true,
    connectionLimit: DB_CONNECTION_LIMIT ? Number(DB_CONNECTION_LIMIT) : 10,
    queueLimit: 0
  });

  return pool;
}

export async function initDb() {
  const db = getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_ids (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      saved_id INT UNSIGNED NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_texts (
      guild_id VARCHAR(32) NOT NULL,
      user_id  VARCHAR(32) NOT NULL,
      kind     VARCHAR(8)  NOT NULL,
      text     TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, kind)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS rpg_leaderboards (
      challenge VARCHAR(32) NOT NULL,
      payload   TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge)
    )
  `);

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
}

/**
 * Upsert saved_id for (guild_id, user_id)
 */
export async function setSavedId({ guildId, userId, savedId }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO user_ids (guild_id, user_id, saved_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE saved_id = VALUES(saved_id)
    `,
    [String(guildId), String(userId), savedId]
  );
}

/**
 * Get saved_id for (guild_id, user_id). Returns null if none.
 */
export async function getSavedId({ guildId, userId }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT saved_id FROM user_ids WHERE guild_id = ? AND user_id = ? LIMIT 1`,
    [String(guildId), String(userId)]
  );
  return rows?.[0]?.saved_id ?? null;
}

export async function deleteSavedId({ guildId, userId }) {
  const db = getDb();
  await db.execute(
    `DELETE FROM user_ids WHERE guild_id = ? AND user_id = ?`,
    [String(guildId), String(userId)]
  );
}

export async function setUserText({ guildId, userId, kind, text }) {
  const db = getDb();
  await db.execute(
    `
    INSERT INTO user_texts (guild_id, user_id, kind, text)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE text = VALUES(text)
    `,
    [String(guildId), String(userId), String(kind), String(text)]
  );
}

export async function getUserText({ guildId, userId, kind }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT text FROM user_texts WHERE guild_id = ? AND user_id = ? AND kind = ? LIMIT 1`,
    [String(guildId), String(userId), String(kind)]
  );
  return rows?.[0]?.text ?? null;
}

export async function deleteUserText({ guildId, userId, kind }) {
  const db = getDb();
  await db.execute(
    `DELETE FROM user_texts WHERE guild_id = ? AND user_id = ? AND kind = ?`,
    [String(guildId), String(userId), String(kind)]
  );
}
