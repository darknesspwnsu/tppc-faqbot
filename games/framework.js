// games/framework.js
//
// Lightweight game framework helpers for TPPC Discord Bot games.
// Composition-first: games opt into pieces instead of inheriting a base class.
//
// Core ideas:
// - Game state is kept in memory via createGameManager (guild/global scope).
// - Timers should be owned by TimerBag so manager.stop() is always safe.
// - Helpers keep command UX consistent (help/rules/status, permission checks, etc.).

import { MessageFlags, PermissionsBitField } from "discord.js";
import { isAdminOrPrivileged } from "../auth.js";
import { CONTEST_ROLES_BY_GUILD } from "../configs/contest_roles.js";
import { parseDurationSeconds, formatDurationSeconds } from "../shared/time_utils.js";
import { startTimeout, startInterval, clearTimer } from "../shared/timer_utils.js";

/* --------------------------------- basics -------------------------------- */

export function mention(userId) {
  return `<@${userId}>`;
}

export function channelMention(channelId) {
  return `<#${channelId}>`;
}

function contestRoleConfigFor({ guildId, channelId, applyTo }) {
  const g = CONTEST_ROLES_BY_GUILD?.[String(guildId || "")];
  const cfg = g?.[String(channelId || "")];
  if (!cfg?.roleId) return null;
  const apply = Array.isArray(cfg.applyTo) ? cfg.applyTo : [];
  if (!apply.includes(applyTo)) return null;
  return cfg;
}

async function updateRoleMembers({ guild, roleId, userIds, action }) {
  const added = [];
  const failed = [];
  const ids = Array.isArray(userIds) ? userIds : [];
  if (!guild?.members?.fetch || !roleId || !ids.length) return { added, failed };

  const members = await guild.members.fetch({ user: ids }).catch(() => null);

  for (const id of ids) {
    const m = members?.get?.(id) || guild.members?.cache?.get?.(id);
    if (!m) {
      failed.push(id);
      continue;
    }
    try {
      if (action === "add") await m.roles.add(roleId);
      else await m.roles.remove(roleId);
      added.push(id);
    } catch {
      failed.push(id);
    }
  }

  return { added, failed };
}

async function notifyRoleErrors(ctx, roleId, failedIds) {
  if (!failedIds.length) return;
  const list = failedIds.map(mention).join(", ");
  const content = `⚠️ Could not assign <@&${roleId}> to: ${list}`;

  if (ctx?.message) {
    try {
      await ctx.message.reply(content);
    } catch {}
    return;
  }

  if (ctx?.interaction) {
    try {
      if (ctx.interaction.deferred || ctx.interaction.replied) {
        await ctx.interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await ctx.interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
}

export async function assignContestRoleForEntrants(ctx, entrants, applyTo = "game_join_react") {
  const ids = Array.from(entrants || []).filter(Boolean);
  if (!ids.length) return { assignment: null, failedIds: [] };

  const guildId = ctx?.message?.guildId || ctx?.interaction?.guildId;
  const channelId = ctx?.message?.channelId || ctx?.interaction?.channelId;
  if (!guildId || !channelId) return { assignment: null, failedIds: [] };

  const cfg = contestRoleConfigFor({ guildId, channelId, applyTo });
  if (!cfg) return { assignment: null, failedIds: [] };

  const guild = ctx?.message?.guild || ctx?.interaction?.guild;
  if (!guild) return { assignment: null, failedIds: ids };

  const { added, failed } = await updateRoleMembers({ guild, roleId: cfg.roleId, userIds: ids, action: "add" });

  if (failed.length) await notifyRoleErrors(ctx, cfg.roleId, failed);

  const assignment =
    added.length > 0
      ? { roleId: cfg.roleId, userIds: added, guildId: String(guildId), channelId: String(channelId) }
      : null;

  return { assignment, failedIds: failed };
}

async function cleanupContestRoleAssignment(state) {
  const assignment = state?.contestRoleAssignment;
  if (!assignment?.roleId || !Array.isArray(assignment.userIds) || !assignment.userIds.length) return;

  const client = state.client;
  const guildId = state.guildId;
  if (!client || !guildId) return;

  const guild =
    client.guilds?.cache?.get?.(guildId) ||
    (client.guilds?.fetch ? await client.guilds.fetch(guildId).catch(() => null) : null);
  if (!guild) return;

  await updateRoleMembers({ guild, roleId: assignment.roleId, userIds: assignment.userIds, action: "remove" });
}

export function nowMs() {
  return Date.now();
}

/**
 * Extracts Discord mention IDs in the order they appear in the raw text.
 * Supports: <@123> or <@!123>
 */
export function parseMentionIdsInOrder(text) {
  const s = String(text ?? "");
  const ids = [];
  const re = /<@!?(\d+)>/g;
  let m;
  while ((m = re.exec(s)) !== null) ids.push(m[1]);
  return ids;
}

/** Safer string trim for command rest args */
export function cleanRest(rest) {
  return String(rest || "").trim();
}

/** Reusable shuffle (in-place Fisher-Yates) */
export function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Reusable int clamp/validate */
export function clampInt(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  n = Math.floor(n);
  if (n < lo || n > hi) return null;
  return n;
}

/** Expose auth check so games can avoid importing auth.js directly */
export function isAdminOrPrivilegedMessage(message) {
  return Boolean(isAdminOrPrivileged(message));
}

/* ------------------------------ durations -------------------------------- */

export { parseDurationSeconds, formatDurationSeconds };

/* ------------------------------ reactions -------------------------------- */

/**
 * Generic ✅-join pattern (reaction collector).
 *
 * Options allow matching existing game behavior:
 * - trackRemovals: when true, removes users on unreact (requires dispose:true)
 * - dispose: pass through to collector (needed if you want "remove" events)
 *
 * Returns { entrants:Set<string>, joinMsg, reason }.
 * Best-effort: edits the join message when the window closes.
 */
export async function collectEntrantsByReactionsWithMax({
  channel,
  promptText,
  durationMs,
  maxEntrants,
  emoji = "✅",
  dispose = false,
  trackRemovals = false,
}) {
  const joinMsg = await channel.send(promptText);

  try {
    await joinMsg.react(emoji);
  } catch {
    return { entrants: new Set(), joinMsg };
  }

  const entrants = new Set();
  const filter = (reaction, user) => !user.bot && reaction.emoji?.name === emoji;

  return new Promise((resolve) => {
    const collector = joinMsg.createReactionCollector({
      filter,
      time: durationMs,
      dispose: Boolean(dispose),
    });

    collector.on("collect", (_reaction, user) => {
      entrants.add(user.id);
      if (maxEntrants && entrants.size >= maxEntrants) collector.stop("max");
    });

    if (trackRemovals) {
      collector.on("remove", (_reaction, user) => {
        entrants.delete(user.id);
      });
    }

    collector.on("end", async (_c, reason) => {
      // Best-effort: edit the join message to indicate entries are closed
      try {
        const closedText =
          reason === "max"
            ? "Entries have closed for this contest (max entrants reached)."
            : "Entries have closed for this contest.";
        await joinMsg.edit(closedText);

      } catch {
        // ignore (missing perms, message deleted, etc.)
      }
      resolve({ entrants, joinMsg, reason });
    });
  });
}

/* --------------------------------- replies -------------------------------- */

async function safeReplyInteraction(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (e) {
    // swallow
  }
}

export async function reply(ctx, content, opts = {}) {
  const payload =
    typeof content === "string"
      ? { content, allowedMentions: { parse: [] }, ...opts }
      : { allowedMentions: { parse: [] }, ...content, ...opts };

  if (ctx?.message) {
    try {
      return await ctx.message.reply(payload);
    } catch (e) {}
    return;
  }
  if (ctx?.interaction) {
    return await safeReplyInteraction(ctx.interaction, payload);
  }
}

/* ------------------------------- permissions ------------------------------ */

export function isAdminish(member) {
  if (!member) return false;
  try {
    return (
      member.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
      member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)
    );
  } catch (e) {
    return false;
  }
}

/**
 * Canonical "can manage this game" for any ctx.
 *
 * - owner always allowed
 * - message ctx: uses isAdminOrPrivileged(message)
 * - interaction ctx: uses isAdminOrPrivileged(message-like), else Admin/ManageGuild
 */
export function canManageCtx(ctx, state, ownerField = "creatorId") {
  if (!state) return false;

  const message = ctx?.message;
  const interaction = ctx?.interaction;

  const ownerId = state?.[ownerField];
  const userId = message?.author?.id || interaction?.user?.id;
  if (ownerId && userId && ownerId === userId) return true;

  if (message) return Boolean(isAdminOrPrivileged(message));

  const messageLike = interaction
    ? { guildId: interaction.guildId, member: interaction.member, author: interaction.user }
    : null;
  if (messageLike && isAdminOrPrivileged(messageLike)) return true;

  const member = interaction?.member;
  return isAdminish(member);
}

/**
 * Back-compat helper (kept for existing callers).
 */
export function canManageGame({ member, userId }, state, ownerField = "creatorId") {
  if (!state) return false;
  const ownerId = state?.[ownerField];
  if (ownerId && userId && ownerId === userId) return true;
  if (isAdminish(member)) return true;
  return false;
}

/* --------------------------------- timers -------------------------------- */

export class TimerBag {
  constructor(label = "game.timer") {
    this._timers = new Set();
    this._intervals = new Set();
    this._label = label;
  }

  setTimeout(fn, ms) {
    const t = startTimeout({
      label: `${this._label}:timeout`,
      ms,
      fn: () => {
        this._timers.delete(t);
        fn();
      },
    });
    this._timers.add(t);
    return t;
  }

  setInterval(fn, ms) {
    const t = startInterval({
      label: `${this._label}:interval`,
      ms,
      fn,
    });
    this._intervals.add(t);
    return t;
  }

  clearAll() {
    for (const t of this._timers) clearTimer(t, `${this._label}:timeout`);
    for (const t of this._intervals) clearTimer(t, `${this._label}:interval`);
    this._timers.clear();
    this._intervals.clear();
  }
}

/**
 * Generic cooldown helper for round-based games.
 *
 * Sends an optional message, then schedules the next-round callback
 * using the game's TimerBag and manager to ensure cleanup safety.
 */
export async function scheduleRoundCooldown({
  state,
  manager,
  channel,
  delayMs,
  message,
  onStart,
}) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (message && channel?.send) {
    try {
      await channel.send(message);
    } catch {}
  }

  const timers = state?.timers;
  if (!timers?.setTimeout) return;

  timers.setTimeout(async () => {
    const live = manager?.getState ? manager.getState({ guildId: state?.guildId }) : state;
    if (!live) return;
    if (onStart) await onStart(live, channel);
  }, ms);
}

/* ------------------------------- safe editing ------------------------------ */

/**
 * Safely edit a message by id (common “board message” pattern).
 * Works even if message isn't cached.
 */
export async function safeEditById(channel, messageId, payload) {
  if (!channel || !messageId) return false;
  try {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return false;
    await msg.edit(payload);
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------ board helpers ------------------------------ */

/**
 * Board helper for "single message" games.
 *
 * Requires state.client + state.channelId to resolve the channel.
 * Uses state[messageIdField] to track the board message id.
 */
export function createBoard(state, { messageIdField = "messageId" } = {}) {
  async function getChannel() {
    const client = state?.client;
    const channelId = state?.channelId;
    if (!client || !channelId) return null;

    const cached = client.channels?.cache?.get?.(channelId) || null;
    if (cached) return cached;

    try {
      return await client.channels.fetch(channelId);
    } catch {
      return null;
    }
  }

  async function post(channel, payload) {
    if (!channel?.send) return null;
    const msg = await channel.send(payload);
    state[messageIdField] = msg.id;
    return msg;
  }

  async function update(payload) {
    const channel = await getChannel();
    if (!channel) return false;
    const messageId = state?.[messageIdField];
    return await safeEditById(channel, messageId, payload);
  }

  async function end(payload, { disableComponents = false, stopManager = null } = {}) {
    if (disableComponents) {
      const p = { ...payload };
      if (p.components) {
        p.components = p.components.map((row) => {
          const r = row?.toJSON ? row.toJSON() : row;
          if (!r?.components) return r;
          return {
            ...r,
            components: r.components.map((c) => ({ ...c, disabled: true })),
          };
        });
      }
      await update(p);
    } else {
      await update(payload);
    }

    if (typeof stopManager === "function") stopManager();
  }

  return { post, update, end };
}

export async function guardBoardInteraction(
  interaction,
  {
    manager,
    messageIdField = "messageId",
    state = null,
    requireSameChannelGuard = true,
    wrongUserText = null,
    allowUserIds = null,
  } = {}
) {
  const st =
    state ||
    manager?.getState?.({
      interaction,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });

  if (!st) {
    try {
      await interaction.reply({ content: "No active game.", flags: MessageFlags.Ephemeral });
    } catch {}
    return null;
  }

  if (requireSameChannelGuard) {
    const ok = await requireSameChannel({ interaction }, st, manager);
    if (!ok) return null;
  }

  const activeMsgId = st?.[messageIdField];
  if (activeMsgId && interaction.message?.id && interaction.message.id !== activeMsgId) {
    try {
      await interaction.reply({ content: "These buttons aren’t for the current game message.", flags: MessageFlags.Ephemeral });
    } catch {}
    return null;
  }

  if (Array.isArray(allowUserIds) && allowUserIds.length) {
    const uid = interaction.user?.id;
    if (!uid || !allowUserIds.includes(uid)) {
      try {
        await interaction.reply({
          content: wrongUserText || "Only the active player(s) can use these buttons.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {}
      return null;
    }
  }

  return { state: st, board: createBoard(st, { messageIdField }) };
}

/* ------------------------------ game manager ------------------------------ */

/**
 * In-memory game state manager.
 *
 * Scope:
 * - "guild" (default): one active state per guild
 * - "global": single shared state
 *
 * Expect state to include: guildId, channelId, creatorId, client (when needed),
 * and timers (TimerBag) for safe cleanup.
 */
export function createGameManager({ id, prettyName, scope = "guild" } = {}) {
  const label = prettyName || id || "game";

  const globalSlot = { state: null };
  const perGuild = new Map(); // guildId -> state

  function keyFromCtx(ctx) {
    if (scope === "global") return "__global__";
    const gid = ctx?.guildId || ctx?.message?.guildId || ctx?.interaction?.guildId;
    return gid || null;
  }

  function getState(ctx) {
    const k = keyFromCtx(ctx);
    if (!k) return null;
    if (scope === "global") return globalSlot.state;
    return perGuild.get(k) || null;
  }

  function setState(ctx, state) {
    const k = keyFromCtx(ctx);
    if (!k) return false;
    if (scope === "global") {
      globalSlot.state = state;
      return true;
    }
    perGuild.set(k, state);
    return true;
  }

  function clearState(ctx) {
    const k = keyFromCtx(ctx);
    if (!k) return false;
    if (scope === "global") {
      globalSlot.state = null;
      return true;
    }
    perGuild.delete(k);
    return true;
  }

  function isActive(ctx) {
    return Boolean(getState(ctx));
  }

  function alreadyRunningText(state) {
    if (!state) return `${label} is already running.`;
    const ch = state.channelId ? ` in ${channelMention(state.channelId)}` : "";
    const by = state.creatorId ? ` (started by ${mention(state.creatorId)})` : "";
    return `⚠️ ${label} is already running${ch}${by}.\nTry \`!${id}status\` or \`!${id}help\`.`;
  }

  function noActiveText() {
    return `No active ${label}.\nTry \`!${id}\` to start or \`!${id}help\` for commands.`;
  }

  function tryStart(ctx, initState) {
    const existing = getState(ctx);
    if (existing) return { ok: false, errorText: alreadyRunningText(existing) };

    const st = {
      ...initState,
      createdAtMs: initState?.createdAtMs ?? nowMs(),
    };

    if (!st.timers) st.timers = new TimerBag();

    setState(ctx, st);
    return { ok: true, state: st };
  }

  function stop(ctx) {
    const st = getState(ctx);
    if (st?.contestRoleAssignment) {
      void cleanupContestRoleAssignment(st);
    }
    if (st?.timers?.clearAll) st.timers.clearAll();
    clearState(ctx);
    return st;
  }

  function isSameChannel(ctx, state) {
    const channelId = ctx?.channelId || ctx?.message?.channelId || ctx?.interaction?.channelId;
    if (!state?.channelId) return true;
    return state.channelId === channelId;
  }

  return {
    id,
    label,
    scope,
    getState,
    setState,
    clearState,
    isActive,
    tryStart,
    stop,
    isSameChannel,
    alreadyRunningText,
    noActiveText,
  };
}

/* ----------------------------- common guardrails ---------------------------- */

export async function requireSameChannel(ctx, state, manager) {
  if (!state) return true;
  if (manager?.isSameChannel?.(ctx, state)) return true;

  const expected = state.channelId ? channelMention(state.channelId) : "the game channel";
  await reply(ctx, `🚫 This game is running in ${expected}. Please use commands there.`);
  return false;
}

export async function requireActive(ctx, manager) {
  const st = manager.getState(ctx);
  if (st) return st;
  await reply(ctx, manager.noActiveText());
  return null;
}

/**
 * Enforce manage permission (owner or admin).
 * Supports custom deniedText so games can keep their phrasing.
 */
export async function requireCanManage(
  ctx,
  state,
  { ownerField = "creatorId", managerLabel = "game", deniedText = null } = {}
) {
  if (canManageCtx(ctx, state, ownerField)) return true;
  await reply(ctx, deniedText || `🚫 Only the host/admin can manage this ${managerLabel}.`);
  return false;
}

/* ------------------------ main-command subcommands ------------------------- */

/**
 * Wrap a game's *primary* command handler (e.g. "!blackjack") so it consistently supports:
 * - "!<game> help"
 * - "!<game> rules"
 * - (optional) "!<game> status"
 *
 * Everything else is passed through to `onStart`.
 */
export function withGameSubcommands({
  helpText,
  rulesText,
  onStart,
  onStatus,
  allowStatusSubcommand = true,
  helpAliases = ["help", "h", "?"],
  rulesAliases = ["rules", "rule", "how", "howto"],
  statusAliases = ["status"],
} = {}) {
  if (typeof onStart !== "function") {
    throw new Error("withGameSubcommands requires an onStart({message,rest}) function");
  }

  return async ({ message, rest }) => {
    const raw = String(rest ?? "").trim();
    const a = raw.toLowerCase();

    if (helpAliases.includes(a)) {
      await reply({ message }, helpText || "No help available.");
      return;
    }

    if (rulesAliases.includes(a)) {
      await reply({ message }, rulesText || "No rules available.");
      return;
    }

    if (allowStatusSubcommand && statusAliases.includes(a)) {
      if (typeof onStatus === "function") return await onStatus({ message });
      await reply({ message }, "Try the `!<game>status` command.");
      return;
    }

    return await onStart({ message, rest });
  };
}

/**
 * Back-compat / nicer naming: this is the same thing as withGameSubcommands.
 * Use whichever name you prefer in game files.
 */
export const withQoLSubcommands = withGameSubcommands;

/* ------------------------- QoL command bundle helper ------------------------ */

export function makeGameQoL(
  register,
  {
    manager,
    id,
    prettyName,
    helpText,
    rulesText,
    renderStatus,
    cancel,
    end,
    manageDeniedText = null,
  } = {}
) {
  const label = prettyName || id || manager?.label || "game";

  // Help (NOT primary)
  register(
    `!${id}help`,
    async ({ message }) => {
      await reply({ message }, helpText || `No help text available for ${label}.`);
    },
    `• !${id}help — show ${label} help`,
    { helpTier: "normal" }
  );

  // Rules (NOT primary)
  register(
    `!${id}rules`,
    async ({ message }) => {
      await reply({ message }, rulesText || `No rules text available for ${label}.`);
    },
    `• !${id}rules — show ${label} rules`,
    { helpTier: "normal" }
  );

  // Status (NOT primary)
  register(
    `!${id}status`,
    async ({ message }) => {
      const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!st) {
        await reply({ message }, manager.noActiveText());
        return;
      }
      if (!(await requireSameChannel({ message }, st, manager))) return;

      const text =
        typeof renderStatus === "function"
          ? renderStatus(st, { message })
          : `✅ ${label} is running in ${channelMention(st.channelId)}.`;
      await reply({ message }, text);
    },
    `• !${id}status — show ${label} status`,
    { helpTier: "normal" }
  );

  // Cancel (NOT primary)
  register(
    `!cancel${id}`,
    async ({ message }) => {
      const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
      if (!st) {
        await reply({ message }, manager.noActiveText());
        return;
      }
      if (!(await requireSameChannel({ message }, st, manager))) return;

      const ok = await requireCanManage(
        { message },
        st,
        {
          ownerField: st.hostId ? "hostId" : "creatorId",
          managerLabel: label,
          deniedText: manageDeniedText || null,
        }
      );
      if (!ok) return;

      if (typeof cancel === "function") {
        await cancel(st, { message, manager });
      } else {
        manager.stop({ message, guildId: message.guildId });
        await reply({ message }, `🛑 ${label} cancelled.`);
      }
    },
    `• !cancel${id} — cancel the current ${label}`,
    { helpTier: "normal" }
  );

  // Optional hard-end alias (hidden)
  if (end) {
    register(
      `!end${id}`,
      async ({ message }) => {
        const st = manager.getState({ message, guildId: message.guildId, channelId: message.channelId });
        if (!st) {
          await reply({ message }, manager.noActiveText());
          return;
        }
        if (!(await requireSameChannel({ message }, st, manager))) return;

        const ok = await requireCanManage(
          { message },
          st,
          {
            ownerField: st.hostId ? "hostId" : "creatorId",
            managerLabel: label,
            deniedText: manageDeniedText || null,
          }
        );
        if (!ok) return;

        await end(st, { message, manager });
      },
      `• !end${id} — end the current ${label}`,
      { admin: false, hideFromHelp: true }
    );
  }
}
