// games/closest_roll_wins.js
//
// ClosestRollWins
// - !closestroll [target] [timelimit] (alias: !cr)
// - !awesome (only counted while active)
// - !endclosestroll (admin or starter) => ends + announces winner
// - !cancelclosestroll (admin or starter) => cancels, no winner
//
// Aliases preserved:
// - !endclosest => alias for !endclosestroll
// - !cancelclosest => alias for !cancelclosestroll
//
// One active contest per guild, bound to the channel it started in.

import {
  channelMention,
  createGameManager,
  makeGameQoL,
  mention,
  reply,
  requireCanManage,
  requireSameChannel,
  withGameSubcommands,
} from "./framework.js";

const manager = createGameManager({ id: "closestroll", prettyName: "ClosestRoll", scope: "guild" });

const MIN = 0;
const MAX = 101;

function clampInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || !Number.isInteger(x)) return null;
  return x;
}

function parseDurationMs(token) {
  const s = String(token ?? "").trim().toLowerCase();
  if (!s) return null;

  const m = s.match(/^(\d+)\s*([a-z]+)?$/);
  if (!m) return null;

  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;

  const unitRaw = (m[2] || "s").trim();

  const unit =
    unitRaw === "s" || unitRaw === "sec" || unitRaw === "secs" || unitRaw === "second" || unitRaw === "seconds"
      ? "s"
      : unitRaw === "m" || unitRaw === "min" || unitRaw === "mins" || unitRaw === "minute" || unitRaw === "minutes"
      ? "m"
      : unitRaw === "h" || unitRaw === "hr" || unitRaw === "hrs" || unitRaw === "hour" || unitRaw === "hours"
      ? "h"
      : null;

  if (!unit) return null;

  const mult = unit === "h" ? 3600_000 : unit === "m" ? 60_000 : 1000;
  return num * mult;
}

function randIntInclusive(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatTimeLeftMs(ms) {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.ceil(m / 60);
  return `${h}h`;
}

function helpText() {
  return (
    "**ClosestRoll help**\n" +
    "`!cr [target 0-101] [timeLimit]` — start\n" +
    "Aliases: `!closestroll`, `!cr`\n" +
    "Time formats: `30`, `30s`, `30sec`, `30seconds`, `5m`, `1h`\n" +
    "`!awesome` — roll (only counts while active, in this channel)\n" +
    "`!endclosest` / `!endclosestroll` — end early (admin/starter)\n" +
    "`!cancelclosest` / `!cancelclosestroll` — cancel (admin/starter)"
  );
}

export const __testables = {
  clampInt,
  parseDurationMs,
  randIntInclusive,
  formatTimeLeftMs,
};

function rulesText() {
  return (
    "**ClosestRoll — Rules (layman)**\n" +
    "A secret target number (0–101) is chosen.\n" +
    "Everyone rolls using `!awesome`.\n" +
    "The roll closest to the target wins.\n" +
    "If someone rolls the exact target, the game ends instantly.\n" +
    "Optionally, the host can set a time limit (example: `5m`)."
  );
}

const CRW_HELP = helpText();
const CRW_RULES = rulesText();

async function sendToGameChannel(st, content, channelOverride = null) {
  const ch =
    channelOverride ||
    st?.client?.channels?.cache?.get?.(st.channelId) ||
    (st?.client?.channels?.fetch ? await st.client.channels.fetch(st.channelId).catch(() => null) : null);

  if (!ch?.send) return false;
  await ch.send(content);
  return true;
}

async function endWithWinner(st, reason, channelOverride = null) {
  // Stop first to clear timers & state (we keep using local `st`)
  manager.stop({ guildId: st.guildId });

  if (!st.best) {
    await sendToGameChannel(
      st,
      `🏁 **ClosestRoll ended** (${reason}).\n` +
        `Target: **${st.target}**\n` +
        `No valid \`!awesome\` rolls were recorded.`,
      channelOverride
    );
    return;
  }

  const b = st.best;
  await sendToGameChannel(
    st,
    `🏁 **ClosestRoll ended** (${reason}).\n` +
      `Host: ${mention(st.creatorId)}\n` +
      `Target: **${st.target}**\n` +
      `Winner: ${mention(b.userId)} with **${b.roll}** (diff **${b.diff}**)`,
    channelOverride
  );
}

async function cancelNoWinner(st, reason, channelOverride = null) {
  manager.stop({ guildId: st.guildId });

  await sendToGameChannel(
    st,
    `🛑 **ClosestRoll cancelled** (${reason}).\n` +
      `Host: ${mention(st.creatorId)}\n` +
      `Target: **${st.target}**\n` +
      `No winner will be announced.`,
    channelOverride
  );
}

function maybeExpired(st) {
  if (!st?.endsAtMs) return false;
  return Date.now() >= st.endsAtMs;
}

// Called by the global "!awesome" handler (only counts while active)
export async function onAwesomeRoll(message, roll) {
  if (!message?.guildId) return;

  const st = manager.getState({ message, guildId: message.guildId });
  if (!st) return;

  // Only monitor the channel the contest started in
  if (message.channelId !== st.channelId) return;

  // If time expired, end now before counting
  if (maybeExpired(st)) {
    await endWithWinner(st, "time limit expired", message.channel);
    return;
  }

  const diff = Math.abs(roll - st.target);
  const now = Date.now();

  if (!st.best || diff < st.best.diff) {
    st.best = { userId: message.author.id, roll, diff, atMs: now };
  }

  if (diff === 0) {
    await endWithWinner(st, "exact hit", message.channel);
  }
}

// ---------- Main registration ----------

export function registerClosestRollWins(register) {
  makeGameQoL(register, {
    manager,
    id: "closestroll",
    prettyName: "ClosestRoll",
    helpText: CRW_HELP,
    rulesText: CRW_RULES,
    renderStatus: (st) => {
      const timeLine =
        st.endsAtMs ? `Time left: **${formatTimeLeftMs(st.endsAtMs - Date.now())}**` : `Time limit: *(none)*`;
      const bestLine = st.best
        ? `Best so far: ${mention(st.best.userId)} rolled **${st.best.roll}** (diff **${st.best.diff}**)`
        : "Best so far: *(none)*";

      return (
        `🎯 **ClosestRoll is running** in ${channelMention(st.channelId)}\n` +
        `Target: **${st.target}**\n` +
        `${timeLine}\n` +
        `${bestLine}`
      );
    },
    cancel: async (st) => cancelNoWinner(st, "cancelled"),
    end: async (st) => endWithWinner(st, "ended early"),
  });

  async function startClosestRoll({ message, rest }) {
    if (!message.guildId) return;

    const tokens = String(rest ?? "").trim().split(/\s+/).filter(Boolean);

    const res = manager.tryStart(
      { message, guildId: message.guildId, channelId: message.channelId },
      {
        guildId: message.guildId,
        channelId: message.channelId,
        creatorId: message.author.id,
        client: message.client,
        target: null,
        endsAtMs: null,
        best: null,
      }
    );

    if (!res.ok) {
      // keep old-style message
      const existing = manager.getState({ message, guildId: message.guildId });
      if (existing) {
        await message.reply(`⚠️ A ClosestRoll is already running.\nStarted by ${mention(existing.creatorId)} in ${channelMention(existing.channelId)}`);
        return;
      }
      await message.reply(res.errorText);
      return;
    }

    const st = res.state;

    let target = null;
    let timeMs = null;

    if (tokens[0]) {
      const t0 = clampInt(tokens[0]);
      if (t0 !== null) target = t0;
      else {
        manager.stop({ guildId: message.guildId });
        await message.reply(
          `❌ Invalid target number.\n` +
            `Usage: \`!closestroll [0-101] [timeLimit]\` e.g. \`!cr 42 5m\` or \`!cr\` (no target).\n` +
            `Time limit formats: \`30s\`, \`5m\`, \`1h\`, or plain seconds like \`120\`.`
        );
        return;
      }
    }

    if (tokens[1]) {
      timeMs = parseDurationMs(tokens[1]);
      if (!timeMs) {
        manager.stop({ guildId: message.guildId });
        await message.reply(`❌ Invalid time limit.\nUse \`30s\`, \`5m\`, \`1h\`, or plain seconds like \`120\`.`);
        return;
      }
    }

    if (target === null) target = randIntInclusive(MIN, MAX);

    if (target < MIN || target > MAX) {
      manager.stop({ guildId: message.guildId });
      await message.reply(`❌ Target must be between **${MIN}** and **${MAX}** (inclusive).`);
      return;
    }

    const now = Date.now();
    const endsAtMs = timeMs ? now + timeMs : null;

    st.target = target;
    st.endsAtMs = endsAtMs;

    if (endsAtMs) {
      st.timers.setTimeout(async () => {
        const live = manager.getState({ guildId: st.guildId });
        if (!live) return;
        await endWithWinner(live, "time limit expired");
      }, timeMs);
    }

    const timeLine = endsAtMs ? `Time limit: **${formatTimeLeftMs(endsAtMs - now)}**` : `Time limit: *(none)*`;

    await message.channel.send(
      `🎯 **ClosestRoll started!**\n` +
        `Target number: **${target}**\n` +
        `${timeLine}\n` +
        `Roll with \`!awesome\` — closest wins (exact ends instantly).`
    );
  }

  register(
    "!closestroll",
    withGameSubcommands({
      helpText: CRW_HELP,
      rulesText: CRW_RULES,
      onStart: async ({ message, rest }) => startClosestRoll({ message, rest }),
      onStatus: async ({ message }) => {
        const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
        if (!st) return void (await message.reply(manager.noActiveText()));
        if (!(await requireSameChannel({ message }, st, manager))) return;
        await message.reply(
          `🎯 **ClosestRoll is running** in ${channelMention(st.channelId)}\n` +
          `Target: **${st.target}**\n` +
          (st.endsAtMs ? `Time left: **${formatTimeLeftMs(st.endsAtMs - Date.now())}**\n` : `Time limit: *(none)*\n`) +
          (st.best
            ? `Best so far: ${mention(st.best.userId)} rolled **${st.best.roll}** (diff **${st.best.diff}**)`
            : "Best so far: *(none)*")
        );
      },
    }),
    "!closestroll [0-101] [timeLimit] — starts ClosestRoll (alias: !cr)",
    { helpTier: "primary", aliases: ["!cr"] }
  );

  // Alias wrappers (so existing aliases still work)
  register(
    "!endclosest",
    async ({ message }) => {
      const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!st) return void (await message.reply("No active ClosestRoll to end."));
      if (!(await requireSameChannel({ message }, st, manager))) {
        await message.reply(`ClosestRoll is running in ${channelMention(st.channelId)}. Started by ${mention(st.creatorId)}.`);
        return;
      }
      const ok = await requireCanManage(
        { message },
        st,
        { ownerField: "creatorId", managerLabel: "ClosestRoll", deniedText: "Nope — only admins or the contest starter can do that." }
      );
      if (!ok) return;

      await endWithWinner(st, "ended early", message.channel);
    },
    "!endclosest — ends ClosestRoll early (alias for !endclosestroll)",
    { admin: true, hideFromHelp: true }
  );

  register(
    "!cancelclosest",
    async ({ message }) => {
      const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!st) return void (await message.reply("No active ClosestRoll to cancel."));
      if (!(await requireSameChannel({ message }, st, manager))) {
        await message.reply(`ClosestRoll is running in ${channelMention(st.channelId)}. Started by ${mention(st.creatorId)}.`);
        return;
      }
      const ok = await requireCanManage(
        { message },
        st,
        { ownerField: "creatorId", managerLabel: "ClosestRoll", deniedText: "Nope — only admins or the contest starter can do that." }
      );
      if (!ok) return;

      await cancelNoWinner(st, "cancelled", message.channel);
    },
    "!cancelclosest — cancels ClosestRoll (alias for !cancelclosestroll)",
    { admin: true, hideFromHelp: true }
  );
}
