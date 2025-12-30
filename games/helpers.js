// games/helpers.js
//
// Shared helpers for game modules (parsers/formatters).

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
