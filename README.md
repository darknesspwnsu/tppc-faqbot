# TPPC Discord Utility Bot — Spectreon

**Spectreon** is a modular Discord bot built for **TPPC community servers**, providing
utilities, contests, and multiplayer games with strict consistency, deterministic rules,
and per-guild configurability.

The bot is designed to scale across **multiple servers** without command collisions,
spam, or ambiguity.

---

## ✨ Core Philosophy

- **Explicit commands only** (`!cmd`, `?cmd`, or `/cmd`)
- **One active game per guild**
- **Deterministic behavior**
- **Low-noise UX (silent ignores where configured)**
- **Per-guild command exposure control**
- **Automatically generated help**

---

## 🧩 Key Features

### 🧰 Utilities
- Trading (`FT`) and Looking-For (`LF`) lists (DB-backed)
- TPPC ID storage & lookup
- Rarity lookups (live GitHub Pages JSON)
- Level-4 rarity stats
- Rarity comparison & history charts
- Wiki lookups (local index, Cloudflare-safe)
- FAQ system with fuzzy matching
- Promo tracking (`!promo` / `!setpromo`)
- RPG tools: leaderboards, power plant status, ID/box lookup, pokedex + stats + egg time
- Viewbox DMs with graceful failure handling when DMs are closed

---

### 🎲 Contests
- Advent: public daily claims December 1–24, per-server role/thread/host settings, dated DM reports, and role counts
- Trivia: varied Pokémon and TPPC multiple-choice rounds, first-answer locking, scoring, and [documented question sources](docs/trivia-sources.md)
- RNG tools: `roll`, `choose`, `elim`, `awesome`
- Reaction-based contests (`choose` supports `winners=<n>`, default 1)
- Whispers (hidden phrases + optional prizes)
- Giveaways (button-based entries, reroll/end/delete/list, summary file)
- Reading & forum list helpers
- Contest helpers reused by games where applicable

---

### 🎮 Games

All games share a **common framework**:
- Reaction-join **or** tagged players
- Per-turn timers with skip handling
- Host-controlled lifecycle
- Deterministic resolution

Current games include:

- **Exploding Voltorbs**
- **Exploding Electrode**
- **Safari Zone**
- **Bingo**
- **Blackjack**
- **Closest Roll Wins**
- **Higher or Lower**
- **Rock Paper Scissors**
- **Hangman**
- **Deal or No Deal**
- **Auction**
- **Mafia** (lightweight, host-driven)

Only **primary game commands** appear in help to avoid clutter.

---

## 📘 Help System

- `!help` — public, truncated preview (safe under 2000 chars)
- `/help` — full interactive help menu (ephemeral)
- Commands are grouped by category
- Per-guild exposure is respected automatically (wrong prefix is silent)
- Admin-only commands are hidden from non-admins

---

## ⚙️ Command Exposure Model

Each logical command can be exposed as:

- `bang` → `!command`
- `q` → `?command`
- `off` → disabled

Wrong-prefix usage is silently ignored by design. This is controlled in `configs/command_exposure.js`.

This prevents collisions with other bots **without breaking muscle memory**.

> **Important:**  
> A command is *never* exposed as both `!` and `?` at the same time.

Slash command exposure can be controlled per guild in `configs/command_exposure.js`.

---

## 🗂 Project Structure

```

.
├── bot.js                    # Discord client + lifecycle
├── commands.js               # Unified command registry
├── info/helpbox.js           # !help and /help UI
├── info/faq.js               # FAQ + wiki commands
├── info/wiki.js              # Wiki index/search
├── auth.js                   # Admin / privileged checks
├── db.js                     # MySQL persistence
├── tools/                    # TPPC tools & promo system
├── trades/                   # FT / LF / ID commands
├── tools/rarity.js           # Rarity, comparisons, history
├── rpg/                      # RPG utilities (leaderboards, power plant, pokedex, viewbox)
├── scripts/                  # One-off generators and tooling
├── contests/
│   ├── contests.js           # Contest module registry
│   ├── rng.js
│   ├── reaction_contests.js
│   ├── whispers.js
│   ├── giveaway.js
│   ├── helpers.js
│   └── ...
├── games/
│   ├── games.js              # Game registry
│   ├── exploding_voltorbs.js
│   ├── blackjack.js
│   ├── auction.js
│   └── ...
├── verification/
│   ├── verification.js
│   ├── verifyme.js
│   └── whois.js
├── configs/
│   └── command_exposure.js
├── shared/
│   └── time_utils.js
├── shared/
│   └── pokename_utils.js
├── data/
│   ├── wiki_data.json
│   ├── pokedex_map.json
│   ├── pokemon_evolutions.json
│   └── privileged_users.json
└── .env.example

````

---

## 🧪 Requirements

MarketPoll data can be audited with `npm run marketpoll:audit -- --env /secure/path/production.env`.
See [the audit guide](docs/marketpoll-audit.md) for read-only production access, options, and report outputs.

- **Node.js 20.19+** (22 LTS recommended; `.nvmrc` pinned to `22.12.0`)
- **Discord.js v14**
- **MySQL / MariaDB** (required for most features)
- Discord bot permissions:
  - Read Messages
  - Send Messages
  - Add Reactions
  - Manage Messages (recommended for games)

---

## 🚀 Setup

```bash
npm install
cp .env.example .env
# fill in env values
npm start
````

Optional Docker helpers (macOS):
- `npm run start:dev:docker` — starts Docker Desktop, ensures `tppc-mysql` is running, then runs `start:dev`.
- `npm run stop:dev:docker` — stops the dev bot, stops `tppc-mysql`, and quits Docker Desktop.

---

## 🌱 Environment Variables

See `.env.example` for the canonical list.

Common variables:

| Variable                      | Description                         |
| ----------------------------- | ----------------------------------- |
| `DISCORD_TOKEN`               | **Required** bot token              |
| `ALLOWED_CHANNEL_IDS`         | Optional channel allowlist          |
| `SLASH_GUILD_ID`              | Guild-only slash registration (dev) |
| `BOT_DEFAULT_NICKNAME`        | Default guild nickname for this deployment |
| `BOT_NICKNAME_OVERRIDE`       | Force a nickname regardless of seasonal rules |
| `ADVENT_DEV_CLAIM_PERIOD`     | Dev bot only: inclusive test dates, e.g. `10-01..10-25`; production ignores it |
| `DB_HOST / DB_USER / DB_NAME` | MySQL connection                    |
| `RARITY_JSON_URL`             | Live rarity JSON source             |
| `RARITY_REFRESH_MS`           | Retry interval during refresh window |
| `RARITY_REFRESH_WINDOW_MINUTES` | Morning retry window length       |
| `RARITY_DAILY_REFRESH_ET`     | Daily refresh time (ET)             |

---

## 🧠 Database Usage

The bot automatically creates required tables:

* `user_ids` — TPPC IDs
* `user_texts` — FT/LF lists, promos, whispers
* `rpg_leaderboards` — cached RPG leaderboards
* `rpg_pokedex` — cached pokedex payloads
* `contests` / `contest_entries` — giveaways and contest state
* `advent_settings` / `advent_claims` — per-server Advent settings and permanent daily claim history

If DB is unavailable, some features safely degrade (e.g. promos fall back to memory).

---

## 📦 Deployment (Production)

```bash
git clone <repo>
cd <repo>
npm ci
cp .env.example .env
nano .env
npm start
```

Recommended process manager:

```bash
pm2 start bot.js --name spectreon
pm2 save
pm2 startup
```

---

## ➕ Adding New Commands

```js
register(
  "!example",
  async ({ message, rest }) => {
    await message.reply("Hello!");
  },
  "!example — says hello"
);
```

* Help text updates automatically
* Exposure rules are enforced automatically
* Categories propagate to help UI

---

## 🎯 Design Goals

* Predictable behavior
* Minimal moderator overhead
* Clean UX for both casual users and power users
* Easily extensible without rewriting core systems

## Cosmetic shop and list randomizer

Use `!shuffle` to randomize a public list, `!shop` to buy or refund cosmetic
roles with points, and `!shopadmin` to configure listings live.
See [setup and command examples](docs/cosmetic-shop.md).
