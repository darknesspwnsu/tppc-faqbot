// info/welcome.js
//
// Welcome DM on guild join.

import { logger } from "../shared/logger.js";
import { metrics } from "../shared/metrics.js";
import { sendDm } from "../shared/dm.js";
import { WELCOME_GUILD_IDS, WELCOME_MESSAGE } from "../configs/welcome_config.js";

export async function handleGuildMemberAdd(member) {
  if (!member?.user || member.user.bot) return;
  const guildId = String(member.guild?.id || "");
  if (!WELCOME_GUILD_IDS.has(guildId)) return;

  const res = await sendDm({ user: member.user, payload: WELCOME_MESSAGE, feature: "welcome" });
  void metrics.increment("welcome.dm", { status: res.ok ? "ok" : "error" });
  if (!res.ok && res.code !== 50007) {
    logger.warn("welcome.dm.failed", {
      guildId,
      userId: member.user.id,
      error: res.error,
    });
  }
}

export const __testables = { WELCOME_MESSAGE };
