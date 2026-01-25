# Spectreon User Manual

This manual documents all user-facing and admin-facing features, commands, options, and common responses. It is written for both general users and server staff. Admin-only commands are listed in the **Admin Appendix** and referenced where relevant.

---

## Table of Contents

1. General Behavior & Conventions
2. Getting Started
3. Trades & IDs
4. Info Commands
5. Verification Commands
6. RPG Commands
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
- **Channel restrictions**: some commands are limited to specific channels per server; restricted commands may be silent or return a short warning.
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

## 3) Trades & IDs

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

### `!ft` / `!lf` (Trading lists)
Create and view “is trading” and “is looking for” lists.

**Usage:**
- `!ft add <list>` — save your trading list
- `!ft append <list>` — append to your trading list
- `!ft del` — clear your trading list
- `!ft [@user...]` — show trading list(s)
- `!lf add <list>` — save your looking‑for list
- `!lf append <list>` — append to your looking‑for list
- `!lf del` — clear your looking‑for list
- `!lf [@user...]` — show looking‑for list(s)

**Shortcuts:**
- `!ftadd <text>` → `!ft add <text>`
- `!ftdel` → `!ft del`
- `!lfadd <text>` → `!lf add <text>`
- `!lfdel` → `!lf del`

**Invalid input:**
- Missing list text on add → usage hint
- Clearing when empty → “Nothing to clear!”

---

## 4) Info Commands

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

## 5) Verification Commands

### `/verifyme`
Links your TPPC forums account for server verification.

**Usage (choose exactly one):**
- `/verifyme username:<forums username>` — bot sends you a forum PM with a code
- `/verifyme securitytoken:<code>` — submit the code you received

**Common responses:**
- If verification isn’t configured: “Verification is not configured for this server.”
- If both or neither options provided: usage guidance
- If already verified: confirms you don’t need to verify again
- If DM fails: you’ll receive an ephemeral warning

### `/whois`
Looks up what forums account a Discord user is verified as.
- **Usage:** `/whois user:@user`
- **Response:** verified forum username, or “not verified.”

### `/unverify` (Admin/Privileged)
See **Admin Appendix**.

---

## 6) RPG Commands

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
  - `!lb <customlb> [participant]` — custom leaderboard (top 5; quote names with spaces)
  - Admin: `!lb <customlb> --all` or `!lb <customlb> --10` (quote names with spaces)
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
 - Some sprite libraries have limited coverage (e.g., HGSS up to #493, Black/White up to #649).

**Common responses:**
- `Unknown Pokémon name` + “Did you mean” buttons (clickable).

### `!sprite` (aliases: `!pokesprite`, `!gif`)
Returns a TPPC sprite URL.
- `!sprite <pokemon> [xy|hgss|bw|blackwhite] [M|F]`
- If the requested library lacks coverage, you’ll get a helpful error.

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

## 7) Tools & Utilities

### `!rarity` and related
Rarity tools (including comparison, reload, and rarity4).
Common commands:
- `!rarity <pokemon>`
- `!rarity4 <pokemon>` (Level 4 rarity lookup)
- `!rc <pokemonA> <pokemonB>` (comparison)
- `!rarityreload` (admin/privileged)
- `!rarity4reload` (admin)

**Invalid input:**
- Unknown Pokémon → error
- Same Pokémon comparison → error

### `!promo` / `!p` (Promo)
Shows the current weekly promo Pokémon/item.
- **Usage:** `!promo` or `!p`
- **Admin:** `!setpromo <text>` (see Admin Appendix)

### `!links` / `!link` / `!short` (tools/links)
Quick link shortcuts (see response list). Some are aliases.

### `!calculator` / `!calc`
Multi-purpose calculations (game/tool specific). Follow prompts and usage output.

**Core functions:**
- `!calc l2e <level>` — Level → Exp
- `!calc l2eb <level>` — Level → Exp (billions)
- `!calc e2l <exp>` — Exp → Level
- `!calc eb2l <exp_in_billions>` — Exp (billions) → Level
- `!calc la <lvl...>` — Add levels → level
- `!calc ea <exp...>` — Add exp values → level
- `!calc eba <exp_bil...>` — Add exp values in billions → level
- `!calc ld <lvl1> <lvl2>` — Level difference → level
- `!calc buy <money>` — Buyer pays money → max affordable level (PP no/yes)
- `!calc buym <money_millions>` — Buyer pays (millions) → max affordable level
- `!calc sell <money>` — Seller receives money → max affordable level
- `!calc sellm <money_millions>` — Seller receives (millions) → max affordable level

**Examples:**
- `!calc l2e 125`
- `!calc eb2l 42.5`
- `!calc la 100 200 300`
- `!calc buy 500000000`

### `/sortbox`
Sorts a TPPC trainer box and DMs you BBCode as a text file.
- **Input:** `id` or `ids` (comma/space-separated). If omitted, uses saved IDs for you (or `user`).
- **Lookup:** `rpgusername` to resolve a trainer ID
- **Multiple IDs:** set `all_saved` or pass `ids`
- **Split output:** set `split_outputs` to DM one file per ID
- **Options:** combine dupes, plain levels, combine Shiny/Dark, dedicated Unknown/Legends, filter junk maps/swaps
- **Colors:** optional BBCode colors for gold/shiny/dark/normal names

### Message counts (`!count` / `!activity` / `!yap`)
Tracks message counts in configured channels (may include forum threads if your server configured them).
- `!count` → your count
- `!count @user` → user count
- `!count leaderboard` → top 10
- `!count overall` → includes migrated Flareon counts (if available)
- `!count leaderboard overall` → combined

**Admin:** `/resetcount` → reset all counters (confirmation required)

### Reminders & NotifyMe
- `/notifyme set <phrase>` — DM when phrase appears in guild
- `/notifyme list`
- `/notifyme unset <number from /notifyme list>`
- `/notifyme clear` — clear all for this server

- `/remindme set phrase:<phrase> <time>`
- `/remindme set messageID:<id> <time>`
- `/remindme set phrase:<phrase> at:<datetime>`
- `/remindme set messageID:<id> at:<datetime>`
- `/remindme list`
- `/remindme unset <number from /remindme list>`
- `/remindme clear` — clear all reminders

**Rules:**
- Max 10 reminders/notifications (admins/privileged exempt)
- NotifyMe is **guild-scoped**
- RemindMe works in servers; message IDs must be in a server the bot can access
- DM permission is required; bot tests DMs and warns if it cannot DM you
- `time` supports fractional values like `1.5h`
- `at:` accepts common formats like `2026-01-18 19:30`, `01/18/2026 7:30 PM`, `Jan 18 2026 7:30 PM`, or `7am tomorrow`
- Timezone defaults to America/New_York; add `UTC`, `ET`, or an offset like `-05:00` to override

---

## 8) Contests

### Reaction contests (`!conteststart` / `!contest` / `/contest`)
Runs a reaction‑based contest in the current channel (uses 👍). Admin/privileged or contest host only.

**Bang usage:**
- `!conteststart [list|choose|elim] <time> [quota] [winners] [prize=...] [require=verified]`
- Aliases: `!contest`, `!startcontest`
- `!cancelcontest` — cancel an active contest in this channel (host or admin)

**Slash usage:**
- `/contest mode:<list|choose|elim> time:<30sec|5min|1hour> quota:<N> winners:<N> prize:<text> require_verified:<true|false>`

**Notes:**
- `list` prints entrants, `choose` picks winners, `elim` runs elimination rounds.
- `require=verified` / `require_verified` enforces verified role + saved ID. Ineligible users receive a DM with steps; eligibility is re‑checked at draw time.

### Giveaways (`/giveaway`)
Subcommands: `create`, `list`, `end`, `delete`, `reroll`
- Button-based entry
- Admin/privileged only for create/end/delete/reroll
- `/giveaway create` supports `require_verified` to require verified role + saved ID
- `/giveaway list` shows active giveaways with links
- Reroll does not re-upload summary file

### Poll contests (`/pollcontest`)
Creates or manages poll contests (admin/privileged).

### Whispers (`/whisper`)
Case‑insensitive phrase triggers that notify staff or log internally.
Subcommands:
- `/whisper add` — add a phrase to listen for (case-insensitive)
- `/whisper list` — list current phrases
- `/whisper delete` — remove a phrase (case-insensitive)
**Limits:**
- Max 5 whispers per user (admins/privileged exempt)
- Max 256 characters per phrase

### Reading tracker (`!startReading` / `!endReading`)
Tracks unique responders in the current channel (admin/privileged only).
- `!startReading [phrase]` — optional phrase filter (case‑insensitive)
- `!endReading` — ends and prints the participant list (no pings)

### TPPC Lottery (`!lotto`)
Companion for the weekly forum lottery (admin starts tracking; users generate combos).
- `!lotto set <postnumber>` — start tracking from a forum post number (admin only)
- `!lotto` — generate a unique combo (reserved ~10 min; non‑admin cooldown ~10 min)
- `!lotto check 1 2 3` — check if a combo is already claimed
- `!lotto check --live 1 2 3` — force a live scrape (admin only)
- `!lotto status` — show tracking status + valid entrants
- `!lotto invalid` — list invalid forum entries (live scrape)
- `!lotto roll` — roll winning numbers (admin only)
- `!lotto reset` — stop tracking and clear cache (admin only)
- `!lotto rules` / `!lotto help`
- Alias: `!lottery`

**Notes:**
- Generated combos are reserved for ~10 minutes to avoid duplicates.
- `--live` is admin‑only; normal users get cached results.

### RNG utilities (`!roll`, `!choose`, `!elim`, `!coinflip`, `!awesome`)
Randomizers and eliminations (prefix may be `!` or `?` depending on server policy).
- `!roll NdM` — roll N numbers in range 1..M (example: `!roll 1d100`)
- `!choose a b c` — pick one option at random
- `!elim <1–30s> <items...>` — eliminate one item per round
- `?cancelelim` — cancel the active elimination (starter or admin)
- `!coinflip` — Heads/Tails
- `!awesome` — tells you how awesome someone is (0–101%)

### Custom leaderboards (`!customlb`)
Guild-scoped leaderboards with a custom metric label (admin/privileged).
- `!customlb create <lb_name> [metric]` — metric defaults to `Points`
- `!customlb help` — show usage and examples
- `!customlb list` — list active custom leaderboards
- `!customlb delete|del <lb_name>` — requires confirmation buttons
- `!customlb rename <old> <new> [metric]` — rename or update leaderboard name and/or metric name
- `!customlb entrant add <lb_name> <list>` — add entrants (starts at 0)
- `!customlb entrant delete <lb_name> <list>` — remove entrants
- `!customlb score set <lb_name> <name> <score>` — set a single score
- `!customlb score update <lb_name> <name> <delta> [name delta ...]` — increment/decrement

**Rules & syntax:**
- Admin/privileged only; non‑admin usage is ignored.
- Leaderboard names can include spaces; wrap them in quotes or use underscores.
- Metric names may include spaces.
- Participant lists support spaces or commas. Names with spaces should be quoted.
- Score updates accept +/- values; missing signs default to +.

**Batch examples:**
- `!customlb score update "Haunter Shop" Haunter +1 "The Triassic" +2`
- `!customlb entrant add "Haunter Shop" Haunter, "The Triassic"`

**Common invalid responses:**
- Missing duration → usage hint
- Permission failure → “You do not have permission…”

---

## 9) Games

Game commands generally follow a `!game` and `!game help` pattern. Many support in-channel prompts and timers.

**Examples:**
- `!hangman`, `/hangman`
- `!pokeunscramble`, `/pokeunscramble`
- `!blackjack`
- `!rps`
- `!bingo`
- `!dond` (Deal or No Deal)
- `!sz` (Safari Zone) — aliases: `!safari`, `!safarizone`
- `!ev` (Exploding Voltorbs) — alias: `!voltorb`
- `!ee` (Exploding Electrode) — alias: `!electrode`
- `!auction`
- `!higherorlower` (alias: `!hol`)
- `!closestroll` (alias: `!cr`)
- `!mafia`

**Invalid input:**
- Wrong phase or missing params → prompt or help text.

---

## 10) Fun Commands

Lightweight utilities or fun responses.
- `!rig` — bless someone with RNG
- `!curse @user` — curse someone with anti‑RNG
- `!slap @user` — playful slap command
- `!m8ball <question>` (alias: `!8ball`) — magic 8‑ball answer (15s cooldown for normal users)
- Passive: messages containing “intbkty” get a boot reaction

---

## 11) Admin Appendix (Admin/Privileged Only)

These commands are hidden from public help and only visible in the private admin panel.

### Admin / Info
- `!faqreload` — reloads `faq.json`
- `!rarity4reload` — refresh rarity4 cache
- `!setpromo <text>` — set promo manually
- `!cmdpolicy` — show per‑guild command exposure overrides
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
