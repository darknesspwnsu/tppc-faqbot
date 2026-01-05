# AI Collaboration Guidelines

This document expands on CONTRIBUTING.md with practical guardrails for using AI
tools (Codex, Copilot, Claude, etc.) on this codebase. The goal is to move
fast without breaking invariants that keep the bot stable.

## Architectural Philosophy

- Prefer small, targeted changes over sweeping refactors. Stability matters.
- Keep behavior deterministic and user-facing text consistent.
- Favor clear, explicit logic over clever abstractions.
- When a feature needs persistence, use the existing DB patterns and cache
  intentionally (avoid ad hoc globals that bypass stored state).
- Error handling should be user-friendly; stack traces should stay in logs.
- Prefer scheduled refresh + stale guard rails for cache-driven features.
- Treat timestamps and timezones carefully. Use explicit TZ handling when
  scheduling.

## Before You Ask AI to Code, Understand X

1. **Command architecture**: bang commands vs slash vs component routing.
2. **Caching**: when a cache is allowed to be stale and when it must refresh.
3. **DB invariants**: sentinel rows, per-guild scoping, and TEXT storage.
4. **Permissions**: admin/privileged checks and exposure rules.
5. **Error UX**: failures should be graceful, with short user-visible messages.
6. **Testing expectations**: new behavior should be backed by targeted tests.

## Good AI Usage (Examples)

- "Add a per-guild cache with a stale check and a safe fallback to DB."
- "Update scheduler to be TZ-correct and add tests for DST transitions."
- "Refactor a parsing function, keep outputs identical, add regression tests."
- "Add one new command and mirror existing error patterns and help text."
- "Follow existing scheduler patterns (see `tools/rarity.js` and `tools/promo.js`)."
- "Reuse the centralized registry and exposure rules (`commands.js`)."

## Bad AI Usage (Examples)

- Large refactors that change multiple modules without tests or justification.
- Changing user-facing messages casually (breaks expectations/tests).
- Introducing new libraries when existing utilities already solve the problem.
- Ignoring permission/exposure rules for commands.
- Making network calls or DB writes from message hooks without rate controls.
- Changing DB schemas without a forward-safe migration path (`db.js`).

## Known AI Failure Modes in This Repo

- **Timezone scheduling mistakes**: naive UTC math; must be TZ-aware.
- **Over-eager caching**: AI often forgets to refresh stale cache on read.
- **Permission leakage**: missing admin/privileged checks or exposure gates.
- **Command parsing regressions**: forms/variants parsing breaks edge cases.
- **Silent errors**: missing user-facing feedback or swallowing failures.
- **Unscoped data**: forgetting to scope to guild or user where required.

## Invariants and Guardrails

### Error Handling
- For user actions, respond with a friendly message, not a stack trace.
- Log errors with context for debugging, but keep chat output clean.
- If an operation can fail (DB, network, DM), handle it explicitly.
  - Good: DM failure handling in `rpg/viewbox.js` and `tools/reminders.js`.
  - Bad: Throwing raw errors directly to chat or failing silently.

### Caching
- Use cache only when it has a clear invalidation strategy.
- If data is time-sensitive, implement stale checks and refresh on read.
- Avoid double sources of truth; cache should mirror DB or remote source.
  - Good: promo stale guards in `tools/promo.js`.
  - Bad: cache-only updates that never sync to DB.

### Scheduling and Time
- Use explicit timezone conversions for ET or PT scheduling.
- Avoid assuming local machine time or UTC for user-facing schedules.
- Add tests for DST boundaries for any new scheduler logic.
 - Use `shared/timer_utils.js` (and `games/framework.js` TimerBag) for timeouts/intervals.
  - Good: ET scheduling helpers in `tools/rarity.js`.
  - Bad: `Date.UTC()` with local times and no TZ conversion.

### Commands and Parsing
- Preserve existing command behavior and help text formats.
- Add tests for parsing edge cases (spacing, forms, aliases).
- When adding subcommands, keep short, consistent descriptions.
  - Good: command parsing tests in `tests/tools/rarity.test.js`.
  - Bad: untested parser changes that break form inputs.

### Permissions and Exposure
- Admin/privileged checks must be consistent with other commands.
- Respect per-guild exposure settings for bang and slash commands.
  - Good: admin checks in `tools/promo.js` and `contests/whispers.js`.
  - Bad: exposing admin-only commands to all users.

### Data Scope
- Most data is per-guild; only make global data when explicitly intended.
- For per-user limits, define whether it is per-guild or global.
  - Good: per-guild data stored via sentinel rows in `db.js`.
  - Bad: cross-guild cache keys for user-specific data.

### User-Facing Text
- Prefer short, consistent responses. Avoid changing phrasing unless needed.
- Use existing message patterns and emojis for consistency.
  - Good: reuse existing confirmation text patterns.
  - Bad: changing command help text without updating tests.

## Patterns to Follow

- **Stale guard**: If cache is stale, refresh once and fall back gracefully.
- **Retry behavior**: Provide a manual override command for admin fixes.
- **Scheduler**: Kick once on startup and schedule for next target time.
- **Parsing**: Normalize inputs to match existing variants and formats.
- **Tests**: New behavior gets tests covering at least one success path and
  one edge case.
  - Good: scheduler tests in `tests/tools/rarity.test.js`.
  - Good: parsing tests in `tests/tools/rarity.test.js`.

## Quick Checklist for AI-Authored Changes

- Does it preserve current behavior and messages?
- Is new behavior scoped correctly (guild/user)?
- Are permission checks in place?
- Are caches refreshed when stale?
- Are tests added or updated for new logic?
- Is scheduling timezone-correct?
