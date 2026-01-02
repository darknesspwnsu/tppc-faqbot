# Games Overview

This folder contains the interactive game modules registered in `games/games.js`.

## Quick Index

| Game | Primary command | Scope / channel notes | Join / entry |
| --- | --- | --- | --- |
| Auction | `!auction` | Guild-scoped, start channel bound | `!auction join` (reaction join) |
| Blackjack | `!blackjack` | Guild-scoped, start channel bound | Tag list (`@p1 @p2 ...`) |
| Bingo | `!bingo` | Guild-scoped, channel-agnostic | Range + optional drawn list |
| Closest Roll | `!closestroll` / `!cr` | Guild-scoped, start channel bound | Host starts with optional target/time |
| Deal or No Deal | `/dond` | Guild-scoped, start channel bound | Slash start + modal prize list |
| Exploding Electrode | `!ee` | Guild-scoped, start channel bound | Tag list or reaction join |
| Exploding Voltorbs | `!ev` | Guild-scoped; announcements in start channel | Tag list or reaction join |
| Hangman | `/hangman` | Guild-scoped, start channel bound | Slash start + reaction join |
| Higher or Lower | `!higherorlower` / `!hol` | Guild-scoped, start channel bound | Host starts with rounds + optional range |
| Mafia | `!mafia` | Guild-scoped, start channel bound | Reaction join (✅) |
| RPS | `!rps` | Guild-scoped, start channel bound | Solo or tag opponent |
| Safari Zone | `!sz` | Guild-scoped, channel-agnostic | Tag list or reaction join |

## Common Conventions

- Most games support `!<game> help` and `!<game> rules` via the shared framework.
- Channel binding is game-specific; check the module header for details.
- All games should use the shared framework helpers for timers, cleanup, and permissions.
