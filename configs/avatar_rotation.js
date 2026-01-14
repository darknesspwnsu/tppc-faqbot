// configs/avatar_rotation.js
//
// Date-range based avatar rotation for the Discord bot.
// Rules are evaluated in order; the first match wins.
// Months are 0-based (0 = January).

export const AVATAR_ROTATION_ENABLED = true;

export const AVATAR_ROTATION_RULES = [
  {
    id: "new_year",
    ranges: [{ start: { month: 0, day: 1 }, end: { month: 0, day: 31 } }],
    file: "assets/avatars/new_year.png",
  },
  {
    id: "st_patricks_day",
    ranges: [{ start: { month: 2, day: 17 }, end: { month: 2, day: 17 } }],
    file: "assets/avatars/st_patricks.png",
  },
  {
    id: "april_fools_day",
    ranges: [{ start: { month: 3, day: 1 }, end: { month: 3, day: 1 } }],
    file: "assets/avatars/april_fools.png",
  },
  {
    id: "halloween_promo",
    ranges: [{ start: { month: 9, day: 15 }, end: { month: 9, day: 31 } }],
    file: "assets/avatars/halloween_promo.png",
  },
  {
    id: "christmas",
    ranges: [{ start: { month: 11, day: 1 }, end: { month: 11, day: 31 } }],
    file: "assets/avatars/christmas.png",
  },
  {
    id: "default",
    ranges: [{ start: { month: 0, day: 1 }, end: { month: 11, day: 31 } }],
    file: "assets/avatars/default.png",
  },
];
