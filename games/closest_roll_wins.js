// games/closest_roll_wins.js
//
// ClosestRollWins
// - !closestroll [target] [timelimit] (alias: !cr)
// - !awesome (only counted while active)
// - !endclosestroll / !endclosest (admin or starter) => ends + announces winner
// - !cancelclosestroll / !cancelclosest (admin or starter) => cancels, no winner
//
// One active contest per guild, bound to the channel it started in.
//
// Target and rolls are integers 0..101 inclusive.
// Time limit (optional) accepts: "30s", "5m", "1h", or plain number = seconds.
//
// Tie-break: smallest diff wins; on equal diff, earliest roll wins.

import { isAdminOrPrivileged } from "../auth.js";

const ACTIVE_BY_GUILD = new Map(); // guildId -> state

// state = {
//   guildId, channelId, creatorId,
//   target,
//   createdAtMs,
//   endsAtMs: number|null,
//   timer: Timeout|null,
//   best: { userId, roll, diff, atMs } | null,
//   ended: boolean,
// };

const MIN = 0;
const MAX = 101;

function clampInt(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || !Number.isInteger(x)) return null;
  return x;
}

function parseDurationMs(token) {
  // Accept:
  //  "30" (seconds)
  //  "30s", "30sec", "30secs", "30second", "30seconds"
  //  "5m", "5min", "5mins", "5minute", "5minutes"
  //  "1h", "1hr", "1hrs", "1hour", "1hours"
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

function canManage(message, st) {
  if (!st) return false;
  if (isAdminOrPrivileged(message)) return true;
  return message.author?.id === st.creatorId;
}

function locationLine(st) {
  return `Started by <@${st.creatorId}> in <#${st.channelId}>`;
}

function ensureSameChannel(message, st) {
  if (!message.guildId) return { ok: false, reason: "no_guild" };
  if (!st) return { ok: false, reason: "no_state" };

  if (message.guildId !== st.guildId) return { ok: false, reason: "wrong_guild" };
  if (message.channelId !== st.channelId) return { ok: false, reason: "wrong_channel" };

  return { ok: true };
}

function clearTimer(st) {
  if (st?.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
}

async function endWithWinner(message, st, reason) {
  clearTimer(st);
  st.ended = true;
  ACTIVE_BY_GUILD.delete(st.guildId);

  if (!st.best) {
    await message.channel.send(
      `🏁 **ClosestRoll ended** (${reason}).\n` +
        `Target: **${st.target}**\n` +
        `No valid \`!awesome\` rolls were recorded.`
    );
    return;
  }

  const b = st.best;
  await message.channel.send(
    `🏁 **ClosestRoll ended** (${reason}).\n` +
      `Target: **${st.target}**\n` +
      `Winner: <@${b.userId}> with **${b.roll}** (diff **${b.diff}**)`
  );
}

async function cancelNoWinner(message, st, reason) {
  clearTimer(st);
  st.ended = true;
  ACTIVE_BY_GUILD.delete(st.guildId);

  await message.channel.send(
    `🛑 **ClosestRoll cancelled** (${reason}).\n` +
      `Target: **${st.target}**\n` +
      `No winner will be announced.`
  );
}

function maybeExpireNow(st) {
  if (!st || st.ended) return false;
  if (!st.endsAtMs) return false;
  return Date.now() >= st.endsAtMs;
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

export async function onAwesomeRoll(message, roll) {
  if (!message?.guildId) return;

  const st = ACTIVE_BY_GUILD.get(message.guildId);
  if (!st || st.ended) return;

  // Only monitor the channel the contest started in
  if (message.channelId !== st.channelId) return;

  // If time expired, end now before counting
  if (st.endsAtMs && Date.now() >= st.endsAtMs) {
    await endWithWinner(message, st, "time limit expired");
    return;
  }

  const diff = Math.abs(roll - st.target);
  const now = Date.now();

  // Update best (tie => earliest keeps, so only replace if strictly better)
  if (!st.best || diff < st.best.diff) {
    st.best = { userId: message.author.id, roll, diff, atMs: now };
  }

  // Exact ends immediately
  if (diff === 0) {
    await endWithWinner(message, st, "exact hit");
  }
}

// ---------- Main registration ----------

export function registerClosestRollWins(register) {
  // Internal helper: before handling any action, auto-expire if time is up.
  async function autoExpireIfNeeded(message) {
    const st = ACTIVE_BY_GUILD.get(message.guildId);
    if (!st) return false;
    if (!ensureSameChannel(message, st).ok) return false;

    if (maybeExpireNow(st)) {
      await endWithWinner(message, st, "time limit expired");
      return true;
    }
    return false;
  }

  async function startClosestRoll({ message, rest }) {
    if (!message.guildId) return;

    const guildId = message.guildId;
    const existing = ACTIVE_BY_GUILD.get(guildId);
    if (existing && !existing.ended) {
      await message.reply(
        `⚠️ A ClosestRoll is already running.\n${locationLine(existing)}`
      );
      return;
    }

    const tokens = String(rest ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length == 1 && tokens[0].toLowerCase() === "help") {
      await message.reply(
        "**ClosestRoll help**\n" +
        "`!cr [target 0-101] [timeLimit]` — start\n" +
        "Aliases: `!closestroll`, `!cr`\n" +
        "Time formats: `30`, `30s`, `30sec`, `30seconds`, `5m`, `1h`\n" +
        "`!awesome` — roll (only counts while active, in this channel)\n" +
        "`!endclosest` / `!endclosestroll` — end early (admin/starter)\n" +
        "`!cancelclosest` / `!cancelclosestroll` — cancel (admin/starter)"
      );
      return;
    }


    let target = null;
    let timeMs = null;

    // token[0] may be target (int), token[1] may be duration
    if (tokens[0]) {
      const t0 = clampInt(tokens[0]);
      if (t0 !== null) target = t0;
      else {
        await message.reply(
          `❌ Invalid target number.\n` +
            `Usage: \`!closestroll [0-101] [timeLimit]\` e.g. \`!cr 42 5m\` or \`!cr 5m\` (no target).\n` +
            `Time limit formats: \`30s\`, \`5m\`, \`1h\`, or plain seconds like \`120\`.`
        );
        return;
      }
    }

    // If they provided exactly 1 token and it's >101 or weird, they might have meant time.
    // But you asked for strict-ish invalid input rejection; we’ll keep it simple:
    // - If first token is an int, treat as target
    // - Second token (if present) is duration
    if (tokens[1]) {
      timeMs = parseDurationMs(tokens[1]);
      if (!timeMs) {
        await message.reply(
          `❌ Invalid time limit.\n` +
            `Use \`30s\`, \`5m\`, \`1h\`, or plain seconds like \`120\`.`
        );
        return;
      }
    } else if (tokens.length === 1 && target !== null) {
      // no time token
    } else if (tokens.length === 1 && target === null) {
      // unreachable (we parse int above), but leaving for safety
    }

    // If no target provided, roll it.
    if (target === null) target = randIntInclusive(MIN, MAX);

    // Validate target range
    if (target < MIN || target > MAX) {
      await message.reply(`❌ Target must be between **${MIN}** and **${MAX}** (inclusive).`);
      return;
    }

    const now = Date.now();
    const endsAtMs = timeMs ? now + timeMs : null;

    const st = {
      guildId,
      channelId: message.channelId,
      creatorId: message.author.id,
      target,
      createdAtMs: now,
      endsAtMs,
      timer: null,
      best: null,
      ended: false,
    };

    // If time-limited, schedule auto-end (so it *actually* ends even if nobody types)
    if (endsAtMs) {
      st.timer = setTimeout(async () => {
        // We may not have a message object here; we can only end silently unless we can access channel.
        // So: we rely on being able to send via cached channel on message.client.
        // We’ll defensively check if the state is still active, and then send in that channel.
        try {
          const live = ACTIVE_BY_GUILD.get(guildId);
          if (!live || live.ended) return;

          // Try to fetch the channel from the client.
          const ch = message.client?.channels?.cache?.get(st.channelId);
          if (ch) {
            await endWithWinner({ channel: ch }, live, "time limit expired");
          } else {
            // Fallback: just clear state if channel not found
            clearTimer(live);
            live.ended = true;
            ACTIVE_BY_GUILD.delete(guildId);
          }
        } catch {
          // Last-resort cleanup
          const live = ACTIVE_BY_GUILD.get(guildId);
          if (live) {
            clearTimer(live);
            live.ended = true;
            ACTIVE_BY_GUILD.delete(guildId);
          }
        }
      }, timeMs);
    }

    ACTIVE_BY_GUILD.set(guildId, st);

    const timeLine = endsAtMs
      ? `Time limit: **${formatTimeLeftMs(endsAtMs - now)}**`
      : `Time limit: *(none)*`;

    await message.channel.send(
      `🎯 **ClosestRoll started!**\n` +
        `Target number: **${target}**\n` +
        `${timeLine}\n` +
        `Roll with \`!awesome\` — closest wins (exact ends instantly).`
    );
  }

  register(
    "!closestroll",
    async (ctx) => startClosestRoll(ctx),
    "!closestroll [0-101] [timeLimit] — starts ClosestRoll (alias: !cr)"
  );

  register(
    "!cr",
    async (ctx) => startClosestRoll(ctx),
    "!cr [0-101] [timeLimit] — starts ClosestRoll"
  );

  async function endClosest({ message }, isCancel) {
    if (!message.guildId) return;

    // If expired, auto-end first; if it ended, we’re done.
    const expired = await autoExpireIfNeeded(message);
    if (expired) return;

    const st = ACTIVE_BY_GUILD.get(message.guildId);
    if (!st || st.ended) {
      await message.reply("No active ClosestRoll to end.");
      return;
    }

    const loc = ensureSameChannel(message, st);
    if (!loc.ok) {
      await message.reply(`ClosestRoll is running in <#${st.channelId}>. ${locationLine(st)}`);
      return;
    }

    if (!canManage(message, st)) {
      await message.reply("Nope — only admins or the contest starter can do that.");
      return;
    }

    if (isCancel) {
      await cancelNoWinner(message, st, "cancelled");
    } else {
      await endWithWinner(message, st, "ended early");
    }
  }

  register(
    "!endclosestroll",
    async (ctx) => endClosest(ctx, false),
    "!endclosestroll — ends ClosestRoll early (alias: !endclosest)",
    { admin: true }
  );

  register(
    "!endclosest",
    async (ctx) => endClosest(ctx, false),
    "!endclosest — ends ClosestRoll early",
    { admin: true }
  );

  register(
    "!cancelclosestroll",
    async (ctx) => endClosest(ctx, true),
    "!cancelclosestroll — cancels ClosestRoll (alias: !cancelclosest)",
    { admin: true }
  );

  register(
    "!cancelclosest",
    async (ctx) => endClosest(ctx, true),
    "!cancelclosest — cancels ClosestRoll",
    { admin: true }
  );
}
