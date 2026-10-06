# Gaps: S04 — current `seller-onboarding` code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. `pnpm --dir packages/backend check:table-ownership` was run on the same day and its `seller-onboarding` block is reproduced in section C. The domain has 15 files, including one e2e spec (`onboarding.e2e-spec.ts`, 12 tests) and one unit spec (`domain/validators.spec.ts`).

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Submit writes tenancy's `Shop` table (`UPDATE "Shop" SET "verificationStatus" = 'PENDING'`) | `libs/domains/seller-onboarding/application/onboarding-session.service.ts:59` | FR-041, AS-05, AS-62; remove the statement, tenancy consumes `shop.onboarding_submitted` (S03 AS-72) |
| A2 | Verification writes `Shop` (`verificationStatus = 'VERIFIED', payoutsEnabled = TRUE`) and uses its row count as the "was it new" signal | `application/verification.service.ts:49-52` | FR-040, FR-041, AS-49; the guard becomes a conditional update on the application's own status (`SUBMITTED → VERIFIED`) |
| A3 | Review queue joins `"Shop"` for the name | `application/review.service.ts:43` | FR-060, AS-63; R1 `ShopQueryService.getShopsByIds` once per page, `shopName: null` when absent |
| A4 | `maybeVerify` runs in its own transaction after the approving one, in both paths; a crash in between leaves all kinds approved and the application open | `application/review.service.ts:122`; `application/extraction.service.ts:202` | FR-040, AS-49, AS-51, AS-53; run inside `finish` and `resolve` transactions, locking the application row |
| A5 | Extraction message is enqueued after commit, outside the outbox (dual write) | `application/onboarding-documents.service.ts:77` | FR-013, AS-15; append `onboarding.extract_document` to the outbox in the confirming transaction (needs S53 command path) |
| A6 | Claim lets any worker take `QUEUED` **or** `EXTRACTING`, so concurrent deliveries both call the model; no lease | `application/extraction.service.ts:63-66` | FR-025, AS-31; lease column, claim only `QUEUED` or expired `EXTRACTING` |
| A7 | `finish` inserts a `ReviewTask` even when the conditional update changed nothing (superseded or already decided document) and always calls `maybeVerify` after `ACCEPTED` | `application/extraction.service.ts:189-202` | FR-025, AS-33; assert one affected row, otherwise discard |
| A8 | Supersede on confirm skips `EXTRACTING` and leaves open review tasks `OPEN`; the queue hides them only by joining the document status | `application/onboarding-documents.service.ts:69-74`; `application/review.service.ts:42` | FR-014, AS-17, AS-33; include `EXTRACTING`, set tasks to `CANCELLED` |
| A9 | No dead-letter handling: a message parked after 5 receives leaves the document `EXTRACTING` forever; Lambda only reports errors | `apps/lambdas/src/handlers/document-extractor.ts:22-34`; `application/extraction.service.ts` (no `routeToReview`) | FR-026, AS-32; dead-letter handler → `ExtractionService.routeToReview(documentId, 'extraction_unavailable')`, alarm metric |
| A10 | No explicit per-call timeout, no cap check on output; model access through `LLM_PROVIDER` of `assistant` | `application/extraction.service.ts:89-98` | FR-026, AS-32, AS-69; `timeoutMs: 45_000`, config validation at startup |
| A11 | Model output validated with a non-strict zod object: unknown keys are stripped silently | `domain/extraction-schema.ts:48-54` | FR-021, AS-27; `.strict()` on every level, `invalid_output` on any extra key |
| A12 | Missing stored object crashes processing (`getStream` error propagates, retried until the DLQ) instead of review `file_missing` | `application/extraction.service.ts:204-208` | FR-023, AS-35 |
| A13 | `evaluate` mixes pure rules with `Date.now()` and lives in `application/`; `sniff` likewise | `application/extraction.service.ts:140-186, 211-217` | I.3, VII.5, AS-23, AS-28; move to `domain/extraction-rules.ts` and `domain/file-type.ts` with an injected `now` |
| A14 | Sealing uses no context; `open` for review likewise | `application/extraction.service.ts:115`; `application/review.service.ts:79,108` | FR-024, AS-30; `kyc:<documentId>:<attempt>` (S01 contract) |
| A15 | Step endpoint takes `@Body() body: unknown` and an unvalidated `step` string; errors are a single joined string; schemas are non-strict | `api/onboarding.controller.ts:35`; `application/onboarding-session.service.ts:27-32`; `domain/questionnaire.ts:11-34` | FR-001, AS-02; contract schemas, strict, `errors: [{path, message}]` |
| A16 | Cross-step rule only checks "VAT registered ⇒ number" | `domain/questionnaire.ts:40-42` | FR-003, AS-04, AS-72 |
| A17 | After submit `GET` returns an empty `answers` (the draft is gone) and no `status`, `submissionNo`, per-kind progress | `api/onboarding.controller.ts:40-43`; `application/onboarding-session.service.ts:37-41` | AS-09, AS-55 |
| A18 | No application status, no rounds, no way back after a rejection; `ShopOnboarding` has no `status`, `submissionNo`, `rejectedAt` | `migrations/20261002170000-seller-onboarding.js:20-26` | FR-003, FR-005, AS-56, AS-57, AS-70 |
| A19 | Document request: accepts any kind (including a VAT certificate when not VAT registered), any application state, unlimited distinct files, always `201`; uniqueness is per `(shop, kind, hash)` | `application/onboarding-documents.service.ts:43-65`; migration line 37 | FR-010, FR-012, AS-13, AS-14, AS-18, AS-19, AS-57; add round column, partial caps, state gates |
| A20 | `uploaded` checks only that an object exists (`head`), not its size; missing object is `400`; `upload` grant shape unspecified | `application/onboarding-documents.service.ts:63-66` | FR-013, AS-16 (`409 upload_not_received`, `422 upload_mismatch`) |
| A21 | No rate limits on uploads or submit | `api/onboarding.controller.ts:48-58` | FR-015, AS-20; S50 policies |
| A22 | `ShopScoped('shop.manage')` is used but the controller still imports tenancy and identity internals (`UserRawDto`, `Firewall`, `Role` from barrels), responses are not contract DTOs, errors are Nest exceptions with free text, no stable `code` | `api/onboarding.controller.ts:3-6,38-80`; all services | V.1–V.3, FR-100, AS-65, AS-68 |
| A23 | Review: `reason` optional with default text; unknown corrections ignored; unbounded `corrections` record; resolved task reports `404`; no application-level rejection; no conflict-of-interest check; not sensitive | `api/onboarding.controller.ts:22-26,70-82`; `application/review.service.ts:68-76,60-66` | FR-031–FR-034, AS-39, AS-42–AS-47 |
| A24 | Review queue returns a bare array limited by `limit`, ordered by `createdAt` only (no tiebreaker), no cursor, `LEFT JOIN LATERAL` over another table's rows is fine (own tables) but the order is not deterministic | `application/review.service.ts:38-56`; `api/onboarding.controller.ts:72-75` | FR-030, AS-37, AS-38; keyset on `(createdAt, id)` |
| A25 | Human approval does not require key fields; corrections of non-sensitive fields stored unmasked and unbounded | `application/review.service.ts:85-98` | FR-032, AS-42 |
| A26 | No audit of resolves or file-link issues; no queue-age, duration, token or failure metrics (only three counters) | `application/review.service.ts:28-29,56,121`; `application/extraction.service.ts:42` | FR-035, FR-070, AS-48, AS-66 |
| A27 | Events: aggregate/topic `shops`, no `submissionNo`, no `shop.rejected`, no `shop.onboarding_document_rejected`; verification event written with version arg `2` for `ShopVerified.create` | `application/events/onboarding-events.ts:4-14`; `application/verification.service.ts:55` | AS-54, Provides (topic `shop-onboarding`) |
| A28 | Purge job: scheduled only on verification, payload `{shopId}`, raw SQL in `infra/` with `now()` in SQL, deletes inside a loop with per-file updates, no per-round scope, no rejection or shop-deletion trigger, no erase job, no consumer of `tenancy.shop_deleted` | `infra/onboarding.jobs.ts:19-33`; `application/verification.service.ts:56-60` | FR-050, AS-58–AS-61 |
| A29 | No status history, so transitions are not auditable; document and application transitions are not asserted as one-row conditional updates everywhere | all services (`UPDATE "ShopDocument" … WHERE id = :id` in `review.service.ts:70,103,105`) | FR-062, AS-70 |
| A30 | Modules import other domains' internals: `LlmModule`, `LlmMeter`, `LLM_PROVIDER`, `LlmTurnResult`, `textOf`, `LlmUnavailableError` from `assistant`; `UsageService` from `billing`; ClickHouse and Kafka producer modules (the extraction Lambda boots analytics clients it should not need); `SecretBox` and `AuthModule` from identity | `onboarding.module.ts:7-10,15,34`; `application/extraction.service.ts:9,17`; `apps/lambdas/src/handlers/document-extractor.ts:7` | FR-060, debt D-14, S46 (port in `libs/infrastructure/llm`, metering by `llm.call_completed`), AS-62 |
| A31 | Layering: application services run raw SQL through `@InjectConnection` Sequelize, no repository ports in `domain/`, no repositories in `infra/`; `OnboardingModule` exports `VerificationService` (nobody imports it) | `application/*.ts`; `onboarding.module.ts:22-23` | I.1, I.2, debt D-6; repository ports and adapters; export nothing from `OnboardingModule` |
| A32 | Barrel exports `ExtractionService` and the three modules; its comment says models are exported (none are) | `index.ts:1-8` | X.4, debt D-8; keep modules, `ExtractionService` (process, routeToReview) and contract types; drop the stale comment |
| A33 | Schema: foreign keys `ShopOnboarding.shopId → Shop`, `ShopDocument.shopId → Shop` | `migrations/20261002170000-seller-onboarding.js:22,32` | FR-060, AS-62, IX.4.3; expand/contract: drop the constraints |
| A34 | Schema lacks: `ShopOnboarding.status/submissionNo/rejectedAt/rejectionReasonCode/rejectionReason`, `ShopDocument.submissionNo` and the new per-round unique index, `ShopDocument.leaseUntil`, `ReviewTask` status `CANCELLED`, status history table, `ReviewTask(documentId)` and `(createdAt, id)` queue index, `lock_timeout` on each statement set | `migrations/20261002170000-seller-onboarding.js` | FR-003, FR-005, FR-012, FR-025, FR-030, FR-062, III.11 |
| A35 | The migration also adds `Shop.verificationStatus` and `Shop.payoutsEnabled` (tenancy-owned columns) | `migrations/20261002170000-seller-onboarding.js:12-17` | IX.3; tenancy's migration (S03 A17) must own them; leave this migration's history untouched |
| A36 | Config: `onboarding_extraction_model` / `onboarding_escalation_model` read with inline defaults; no schema validation | `application/extraction.service.ts:56-58`; `libs/common/config/types.ts` | AS-69; zod schema, startup failure |
| A37 | Existing e2e covers about 12 of 72 scenarios; seeds shops and memberships through tenancy's models and raw `UPDATE "User"`; reads `"Shop"` directly; calls `extraction.process` and the jobs directly (fine) but never exercises HTTP concurrency, 401, cross-tenant, rate limit, outbox rows beyond one count, consumers, logs, metrics; has a `console.log('SUBMIT ERROR')` | `onboarding.e2e-spec.ts:15,22,81,88,112` (also S01 gaps line 129, S03 gaps lines 60,77) | `test-plan.md`: split into the seven files named there; seed through `test/seeds`; read the shop's status from tenancy's events/R1 in tests only |
| A38 | Unit coverage is only `validators.spec.ts` (IBAN, VAT DE/PL, names); missing: NL VAT, mod-97 property test, extraction rules, file type, status machines, questionnaire, config | `domain/validators.spec.ts:1-51` | AS-23, AS-28, AS-69–AS-72 |
| A39 | Review responses expose raw `reasons` and masked `fields` already; the seller view (`publicView`) is correct, but `GET /onboarding` lists documents by raw SQL `SELECT *` (all columns incl. `storageKey` pulled into memory) | `application/onboarding-documents.service.ts:79-86` | AS-55 (select only the public columns) |
| A40 | No web screens exist for the wizard or the moderator queue | `packages/web/app` (no onboarding or review route) | UI journeys in `test-plan.md`; owned by the web capabilities |

## B. Debt-register rows (open) that name `seller-onboarding` or S04

| Row | What | Mechanism / where it is paid |
|---|---|---|
| D-6 (I.2) | Layering: application services use the Sequelize connection directly, no ports in `domain/` | repository ports in `domain/`, adapters in `infra/` (A31) |
| D-7 (IX.4) | Other domains' `*Model` imports | none for this domain (no `MODEL` row); keep it that way: the e2e must stop importing tenancy's `ShopModel` (A37) |
| D-8 (X.4) | Barrel exports infrastructure internals | `index.ts` exports modules, `ExtractionService`, contract types (A32); the Lambda imports `OnboardingExtractionModule` and a dead-letter entry only |
| D-12 (IX.4) | Raw SQL on other domains' tables | the three `Shop` lines of section C (A1–A3) |
| D-14 (X.3, X.7) | The LLM port and adapters live in `assistant/infra/llm/`; seller-onboarding and the Lambda use them; `llm-meter` calls billing directly | S46 moves the port to `libs/infrastructure/llm`; S04 switches the import and drops `LlmMeter`, `UsageService`, ClickHouse and Kafka producer imports (A30) |

D-15, D-16, D-17 and the resolved rows do not name this domain.

## C. `pnpm --dir packages/backend check:table-ownership` lines for `seller-onboarding` (3 findings, 0 `MODEL`)

| Line | Kind | Table (owner) | File | IX.7 mechanism that replaces it |
|---|---|---|---|---|
| 1 | SQL | `Shop` (tenancy) | `libs/domains/seller-onboarding/application/onboarding-session.service.ts` (`:59`, status → `PENDING`) | **Event + R3-style consumption in tenancy**: this domain publishes `shop.onboarding_submitted` (outbox); tenancy owns the `Shop` update (S03 AS-72). No cross-domain write remains. |
| 2 | SQL | `Shop` (tenancy) | `libs/domains/seller-onboarding/application/review.service.ts` (`:43`, `JOIN "Shop"`) | **R1**: `ShopQueryService.getShopsByIds(ids)` (batch, DTO), merged by ID in the application service. |
| 3 | SQL | `Shop` (tenancy) | `libs/domains/seller-onboarding/application/verification.service.ts` (`:49`, `VERIFIED`/`payoutsEnabled`) | **Event**: `shop.verified` (outbox, same transaction); tenancy applies it. |

Other cross-domain edges the static check cannot see but the spec bans: the two foreign keys to `Shop` (A33, IX.4.3), the `Shop` column migration (A35), the ClickHouse/Kafka/billing/assistant imports (A30), and the `LEFT JOIN`s that stay inside this domain's own four tables (allowed).

`pnpm --dir packages/backend check:table-ownership --strict` must exit 0 for these three lines once A1–A3 land (AS-62); the static gate stays the merge-blocking enforcement.

## D. Suggested implementation order

1. Contracts and config (A15, A22, A36), strict schemas and pure domain modules with unit specs (A13, A16, A38; AS-23, AS-28, AS-69–AS-72).
2. Migration (A18, A33, A34) as expand/contract; repository ports (A31).
3. Stop writing and reading `Shop` (A1–A3), outbox events with the new topic (A27), the verification-in-transaction change (A4).
4. Documents: rounds, caps, gates, confirm rules, outbox command (A5, A8, A19–A21).
5. Extraction: lease, conditional finish, strict output, sealing context, dead-letter handler, port switch (A6, A7, A9–A12, A14, A30).
6. Review: pagination, decisions, conflict of interest, audit, metrics (A23–A26).
7. Retention jobs and the `shop_deleted` consumer (A28).
8. Rewrite the e2e into the seven files of `test-plan.md` (A37) and run them green (VII.9).
