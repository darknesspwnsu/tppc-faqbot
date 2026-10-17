// Defaults until the real Discord IDs are supplied. Runtime overrides are
// stored per guild; only privileged users or that guild's host can change them.
export const ADVENT_DEFAULTS = {
  roleId: "00000",
  channelId: "11111", // Public Advent claim thread
  hostId: "22222",
};

// Optional checked-in defaults for individual servers.
export const ADVENT_BY_GUILD = {};

// Production dates are fixed. The identified dev bot can opt into a test period.
export const ADVENT_TIME_ZONE = "America/New_York";
export const ADVENT_FIRST_DAY = 1;
export const ADVENT_LAST_DAY = 24;
export const ADVENT_DEFAULT_PERIOD = Object.freeze({
  startMonth: 12, startDay: ADVENT_FIRST_DAY,
  endMonth: 12, endDay: ADVENT_LAST_DAY, devOverride: false,
});
export const ADVENT_DEV_BOT_ID = "1453323573220348017";

export function getAdventClaimPeriod(botId, env = process.env) {
  const raw = String(env.ADVENT_DEV_CLAIM_PERIOD || "").trim();
  // Use the authenticated client identity, never a nickname or a caller's ID.
  if (String(botId) !== ADVENT_DEV_BOT_ID || !raw) return ADVENT_DEFAULT_PERIOD;
  const match = /^(\d{2})-(\d{2})\.\.(\d{2})-(\d{2})$/.exec(raw);
  const [startMonth, startDay, endMonth, endDay] = match ? match.slice(1).map(Number) : [];
  const validDay = (month, day) => month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(2000, month, 0)).getUTCDate();
  if (!match || !validDay(startMonth, startDay) || !validDay(endMonth, endDay) ||
      startMonth * 100 + startDay > endMonth * 100 + endDay) {
    throw new Error("Invalid ADVENT_DEV_CLAIM_PERIOD. Use MM-DD..MM-DD within one calendar year, for example 10-01..10-25.");
  }
  return { startMonth, startDay, endMonth, endDay, devOverride: true };
}
