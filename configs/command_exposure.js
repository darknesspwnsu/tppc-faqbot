// configs/command_exposure.js
//
// exposure:
//  - "bang" => only !cmd works
//  - "q"    => only ?cmd works
//  - "off"  => neither works
//
// Per your preference, we do NOT support "both".

export const DEFAULT_EXPOSURE = "bang";

export const COMMAND_EXPOSURE_BY_GUILD = {
  // Unofficial: flip collisions to ?
  "880141088722141294": {
    "rarity.main": "q",
    "rarity.l4": "q",
    "rng.awesome": "q",
    "rng.choose": "q",
    "rng.roll": "q",
    "trading.ft": "q",
    "trading.id": "q",
    "trading.lf": "q",
  },

  // Official: disable collisions entirely
  "329934860388925442": {
    "rarity.main": "bang",
    "rng.choose": "bang",
    "rng.elim": "bang",
    "rng.roll": "bang",
    "trading.ft": "bang",
    "trading.id": "bang",
    "trading.lf": "bang",
  },
};

// Optional per-command channel policy.
// If no policy exists, command is allowed in all channels.
//
// Shape:
//  COMMAND_CHANNEL_POLICY_BY_GUILD[guildId][logicalId] = {
//    allow?: string[];     // allowlist (if present, ONLY these channels)
//    deny?: string[];      // denylist
//    silent?: boolean;     // if blocked, silently ignore (default false)
//  }
export const COMMAND_CHANNEL_POLICY_BY_GUILD = {
  // Official server: restrict rng.awesome to specific channels
  "329934860388925442": {
    "rng.awesome": {
      allow: ["331114564966154240", "551243336187510784"],
      silent: true, // awesome should just do nothing if used elsewhere
    },
  },
};
