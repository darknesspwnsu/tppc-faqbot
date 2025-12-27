// games/explodingVoltorbs.js
//
// Exploding Voltorbs:
// - One game active per guild
// - Someone "holds" the Voltorb, can pass via mention
// - Explosion happens at a random time in a range
//
// Commands (registered via registerExplodingVoltorbs):
//   !ev [min-max]        -> start game (default 30-90)
//   !passvoltorb @user   -> pass to mentioned user
//   !endvoltorb          -> force-end (admin only by default in registry)

const activeGames = new Map(); // guildId -> { holderId, explosionTimeout, scareInterval }

const scareMessages = [
  "⚡ The Voltorb crackles ominously...",
  "💣 You hear an unsettling *tick... tick...*",
  "😈 The bot whispers: *it’s totally safe* (it isn’t).",
  "👀 Everyone stares at the Voltorb.",
  "🧨 The fuse looks... shorter than before."
];

function isAdminMember(message) {
  return (
    message.member?.permissions?.has("Administrator") ||
    message.member?.permissions?.has("ManageGuild")
  );
}

export function startExplodingVoltorbs(message, rangeArg) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  if (activeGames.has(guildId)) {
    message.reply("⚠️ A Voltorb game is already running!");
    return;
  }

  const DEFAULT_MIN = 30;
  const DEFAULT_MAX = 90;
  const MAX_ALLOWED = 600;

  let minSeconds = DEFAULT_MIN;
  let maxSeconds = DEFAULT_MAX;

  if (rangeArg) {
    const match = String(rangeArg).trim().match(/^(\d+)-(\d+)$/);
    if (!match) {
      message.reply("❌ Use `min-max` seconds (example: `30-90`)");
      return;
    }

    minSeconds = Number(match[1]);
    maxSeconds = Number(match[2]);

    if (
      !Number.isFinite(minSeconds) ||
      !Number.isFinite(maxSeconds) ||
      minSeconds < 5 ||
      maxSeconds > MAX_ALLOWED ||
      minSeconds >= maxSeconds
    ) {
      message.reply(`❌ Range must be 5–${MAX_ALLOWED} seconds, min < max.`);
      return;
    }
  }

  const explodeDelayMs =
    (Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds) * 1000;

  const holderId = message.author?.id;
  if (!holderId) return;

  const explosionTimeout = setTimeout(() => {
    const game = activeGames.get(guildId);
    if (!game) return;

    message.channel.send(`💥 **BOOM!** <@${game.holderId}> was holding the Voltorb and got blown up!`);

    clearInterval(game.scareInterval);
    activeGames.delete(guildId);
  }, explodeDelayMs);

  const scareInterval = setInterval(() => {
    const game = activeGames.get(guildId);
    if (!game) return;

    if (Math.random() < 0.35) {
      const scare = scareMessages[Math.floor(Math.random() * scareMessages.length)];
      message.channel.send(`${scare}\n👀 <@${game.holderId}> is holding the Voltorb.`);
    }
  }, 8000);

  activeGames.set(guildId, {
    holderId,
    explosionTimeout,
    scareInterval
  });

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
      `💣 <@${holderId}> is holding the Voltorb!\n` +
      `⏱️ Explosion time: **${minSeconds}–${maxSeconds} seconds**\n` +
      `😈 The bot may lie.`
  );
}

export function passVoltorb(message) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = activeGames.get(guildId);
  if (!game) {
    message.reply("❌ There is no active Voltorb game.");
    return;
  }

  if (game.holderId !== message.author?.id) {
    message.reply("❌ You’re not holding the Voltorb!");
    return;
  }

  const target = message.mentions?.users?.first?.();
  if (!target) {
    message.reply("❌ Mention someone to pass it to!");
    return;
  }

  if (target.bot) {
    message.reply("🤖 Bots cannot hold Voltorbs.");
    return;
  }

  game.holderId = target.id;

  message.channel.send(
    `🔁 <@${message.author.id}> passed the Voltorb to <@${target.id}>!\n` + `💣 The ticking continues...`
  );
}

export function endVoltorbGame(message, { reason = "ended" } = {}) {
  const guildId = message.guild?.id;
  if (!guildId) return;

  const game = activeGames.get(guildId);
  if (!game) {
    message.reply("❌ There is no active Voltorb game.");
    return;
  }

  clearTimeout(game.explosionTimeout);
  clearInterval(game.scareInterval);
  activeGames.delete(guildId);

  message.channel.send(`🧯 Voltorb game ${reason}.`);
}

/**
 * Command wiring for this game
 */
export function registerExplodingVoltorbs(register) {
  // Start
  register(
    "!ev",
    async ({ message, rest }) => {
      if (!message.guild) return;

      const rangeArg = rest
        ? rest.trim().replace(/s$/i, "")
        : null;

      startExplodingVoltorbs(message, rangeArg);
    },
    "!ev [min-max] — start Exploding Voltorbs (default 30-90s)",
    { aliases: ["!explodingvoltorbs", "!voltorb"] }
  );

  // Pass
  register(
    "!pass",
    async ({ message }) => {
      if (!message.guild) return;
      passVoltorb(message);
    },
    "!passvoltorb @user — pass the Voltorb (only holder can pass)",
    { aliases: ["!passv", "!pv", "!passvoltorb"] }
  );

  // End (admin-only)
  register(
    "!endvoltorb",
    async ({ message }) => {
      if (!message.guild) return;
      if (!isAdminMember(message)) {
        // keep it strict; you can loosen later to allow the current holder too
        await message.reply("Nope — only admins can end the Voltorb game.");
        return;
      }
      endVoltorbGame(message, { reason: "ended early" });
    },
    "!endvoltorb — force-end Exploding Voltorbs (admin)",
    { admin: true, aliases: ["!stopvoltorb"] }
  );
}
