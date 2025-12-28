// toybox.js
import { getUserText, setUserText } from "./db.js";

/* ------------------------------- small helpers ------------------------------ */

function targetUser(message) {
  return message.mentions?.users?.first?.() ?? null;
}

function mention(id) {
  return `<@${id}>`;
}

function norm(s) {
  return String(s ?? "").trim();
}

function lc(s) {
  return String(s ?? "").toLowerCase();
}

/* ------------------------------ whisper storage ----------------------------- */

// We store all whispers for a guild under a sentinel "user_id" row.
// This makes scanning easy (one row read per guild).
const WHISPER_KIND = "whisper";
const WHISPER_USER_ID = "__guild__"; // sentinel

// In-memory fallback cache (also used as the live index)
const guildWhispers = new Map(); // guildId -> { loaded, items: [{ phrase, ownerId }], dbOk?: boolean }

function getGuildState(guildId) {
  if (!guildWhispers.has(guildId)) {
    guildWhispers.set(guildId, { loaded: false, items: [], dbOk: undefined });
  }
  return guildWhispers.get(guildId);
}

function serializeItems(items) {
  // Keep it simple + stable
  return JSON.stringify(
    (items || []).map((x) => ({
      phrase: String(x.phrase || ""),
      ownerId: String(x.ownerId || "")
    }))
  );
}

function deserializeItems(text) {
  try {
    const arr = JSON.parse(String(text || "[]"));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        phrase: norm(x?.phrase),
        ownerId: norm(x?.ownerId)
      }))
      .filter((x) => x.phrase && x.ownerId);
  } catch {
    return [];
  }
}

// Try DB, but never require it.
// If DB env vars are missing, or initDb wasn't run, or tables don't exist, etc. -> fallback.
async function tryLoadGuildFromDb(guildId) {
  const state = getGuildState(guildId);

  // If we already tried DB and it failed, don't spam.
  if (state.dbOk === false) return false;

  try {
    const t = await getUserText({ guildId, userId: WHISPER_USER_ID, kind: WHISPER_KIND });
    const items = deserializeItems(t);
    state.items = items;
    state.loaded = true;
    state.dbOk = true;
    return true;
  } catch {
    state.dbOk = false;
    // don't mark loaded here; we still want in-memory default
    return false;
  }
}

async function trySaveGuildToDb(guildId) {
  const state = getGuildState(guildId);
  if (state.dbOk === false) return false;

  try {
    await setUserText({
      guildId,
      userId: WHISPER_USER_ID,
      kind: WHISPER_KIND,
      text: serializeItems(state.items)
    });
    state.dbOk = true;
    return true;
  } catch {
    state.dbOk = false;
    return false;
  }
}

async function ensureGuildLoaded(guildId) {
  const state = getGuildState(guildId);
  if (state.loaded) return state;

  // Attempt DB first; if it fails, just use empty in-memory.
  const ok = await tryLoadGuildFromDb(guildId);
  if (!ok) {
    state.items = state.items || [];
    state.loaded = true;
  }
  return state;
}

function phraseKey(phrase) {
  // normalize for matching & dedupe
  return lc(norm(phrase));
}

function addWhisper(state, phrase, ownerId) {
  const p = norm(phrase);
  if (!p) return { ok: false, reason: "empty" };

  const key = phraseKey(p);
  const exists = state.items.some((x) => phraseKey(x.phrase) === key && x.ownerId === ownerId);
  if (exists) return { ok: false, reason: "exists" };

  state.items.push({ phrase: p, ownerId });
  return { ok: true };
}

function listWhispersForUser(state, ownerId) {
  return state.items.filter((x) => x.ownerId === ownerId);
}

/* -------------------------------- registry -------------------------------- */

export function registerToybox(register) {
  // ------------------------------- Bang: rig --------------------------------
  register(
    "!rig",
    async ({ message }) => {
      const uid = message.mentions?.users?.first?.()?.id ?? message.author.id;
      await message.channel.send(`${mention(uid)} has now been blessed by rngesus.`);
    },
    "!rig — bless someone with RNG"
  );

  // ------------------------------ Bang: curse -------------------------------
  register(
    "!curse",
    async ({ message }) => {
      const target = targetUser(message);

      if (!target) {
        await message.reply("You must curse someone else (mention a user).");
        return;
      }
      if (target.id === message.author.id) {
        await message.reply("You can't curse yourself. Why would you want to do that?");
        return;
      }

      await message.channel.send(`${mention(target.id)} is now cursed by rngesus.`);
    },
    "!curse @user — curse someone with anti-RNG"
  );

  // ------------------------------- Bang: slap -------------------------------
  register(
    "!slap",
    async ({ message }) => {
      const target = targetUser(message);
      if (!target) {
        await message.reply("Usage: `!slap @user`");
        return;
      }

      await message.channel.send(
        `_${mention(message.author.id)} slaps ${mention(target.id)} around a bit with a large trout._`
      );
    },
    "!slap @user — slaps someone around with a large trout"
  );

  // ------------------------------ Slash: whisper ----------------------------
  register.slash(
    {
      name: "whisper",
      description: "Register a magic phrase to listen for (private to you)",
      options: [
        {
          type: 3, // STRING
          name: "phrase",
          description: "The phrase to listen for",
          required: true
        }
      ]
    },
    async ({ interaction }) => {
      const guildId = interaction.guild?.id;
      if (!guildId) {
        await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
        return;
      }

      const phrase = norm(interaction.options?.getString?.("phrase"));
      const ownerId = interaction.user?.id;

      if (!phrase) {
        await interaction.reply({ content: "Please provide a phrase.", ephemeral: true });
        return;
      }

      const state = await ensureGuildLoaded(guildId);

      const res = addWhisper(state, phrase, ownerId);
      if (!res.ok && res.reason === "exists") {
        await interaction.reply({
          content: `You are already listening for: "${phrase}"`,
          ephemeral: true
        });
        return;
      }
      if (!res.ok) {
        await interaction.reply({ content: "Invalid phrase.", ephemeral: true });
        return;
      }

      // Best-effort persist; if DB isn't available, it just stays in memory.
      await trySaveGuildToDb(guildId);

      await interaction.reply({
        content: `✅ Listening for: "${phrase}"\nUse \`/listwhispers\` to see your phrases.`,
        ephemeral: true
      });
    }
  );

  // --------------------------- Slash: listwhispers --------------------------
  register.slash(
    {
      name: "listwhispers",
      description: "List the magic phrases you are listening for (private)"
    },
    async ({ interaction }) => {
      const guildId = interaction.guild?.id;
      if (!guildId) {
        await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
        return;
      }

      const ownerId = interaction.user?.id;
      const state = await ensureGuildLoaded(guildId);

      const mine = listWhispersForUser(state, ownerId);
      if (!mine.length) {
        await interaction.reply({ content: "You have no active whispers in this server.", ephemeral: true });
        return;
      }

      const lines = mine
        .map((x, i) => `${i + 1}. "${x.phrase}"`)
        .slice(0, 50);

      const extra = mine.length > 50 ? `\n…plus ${mine.length - 50} more.` : "";

      await interaction.reply({
        content: `Your whispers in **${interaction.guild?.name ?? "this server"}**:\n${lines.join("\n")}${extra}`,
        ephemeral: true
      });
    }
  );

  /* ---------------------------- Passive listeners --------------------------- */

  register.listener(async ({ message }) => {
    try {
      // Ignore bots / system
      if (!message || message.author?.bot) return;

      const guildId = message.guild?.id;
      if (!guildId) return;

      const content = norm(message.content);
      if (!content) return;

      const lower = lc(content);

      // 1) intbkty boot reaction listener
      if (lower.includes("intbkty")) {
        try {
          await message.react("👢");
        } catch {
          // ignore react failures (missing perms / already reacted / etc.)
        }
      }

      // 2) whisper phrase listener
      const state = await ensureGuildLoaded(guildId);
      if (!state.items.length) return;

      // Cheap short-circuit: if the message is very short, still fine; just scan.
      for (const w of state.items) {
        const p = phraseKey(w.phrase);
        if (!p) continue;

        // Simple contains match (case-insensitive)
        if (lower.includes(p)) {
          const ownerId = w.ownerId;
          const speakerId = message.author?.id;

          // Avoid pinging the owner if they triggered their own phrase, if you want:
          // (comment out if you DO want self-triggers)
          // if (ownerId && speakerId && ownerId === speakerId) continue;
          await message.reply({
            content: `🎉 Congratulations, you have found the magic phrase set by ${mention(ownerId)}!`,
            allowedMentions: { users: [ownerId] }
          });

        }
      }
    } catch {
      // Keep passive listener failures isolated
    }
  });
}
