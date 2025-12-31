// rpg/storage.js
//
// DB helpers for leaderboard caching.

import { getDb } from "../db.js";

export async function upsertLeaderboard({ challenge, payload }) {
  const db = getDb();
  const text = JSON.stringify(payload ?? {});
  await db.execute(
    `
    INSERT INTO rpg_leaderboards (challenge, payload)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE
      payload = VALUES(payload),
      updated_at = CURRENT_TIMESTAMP
  `,
    [challenge, text]
  );
}

export async function getLeaderboard({ challenge }) {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT challenge, payload, updated_at FROM rpg_leaderboards WHERE challenge = ? LIMIT 1`,
    [challenge]
  );
  const row = rows?.[0];
  if (!row) return null;
  let payload = null;
  try {
    payload = JSON.parse(String(row.payload || ""));
  } catch {
    payload = null;
  }
  return {
    challenge: row.challenge,
    payload,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
  };
}
