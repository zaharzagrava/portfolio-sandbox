# Implementation Plan: S47 — "Ask this product" and shop help center (domain `assistant`, knowledge half)

**Branch**: `S47-rag-help-center` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-55, FR-001–FR-044, SC-001–SC-010), `test-plan.md`, `gaps.md` (G1–G51, debt D-6/D-7/D-8/D-12/D-14, ownership findings), `questions.md` (defaults accepted as written), the constitution (v3.x), and the follow-ups left by S05 and S50 (below).

## Summary

Bring the knowledge half of `assistant` from a sound happy-path draft to the spec: admission, error and state-machine strictness, resilience, DTO hygiene, lifecycle events and domain boundaries.

1. **Boundaries first** (D-6, D-7, D-8, D-12, D-14): ports with tokens in `domain/ports.ts` (`DocumentRepository`, `PassageRepository`, `EmbeddingProvider`, `ObjectStore`, `TaskPublisher`, `QuestionCache`, `ProductDirectory`, `ShopDirectory`, `AnswerModel`, `CallRecorder`, `Moderator`, `Clock`); adapters in `infra/`; `api/` and `application/` import no `infra/` and no `@InjectConnection`. Foreign SQL on `Product` → S05 `getProductsByIds`; foreign keys to `Shop` and `Product` removed by expand/contract; deletion by two projector consumers (`catalog.product_deleted`, `tenancy.shop_deleted`) in `KnowledgeProjectorModule`.
2. **Documents API** (`apps/core`): shared zod schemas in `packages/contracts` → explicit DTOs; create returns `201` new / `200 deduplicated`; every transition is a conditional update (`409 invalid_transition`, `409 upload_missing`); cursor list + get + retry + conditional delete; per-shop cap and `rag.ingest` policy; admin routes (create/list/delete/re-index) with the same service behind a `Scope` value (`{kind:'shop'}` or `{kind:'platform'}`).
3. **Ingestion** (`apps/worker`): one consumer, one retry layer (redelivery). Claim = conditional update with a 5-minute lease token; embedding with no network call inside a transaction; commit = one transaction that re-checks the lease, swaps passages and sets `READY`; deterministic problems → `FAILED(failureCode)` and ack; transient → `QUEUED` and redeliver; fifth receive → `FAILED(embedding_unavailable)` keeping old passages. Sweep job (S49) repairs abandoned uploads, lost enqueues, expired leases, orphaned bytes, old tombstones.
4. **Retrieval**: `KnowledgeSearchService` (exported) over `PassageRepository.candidates(scope, …)`: scope, `status <> DELETED ∧ chunkCount > 0` and, for the meaning list, `embeddingModel = configured`, all inside the ranking query; hydration repeats them; query-embedding timeout 3 s → keyword-only; statement deadline 2 s → `RetrievalUnavailableError`; optional cache keyed by model + normalized-question hash.
5. **Answers**: `AskService` runs the admission pipeline in the order of FR-032 and a pure `domain/citations.ts`; budget rejection is `429 assistant_busy` before the stream; in-stream events are `sources{mode,items}`, `text`, `done{citations,grounded}`, `not_found`, `refusal`, `error`; per-chunk output moderation; deadlines; every call (also failed/aborted) recorded through `CallRecorder`.
6. **Operate**: required configuration with startup guards (production refuses the hashing embedder, the scripted provider, a wrong dimension), `rag_*` metrics, logs without private text, eval harness on the exported service with exit codes, W02 `AskProduct` updated to the new stream contract.

Why no SQL outbox for document events: the capability publishes none (`questions.md` LOCAL). Why no new table: only columns on `KnowledgeDocument`/`KnowledgeChunk` (expand/contract).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, Next.js in `packages/web` (one component)
**Primary Dependencies**: `Sequelize` raw SQL inside `infra/` repositories only (pgvector `halfvec(1024)` + `tsvector`), `TaskQueue` (SQS port, `receiveCount`, `bodySchema`, DLQ), `ObjectStorage` (`presignPost`/`head`/`getStream`/`put`/delete), `RedisService` (cache), `@app/infrastructure/rate-limit` (`definePolicies`, `forFeature`), `@app/infrastructure/projections` (`Projector`), `@app/infrastructure/jobs` (`declareJobType`, `upsertSchedule`), `TransactionRunner` (`@app/infrastructure/context`, S54), `CLOCK` (`@app/common/core/clock`), metrics registry (`@app/common/telemetry`), `ProductQueryService` (`@app/domains/catalog`), `ShopQueryService`/`ShopScoped` (`@app/domains/tenancy`), `Firewall`/`User` (`@app/domains/identity`), existing `assistant/infra/llm` provider (until S46 moves it; see R-2)
**Storage**: PostgreSQL tables `KnowledgeDocument`, `KnowledgeChunk` (owner `assistant`, already registered); object storage prefix `knowledge/`; Redis keys `rag:qe:v1:*` (derived, 24 h TTL); SQS `knowledge-ingest` + `knowledge-ingest-dlq`
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (the eight `knowledge-*.e2e-spec.ts` files named in `test-plan.md`), unit specs beside `domain/` (`chunker`, `rrf`, `citations`, `retrieval-metrics`, `sensitive-data`, `document-cursor`, `document-state`, `failure-codes`), one Playwright journey (`packages/web/tests/knowledge.spec.ts`)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/worker` (ingest consumer + sweep), `apps/projector` (deletion consumers), `apps/local-monolith` aggregates them
**Project Type**: backend domain module + contracts package + one web component
**Performance Goals**: first words within 2 s p95 with 1 s first token (SC-002, ops artifact); retrieval < 1 s at 10 M passages (ops artifact)
**Constraints**: query embedding 3 s, retrieval 2 s, first token 30 s, answer 60 s, input moderation 200 ms, lease 5 min, upload grant 15 min, inline markdown 1 MiB, PDF 20 MiB / 500 pages, 2,000 passages per document, 1,000 documents per shop, list 20 default / 100 max
**Scale/Scope**: 10 M passages, 2,000 questions/s planned (SC-002)

**Connection arithmetic (III.12)**: ask path holds one pooled connection for the retrieval round trip only (never across the model stream); ingestion holds a connection only inside the claim, the commit transaction, and the sweep steps; embedding and storage calls run outside any transaction. Worker concurrency 4 per instance → at most 4 concurrent short transactions.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I) | PASS after work (D-6, G46–G50) | ports in `domain/ports.ts`; pure rules (`rrf`, `citations`, `scope`, `document-state`, `failure-codes`, `sensitive-data`, `document-cursor`, `retrieval-metrics`) in `domain/`; `application/` injects tokens only; no `Date.now()`/`now()` in application (clock injected; database clock only for lease/sweep ages) |
| 2 Pipeline (II) | PASS after work (G4, G37) | thin controllers; request bodies/queries parsed by zod schemas from `contracts` at the pipe; domain errors with `code` + status rendered by the global problem+json filter; the ask controller does no SQL and no lookup (II.1); guard order = FR-032 |
| 3 Data access (III) | PASS after work (G8, G14, G19, G25) | every state change is a conditional update asserting the prior state; unique partial index for content identity (`INSERT … ON CONFLICT DO NOTHING` + re-read); keyset pagination; scope predicates inside ranking queries; the three direct `sequelize.transaction` sites (`.tx.baseline` = 3) migrate to `TransactionRunner.run` and lose their `// S54 T037 audit` comment; no network I/O inside a transaction; `lock_timeout` on every migration |
| 4 Messaging (IV) | PASS after work (G16, G18, G20) | queue payload validated by `bodySchema` (DLQ at once) plus zod in the handler; DLQ reached after 5 receives (`elasticmq.conf` already `maxReceiveCount = 5`, asserted by a test, L-002); projectors validate through `defineEvent` schemas, `idempotency: 'natural'` (conditional deletes), dead-letter via the framework; explicit timeouts on every outbound call; exactly one retry layer per path |
| 5 Contracts (V) | PASS after work (G1–G6, G30, G31) | schemas in `packages/contracts/src/assistant/knowledge.ts` (+ fix `ask.ts` to the spec); problem+json with stable `code` and `requestId`; `404` for cross-tenant, `409` illegal transition, `422` semantic, `429/503` with `Retry-After`; breaking shapes listed in `contracts/knowledge-api.md` |
| 6 Frontend (VI) | PASS after work (G45) | `AskProduct` parses events with the shared schema, reads `sources.items`, `grounded`, status-specific messages; seller screens belong to W04 |
| 7 Tests (VII) | PASS after work (G43, G44) | every scenario of `test-plan.md` mapped; concurrency rows by `Promise.all`; forced paths for embedder stall/fail, cache down, limiter down, held table lock, moderator timeout; e2e seeds go through HTTP where an endpoint exists |
| 8 Operations (VIII) | PASS after work (G40–G42) | config rules in `libs/common/config/knowledge-config.ts` (joi, like `share-links-config.ts`), production guards, `rag_*` metrics, logs with ids and hash prefixes only, graceful stop of the consumer (already `onModuleDestroy`) |
| 9 DB isolation (IX) | PASS after work (D-7, D-12, G51) | zero foreign models/SQL/FKs for the domain in `check:table-ownership --strict`; hydration join `KnowledgeChunk ⋈ KnowledgeDocument` is intra-owner |
| 10 Monorepo (X) | PASS after work (D-8, G49) | barrel exports `KnowledgeModule`, `KnowledgeWorkerModule`, `KnowledgeProjectorModule`, DTO types, `KnowledgeSearchService`, `RetrievalUnavailableError`, plus the S46 symbols that other domains import today (listed in R-2) until S46 moves them |

Post-design re-check: PASS, with three flagged risks. (a) **S46 has no code yet** (`libs/infrastructure/llm`, `LlmCallRecorder`, moderation port do not exist): the plan binds to S47-owned ports and ships interim adapters over what exists, so D-14 stays *open* until S46 lands (R-2, R-3). (b) The required `lock_timeout`-guarded drop of two foreign keys is a contract step on a live table: ordered after the code stops relying on them (R-5). (c) The real moderation backend is not specified anywhere; in production the categorical check fails startup until S46 supplies one (R-3).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S47** (`getProductsByIds`): create-time ownership uses `ProductQueryService.getProductsByIds([productId], {shopId})` (absent → `404 not_found`, `ARCHIVED` → `409 product_archived`); ask-time lookup uses `getProductsByIds([productId])` plus `ShopQueryService.getShopsByIds([shopId])` for the status gate. No `JOIN "Product"`, no `ProductModel`. `ProductService.search` is gone: `application/assistant-tools.ts` already calls `ElasticsearchService.searchProducts` (S46's file; verified, nothing to change in S47; S46 owns its remaining `ProductService` use for `get_product`). The `ChatChannel → Product` and `ProductDtoService` items of the S05 list are S24's, not S47's.
2. **S50 → S47** (`definePolicies` + `forFeature`): `rag.ask` and the new `rag.ingest` move to `libs/domains/assistant/knowledge-rate-limit-policies.ts` (`definePolicies('assistant', …)`), registered by `KnowledgeModule` via `RateLimitModule.forFeature`; `llm.messages` and `llm.provider.tpm` stay in S46's file. Controllers use `@RateLimit('rag.ask' | 'rag.ingest')`; the web client and contract tests read the structured `RateLimit`/`RateLimit-Policy` headers and the two new answers: `503 rate_limiter_unavailable` (limiter store down, fail closed) and `422 rate_limit_cost_exceeded` (a cost larger than the policy limit; reachable by the budget call with `cost` = estimated tokens). Mapping to the spec: AS-07 says `503 assistant_unavailable` for limiter down — S50's code is the platform's; the plan serves the S50 answer `rate_limiter_unavailable` for the per-caller policies and keeps `assistant_unavailable` for the provider budget and moderation (see R-9; the spec text is a human-signed artifact and is not edited here, `gaps.md` "Spec changes").
3. **S54 transactions**: the three direct `sequelize.transaction` sites (`infra/retriever.ts:89`, `application/knowledge.service.ts:171`, `:217`) are migrated to `TransactionRunner.run` and their `// S54 T037 audit` comments deleted; `.tx.baseline` for the domain must fall from 3 to 0 and never rise.
4. **gaps.md items**: every row G1–G51, debt D-6/D-7/D-8/D-12/D-14 and the order of work are covered; the traceability table is in `research.md` (section "Traceability").
5. **Living specification** (rule 0): `docs/spec/capabilities/` has no page for S47. Because the change of behavior starts in the page, the first task *creates* `docs/spec/capabilities/S47-rag-help-center.md` (model: `S25-discussions.md`) describing today's rules, and each behavior task then edits the rules first and keeps `[proof: …]`/`[code: …]` true (`python3 scripts/livespec/check.py`). No `*.reviewed.json` is created or edited; no human-signed page changes (`gaps.md` "Spec changes").
6. **Unverified criteria** (rule 2): SC-002, SC-003 (real-model half), SC-004 (60-second half), SC-006 go under "Ops artifacts" in `quickstart.md` and as rows in `specs/UNVERIFIED.md` (done at plan time, status "not run"). SC-001, SC-005, SC-007, SC-008, SC-009 are proven by tests; SC-010's "full suite" scan is proven for the knowledge suites only (AS-53) and stated so.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S47-rag-help-center/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/
│   ├── knowledge-api.md      # HTTP routes, DTOs, stream events, problem codes
│   └── events-and-queues.md  # ingest queue, consumed events, job type
└── tasks.md                  # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/assistant/
├── ask.ts                    # fixed: sources {mode, items}, n from 0, headingPath string, done.grounded
└── knowledge.ts              # new: document, page, create request/response, list query, admin, reindex

packages/backend/libs/common/config/
└── knowledge-config.ts       # new: rag_* / knowledge_* keys, joi rules, production guards (types.ts keeps voyage_*)

packages/backend/libs/domains/assistant/
├── domain/
│   ├── ports.ts              # tokens + interfaces (R-1)
│   ├── chunker.ts rrf.ts     # existing (rrf gets its own spec)
│   ├── citations.ts          # pure citationsOf (G48)
│   ├── scope.ts              # RetrievalScope + predicate description (pure)
│   ├── document-state.ts     # transitions table, legal moves, FailureCode
│   ├── document-cursor.ts    # opaque keyset cursor
│   ├── sensitive-data.ts     # Luhn + credential shapes
│   ├── retrieval-metrics.ts  # recall@k, MRR
│   └── knowledge-errors.ts   # typed domain errors with code + status
├── application/
│   ├── document.service.ts       # create / uploaded / retry / delete / list / get (shop + platform scope)
│   ├── ingest.service.ts         # claim, parse, embed, commit, failure classification
│   ├── reindex.service.ts        # admin re-index (idempotent)
│   ├── knowledge-search.service.ts  # exported; replaces Retriever
│   ├── ask.service.ts            # admission order + stream (replaces answer.service.ts)
│   └── lifecycle.service.ts      # purge by product / by shop (used by projectors)
├── infra/
│   ├── pg-document.repository.ts pg-passage.repository.ts
│   ├── embedder.ts               # no internal retry; hashing adapter marked test-only
│   ├── pdf-parser.ts             # existing parser moved out of the service
│   ├── storage.adapter.ts task-publisher.adapter.ts question-cache.adapter.ts
│   ├── catalog.adapter.ts tenancy.adapter.ts      # wrap exported R1 services
│   ├── answer-model.adapter.ts call-recorder.adapter.ts moderator.adapter.ts   # interim over assistant/infra/llm (R-2, R-3)
│   ├── knowledge-ingest.consumer.ts knowledge-sweep.jobs.ts
│   └── knowledge-lifecycle.projectors.ts   # ProductDeletedConsumer, ShopDeletedConsumer
├── api/
│   ├── knowledge-documents.controller.ts   # shop routes
│   ├── knowledge-admin.controller.ts       # admin routes
│   └── knowledge-ask.controller.ts         # two ask routes (SSE writer in assistant-stream.ts)
├── knowledge-rate-limit-policies.ts
├── knowledge.module.ts       # KnowledgeModule, KnowledgeWorkerModule, KnowledgeProjectorModule
├── knowledge-*.e2e-spec.ts   # ASK DOCS INGEST RETRIEVE ADMIN EVENTS PLATFORM (test-plan.md)
└── index.ts                  # exports per D-8

packages/backend/migrations/   # 3 steps: expand, backfill, contract (R-5)
packages/backend/scripts/rag-eval/  # rag-eval.ts on KnowledgeSearchService; rag-eval.e2e-spec.ts
packages/web/components/product/ask-product.tsx   # + tests/knowledge.spec.ts
apps/projector (ProjectorModule), apps/worker, apps/core: import the three modules by name (L-004, L-015: boot each)
```

**Structure Decision**: split by responsibility inside the existing `assistant` lib (no new lib): the knowledge half gets its own files and tokens; S46 files (`assistant.*`, conversation store, generation buffer, tools, quota) are untouched except that `rate-limit-policies.ts` loses `rag.ask` and `index.ts` is rewritten.

## Phases of work (inputs for `/speckit-tasks`; mirrors `gaps.md` order, 10 steps)

1. **Living page + contracts + config** (G2, G41): create the capability page; schemas in `contracts`; `knowledge-config.ts` with rules and tests; `ask.ts` corrected.
2. **Boundaries** (D-6, D-7, D-8, D-12, G46–G51): ports, adapters, repositories, directories over S05/S03, barrel; expand migration (R-5) first, contract migration last; `TransactionRunner` migration of the three sites.
3. **Documents API** (G1, G3–G13): DTOs, validation, state machine, lease, retry, cursor list, cap, rate limits, admin routes.
4. **Ingestion resilience** (G14–G24): claim/commit, failure codes, single retry layer, receive-count handling, sweep job, orphan bytes, re-index, model per passage.
5. **Retrieval** (G25–G29): scope + status + model in the ranking query, fallback, deadline, cache.
6. **Answers** (G30–G38, D-14 interim): admission order, moderation, pre-stream rejections, deadlines, recorder, `sources.mode`, `grounded`, `rag_model` key (R-8).
7. **Lifecycle consumers** (G23): `KnowledgeProjectorModule`.
8. **Eval harness, config guards, metrics, logs** (G39, G40, G42).
9. **Tests per `test-plan.md`** (G43, G44) and web (G45): scenario → file map is kept in the task list so renames never lose a scenario (L-017).
10. **Close**: boot `apps/core`, `apps/worker`, `apps/projector` for real (L-004, L-015), run the capability suite in batches (L-008), `check:table-ownership --strict`, `check:boundaries`, `check:no-wallclock`, livespec check, debt-register rows with real commit ids.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Interim adapters for `CallRecorder`, `Moderator`, `AnswerModel` over `assistant/infra/llm` | S46's `@app/infrastructure/llm` does not exist yet; S47 must not build a second provider path nor wait | Importing `LlmMeter` directly keeps D-14 and the billing coupling; building the lib here steals S46's scope |
| `chunkCount > 0` as the "has serving passages" predicate | AS-25/AS-41 require old passages to serve while a document is `QUEUED`/`PROCESSING`/`FAILED` | A `status = 'READY'` filter (G25's literal reading) would hide a document during re-index |
| Two consumers in one module on two topics | One event contract per consumer group (framework rule) | One consumer for both topics would couple their offsets and dead letters |
