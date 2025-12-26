// games/explodingVoltorbs.js

const activeGames = new Map();

const scareMessages = [
  "⚠️ The Voltorb is vibrating violently...",
  "💥 **CRITICAL WARNING** — energy spike detected!",
  "😰 Something feels very wrong...",
  "🔥 Voltorb temperature rising rapidly!",
  "💣 The fuse is crackling ominously...",
  "⚡ You hear a sharp electrical snap...",
  "💥 IT'S ABOUT TO— never mind.",
];

function startGame(message, rangeArg) {
  const guildId = message.guild.id;

  if (activeGames.has(guildId)) {
    message.reply("⚠️ A Voltorb game is already running!");
    return;
  }

  // ---- range parsing ----
  const DEFAULT_MIN = 30;
  const DEFAULT_MAX = 90;
  const MAX_ALLOWED = 600;

  let minSeconds = DEFAULT_MIN;
  let maxSeconds = DEFAULT_MAX;

  if (rangeArg) {
    const match = rangeArg.match(/^(\d+)-(\d+)$/);
    if (!match) {
      return message.reply("❌ Use `min-max` seconds (example: `30-90`)");
    }

    minSeconds = Number(match[1]);
    maxSeconds = Number(match[2]);

    if (minSeconds < 5 || maxSeconds > MAX_ALLOWED || minSeconds >= maxSeconds) {
      return message.reply(`❌ Range must be 5–${MAX_ALLOWED} seconds, min < max.`);
    }
  }

  const explodeDelay =
    (Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds) * 1000;

  const holderId = message.author.id;

  const explosionTimeout = setTimeout(() => {
    const game = activeGames.get(guildId);
    if (!game) return;

    message.channel.send(
      `💥 **BOOM!** <@${game.holderId}> was holding the Voltorb and got blown up!`
    );

    clearInterval(game.scareInterval);
    activeGames.delete(guildId);
  }, explodeDelay);

  const scareInterval = setInterval(() => {
    const game = activeGames.get(guildId);
    if (!game) return;

    if (Math.random() < 0.35) {
      const scare =
        scareMessages[Math.floor(Math.random() * scareMessages.length)];

      message.channel.send(
        `${scare}\n👀 <@${game.holderId}> is holding the Voltorb.`
      );
    }
  }, 8000);

  activeGames.set(guildId, {
    holderId,
    explosionTimeout,
    scareInterval,
  });

  message.channel.send(
    `⚡ **Exploding Voltorbs started!**\n` +
    `💣 <@${holderId}> is holding the Voltorb!\n` +
    `⏱️ Explosion time: **${minSeconds}–${maxSeconds} seconds**\n` +
    `😈 The bot may lie.`
  );
}

function passVoltorb(message) {
  const game = activeGames.get(message.guild.id);

  if (!game) {
    return message.reply("❌ There is no active Voltorb game.");
  }

  if (game.holderId !== message.author.id) {
    return message.reply("❌ You’re not holding the Voltorb!");
  }

  const target = message.mentions.users.first();
  if (!target) {
    return message.reply("❌ Mention someone to pass it to!");
  }

  if (target.bot) {
    return message.reply("🤖 Bots cannot hold Voltorbs.");
  }

  game.holderId = target.id;

  message.channel.send(
    `🔁 <@${message.author.id}> passed the Voltorb to <@${target.id}>!\n` +
    `💣 The ticking continues...`
  );
}

module.exports = {
  startGame,
  passVoltorb,
};
