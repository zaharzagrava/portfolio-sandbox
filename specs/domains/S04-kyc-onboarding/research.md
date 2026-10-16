# Research: S04 decisions (Phase 0)

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted as written. This file records how each open technical point is resolved and which existing building block is reused. Paths are under `packages/backend/` (`SO` = `libs/domains/seller-onboarding`).

## R-01 Event topic: `shop-onboarding` versus `shops.events`

- **Decision**: keep aggregate `shops` and topic `shops.events` (analysis C1/C2; questions.md RESOLVED).
- **Why**: `topicFor(aggregateType)` yields `<aggregateType>.events` and aggregate types have no hyphens, so `shop-onboarding` cannot be produced through `defineEvent`. Tenancy already consumes `shops.events` at version 1 (`SHOP_EVENTS_TOPIC`, `consumedEvent`), so J02 and payouts keep working with no cross-domain edit.
- **Consequence**: S28's `NOTIFICATION_SOURCE_TOPICS.shopOnboarding = 'shop-onboarding'` is the stale constant; sibling follow-up in `gaps.md` (**S28**). Contract version of `shop.verified` stays 1.
- **Alternative rejected**: a new topic with dual publish (needs a second aggregate type; the registry refuses duplicate event types).
- **Event definitions**: S04 owns `defineEvent` for the four events; tenancy does not register them (a second registration throws `DuplicateEventDefinitionError`). Payload `shopId` is validated as a UUID.

## R-02 Verification inside the approving transaction (A4, FR-040)

- **Decision**: one application service method `VerificationPolicy.evaluate(tx, shopId)` is called from `finish` (extraction) and `resolve` (review) inside their transaction. It first locks the application row (`SELECT … FOR UPDATE` through the repository port), then reads the required-kind approvals and, if complete, does `UPDATE … SET status='VERIFIED' WHERE shopId=? AND status='SUBMITTED'` (asserts 1 row), history row, outbox `shop.verified`, `jobs.enqueue(purge)` with key `purge:<shopId>:<submissionNo>`.
- **Rationale**: the row lock serializes the last two approvals (AS-51); a failing outbox append rolls the approval back (AS-53).
- **Rejected**: repair job (hides the gap, III.6 wants the invariant in the store); advisory locks (row lock already exists).

## R-03 Transactions (cross-spec rule 4)

- Three direct `sequelize.transaction` sites exist (`onboarding-documents.service.ts:106`, `extraction.service.ts:303`, `review.service.ts:87`; `.tx.baseline` = 3). Every one is rewritten with `TransactionRunner.run` (`libs/infrastructure/context/transaction-runner.service.ts`) or `@Transactional`; the `// S54 T037 audit` comment is deleted at each site. The count in this domain must end at 0, never above 3.
- No model, storage or queue call inside a transaction (AS-64): extraction reads the object and calls the model between a short claim transaction and a short finish transaction.

## R-04 Extraction command through the outbox (A5)

- **Decision**: `OutboxService.appendTask` (exists, `outbox-tasks.e2e-spec.ts`) in the confirming transaction; type `onboarding.extract_document` v1 `{documentId}`, queue `onboarding-documents`. The queue and its DLQ (max receives 5) must exist in `elasticmq.conf` (L-002, L-020); readiness fails while it is missing.
- L-001: FIFO-only options (`groupId`) are not passed; the queue is standard and the task input is validated where it is created.

## R-05 Lease claim and conditional finish (A6, A7)

- `ShopDocument.leaseUntil timestamptz`. Claim: `UPDATE … SET status='EXTRACTING', leaseUntil=now+lease WHERE id=? AND (status='QUEUED' OR (status='EXTRACTING' AND leaseUntil < now))`, row count 0 ⇒ no-op ack. `now` comes from the injected clock (not SQL `now()`), lease from config (5 min, must exceed the 45 s model timeout).
- Finish: `UPDATE … WHERE id=? AND status='EXTRACTING'` asserts one row; otherwise the attempt may be recorded but no task, no verification, no event (AS-33).
- Resume: attempts already stored (`ESCALATE`) decide the next attempt number; attempt 1 is never paid for twice (AS-31).

## R-06 Dead-letter handler (A9)

- `apps/lambdas/src/handlers/document-extractor-dlq.ts` (new entry) calls `ExtractionService.routeToReview(documentId, 'extraction_unavailable')`, idempotent (conditional `EXTRACTING|QUEUED → NEEDS_REVIEW`), increments `kyc_extraction_failures_total{reason}`. Invalid payloads are failed batch items (S55 helper). The Lambda app imports `OnboardingExtractionModule` only; it must boot standalone (L-018, L-015): add a boot smoke (real module compile) in the boundaries spec and run the lambda bootstrap once.

## R-07 LLM port (A10, A30, follow-up from S46)

- S46 has shipped `@app/infrastructure/llm` (`LLM_PROVIDER`, `LlmUnavailableError`, `LlmRejectedError`, `LlmCallRecorder`, `ScriptedLlmProvider`, `assertLlmConfig`). Switch the imports; drop `LlmMeter`, billing `UsageService`, ClickHouse and Kafka producer modules from `onboarding.module.ts` and the Lambda.
- Per call: `maxRetries: 0`, `timeoutMs: 45000`, `callId = "<documentId>:<attempt>"`, `purpose: "extraction"` (the shipped enum `LLM_PURPOSES` is `chat|summary|extraction|rag`, so spec AS-36's `kyc_extraction` cannot be sent: `extraction` is used and the e2e asserts it; the AS-36 wording is listed under "Sibling-spec/Spec changes" in gaps.md). `subjectId = shopId`, `scopeId = documentId`.
- Metering failure never fails extraction: `LlmCallRecorder` errors are caught and counted.
- Tests use `ScriptedLlmProvider` (delay, timeout, 429/5xx, malformed answers).

## R-08 SecretBox context (S01 follow-up, A14)

- `SecretBox.seal(plaintext, context?)`/`open(sealed, context?)` already take an optional context (`secret-box.ts`, `v2` format with AAD). Adopt `kyc:<documentId>:<attempt>` for every new sealed value (extraction, human attempt, review `open`). `open` of legacy `v1` values keeps working. Identity is reached through the `SecretSealerPort` (inject the port, not the identity barrel internals) if exported; otherwise via the exported `SecretBox` from the identity public barrel.

## R-09 Reading shop data (A3, FR-060)

- `ShopQueryService.getShopsByIds` once per queue page (ids deduplicated, ≤ 100), merged by id in the application service, `shopName: null` when absent. `ShopAccessService.getRole(shopId, userId)` for the conflict-of-interest check. Both imported from the tenancy public barrel. No `Shop` SQL remains: `check:table-ownership --strict` shows 0 findings for the domain.

## R-10 Layering (A31, A32, D-6, D-8)

- Repository ports in `domain/ports.ts` (`ApplicationRepository`, `DocumentRepository`, `AttemptRepository`, `ReviewTaskRepository`, `StatusHistoryRepository`), Sequelize adapters in `infra/*.repository.ts` taking the `Transaction` from the ambient context. Application services only orchestrate. `OnboardingModule` exports nothing; the barrel keeps the three modules, `ExtractionService` (`process`, `routeToReview`) and contract types.
- Pure logic to `domain/`: `extraction-rules.ts` (injected `now`), `file-type.ts`, `status-machines.ts` (exhaustive, `assertNever`), `questionnaire.ts`, `extraction-config.ts`.

## R-11 Migration (A18, A33–A35, III.11)

- One expand migration `2026101x…-seller-onboarding-s04.js` (new files only, history of `20261002170000` untouched): adds columns and tables of `data-model.md`, backfills `status='SUBMITTED'/'VERIFIED'` and `submissionNo=1` for existing rows (a `Shop.verificationStatus` read is not allowed: derive `VERIFIED` from `verifiedAt`/documents of the domain itself, default `SUBMITTED`), creates indexes `CONCURRENTLY`, sets `lock_timeout`. A second contract migration drops the two foreign keys (`ShopOnboarding.shopId`, `ShopDocument.shopId`) after code stopped relying on them. Down migrations are defined.
- L-011: the tables exist in the test stack; compare with the doctor after migrating.

## R-12 Retention jobs (A28)

- Handlers in `infra/onboarding.jobs.ts` registered with S49: `onboarding.purge-documents {shopId, submissionNo}` (unique key `purge:<shopId>:<submissionNo>`, `runAt = decision + 30d` from the injected clock; storage delete per file, `purgedAt` per file, failure throws for retry) and `onboarding.erase-records {shopId}` (guard: due time reached, else no-op). `tenancy.shop_deleted` consumer through the S53 inbox (idempotent by `eventId`, strict payload, DLQ on invalid).

## R-13 Errors, rate limits, contracts (A15, A21, A22)

- Contract schemas in `packages/contracts/src/onboarding/*` (strict zod, `errors: [{path, message}]`); controller uses a validation pipe per schema; domain errors extend the problem+json base with the stable `code` list of FR-100. Policies `onboarding.upload.shop` 20/h and `onboarding.submit.shop` 10/day declared in S50's registry (fail-closed). The route table of the controller is checked against the schema registry (AS-68).

## R-14 Metrics, logs, audit (A26)

- Seven series of AS-66 through the S54 metrics registry; `kyc_review_queue_oldest_age_seconds` is an observable gauge read from a cheap indexed query. Audit through the S54 audit logger: `{reviewerId, taskId, shopId, decision, outcome}` only. Logger context carries `requestId`/`traceId`; no sensitive values are ever passed to a log call.

## R-15 Live specification (cross-spec rule 0)

- `docs/spec/capabilities/` has no `S04-*.md` page today. No page is edited; no `*.reviewed.json` is touched. If the implementation creates a page, it follows the template of a neighbouring page and keeps `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`). Nothing signed by a human is changed: `## Spec changes` in gaps.md says "none".

## R-16 Unverified criteria (cross-spec rule 2)

- SC-006 (60 s propagation), SC-007 (5 min / 15 min latency at normal load), SC-008 (3 interactions, UI) and the 100×10 loop of SC-002 at scale are not proven by the e2e suite (SC-002 is proven at a smaller repetition count). They go to `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md`, status `not run`.
