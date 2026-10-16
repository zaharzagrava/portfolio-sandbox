# Data Model: S07 — Bulk Catalog Import

Owner of every table below: `domain:catalog-sync` (registered in `packages/backend/db/ownership.ts`; `ImportJob` already is). No table has a foreign key to another owner (IX.4); `shopId`, `createdBy` are plain UUIDs. All SQL lives in `infra/repositories/sequelize-import.repository.ts`; principal (`shopId`) is in every predicate that serves a request (III.4).

## ImportJob (exists; expanded)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK default `uuidv7()` | exposed as `importId` |
| `shopId` | UUID NOT NULL | FK to `Shop` **dropped** (contract step) |
| `createdBy` | UUID NOT NULL | FK to `User` **dropped** |
| `status` | TEXT NOT NULL | CHECK in the 8 states: `PENDING_UPLOAD, UPLOADED, SCANNING, PROCESSING, DONE, FAILED, CANCELLED, EXPIRED` |
| `fileName` | TEXT NOT NULL | sanitised display name (≤ 120) |
| `sizeBytes` | BIGINT NOT NULL | 1 … 5,368,709,120 (CHECK) |
| `storageKey` | TEXT NOT NULL UNIQUE | server-made `imports/<shopId>/<id>/source` (replaces `objectKey`; data step copies, contract step drops `objectKey`) |
| `uploadHandle` | TEXT NULL | multipart upload id (replaces `uploadId`); NULL after complete/abort |
| `slot` | SMALLINT NOT NULL | 1..3, cap mechanism (D-04) |
| `format` | TEXT NULL | `csv` \| `jsonl` |
| `headerColumns` | TEXT[] NULL | normalised header (resume uses it) |
| `ignoredColumns` | TEXT[] NOT NULL DEFAULT `{}` | unknown columns |
| `scan` | TEXT NULL | `clean` \| `skipped` |
| `scannedAt` | TIMESTAMPTZ NULL | |
| `rowsProcessed`, `rowsCreated`, `rowsUpdated`, `rowsUnchanged`, `rowsFailed` | INTEGER NOT NULL DEFAULT 0 | CHECK `rowsProcessed = created+updated+unchanged+failed` |
| `lastRow` | INTEGER NOT NULL DEFAULT 0 | replaces `checkpointRow` (data step copies it) |
| `nextByteOffset` | BIGINT NOT NULL DEFAULT 0 | |
| `bytesProcessed` | BIGINT NOT NULL DEFAULT 0 | |
| `failureCode` | TEXT NULL | one of the 10 failure codes (CHECK) |
| `failureDetail` | TEXT NULL | generic detail such as missing column names; never SQL or stack |
| `errorReportKey` | TEXT NULL | object key of the concatenated report |
| `errorReportRows` | INTEGER NOT NULL DEFAULT 0 | report lines |
| `leaseHolder` | UUID NULL, `leaseExpiresAt` TIMESTAMPTZ NULL | D-02 |
| `cancelRequestedAt` | TIMESTAMPTZ NULL | running-job cancel (D-… AS-56) |
| `lastEnqueuedAt` | TIMESTAMPTZ NULL | recovery window (D-20) |
| `startedAt`, `finishedAt` | TIMESTAMPTZ NULL | |
| `createdAt`, `updatedAt` | TIMESTAMPTZ NOT NULL | |
| legacy `error`, `checkpointRow`, `objectKey`, `uploadId`, `rowsProcessed/rowsFailed` (kept) | | `error`, `checkpointRow`, `objectKey`, `uploadId` dropped in the contract migration after the code stops reading them |

Indexes: `("shopId","createdAt" DESC,"id" DESC)` (list, keyset); `UNIQUE ("shopId","slot") WHERE status IN ('PENDING_UPLOAD','UPLOADED','SCANNING','PROCESSING')` (cap); `UNIQUE ("shopId") WHERE status IN ('SCANNING','PROCESSING')` (one run per shop); `("status","updatedAt")` partial for recovery (`status IN ('UPLOADED','SCANNING','PROCESSING')`); `("status","createdAt") WHERE status='PENDING_UPLOAD'` (expiry); `("finishedAt") WHERE status IN (final)` (purge).

Existing rows in the legacy 6-state table: `PENDING_UPLOAD|UPLOADED|SCANNING|PROCESSING` rows are mapped (data step) to `EXPIRED` when older than 24 h and otherwise given slots; `DONE|FAILED` copy as is with `failureCode='internal_error'` for `FAILED`. (Pre-release data; the data step is deliberately simple and idempotent.)

## ImportJobHistory (new)

`id BIGSERIAL PK`, `importId UUID NOT NULL`, `shopId UUID NOT NULL` (for purge by shop), `from TEXT NULL` (first row), `to TEXT NOT NULL`, `at TIMESTAMPTZ NOT NULL`, `reason TEXT NULL`. Index `("importId","id")`, `("shopId")`. Append-only; written in the transaction of the transition. No FK (the purge deletes history rows first, in the same transaction as the job row).

## Handled events (no new table)

Not created. `Projector.idempotency = 'inbox'` writes `(consumer, eventId)` into the shared inbox (`ProcessedWebhookEvent`, owner `infrastructure:inbox`), as `tenancy-events.consumer.ts` does; the deletion consumer is `'natural'`. `gaps.md` D.2's "handled-event table" is satisfied by the shared inbox.

## State machine (domain/import-status.ts)

```
PENDING_UPLOAD → UPLOADED | CANCELLED | EXPIRED | FAILED
UPLOADED       → SCANNING | CANCELLED | FAILED
SCANNING       → PROCESSING | CANCELLED | FAILED
PROCESSING     → DONE | CANCELLED | FAILED
DONE, FAILED, CANCELLED, EXPIRED: final
```

13 allowed pairs of 56. `ImportStatus` is a string-literal union; `transition(from, to)` returns a typed result; every `switch` ends in `assertNever`. Repository `transition({id, shopId?, from, to, reason, now, lease?, failure?, counters?})` = `UPDATE … WHERE id=:id AND status=:from [AND lease fence]` asserting 1 row + history insert + (if `to` is final) release lease and clear `uploadHandle`, all in one `TransactionRunner.run`, and (final) `outbox.append(import_finished)` in the same transaction. Zero rows ⇒ `StaleTransitionError` (caller re-reads and decides replay vs 409).

Who moves what: API — `start` (insert PENDING_UPLOAD), `complete` (→UPLOADED / →FAILED), `cancel` (→CANCELLED, or sets `cancelRequestedAt` for SCANNING/PROCESSING); expiry job (→EXPIRED); runner (UPLOADED→SCANNING→PROCESSING→DONE|FAILED|CANCELLED); offboarding consumer (as `cancel`); recovery changes no status.

## Value objects

- `ImportJobView` (response DTO) = `importJobSchema`: no `storageKey`, `uploadHandle`, lease, `cancelRequestedAt`, `lastEnqueuedAt`, `slot`.
- `ImportRowResult` = `{ row, sku, problems: {field, code}[] }` → report lines `row,sku,field,code,message`.
- `ImportBatch` = `{ batchNumber, records[], lastRow, nextByteOffset }`; `batchNumber = ceil(lastRow / 500)` is deterministic across resumes because checkpoints sit at multiples of 500 records (a file-rule-failed row still counts as a record).
- `ImportMessage` = `{ importId: uuid }` strict.

## Storage layout (object storage)

| Key | Content | Lifetime |
|---|---|---|
| `imports/<shopId>/<importId>/source` | uploaded file (assembled multipart) | deleted when final; lifecycle rule 7 days (ops) |
| `imports/<shopId>/<importId>/report/<batch>.csv` | error lines of one batch (no header) | until finalisation |
| `imports/<shopId>/<importId>/report/errors.csv` | header + all lines | 30 days after `finishedAt` (purge job); user-content origin download only |

Everything under `imports/<shopId>/` is removed on `shop_deleted`.

## Retention

Report 30 days after `finishedAt` (`errorReportKey` cleared, `errorReportRows` kept → status shows `available:false`); record + history 90 days; non-final jobs never purged; ≤ 500 per run, oldest first.
