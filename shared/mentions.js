// shared/mentions.js
//
// Shared Discord mention parsing helpers.

export function parseMentionToken(token) {
  const m = /^<@!?(\d+)>$/.exec(String(token ?? "").trim());
  return m ? m[1] : null;
}

export function parseMentionIdsInOrder(text) {
  const s = String(text ?? "");
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(s)) !== null) ids.push(m[1]);
  return ids;
}

export function parseMentionIdFromText(text) {
  const ids = parseMentionIdsInOrder(text);
  return ids.length ? ids[0] : null;
}

export function getMentionedUsers(message) {
  return message?.mentions?.users ? Array.from(message.mentions.users.values()) : [];
}
