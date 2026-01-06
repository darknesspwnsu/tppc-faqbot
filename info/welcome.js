// info/welcome.js
//
// Welcome DM on guild join.

import { getDb } from "../db.js";
import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { sendDm } from "../shared/dm.js";
import { WELCOME_GUILD_IDS, WELCOME_MESSAGE } from "../configs/welcome_config.js";

export async function handleGuildMemberAdd(member) {
  if (!member?.user || member.user.bot) return;
  const guildId = String(member.guild?.id || "");
  if (!WELCOME_GUILD_IDS.has(guildId)) return;

  const db = getDb();
  const [rows] = await db.execute(
    `SELECT 1 FROM welcome_dms WHERE guild_id = ? AND user_id = ? LIMIT 1`,
    [guildId, member.user.id]
  );
  if (rows?.length) return;

  const res = await sendDm({ user: member.user, payload: WELCOME_MESSAGE, feature: "welcome" });
  void metrics.increment("welcome.dm", { status: res.ok ? "ok" : "error" });
  await db.execute(
    `INSERT IGNORE INTO welcome_dms (guild_id, user_id) VALUES (?, ?)`,
    [guildId, member.user.id]
  );
  if (!res.ok && res.code !== 50007) {
    logger.warn("welcome.dm.failed", {
      guildId,
      userId: member.user.id,
      error: res.error,
    });
  }
}

export const __testables = { WELCOME_MESSAGE };
