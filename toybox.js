// toybox.js

import fs from "fs/promises";
import path from "path";
import { isAdminOrPrivileged } from "./auth.js";
import { logger } from "./shared/logger.js";

const M8BALL_CONFIG_PATH = path.resolve("configs", "m8ball_config.json");
const M8BALL_COOLDOWN_MS = 15_000;
let m8ballConfigCache = null;

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

async function loadM8BallConfig() {
  if (m8ballConfigCache) return m8ballConfigCache;

  try {
    const raw = await fs.readFile(M8BALL_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const responses = Array.isArray(parsed?.responses) ? parsed.responses : [];
    m8ballConfigCache = { responses };
  } catch (err) {
    logger.warn("toybox.m8ball.config_failed", { error: logger.serializeError(err) });
    m8ballConfigCache = { responses: [] };
  }

  return m8ballConfigCache;
}

async function buildM8BallReply(entry) {
  const content = `🎱 ${entry.text}`;
  if (!entry.file) return { content };

  const filePath = path.resolve(process.cwd(), entry.file);
  try {
    await fs.access(filePath);
    return {
      content,
      files: [
        {
          attachment: filePath,
          name: path.basename(filePath),
        },
      ],
    };
  } catch (err) {
    logger.warn("toybox.m8ball.asset_missing", {
      file: entry.file,
      error: logger.serializeError(err),
    });
    return { content };
  }
}

/* -------------------------------- registry -------------------------------- */

export function registerToybox(register) {
  const m8ballCooldowns = new Map();
  // ------------------------------- Bang: rig --------------------------------
  register(
    "!rig",
    async ({ message }) => {
      const uid = message.mentions?.users?.first?.()?.id ?? message.author.id;
      await message.channel.send(`${mention(uid)} has now been blessed by rngesus.`);
    },
    "!rig — bless someone with RNG",
    { aliases: ["!bless"] }
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
      if (target.id === message.author.id) {
        await message.reply("You can't slap yourself. Try someone else.");
        return;
      }

      await message.channel.send(
        `_${mention(message.author.id)} slaps ${mention(target.id)} around a bit with a large trout._`
      );
    },
    "!slap @user — slaps someone around with a large trout"
  );

  // ------------------------------ Bang: m8ball ------------------------------
  const handleM8Ball = async ({ message, rest }) => {
    const question = norm(rest);
    if (!question) {
      await message.reply("Usage: `!m8ball <question>`");
      return;
    }

    const bypassCooldown = isAdminOrPrivileged(message);
    const userId = message.author?.id;
    const now = Date.now();
    if (!bypassCooldown && userId) {
      const last = m8ballCooldowns.get(userId) || 0;
      if (now - last < M8BALL_COOLDOWN_MS) {
        const remaining = Math.ceil((M8BALL_COOLDOWN_MS - (now - last)) / 1000);
        await message.reply(`⚠️ This command is on cooldown for another ${remaining}s!`);
        return;
      }
      m8ballCooldowns.set(userId, now);
    }

    const config = await loadM8BallConfig();
    const responses = config.responses;
    if (!responses.length) {
      await message.reply("❌ No m8ball responses are configured yet.");
      return;
    }

    const pick = responses[Math.floor(Math.random() * responses.length)];
    const payload = await buildM8BallReply(pick);
    await message.reply(payload);
  };

  register.expose({
    logicalId: "toybox.m8ball",
    name: "m8ball",
    handler: handleM8Ball,
    help: "!m8ball <question> — ask the magic 8-ball",
    opts: { aliases: ["8ball"] },
  });

  /* ---------------------------- Passive listeners --------------------------- */
  // Keep ONLY the intbkty boot reaction listener here.

  register.listener(async ({ message }) => {
    try {
      if (!message || message.author?.bot) return;

      const content = norm(message.content);
      if (!content) return;

      const lower = lc(content);

      if (lower.includes("intbkty")) {
        try {
          await message.react("👢");
        } catch {
          // ignore react failures
        }
      }
    } catch {
      // keep passive listener failures isolated
    }
  });
}
