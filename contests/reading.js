// contests/reading.js
//
// Reading tracker (message commands):
// - !startReading [phrase]
// - !endReading
//
// Scope:
// - Guild + channel scoped; tracks unique responders in that channel only.
import { isAdminOrPrivileged } from "../auth.js";
import { sendChunked } from "./helpers.js";

// Keyed by "guildId:channelId"
const activeReadingSessions = new Map();

/**
 * Session shape:
 * {
 *   guildId: string,
 *   channelId: string,
 *   startedAt: number,
 *   startedBy: string,
 *   participantsById: Map<string, string>, // id -> displayName snapshot (no ping formatting)
 *   phrase: string|null,                  // optional filter phrase (case-insensitive substring)
 *   messageCount: number
 * }
 */

function sessionKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function displayNameNoPing(message) {
  // Prefer guild displayName if available, fallback to global username
  const dn = message.member?.displayName;
  const un = message.author?.username;
  return String(dn || un || "Unknown").trim();
}

function normalizeSortKey(name) {
  return String(name || "").toLowerCase();
}

export function registerReading(register) {
  // Start
  register(
    "!startReading",
    async ({ message, rest }) => {
      if (!message.guildId) return;
      if (!isAdminOrPrivileged(message)) return;

      const phrase = String(rest ?? "").trim();
      const phraseNorm = phrase ? phrase.toLowerCase() : null;

      const key = sessionKey(message.guildId, message.channelId);
      if (activeReadingSessions.has(key)) {
        await message.reply("Reading is already active in this channel. Use `!endReading` to stop.");
        return;
      }

      activeReadingSessions.set(key, {
        guildId: message.guildId,
        channelId: message.channelId,
        startedAt: Date.now(),
        startedBy: message.author.id,
        participantsById: new Map(),
        phrase: phraseNorm,
        messageCount: 0,
      });

      await message.reply(
        phraseNorm
          ? `✅ Reading started. I’m tracking unique responders whose messages include: "${phrase}"`
          : "✅ Reading started. I’m now tracking unique responders in this channel."
      );
    },
    "!startReading — start tracking unique responders in this channel"
  );

  // End
  register(
    "!endReading",
    async ({ message }) => {
      if (!message.guildId) return;
      if (!isAdminOrPrivileged(message)) return;

      const key = sessionKey(message.guildId, message.channelId);
      const session = activeReadingSessions.get(key);

      if (!session) {
        await message.reply("No active reading session in this channel. Use `!startReading` first.");
        return;
      }

      activeReadingSessions.delete(key);

      const names = [...session.participantsById.values()]
        .map((s) => String(s || "").trim())
        .filter(Boolean);

      // Unique by case-insensitive name (extra safety, in case display names collide)
      const seen = new Set();
      const deduped = [];
      for (const n of names) {
        const k = normalizeSortKey(n);
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(n);
      }

      deduped.sort((a, b) => normalizeSortKey(a).localeCompare(normalizeSortKey(b)));

      if (!deduped.length) {
        const note = session.phrase
          ? `📖 Reading ended. No messages matched the phrase "${session.phrase}".`
          : "📖 Reading ended. No participants spoke during the session.";

        await message.channel.send(note);
        return;
      }

      // Output does NOT tag (no <@id>)
      const header = `📖 Reading ended. Participants (${deduped.length}):`;
      const body = deduped.join("\n");

      await sendChunked({
        send: (content) => message.channel.send(content),
        header,
        lines: deduped,
      });
    },
    "!endReading — stop tracking and print the unique responder list"
  );

  // Passive listener: collect unique responders while active
  register.listener(async ({ message }) => {
    try {
      if (!message?.guildId) return;
      if (!message.channelId) return;
      if (!message.author || message.author.bot) return;

      const key = sessionKey(message.guildId, message.channelId);
      const session = activeReadingSessions.get(key);
      if (!session) return;

      // Optional phrase filter (case-insensitive substring)
      if (session.phrase) {
        const content = String(message.content ?? "");
        if (!content.toLowerCase().includes(session.phrase)) return;
      }

      session.messageCount += 1;

      const uid = message.author.id;
      if (!session.participantsById.has(uid)) {
        session.participantsById.set(uid, displayNameNoPing(message));
      }
    } catch {
      // keep listener failures isolated
    }
  });
}
