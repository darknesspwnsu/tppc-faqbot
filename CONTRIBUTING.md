# CLAUDE.md

## Project Overview

This repository contains a **modular Discord bot built for TPPC (The Pokémon Poke Center) communities**.

**TPPC (The Pokémon Poke Center)** is a long-running, browser-based Pokémon RPG that focuses on collection, training, trading, and community-driven events. Because much of TPPC’s social activity happens outside the game—primarily on Discord—this bot exists to support trading, contests, games, verification, and data lookup in a clean, scalable way.

This is **not a generic Discord bot**. All design decisions prioritize:

* TPPC-specific workflows
* Fairness and low spam in large servers
* Configurability per guild and per channel
* Long-running games and contests with minimal moderator overhead

---

## Primary Purpose of This Bot

The bot provides:

* Trading utilities (IDs, FT/LF lists)
* Rarity lookups and comparisons
* Contest and RNG tooling
* Interactive Discord games
* Verification and moderation utilities
* A dynamic, policy-aware help system

All functionality is built on a **custom command framework** that allows fine-grained control over command exposure, channel usage, and UX consistency.

---

## How Claude Should Assist on This Project

Claude is being used as an **additional set of architectural eyes**, not just an implementation tool.

### High-Priority Areas to Focus On

When reviewing or proposing changes, prioritize help in these areas:

1. **Architecture Reviews**

   * Evaluate specific modules or patterns that may be unclear, overgrown, or fragile
   * Identify coupling, duplication, or hidden complexity
   * Suggest cleaner boundaries or abstractions where appropriate

2. **Adding New Features**

   * Look at how new features integrate with:

     * the command registry
     * guild exposure policies
     * help rendering
     * existing UX conventions
   * Prefer reuse of existing infrastructure over new patterns

3. **Refactoring Challenges**

   * Help restructure features that have grown organically
   * Reduce complexity without breaking behavior
   * Preserve backward compatibility where feasible
   * Flag risky refactors before suggesting them

4. **Edge Case Handling**

   * Identify race conditions (timers, reactions, concurrent games)
   * Review permission and privilege boundaries
   * Improve error handling and cleanup paths
   * Ensure failures degrade gracefully, not catastrophically

5. **Testing Strategies (Lower Priority)**

   * Suggest practical testing approaches when requested
   * Focus on high-risk logic (parsers, state machines, DB interactions)
   * Avoid heavy test frameworks unless clearly justified

Claude should **not default to rewriting everything**. Incremental improvement and safety are preferred over large rewrites.

---

## Core Design Principles (DO NOT VIOLATE)

### 1. Command Consistency Is Mandatory

All interactive features **must follow existing command UX rules**:

* Games must support both:

  * `!<game> help` **and** `!<game>help`
  * `!<game> rules` **and** `!<game>rules`
* Help and rules must be registered via the shared framework
* Disabled commands should **silently return** unless explicitly configured otherwise

Inconsistency across games or commands is considered a regression.

---

### 2. Use the Unified Command Registry

All commands must be registered via `commands.js` using:

* `register(...)`
* `register.expose(...)`
* `register.slash(...)`
* `register.component(...)`
* `register.onMessage(...)`

Never:

* Attach raw `messageCreate` listeners outside the registry
* Register slash commands without syncing through the registry
* Duplicate logic that already exists in the framework

---

### 3. Respect Guild-Level Command Exposure

Each logical command may be:

* Exposed as `!command`
* Exposed as `?command`
* Disabled entirely

Rules:

* Wrong prefix → **silent ignore**
* Disabled (`off`) → explicit “disabled” message
* Channel restrictions may be silent or noisy depending on policy

Never hardcode prefixes or assume `!` always works.

---

### 4. Help System Rules

The help system is **dynamic and guild-aware**:

* `!help` → public, truncated preview
* `/help` → private (ephemeral), interactive
* Help output must:

  * Reflect actual command availability in that guild
  * Hide admin-only and disabled commands
  * Rewrite prefixes automatically

Never hardcode help output or duplicate help text.

---

### 5. Games Framework Rules

All games must:

* Use the shared games framework
* Clean up state on timeout, cancellation, or error
* Avoid unnecessary message spam
* Prefer message edits over new messages
* Prevent soft-locks or stuck game states

Game state must always be guild-scoped and self-cleaning.

---

### 6. Contests & RNG Tools

Contest utilities must:

* Be fair and deterministic where applicable
* Avoid leaking private contest data publicly
* Respect admin / privileged gating
* Use slash commands where privacy is required

---

### 7. Database Usage Rules

Database-backed features include:

* Trading IDs
* FT / LF lists
* Promo text
* Verification data

Rules:

* Always scope data by `guildId`
* Gracefully handle DB unavailability
* Cache where appropriate
* Never block bot startup on a single DB failure

---

### 8. Permissions & Privilege Handling

Permission checks must use:

* `isAdminOrPrivileged(...)`

Never:

* Manually check Discord permissions inline
* Bypass privilege checks for convenience

---

### 9. File & Module Organization

Respect the existing structure:

```
commands.js          → command registry
games/               → interactive games
contests/            → contest utilities
verification/        → verification workflows
configs/             → exposure & policy config
db.js                → database access
helpbox.js           → help UI
```

Avoid monolithic files and cross-cutting logic outside the registry.

---

### 10. Style & Tone Expectations

Code should be:

* Defensive
* Explicit
* Readable
* Low-magic

User-facing messages should be:

* Clear
* Neutral
* Low-noise
* Consistent

Avoid unnecessary emojis, verbosity, or debug output.

---

## Known Sharp Edges

This codebase is stable, but there are a few areas that are easy to accidentally break during refactors or feature work:

### 1. Guild Exposure & Prefix Rewriting

* Commands registered via `register.expose(...)` can appear as **`!cmd` OR `?cmd` OR be disabled** depending on guild policy.
* **Never** hardcode prefixes in usage strings, help text, or “did you mean” actions. Help output is dynamically rewritten per guild.
* “Wrong prefix” behavior is intentionally **silent** (by design). If you add new “error” replies for wrong prefixes, you’ll introduce noise regressions.

### 2. Channel Policy vs “Global Allowed Channels”

There are two separate layers of command visibility:

* A **global allowlist** via `ALLOWED_CHANNEL_IDS` (in `bot.js`) that blocks processing entirely.
* A **per-command channel policy** via `COMMAND_CHANNEL_POLICY_BY_GUILD` (in `configs/command_exposure.js`).

Sharp edge:

* If a command “does nothing,” check both layers before assuming the handler is broken.
* Some policies are explicitly configured to **silently ignore** when blocked.

### 3. Help System: Must Stay Truthful

* `/help` and `!help` are not a dumb list—help is computed from the registry and rewritten per guild.
* If you add commands without proper `help`, `category`, `helpTier`, `hideFromHelp`, or `admin` flags, help output will become misleading.
* Games category intentionally shows **primary** commands only (to avoid flooding help). If you expect a command to show up, ensure it is marked appropriately.

### 4. Stateful Games & Timers (Race Conditions)

Games and contest flows often rely on:

* timers (`setTimeout`, interval ticks)
* message edits
* reaction collection
* “current turn” state machines

Common failure modes:

* double-finalization (timer fires after manual end)
* stale state edits (trying to edit a message that was deleted)
* overlapping turns due to delayed awaits
* failure to clean up state on error paths

Rule of thumb:

* Every game should be robust to “end” being called twice.
* Always `try/catch` message fetch/edit, and always clear timers.

### 5. Discord Rate Limits from “Animation” Features

Any feature that “animates” via repeated message edits (wheel spins, countdowns, etc.) can hit:

* rate limits
* message edit failures
* jitter due to latency

Avoid:

* too many edits per second
* long sequences of edits in public channels

Prefer:

* fewer edits with smoother easing
* batching output
* fallbacks when edits fail

### 6. Interaction vs Message Context Differences

Slash interactions aren’t the same as message commands:

* `interaction.reply()` vs `message.reply()`
* ephemeral vs public visibility
* follow-ups after `deferUpdate()`
* components must be routed by customId prefixes

Sharp edge:

* Some handlers create “message-like” objects for reuse. If you rely on message-only properties (e.g., `message.member.permissions`), it may break in interactions.

### 7. DB Availability & Partial Failures

DB is expected to be available in production, but code must assume:

* init may temporarily fail (retry occurs)
* queries may throw
* schema exists but data may be missing

Rules:

* Never make DB failure crash a command path.
* Prefer graceful fallback/caching where it’s already established.

### 8. Privileged Users Config Drift

Privileged access is loaded from JSON at startup.

* If the file path changes or config is missing, privileged checks can silently “turn off.”
* Always keep permission-sensitive commands safe even if privileged users fail to load.

### 9. “Did You Mean” Buttons / CustomId Payloads

Some commands (rarity especially) use buttons where:

* the customId encodes command + args
* values are URL-encoded
* handler reroutes into a command dispatcher

Sharp edge:

* customId length limits exist
* encoding/decoding mistakes cause reruns to break
* rerouted handlers may not behave exactly like a true `message` object

Keep payloads short and always decode defensively.

### 10. Multiple Sources of Truth for Behavior

Over time, behavior expectations may exist in:

* code comments
* help text
* output examples from Discord logs
* your stated UX rules (help/rules dual forms, silent ignores, etc.)

When changing behavior:

* ensure outputs still match established patterns
* avoid “small” wording changes that accidentally break community expectations or moderation workflows

---


## Final Note to Claude

> You are an extra set of eyes on a mature, growing codebase.
> Prioritize safety, consistency, and integration over novelty.
> When unsure, ask before implementing.
