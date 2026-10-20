# Public list shuffle and cosmetic points shop

These commands use the normal per-guild exposure and channel policies. Examples
use `!`; the configured prefix may be `?`. Logical IDs: `rng.shuffle`,
`shop.main`, and `shop.admin`. All register through the existing tool registry
and appear in the guild-aware help. Shop management is admin/privileged only.

## Shuffle a list publicly

```text
!shuffle
Alice Smith
Bob
Charlie
```

`!randomize` is an alias. Commas also preserve names with spaces:
`!shuffle Alice Smith, Bob, Charlie`. A single line without commas splits on
whitespace (`!shuffle 1 2 3 4 5 6`). Every occurrence is retained, including
duplicates. Supports 2–200 entries. Results do not ping mentions; long results
are attached as a text file. Uses a cryptographic Fisher–Yates shuffle.

## Staff setup (live, no restart)

1. Create cosmetic roles in Discord. Give them **no permissions**, including
   channel permission grants. Set colors, role icons (badges), and gradients in
   Discord where the server's features support them. The shop assigns these
   existing roles; it does not unlock Discord's premium role features.
2. Give the bot Manage Roles and place its highest role above every shop role.
3. Add a listing:

   ```text
   !shopadmin set blue @BlueRole 25 loot 100 Blue badge
   !shopadmin set sunset @SunsetRole 50 trivia 50 Sunset gradient
   !shopadmin set sparkle @SparkleRole 30 scramble 0 Sparkle badge
   ```

   Mention the actual role (or use its numeric role ID). Arguments are item ID,
   role, price, currency, refund percentage, and display name. IDs use lowercase
   letters, numbers, underscores or hyphens (up to 32 characters). Prices are
   whole numbers from 1 to 1,000,000; names are up to 80 characters.

4. Repeat `set` with the same ID and role to update price, name, currency, or
   refund percentage immediately. A listing's role cannot be changed and a
   role cannot have two listings. Use a new role and ID for another cosmetic.
5. `!shopadmin pause blue` hides a listing and stops new purchases.
   `!shopadmin resume blue` reopens it. Updating a paused listing keeps it paused.
   `!shopadmin list [page]` includes paused listings.

Refund 100 returns the full purchase price, 50 returns half (rounded down),
and 0 disables refunds for a completed purchase. Each receipt keeps the price,
currency, role, and refund policy from the purchase, even after staff edits or
pauses the listing. Existing purchases remain visible and refundable.

## Member commands

| Command | Result |
| --- | --- |
| `!shop [page]` | Current enabled listings, prices, and refund policies |
| `!shop balance` | Separate available loot, trivia, and scramble scores |
| `!shop buy blue` | Pay points and receive the role |
| `!shop owned [page]` | Receipts, pending actions, and refundable amounts |
| `!shop refund blue` | Remove the role, then credit the receipt's refund |
| `!shop help` | Usage and spending policy |

Currencies remain separate; staff choose one per listing. Spending deducts from
the existing score table, so **leaderboards show the remaining score**. There is
no new shared currency or retroactive score conversion. Existing score-reset
commands still reset available points; existing receipts survive resets and
remain refundable according to their terms. Points cannot be transferred between
guilds or currencies. Shop purchases apply only to the invoking member. Roles
the member already has outside the shop cannot be bought or refunded here.
Members can own several cosmetics; Discord's role ordering controls which color
or icon is shown. Purchases do not reorder roles.

## Persistence and failure recovery

`initDb()` creates three new InnoDB tables without modifying existing scores:
`shop_items`, `shop_purchases`, and `shop_events`. All queries are guild-scoped.
Prices and receipts are read live, without a stale catalog cache. Back up these
tables together with the score tables.

Payment is reserved and a pending receipt committed in one transaction before
calling Discord. Insufficient funds and duplicate completed purchases do not
charge points. Repeating `buy` on a pending receipt retries role delivery without
another debit, even if the listing is paused. If delivery fails or the bot
restarts mid-operation, the member can retry `buy` or cancel using `refund`.
Pending purchases always cancel for a full refund, including non-refundable
listings; the bot removes any partially delivered role first.

A refund is marked in progress before role removal. Points are credited and the
receipt deleted in one transaction only after Discord succeeds. Retrying a
pending refund cannot credit points twice. If the role was deleted, the receipt
can still be refunded. Staff should fix role hierarchy/permissions and let the
member retry when role removal fails. Never delete a pending receipt manually.
The event table retains payment reservations and completed refunds for audits.

Run one active bot worker for a guild, as with the existing in-memory game and
contest state. Member shop actions are serialized within that worker; SQL locks
also protect debits and refunds. Discord and MySQL cannot share a transaction,
so durable pending states provide explicit recovery when either is unavailable.

## Verification

Run `npm run test:run`. For optional real MySQL transaction tests, use a dedicated
empty test database and set `SHOP_TEST_MYSQL=1`, `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_NAME`, and optionally `DB_PASSWORD`, then run
`npm run test:run -- tests/tools/shop_store.mysql.test.js`. The database name must
end in `_test`. The test initializes the schema and cleans only its fixture guild
rows in that dedicated database; never use production.
