# TPPC Discord Utility Bot AKA Spectreon

A modular Discord bot for **TPPC community servers**, focused on **utilities**, **games**, and **contest tooling**.

Commands are explicit (prefixed with `!`) to avoid spam and false positives.
Slash commands (`/help`) are used for long-form or UI-heavy output.

---

## Key Features

### 🧰 Utilities

* Trading / Looking For lists
* ID lookup & storage
* Wiki lookup using a **local index** (Cloudflare-safe)
* FAQ system with fuzzy matching
* Rarity tools & calculators
* Custom helper utilities for TPPC gameplay

### 🎮 Games

Turn-based, multiplayer mini-games with:

* Reaction-join **or** tagged players
* Per-turn timers with skip handling
* One active game per guild
* Deterministic turn rules

Current games include:

* **Exploding Voltorbs**
* **Exploding Electrode**
* **Safari Zone** (grid-based prize hunt)

### 📘 Help System

* `!help` — short preview + redirect
* `/help` — full command list (no 2000-char limit)
* Admin-only commands hidden from non-admin users

---

## Project Structure

```
.
├── bot.js              # Discord client + event handlers
├── commands.js         # Command registry & dispatch
├── helpbox.js          # !help and /help logic
├── games/
│   ├── games.js        # Game registry
│   ├── exploding_voltorbs.js
│   ├── exploding_electrode.js
│   └── safari_zone.js
├── faq.js              # FAQ engine (fuzzy matching)
├── wiki.js             # Local TPPC wiki lookup
├── rarity.js           # Rarity utilities & commands
├── trades.js           # Trading / LF systems
├── contests.js         # Reaction-join helpers
├── tools.js            # Shared helpers
├── data/
│   ├── wiki_data.json
│   └── ngs.json
├── auth.js             # Admin / privilege checks
└── .env.example
```

---

## Requirements

* **Node.js 20+** (21+ fine)
* A Discord Bot Token (Discord Developer Portal)
* Permissions:

  * Read Messages
  * Send Messages
  * Add Reactions
  * Manage Messages (recommended for games)

---

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your values
npm start
```

---

## Environment Variables

See `.env.example` for the canonical list. Common settings include:

| Variable                  | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `DISCORD_TOKEN`           | **Required** bot token                          |
| `ALLOWED_CHANNEL_IDS`     | Comma-separated channel allowlist (empty = all) |
| `EVAL_COOLDOWN_MS`        | Cooldown for eval-style commands                |
| `TRADING_GUILD_ALLOWLIST` | Guilds allowed to use trading commands          |
| `RARITY_GUILD_ALLOWLIST`  | Guilds allowed to use rarity commands           |
| `DEFAULT_THRESHOLD`       | FAQ match confidence (0–1)                      |
| `NEAR_MISS_MIN/MAX`       | FAQ near-miss logging band                      |

---

## Commands Overview

### General

* `!help` — short preview + prompt to use `/help`
* `/help` — full command list
* `!roll NdM`
* `!choose option1 option2 ...`
* `!coinflip`
* `!awesome [@user]`

### TPPC Utilities

* `!wiki <term>` — TPPC wiki lookup
* `!faq <question>` — canned FAQ responses
* `!ng` — current New Goldens list
* `!rarity <pokemon>` — rarity lookup
* `!rc <pokemon1> <pokemon2>` — rarity comparison

### Trading

* `!ft`, `!lf` — trading / looking-for lists
* `!id` — save or lookup TPPC IDs

### Games

* `!ev` — Exploding Voltorbs
* `!ee` — Exploding Electrode
* `!sz` — Safari Zone

Games support:

* Tagged players **or** reaction-based join
* Turn timers (default 30s)
* Skip-on-timeout (players are not eliminated)
* Deterministic or random turn modes depending on game rules

### Admin

* `!faqreload`
* `!endsafari`, `!endev`, etc.
* Hidden from non-admin users in help output

---

## Help Philosophy

* `!help` is intentionally **short** to avoid Discord’s 2000-char limit
* `/help` is the authoritative, complete reference
* Help text is generated automatically from command registrations

---

## Updating Data

### Wiki Index

* Stored locally to avoid Cloudflare blocks
* Update the source JSON and restart

### NG List

Edit:

```json
["Glaceon", "Eevee"]
```

or:

```json
{ "ngs": ["Glaceon", "Eevee"] }
```

Then restart the bot.

---

## Deployment (VPS / Production)

```bash
git clone <repo>
cd <repo>
npm ci
cp .env.example .env
nano .env
npm start
```

Recommended: **PM2**

```bash
pm2 start bot.js --name tppc-bot
pm2 save
pm2 startup
```

---

## Adding New Commands

All commands are registered in `commands.js`:

```js
register(
  "!mycmd",
  async ({ message, rest }) => {
    await message.reply("You said: " + rest);
  },
  "!mycmd — does a thing"
);
```

Help output updates automatically.

---

## Design Goals

* Deterministic behavior
* Explicit commands
* No silent failures
* Scales with TPPC community needs
* Easy to extend without rewriting core systems

---

If you want, next step I can:

* Tighten wording further (more “public repo” tone vs dev tone)
* Add a **Games section with screenshots/examples**
* Split README into **User Guide** + **Developer Guide**

Just tell me how polished you want it.
