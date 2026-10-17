// Defaults until the real Discord IDs are supplied. Runtime overrides are
// stored per guild; only privileged users or that guild's host can change them.
export const ADVENT_DEFAULTS = {
  roleId: "00000",
  channelId: "11111", // Public Advent claim thread
  hostId: "22222",
};

// Optional checked-in defaults for individual servers.
export const ADVENT_BY_GUILD = {};

// Dates are deliberately fixed rather than configurable at runtime.
export const ADVENT_TIME_ZONE = "America/New_York";
export const ADVENT_FIRST_DAY = 1;
export const ADVENT_LAST_DAY = 24;
