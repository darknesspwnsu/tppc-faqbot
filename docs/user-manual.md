# Spectreon User Manual

This manual documents all user-facing and admin-facing features, commands, options, and common responses. It is written for both general users and server staff. Admin-only commands are listed in the **Admin Appendix** and referenced where relevant.

---

## Table of Contents

1. General Behavior & Conventions
2. Getting Started
3. Info Commands
4. Verification Commands
5. RPG Commands
6. Trades & IDs
7. Tools & Utilities
8. Contests
9. Games
10. Fun / Toybox
11. Admin Appendix
12. Troubleshooting & Common Errors

---

## 1) General Behavior & Conventions

- **Bang commands** use `!command` (some also support `?command`).
- **Slash commands** use `/command` and often respond **ephemerally** (private), especially for admin or account actions.
- **Permissions**: some commands require admin/privileged users. These are listed in the **Admin Appendix**.
- **DM behavior**: features that DM you can fail if your DMs are closed. You’ll usually see a friendly error.
- **Input parsing**: commands are generally case-insensitive for keywords; Pokémon names are tolerant of form prefixes (s/d/g) in many RPG tools.

**Common error patterns:**
- Missing arguments often return a short usage guide.
- Invalid arguments usually return a specific error (e.g., “Unknown Pokémon name”, “Invalid argument”, “Usage: …”).
- Some lookup-style commands respond silently if no results are found.

---

## 2) Getting Started

- Use `/help` to open the private help menu (best starting point).
- Use `!help categories` or `!help allcategories` to see public categories.
- Use `/verifyme` to link your TPPC forums account (if your server has verification enabled).
- Use `!id add <number>` to save your TPPC RPG ID for use by other commands.

---

## 3) Info Commands

### `/help`
**What it does:** Private, interactive help menu with categorized commands.
- **Usage:** `/help` or `/help category:<Category>`
- **Invalid input:** If the category is unknown, it falls back to the default page.

### `!help` (aliases: `!helpme`, `!h`)
**What it does:** Public help.
- `!help` → redirects to `/help`.
- `!help <category>` → shows that category publicly (Admin category is hidden).
- `!help categories` → list public categories.
- **Invalid input:** `Unknown help category` message.

### `!faq <question>`
Ask the FAQ bot a specific question.
- **Example:** `!faq how do I goldenize?`
- **Missing input:** prompts you to ask a specific question + provides FAQ link.
- **No confident match:** may not respond.

### `!wiki <term>` (alias: `!w`)
Searches the TPPC wiki and posts matching links.
- **Missing input:** no response.
- **No matches:** no response.

### `!ng` / `!ngs`
Shows the current NG list.
- **No NGs:** no response.

### `!rules [discord|rpg|forums]`
Returns relevant rules links.
- **No argument:** lists all rule links.
- **Invalid argument:** replies with usage.

### `!glossary <term>` (alias: `!g`)
Looks up a glossary term.
- **Missing input:** no response.
- **Unknown term:** no response.

### `!events` and `/events`
Shows current and upcoming TPPC events.
- `!events` → next 2 months
- `!events all` or `/events all` → all events
- `!events help` → detailed help + subscription instructions

**Notes:**
- Events list shows **Active** and **Upcoming** sections.
- Recurring events are marked with `*` and explained in the footer.
- Random events show “timing varies”.

### `/subscriptions` (Event subscriptions)
Manage event subscriptions (DMs required).
- `subscribe event_ids:<id[,id]>` (supports `all`)
- `unsubscribe event_ids:<id[,id]>`
- `unsub_all`
- `list`

**Examples:**
- `/subscriptions subscribe event_ids:scatterbug,deerling`
- `/subscriptions subscribe event_ids:discord_announcements`

**Invalid / edge cases:**
- Unknown IDs → “Unknown event IDs: …”
- No active subs on unsubscribe/unsub_all → “You have no active subscriptions.”
- Re-subscribing → “You are already subscribed to those event(s).”

**Admin announcements subscription:**
- `discord_announcements` forwards official staff announcements via DM.

---

## 4) Verification Commands

### `/verifyme`
Links your TPPC forums account for server verification.

**Usage (choose exactly one):**\n
- `/verifyme username:<forums username>` — bot sends you a forum PM with a code\n
- `/verifyme securitytoken:<code>` — submit the code you received\n

**Common responses:**\n
- If verification isn’t configured: “Verification is not configured for this server.”\n
- If both or neither options provided: usage guidance\n
- If already verified: confirms you don’t need to verify again\n
- If DM fails: you’ll receive an ephemeral warning\n

### `/whois`
Looks up what forums account a Discord user is verified as.
- **Usage:** `/whois user:@user`\n
- **Response:** verified forum username, or “not verified.”\n

### `/unverify` (Admin/Privileged)
See **Admin Appendix**.

---

## 5) RPG Commands

### `!leaderboard` (aliases: `!ld`, `!lb`, `!leader`)
Fetches TPPC leaderboards.
- **Usage (standings):**
  - `!lb ssanne`
  - `!lb safarizone`
  - `!lb tc`
  - `!lb roulette` or `!lb roulette weekly`
  - `!lb speedtower`
  - `!lb trainers [1-20]`
  - `!lb pokemon <name> [1-20]` or `!lb poke <name> [1-20]`
- **History:**
  - `!lb ssanne history`
  - `!lb tc history`
  - `!lb roulette history`
  - `!lb roulette weekly history`
  - `!lb speedtower history`

**Invalid input:**
- Unknown subcommand → usage block
- Invalid count (not 1–20) → error
- History for trainers/pokemon → “History is not tracked for this challenge.”

### `!powerplant`
Shows current TPPC power plant control.

### `/findmyid`
Find TPPC RPG trainer IDs by name.
- **Usage:** `/findmyid name:<trainer name>`

### `!pokedex` (aliases: `!dex`, `!pd`)
Fetches TPPC pokedex info (stats, types, egg groups, sprites, breeding time).
- Supports forms and modifiers (shiny/dark/golden), including Mega and regional forms.
- Shows egg time based on base evolution.

**Common responses:**
- `Unknown Pokémon name` + “Did you mean” buttons (clickable).

### `!stats <pokemon>`
Returns stats only (text). Includes total base stats (unmodified).

### `!eggtime <pokemon>` (aliases: `!egg`, `!eggtimes`, `!breedtime`, `!breedtimes`)
Returns breeding time (normal + Power Plant).
- Shows base evolution used for calculation.

### `/viewbox` (and `!viewbox` if available)
DMs a trainer’s Pokémon box.
- Returns a header: “Viewing box contents for … (RPG username: … | RPG ID: …)”
- If DMs are closed: you’ll receive a friendly ephemeral error.

### `!rpginfo`
RPG informational helpers.
- `!rpginfo ssanne` → battles needed for Golden Volcanion
- `!rpginfo tc` → current Training Challenge ineligible list
- `!rpginfo tc eligible <pokemon>` (or `iseligible`) → checks TC eligibility

**Eligibility logic:**
- If base evolution is banned → ineligible
- If base evolution not banned → “might be eligible if it evolves through the Pokémon Center”
- Non-existent Pokémon → error

---

## 6) Trades & IDs

### `!id` (and `/id`)
Save and look up TPPC IDs.

**Bang usage:**
- `!id add <number> [label]`
- `!id del` (delete all)
- `!id del <id|label>`
- `!id setdefault <id|label>`
- `!id` (default ID)
- `!id all` (list all)
- `!id <label>` (lookup label)
- `!id @user` / `!id @user all` / `!id @user <label>`

**Slash usage:**
- `/id action:<add|del|delall|get|list|setdefault> value:<id> label:<label> target:<id|label> user:<user> users:<mentions>`

**Rules:**
- Max 5 IDs per user
- Labels: letters/numbers/underscore/hyphen, 1–20 chars
- Reserved labels: `all`, `help`

**Invalid input:**
- Bad ID or label → returns usage or validation error

---

## 7) Tools & Utilities

### `!rarity` and related
Rarity tools (including comparison, reload, and rarity4).
Common commands:
- `!rarity <pokemon>`
- `!rc <pokemonA> <pokemonB>` (comparison)
- `!rarityreload` (admin/privileged)
- `!rarity4reload` (admin)

**Invalid input:**
- Unknown Pokémon → error
- Same Pokémon comparison → error

### `!p` (Promo)
Shows the current weekly promo Pokémon/item.
- **Usage:** `!p`
- **Admin:** `!setpromo <text>` (see Admin Appendix)

### `!links` / `!link` / `!short` (tools/links)
Quick link shortcuts (see response list). Some are aliases.

### `!calculator` / `!calc`
Multi-purpose calculations (game/tool specific). Follow prompts and usage output.

### Message counts (`!count` / `!activity` / `!yap`)
Tracks message counts in configured channels.
- `!count` → your count
- `!count @user` → user count
- `!count leaderboard` → top 10
- `!count overall` → includes migrated Flareon counts (if available)
- `!count leaderboard overall` → combined

**Admin:** `/resetcount` → reset all counters (confirmation required)

### Reminders & NotifyMe
- `/notifyme set <phrase>` — DM when phrase appears in guild
- `/notifyme list`
- `/notifyme unset <dropdown>`
- `/notifyme clear` — clear all for this server

- `/remindme set phrase:<phrase> <time>`
- `/remindme set messageID:<id> <time>`
- `/remindme list`
- `/remindme unset <dropdown>`
- `/remindme clear` — clear all reminders

**Rules:**
- Max 10 reminders/notifications (admins/privileged exempt)
- NotifyMe is **guild-scoped**
- RemindMe works in servers; message IDs must be in a server the bot can access
- DM permission is required; bot tests DMs and warns if it cannot DM you

---

## 8) Contests

### `!contest` (umbrella)
Hosts multiple contest types with subcommands.
- `!contest choose <duration>`
- `!contest roll <duration>`
- `!contest start <duration>`
- `!contest list`
- (See in-command help output for full options)

### Giveaways (`/giveaway`)
Subcommands: `create`, `list`, `end`, `delete`, `reroll`
- Button-based entry
- Admin/privileged only for create/end/delete/reroll
- `/giveaway list` shows active giveaways with links
- Reroll does not re-upload summary file

### Poll contests (`/pollcontest`)
Creates or manages poll contests (admin/privileged).

### Whispers (`/whisper`)
Case‑insensitive phrase triggers that notify staff or log internally.
Subcommands:
- `/whisper add` — add a phrase to listen for (case-insensitive)\n
- `/whisper list` — list current phrases\n
- `/whisper delete` — remove a phrase (case-insensitive)\n

### Reading contests / RNG / Reaction contests
Hosted by contest admins. See command help for prompts and formats.

**Common invalid responses:**
- Missing duration → usage hint
- Permission failure → “You do not have permission…”

---

## 9) Games

Game commands generally follow a `!game` and `!game help` pattern. Many support in-channel prompts and timers.

**Examples:**
- `!hangman`, `/hangman`
- `!pokemonunscramble`, `/pokemonunscramble`
- `!blackjack`
- `!rps`
- `!bingo`
- `!deal` (Deal or No Deal)
- `!safari` / `!safarizone`
- `!voltorb` / `!electrode` (exploding games)
- `!auction`
- `!higherorlower`
- `!closestrollwins`
- `!mafia`

**Invalid input:**
- Wrong phase or missing params → prompt or help text.

---

## 10) Fun / Toybox

Commands for lightweight utilities or fun responses.
- `!toybox` commands (see help output)
- Additional fun aliases registered in `toybox.js`

---

## 11) Admin Appendix (Admin/Privileged Only)

These commands are hidden from public help and only visible in the private admin panel.

### Admin / Info
- `!faqreload` — reloads `faq.json`
- `!rarity4reload` — refresh rarity4 cache
- `!setpromo <text>` — set promo manually
- `/unverify` — remove verification for a user
- `/getforumlist` — scrape TPPC forum thread and DM list
- `/pollcontest` — manage poll contests (admin/priv)

### Admin / Tools
- `!exportmetrics` / `!export` — export metrics snapshot
- `/resetcount` — reset message counts (confirmation required)

---

## 12) Troubleshooting & Common Errors

- **No response from a command:**
  - Check bot permissions in the channel.
  - Some lookup commands intentionally stay silent if no match is found.

- **“The application did not respond”**
  - This can happen if a slash command takes too long without deferring. The bot may still have completed the action.

- **DM failures:**
  - Ensure “Allow direct messages from server members” is enabled.

- **Unknown Pokémon name:**
  - Use correct spelling; “Did you mean” buttons appear for near matches.

- **Permission errors:**
  - Admin/privileged commands are restricted and may not be visible in public help.

---

## Admin‑Only Note in Public Sections

Whenever you see a command labeled as admin/privileged, its full details are in the **Admin Appendix**. Public help will not show these commands in public category listings.
