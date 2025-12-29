// contests/rng.js
import { isAdminOrPrivileged } from "../auth.js";
import { onAwesomeRoll } from "../games/closest_roll_wins.js";

// guildId -> { timeout, channelId, creatorId }
const activeElimByGuild = new Map();

// Channel allowlist for specific commands
// guildId -> array of allowed channelIds
const AWESOME_CHANNELS = {
  "329934860388925442": ["331114564966154240", "551243336187510784"],
};

function isAllowedChannel(message, allowedIds) {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) return true;
  const cid = message?.channelId;
  return !!cid && allowedIds.includes(cid);
}

function randIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function targetUserId(message) {
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}

function mention(id) {
  return `<@${id}>`;
}

function parseSecondsToMs(raw) {
  const s = (raw ?? "").trim().toLowerCase();
  const m = /^(\d+)\s*s$/.exec(s);
  if (!m) return { error: "Delay must be specified in seconds, e.g. `2s` (1s–30s)." };

  const seconds = Number(m[1]);
  if (!Number.isInteger(seconds)) return { error: "Delay must be a whole number of seconds." };
  if (seconds < 1) return { error: "Delay must be at least 1 second." };
  if (seconds > 30) return { error: "Delay cannot exceed 30 seconds." };
  return { ms: seconds * 1000, seconds };
}

export function chooseOne(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return null;
  return a[randIntInclusive(0, a.length - 1)];
}

/**
 * Shared elimination runner (so reaction_contests can reuse it).
 * items are strings (usernames, IDs, whatever you want to print).
 */
export async function runElimFromItems({ message, delayMs, delaySec, items }) {
  if (!message.guild) return { ok: false, error: "No guild." };

  const guildId = message.guildId;
  if (activeElimByGuild.has(guildId)) {
    return { ok: false, error: "An elimination is already running in this server." };
  }

  let remaining = (items || []).slice().filter(Boolean);
  if (remaining.length < 2) {
    return { ok: false, error: "You need at least 2 items to run an elimination." };
  }

  await message.channel.send(`Setting up elimination with ${delaySec}s between rounds... are you ready?`);

  const finish = async () => {
    const st = activeElimByGuild.get(guildId);
    if (st?.timeout) {
      try { clearTimeout(st.timeout); } catch {}
    }
    activeElimByGuild.delete(guildId);

    if (remaining.length === 1) {
      await message.channel.send(`${remaining[0]} wins!`);
    } else {
      await message.channel.send("Elimination ended with no winner.");
    }
  };

  const runRound = async () => {
    if (!message.channel) return;

    if (remaining.length === 1) {
      await finish();
      return;
    }

    const idx = Math.floor(Math.random() * remaining.length);
    const eliminated = remaining.splice(idx, 1)[0];

    await message.channel.send(
      `${eliminated} has been eliminated! Remaining: ${remaining.join(", ")}\n______________________`
    );

    if (remaining.length === 1) {
      await finish();
      return;
    }

    const t = setTimeout(runRound, delayMs);
    const st = activeElimByGuild.get(guildId);
    if (st) st.timeout = t;
  };

  // Acquire lock
  activeElimByGuild.set(guildId, { timeout: null, channelId: message.channelId, creatorId: message.author.id });

  // Start (first elimination after delayMs)
  const t0 = setTimeout(runRound, delayMs);
  activeElimByGuild.set(guildId, { timeout: t0, channelId: message.channelId, creatorId: message.author.id });

  return { ok: true };
}

export function registerRng(register) {
  register(
    "?roll",
    async ({ message, rest }) => {
      const arg = rest.trim();
      const m = /^(\d+)d(\d+)(?:\s+(norepeat|nr))?$/i.exec(arg);

      if (!m) {
        await message.channel.send("Invalid format. Please use a format like `1d100`");
        return;
      }

      const noRepeat = !!m[3];
      const n = Number(m[1]);
      const sides = Number(m[2]);

      if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 0) {
        await message.channel.send("Invalid format. Please use a format like `1d100`");
        return;
      }

      if (noRepeat && n > (sides + 1)) {
        await message.channel.send(
          `Impossible with norepeat: you asked for ${n} unique rolls but range is only 0..${sides} (${sides + 1} unique values).`
        );
        return;
      }

      const uid = targetUserId(message);
      let rolls;

      if (!noRepeat) {
        rolls = Array.from({ length: n }, () => randIntInclusive(0, sides));
      } else {
        const rangeSize = sides + 1;

        if (n > rangeSize * 0.6) {
          const arr = Array.from({ length: rangeSize }, (_, i) => i);
          for (let i = 0; i < n; i++) {
            const j = randIntInclusive(i, rangeSize - 1);
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
          }
          rolls = arr.slice(0, n);
        } else {
          const seen = new Set();
          while (seen.size < n) seen.add(randIntInclusive(0, sides));
          rolls = Array.from(seen);
        }
      }

      const suffix = noRepeat ? " (norepeat mode: ON)" : "";
      const out = `${mention(uid)} ${rolls.join(", ")}${suffix}`;

      if (out.length > 1900) {
        await message.channel.send(
          `${mention(uid)} Rolled ${n}d${sides}${noRepeat ? " norepeat" : ""}. Output too long to display (${out.length} chars). Try a smaller N.`
        );
        return;
      }

      await message.channel.send(out);
    },
    "?roll NdM — rolls N numbers from 0..M (example: ?roll 1d100)"
  );

  register(
    "?choose",
    async ({ message, rest }) => {
      const options = rest.trim().split(/\s+/).filter(Boolean);
      if (options.length < 1) {
        await message.channel.send("Usage: `?choose option1 option2 ...`");
        return;
      }
      const pick = chooseOne(options);
      await message.channel.send(pick);
    },
    "?choose a b c — randomly chooses one option"
  );

  register(
    "?elim",
    async ({ message, rest }) => {
      if (!message.guild) return;

      const parts = rest.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 3) {
        await message.reply("Usage: `?elim <seconds> <item1> <item2> [...]`");
        return;
      }

      const delayRaw = parts[0];
      const parsed = parseSecondsToMs(delayRaw);
      if (parsed.error) {
        await message.reply(parsed.error);
        return;
      }

      const delayMs = parsed.ms;
      const delaySec = parsed.seconds;

      const remaining = parts.slice(1);
      const res = await runElimFromItems({ message, delayMs, delaySec, items: remaining });
      if (!res.ok) await message.reply(res.error);
    },
    "?elim <1–30s> <items...> — randomly eliminates one item per round"
  );

  register(
    "?cancelelim",
    async ({ message }) => {
      if (!message.guildId) return;

      const state = activeElimByGuild.get(message.guildId);
      if (!state) {
        await message.reply("No elimination is currently running.");
        return;
      }

      if (!isAdminOrPrivileged(message) && message.author.id !== state.creatorId) {
        await message.reply("Only the elimination starter or an admin can cancel it.");
        return;
      }

      if (state.timeout) {
        try { clearTimeout(state.timeout); } catch {}
      }

      activeElimByGuild.delete(message.guildId);
      await message.channel.send("Elimination has been cancelled!");
    },
    "?cancelelim — cancels the currently running elimination",
    { aliases: ["?stopelim", "?endelim"] }
  );

  register(
    "!awesome",
    async ({ message }) => {
      const allowed = AWESOME_CHANNELS[String(message.guildId)] || [];
      if (!isAllowedChannel(message, allowed)) {
        console.log(`[AWESOME] blocked in ${message.guildId}/${message.channelId}`);
        return;
      }

      const uid = targetUserId(message);
      const x = randIntInclusive(0, 101);
      await message.channel.send(`${mention(uid)} is ${x}% awesome!`);

      // ClosestRollWins integration
      try { await onAwesomeRoll(message, x); } catch {}
    },
    "!awesome — tells you how awesome someone is (0–101%)",
    { aliases: ["!a"] }
  );

  register(
    "!coinflip",
    async ({ message }) => {
      const uid = targetUserId(message);
      const roll = Math.random();

      let result;
      if (roll < 0.005) {
        const sideMessages = [
          "🪙 landed on its side! Physics is confused.",
          "🪙 balanced perfectly on its edge. RNGesus is watching.",
          "🪙 landed on its side. Buy a lottery ticket.",
          "🪙 stands upright. Reality briefly glitches.",
        ];
        result = sideMessages[Math.floor(Math.random() * sideMessages.length)];
      } else if (roll < 0.5025) {
        result = "Heads!";
      } else {
        result = "Tails!";
      }

      await message.channel.send(`${mention(uid)} ${result}`);
    },
    "!coinflip — flips a coin (Heads/Tails)",
    { aliases: ["!flip", "!coin"] }
  );
}
