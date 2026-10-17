# MarketPoll production audit

Run from a checkout with dependencies installed (`npm ci`), on a machine that can reach the production MySQL/MariaDB database. Node 20.19+ is required, as for the bot.

```bash
npm run marketpoll:audit -- --env /secure/path/production.env
```

The dotenv file uses the bot's existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` variables. Exported environment variables take precedence over file values. If those variables are already supplied by your production environment, omit `--env`. Optionally set `DB_SSL_CA` to a trusted CA certificate path for verified TLS. Credentials are never included in the report or snapshot.

The script opens its own connection, uses a read-only consistent transaction, and only reads MarketPoll tables. It does not import bot startup or run migrations, update scores, close polls, or contact Discord. A database account with SELECT access is sufficient. Missing optional tables or old bundle/mode columns produce report warnings; a missing poll table fails without modifying anything.

## Options

```bash
# Focus on one Discord community, retaining its full history.
npm run marketpoll:audit -- --env /secure/path/production.env --guild 123456789012345678

# Examine a date range and change the audit threshold and comparison windows.
npm run marketpoll:audit -- --since 2026-07-01 --min-votes 10 --recent-days 60

# Choose a new output directory.
npm run marketpoll:audit -- --out analysis/marketpoll/first-audit

# Reanalyze the same snapshot offline at a different turnout threshold.
npm run marketpoll:audit -- --input analysis/marketpoll/first-audit/snapshot.json --min-votes 10

npm run marketpoll:audit -- --help
```

`--since` accepts a UTC date or ISO timestamp ending in `Z`; it filters poll start time and scheduler run time. By default all guilds and all history are included. `--input` preserves the snapshot's capture time, seeds, and scope and cannot be combined with `--env`, `--guild`, or `--since`. Tables are read in pages of 1,000 polls without a history cap; the selected history is analyzed in memory. Run off-peak if the poll history is exceptionally large. Queries have a 30-second client timeout.

## Outputs

Default output is a new timestamped directory under `analysis/marketpoll/`, which Git ignores. Existing files are never overwritten.

- `report.md`: readable audit, participation, exclusions, coverage, comparison groups, repeated preferences, close contests, changes in identical matchups, polling priorities, scheduler reasons, and limitations.
- `audit.json`: complete derived analysis, including all assets, matchups, components, current settings, and excluded poll IDs/reasons.
- `snapshot.json`: selected raw poll records plus current seed context, settings, global scores, and scheduler aggregates. Reusable without database access; includes Discord message and guild IDs but no voter identities or credentials.
- `assets.csv`: coverage per Pokémon/gender. Vote shares and distinct opponent counts use 1v1 polls only. Bundle appearances are counted separately. Current global Elo is context, not a scoped or reconstructed ranking.
- `matchups.csv`: canonical full-side vote totals, repeated preferences, and adjacent-window comparisons. Swapping the left/right position does not create a new matchup; bundles are never split into individual wins.
- `weekly.csv`: Monday-based UTC participation totals. Weeks with no polls are omitted.

Share `report.md` and `audit.json` to review the findings; include `snapshot.json` if we need to adjust the analysis offline.

## Reading the findings

A usable poll is closed, non-error, structurally valid, counted (not exhibition), and has at least `--min-votes` votes (default 5). This is a reproducible audit rule, independent of `affects_score` and historical minimum-vote settings. The audit identifies invalid vote totals, inconsistent outcomes, invalid timestamps/sides/modes, and duplicate messages. It reports overdue open polls and differences from the bot's recorded scoring decisions.

“Repeated preference” requires at least 3 polls, 30 votes, 60% pooled support, and the preferred side winning at least 75% of polls. “Close contest” requires at least 3 polls and 30 votes with support between 40% and 60%. These are descriptive screening rules, not statistical confidence claims. Recent changes compare identical matchups in the last 30 days against the prior 30 days (configurable), requiring at least 2 polls and 10 votes per window. An empty table means insufficient qualifying evidence, not proof of no preference or change.

The 1v1 graph shows groups connected by usable solo comparisons. Disconnected groups cannot support an overall ranking. Bundle-only assets are outside this graph. At least 5 solo polls against 3 distinct opponents earns the descriptive “broader solo coverage” label; it does not certify a stable ranking.

Coverage uses the checkout's current baseline seed file plus captured production overrides, not historical seeds. Current settings and Elo are not historical snapshots. The existing bot increments polls_count and W/L/T for low-turnout counted polls too, so those counters are not used as usable sample sizes. Votes are events rather than unique people, and the data cannot identify repeated voters or coordinated voting. Treat findings as stated preference among poll participants, not x prices or completed trade evidence.
