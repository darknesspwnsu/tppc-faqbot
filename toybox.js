// toybox.js

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
