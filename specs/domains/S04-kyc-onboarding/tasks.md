# Tasks: S04 Seller Onboarding / KYC (`seller-onboarding`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md` (A1–A40, D-6/7/8/12/14), `questions.md` (defaults accepted), `research.md` (R-01…R-16), `data-model.md`, `contracts/`, `quickstart.md`.
**Tests**: required (test-plan.md, constitution VII). Within every story each failing test task comes **before** its code task (red → green).
**Paths**: `SO` = `packages/backend/libs/domains/seller-onboarding`; `CT` = `packages/contracts/src/onboarding`; `MIG` = `packages/backend/migrations`. Run backend commands from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; units with `pnpm jest SO/domain`.
**Stop rule**: the same test failing after 5 fix attempts ⇒ write blocker, attempts and hypothesis into `questions.md` and stop.
**Never**: git checkout/restore/reset/stash/clean; new direct `sequelize.transaction`; editing `*.reviewed.json` or another capability's spec; describing an unrun criterion as verified.
**Lessons applied**: L-001 (no `groupId` on the standard queue; validate at creation), L-002/L-020 (queue + DLQ in `elasticmq.conf`, reload), L-003 (no "A or B" asserts), L-004/L-015/L-018 (real API and standalone Lambda boot), L-006 (tests seed their own data via `test/seeds`), L-008 (batches, summary line), L-011 (tables in test stack), L-012/L-019 (fresh-stack proofs at the end), L-017 (every scenario of the 12 old tests survives the split).

Story map: US1 questionnaire (AS-01–09) · US2 documents (AS-10–21) · US3 extraction (AS-22–36) · US4 review (AS-37–48) · US5 verification (AS-49–54) · US6 seller view (AS-55) · US7 resubmission (AS-56–57) · US8 retention (AS-58–61) · US9 boundaries (AS-62–68). Pure-logic scenarios AS-23, 28, 69–72 are in Phase 2.

---

## Phase 1: Setup

- [ ] T001 Record baselines: run `pnpm --dir packages/backend check:table-ownership` and `grep -rn "sequelize.transaction" SO` and confirm the 3 direct sites (`application/onboarding-documents.service.ts:~106`, `application/extraction.service.ts:~303`, `application/review.service.ts:~87`, each with a `// S54 T037 audit` comment) match `specs/domains/S04-kyc-onboarding/.tx.baseline`; list the 12 tests in `SO/onboarding.e2e-spec.ts` in a scratch note (L-017 scenario inventory, kept until T176).
- [ ] T002 Confirm the test stack is up and migrated (`pnpm run db:jest:migrate:up`); verify `docker-compose.test.yaml` services (Postgres, Redis, object storage, ElasticMQ) respond; if not, report as blocked, do not fake.
- [ ] T003 [P] Check shared helpers exist and note their import paths: `test/seeds` (shop + membership + platform-role users), `expectContract`, `ScriptedLlmProvider` (`@app/infrastructure/llm`), `OutboxService.appendTask`, `TransactionRunner` (`libs/infrastructure/context/transaction-runner.service.ts`), S50 rate limiter, S49 jobs, S53 inbox. Add any missing seed helper to `test/seeds` only (never models inside specs).

---

## Phase 2: Foundational (blocks all stories) — plan groups A and B

### 2a. Contracts, errors, config, pure domain (group A) — tests first

- [ ] T004 [P] Write failing unit spec `SO/domain/status-machines.spec.ts` (AS-70): `it.each` over every state × event for application (`SUBMITTED→VERIFIED`, `SUBMITTED→REJECTED`, `REJECTED→SUBMITTED` with `submissionNo + 1`, `VERIFIED` terminal) and document (`AWAITING_UPLOAD→QUEUED`, `QUEUED→EXTRACTING`, `EXTRACTING→APPROVED|NEEDS_REVIEW`, `NEEDS_REVIEW→APPROVED|REJECTED`, `QUEUED|EXTRACTING|NEEDS_REVIEW|REJECTED→SUPERSEDED`; `QUEUED→NEEDS_REVIEW` NOT allowed), plus review task `OPEN→APPROVED|REJECTED|CANCELLED`.
- [ ] T005 [P] Write failing unit spec `SO/domain/validators.spec.ts` additions (AS-71, A38): NL VAT cases, `fast-check` property for IBAN mod-97 (valid generated IBANs pass, any single-digit change fails), masking of IBAN/VAT/holder; keep existing DE/PL/name cases.
- [ ] T006 [P] Write failing unit spec `SO/domain/questionnaire.spec.ts` (AS-72, A16): `it.each` per-step strict schemas (unknown field rejected), cross-step rules "VAT registered ⇒ number", "VAT number ⇒ registered", "number valid for the business country", required-document derivation per country/legal form/VAT.
- [ ] T007 [P] Write failing unit spec `SO/domain/extraction-rules.spec.ts` (AS-23, A13/A38): `it.each` per issue code and boundary date (statement age 180 days boundary, name match threshold 0.6 boundary), escalation flags, injected `now`.
- [ ] T008 [P] Write failing unit spec `SO/domain/file-type.spec.ts` (AS-28, A13): `it.each` magic bytes for PDF/PNG/JPEG, mismatch with declared type, truncated/empty/unknown.
- [ ] T009 [P] Write failing unit spec `SO/domain/extraction-config.spec.ts` (AS-69, A36): `it.each` bad configurations (lease ≤ 45 s model timeout, threshold outside 0..1, attempts ≠ 2 cap, negative days, empty model names) fail with a message naming the key; defaults valid.
- [ ] T010 [P] Contract schemas in `CT/` (A15, A22, R-13): strict zod for the step bodies (`business|tax|catalog|policies`), step param, submit request/response (`submissionNo`), onboarding view (`status`, `submissionNo`, submitted answers, `requiredDocuments: {kind, status}[]`, documents with public columns only), upload request/response, confirm response, review queue `{items, nextCursor}` with `attempts`, resolve request (decisions `APPROVE|REJECT|REJECT_APPLICATION`, `reason` 3–500 chars required on reject, bounded `corrections`), problem+json with `errors: [{path, message}]` and the stable `code` list of FR-100; export from the contracts index.
- [ ] T011 [P] Error classes and stable codes in `SO/domain/errors.ts` (FR-100): `validation_failed`, `document_not_required`, `upload_not_received` (409), `upload_mismatch` (422), `task_already_resolved` (409), `review_task_not_found` (404), `missing_fields` (422), conflict-of-interest, state-gate and cap codes; extend the problem+json base; no free text from user data.
- [ ] T012 Implement `SO/domain/application-status.ts` and `SO/domain/document-status.ts` (exhaustive, `assertNever`) to pass T004.
- [ ] T013 Implement `SO/domain/validators.ts` additions (NL VAT, masking helpers) to pass T005.
- [ ] T014 Rewrite `SO/domain/questionnaire.ts` (A15, A16): strict per-step schemas, cross-step rules, required-document derivation; pass T006.
- [ ] T015 Create `SO/domain/extraction-rules.ts` (A13): move `evaluate` out of `application/extraction.service.ts:140-186`, take an injected `now`, no `Date.now()`; pass T007.
- [ ] T016 Create `SO/domain/file-type.ts` (A13): move `sniff` out of `application/extraction.service.ts:211-217`; pass T008.
- [ ] T017 Create `SO/domain/extraction-config.ts` (A36): zod schema for `onboarding_extraction_model`, `onboarding_escalation_model`, thresholds (name match 0.6, statement age 180 d), model timeout 45 s, lease 5 min (must exceed the timeout), attempts 2, link 300 s, grant 15 min, retention 30 d / 1825 d; validated at module start (startup failure); wire into `libs/common/config/types.ts`; pass T009.
- [ ] T018 Make `SO/domain/extraction-schema.ts` strict (A11): `.strict()` on every level, caps on value lengths and confidence range; any extra key ⇒ `invalid_output`.
- [ ] T019 Run `pnpm jest libs/domains/seller-onboarding/domain` — all green.

### 2b. Migration, ports, adapters (group B)

- [ ] T020 Write failing check in `SO/onboarding-boundaries.e2e-spec.ts` skeleton (describe `Seller onboarding: boundaries and observability (e2e)`) that asserts the new columns/tables/indexes exist and the two FKs are gone (catalog query) — fills in AS-62 later (T150); here only the schema assertions (red).
- [ ] T021 Expand migration `MIG/2026101x-seller-onboarding-s04.js` (A18, A34, R-11; history of `20261002170000` untouched). `ShopOnboarding`: `status text NOT NULL` default `SUBMITTED` with CHECK `SUBMITTED|VERIFIED|REJECTED`; `submissionNo int NOT NULL default 1` CHECK ≥ 1; `verifiedAt`, `rejectedAt` timestamptz null; `rejectionReasonCode text null` CHECK `DOCUMENTS_INVALID|IDENTITY_MISMATCH|FRAUD_SUSPECTED|OTHER`; `rejectionReason text null` 3–500 chars. `ShopDocument`: `submissionNo int NOT NULL default 1`, `leaseUntil timestamptz null`, `purgedAt` ensured, status CHECK `AWAITING_UPLOAD, QUEUED, EXTRACTING, NEEDS_REVIEW, APPROVED, REJECTED, SUPERSEDED`. `ReviewTask`: status CHECK `OPEN|APPROVED|REJECTED|CANCELLED`, `corrections jsonb`, `resolvedBy`, `resolvedAt`. New table `OnboardingStatusHistory {id uuid PK, entity text ('APPLICATION'|'DOCUMENT'), entityId uuid, shopId uuid, fromStatus text null, toStatus text, actor text ('system'|'user:<uuid>'|'worker'), reasonCode text null, at timestamptz}`. Indexes `CONCURRENTLY` outside a transaction: unique `(shopId, submissionNo, kind, contentHash)`, `(shopId, submissionNo, kind)`, partial `(status, leaseUntil) WHERE status='EXTRACTING'`, partial unique `ReviewTask(documentId) WHERE status='OPEN'`, `(createdAt, id) WHERE status='OPEN'`, `(shopId) WHERE status='OPEN'`, history `(entity, entityId, at)`; `DocumentExtraction` unique `(documentId, attempt)`. `SET lock_timeout` on each statement set; batch backfill `status='SUBMITTED'` (`VERIFIED` only if derived from this domain's own `verifiedAt`/documents, never from `Shop`), `submissionNo=1`; down migration defined. Does not touch `Shop.*` columns (A35).
- [ ] T022 Run the migration on the test stack and compare tables with the doctor (L-011); T020 schema assertions that do not depend on the contract migration go green.
- [ ] T023 [P] Repository ports in `SO/domain/ports.ts` (A31, R-10): `ApplicationRepository` (incl. row lock `FOR UPDATE`), `DocumentRepository`, `AttemptRepository`, `ReviewTaskRepository`, `StatusHistoryRepository`; Transaction taken from the ambient context.
- [ ] T024 Sequelize adapters `SO/infra/application.repository.ts`, `document.repository.ts`, `attempt.repository.ts`, `review-task.repository.ts`, `status-history.repository.ts`; every transition is `UPDATE … WHERE id/shopId=? AND status=<from>` asserting 1 row plus a history row (A29, FR-062); document selects only public columns for the seller view (A39).
- [ ] T025 Migrate the three direct `sequelize.transaction` sites to `TransactionRunner.run`/`@Transactional` and delete each `// S54 T037 audit` comment (rule 4, R-03): `application/onboarding-documents.service.ts`, `application/extraction.service.ts`, `application/review.service.ts`. Confirm `grep -rn "sequelize.transaction" SO` is 0.
- [ ] T026 Refactor application services to use the ports (A31, D-6): remove `@InjectConnection` raw SQL from `application/*.ts`; `OnboardingModule` exports nothing (`onboarding.module.ts:22-23`).
- [ ] T027 Clean the barrel `SO/index.ts` (A32, D-8): export the three modules, `ExtractionService` (`process`, `routeToReview`) and contract types only; delete the stale comment.
- [ ] T028 Run the existing `SO/onboarding.e2e-spec.ts` as a smoke (`test-spec.sh`) plus `pnpm tsc --noEmit -p .` — behaviour unchanged, still green.

**Checkpoint**: units green, migration applied, ports in place, 0 direct transaction sites.

---

## Phase 3: US1 — Questionnaire in stages (P1) — AS-01–09

**Goal**: four-step drafts in Redis, strict validation, single idempotent submit.
**Independent test**: `onboarding-questionnaire.e2e-spec.ts` (AS-01–09) green on its own.

- [ ] T029 [US1] Create `SO/onboarding-questionnaire.e2e-spec.ts` (describe `Seller onboarding: staged questionnaire (e2e)`; real modules, production pipe/filter/prefix; `expectContract` on every response; seeds via `test/seeds`; carry over the questionnaire scenarios of the old spec). Failing tests, one per row: AS-01 (view, draft key `onboarding:draft:<shopId>` + 7 d TTL, no row, no event), AS-02 (table-driven over steps: validation classes, unknown step, unknown field, body shape, `errors:[{path,message}]`), AS-03 (sliding TTL, step independence, concurrent saves via `Promise.all`, expiry by key deletion), AS-04 (missing steps, cross-step rules, nothing persisted), AS-05 (row, one outbox `shop.onboarding_submitted`, draft dropped, **no `Shop` write**), AS-06 (`Promise.all` ×5, one row/one event; 20 repetitions), AS-07 (no edits after submit/verification), AS-08 (401, cross-tenant 404, permission 403 for staff/viewer, suspended gate, draft isolation; route-table driven), AS-09 (view in every state parses with contract).
- [ ] T030 [US1] Replace `api/onboarding.controller.ts` questionnaire routes with a thin controller using the contract schemas via a validation pipe (A15, A22); `ShopScoped('shop.manage')`; remove tenancy/identity internals imports; split into `api/onboarding.controller.ts` and `api/review.controller.ts` (review routes moved in US4).
- [ ] T031 [US1] Rewrite `application/onboarding-session.service.ts` (A1, A15, A17): strict step validation, Redis draft store `infra/draft.store.ts` (one hash field per step, `HSET` + `EXPIRE` in one script, 7 d sliding), submit in `TransactionRunner.run`: lock application row, insert/transition row, history row, outbox `shop.onboarding_submitted` `{shopId, submissionNo, country, legalForm, requiredDocuments}`; idempotent/concurrent submit returns the same result; **delete `UPDATE "Shop"` (`:59`)**; draft deleted after commit.
- [ ] T032 [US1] Define the events in `application/events/onboarding-events.ts` via `defineEvent` (A27, R-01): aggregate `shops` (topic `shops.events`), key `shopId`, `shopId` validated as UUID, `shop.onboarding_submitted` v1, `shop.verified` v1 (contract version stays 1; tenancy matches only v1), `shop.rejected` v1, `shop.onboarding_document_rejected` v1; the only registration (tenancy must not re-register). Event bodies as in `contracts/events.md`.
- [ ] T033 [US1] Declare S50 policy `onboarding.submit.shop` (10/day, fail-closed) and apply it to submit (A21). Idempotent replays of an already submitted application do not consume the limit (questions.md RESOLVED); AS-06/SC-002 tests use a fresh shop per repetition.
- [ ] T034 [US1] Run `test-spec.sh libs/domains/seller-onboarding/onboarding-questionnaire.e2e-spec.ts` until AS-01–09 are green (AS-56/57 are US7).

---

## Phase 4: US2 — Upload business documents (P1) — AS-10–21

**Goal**: grants, de-duplication, caps, gates, outbox command, supersede.
**Independent test**: `onboarding-documents.e2e-spec.ts`.

- [ ] T035 [US2] Create `SO/onboarding-documents.e2e-spec.ts` (describe `Seller onboarding: document intake (e2e)`). Failing tests: AS-10 (upload before submit → 409), AS-11 (request body, grant shape, row), AS-12 (table-driven validation classes), AS-13 (kind not required → 422 `document_not_required`), AS-14 (de-dup: `201` new/`200` same, `Promise.all` ×5 one row), AS-15 (confirm: status `QUEUED`, outbox `onboarding.extract_document` row in the same tx, replay idempotent), AS-16 (`409 upload_not_received`, `422 upload_mismatch` on size), AS-17 (newer file supersedes unresolved incl. `EXTRACTING`, open tasks `CANCELLED`), AS-18 (approved-kind, verified and rejected-application gates), AS-19 (5 per kind per round, counting superseded), AS-20 (upload 20/h and submit 10/day → 429, real limiter, frozen clock), AS-21 (cross-tenant → 404).
- [ ] T036 [US2] Rewrite `application/onboarding-documents.service.ts` (A8, A19, A20, A39): required-kind and state gates, caps under the application row lock, per-round uniqueness `(shopId, submissionNo, kind, contentHash)`, confirm checks object existence (`upload_not_received`) and size (`upload_mismatch`), supersede includes `EXTRACTING`, cancels `ReviewTask` (`OPEN→CANCELLED`), history rows, public-columns-only listing.
- [ ] T037 [US2] Outbox command (A5, R-04, L-001): `OutboxService.appendTask` type `onboarding.extract_document` v1 `{documentId: uuid}` in the confirming transaction; remove the post-commit `queue.enqueue`; validate the input where the task is created; no `groupId`.
- [ ] T038 [US2] Add queue `onboarding-documents` and its DLQ (max receives 5, visibility ≥ 270 s) to `elasticmq.conf`; readiness fails while a consumed queue is missing; document the reload command for unattended agents and reload the queue server (L-002, L-020).
- [ ] T039 [US2] Declare S50 policy `onboarding.upload.shop` (20/hour, fail-closed) and apply it to the upload request (A21).
- [ ] T040 [US2] Run `onboarding-documents.e2e-spec.ts` until green.

---

## Phase 5: US3 — AI reads the document, rules decide (P1) — AS-22–36

**Goal**: leased claim, bounded model calls, strict output, sealed values, dead-letter path.
**Independent test**: `onboarding-extraction.e2e-spec.ts`.

- [ ] T041 [US3] Create `SO/onboarding-extraction.e2e-spec.ts` (describe `Seller onboarding: AI extraction (e2e)`; `ScriptedLlmProvider`, in-memory storage with fault injection, frozen clock; drive `ExtractionService.process` and, for AS-34, the Lambda `handler` with an SQS event). Failing tests: AS-22 (one cheap call, no tools, schema, approved), AS-24 (escalation fixes misread, 2 attempts), AS-25 (exhausted → review), AS-26 (prompt-injected doc: name mismatch, no escalation, not verified), AS-27 (table-driven hostile/malformed answers → `invalid_output`, empty tool list; ≥ 30 variants for SC-003), AS-29 (declared type ≠ bytes → review, no model call), AS-30 (masked view, values sealed with context `kyc:<documentId>:<attempt>`, no PII in captured logs), AS-31 (redelivery, `Promise.all` concurrent workers → one claim, resume at attempt 2, no-op messages; ≤ 2 model calls ever, SC-004), AS-32 (provider failure, lease expiry via clock advance, dead-letter routing), AS-33 (superseded during extraction: result discarded, no task/event/verification), AS-34 (invalid payloads as failed batch items), AS-35 (missing object → review `file_missing`; transient storage error propagates), AS-36 (`LlmCallRecorder` record with `purpose: "extraction"`, `callId "<documentId>:<attempt>"`, metering failure tolerated).
- [ ] T042 [US3] Switch the LLM port (A30, D-14, S46 follow-up, R-07): import `LLM_PROVIDER`, `LlmUnavailableError`, `LlmRejectedError`, `LlmCallRecorder` from `@app/infrastructure/llm`; per call `maxRetries: 0`, `timeoutMs: 45000` (from config), `callId = "<documentId>:<attempt>"`, `purpose: "extraction"`, `subjectId = shopId`, `scopeId = documentId`; recorder errors caught and counted. Remove `LlmModule`, `LlmMeter`, billing `UsageService`, ClickHouse and Kafka producer imports from `onboarding.module.ts` (`:7-10,15,34`) and `apps/lambdas/src/handlers/document-extractor.ts:7`; inject the secret sealer through the identity public barrel only (no `AuthModule` internals).
- [ ] T043 [US3] Rewrite `application/extraction.service.ts` claim (A6, R-05): `UPDATE … SET status='EXTRACTING', leaseUntil=<clock now + lease> WHERE id=? AND (status='QUEUED' OR (status='EXTRACTING' AND leaseUntil < now))`, 0 rows ⇒ no-op ack; `now` from the injected clock, not SQL `now()`; short claim tx, then storage read and model calls **outside** any transaction (AS-64), then short finish tx.
- [ ] T044 [US3] Conditional finish (A7, A12): `UPDATE … WHERE id=? AND status='EXTRACTING'` asserting one row; otherwise discard (no task, no verification, no event); `DocumentExtraction` insert `ON CONFLICT (documentId, attempt) DO NOTHING`; resume from stored attempts (attempt 1 never paid twice); missing object ⇒ `routeToReview('file_missing')`; storage transient error propagates.
- [ ] T045 [US3] Sealing context (A14, S01 follow-up, R-08): `seal(json, 'kyc:<documentId>:<attempt>')`; legacy no-context values still open; human attempt = next number with `model='human'`.
- [ ] T046 [US3] Use `domain/extraction-rules.ts`, `file-type.ts`, strict schema from the service; escalate once on `ESCALATE`, ≤ 2 calls per document; name-mismatch/injection never escalates and is never approved.
- [ ] T047 [US3] `ExtractionService.routeToReview(documentId, reason)` (A9): idempotent, claims first (`QUEUED→EXTRACTING`) then `EXTRACTING→NEEDS_REVIEW` per the state machine, creates one `OPEN` task, increments `kyc_extraction_failures_total{reason}`.
- [ ] T048 [US3] Lambda `apps/lambdas/src/handlers/document-extractor.ts`: partial batch failure items (invalid body ⇒ failed item, no side effect); new `document-extractor-dlq.ts` calling `routeToReview(documentId, 'extraction_unavailable')`; the Lambda app imports `OnboardingExtractionModule` only (L-018).
- [ ] T049 [US3] Run `onboarding-extraction.e2e-spec.ts` until green.

---

## Phase 6: US4 — Human review (P1) — AS-37–48

**Goal**: keyset queue, strict decisions, conflict of interest, audit.
**Independent test**: `onboarding-review.e2e-spec.ts`.

- [ ] T050 [US4] Create `SO/onboarding-review.e2e-spec.ts` (describe `Seller onboarding: human review (e2e)`). Failing tests: AS-37 (shape, masking, order, link or null, filter), AS-38 (120 tasks keyset `(createdAt, id)`, limit cap 100, tampered cursor → 400), AS-39 (401, 403 non-staff, revoked session refused on sensitive route), AS-40 (approve as-is), AS-41 (corrections, masked pairs, correction counters), AS-42 (table-driven: hard checks, `missing_fields` 422, invalid/unknown/over-long corrections 400), AS-43 (reject doc: reason 3–500, event `shop.onboarding_document_rejected`, seller sees reason), AS-44 (`Promise.all` two reviewers, one winner), AS-45 (stale 409, resolved `409 task_already_resolved`, unknown `404 review_task_not_found`, malformed id), AS-46 (`REJECT_APPLICATION`), AS-47 (conflict of interest refusal), AS-48 (captured audit stream: `{reviewerId, taskId, shopId, decision, outcome}`, no personal data).
- [ ] T051 [US4] `api/review.controller.ts` (A22, A23): contract schemas, `Firewall({roles: ['ADMIN','MODERATOR'], sensitive: true})`, no tenancy/identity internals.
- [ ] T052 [US4] Rewrite `application/review.service.ts` queue (A3, A24, R-09): keyset on `(createdAt, id)` with opaque validated cursor, `{items, nextCursor}`, limit ≤ 100, `attempts`; shop names via **one** `ShopQueryService.getShopsByIds` call per page (ids de-duplicated, `shopName: null` when absent); remove `JOIN "Shop"` (`:43`).
- [ ] T053 [US4] Rewrite `resolve` (A23, A25, A29): required `reason` 3–500 chars on reject, strict bounded corrections stored masked, key fields required for approval, `REJECT_APPLICATION` (`SUBMITTED→REJECTED`, history, outbox `shop.rejected` `{shopId, submissionNo, rejectedAt, reasonCode}`, cancel open tasks, schedule purge — needs T065 (Phase 10) and the policy of T058; build the purge-scheduling call behind T065's port, so T053 depends on T058 and T065), single-winner conditional updates, human attempt sealed with context (T045), `open` with context.
- [ ] T054 [US4] Conflict-of-interest check with `ShopAccessService.getRole(shopId, userId)` from the tenancy public barrel (A23, R-09).
- [ ] T055 [US4] Audit logger and metrics (A26, R-14): audit via the S54 audit logger on resolve and file-link issue; add the seven series of AS-66 (review duration, queue age gauge `kyc_review_queue_oldest_age_seconds`, tokens, failures, correction rate per field, etc.) without identifiers as labels.
- [ ] T056 [US4] Run `onboarding-review.e2e-spec.ts` until green.

---

## Phase 7: US5 — Verified exactly once (P1) — AS-49–54

**Goal**: verification inside the approving transaction, serialized per shop.
**Independent test**: `onboarding-verification.e2e-spec.ts`.

- [ ] T057 [US5] Create `SO/onboarding-verification.e2e-spec.ts` (describe `Seller onboarding: verification and view (e2e)`). Failing tests: AS-49 (verified in the approving tx: event, purge job key `purge:<shopId>:<submissionNo>`, **no `Shop` write**), AS-50 (partial/non-required approvals do not verify), AS-51 (`Promise.all` last two approvals → one verification, one event), AS-52 (`VERIFIED` final), AS-53 (real Postgres trigger fails one outbox insert ⇒ approval rolled back, retry completes; trigger dropped in `afterEach`, L-013), AS-54 (event envelope and payload contracts; nothing emitted on 4xx).
- [ ] T058 [US5] Create `application/verification-policy.service.ts` (A2, A4, R-02): `evaluate(tx, shopId)` locks the application row (`FOR UPDATE`), checks required-kind approvals, `UPDATE … SET status='VERIFIED', verifiedAt WHERE shopId=? AND status='SUBMITTED'` (asserts 1 row), history row, outbox `shop.verified` `{shopId, submissionNo, verifiedAt}`, `jobs.enqueue(purge)`; call it inside `finish` (extraction) and `resolve` (review) transactions; delete `verification.service.ts` `UPDATE "Shop"` (`:49-52`) and the separate-transaction `maybeVerify` (`review.service.ts:122`, `extraction.service.ts:202`).
- [ ] T059 [US5] Run `onboarding-verification.e2e-spec.ts` until green; run `pnpm --dir packages/backend check:table-ownership --strict` and confirm the `seller-onboarding` block is empty (A1–A3).

---

## Phase 8: US6 — Seller sees progress, never extracted data (P1) — AS-55

- [ ] T060 [US6] Add failing AS-55 test to `onboarding-verification.e2e-spec.ts`: seller view returns statuses, rejection reason of documents, `requiredDocuments`, `submissionNo`; never extracted values, `storageKey`, masked fields or attempts; response parses with the contract.
- [ ] T061 [US6] Implement the view in `application/onboarding-session.service.ts`/`documents.service.ts` (A17, A39): submitted answers after submission, `status`, `submissionNo`, per-kind progress, public columns only; pass T060.

---

## Phase 9: US7 — Resubmission after rejection (P2) — AS-56–57

- [ ] T062 [US7] Add failing AS-56 and AS-57 tests to `onboarding-questionnaire.e2e-spec.ts`: after `REJECTED`, first step save seeds the draft from last answers with the saved step replaced; submit → `REJECTED→SUBMITTED`, `submissionNo = 2`, new `shop.onboarding_submitted`; same file accepted in round 2 (per-round uniqueness); concurrent resubmissions (`Promise.all`) → one round.
- [ ] T063 [US7] Implement draft seeding in `infra/draft.store.ts` and the `REJECTED→SUBMITTED` transition (`submissionNo + 1`, history, outbox) in `onboarding-session.service.ts`; pass T062.

---

## Phase 10: US8 — Retention (P2) — AS-58–61

- [ ] T064 [US8] Create `SO/onboarding-retention.e2e-spec.ts` (describe `Seller onboarding: retention (e2e)`). Failing tests: AS-58 (purge after verification: files deleted per file, `purgedAt` per file, sealed values kept, idempotent, partial storage failure throws for retry), AS-59 (purge after rejection scheduled 30 d later; later round untouched), AS-60 (`tenancy.shop_deleted` consumer: purge now, erase scheduled, duplicate `eventId` → one effect, invalid payload → rejected/DLQ with no effect), AS-61 (erase job runs only at due time, frozen clock; removes rows and history).
- [ ] T065 [US8] Rewrite `infra/onboarding.jobs.ts` (A28, R-12): `onboarding.purge-documents {shopId, submissionNo}` (unique key `purge:<shopId>:<submissionNo>`, `runAt = decision + 30d` from the injected clock, no SQL `now()`, per-file storage delete + `purgedAt`, failure throws) and `onboarding.erase-records {shopId}` (key `erase:<shopId>`, guard: due time reached else no-op, 1825 days configurable); schedule purge also on `shop.rejected`.
- [ ] T066 [US8] Create `infra/shop-deleted.consumer.ts` (S53 inbox, dedupe by `eventId`, strict payload `{shopId}`, DLQ on invalid): purge raw files now, cancel open tasks, schedule erase.
- [ ] T067 [US8] Run `onboarding-retention.e2e-spec.ts` until green.

---

## Phase 11: US9 — Boundaries, observability, errors (P1) — AS-62–68

- [ ] T068 [US9] Complete `SO/onboarding-boundaries.e2e-spec.ts` failing tests: AS-62 (catalog query: 0 foreign keys cross the domain boundary; `check:table-ownership --strict` is the gate), AS-63 (spy on the exported `ShopQueryService`: one `getShopsByIds` call per page), AS-64 (DB activity view from the fake model/storage/queue: no open transaction during calls), AS-65 (table over FR-100: problem+json for each failure class, generic 500), AS-66 (in-memory metric reader: seven series and label set, no identifiers), AS-67 (captured log stream over a full run: `requestId`/`traceId`, 0 full IBAN/VAT/holder; SC-005), AS-68 (route table check: every endpoint has a `packages/contracts` schema and every response parses).
- [ ] T069 [US9] Contract migration `MIG/2026101x-seller-onboarding-s04-contract.js` (A33): drop FKs `ShopOnboarding.shopId → Shop` and `ShopDocument.shopId → Shop`, drop the old unique `(shopId, kind, contentHash)`; down defined. Land only after US2 passes (plan ordering).
- [ ] T070 [US9] Error mapping and logging (A22, FR-100): all failures problem+json with stable `code`; logger context carries `requestId`/`traceId`; no sensitive value passed to any log call.
- [ ] T071 [US9] Boot smoke in the boundaries spec (L-015, L-018): compile a real module with only `OnboardingExtractionModule` (no ClickHouse, Kafka producer or billing) and the full `OnboardingModule` in the API app.
- [ ] T072 [US9] Run `onboarding-boundaries.e2e-spec.ts` until green; run `check:model-registry` and `check:boundaries`.

---

## Phase 12: Gap closure and follow-ups (every item has a task)

| Gap / follow-up | Task |
|---|---|
| A1 Shop UPDATE at submit | T031 |
| A2 Shop UPDATE at verify | T058 |
| A3 JOIN Shop in queue | T052 |
| A4 verify in own tx | T058 |
| A5 post-commit enqueue | T037 |
| A6 claim without lease | T043 |
| A7 finish inserts task unconditionally | T044 |
| A8 supersede skips EXTRACTING | T036 |
| A9 no dead-letter | T047, T048 |
| A10 timeout / config | T017, T042 |
| A11 non-strict output | T018 |
| A12 missing object | T044 |
| A13 impure evaluate/sniff | T015, T016 |
| A14 sealing context | T045 |
| A15 loose step validation | T010, T014, T030, T031 |
| A16 cross-step rule | T006, T014 |
| A17 view after submit | T031, T061 |
| A18 status/rounds | T021 |
| A19 document request rules | T036 |
| A20 confirm size/missing | T036 |
| A21 rate limits | T033, T039 |
| A22 controller internals/errors | T011, T030, T051, T070 |
| A23 review resolve semantics | T051, T053, T054 |
| A24 queue pagination | T052 |
| A25 key fields/corrections | T053 |
| A26 audit/metrics | T055 |
| A27 events/topic | T032 |
| A28 retention jobs | T065, T066 |
| A29 transitions/history | T024, T053 |
| A30 foreign imports | T042 |
| A31 layering | T023, T024, T026 |
| A32 barrel | T027 |
| A33 FKs | T069 |
| A34 schema | T021 |
| A35 Shop columns | T021 (untouched), T077 sibling note |
| A36 config schema | T017 |
| A37 e2e rewrite | T029, T035, T041, T050, T057, T064, T068, T076 |
| A38 unit coverage | T004–T009 |
| A39 public columns | T024, T036, T061 |
| A40 web screens | out of scope (owned by web capabilities); recorded in T078 |
| D-6, D-7, D-8, D-12, D-14 | T026, T076 (no `ShopModel` import), T027, T059, T042 |

- [ ] T073 Follow-up S01 (`SecretBox.seal/open` optional `context`): verified by T041 AS-30 and T045; adopt for every new sealed column; mention in the report.
- [ ] T074 Follow-up S03 (events + stop `UPDATE "Shop"` at `onboarding-session.service.ts:59` and `verification.service.ts:49`, `ShopQueryService` at `review.service.ts:43`): done by T031, T052, T058. **Topic decided** (questions.md → RESOLVED, R-01): S04 keeps aggregate `shops` / topic `shops.events` and contract version 1, which tenancy already reads (`SHOP_EVENTS_TOPIC`, `ShopVerifiedSeen` matches only v1); no tenancy edit is needed. The `gaps.md` **S03** bullet says so; the **S28** bullet asks to change `NOTIFICATION_SOURCE_TOPICS.shopOnboarding` to `shops.events`. Tenancy must not `defineEvent` these events (`DuplicateEventDefinitionError`). Mention both in the final report.
- [ ] T075 Follow-up S28 (confirm topic names and payloads when schemas ship in `packages/contracts`) and S46 (import paths and per-call parameters): S28 confirmation is a `gaps.md` sibling bullet (already present; keep, add that field names equal `contracts/events.md`); S46 done by T042.

---

## Phase 13: Polish and runtime proofs (L-019: scripted, by the final checkpoint)

- [ ] T076 Remove `SO/onboarding.e2e-spec.ts` only after confirming each of its 12 scenarios (T001 inventory) is covered by a test in the seven new files (L-017); remove its `console.log('SUBMIT ERROR')`, `ShopModel` import and raw `UPDATE "User"` seeding (A37, D-7). Check no spec reads `"Shop"` directly.
- [ ] T077 `gaps.md`: keep `## Spec changes` ("None", plus the `extraction` vs `kyc_extraction` purpose note); complete `## Sibling-spec follow-ups` bullets in the required form `- **<id>**: <what they must adopt>` for S03, S28, S46, S50, S55, S53 (as already listed) and add: **S03** the tenancy-owned `Shop.verificationStatus/payoutsEnabled` columns (A35) must be owned by tenancy's migration.
- [ ] T078 Ops artifacts (rule 2): confirm `quickstart.md` "Ops artifacts" lists SC-002 (full 100×10 loop), SC-006, SC-007, SC-008 with status `not run` and `specs/UNVERIFIED.md` has the four matching S04 rows (present today); add nothing described as verified. Note A40 (no web screens) under SC-008.
- [ ] T079 Living spec (rule 0): no `docs/spec/capabilities/S04-*.md` exists; if a page is created, follow a neighbouring page, keep `[proof:]`/`[code:]` true, run `python3 scripts/livespec/check.py`; never touch `*.reviewed.json`.
- [ ] T080 Static gates: `pnpm tsc --noEmit -p .`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:model-registry`; confirm `grep -rn "sequelize.transaction" SO` = 0 and no `// S54 T037 audit` left in the domain.
- [ ] T081 Runtime proofs (L-004, L-015, L-018): start the real API and confirm it boots with the new imports, outbox/jobs hooks and consumer; boot `document-extractor` and `document-extractor-dlq` standalone; confirm `onboarding-documents` and DLQ exist in `elasticmq.conf` and readiness fails when missing (L-002/L-020).
- [ ] T082 Whole capability suite once, in batches of fresh processes (L-008): `test-spec.sh libs/domains/seller-onboarding`; every batch must print its summary line; then once on an empty stack via `scripts/qa/fresh-run.sh` (L-006, L-012). Report real results; if anything fails, say so with output.

---

## Dependencies and order

- Phase 1 → Phase 2 (blocks everything). Inside Phase 2: tests T004–T009 before T012–T018; T021 before T022–T028; T023 before T024–T026.
- US1 (Phase 3) provides submit/events used by all others. US2 needs US1. US3 needs US2 (documents) and T032/T038. US4 and US5 need US3 (`finish`) and the verification policy; implement T058 before T053's `REJECT_APPLICATION` approval path finishes. US6 after US2+US5. US7 after US1+US4. US8 after US4/US5 (scheduling). US9 last; T069 only after US2.
- Group ordering from plan: A → B → C (T031, T032, T052, T058) → D → E → F → G → H.

## Parallel examples

- Phase 2: T004–T011 are independent files (all `[P]`); T023 `[P]` with T021 once the data model is fixed.
- After Phase 2: US1 e2e (T029) and US2 e2e (T035) can be drafted in parallel; US3 test (T041) and US4 test (T050) as well (different files, run later in order).
- Retention (T064) and boundaries (T068) tests can be written while US3–US5 code lands.

## Implementation strategy

MVP = Phase 1 + 2 + US1 + US2 + US3 + US5 (a shop can submit, upload, be read and be verified with the boundary violations A1–A4 gone); then US4 (review), US6, US7, US8, US9, closure. Run only the narrowest test for each task; the whole suite once at T082.

**Counts**: 82 tasks. Setup 3, Foundational 25 (T004–T028), US1 6, US2 6, US3 9, US4 7, US5 3, US6 2, US7 2, US8 4, US9 5, Gap/follow-up closure 3 (+ table), Polish 7.
