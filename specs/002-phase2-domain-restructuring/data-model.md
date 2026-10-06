# Data Model: Ownership Registry

No database schema changes. The one new data artifact is the ownership registry
(`packages/backend/db/ownership.ts`), which is static metadata about existing tables.

## Entities

### Owner
- `domain:<Domain>`, where `Domain` is one of the 25 names in `DOMAINS` (domain map §1.1, minus
  `bff`, which is now composition per constitution X.8).
- `infrastructure:<InfrastructureOwner>`, where `InfrastructureOwner` ∈ {`outbox`, `idempotency`,
  `jobs`, `database`}.

### Ownership entry
- `table`: the exact Postgres table name in `public` (flat, no prefix, IX.2).
- `owner`: exactly one `Owner`.
- There are 100 entries. Domains with **zero** entries by design are `community` (ScyllaDB/Redis,
  D5) and `discovery` (read models only).

### Retired table
- `RETIRED_TABLES`: created by an old migration and dropped later (`Inventory`). It is excluded
  from completeness checks.

## Validation rules (enforced by `db/ownership.spec.ts`)

1. **Complete**: every table created by a migration, renamed into existence, or named by a model's
   `tableName` is registered. Partition children (`_default`, monthly) and `_new` staging copies
   count as their parent.
2. **No stale entries**: every registered table is created by something.
3. **Valid owners**: every owner is a known domain or an allowlisted infrastructure lib.
4. **Exact technical allowlist**: infrastructure owns exactly `Job`, `JobKey`, `JobSchedule`,
   `Migration`, `Outbox`, and `ProcessedWebhookEvent`.
5. **Placement**: a model file under `libs/domains/<d>/` (or `libs/infrastructure/<lib>/`) maps a
   table owned by `domain:<d>` (or `infrastructure:<lib>`). Legacy models under `libs/common/src/`
   are exempt until their domain migrates.
6. **Known domains**: every folder in `libs/domains/` is in `DOMAINS`.

## Helper API

- `ownerOf(table): Owner | undefined`
- `ownedBy(owner): Table[]`, the set `owned(D)` used by the future IX.5 static query check.
