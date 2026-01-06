// configs/rpg_events.js
//
// RPG event definitions and overrides.

export const RPG_EVENT_TIMEZONE = "America/New_York";

export const RPG_EVENTS = [
  {
    id: "august_golden_day",
    name: "August Golden Day",
    kind: "fixed_date",
    month: 8,
    day: 2,
    description: "Goldenize your Pokémon on August 2nd.",
  },
  {
    id: "winter_golden_day",
    name: "Winter Golden Days",
    kind: "winter_golden_days",
    description: "Goldenize your Pokémon on Dec 25 and Dec 31–Jan 1.",
  },
  {
    id: "team_rocket",
    name: "Team Rocket Takeover",
    kind: "radio_tower",
    description: "Radio Tower takeover with the Secret Key reward.",
  },
  {
    id: "cherubi",
    name: "Cherubi on Treepath",
    kind: "monthly_first",
    description: "Special Cherubi appears on Treepath on the first of each month.",
  },
  {
    id: "deerling",
    name: "Deerling on Treepath",
    kind: "seasonal_marker",
    description: "Deerling appears on equinox/solstice days.",
  },
  {
    id: "scatterbug",
    name: "Scatterbug Swarm",
    kind: "weekly",
    weekday: 6, // Saturday
    description: "Scatterbug swarm (24h).",
  },
  {
    id: "weekly_promo",
    name: "Weekly Promo Refresh",
    kind: "weekly",
    weekday: 0, // Sunday
    description: "Weekly TPPC promo refresh (Sunday midnight).",
  },
  {
    id: "halloween",
    name: "Halloween Event",
    kind: "fixed_date",
    month: 10,
    day: 31,
    description: "Seasonal Halloween event (usually).",
  },
  {
    id: "valentines",
    name: "Valentine's Event",
    kind: "fixed_date",
    month: 2,
    day: 14,
    description: "Seasonal Valentine’s event (usually).",
  },
  {
    id: "easter",
    name: "Easter Event",
    kind: "easter",
    description: "Seasonal Easter event (usually).",
  },
];

// Optional overrides (year -> { start, end }) in local ET date strings.
// Format: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm".
export const RPG_EVENT_OVERRIDES = {
  // halloween: { "2025": { start: "2025-10-25", end: "2025-10-31" } },
};
