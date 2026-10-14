# Tasks: S47 — "Ask this product" and shop help center (domain `assistant`, knowledge half)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `research.md` (R-1…R-14), `data-model.md`, `contracts/`, `quickstart.md`, `questions.md` (defaults accepted)
**Tests**: required (constitution VII, `test-plan.md`). For every test-plan row the failing test task comes before the code task. A test must be able to fail (L-003); it creates its own data (L-005, L-006).

## Conventions

- `LIB` = `packages/backend/libs/domains/assistant`. Backend commands run from `packages/backend`. Spec files are the eight names of `test-plan.md`; scenarios (AS-nn), not file names, are what must never disappear (L-017).
- Run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; narrowest test while working, whole suite once in the last phase, in batches of fresh processes (L-008). After 5 failed fixes of the same test: stop, write blocker, tried, hypothesis in `questions.md`.
- Rule 0: the first task creates the capability page; each behavior task edits the page rules first and keeps `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`). Never create or edit `*.reviewed.json`.
- Rule 3: never `git checkout/restore/reset/stash/clean`; undo by hand editing only the named lines.
- Rule 4: no new direct `sequelize.transaction`; `TransactionRunner.run` / `@Transactional` only (T018 migrates the 3 audited sites).
- `[P]` = different files, no dependency on an unfinished task. Story labels: US1 ask product, US2 documents, US3 permissions, US4 help-center ask, US5 platform/re-index/sweep, US6 retrieval quality, US7 lifecycle, US8 operate.

## Phase 1: Setup

- [X] T001 Create the living-spec page `docs/spec/capabilities/S47-rag-help-center.md` (model: `S25-discussions.md`) describing today's rules (documents, ingestion, retrieval, ask) with `[code:]` pointers to `LIB`; run `python3 scripts/livespec/check.py`; create no `*.reviewed.json`
- [X] T002 [P] Confirm the "Check" items of `research.md` and record each result in a short list at the end of `research.md`: `receiveCount` is 1-based in `libs/infrastructure/**/sqs-task-queue.ts` and `in-memory-task-queue.ts` (R-6); `ProductDeleted` exported from `@app/domains/catalog` entry point (R-12); name of the breaker in `libs/common/resilience` (R-10); which key `marketing/domain/list-cursor.ts` signs with (R-11); migrations apply in filename order in the test stack (R-5); `llm.call_completed` v1 tolerates optional `scopeId`/`outcome` (R-2). A missing export becomes a bullet under "Sibling-spec follow-ups" in `gaps.md`
- [X] T003 [P] Record baselines: `wc -l` of `.tx.baseline` (must read 3) and `pnpm check:table-ownership --strict` output for `assistant` (needs approval; if denied, mark blocked in `gaps.md`, do not claim it passed)

## Phase 2: Foundational (blocks every story)

**Contracts and config (G2, G41)**

- [X] T004 [P] Write failing unit spec `packages/contracts/src/assistant/knowledge.spec.ts` for `knowledgeDocumentSchema` (strict: rejects `storageKey`, `contentHash`, `indexedHash`, `embeddingModel`, `createdBy`, `error`), `knowledgeCreateRequestSchema` (exactly one of `markdown` 1 byte–1 MiB not whitespace-only, or `pdfSha256` `^[0-9a-f]{64}$` + `pdfSize` 1–20 MiB; `title` 1–200; `visibility` `PUBLIC|SHOP_PRIVATE`; `productId` uuid; unknown field rejected; exact limits accepted), admin variant, list query (`limit` 1–100 default 20), `ragAskRequestSchema` (3–500, trimmed ≥ 3, strict), `ragStreamEventSchema` (`sources {mode, items[n from 0, headingPath string, page|null]}`, `done {citations, grounded}`)
- [X] T005 Implement `packages/contracts/src/assistant/knowledge.ts` and correct `packages/contracts/src/assistant/ask.ts` (`n` from 0, `headingPath` string, `done.grounded`, `sources {mode, items}`); export from the package index; find the other users with `grep ragSourceSchema` and fix them (depends on T004)
- [X] T006 [P] Write failing unit spec `packages/backend/libs/common/config/knowledge-config.spec.ts`: defaults (`rag_min_similarity` 0.3, `rag_candidates` 40, `rag_top_k` 6, `rag_query_embed_timeout_ms` 3000, `rag_retrieval_timeout_ms` 2000, `rag_first_token_timeout_ms` 30000, `rag_answer_timeout_ms` 60000, `knowledge_max_documents_per_shop` 1000, `knowledge_max_pages` 500, `knowledge_processing_lease_ms` 300000, `knowledge_upload_ttl_s` 900, `knowledge_max_receives` 5, `knowledge_ingest_concurrency` 4, `knowledge_embed_batch` 128, `rag_eval_min_recall` 0.8, `rag_model` default `claude-sonnet-5-5`, `moderation_backend`); invalid values fail with a message naming the key, never the value
- [X] T007 Implement `packages/backend/libs/common/config/knowledge-config.ts` (joi, pattern of `share-links-config.ts`); keep `voyage_*` in `types.ts`; wire into the config module (G38 `rag_model`, G22 constants become config) (depends on T006)

**Migrations (G51, G21, R-5)**

- [X] T008 Write expand migration `packages/backend/migrations/<ts>-knowledge-s47-expand.js`: `SET LOCAL lock_timeout = '5s'`, idempotent (`IF NOT EXISTS`); `KnowledgeDocument` add `failureCode TEXT NULL` (CHECK in `not_a_pdf, unparseable, no_text, too_many_pages, too_many_chunks, size_mismatch, embedding_unavailable`), `contentSize BIGINT NULL`, `leaseToken UUID NULL`, `leaseUntil TIMESTAMPTZ NULL`, `queuedAt TIMESTAMPTZ NULL`, `deletedAt TIMESTAMPTZ NULL`, `bytesRemovedAt TIMESTAMPTZ NULL`; `KnowledgeChunk` add `embeddingModel TEXT NULL` and `CHECK (tokens BETWEEN 1 AND 800)`; indexes `(shopId, createdAt DESC, id DESC) WHERE status <> 'DELETED'`, platform `(createdAt DESC, id DESC) WHERE "shopId" IS NULL AND status <> 'DELETED'`, `(status, queuedAt) WHERE status IN ('QUEUED','PROCESSING','AWAITING_UPLOAD')`, `(deletedAt) WHERE status = 'DELETED'`
- [X] T009 Write backfill migration `…-knowledge-s47-backfill.js`: batches of 5,000 by id range setting `KnowledgeChunk.embeddingModel` from the document; map old `error` text of `FAILED` rows to `failureCode` (`embedding_unavailable` or `unparseable`); drop nothing
- [X] T010 Write a migration check in `knowledge-platform.e2e-spec.ts` fixture area (or `LIB/knowledge-schema.e2e-spec.ts` if the file does not exist yet): after expand+backfill every new column exists and every chunk has `embeddingModel`; re-running the migrations changes nothing (depends on T008, T009). Contract migration is T060 (later on purpose)

**Ports, adapters, domain purity (D-6, D-7, G46–G50)**

- [X] T011 [P] Write failing unit specs in `LIB/domain/`: `document-state.spec.ts` (table of legal moves per R-4; every illegal pair rejected; `FailureCode` closed list), `failure-codes.spec.ts`, `document-cursor.spec.ts` (round trip, tampered tag → invalid, malformed → invalid, ordering key), `scope.spec.ts` (product and shop scope descriptions per `data-model.md`), `sensitive-data.spec.ts` (Luhn-valid 13–19 digit runs, `sk-…`, `AKIA…`, `-----BEGIN … KEY-----`, bearer shapes → true; random digits failing Luhn, plain prose → false)
- [X] T012 Implement `LIB/domain/document-state.ts`, `failure-codes.ts`, `document-cursor.ts`, `scope.ts`, `sensitive-data.ts`, `knowledge-errors.ts` (typed errors with `code` + status: `invalid_transition` 409, `upload_missing` 409, `product_document_must_be_public` 422, `document_limit_reached` 422, `product_archived` 409, `input_rejected` 422, `assistant_busy` 429, `assistant_unavailable` 503, `RetrievalUnavailableError`) (depends on T011, T005)
- [X] T013 Define `LIB/domain/ports.ts`: tokens + interfaces `DocumentRepository`, `PassageRepository`, `EmbeddingProvider` (`embed(texts,{signal})`, `model`, `dimensions`), `ObjectStore`, `TaskPublisher`, `QuestionCache`, `ProductDirectory`, `ShopDirectory`, `AnswerModel`, `CallRecorder`, `Moderator`; `Clock` from `@app/common/core/clock` (R-1)
- [X] T014 [P] Implement `LIB/infra/catalog.adapter.ts` and `tenancy.adapter.ts` over `ProductQueryService.getProductsByIds(ids,{shopId?})` and `ShopQueryService.getShopsByIds` (S05/S03 follow-ups; no `JOIN "Product"`, no `ProductModel`) (depends on T013)
- [X] T015 [P] Implement `LIB/infra/pg-document.repository.ts` (raw SQL, every state change `UPDATE … WHERE status = :from [AND leaseToken]` with scope predicate; `INSERT … ON CONFLICT DO NOTHING RETURNING` + re-read; cap in the insert statement; keyset list; no `sequelize.transaction`) and `pg-passage.repository.ts` (candidates, hydration, swap) (depends on T013, T008)
- [X] T016 [P] Implement adapters `embedder.ts` (no internal retry, `AbortSignal`, hashing adapter marked test-only, G18), `pdf-parser.ts` (moved out of the service), `storage.adapter.ts`, `task-publisher.adapter.ts`, `question-cache.adapter.ts` (errors swallowed and counted), and interim `answer-model.adapter.ts`, `call-recorder.adapter.ts`, `moderator.adapter.ts` over `assistant/infra/llm` (R-2, R-3; no `LlmMeter`, no `UsageService`) (depends on T013)
- [X] T017 Rewire `KnowledgeModule`, `KnowledgeWorkerModule`, `KnowledgeProjectorModule` in `LIB/knowledge.module.ts`: bind tokens to adapters, remove the re-provided `UsageService`/`LlmMeter` (G35, D-14 partial), register `rag.ask`/`rag.ingest` through `RateLimitModule.forFeature` (T019); `api/` and `application/` import no `infra/` and no `@InjectConnection` (G46) (depends on T014–T016)
- [X] T018 Migrate the three direct `sequelize.transaction` sites (`infra/retriever.ts:89`, `application/knowledge.service.ts:171`, `:217`) to `TransactionRunner.run` inside the new repositories/services, delete every `// S54 T037 audit` comment there; `.tx.baseline` for the domain must read 0 (rule 4) (depends on T015)
- [X] T019 [P] Create `LIB/knowledge-rate-limit-policies.ts` with `definePolicies('assistant', …)`: `rag.ask` 10/min per user or client address, fail closed; `rag.ingest` 30/min per shop, fail closed; remove `rag.ask` from `LIB/rate-limit/rate-limit-policies.ts` (S46 keeps `llm.messages`, `llm.provider.tpm`) (S50 follow-up)
- [X] T020 Rewrite `LIB/index.ts` to export only `KnowledgeModule`, `KnowledgeWorkerModule`, `KnowledgeProjectorModule`, DTO types, `KnowledgeSearchService`, `RetrievalUnavailableError`, `RetrievalScope`, plus the S46 symbols other domains import today (list them in a comment, R-2); grep the repo for importers and fix them (G49, D-8, D-7)
- [X] T021 [P] Add `check:no-wallclock` hygiene: replace `Date.now()`/`now()` in `application/` with the injected clock (G50); database clock stays only in lease/sweep SQL
- [X] T022 Boot check (L-004, L-015): `tsc --noEmit`, `pnpm check:boundaries`, then start the real `apps/core` and confirm the module graph resolves; if the sandbox denies the start, mark blocked, not done

**Checkpoint**: contracts, config, schema, ports and adapters compile and the app boots; stories can begin.

## Phase 3: US1 — A buyer asks a question about a product (P1) 🎯 MVP

**Goal**: streamed grounded answers with citations; not-found without a model call; strict admission order.
**Independent test**: `knowledge-ask.e2e-spec.ts` (index one manual via HTTP, ask answerable and unanswerable questions).

### Tests first

- [X] T023 [P] [US1] Failing unit spec `LIB/domain/citations.spec.ts` (AS-12): `it.each` over indexes `[0,0,2,9,-1]` → `[0,2]`, other location kind dropped, empty text dropped, no citation → `sources: []` and `grounded: false`, ≥ 1 valid → `grounded: true`
- [X] T024 [P] [US1] Failing unit spec `LIB/domain/prompt.spec.ts` (AS-01, AS-13): `RAG_INSTRUCTIONS` is a constant; the built request has instruction block, one passage block per item with citations enabled, question last, no tools, effort low, `maxTokens` 1500; no document or question text in the instruction block
- [X] T025 [US1] Create `LIB/knowledge-ask.e2e-spec.ts` (`describe('RAG: ask this product and the shop help center')`) with fixtures that seed through HTTP (G44) and failing tests for AS-01 (events order, headers, `sources` shape, one `llm.call_completed` with purpose `rag`, no cost/model in events), AS-02 (anonymous served, invalid token 401, subject `anonymous`), AS-03 (not_found, zero model calls, zero records, counter), AS-04 (`it.each` unknown/archived/inactive shop → identical 404; restore serves again)
- [X] T026 [US1] Add failing tests in the same file: AS-05 (`it.each` all invalid classes + boundaries 3 and 500), AS-06 (flagged → `422 input_rejected` with category and no question text; sensitive data; moderator timeout 200 ms → `503 assistant_unavailable` + `Retry-After`), AS-07 (11th ask `429 rate_limited` + `Retry-After` + structured `RateLimit`/`RateLimit-Policy`; other caller unaffected; limiter store down → `503 rate_limiter_unavailable` per the "Spec changes" delta), AS-08 (`429 assistant_busy` before any stream)
- [X] T027 [US1] Add failing tests: AS-09 (`it.each` provider unavailable / first-token 30 s / answer 60 s with fake timers → `error` event, one `failed` record, no `done`), AS-10 (refusal), AS-11 (disconnect aborts within 1 s, `aborted` estimate recorded), AS-13 (injection text stays in passage blocks, instruction block byte-identical to AS-01), AS-14 (`it.each` four admission-order rows), AS-48 (held table lock → `503 assistant_unavailable` before stream, generic body, deadline counter)

### Implementation

- [X] T028 [US1] Edit the capability page rules first (admission order, stream contract, statuses), then implement `LIB/domain/citations.ts` (pure `citationsOf`, G48) and `LIB/domain/prompt.ts` (depends on T023, T024)
- [X] T029 [US1] Implement `LIB/application/knowledge-search.service.ts` minimal path (scope → `PassageRepository.candidates`, fusion with existing `domain/rrf.ts`, mode `hybrid`, `RetrievalUnavailableError` on deadline via `SET LOCAL statement_timeout` inside `TransactionRunner.run`), exported from the barrel; replaces `Retriever` (G25, G28; fuller behavior in US6) (depends on T015)
- [X] T030 [US1] Implement `LIB/application/ask.service.ts` (replaces `answer.service.ts`): order lookup (`ProductDirectory` + `ShopDirectory`: unknown/ARCHIVED/non-ACTIVE shop → `404 not_found`) → input moderation (200 ms, fail closed) → provider budget `llm.provider.tpm` (cost = estimated tokens, denial → `429 assistant_busy`; unit-assert estimate can never exceed the policy limit so `422 rate_limit_cost_exceeded` is unreachable) → retrieval → `not_found` (no model call, no record) or stream; first-token and answer timers on the injected clock; `AbortController` on client close; one `CallRecorder.record` in `finally` (completed/failed/refused/aborted, estimated tokens); per-chunk output moderation with previous 256 chars → `refusal {source:'moderation'}`; breaker around the provider call; `sources {mode,items}`, `done {citations, grounded}` (G30–G34, G36, G37, G50) (depends on T028, T029, T016)
- [X] T031 [US1] Implement `LIB/api/knowledge-ask.controller.ts` + `assistant-stream.ts` SSE writer: `POST /products/:productId/ask` (`Firewall({anonymous:true})`, `@RateLimit('rag.ask')`, zod pipe from `contracts`), headers written only after retrieval succeeded (G31), controller issues no SQL (II.1, G36, G37); delete the old controller and `answer.service.ts`; delete `rag.ask` use of `LlmMeter` (depends on T030)
- [X] T032 [US1] Run `test-spec.sh LIB/knowledge-ask.e2e-spec.ts`; make every US1 test pass; keep `[proof:]` in the page true; `python3 scripts/livespec/check.py`

**Checkpoint**: US1 independently demonstrable (MVP).

## Phase 4: US2 — A seller adds, monitors and removes documents (P1)

**Goal**: strict documents API, state machine with conditional updates, resilient ingestion.
**Independent test**: `knowledge-documents.e2e-spec.ts` + `knowledge-ingest.e2e-spec.ts`.

### Tests first

- [X] T033 [P] [US2] Failing unit spec updates: move the RRF block out of `LIB/domain/chunker.spec.ts` into new `LIB/domain/rrf.spec.ts` (AS-44 exact scores: both lists beats single #1, stable ties, empty, duplicates by best rank, constant 60); keep chunker tests; add AS-34 `describe.each` cases (fences, FAQ merge, long paragraph, giant sentence, PDF pages, ≤ 800 tokens, overlap ~80, ordinals gapless, determinism) and the fast-check property that every non-heading sentence appears
- [X] T034 [US2] Create `LIB/knowledge-documents.e2e-spec.ts` (`describe('RAG: document management API')`), failing tests: AS-15 (201 + DTO has no internal fields, parsed with the contract schema, one task), AS-16 (PDF create returns grant bound to hash and size, expiry ≤ 15 min; `uploaded` queues once), AS-17 (`it.each` all invalid classes, exact limits accepted, `SHOP_PRIVATE`+product → `422`), AS-18 (`it.each` 401 on every route incl. admin and help-center)
- [X] T035 [US2] Add failing tests: AS-19 (`it.each` route × principal: non-member 404, missing permission 403, suspended `403 shop_suspended` on writes with list/get/help-center 200, `409 shop_offboarding`, non-admin 403 on admin), AS-20 (other shop's/unknown product 404, ARCHIVED `409 product_archived`, nothing stored), AS-21 (repeat 200 deduplicated, other scope new doc, re-add after delete), AS-22 (five parallel creates → one 201, four 200, one row, one task), AS-23 (`upload_missing`, replays 200 no second task, FAILED 409, concurrent calls one task)
- [X] T036 [US2] Add failing tests: AS-28 (delete immediate in list/get/questions, repeat 404, concurrent → one 204), AS-30 (retry only from FAILED 202, others 409, concurrent one 202), AS-31 (keyset paging, status filter, limits 0/101/abc → 400, tampered cursor `400 invalid_cursor`, scope isolation, contract schema), AS-32 (cap 3 in tests → 422, duplicate still 200, delete frees slot), AS-33 (31st create → 429, other shop unaffected)
- [X] T037 [US2] Create `LIB/knowledge-ingest.e2e-spec.ts` (`describe('RAG: ingestion pipeline (queue consumer)')`), failing tests: AS-15 (markdown → passages with heading paths, embeddings, keyword entries, 1–800 tokens, model recorded), AS-16 (PDF pages and numbered headings survive), AS-24 (`it.each` six poison inputs → FAILED once with `failureCode`, acked, no chunks, no parser message or path in responses; hash mismatch → `size_mismatch`), AS-25 (transient twice then success; 5 receives → DLQ and `FAILED(embedding_unavailable)`, previous passages untouched; assert `elasticmq.conf` `maxReceiveCount` equals `knowledge_max_receives`, L-002), AS-26 (redelivery no-op with zero embedder calls; two workers → one embed; expired lease taken over), AS-27 (`it.each` invalid payloads → DLQ no effect; unknown/DELETED id → ack), AS-29 (delete during embedding stays DELETED, zero chunks)

### Implementation

- [X] T038 [US2] Edit the capability page (document rules, state machine, limits, failure codes), then implement `LIB/application/document.service.ts` with `Scope` value `{kind:'shop'}|{kind:'platform'}`: create (hash identity, `201`/`200`, product ownership via `ProductDirectory` → `404`/`409`, `422` rules, cap in the insert statement, `rag.ingest`), uploaded (conditional, `upload_missing` via `ObjectStore.head`), retry, delete (single conditional update + passages removal in one `TransactionRunner.run`, bytes removed after, failures left for sweep), cursor list, get; enqueue after commit (G1, G3–G11, G13) (depends on T012, T014, T015, T034–T036)
- [X] T039 [US2] Implement `LIB/api/knowledge-documents.controller.ts` with `ShopScoped('products.read'|'products.write')`, `@RateLimit('rag.ingest')` on create/uploaded, zod pipes from `contracts` (`strict`, unknown field → 400), explicit DTO mapper (no raw rows), `201`/`200`, `202` on retry, `204` on delete, new `GET …/documents/:documentId` (G1–G5, G9)
- [X] T040 [US2] Implement `LIB/application/ingest.service.ts` per R-6: claim with 5-minute lease token, bytes read with 10 s timeout and size/hash checks, parse and chunk, limits 500 pages / 2,000 chunks → `FAILED(code)` conditional on lease, embed in `knowledge_embed_batch` with per-call `AbortSignal` and no internal retry, commit in one `TransactionRunner.run` (re-check lease → swap passages and `READY`, `chunkCount`, `indexedHash`, `embeddingModel` per passage; zero rows → rollback and ack), transient → `release` to `QUEUED` and rethrow, `receiveCount >= knowledge_max_receives` → `FAILED(embedding_unavailable)` keeping old passages (G14–G18, G21, G22) (depends on T037)
- [X] T041 [US2] Implement `LIB/infra/knowledge-ingest.consumer.ts`: `bodySchema` `{documentId: uuid}` strict (DLQ at once) + zod in the handler (G20), concurrency from config, graceful stop; validate the queue option where the message is created (L-001: no FIFO-only options on the standard queue); confirm queue `knowledge-ingest` and DLQ exist in `infra/docker/elasticmq/elasticmq.conf` and that readiness fails while missing (L-002)
- [X] T042 [US2] Run `test-spec.sh` on `knowledge-documents.e2e-spec.ts` and `knowledge-ingest.e2e-spec.ts`; run the `domain/` unit specs; `python3 scripts/livespec/check.py`; delete `knowledge.e2e-spec.ts` tests only after each scenario is mapped (L-017; write the mapping into `test-plan.md` "Existing specs to migrate" line)

## Phase 5: US3 — Permissions are enforced inside the query (P1)

**Goal**: zero leaks across buyers, shops and platform.
**Independent test**: `knowledge-retrieval.e2e-spec.ts` isolation rows and ASK AS-38.

- [X] T043 [US3] Create `LIB/knowledge-retrieval.e2e-spec.ts` (`describe('RAG: hybrid retrieval and in-query permissions')`) with failing tests: AS-35 (buyer scope returns only D1+D3), AS-36 (member scope D1–D4 + D6, never D5), AS-37 (300 stronger foreign private passages never starve the caller's 3; empty scope → empty, not error); fixtures create documents via HTTP and drive ingestion through the consumer
- [X] T044 [US3] Add failing test AS-38 to `knowledge-ask.e2e-spec.ts`: `BRIE` asks SHOP_B help center about SHOP_A's private contract → `not_found` or answer from own/platform only; capture every model request and assert none contains SHOP_A text; buyer on `PA1` gets the same guarantee (SC-001)
- [X] T045 [US3] Make `PassageRepository.candidates` and hydration apply scope + `d.status <> 'DELETED' AND d."chunkCount" > 0` (+ `c."embeddingModel" = :model` on the meaning list) inside the ranking statement and again in hydration (G25, G26, FR-021, R-4, R-8); edit the page rules first (depends on T043, T044)
- [X] T046 [US3] Run `knowledge-retrieval.e2e-spec.ts` and the AS-38 test; fix until green

## Phase 6: US4 — Seller asks the shop help center (P2)

**Independent test**: ASK AS-39 and the AS-05…AS-11 rows against the help-center route.

- [X] T047 [US4] Add failing tests to `knowledge-ask.e2e-spec.ts`: AS-39 (platform article cited, `subjectId` = user id, `scopeId` = shop id, purpose `rag`, SUSPENDED shop allowed), and re-run the validation, moderation, rate-limit, budget, provider-failure and disconnect rows against `POST /shops/:shopId/knowledge/ask` (`it.each` over both routes)
- [X] T048 [US4] Implement the help-center route in `LIB/api/knowledge-ask.controller.ts` (`ShopScoped('shop.read')`, `@RateLimit('rag.ask')`) calling the same `AskService` with `{kind:'shop'}` target; subject is the user id (G35)
- [X] T049 [US4] Run the ask suite; page rules updated for the help-center route

## Phase 7: US5 — Platform articles, re-index, sweeps (P2)

**Independent test**: `knowledge-admin.e2e-spec.ts`.

- [X] T050 [US5] Create `LIB/knowledge-admin.e2e-spec.ts` (`describe('RAG: platform articles, re-index and sweeps')`) with failing tests: AS-40 (admin create/list/delete, PDF form, dedup, shop routes 404 for platform ids and admin routes 404 for shop ids, buyers never see, every shop's help center sees), AS-41 (M1 passages leave meaning candidates but stay keyword-findable; `POST /admin/knowledge/reindex` → `202 {enqueued:n}`, second call `{enqueued:0}`; swap atomic under a concurrent question; non-admin 403), AS-42 (frozen clock: abandoned uploads > 24 h → DELETED and bytes removed; QUEUED > 5 min without task re-enqueued once; expired leases → QUEUED; tombstones > 30 d purged; two runs at once change nothing)
- [X] T051 [US5] Implement `LIB/api/knowledge-admin.controller.ts` (administrator guard) reusing `DocumentService` with `{kind:'platform'}` scope, and `LIB/application/reindex.service.ts` (idempotent: READY with model ≠ configured and not queued → `QUEUED` conditional + one task) (G12, G21) (depends on T050)
- [X] T052 [US5] Implement `LIB/infra/knowledge-sweep.jobs.ts`: `declareJobType('knowledge.sweep', z.object({}).strict())`, `upsertSchedule` every 5 min catching `InvalidScheduleError`, steps (a)–(e) of R-7 as bounded conditional statements (500 rows), orphaned bytes retried and no storage key in logs (G13, G19, G24, G42) (depends on T050)
- [X] T053 [US5] Run `knowledge-admin.e2e-spec.ts`; update page rules

## Phase 8: US6 — Retrieval quality, degradation, measurement (P2)

**Independent test**: remaining RETRIEVE rows and `rag-eval.e2e-spec.ts`.

- [X] T054 [P] [US6] Failing unit spec `LIB/domain/retrieval-metrics.spec.ts` (AS-49: rank 1, rank k, rank k+1, no expected, empty result) and implement `domain/retrieval-metrics.ts` (recall@k, MRR)
- [X] T055 [US6] Add failing tests to `knowledge-retrieval.e2e-spec.ts`: AS-43 (paraphrase by meaning; model number by keywords with floor raised; heading word matches), AS-45 (below-floor hits count only with keyword hit; off-topic empty), AS-46 (failing and stalled embedder → `mode: 'keyword'`, `rag_retrieval_degraded_total` increments, no keyword match → empty; embedder never retried within the request), AS-47 (case/whitespace variants embed once, key includes model, cache store down still answers)
- [X] T056 [US6] Implement in `knowledge-search.service.ts`: question embedding raced against `rag_query_embed_timeout_ms` with `AbortSignal`, keyword-only fallback, floor rule, normalize (trim, collapse whitespace, lowercase) + cache key `rag:qe:v1:sha256(model+normalized)` TTL 24 h, errors swallowed and counted, `k ≤ 20`, metrics `rag_retrieval_duration_seconds`, `rag_retrieval_degraded_total` (G27, G29)
- [X] T057 [US6] Create `packages/backend/scripts/rag-eval/rag-eval.e2e-spec.ts` (`describe('RAG: evaluation harness')`): failing tests — prints recall@k and MRR, exit `1` below `RAG_EVAL_MIN_RECALL`, `0` otherwise, `2` with offending case index on malformed golden file, zero model calls; then rework `scripts/rag-eval/rag-eval.ts` to import `KnowledgeSearchService` from the barrel and boot only the minimal module (G39); add `rag:eval` script and curated `golden.json` if absent
- [X] T058 [US6] Run RETRIEVE and EVAL suites; fix until green

## Phase 9: US7 — Documents follow product and shop lifecycle (P3)

**Independent test**: `knowledge-events.e2e-spec.ts`.

- [X] T059 [US7] Create `LIB/knowledge-events.e2e-spec.ts` (`describe('RAG: product and shop deletion consumers')`) with failing tests: AS-50 (product_deleted purges its documents, passages and bytes; duplicate `eventId` single effect; no-document product no-op; in-flight ingestion ends DELETED with zero chunks), AS-51 (shop_deleted purges only that shop; platform and SHOP_B unchanged; duplicate no effect), AS-52 (`it.each` missing/non-UUID id, wrong version, not JSON → dead-lettered, next message still processed); payloads use the real schemas `{productId, shopId, productVersion}` and `{shopId, shopVersion}`
- [X] T060 [US7] Implement `LIB/application/lifecycle.service.ts` (`purgeByProduct`, `purgeByShop`: batches of 200, one `TransactionRunner.run` each, `status='DELETED', chunkCount=0, title='', deletedAt=now()`, passages deleted, bytes removed after commit, failures left to sweep (d)) and `LIB/infra/knowledge-lifecycle.projectors.ts` (`knowledge-product-deleted`, `knowledge-shop-deleted`, `idempotency: 'natural'`, UUID `aggregateIdSchema`) registered in `KnowledgeProjectorModule`; import `ProductDeleted`/`ShopDeleted` from the owners' entry points (or contracts if not exported, T002) (G23)
- [X] T061 [US7] Write the contract migration `…-knowledge-s47-contract.js` (`lock_timeout`; find FK names in `pg_constraint`; drop the `Shop` and `Product` FKs; `KnowledgeChunk.embeddingModel SET NOT NULL`; drop `KnowledgeDocument.error`; header documents "no down"), apply only after T038–T060 code is in; extend the migration test: no FK from either table to another owner's table (G51, D-12)
- [X] T062 [US7] Run `knowledge-events.e2e-spec.ts`, then the full ASK/DOCS/INGEST suites again to prove the contract migration broke nothing

## Phase 10: US8 — Operate it safely (P3)

**Independent test**: `knowledge-platform.e2e-spec.ts`.

- [X] T063 [US8] Create `LIB/knowledge-platform.e2e-spec.ts` (`describe('RAG: configuration, observability, boundaries')`) with failing tests: AS-53 (metrics `rag_ingest_total{outcome}`, `rag_ingest_duration_seconds`, `rag_retrieval_duration_seconds`, `rag_retrieval_degraded_total`, `rag_answers_total{outcome}`, `rag_documents{status}` move; capture logs, metric labels and spans over a run and assert none contains question text, document text or title, a presigned address or a secret; question hash prefix equals the cache hash), AS-54 (production refuses: no `voyage_api_key`, scripted provider, dimension ≠ 1024, missing `moderation_backend` — message names the key; development allows the test embedder), AS-55 (no FK from the two tables to other owners; ownership registry lists both under `domain:assistant`)
- [X] T064 [US8] Implement `rag_*` metrics through `@app/common/telemetry`, log hygiene (ids and hash prefix only; remove the storage-key `logger.warn`) and `KnowledgeConfigGuard` (`OnModuleInit`, production guards R-13; hashing embedder bound only when `NODE_ENV !== 'production'`; `isScripted` on the provider adapter) (G40, G42)
- [X] T065 [US8] Run `knowledge-platform.e2e-spec.ts`; then `pnpm check:table-ownership --strict` (zero findings for the domain: no `MODEL`, no `SQL` on `Product`, no FK), `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:no-wallclock`; report any check that needs approval as blocked

## Phase 11: Web (W02 follow-up, G45)

- [ ] T066 **[BLOCKED - written and type-checked, not run: the dev stack (API :8000, web :3000) is not up in this sandbox; the question box is proven by `components/product/ask-product.test.tsx`]** [P] Write failing Playwright journey `packages/web/tests/knowledge.spec.ts` (`describe('Ask this product and help documents')`): buyer asks on the product page, answer streams with source chips (runs once, web only); the two W04-dependent rows (seller PDF upload READY, help-center ask) are `test.skip` with the reason in the title (L-006: create own data; L-007: runner timeouts, 2 workers)
- [X] T067 Update `packages/web/components/product/ask-product.tsx`: parse events with `ragStreamEventSchema` from `@marketplace-sandbox/contracts`, read `sources.items` as chips, hint when `grounded:false`, `not_found` text, `refusal` shown as a refusal (not an error), statuses `401/404/422 input_rejected/429/503` with `RateLimit`/`RateLimit-Policy`/`Retry-After`, in-stream `error`; handle `503 rate_limiter_unavailable` and `422 rate_limit_cost_exceeded` (S50 follow-up) (depends on T005, T066)

## Phase 12: Polish, close and honest reporting

- [X] T068 Verify unverified criteria (rule 2): `quickstart.md` "Ops artifacts" lists SC-002, SC-003 (real-model half), SC-004 (60 s half), SC-006 and `specs/UNVERIFIED.md` has one row each (spec, criterion, how to run, status `not run`); add anything the final test mapping leaves unproven; never describe them as verified; state in the report that SC-010's repository-wide scan is not run
- [X] T069 Confirm "Sibling-spec follow-ups" and "Spec changes" in `gaps.md` still match the code (S46, S18, S05, S03, S50, S49, W02, W04; AS-07 `rate_limiter_unavailable` delta, fourth production guard, `size_mismatch` for hash mismatch, `chunkCount > 0` serving rule, real event payloads, corrected `ask.ts`); add bullets for anything new, edit no sibling spec
- [X] T070 **[DONE - core served the S47 routes and the worker registered `knowledge.sweep` once; after the bootstrap-http.ts fix the real `apps/projector` stays up and logs `consumer knowledge-product-deleted started on products.events` and `consumer knowledge-shop-deleted started on tenancy.events` (log /tmp/boot-projector.OjDV8R.log)]** Real application start (L-004, L-015): boot `apps/core`, `apps/worker`, `apps/projector` and check start-up logs for `KnowledgeModule` routes, consumer `knowledge-ingest` and job `knowledge.sweep` scheduled once, consumer groups `knowledge-product-deleted` and `knowledge-shop-deleted`. If the sandbox denies starting the apps, mark the task **blocked** (precedent S36 T060), do not mark it done
- [ ] T071 **[NOT RUN - `scripts/qa/fresh-run.sh` rebuilds the whole stack; every e2e file ran on the existing test stack after applying the three migrations]** Fresh-stack run (L-012, L-011): `scripts/qa/fresh-run.sh` for the capability; compare tables, queues and buckets with the doctor
- [X] T072 Whole capability suite once, in batches of fresh processes (L-008): unit specs (`pnpm test -- libs/domains/assistant libs/common/config`), the eight e2e files via `test-spec.sh`, `tsc --noEmit`, ESLint on touched packages, `python3 scripts/livespec/check.py`; a batch without summary line is a crash
- [X] T073 Finish the debt register `docs/work/architecture/debt-register.md`: close D-6, D-7, D-8, D-12 with the real commit id once T065 is green; mark D-14 *partially paid* (no `LlmMeter`, no `UsageService`; `./infra/llm/*` only inside the three interim adapters) and keep it open until S46 lands; confirm `.tx.baseline` reads 0
- [X] T074 Remove the legacy `LIB/knowledge.e2e-spec.ts`, `answer.service.ts`, `retriever.ts`, old controller and any dead exports once every old scenario is mapped (L-017); final grep that nothing imports them

## Gap coverage (every gaps.md item has a task)

| Items | Tasks |
|---|---|
| G1–G5 | T004, T005, T034, T038, T039 |
| G6–G10 | T035, T036, T038, T039 |
| G11 | T019, T036, T038 |
| G12 | T050, T051 |
| G13, G19, G24 | T052 |
| G14–G18, G20, G22 | T037, T040, T041, T007 |
| G21, G26 | T008, T009, T045, T051 |
| G23 | T059, T060 |
| G25, G28 | T029, T045 |
| G27, G29 | T055, T056 |
| G30–G34, G36, G37 | T023–T031 |
| G35, D-14 | T016, T017, T073 |
| G38 | T007, T030 |
| G39 | T057 |
| G40, G41, G42 | T006, T007, T063, T064 |
| G43, G44 | T025–T027, T034–T037, T043–T044, T050, T055, T059, T063 |
| G45 | T066, T067 |
| G46–G50, D-6, D-7, D-8 | T013–T018, T020, T021 |
| G51, D-12 | T008, T061 |

## Dependencies and order

- Phase 1 → Phase 2 (T022 boot check closes it) → stories. US1 (MVP) needs T012–T017, T019; US2 needs T012–T018; US3 needs US1+US2 fixtures; US4 needs US1; US5 needs US2; US6 needs US1 (T029); US7 needs US2 (T061 last, after all code); US8 needs everything it measures.
- Within a story: failing tests → domain pure code → repositories/services → controllers → run the suite.
- Parallel: T002/T003; T004/T006/T011; T014/T015/T016/T019/T021; T023/T024; T033; T054; T066. The e2e specs of different stories touch different files and can be written in parallel, but they share the test stack, so run them one batch at a time (L-008).

## MVP

Phases 1–2 plus US1 (T001–T032): a buyer can ask, get cited answers or `not_found`, with admission order and recorded calls. US2 and US3 (P1) follow before any release because documents and isolation are the data-quality and security core.
