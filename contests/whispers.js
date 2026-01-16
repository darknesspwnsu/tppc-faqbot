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
import { MessageFlags } from "discord.js";
import crypto from "node:crypto";

import { getDb, getUserText, setUserText } from "../db.js";
import { includesWholePhrase, normalizeForMatch } from "./helpers.js";

/* ------------------------------- small helpers ------------------------------ */

function mention(id) {
  return `<@${id}>`;
}

function norm(s) {
  return String(s ?? "").trim();
}

function getWhisperKey() {
  return getWhisperKeyById(getActiveKeyId());
}

function getActiveKeyId() {
  const raw = String(process.env.WHISPER_ENC_KEY_ID || "").trim();
  return raw || "v1";
}

function parseKeyConfig() {
  const raw = String(process.env.WHISPER_ENC_KEYS || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore and fall back to key=value parsing below
  }
  const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!pairs.length) return null;
  const out = {};
  for (const pair of pairs) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const id = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (id && value) out[id] = value;
  }
  return Object.keys(out).length ? out : null;
}

function decodeKeyMaterial(raw) {
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const buf = Buffer.from(raw, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function getWhisperKeyById(keyId) {
  const keys = parseKeyConfig();
  if (keys && keyId && keys[keyId]) {
    return decodeKeyMaterial(String(keys[keyId]));
  }

  const raw = String(process.env.WHISPER_ENC_KEY || "").trim();
  return decodeKeyMaterial(raw);
}


/* ------------------------------ whisper storage ----------------------------- */

// We store all whispers for a guild under a sentinel "user_id" row.
// This makes scanning easy (one row read per guild).
const WHISPER_KIND = "whisper";
const WHISPER_USER_ID = "__guild__"; // sentinel

// In-memory fallback cache (also used as the live index)
const guildWhispers = new Map(); // guildId -> { loaded, items: [{ phrase, ownerId, prize? }], dbOk?: boolean, lastDbFailMs?: number }

const DB_RETRY_COOLDOWN_MS = 60_000;
const WHISPER_ENCRYPTION_VERSION = 1;
const WHISPER_ENCRYPTION_ALG = "aes-256-gcm";

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
      createdAt:
        x?.createdAt == null
          ? null
          : Number.isFinite(Number(x.createdAt))
            ? Number(x.createdAt)
            : null,
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
        createdAt:
          x?.createdAt == null
            ? null
            : Number.isFinite(Number(x?.createdAt))
              ? Number(x.createdAt)
              : null,
      }))
      .filter((x) => x.phrase && x.ownerId)
      .map((x) => ({
        phrase: x.phrase,
        ownerId: x.ownerId,
        prize: x.prize || "",
        createdAt: x.createdAt,
      }));
  } catch {
    return [];
  }
}

function isEncryptedPayload(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return (
      parsed &&
      typeof parsed === "object" &&
      parsed.v === WHISPER_ENCRYPTION_VERSION &&
      parsed.alg === WHISPER_ENCRYPTION_ALG &&
      typeof parsed.kid === "string" &&
      typeof parsed.iv === "string" &&
      typeof parsed.tag === "string" &&
      typeof parsed.data === "string"
    );
  } catch {
    return false;
  }
}

function encryptPayload(plaintext) {
  const keyId = getActiveKeyId();
  const key = getWhisperKeyById(keyId);
  if (!key) throw new Error("Missing whisper encryption key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(WHISPER_ENCRYPTION_ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: WHISPER_ENCRYPTION_VERSION,
    kid: keyId,
    alg: WHISPER_ENCRYPTION_ALG,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function decryptPayload(text) {
  const parsed = JSON.parse(String(text || ""));
  if (!parsed || parsed.v !== WHISPER_ENCRYPTION_VERSION || parsed.alg !== WHISPER_ENCRYPTION_ALG) {
    throw new Error("Unsupported whisper payload");
  }
  const keyId = String(parsed.kid || "").trim() || "v1";
  const key = getWhisperKeyById(keyId);
  if (!key) throw new Error("Missing whisper encryption key");
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");
  const decipher = crypto.createDecipheriv(WHISPER_ENCRYPTION_ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}

function decodeStoredItems(text) {
  if (!isEncryptedPayload(text)) {
    return { items: deserializeItems(text), encrypted: false };
  }
  const plaintext = decryptPayload(text);
  return { items: deserializeItems(plaintext), encrypted: true };
}

async function tryLoadGuildFromDb(guildId) {
  const state = getGuildState(guildId);
  if (state.dbOk === false) {
    const lastFail = state.lastDbFailMs || 0;
    if (Date.now() - lastFail < DB_RETRY_COOLDOWN_MS) return false;
  }

  try {
    const t = await getUserText({ guildId, userId: WHISPER_USER_ID, kind: WHISPER_KIND });
    const { items, encrypted } = decodeStoredItems(t);
    state.items = items;
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
    const raw = serializeItems(state.items);
    const key = getWhisperKey();
    const text = key ? encryptPayload(raw) : raw;
    await setUserText({
      guildId,
      userId: WHISPER_USER_ID,
      kind: WHISPER_KIND,
      text,
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
    createdAt: Date.now(),
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

function formatWhisperCreatedAt(ms) {
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.floor(ms / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return `<t:${seconds}:f>`;
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
        await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
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
          await interaction.reply({ content: "You have no active whispers in this server.", flags: MessageFlags.Ephemeral });
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
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!phrase) {
        await interaction.reply({ content: "Please provide a phrase.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (mode === "delete") {
        const res = removeWhisper(state, phrase, ownerId);
        if (!res.ok && res.reason === "missing") {
          await interaction.reply({
            content: `You are not listening for: "${phrase}"`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!res.ok) {
          await interaction.reply({ content: "Invalid phrase.", flags: MessageFlags.Ephemeral });
          return;
        }

        await trySaveGuildToDb(guildId);

        await interaction.reply({
          content: `🗑️ Removed whisper: "${phrase}"`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const res = addWhisper(state, phrase, ownerId, prize);
      if (!res.ok && res.reason === "exists") {
        await interaction.reply({
          content: `You are already listening for: "${phrase}"`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!res.ok) {
        await interaction.reply({ content: "Invalid phrase.", flags: MessageFlags.Ephemeral });
        return;
      }

      await trySaveGuildToDb(guildId);

      await interaction.reply({
        content:
          `✅ Listening for: "${phrase}"` +
          (prize ? `\nPrize: ${prize}` : "") +
          `\nUse \`/whisper list\` to see your phrases.` +
          `\nFor reminders/notifications, use \`/notifyme\` or \`/remindme\`.`,
        flags: MessageFlags.Ephemeral,
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
          const createdAt = Number.isFinite(w.createdAt) ? w.createdAt : null;

          let msgOut =
            `🎉 Congratulations, you have found the hidden phrase "${phrase}" set by ${mention(ownerId)}!`;
          if (prize) msgOut += `\nYou have won: ${prize}`;
          const when = formatWhisperCreatedAt(createdAt);
          if (when) msgOut += `\n_Whisper set: ${when}_`;

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

export const __testables = {
  encryptPayload,
  decryptPayload,
  isEncryptedPayload,
  decodeStoredItems,
  getActiveKeyId,
  getWhisperKeyById,
};

export async function migrateWhispersToEncrypted() {
  const key = getWhisperKey();
  if (!key) return { ok: false, reason: "missing_key" };

  const db = getDb();
  const [rows] = await db.execute(
    `
    SELECT guild_id, text
    FROM user_texts
    WHERE kind = ? AND user_id = ?
  `,
    [WHISPER_KIND, WHISPER_USER_ID]
  );

  let migrated = 0;
  for (const row of rows || []) {
    const text = String(row?.text ?? "");
    const trimmed = text.trim();
    if (!trimmed || trimmed === "[]") continue;
    if (isEncryptedPayload(text)) continue;

    const encryptedText = encryptPayload(text);
    await setUserText({
      guildId: row.guild_id,
      userId: WHISPER_USER_ID,
      kind: WHISPER_KIND,
      text: encryptedText,
    });
    migrated += 1;
  }

  return { ok: true, migrated };
}
