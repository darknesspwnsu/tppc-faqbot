// games/explodingVoltorbs.js
//
// Exploding Voltorbs:
// - One game active per guild
// - Someone "holds" the Voltorb, can pass via mention
// - Explosion happens at a random time in a range
//
// Commands:
//   !ev [min-max] [@user1 @user2 ...] -> start game (default 30-90)
//   !passvoltorb @user               -> pass to a participant
//   !endvoltorb                      -> force-end (admin or starter only)

const activeGames = new Map(); // guildId -> { starterId, holderId, explosionTimeout, scareInterval, participants }

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

export function startExplodingVoltorbs(message, rangeArg, participants = []) {
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

  // 1️⃣ Validate range first
  if (rangeArg) {
    const match = rangeArg.replace(/s$/i, "").match(/^(\d+)-(\d+)$/);
    if (!match) {
      message.reply(
        "❌ Invalid range. Use `min-max` seconds (example: 10-20 or 10-20s)."
      );
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

  // 2️⃣ Require at least two participants AFTER range is validated
  if (participants.length < 2) {
    message.reply(
      "❌ You need at least **2 participants** to start the game.\n" +
      "Usage: `!ev [min-max] @Player1 @Player2 [@Player3 ...]`"
    );
    return;
  }

  // Pick random initial holder
  const holder = participants[Math.floor(Math.random() * participants.length)];
  if (holder.bot) {
    message.reply("❌ The bot can't hold the voltorb!");
    return;
  }

  if (!holder) {
    message.reply("❌ Invalid participant selected as initial holder.");
    return;
  }

  const explodeDelayMs =
    (Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds) * 1000;

  const explosionTimeout = setTimeout(() => {
    const game = activeGames.get(guildId);
    if (!game) return;

    message.channel.send(
      `💥 **BOOM!** <@${game.holderId}> was holding the Voltorb and got blown up!`
    );

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
    starterId: message.author.id,
    holderId: holder.id,
    explosionTimeout,
    scareInterval,
    participants: participants.map(u => u.id)
  });

  const mentionsText = participants.map(u => `<@${u.id}>`).join(", ");

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
      `💣 Participants: ${mentionsText}\n` +
      `💥 Initial holder: <@${holder.id}>\n` +
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
    return;
  }

  const target = message.mentions?.users?.first?.();
  if (!target) {
    message.reply("❌ Mention someone to pass it to!");
    return;
  }

  if (target.bot || !game.participants.includes(target.id)) {
    message.reply(`❌ <@${target.id}> is not a participant in this game.`);
    return;
  }

  game.holderId = target.id;

  message.channel.send(
    `🔁 <@${message.author.id}> passed the Voltorb to <@${target.id}>!\n💣 The ticking continues...`
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

export function registerExplodingVoltorbs(register) {
  // Start game
  register(
    "!ev",
    async ({ message, rest }) => {
      if (!message.guild) return;

      if (!rest) {
        message.reply(
          "❌ You must provide a range and participants.\n" +
          "Usage: `!ev [min-max] @Player1 @Player2 [@Player3 ...]`"
        );
        return;
      }

      const parts = rest.trim().split(/\s+/);
      let rangeArg = null;

      // detect min-max range first (optional trailing 's')
      const rangeMatch = parts[0].match(/^(\d+)-(\d+)s?$/i);
      if (rangeMatch) {
        rangeArg = parts.shift(); // remove from parts
      } else {
        message.reply(
          "❌ Invalid range. Use `min-max` seconds (example: 10-20 or 10-20s).\n" +
          "Usage: `!ev [min-max] @Player1 @Player2 [@Player3 ...]`"
        );
        return;
      }

      // parse mentions as participants
      const participants = message.mentions.users.map(u => u);
      if (participants.length < 2) {
        message.reply(
          "❌ You need at least **2 participants** to start the game.\n" +
          "Usage: `!ev [min-max] @Player1 @Player2 [@Player3 ...]`"
        );
        return;
      }

      startExplodingVoltorbs(message, rangeArg, participants);
    },
    "!ev [min-max] [@Player1 @Player2 ...] — start Exploding Voltorbs",
    { aliases: ["!explodingvoltorbs", "!voltorb"] }
  );

  // Pass Voltorb
  register(
    "!pass",
    async ({ message }) => {
      if (!message.guild) return;
      passVoltorb(message);
    },
    "!passvoltorb @user — pass the Voltorb (only holder can pass)",
    { aliases: ["!passv", "!pv", "!passvoltorb"] }
  );

  // End game (admin or starter)
  register(
    "!endvoltorb",
    async ({ message }) => {
      if (!message.guild) return;

      const game = activeGames.get(message.guild.id);
      if (!game) {
        await message.reply("❌ There is no active Voltorb game.");
        return;
      }

      if (!isAdminMember(message) && message.author.id !== game.starterId) {
        await message.reply("Nope — only admins or the starter can end the game early.");
        return;
      }

      endVoltorbGame(message, { reason: "ended early" });
    },
    "!endvoltorb — force-end Exploding Voltorbs (admin or starter)",
    { admin: true, aliases: ["!stopvoltorb"] }
  );
}
