import { PermissionsBitField } from "discord.js";
import fs from "fs";
import path from "path";

// Load privileged users from JSON
let PRIVILEGED_USERS = {};

try {
  const filePath = path.resolve(process.cwd(), "configs", "privileged_users.json");
  const raw = fs.readFileSync(filePath, "utf8");
  PRIVILEGED_USERS = JSON.parse(raw);
  console.log("[AUTH] Loaded privileged users:", Object.keys(PRIVILEGED_USERS));
} catch (err) {
  console.warn("[AUTH] Could not load configs/privileged_users.json — privileged users disabled");
  PRIVILEGED_USERS = {};
}

function isAdmin(message) {
  if (!message.member) return false;
  const perms = message.member.permissions;
  return (
    perms?.has(PermissionsBitField.Flags.Administrator) ||
    perms?.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function isPrivileged(message) {
  const gid = message.guildId;
  const uid = message.author?.id;
  if (!gid || !uid) return false;

  const list = PRIVILEGED_USERS[gid];
  if (!Array.isArray(list) || list.length === 0) return false;

  return list.includes(uid);
}

export function isAdminOrPrivileged(message) {
  return isAdmin(message) || isPrivileged(message);
}
