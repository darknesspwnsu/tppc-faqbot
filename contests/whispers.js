// contests/whispers.js
//
// Whisper phrases (slash only):
// - /whisper add phrase:<text> prize:<optional> (case-insensitive)
// - /whisper delete phrase:<text> (case-insensitive)
// - /whisper list
//
// Behavior:
// - Phrases are matched as whole words/phrases in public chat.
// - When found, the phrase is announced and removed.
import { getUserText, setUserText } from "../db.js";
import { includesWholePhrase, normalizeForMatch } from "./helpers.js";

/* ------------------------------- small helpers ------------------------------ */

function mention(id) {
  return `<@${id}>`;
}

function norm(s) {
  return String(s ?? "").trim();
}


/* ------------------------------ whisper storage ----------------------------- */

// We store all whispers for a guild under a sentinel "user_id" row.
// This makes scanning easy (one row read per guild).
const WHISPER_KIND = "whisper";
const WHISPER_USER_ID = "__guild__"; // sentinel

// In-memory fallback cache (also used as the live index)
const guildWhispers = new Map(); // guildId -> { loaded, items: [{ phrase, ownerId, prize? }], dbOk?: boolean, lastDbFailMs?: number }

const DB_RETRY_COOLDOWN_MS = 60_000;

function getGuildState(guildId) {
  if (!guildWhispers.has(guildId)) {
    guildWhispers.set(guildId, { loaded: false, items: [], dbOk: undefined, lastDbFailMs: null });
  }
  return guildWhispers.get(guildId);
}

export function serializeItems(items) {
  return JSON.stringify(
    (items || []).map((x) => ({
      phrase: String(x.phrase || ""),
      ownerId: String(x.ownerId || ""),
      prize: x.prize == null ? "" : String(x.prize || ""),
    }))
  );
}

export function deserializeItems(text) {
  try {
    const arr = JSON.parse(String(text || "[]"));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        phrase: norm(x?.phrase),
        ownerId: norm(x?.ownerId),
        prize: norm(x?.prize),
      }))
      .filter((x) => x.phrase && x.ownerId)
      .map((x) => ({
        phrase: x.phrase,
        ownerId: x.ownerId,
        prize: x.prize || "",
      }));
  } catch {
    return [];
  }
}

async function tryLoadGuildFromDb(guildId) {
  const state = getGuildState(guildId);
  if (state.dbOk === false) {
    const lastFail = state.lastDbFailMs || 0;
    if (Date.now() - lastFail < DB_RETRY_COOLDOWN_MS) return false;
  }

  try {
    const t = await getUserText({ guildId, userId: WHISPER_USER_ID, kind: WHISPER_KIND });
    state.items = deserializeItems(t);
    state.loaded = true;
    state.dbOk = true;
    state.lastDbFailMs = null;
    return true;
  } catch {
    state.dbOk = false;
    state.lastDbFailMs = Date.now();
    return false;
  }
}

async function trySaveGuildToDb(guildId) {
  const state = getGuildState(guildId);
  if (state.dbOk === false) {
    const lastFail = state.lastDbFailMs || 0;
    if (Date.now() - lastFail < DB_RETRY_COOLDOWN_MS) return false;
  }

  try {
    await setUserText({
      guildId,
      userId: WHISPER_USER_ID,
      kind: WHISPER_KIND,
      text: serializeItems(state.items),
    });
    state.dbOk = true;
    state.lastDbFailMs = null;
    return true;
  } catch {
    state.dbOk = false;
    state.lastDbFailMs = Date.now();
    return false;
  }
}

async function ensureGuildLoaded(guildId) {
  const state = getGuildState(guildId);
  if (state.loaded) return state;

  const ok = await tryLoadGuildFromDb(guildId);
  if (!ok) {
    state.items = state.items || [];
    state.loaded = true;
  }
  return state;
}

function phraseKey(phrase) {
  // De-dupe whispers per-user by normalized phrase matching rules
  return normalizeForMatch(phrase);
}

function addWhisper(state, phrase, ownerId, prize) {
  const p = norm(phrase);
  if (!p) return { ok: false, reason: "empty" };

  const key = phraseKey(p);
  const exists = state.items.some((x) => phraseKey(x.phrase) === key && x.ownerId === ownerId);
  if (exists) return { ok: false, reason: "exists" };

  state.items.push({
    phrase: p,
    ownerId: String(ownerId || ""),
    prize: norm(prize),
  });
  return { ok: true };
}

export function removeWhisper(state, phrase, ownerId) {
  const p = norm(phrase);
  if (!p) return { ok: false, reason: "empty" };

  const key = phraseKey(p);
  const idx = state.items.findIndex((x) => x.ownerId === ownerId && phraseKey(x.phrase) === key);
  if (idx === -1) return { ok: false, reason: "missing" };

  state.items.splice(idx, 1);
  return { ok: true };
}

function listWhispersForUser(state, ownerId) {
  return state.items.filter((x) => x.ownerId === ownerId);
}

/* -------------------------------- registry -------------------------------- */

export function registerWhispers(register) {
  register.slash(
    {
      name: "whisper",
      description: "Manage magic phrases you are listening for (not for reminders)",
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "add",
          description: "Add a phrase to listen for (case-insensitive)",
          options: [
            {
              type: 3, // STRING
              name: "phrase",
              description: "The phrase to listen for (case-insensitive)",
              required: true,
            },
            {
              type: 3, // STRING
              name: "prize",
              description: "Optional prize text to show when someone finds the phrase",
              required: false,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "delete",
          description: "Delete a phrase you previously registered (case-insensitive)",
          options: [
            {
              type: 3, // STRING
              name: "phrase",
              description: "The phrase to delete (case-insensitive)",
              required: true,
            },
          ],
        },
        {
          type: 1, // SUB_COMMAND
          name: "list",
          description: "List your active phrases",
        },
      ],
    },
    async ({ interaction }) => {
      const guildId = interaction.guild?.id;
      if (!guildId) {
        await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
        return;
      }

      const mode = norm(interaction.options?.getSubcommand?.()) || "add";
      const phrase = norm(interaction.options?.getString?.("phrase"));
      const prize = norm(interaction.options?.getString?.("prize"));
      const ownerId = interaction.user?.id;

      const state = await ensureGuildLoaded(guildId);

      if (mode === "list") {
        const mine = listWhispersForUser(state, ownerId);
        if (!mine.length) {
          await interaction.reply({ content: "You have no active whispers in this server.", ephemeral: true });
          return;
        }

        const lines = mine
          .map((x, i) => {
            const prizePart = x.prize ? ` — Prize: ${x.prize}` : "";
            return `${i + 1}. "${x.phrase}"${prizePart}`;
          })
          .slice(0, 50);

        const extra = mine.length > 50 ? `\n…plus ${mine.length - 50} more.` : "";

        await interaction.reply({
          content: `Your whispers in **${interaction.guild?.name ?? "this server"}**:\n${lines.join("\n")}${extra}`,
          ephemeral: true,
        });
        return;
      }

      if (!phrase) {
        await interaction.reply({ content: "Please provide a phrase.", ephemeral: true });
        return;
      }

      if (mode === "delete") {
        const res = removeWhisper(state, phrase, ownerId);
        if (!res.ok && res.reason === "missing") {
          await interaction.reply({
            content: `You are not listening for: "${phrase}"`,
            ephemeral: true,
          });
          return;
        }
        if (!res.ok) {
          await interaction.reply({ content: "Invalid phrase.", ephemeral: true });
          return;
        }

        await trySaveGuildToDb(guildId);

        await interaction.reply({
          content: `🗑️ Removed whisper: "${phrase}"`,
          ephemeral: true,
        });
        return;
      }

      const res = addWhisper(state, phrase, ownerId, prize);
      if (!res.ok && res.reason === "exists") {
        await interaction.reply({
          content: `You are already listening for: "${phrase}"`,
          ephemeral: true,
        });
        return;
      }
      if (!res.ok) {
        await interaction.reply({ content: "Invalid phrase.", ephemeral: true });
        return;
      }

      await trySaveGuildToDb(guildId);

      await interaction.reply({
        content:
          `✅ Listening for: "${phrase}"` +
          (prize ? `\nPrize: ${prize}` : "") +
          `\nUse \`/whisper list\` to see your phrases.` +
          `\nFor reminders/notifications, use \`/notifyme\` or \`/remindme\`.`,
        ephemeral: true,
      });
    }
  );

  // Passive listener: detect phrases (whole word / whole phrase)
  register.listener(async ({ message }) => {
    try {
      if (!message || message.author?.bot) return;

      const guildId = message.guild?.id;
      if (!guildId) return;

      const content = norm(message.content);
      if (!content) return;

      const normalizedMessage = normalizeForMatch(content);

      const state = await ensureGuildLoaded(guildId);
      if (!state.items.length) return;

      for (let i = 0; i < state.items.length; i++) {
        const w = state.items[i];
        const phrase = norm(w.phrase);
        if (!phrase) continue;

        if (includesWholePhrase(normalizedMessage, phrase)) {
          const ownerId = w.ownerId;
          const prize = norm(w.prize);

          let msgOut =
            `🎉 Congratulations, you have found the hidden phrase "${phrase}" set by ${mention(ownerId)}!`;
          if (prize) msgOut += `\nYou have won: ${prize}`;

          await message.reply({
            content: msgOut,
            allowedMentions: { users: [ownerId] },
          });

          // one-shot removal
          state.items.splice(i, 1);
          await trySaveGuildToDb(guildId);
          break;
        }
      }
    } catch {
      // keep failures isolated
    }
  });
}
