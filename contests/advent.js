import { ApplicationCommandOptionType as Option, ChannelType, MessageFlags } from "discord.js";
import { DateTime } from "luxon";
import { isAdminOrPrivileged } from "../auth.js";
import { sendDm } from "../shared/dm.js";
import { logger } from "../shared/logger.js";
import { clearTimer, startTimeout } from "../shared/timer_utils.js";
import { ADVENT_DEFAULT_PERIOD, ADVENT_TIME_ZONE, getAdventClaimPeriod } from "../configs/advent.js";
import { getAdventSettings, updateAdventSettings, insertAdventClaim, getAdventClaims } from "./advent_store.js";

const memberRequests = new Map();
const roleCountSnapshots = new Map();
const memberRetryAt = new Map();
const claimsInProgress = new Map();
const ROLE_COUNT_CACHE_MS = 30_000;
const REPORT_WAIT_MS = 15_000;
const NO_MENTIONS = { parse: [], repliedUser: false };

function eventDate(atMs) {
  return DateTime.fromMillis(atMs, { zone: ADVENT_TIME_ZONE });
}

function isClaimDate(date, period = ADVENT_DEFAULT_PERIOD) {
  const day = date.month * 100 + date.day;
  return date.isValid && day >= period.startMonth * 100 + period.startDay &&
    day <= period.endMonth * 100 + period.endDay;
}

function periodText(period = ADVENT_DEFAULT_PERIOD) {
  const start = DateTime.fromObject({ year: 2000, month: period.startMonth, day: period.startDay });
  const end = DateTime.fromObject({ year: 2000, month: period.endMonth, day: period.endDay });
  return `${start.toFormat("MMMM d")}–${end.toFormat(period.startMonth === period.endMonth ? "d" : "MMMM d")}`;
}

function reportDate(raw, atMs, period = ADVENT_DEFAULT_PERIOD) {
  const input = String(raw || "yesterday").trim().toLowerCase();
  const today = eventDate(atMs);
  let date;
  if (input === "today") date = today;
  else if (input === "yesterday") date = today.minus({ days: 1 });
  else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) date = DateTime.fromISO(input, { zone: ADVENT_TIME_ZONE });
  if (!date || !(isClaimDate(date, period) || (period.devOverride && isClaimDate(date)))) {
    const dates = `${periodText(period)}${period.devOverride ? ` or ${periodText()}` : ""}`;
    throw new AdventInputError(`Choose one Advent date (${dates}): \`today\`, \`yesterday\`, or \`YYYY-MM-DD\`. Include the year for older events.`);
  }
  return date.toISODate();
}

class AdventInputError extends Error {}

function canManage(source, settings) {
  const userId = source.user?.id || source.author?.id;
  return isAdminOrPrivileged(source) || String(userId) === settings.hostId;
}

function parseId(raw) {
  const text = String(raw || "").trim();
  if (/^\d{5,20}$/.test(text)) return text;
  return /^<(?:@&|@!?|#)(\d{5,20})>$/.exec(text)?.[1] || null;
}

function isPublicThread(channel) {
  return Boolean(channel?.isThread?.()) && channel.type !== ChannelType.PrivateThread;
}

function csvCell(value) {
  let text = String(value ?? "");
  // Names are user-controlled. Keep spreadsheet formula prefixes inert.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function claimsCsv(guildId, date, rows) {
  const header = ["claim_date_tppc", "discord_user_id", "username", "display_name", "claimed_at_tppc", "claimed_at_utc", "claim_reference"];
  const lines = rows.map((row) => [
    date,
    `'${row.user_id}`, // Preserve long Discord IDs when opened in Excel.
    row.username,
    row.display_name,
    eventDate(Number(row.claimed_at_ms)).toISO(),
    DateTime.fromMillis(Number(row.claimed_at_ms), { zone: "UTC" }).toISO(),
    `https://discord.com/channels/${guildId}/${row.channel_id}/${row.source_id}`,
  ].map(csvCell).join(","));
  return Buffer.from(`\uFEFF${header.join(",")}\r\n${lines.join("\r\n")}\r\n`, "utf8");
}

function settingsText(settings, period = ADVENT_DEFAULT_PERIOD) {
  return [
    "**Advent settings**",
    `Participant role: <@&${settings.roleId}> (\`${settings.roleId}\`)`,
    `Claim thread: <#${settings.channelId}> (\`${settings.channelId}\`)`,
    `Host: <@${settings.hostId}> (\`${settings.hostId}\`)`,
    `Claims: ${periodText(period)}, TPPC time (America/New_York).${period.devOverride ? " **DEV TEST OVERRIDE**" : ""}`,
  ].join("\n");
}

function helpText(prefix = "!", period = ADVENT_DEFAULT_PERIOD) {
  return [
    `**Advent** — claim publicly once per TPPC date, ${periodText(period)}.${period.devOverride ? " **DEV TEST OVERRIDE**" : ""}`,
    `• \`${prefix}claim\` or \`/claim\` — claim in the configured Advent thread; the participant role is required.`,
    "**Privileged users / Advent host:**",
    `• \`${prefix}advent claims [today|yesterday|YYYY-MM-DD]\` or \`/advent claims\` — DM one day's report (default: yesterday).`,
    `• \`${prefix}advent config\` — show settings.`,
    `• \`${prefix}advent config role|channel|host <ID or mention>\` or \`/advent config\` — update this server's settings.`,
    `• \`${prefix}rolecount <role ID or mention>\` or \`/rolecount\` — count current members with a role.`,
    "Past reports remain available after the event. Dates cannot be changed at runtime.",
  ].join("\n");
}

function context(source, slash = false) {
  return {
    source,
    slash,
    user: slash ? source.user : source.author,
    guild: source.guild,
    guildId: source.guildId,
    // Use the command's creation time so slow IO cannot move a claim across midnight.
    atMs: source.createdTimestamp ?? Date.now(),
  };
}

async function respond(ctx, content) {
  const payload = { content, allowedMentions: NO_MENTIONS };
  if (ctx.slash && ctx.source.deferred) return ctx.source.editReply(payload);
  if (ctx.slash) payload.flags = MessageFlags.Ephemeral;
  return ctx.source.reply(payload);
}

async function execute(ctx, action) {
  if (!ctx.guildId || !ctx.guild) return respond(ctx, "Use this command in the server. Advent claims must be posted publicly in its claim thread.");
  if (ctx.slash) {
    // Claim deferrals and final responses are public, including failed attempts.
    await ctx.source.deferReply(action.name === "claim" ? {} : { flags: MessageFlags.Ephemeral });
  }
  try {
    return await action.run();
  } catch (err) {
    if (!(err instanceof AdventInputError)) {
      logger.error("advent.command.failed", {
        guildId: ctx.guildId, userId: ctx.user?.id, action: action.name,
        error: logger.serializeError(err),
      });
    }
    return respond(ctx, err instanceof AdventInputError ? err.message : "I couldn't complete that request. Please try again; retrying a claim won't create a duplicate.");
  }
}

async function claim(ctx) {
  const date = eventDate(ctx.atMs);
  const settings = await getAdventSettings(ctx.guildId);
  if (ctx.source.channelId !== settings.channelId || !isPublicThread(ctx.source.channel)) {
    throw new AdventInputError(`Claims must be posted publicly in the Advent thread: <#${settings.channelId}>.`);
  }
  if (!isClaimDate(date, ctx.period)) {
    const closing = date.set({ month: ctx.period.endMonth, day: ctx.period.endDay }).plus({ days: 1 }).toFormat("MMMM d");
    throw new AdventInputError(`Advent claims are open ${periodText(ctx.period)} in TPPC time, closing at midnight on ${closing}.`);
  }
  // Fetch fresh membership; a stale cache must not keep a removed role eligible.
  const member = await ctx.guild.members.fetch({ user: ctx.user.id, force: true });
  if (!member.roles.cache.has(settings.roleId)) throw new AdventInputError("You need the Advent participant role to claim.");
  // An interaction ID is not a message link. Save the public reply's actual ID.
  const sourceId = ctx.slash ? (await ctx.source.fetchReply()).id : ctx.source.id;
  const accepted = await insertAdventClaim({
    guildId: ctx.guildId, date: date.toISODate(), userId: ctx.user.id,
    username: ctx.user.username, displayName: member.displayName || ctx.user.username,
    claimedAtMs: ctx.atMs, channelId: ctx.source.channelId, sourceId,
  });
  return respond(ctx, accepted
    ? `✅ <@${ctx.user.id}> claimed for **${date.toISODate()}** (TPPC time).`
    : `<@${ctx.user.id}>, you already claimed for **${date.toISODate()}** (TPPC time).`);
}

async function requireManager(ctx) {
  const settings = await getAdventSettings(ctx.guildId);
  if (!canManage(ctx.source, settings)) throw new AdventInputError("Only privileged users or this server's Advent host can use this command.");
  return settings;
}

async function waitForClaims(guildId, date) {
  const key = `${guildId}:${date}`;
  if (!claimsInProgress.get(key)?.size) return;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = startTimeout({
      label: "advent.report.wait", ms: REPORT_WAIT_MS,
      fn: () => reject(new AdventInputError(`Some claims for **${date}** are still being saved. Please try the report again shortly; no report was sent.`)),
    });
  });
  try {
    // Include claims that begin while an earlier group is finishing, with one
    // bounded wait for the whole report rather than a fresh timeout per group.
    while (claimsInProgress.get(key)?.size) {
      await Promise.race([Promise.all([...claimsInProgress.get(key)]), timeout]);
    }
  } finally {
    clearTimer(timer);
  }
}

async function report(ctx, rawDate) {
  await requireManager(ctx);
  const date = reportDate(rawDate, ctx.atMs, ctx.period);
  if (date < eventDate(Date.now()).toISODate()) await waitForClaims(ctx.guildId, date);
  const rows = await getAdventClaims({ guildId: ctx.guildId, date });
  const reportedAt = eventDate(Date.now());
  const result = await sendDm({
    user: ctx.user, feature: "advent.report",
    payload: {
      content: `**Advent claims — ${date} (TPPC time)**\nServer: ${ctx.guild.name}\nTotal accepted claims: **${rows.length}**\nAs of: **${reportedAt.toISO()}** (TPPC time).\n${date === reportedAt.toISODate() ? "Today's report is a snapshot; more claims may arrive before midnight." : ""}`,
      files: [{ attachment: claimsCsv(ctx.guildId, date, rows), name: `advent-claims-${ctx.guildId}-${date}.csv` }],
      allowedMentions: NO_MENTIONS,
    },
  });
  return respond(ctx, result.ok
    ? `📩 Sent you the Advent report for **${date}** (TPPC time): **${rows.length}** claim(s).`
    : "I couldn't DM the report. Enable DMs from this server and try again.");
}

async function configure(ctx, patch) {
  const settings = await requireManager(ctx);
  if (!Object.keys(patch).length) return respond(ctx, settingsText(settings, ctx.period));
  for (const id of Object.values(patch)) {
    if (!parseId(id)) throw new AdventInputError("Provide a valid Discord ID or mention.");
  }
  // Validate every field before saving anything.
  if (patch.roleId) {
    const role = await ctx.guild.roles.fetch(patch.roleId);
    if (!role || role.id === ctx.guildId) throw new AdventInputError("Choose a participant role from this server, other than @everyone.");
  }
  if (patch.channelId) {
    const channel = await ctx.guild.channels.fetch(patch.channelId);
    if (!isPublicThread(channel)) throw new AdventInputError("Choose a public thread in this server for Advent claims.");
  }
  if (patch.hostId) {
    const host = await ctx.guild.members.fetch({ user: patch.hostId, force: true });
    if (!host || host.user.bot) throw new AdventInputError("Choose a human member of this server as the Advent host.");
  }
  await updateAdventSettings({ guildId: ctx.guildId, settings, patch, updatedBy: ctx.user.id });
  return respond(ctx, `✅ Updated this server's Advent settings.\n${settingsText(await getAdventSettings(ctx.guildId), ctx.period)}`);
}

function memberCooldownError(retryAt) {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return new AdventInputError(`Discord is limiting member requests for this server. Please try again in **${seconds}** second(s).`);
}

async function fetchRoleCounts(ctx) {
  const startedAt = Date.now();
  const retryAt = memberRetryAt.get(ctx.guildId) || 0;
  if (startedAt < retryAt) throw memberCooldownError(retryAt);
  memberRetryAt.set(ctx.guildId, startedAt + ROLE_COUNT_CACHE_MS);
  let members;
  try {
    members = await ctx.guild.members.fetch({ time: 30_000 });
  } catch (err) {
    // discord.js GatewayRateLimitError carries the gateway retry_after in data.
    const retryAfter = Number(err?.data?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      const nextTry = Math.max(memberRetryAt.get(ctx.guildId), Date.now() + retryAfter * 1000);
      memberRetryAt.set(ctx.guildId, nextTry);
      throw memberCooldownError(nextTry);
    }
    throw err;
  }
  // Snapshot primitive counts, not mutable GuildMember objects. Checking a
  // second role can reuse the same complete fetch without mixed-age membership.
  const counts = new Map();
  for (const member of members.values()) {
    for (const roleId of member.roles.cache.keys()) counts.set(roleId, (counts.get(roleId) || 0) + 1);
  }
  counts.set(ctx.guildId, members.size); // @everyone includes the whole server.
  const sampledAtMs = Date.now();
  const snapshot = { counts, sampledAtMs, expiresAtMs: sampledAtMs + ROLE_COUNT_CACHE_MS };
  roleCountSnapshots.set(ctx.guildId, snapshot);
  return snapshot;
}

async function getRoleCounts(ctx) {
  const snapshot = roleCountSnapshots.get(ctx.guildId);
  if (snapshot && Date.now() < snapshot.expiresAtMs) return snapshot;
  roleCountSnapshots.delete(ctx.guildId);
  let request = memberRequests.get(ctx.guildId);
  if (!request) {
    request = fetchRoleCounts(ctx);
    memberRequests.set(ctx.guildId, request);
  }
  try {
    return await request;
  } finally {
    if (memberRequests.get(ctx.guildId) === request) memberRequests.delete(ctx.guildId);
  }
}

async function countRole(ctx, rawRoleId) {
  await requireManager(ctx);
  const roleId = parseId(rawRoleId);
  if (!roleId) throw new AdventInputError("Provide a Discord role ID or role mention.");
  const role = await ctx.guild.roles.fetch(roleId);
  if (!role) throw new AdventInputError("That role wasn't found in this server.");
  const snapshot = await getRoleCounts(ctx);
  const count = snapshot.counts.get(roleId) || 0;
  const sampledAt = Math.floor(snapshot.sampledAtMs / 1000);
  return respond(ctx, `<@&${roleId}> has **${count}** member(s) in this server (including bots with that role).\nSnapshot: <t:${sampledAt}:F>. Counts are cached for 30 seconds.`);
}

function run(ctx, name, fn) {
  const action = { name, run: fn };
  try {
    ctx.period = getAdventClaimPeriod(ctx.source.client?.user?.id);
  } catch (err) {
    return execute(ctx, { name, run: () => { throw new AdventInputError(err.message); } });
  }
  if (name !== "claim" || !ctx.guildId || !isClaimDate(eventDate(ctx.atMs), ctx.period)) return execute(ctx, action);
  // Register synchronously, before even the slash deferral can yield to a
  // midnight report. This only tracks processing; it adds no approval stage.
  const key = `${ctx.guildId}:${eventDate(ctx.atMs).toISODate()}`;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let pending = claimsInProgress.get(key);
  if (!pending) {
    pending = new Set();
    claimsInProgress.set(key, pending);
  }
  pending.add(done);
  return execute(ctx, action).finally(() => {
    pending.delete(done);
    if (!pending.size) claimsInProgress.delete(key);
    finish();
  });
}

export function registerAdvent(register) {
  register.expose({
    logicalId: "advent.claim", name: "claim",
    handler: ({ message, rest }) => {
      const ctx = context(message);
      return run(ctx, "claim", () => {
        if (String(rest || "").trim()) throw new AdventInputError("Use `claim` without a date or other arguments to claim for today.");
        return claim(ctx);
      });
    },
    help: "!claim — claim publicly for today's Advent prize (December 1–24)",
  });
  register.slash({ name: "claim", description: "Claim today's Advent prize publicly in the Advent thread", dm_permission: false },
    ({ interaction }) => {
      const ctx = context(interaction, true);
      return run(ctx, "claim", () => claim(ctx));
    });

  register.expose({
    logicalId: "advent.manage", name: "advent",
    handler: ({ message, rest, cmd }) => {
      const ctx = context(message);
      const [action = "help", ...args] = String(rest || "").trim().split(/\s+/).filter(Boolean);
      return run(ctx, action.toLowerCase(), async () => {
        if (action.toLowerCase() === "claims") {
          if (args.length > 1) throw new AdventInputError("Reports accept one date at a time.");
          return report(ctx, args[0]);
        }
        if (action.toLowerCase() === "config") {
          if (!args.length) return configure(ctx, {});
          const field = { role: "roleId", channel: "channelId", host: "hostId" }[args[0].toLowerCase()];
          const id = parseId(args[1]);
          if (!field || !id || args.length !== 2) throw new AdventInputError("Use `advent config role|channel|host <ID or mention>`. Event dates are fixed.");
          return configure(ctx, { [field]: id });
        }
        return respond(ctx, helpText(cmd?.startsWith("?") ? "?" : "!", ctx.period));
      });
    },
    help: "!advent — Advent settings and dated claim reports (privileged / host)",
    opts: { admin: true },
  });
  register.slash({
    name: "advent", description: "Advent reports and server settings (privileged users or Advent host)", dm_permission: false,
    options: [
      { type: Option.Subcommand, name: "claims", description: "DM a single day's Advent report, including past events",
        options: [{ type: Option.String, name: "date", description: "today, yesterday (default), or YYYY-MM-DD" }] },
      { type: Option.Subcommand, name: "config", description: "Show or update this server's Advent role, public thread, and host",
        options: [
          { type: Option.Role, name: "role", description: "Participant role" },
          { type: Option.Channel, name: "channel", description: "Public claim thread", channel_types: [ChannelType.AnnouncementThread, ChannelType.PublicThread] },
          { type: Option.User, name: "host", description: "Advent host" },
        ] },
    ],
  }, ({ interaction }) => {
    const ctx = context(interaction, true);
    const sub = interaction.options.getSubcommand();
    return run(ctx, sub, () => {
      if (sub === "claims") return report(ctx, interaction.options.getString("date"));
      const patch = {};
      const role = interaction.options.getRole("role");
      const channel = interaction.options.getChannel("channel");
      const host = interaction.options.getUser("host");
      if (role) patch.roleId = role.id;
      if (channel) patch.channelId = channel.id;
      if (host) patch.hostId = host.id;
      return configure(ctx, patch);
    });
  }, { admin: true });

  register.expose({
    logicalId: "advent.rolecount", name: "rolecount",
    handler: ({ message, rest }) => {
      const ctx = context(message);
      return run(ctx, "rolecount", () => countRole(ctx, rest));
    },
    help: "!rolecount <role ID or mention> — count server members with a role (privileged / Advent host)",
    opts: { admin: true },
  });
  register.slash({
    name: "rolecount", description: "Count current server members with a role (privileged users or Advent host)", dm_permission: false,
    options: [{ type: Option.String, name: "role_id", description: "Discord role ID or mention", required: true }],
  }, ({ interaction }) => {
    const ctx = context(interaction, true);
    return run(ctx, "rolecount", () => countRole(ctx, interaction.options.getString("role_id")));
  }, { admin: true });
}

export const __testables = { eventDate, isClaimDate, reportDate, parseId, claimsCsv, canManage };
