import { PermissionsBitField } from "discord.js";

const PRIVILEGED_USERS = {
  "329934860388925442": [  // TPPC Discord
    "1008064043757600919",    // haunter07 
    "855412889308233780",     // .dkns
    "282116159686574081",     // cookiematchoo
    "184299283049218049",     // _l3
    "240964979459751937",     // webster.
  ]
};

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
