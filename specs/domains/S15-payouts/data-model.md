# Data model: S15 — Seller Payouts

All tables live in the shared `public` schema, owner `domain:payments` (rows added to `packages/backend/db/ownership.ts`). No table has a foreign key to a table of another owner; `shopId` is a plain `UUID`. Money is `BIGINT` minor units with a safe-integer check in the application; the currency is `EUR` (`CHAR(3)` text, default `EUR`).

## Entities

### Payout (expanded; the aggregate)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK `uuidv7()` | the provider idempotency key and reference |
| `shopId` | UUID NOT NULL | plain id; **FK to `Shop` dropped** |
| `periodStart` | DATE NOT NULL | Monday (UTC date); `UNIQUE (shopId, periodStart)` (exists) |
| `currency` | TEXT NOT NULL default `EUR` | |
| `amount` | BIGINT NOT NULL `CHECK > 0` | **legacy**: written equal to `amountMinor` by new code until the contract release |
| `amountMinor` | BIGINT NULL → backfilled; `CHECK ("amountMinor" IS NULL OR "amountMinor" > 0)` | the amount sent; NOT NULL enforced at contract |
| `reserveHeldMinor` | BIGINT NOT NULL default 0 `CHECK >= 0` | the reserve of the run that created it |
| `status` | TEXT NOT NULL default `PENDING`, `CHECK IN ('PENDING','SENDING','UNKNOWN','PAID','FAILED','CANCELLED')` | widened (old code writes only the old three) |
| `destinationSnapshot` | TEXT NULL | full provider account id at creation; never returned or logged |
| `providerRef` | TEXT NULL | **legacy**; new code writes `transferRef` and leaves this equal for old readers |
| `transferRef` | TEXT NULL | the provider's transfer reference once validated |
| `failureCode` | TEXT NULL | `destination_rejected` \| `provider_rejected` |
| `failureReason` | TEXT NULL | sanitized, ≤ 200 chars (existing column; the check is in the application, legacy rows keep their text) |
| `attempts` | INTEGER NOT NULL default 0 | job attempt that last held the send (attempt fence, research R-3) |
| `resendCount` | SMALLINT NOT NULL default 0 | resolver same-key re-sends (≤ 3) |
| `lookupFailures` | SMALLINT NOT NULL default 0 | consecutive unreachable lookups (backoff exponent) |
| `nextResolveAt` | TIMESTAMPTZ NULL | when the resolver looks next (set when `UNKNOWN`, or on a stale `SENDING`) |
| `inDoubtSince` | TIMESTAMPTZ NULL | first moment `SENDING`/`UNKNOWN` was in doubt |
| `inDoubtEventAt` | TIMESTAMPTZ NULL | set when `payout.in_doubt` was emitted (once) |
| `discrepancyReportedAt` | TIMESTAMPTZ NULL | set when a `conflicting_outcome` discrepancy was emitted (once) |
| `payoutVersion` | INTEGER NOT NULL default 1 | +1 at every transition |
| `submittedAt`, `paidAt`, `cancelledAt` | TIMESTAMPTZ NULL | |
| `createdAt`, `updatedAt` | TIMESTAMPTZ NOT NULL | |

Indexes (created `CONCURRENTLY` in a separate non-transactional migration file or `IF NOT EXISTS` in the expand file with `lock_timeout`):
- `UNIQUE ("shopId","periodStart")` — exists; one payout per shop per week (FR-005).
- `("shopId","periodStart" DESC,"id" DESC)` — seller list/detail.
- `("createdAt" DESC,"id" DESC)` with optional filters on `status`, `shopId`, `periodStart` — operator list (a partial composite `("status","createdAt" DESC,"id" DESC)` covers the common `status=UNKNOWN` view).
- `("nextResolveAt") WHERE status IN ('SENDING','UNKNOWN')` — resolver.
- `("paidAt") WHERE status = 'PAID'` — audit of the previous UTC day.

**State machine** (FR-024, AS-27; the pure table in `domain/payout-state.ts`):

```text
PENDING --claim--------------------> SENDING
PENDING --cancel-------------------> CANCELLED (final)
SENDING --provider_success---------> PAID (final)
SENDING --provider_rejected--------> FAILED (final)
SENDING --provider_unknown---------> UNKNOWN
SENDING --retries_exhausted--------> UNKNOWN
SENDING --resolver_found_paid------> PAID
SENDING --resolver_found_rejected--> FAILED
UNKNOWN --resolver_found_paid------> PAID
UNKNOWN --resolver_found_rejected--> FAILED
UNKNOWN --provider_success---------> PAID     (a same-key re-send answered)
UNKNOWN --provider_rejected--------> FAILED   (a same-key re-send was rejected)
every other (state, event) pair is refused; PAID, FAILED, CANCELLED accept nothing.
```

Books follow the state (FR-026): creation posts `SHOP_x → PAYOUT_CLEARING` (`PAYOUT`, reference `id`); `PAID` posts `PAYOUT_CLEARING → PAYOUTS_SENT` (`PAYOUT`, `id:sent`); `FAILED` and `CANCELLED` post `PAYOUT_CLEARING → SHOP_x` (`PAYOUT_REVERSAL`, `id`). Invariant: `PAYOUT_CLEARING` = sum of payouts in `PENDING`, `SENDING`, `UNKNOWN`.

### PayoutHistory (new, append-only)

`id UUID PK uuidv7()`, `payoutId UUID NOT NULL`, `fromStatus TEXT NULL` (null for creation), `toStatus TEXT NOT NULL`, `payoutVersion INTEGER NOT NULL`, `actor TEXT NOT NULL` (`system`, `migration` or the admin's user id), `reason TEXT NULL (≤ 200)`, `at TIMESTAMPTZ NOT NULL`. Index `(payoutId, id)`. A trigger refuses `UPDATE`/`DELETE` (same pattern as S14's append-only triggers). The seller timeline is read from it (`toStatus` mapped to the public statuses, consecutive equal public statuses collapsed).

### PayoutRun (new)

`periodStart DATE PK`, `status TEXT CHECK IN ('RUNNING','COMPLETED','FAILED')`, `created INTEGER`, `existing INTEGER`, `skipped JSONB default '{}'` (`{reason: count}`), `failureCode TEXT NULL` (`ledger_unavailable`, `interrupted`, …), `startedAt`, `finishedAt NULL`, `updatedAt`. Upserted by `periodStart`: a re-execution moves the same row to `RUNNING` and **adds** its counts to a fresh tally (the counts of the latest execution replace the old: `created` + `existing` equal the shops processed in that execution — AS-02 expects `existing 2, created 0` after a re-run, so counters are reset at the start of each execution, and the first execution's creations remain visible through the payouts themselves). Runs are keyed by period so the list stays short (LOCAL decision).

### PayoutDestination (new)

`shopId UUID PK`, `providerAccountId TEXT NOT NULL`, `effectiveFrom TIMESTAMPTZ NOT NULL`, `changedAt TIMESTAMPTZ NOT NULL`, `changedBy TEXT NOT NULL` (admin id or `migration`), `version INTEGER NOT NULL default 1`. The format `acct_` + 8–64 alphanumerics is validated in the application only (a CHECK would make the legacy copy lose rows whose ids do not match). Rules: first destination → `effectiveFrom = changedAt`; a different value → `effectiveFrom = changedAt + cooling`, `version + 1`; the same value → no write. A shop with `now < effectiveFrom` is skipped `destination_cooling` (it is **not** paid to the old account: AS-39), and `GET upcoming` reports `destination_cooling`. The previous value survives in the history, not in the row.

### PayoutDestinationHistory (new, append-only)

`id UUID PK uuidv7()`, `shopId`, `fromMasked TEXT NULL`, `toMasked TEXT NOT NULL`, `effectiveFrom`, `at`, `actor`. Masked only: the history never stores the full value.

### PayoutReserve (new) / PayoutReserveHistory (new, append-only)

`PayoutReserve`: `shopId UUID PK`, `reserveBps SMALLINT NOT NULL CHECK (0..5000)`, `reason TEXT NOT NULL (1..200)`, `updatedBy TEXT NOT NULL`, `updatedAt`. Absent row = platform default. `PayoutReserveHistory`: `id`, `shopId`, `previousBps NULL`, `reserveBps`, `reason`, `actor`, `at`. A change applies to payouts created afterwards, never to existing ones (FR-041).

### PayoutAuditDay (new) and PayoutAuditFinding (new)

`PayoutAuditDay`: `day DATE PK`, `status CHECK IN ('RUNNING','COMPLETED','FAILED')`, `checked INTEGER`, `discrepancies INTEGER`, `startedAt`, `finishedAt NULL`. `PayoutAuditFinding`: `PRIMARY KEY (payoutId, kind)`, `day DATE`, `foundAt`. Inserting a finding `ON CONFLICT DO NOTHING` is what makes "every difference once" (running the audit twice emits nothing new); the event and the metric are emitted only when the insert created the row, in the same transaction as the insert.

## Migrations (expand/contract, III.11)

1. **`20261015…-s15-payouts-expand.js`** (one transaction, `SET LOCAL lock_timeout = '3s'`): add the `Payout` columns (all nullable or with constant defaults — metadata-only); replace the status CHECK (`DROP CONSTRAINT IF EXISTS` + `ADD … NOT VALID`, then `VALIDATE CONSTRAINT`); drop the foreign key `Payout.shopId → Shop` (looked up by catalog, not by name); create the nine new tables and the append-only triggers; backfill, each statement idempotent:
   - `UPDATE "Payout" SET "amountMinor" = "amount" WHERE "amountMinor" IS NULL` (batched by id range, ≤ 5 000 rows per statement);
   - `transferRef = providerRef` where null;
   - `PayoutDestination` from `ProviderAccount` and, only if `information_schema` shows `Shop.stripeAccountId`, from `Shop` for shops not already present (`ON CONFLICT ("shopId") DO NOTHING`), `effectiveFrom = changedAt = now()`, `changedBy = 'migration'`;
   - `destinationSnapshot` of existing payouts from that table (where the shop had an account);
   - one `PayoutHistory` row `∅ → status` per existing payout that has none (`NOT EXISTS`), actor `migration`; `payoutVersion` stays 1.
   Old readers keep working: no column is dropped or renamed, the status check still admits the old values, `amount`/`providerRef` stay.
2. **indexes** in the same file with `CREATE INDEX IF NOT EXISTS` (the `Payout` table is small — one row per shop per week; if a deployment disagrees, the file notes the `CONCURRENTLY` variant to run outside a transaction).
3. **`20261015…-s15-payouts-contract.js`** (a later release, after AS-53's verification on the target database): refuses to run unless `count(Payout) = count(amountMinor IS NOT NULL)`, `sum(amount) = sum(amountMinor)` and every non-null `providerRef` equals `transferRef`; then `ALTER amountMinor SET NOT NULL`, drop `amount`/`providerRef`, drop `ProviderAccount` (tenancy's drop of `Shop.stripeAccountId` is its own contract step). Idempotent (`IF EXISTS`).

`down` migrations only reverse the additions (drop new tables/columns); they never restore the `Shop` foreign key.

## Redis / Kafka / jobs

- No Redis key owned by this capability (limiter and idempotency use S50/S54 prefixes).
- Kafka `payouts.events` (produced; key `payoutId`); see [contracts/events.md](contracts/events.md).
- Job table: `payouts.run-weekly`, `payouts.send`, `payouts.resolve-in-doubt`, `payouts.audit-daily`; `JobKey` idempotency keys: `payout-send:<payoutId>`.
