// shared/time_utils.js
//
// Time parsing helpers shared across modules.

/**
 * Parses:
 *  - "30" => 30
 *  - "10s", "10sec", "10seconds"
 *  - "5m", "5min", "5minutes"
 *  - "2h", "2hr", "2hours"
 *
 * Returns:
 *  - number (seconds) on success
 *  - null on invalid
 *  - def if raw is falsy
 */
export function parseDurationSeconds(raw, def) {
  if (!raw) return def;
  const s = String(raw).trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);

  const m = s.match(
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/
  );
  if (!m) return null;

  const v = Number(m[1]);
  const u = m[2];
  if (u.startsWith("s")) return v;
  if (u.startsWith("m")) return v * 60;
  if (u.startsWith("h")) return v * 3600;
  return null;
}

export function formatDurationSeconds(sec) {
  return sec ? `${sec}s` : "NONE";
}
