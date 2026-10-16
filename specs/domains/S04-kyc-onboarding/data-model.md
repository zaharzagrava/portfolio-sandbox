# Data model: S04 `seller-onboarding`

Only this domain's tables. Cross-domain IDs (`shopId`, `userId`) are plain `uuid` columns with no foreign key (IX.4.3). Existing tables come from `20261002170000-seller-onboarding.js` (history untouched); everything below is added by new expand migrations (R-11). Time columns are `timestamptz`, written from the injected clock.

## ShopOnboarding (one row per shop)

| Column | Type | Note |
|---|---|---|
| shopId | uuid PK | existing; **FK to `Shop` dropped** (contract migration) |
| answers | jsonb | submitted answers of the current round |
| submittedBy | uuid | existing |
| submittedAt | timestamptz | existing |
| status | text NOT NULL | new; `SUBMITTED \| VERIFIED \| REJECTED`, CHECK constraint; default `SUBMITTED` for backfill |
| submissionNo | int NOT NULL default 1 | new; CHECK ≥ 1 |
| verifiedAt, rejectedAt | timestamptz null | new |
| rejectionReasonCode | text null | new; `DOCUMENTS_INVALID \| IDENTITY_MISMATCH \| FRAUD_SUSPECTED \| OTHER` |
| rejectionReason | text null | new; 3–500 chars, never in events, logs or audit |

Transitions (domain `application-status.ts`, exhaustive): `SUBMITTED→VERIFIED`, `SUBMITTED→REJECTED`, `REJECTED→SUBMITTED` (`submissionNo + 1`); `VERIFIED` terminal. Each is `UPDATE … WHERE shopId=? AND status=<from>` asserting 1 row plus a history row.

## ShopDocument

| Column | Type | Note |
|---|---|---|
| id | uuid PK | existing |
| shopId | uuid NOT NULL | existing; **FK dropped** |
| submissionNo | int NOT NULL default 1 | new |
| kind | text | `BUSINESS_REGISTRATION \| VAT_CERTIFICATE \| BANK_STATEMENT` |
| contentType, contentHash, size | text, text, int | existing/ensured |
| storageKey | text | never returned |
| status | text | `AWAITING_UPLOAD, QUEUED, EXTRACTING, NEEDS_REVIEW, APPROVED, REJECTED, SUPERSEDED`; CHECK |
| rejectionReason | text null | seller-visible |
| leaseUntil | timestamptz null | new; set on claim (5 min) |
| purgedAt | timestamptz null | existing/ensured |
| createdAt, updatedAt | timestamptz | existing |

Indexes: unique `(shopId, submissionNo, kind, contentHash)` replacing the old `(shopId, kind, contentHash)` (create new `CONCURRENTLY`, drop old in the contract step); `(shopId, submissionNo, kind)` for caps and supersede; partial `(status, leaseUntil) WHERE status='EXTRACTING'`. Caps (5 per kind per round, counting superseded) are enforced in the confirming/requesting transaction under the application row lock, not by constraint.

Document transitions: as AS-70 (`AWAITING_UPLOAD→QUEUED`, `QUEUED→EXTRACTING`, `EXTRACTING→APPROVED|NEEDS_REVIEW`, `NEEDS_REVIEW→APPROVED|REJECTED`, `QUEUED|EXTRACTING|NEEDS_REVIEW|REJECTED→SUPERSEDED`). Also `QUEUED→NEEDS_REVIEW` is **not** allowed: the dead-letter handler claims first (`QUEUED→EXTRACTING`) then routes, so the machine stays as specified.

## DocumentExtraction (per document and attempt; existing table)

`{documentId, attempt, model, promptVersion, maskedFields jsonb, sealedFields text, issues jsonb, outcome ACCEPTED|ESCALATE|REVIEW, inputTokens, outputTokens, createdAt}`. Unique `(documentId, attempt)` (insert `ON CONFLICT DO NOTHING` makes a redelivered write harmless). `sealedFields` is sealed with context `kyc:<documentId>:<attempt>`; legacy `v1` rows open without context. Human attempt: next number, `model='human'`.

## ReviewTask (existing)

Adds status `CANCELLED` (CHECK `OPEN|APPROVED|REJECTED|CANCELLED`), `corrections jsonb` (masked `{field:{extracted,corrected}}`), `resolvedBy`, `resolvedAt`. Indexes: partial unique `(documentId) WHERE status='OPEN'` (at most one open per document), `(createdAt, id) WHERE status='OPEN'` for keyset paging, `(shopId) WHERE status='OPEN'` for cancel-on-reject. Cancel on supersede/reject/shop deletion: `UPDATE … SET status='CANCELLED' WHERE … AND status='OPEN'`. Transitions: `OPEN→APPROVED|REJECTED|CANCELLED`.

## OnboardingStatusHistory (new)

`{id uuid PK, entity text ('APPLICATION'|'DOCUMENT'), entityId uuid, shopId uuid, fromStatus text null, toStatus text, actor text ('system'|'user:<uuid>'|'worker'), reasonCode text null, at timestamptz}`; index `(entity, entityId, at)`. No free text, no extracted values. Written in the same transaction as every transition (FR-062). Erased with the shop's records (AS-61).

## Temporary draft (Redis hash, not an entity)

Key `onboarding:draft:<shopId>`, one hash field per step (`business|tax|catalog|policies`, JSON), `EXPIRE` 7 d reset on each save (`HSET` + `EXPIRE` in one script). After rejection the first save seeds the hash from `answers` with the saved step replaced. Deleted after the submit commit.

## Scheduled work (S49 `jobs`, not a table of ours)

`onboarding.purge-documents {shopId, submissionNo}` key `purge:<shopId>:<submissionNo>`; `onboarding.erase-records {shopId}` key `erase:<shopId>`.

## Backfill and safety

Expand → code → contract. Backfill sets `status`/`submissionNo` for existing rows in batches; no read of `Shop`. Every statement set carries `SET lock_timeout`; indexes `CONCURRENTLY` outside a transaction. `Shop.verificationStatus`/`payoutsEnabled` columns added by the old migration are left to tenancy (A35).
