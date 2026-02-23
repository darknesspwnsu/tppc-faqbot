// contests/rng.js
//
// RNG utilities (exposed per guild):
// - !/?roll, !/?choose, !/?elim
// - ?cancelelim (hidden)
// - !awesome, !coinflip (legacy)
import { isAdminOrPrivileged } from "../auth.js";
import { onAwesomeRoll } from "../games/closest_roll_wins.js";
import { startTimeout, clearTimer } from "../shared/timer_utils.js";
import fs from "node:fs/promises";
import path from "node:path";

// guildId -> { timeout, channelId, creatorId }
const activeElimByGuild = new Map();
const DEFAULT_DEX_ROLL_MAX = 721;
const DEX_GEN_RANGES = {
  1: [1, 151],
  2: [152, 251],
  3: [252, 386],
  4: [387, 493],
  5: [494, 649],
  6: [650, 721],
  7: [722, 809],
  8: [810, 898],
};
const POKEDEX_MAP_PATH = path.resolve("data/pokedex_map.json");

let dexRollById = null; // Map<dexId, speciesName>
let dexRollIds = null; // number[] sorted asc

function randIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function parsePositiveInt(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

function parsePokedexKey(keyRaw) {
  const [idRaw, formRaw] = String(keyRaw || "").split("-");
  const id = Number(idRaw);
  const form = formRaw === undefined ? 0 : Number(formRaw);
  return { id, form };
}

async function loadDexRollMap() {
  if (dexRollById && dexRollIds) return { byId: dexRollById, ids: dexRollIds };

  const raw = await fs.readFile(POKEDEX_MAP_PATH, "utf8");
  const map = JSON.parse(raw);
  const byId = new Map();

  for (const [name, key] of Object.entries(map || {})) {
    const { id, form } = parsePokedexKey(key);
    if (!Number.isInteger(id) || id < 1) continue;
    const existing = byId.get(id);
    if (!existing || form === 0) {
      byId.set(id, name);
    }
  }

  const ids = Array.from(byId.keys()).sort((a, b) => a - b);

  dexRollById = byId;
  dexRollIds = ids;
  return { byId, ids };
}

function targetUserId(message) {
  const first = message.mentions?.users?.first?.();
  return first?.id ?? message.author.id;
}

function mention(id) {
  return `<@${id}>`;
}

export function parseSecondsToMs(raw) {
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
export async function runElimFromItems({
  message,
  delayMs,
  delaySec,
  items,
  winnerSuffix = "",
  itemLabel = null,
  winnerLabel = null,
}) {
  if (!message.guild) return { ok: false, error: "No guild." };

  const guildId = message.guildId;
  if (activeElimByGuild.has(guildId)) {
    return { ok: false, error: "An elimination is already running in this server." };
  }

  let remaining = (items || []).slice().filter(Boolean);
  const toLabel = typeof itemLabel === "function" ? itemLabel : (item) => String(item);
  const toWinner = typeof winnerLabel === "function" ? winnerLabel : toLabel;
  if (remaining.length < 2) {
    return { ok: false, error: "You need at least 2 items to run an elimination." };
  }

  await message.channel.send(`Setting up elimination with ${delaySec}s between rounds... are you ready?`);

  const finish = async () => {
    const st = activeElimByGuild.get(guildId);
    clearTimer(st?.timeout, `rng.elim:${guildId}`);
    activeElimByGuild.delete(guildId);

    if (remaining.length === 1) {
      const suffix = winnerSuffix ? ` ${winnerSuffix}` : "";
      await message.channel.send(`${toWinner(remaining[0])} wins!${suffix}`);
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
      `${toLabel(eliminated)} has been eliminated! Remaining: ${remaining.map(toLabel).join(", ")}\n______________________`
    );

    if (remaining.length === 1) {
      await finish();
      return;
    }

    const t = startTimeout({
      label: `rng.elim.round:${guildId}`,
      ms: delayMs,
      fn: runRound,
    });
    const st = activeElimByGuild.get(guildId);
    if (st) st.timeout = t;
  };

  // Acquire lock
  activeElimByGuild.set(guildId, { timeout: null, channelId: message.channelId, creatorId: message.author.id });

  // Start (first elimination after delayMs)
  const t0 = startTimeout({
    label: `rng.elim.round:${guildId}`,
    ms: delayMs,
    fn: runRound,
  });
  activeElimByGuild.set(guildId, { timeout: t0, channelId: message.channelId, creatorId: message.author.id });

  return { ok: true };
}

export function registerRng(register) {
  // ------------------------------ ?roll / !roll (exposed per guild) ------------------------------
  const handleRoll = async ({ message, rest }) => {
    const arg = rest.trim();
    const m = /^(\d+)d(\d+)(?:\s+(norepeat|nr))?$/i.exec(arg);

    if (!m) {
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    const noRepeat = !!m[3];
    const n = Number(m[1]);
    const sides = Number(m[2]);

    if (!Number.isInteger(n) || !Number.isInteger(sides) || n < 1 || sides < 1) {
      await message.channel.send("Invalid format. Please use a format like `1d100`");
      return;
    }

    if (noRepeat && n > sides) {
      await message.channel.send(
        `Impossible with norepeat: you asked for ${n} unique rolls but range is only 1..${sides} (${sides} unique values).`
      );
      return;
    }

    const uid = targetUserId(message);
    let rolls;

    if (!noRepeat) {
      rolls = Array.from({ length: n }, () => randIntInclusive(1, sides));
    } else {
      const rangeSize = sides;

      if (n > rangeSize * 0.6) {
        const arr = Array.from({ length: rangeSize }, (_, i) => i + 1);
        for (let i = 0; i < n; i++) {
          const j = randIntInclusive(i, rangeSize - 1);
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
        rolls = arr.slice(0, n);
      } else {
        const seen = new Set();
        while (seen.size < n) seen.add(randIntInclusive(1, sides));
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
  };

  register.expose({
    logicalId: "rng.roll",
    name: "roll",
    handler: handleRoll,
    help: "?roll NdM — rolls N numbers from 1..M (example: ?roll 1d100)",
  });

  // ------------------------------ ?dexroll / !dexroll (exposed per guild) ------------------------------
  const handleDexRoll = async ({ message, rest, cmd }) => {
    const baseCmd = String(cmd || "!dexroll").trim() || "!dexroll";
    const usage =
      `Usage: \`${baseCmd}\` | \`${baseCmd} <upper>\` | ` +
      `\`${baseCmd} <lower> <upper>\` | \`${baseCmd} gen <1-8>\``;
    const args = String(rest || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    let dexData;
    try {
      dexData = await loadDexRollMap();
    } catch (err) {
      console.error("[rng] failed to load pokedex map for dexroll:", err);
      await message.channel.send("Failed to load Pokedex data. Please try again later.");
      return;
    }

    const maxSupported = dexData.ids[dexData.ids.length - 1] || 0;
    if (maxSupported < 1) {
      await message.channel.send("No Pokedex entries are available for dexroll.");
      return;
    }

    let lower = 1;
    let upper = Math.min(DEFAULT_DEX_ROLL_MAX, maxSupported);

    if (args.length === 0) {
      // default range already set above
    } else if (args.length === 1) {
      if (String(args[0]).toLowerCase() === "gen") {
        await message.channel.send(usage);
        return;
      }
      const parsedUpper = parsePositiveInt(args[0]);
      if (!parsedUpper) {
        await message.channel.send(usage);
        return;
      }
      upper = Math.min(maxSupported, parsedUpper);
    } else if (args.length === 2) {
      if (String(args[0]).toLowerCase() === "gen") {
        const gen = parsePositiveInt(args[1]);
        const range = gen ? DEX_GEN_RANGES[gen] : null;
        if (!range) {
          await message.channel.send(usage);
          return;
        }
        lower = range[0];
        upper = Math.min(maxSupported, range[1]);
      } else {
        const parsedLower = parsePositiveInt(args[0]);
        const parsedUpper = parsePositiveInt(args[1]);
        if (!parsedLower || !parsedUpper) {
          await message.channel.send(usage);
          return;
        }
        lower = parsedLower;
        upper = Math.min(maxSupported, parsedUpper);
      }
    } else {
      await message.channel.send(usage);
      return;
    }

    if (lower > upper) {
      await message.channel.send(`Invalid dex range: ${lower}-${upper}.`);
      return;
    }

    const candidates = dexData.ids.filter((id) => id >= lower && id <= upper);
    if (!candidates.length) {
      await message.channel.send(`No Pokemon found in dex range ${lower}-${upper}.`);
      return;
    }

    const pickedDexId = candidates[randIntInclusive(0, candidates.length - 1)];
    const pickedName = dexData.byId.get(pickedDexId);
    if (!pickedName) {
      await message.channel.send("Failed to resolve rolled Pokedex entry. Please try again.");
      return;
    }

    await message.channel.send(`#${pickedDexId} - ${pickedName}`);
  };

  register.expose({
    logicalId: "rng.dexroll",
    name: "dexroll",
    handler: handleDexRoll,
    help: "?dexroll [upper] | [lower upper] | gen <1-8> — rolls a Pokemon dex number",
  });

  // ------------------------------ ?choose / !choose (exposed per guild) ------------------------------
  const handleChoose = async ({ message, rest, cmd }) => {
    const options = rest.trim().split(/\s+/).filter(Boolean);
    if (options.length < 1) {
      const baseCmd = String(cmd || "?choose").trim() || "?choose";
      await message.channel.send(`Usage: \`${baseCmd} option1 option2 ...\``);
      return;
    }
    const pick = chooseOne(options);
    await message.channel.send(pick);
  };

  register.expose({
    logicalId: "rng.choose",
    name: "choose",
    handler: handleChoose,
    help: "?choose a b c — randomly chooses one option",
  });

  // ------------------------------ ?elim / !elim (exposed per guild) ------------------------------
  const handleElim = async ({ message, rest, cmd }) => {
    if (!message.guild) return;

    const parts = rest.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      const baseCmd = String(cmd || "?elim").trim() || "?elim";
      await message.reply(`Usage: \`${baseCmd} <seconds> <item1> <item2> [...]\``);
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
  };

  register.expose({
    logicalId: "rng.elim",
    name: "elim",
    handler: handleElim,
    help: "?elim <1–30s> <items...> — randomly eliminates one item per round",
  });

  // ------------------------------ ?cancelelim (unchanged; still hidden) ------------------------------
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

      clearTimer(state.timeout, `rng.elim:${message.guildId}`);

      activeElimByGuild.delete(message.guildId);
      await message.channel.send("Elimination has been cancelled!");
    },
    "?cancelelim — cancels the currently running elimination",
    { aliases: ["?stopelim", "?endelim"], hideFromHelp: true }
  );

  // ------------------------------ !awesome / ?awesome (exposed per guild) ------------------------------
  const handleAwesome = async ({ message }) => {
    const uid = targetUserId(message);
    const x = randIntInclusive(0, 101);
    await message.channel.send(`${mention(uid)} is ${x}% awesome!`);

    // ClosestRollWins integration
    try { await onAwesomeRoll(message, x); } catch {}
  };

  register.expose({
    logicalId: "rng.awesome",
    name: "awesome",
    handler: handleAwesome,
    help: "!awesome — tells you how awesome someone is (0–101%)",
    opts: { aliases: ["a"] }, // keep existing alias behavior on the ! side
  });

  // ------------------------------ !coinflip (unchanged) ------------------------------
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
