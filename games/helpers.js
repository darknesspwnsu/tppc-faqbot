// games/helpers.js
//
// Shared helpers for game modules (parsers/formatters).

import { reply } from "./framework.js";

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
