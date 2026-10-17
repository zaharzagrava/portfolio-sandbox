# Data model: S45 — Seller discount functions

Owner: domain `shop-functions` (registry `db/ownership.ts`). No table has a foreign key to another domain's table. One expand/contract migration with `SET lock_timeout`, written as `packages/backend/migrations/<ts>-shop-functions-s45.js`. Decisions: [research.md](research.md) D-06, D-07, D-15.

## Tables

### `ShopFunction` (exists, expanded)
| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | default `uuidv7()` |
| `shopId` | uuid not null | **plain column**; FK to `"Shop"` dropped (IX.4) |
| `name` | text not null | 1–60 chars (`CHECK`) |
| `activeVersion` | int null | names the `ACTIVE` version, constrained (below) |
| `activeStatus` | text generated stored | `CASE WHEN "activeVersion" IS NULL THEN NULL ELSE 'ACTIVE' END`, part of the pointer FK |
| `enabled` | boolean not null default true | |
| `createdAt` / `updatedAt` | timestamptz not null default `now()` | `updatedAt` backfilled to `createdAt` |

Constraints: `UNIQUE ("shopId", lower("name"))` (replaces `UNIQUE ("shopId","name")`); index `("shopId","createdAt" DESC,"id" DESC)` for the list keyset; FK `("id","activeVersion","activeStatus") → ShopFunctionVersion("functionId","version","status")` `DEFERRABLE INITIALLY DEFERRED`, MATCH SIMPLE. Function count per shop (≤ 3) is held by `pg_advisory_xact_lock(hashtext('shopfn:'||"shopId"))` in the create transaction (a count cannot be a constraint).

### `ShopFunctionVersion` (exists, expanded)
| Column | Type | Rule |
|---|---|---|
| `functionId`, `version` | uuid, int | PK `(functionId, version)`, `version ≥ 1`; FK `functionId → ShopFunction(id) ON DELETE CASCADE` |
| `source` | text not null | `CHECK (length(source) BETWEEN 1 AND 20000)` |
| `sourceHash` | char(64) | SHA-256 of the source |
| `status` | text not null default `QUEUED` | `CHECK IN ('QUEUED','TESTING','ACTIVE','REJECTED','SUPERSEDED')` |
| `verdicts` | jsonb null | `[{case, verdict, detail?, actual?, ms}]` ordered by case name |
| `rejectionReason` | text null | `CHECK IN ('judge_unavailable')` |
| `judgeAttempts` | int not null default 1 | submit = 1; +1 per recovery re-request; max 5 |
| `createdBy` | uuid not null | plain column |
| `createdAt`, `updatedAt` | timestamptz | `updatedAt` moves on every status change and re-request (recovery reads it) |
| `judgedAt` | timestamptz null | set on `ACTIVE`/`REJECTED`/`SUPERSEDED` from `TESTING` |

Constraints: **partial unique index** `UNIQUE ("functionId") WHERE status = 'ACTIVE'`; unique `("functionId","version","status")` (target of the pointer FK); index `("status","updatedAt")` WHERE `status IN ('QUEUED','TESTING')` for recovery and the backlog gauge. Version cap (100) and numbering are held by the function row lock (D-06).

### `ShopFunctionTestCase` (exists, expanded)
| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `functionId` | uuid not null | FK → `ShopFunction(id) ON DELETE CASCADE` |
| `version` | int null | **null = the current (editable) suite**; set = frozen copy for that version |
| `name`, `input`, `expected` | text, jsonb, jsonb | name 1–80 |

Constraints: unique `("functionId", COALESCE("version",0), "name")`; for a frozen row FK `("functionId","version") → ShopFunctionVersion ON DELETE CASCADE`. Existing rows keep `version = NULL`. Suite replace = delete + insert of the `version IS NULL` rows in one transaction. Frozen copy = `INSERT … SELECT` of the current suite at submit.

### `ShopFunctionVersionHistory` (new, append-only)
| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `uuidv7()` |
| `functionId`, `version` | uuid, int | FK → `ShopFunctionVersion ON DELETE CASCADE` |
| `fromStatus` | text null | null = creation (`∅ → QUEUED`) |
| `toStatus` | text not null | same `CHECK` set |
| `actorId` | uuid null | null = system (judge, recovery) |
| `reason` | text null | `stale`, `judge_unavailable`, `rollback`, … |
| `at` | timestamptz not null | injected clock |

Index `("functionId","version","at","id")`. Registered in `db/ownership.ts`. Deleting a function removes versions, history and cases together (cascade), AS-08/AS-39.

## Version state machine (`domain/version-state.ts`, pure)

States: `QUEUED`, `TESTING`, `ACTIVE`, `REJECTED`, `SUPERSEDED` (a `SUPERSEDED` row remembers whether it **passed**: `verdicts` all `pass`). Events: `claim`, `passed{newerThanActive}`, `failed`, `attemptsExhausted`, `newerActivated`, `rollback`.

| From | Event | To | History reason |
|---|---|---|---|
| QUEUED | claim | TESTING | — |
| TESTING | passed (newer than active, or none) | ACTIVE | — |
| TESTING | passed (older than active) | SUPERSEDED | `stale` |
| TESTING | failed | REJECTED | — |
| QUEUED, TESTING | attemptsExhausted | REJECTED | `judge_unavailable` |
| ACTIVE | newerActivated | SUPERSEDED | — |
| SUPERSEDED (passed) | rollback | ACTIVE | `rollback` |

Every other pair is refused (incl. any exit from `REJECTED`, `ACTIVE + rollback`, `QUEUED + rollback`); the dispatcher ends with `assertNever`. Each transition is `UPDATE … WHERE status = :from` asserting one row, plus one history row, in the transaction that also moves `ShopFunction.activeVersion` when `ACTIVE` changes.

## Breaker (operational, Redis only — `domain/breaker.ts`)

`CLOSED` —5 failures in 60 s→ `OPEN(openUntil = now+300 s)` —`now ≥ openUntil`→ `HALF_OPEN` (one trial) —success→ `CLOSED` / —failure→ `OPEN(now+300 s)`. `no_discount` is not a failure. Four failures then a success then a 61 s pause never open it (the counter has a 60 s TTL set atomically with the increment).

## Redis keys (all with TTL; derived, never authoritative)

| Key | Value | TTL |
|---|---|---|
| `shopfn:active:{shopId}` | JSON `[{id, name, version, source, sourceHash}]` of enabled functions with an active version, name order | 60 s, deleted after commit on any change |
| `shopfn:memo:{functionId}:{version}:{sha256(canonical input)}` | JSON per-line discount vector (integers) | 60 s; failures never stored |
| `shopfn:breaker:{functionId}` | hash `{state, openUntil, lastFailureReason, lastFailureAt}` | 600 s from last write |
| `shopfn:breaker:fail:{functionId}` | failure counter | 60 s, set with the increment in one Lua call |
| `shopfn:breaker:trial:{functionId}` | `SET NX PX` trial token | 5 s (longer than a 5 ms run plus slack) |

## Outbox and queue

Outbox task `shop_functions.judge_requested` (aggregate id = function id, payload `{functionId, version}`), relayed to the single-consumer task queue `shop-functions.judge-version`; dead letters of invalid payloads go to that queue's DLQ.

## Transient types (never stored)

`DiscountCartDto`, `DiscountEvaluationDto` — see [contracts/internal.md](contracts/internal.md).

## Migration notes (D-15)

Expand: new columns, history table, indexes, unique `lower(name)` (pre-check for case-insensitive duplicates; a duplicate is renamed by suffixing `-<n>` and logged in the migration output). Data step: existing test cases keep `version = NULL`; existing versions get a history row; JSONB test inputs rewritten from `unitPrice` to `unitPriceMinor`. Contract: drop the FK to `"Shop"`, drop `UNIQUE ("shopId","name")`. `down` restores the dropped constraints only (data is not un-rewritten).
