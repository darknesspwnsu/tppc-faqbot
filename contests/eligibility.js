import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { isAdminOrPrivileged } from "../auth.js";
import { getSavedId } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let verifyConfigCache = null;

function loadVerificationConfig() {
  if (verifyConfigCache) return verifyConfigCache;
  try {
    const configPath = path.join(__dirname, "..", "configs", "verification_config.json");
    const raw = fs.readFileSync(configPath, "utf8");
    verifyConfigCache = JSON.parse(raw);
  } catch {
    verifyConfigCache = null;
  }
  return verifyConfigCache;
}

export function getVerifiedRoleIds(guildId) {
  const config = loadVerificationConfig();
  const approvalRoles = config?.guilds?.[String(guildId)]?.approvalRoles;
  if (!Array.isArray(approvalRoles)) return [];
  const ids = approvalRoles
    .map((role) => String(role?.id || "").trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function isAdminBypass({ guildId, member, userId }) {
  if (!member) return false;
  return isAdminOrPrivileged({ guildId, member, author: { id: userId } });
}

export async function resolveMember({ guild, userId }) {
  if (!guild?.members?.fetch) return guild?.members?.cache?.get?.(userId) || null;
  try {
    return await guild.members.fetch(userId);
  } catch {
    return guild?.members?.cache?.get?.(userId) || null;
  }
}

export async function resolveMembers({ guild, userIds }) {
  if (!guild?.members?.fetch) return new Map();
  try {
    return await guild.members.fetch({ user: userIds });
  } catch {
    return new Map();
  }
}

export async function checkEligibility({
  guild,
  guildId,
  userId,
  member,
  requireVerified,
  allowAdminBypass = true,
}) {
  if (!requireVerified) return { ok: true, reasons: [] };
  const resolvedMember = member || (guild ? await resolveMember({ guild, userId }) : null);

  if (allowAdminBypass && isAdminBypass({ guildId, member: resolvedMember, userId })) {
    return { ok: true, reasons: [] };
  }

  const reasons = [];
  const verifiedRoleIds = getVerifiedRoleIds(guildId);
  const hasVerifiedRole =
    verifiedRoleIds.length > 0
      ? verifiedRoleIds.some((roleId) => resolvedMember?.roles?.cache?.has?.(roleId))
      : false;
  if (!hasVerifiedRole) {
    reasons.push("missing_verified_role");
  }

  let savedId = null;
  try {
    savedId = await getSavedId({ guildId, userId });
  } catch {
    savedId = null;
  }
  if (!savedId) {
    reasons.push("missing_saved_id");
  }

  return { ok: reasons.length === 0, reasons };
}

export function buildEligibilityDm({ guildName, reasons }) {
  const header = guildName
    ? `You're not eligible for this contest in **${guildName}** yet.`
    : "You're not eligible for this contest yet.";
  const missingVerified = reasons.includes("missing_verified_role");
  const missingId = reasons.includes("missing_saved_id");
  const lines = [
    `${missingVerified ? "❌" : "✅"} Verified role`,
    `${missingId ? "❌" : "✅"} Spectreon ID set (example: \`!id add 123456\`)`,
  ];
  lines.push("Once you fix this, you'll be eligible at draw time.");
  return `${header}\n${lines.join("\n")}`;
}

export async function filterEligibleEntrants({
  guild,
  guildId,
  userIds,
  requireVerified,
  allowAdminBypass = true,
}) {
  if (!requireVerified) return { eligibleIds: userIds, ineligibleIds: [] };
  const ids = Array.isArray(userIds) ? userIds.map(String) : [];
  if (!ids.length) return { eligibleIds: [], ineligibleIds: [] };

  const members = await resolveMembers({ guild, userIds: ids });
  const savedIdResults = await Promise.all(
    ids.map(async (id) => {
      try {
        return await getSavedId({ guildId, userId: id });
      } catch {
        return null;
      }
    })
  );

  const eligibleIds = [];
  const ineligibleIds = [];
  const verifiedRoleIds = getVerifiedRoleIds(guildId);

  ids.forEach((id, idx) => {
    const member = members.get(id) || guild?.members?.cache?.get?.(id) || null;
    if (allowAdminBypass && isAdminBypass({ guildId, member, userId: id })) {
      eligibleIds.push(id);
      return;
    }

    const hasVerifiedRole =
      verifiedRoleIds.length > 0
        ? verifiedRoleIds.some((roleId) => member?.roles?.cache?.has?.(roleId))
        : false;
    const hasSavedId = Boolean(savedIdResults[idx]);

    if (hasVerifiedRole && hasSavedId) eligibleIds.push(id);
    else ineligibleIds.push(id);
  });

  return { eligibleIds, ineligibleIds };
}
