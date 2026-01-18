// games/helpers.js
//
// Shared helpers for game modules (parsers/formatters).

import { clampInt, reply } from "./framework.js";
import {
  parseMentionToken as parseMentionTokenShared,
  getMentionedUsers as getMentionedUsersShared,
} from "../shared/mentions.js";

/**
 * Parses "min-max" numeric ranges (accepts hyphen/en-dash/em-dash).
 * Returns { min, max } on success, or null on failure.
 */
export function parseMinMaxRangeToken(token) {
  const m = String(token ?? "")
    .trim()
    .match(/^(\d+)\s*[-–—]\s*(\d+)$/);
  if (!m) return null;

  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  return { min, max };
}

/**
 * Parses a Discord mention token like "<@123>" or "<@!123>".
 * Returns the user id string or null.
 */
export function parseMentionToken(token) {
  return parseMentionTokenShared(token);
}

/**
 * Returns an array of mentioned users from a message object.
 */
export function getMentionedUsers(message) {
  return getMentionedUsersShared(message);
}

/**
 * Registers "!<id>help" and "!<id>rules" commands with consistent behavior.
 */
export function registerHelpAndRules(register, { id, label, helpText, rulesText } = {}) {
  const gameLabel = label || id || "game";

  register(
    `!${id}help`,
    async ({ message }) => {
      await reply({ message }, helpText || `No help text available for ${gameLabel}.`);
    },
    `• !${id}help — show ${gameLabel} help`,
    { helpTier: "normal" }
  );

  register(
    `!${id}rules`,
    async ({ message }) => {
      await reply({ message }, rulesText || `No rules text available for ${gameLabel}.`);
    },
    `• !${id}rules — show ${gameLabel} rules`,
    { helpTier: "normal" }
  );
}

/**
 * Validates join/max options for reaction-join flows.
 * Returns { ok: true, joinSeconds, maxPlayers } or { ok:false, err }.
 */
export function validateJoinAndMaxForMode({
  hasMentions,
  joinSeconds,
  maxPlayers,
  defaultJoinSeconds,
  joinMin,
  joinMax,
  maxMin,
  maxMax,
  mentionErrorText,
  joinErrorText,
  maxErrorText,
} = {}) {
  if (hasMentions) {
    if (joinSeconds != null || maxPlayers != null) {
      return { ok: false, err: mentionErrorText };
    }
    return { ok: true, joinSeconds: null, maxPlayers: null };
  }

  const join = clampInt(joinSeconds ?? defaultJoinSeconds, joinMin, joinMax);
  if (!join) return { ok: false, err: joinErrorText };

  let max = null;
  if (maxPlayers != null) {
    max = clampInt(maxPlayers, maxMin, maxMax);
    if (!max) return { ok: false, err: maxErrorText };
  }

  return { ok: true, joinSeconds: join, maxPlayers: max };
}
