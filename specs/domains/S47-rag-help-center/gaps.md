# Gaps: S47 — current code versus `spec.md`

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/assistant/` unless stated; line numbers are from the code read on 2026-10-06. `pnpm --dir packages/backend check:table-ownership` needs approval in this session and was **not run**: the ownership findings below come from code search (`@app/domains/*` imports, `@InjectModel`/`@InjectConnection`, raw SQL, migration foreign keys) and must be re-checked against the live `MODEL` and `SQL` rows of the report before closing (see "Table-ownership findings"). S46 rows that touch the same files are in `specs/domains/S46-shopping-assistant/gaps.md`; they are referenced, not repeated.

The current code is a sound draft of the happy path (chunker, RRF, hybrid query with in-query scope, content-hash idempotency, delete in one transaction, e2e of the main flows). The gaps are in admission and error semantics, state-machine strictness, resilience, DTO hygiene, lifecycle events, and boundaries.

## What the code gets wrong or lacks

### Documents API and DTOs

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | Responses are raw database rows (storage key, content hash, indexed hash, embedding model, creator, raw error text) | `application/knowledge.service.ts:65-125`, `api/knowledge.controller.ts:44-59` | AS-15, FR-008, V.1 |
| G2 | No `packages/contracts` schemas for documents, create, ask or stream events; the DTO classes live in the controller | `api/knowledge.controller.ts:13-30` | Cross-capability contracts, V.2 |
| G3 | Create returns `201` for duplicates; no `200 deduplicated` distinction at HTTP level | `api/knowledge.controller.ts:40-46` | AS-21 |
| G4 | Validation: markdown limit 20 MiB inline; no `400` for both-or-neither body, `pdfSha256` without size, whitespace-only markdown reaches the service as `BadRequest` with free text; no `forbidNonWhitelisted` evidence for unknown fields; `SHOP_PRIVATE`+`productId` is `400` | `knowledge.service.ts:13,66-67,243-245`, `api/knowledge.controller.ts:13-22,44-47` | AS-17 |
| G5 | List: no cursor, no `status` filter, hard `LIMIT 200`, no `GET …/documents/:documentId` route | `knowledge.service.ts:111-115`, controller | AS-31, III.10 |
| G6 | `uploaded` silently returns the row for any state and answers `400` for a missing upload; no `409 invalid_transition` / `upload_missing` | `knowledge.service.ts:102-109` | AS-23 |
| G7 | No `retry` route; `FAILED` is only retried by incidental redelivery because `ingest` claims `FAILED` rows | `knowledge.service.ts:138-142` | AS-30, FR-003 |
| G8 | Delete is read-then-update (`get` then unconditional `UPDATE`), so two concurrent deletes both succeed or one hits a stale row; no `404` on repeat in the same statement | `knowledge.service.ts:128-135` | AS-28 |
| G9 | Non-member and permission semantics rely on `ShopScoped`; no test of the matrix, no status-gate coverage (`shop_suspended`, `shop_offboarding`) | controller `:40-67`, `knowledge.e2e-spec.ts:230-240` | AS-18, AS-19 |
| G10 | Another shop's product is `403` (`ForbiddenException`) and ownership comes from raw SQL | `knowledge.service.ts:242-250` | AS-20, FR-010 |
| G11 | No per-shop document cap, no `rag.ingest` rate-limit policy on create/upload | `rate-limit/rate-limit.types.ts:60` (only `rag.ask`), controller | AS-32, AS-33, FR-009 |
| G12 | No admin routes beyond create: no list, no delete, no PDF form, no re-index | `api/knowledge.controller.ts:69-74` | AS-40, AS-41 |
| G13 | Upload grant expiry and 15-minute TTL are not asserted; `AWAITING_UPLOAD` documents are never cleaned | `knowledge.service.ts:98`, no job | AS-16, AS-42 |

### Ingestion

| # | Gap | Where | Spec |
|---|---|---|---|
| G14 | No processing lease: the claim updates `PROCESSING` rows again, so two workers embed the same document (double provider cost) | `knowledge.service.ts:138-146` | AS-26, FR-004 |
| G15 | Transient embedding failure sets `FAILED` and rethrows; a `READY` document being re-indexed would show `FAILED` while old passages serve; no `failureCode`; raw error text stored and returned | `knowledge.service.ts:178-186` | AS-24, AS-25, FR-006 |
| G16 | No dead-letter handling that marks the document `FAILED(embedding_unavailable)` after the 5th receive | `knowledge.module.ts:44-48` | AS-25 |
| G17 | No page limit (500) and no `size_mismatch` check against the declared size; limits throw `PoisonDocumentError` with free text | `knowledge.service.ts:151-152,190-196,204-207` | AS-24 |
| G18 | Embedder retries inside the call (up to 5 attempts) and the queue redelivers: two retry layers; the question path has no timeout shorter than 20 s and no fallback | `infra/embedder.ts:15-16,43-48` | FR-006, FR-024, IV.6 |
| G19 | `storage.put` and `queue.enqueue` after the insert with no repair: a crash between them leaves a `QUEUED` document with no task forever | `knowledge.service.ts:76-80,107` | AS-42, FR-011 |
| G20 | Queue payload is not zod-validated (`body.documentId` used as is); no invalid-payload test | `knowledge.module.ts:46` | AS-27, IV.5 |
| G21 | No re-index path and no model stored per passage: changing `voyage_model` silently mixes vector spaces in one index | migration `20261002160000-knowledge-base.js`, `knowledge.service.ts:166-170` | AS-41, FR-013 |
| G22 | Ingestion concurrency, batch size and lease are constants in code, not configuration | `knowledge.module.ts:46`, `embedder.ts:15` | Config keys |
| G23 | No lifecycle consumers: product and shop deletion rely on database cascades (`REFERENCES "Shop"`, `REFERENCES "Product" ON DELETE CASCADE`) | migration `20261002160000-knowledge-base.js:19-20` | AS-50 – AS-52, FR-012 |
| G24 | Stored bytes of deleted documents are removed best-effort with a warning log; no retry or sweep for orphaned objects | `knowledge.service.ts:134` | AS-28, AS-42 |

### Retrieval and answers

| # | Gap | Where | Spec |
|---|---|---|---|
| G25 | Document `status = 'READY'` is checked only in the hydration query, after fusion; candidate queries do not filter on it, and hydration loads by id without the scope predicate | `infra/retriever.ts:78-106` | AS-35, FR-021, III.4 |
| G26 | No embedding-model filter in the vector candidates | `infra/retriever.ts:80-88` | AS-41, FR-013 |
| G27 | No query-embedding timeout or keyword-only fallback; an embedder error fails the whole ask | `infra/retriever.ts:73,108-120` | AS-46, FR-024 |
| G28 | No retrieval deadline (statement timeout) | `infra/retriever.ts:75-92` | AS-48, FR-026 |
| G29 | The cache key and TTL exist, but there is no test of normalization, model in key, or cache-down path | `infra/retriever.ts:30,108-120`, e2e | AS-47 |
| G30 | `sources` event is a bare array; no `mode`; no `grounded` on `done`; `citationsOf` is untested and an empty-text/other-kind path is untested | `application/answer.service.ts:75,100-101,138-148` | AS-01, AS-12 |
| G31 | Budget rejection is an in-stream `error {code: 'BUSY'}` after `sources`; other pre-stream rejections have no codes | `application/answer.service.ts:78-82` | AS-08, FR-032 |
| G32 | No input moderation, no sensitive-data rejection, no output moderation | `answer.service.ts` (none) | AS-06, FR-035 (S46 port) |
| G33 | No first-token or whole-answer deadline; the failed/aborted/refused calls are not metered (`meter.record` runs only after a completed result) | `answer.service.ts:84-106` | AS-09 – AS-11, FR-036, FR-037 |
| G34 | `AbortController` is wired on `res.close` but the abort path records nothing and is untested | `answer.service.ts:88-89,111` | AS-11 |
| G35 | Metering uses `LlmMeter` (direct billing call) and re-provides `UsageService`; help-center ask passes the shop id as `subjectId` | `answer.service.ts:100`, `api/knowledge.controller.ts:89`, `knowledge.module.ts:10,39` | AS-01, AS-39, FR-037, D-14 |
| G36 | Product ask does not check that the product is active and the shop active; archived or suspended shops' documents are served to anonymous users | `api/knowledge.controller.ts:77-84` | AS-04, FR-030 |
| G37 | The ask paths run no admission order; limiter, validation, lookup are interleaved by the framework | controller `:77-92` | AS-14 |
| G38 | The model default `claude-opus-5-5` for short grounded answers is expensive; configuration key `assistant_model` is shared with S46 | `answer.service.ts:61-63` | LOCAL: add `rag_model` default (S46's `assistant_summary_model` tier) — not in the spec; decide in plan |
| G39 | Evaluation harness imports `Retriever`, boots the full `KnowledgeModule` (HTTP, controller, rate limits) and has no malformed-file exit code, no test | `scripts/rag-eval/rag-eval.ts:18,41-60` | AS-49 |

### Configuration, observability, tests

| # | Gap | Where | Spec |
|---|---|---|---|
| G40 | A missing `voyage_api_key` selects the hashing embedder in every environment; model dimension unchecked | `knowledge.module.ts:21-27` | AS-54, FR-042 |
| G41 | Config keys `rag_*`, `knowledge_*` are mostly not declared in `libs/common/config/types.ts` (only `voyage_*`, `rag_min_similarity`); no schema validation | `libs/common/config/types.ts:183-187` | Config keys, VIII.5 |
| G42 | No metrics (`rag_*`), no structured fields without private text; the `logger.warn` for orphaned objects logs a storage key | `knowledge.service.ts:134`, `answer.service.ts:116` | AS-53, FR-044 |
| G43 | Tests: the 10 e2e tests cover happy paths only; missing: AS-02 – AS-14, AS-17 – AS-23, AS-25 – AS-33, AS-36 – AS-42, AS-45 – AS-52, AS-54; the RRF test sits in `chunker.spec.ts`; there is no UI journey for the seller upload | `knowledge.e2e-spec.ts`, `domain/chunker.spec.ts:67-81` | test-plan.md |
| G44 | e2e seeds use `ShopModel`, `ShopMembershipModel` directly (allowed in tests) and call services (`knowledge.createMarkdown`, `retriever.search`) instead of HTTP for ingestion and retrieval | `knowledge.e2e-spec.ts:17,26,95-98` | VII.2 (through supertest where an endpoint exists; services only for queue-driven steps) |
| G45 | Web: `AskProduct` handles only `429`, treats `refusal` as an error, ignores `sources`/`grounded`, shows no source chips contract | `packages/web/components/product/ask-product.tsx:22-47` | AS-01, W02 (CONTRACT) |

### Layering and boundaries

| # | Gap | Where | Spec |
|---|---|---|---|
| G46 | `api/` and `application/` issue SQL through `@InjectConnection` and import `infra/` (`Embedder`, `toVectorLiteral`, `Retriever`) | `api/knowledge.controller.ts:4,37`, `application/knowledge.service.ts:2,13,59`, `application/answer.service.ts` imports `../infra/*` | D-6, I.2 |
| G47 | Domain ports are missing: `DocumentRepository`, `PassageRepository`, `EmbeddingProvider` (today an abstract class in `infra/`), `ObjectStore`, `TaskPublisher`, `QuestionCache`, `Clock` | `infra/embedder.ts:8-12` | I.1, D-6 |
| G48 | Pure logic lives in `infra/` or `application/`: `citationsOf` (`answer.service.ts:138`), `scopeSql` (`retriever.ts:36-48`), `toVectorLiteral` | — | I.1 (pure logic into `domain/` for unit tests) |
| G49 | Barrel exports `Retriever`, `LlmMeter`, `ScriptedLlmProvider`, `LlmCallsProjector`, the provider internals | `index.ts:8-16` | X.4, D-8 |
| G50 | Time: `now()` in SQL and `Date.now()` in the answer service | `knowledge.service.ts` (several), `answer.service.ts:89,93` | I.3 (injected clock in application; database clock only for lease and sweep ages) |
| G51 | Ownership registry already lists both tables as `domain:assistant` (`db/ownership.ts:166-167`) — keep; remove the two foreign keys by an expand/contract migration with `lock_timeout` | migration `20261002160000-knowledge-base.js:19-20` | AS-55, IX.4, III.11 |

## Open debt-register rows naming `assistant` or S47

| Row | What it says for this domain | Replaced by (IX.7) | Done when |
|---|---|---|---|
| **D-6** (I.2, open) | `api/` and `application/` import `infra/` directly; the knowledge half injects the connection and `Embedder`/`Retriever` | Ports and tokens in `domain/` (G47), adapters in `infra/`, repositories own all SQL (G46) | no `infra/` path in imports of `api/` or `application/` in the knowledge files; `pnpm check:boundaries` clean for this lib |
| **D-7** (IX.4, open) | Other domains' `*Model` exports | S47 imports no foreign model; the barrel exports no model of this domain | `MODEL` rows of the check are empty for this domain |
| **D-8** (X.4, open) | Barrel exports `Retriever`, `LlmMeter`, provider internals | `KnowledgeModule`, `KnowledgeWorkerModule`, `KnowledgeProjectorModule`, DTO types, `KnowledgeSearchService` only (G49); provider exports move with S46 | `index.ts` exports modules, DTO types, event contracts and the search service only |
| **D-12** (IX.4, open) | Raw SQL on another domain's tables | **S47:** `SELECT "shopId" FROM "Product"` at `application/knowledge.service.ts:246` and `api/knowledge.controller.ts:81` → **R1** S05 `ProductQueryService.getProductsByIds`; the two foreign keys to `Shop` and `Product` → removed, deletion by **R3** events (`catalog.product_deleted`, `tenancy.shop_deleted`) consumed by a projector | the check reports zero `SQL` rows for this domain; no `REFERENCES` to another owner's table in the schema |
| **D-14** (X.3, X.7, open) | LLM port and adapters in `assistant/infra/llm` used by others; `llm-meter` calls billing directly | S46 moves the port to `libs/infrastructure/llm`; S47 switches to `LlmCallRecorder` (R3: S18 consumes `llm.call_completed`), drops `LlmMeter` and the re-provided `UsageService` (G35) | `knowledge.module.ts` has no `UsageService`, `LlmMeter`; no import of `./infra/llm/*` |

Rows that do not name this domain (D-1 … D-5, D-9 … D-11, D-13, D-15 … D-17) are not S47's. D-9 (central model registry) is untouched because the domain has no models (raw SQL only); if the implementation introduces models, they register in the domain's own module (X.2), not in `all-models.ts`.

## Table-ownership findings (cross-domain SQL and model access, D-7 / D-12)

`pnpm --dir packages/backend check:table-ownership` could not be run here (requires approval). Findings from code search, to confirm against the live report:

| Kind | Where | Foreign object | Replaced by |
|---|---|---|---|
| Raw SQL on a foreign table | `application/knowledge.service.ts:246` | catalog `Product` (`SELECT "shopId" FROM "Product" WHERE id = :id`, product-in-shop check) | **R1**: S05 `getProductsByIds([productId], {shopId})`; unknown or other shop → `404` |
| Raw SQL on a foreign table | `api/knowledge.controller.ts:81` | catalog `Product` (`SELECT "shopId" FROM "Product"`, shop of the asked product) | **R1**: S05 `getProductsByIds([productId])`, plus S03 `getShopsByIds` for the status gate; the controller stops issuing SQL (II.1) |
| Foreign key | migration `20261002160000-knowledge-base.js:19` | tenancy `Shop` (`"shopId" UUID NULL REFERENCES "Shop"("id")`) | plain id column; deletion by **R3** event `tenancy.shop_deleted` (projector consumer in this domain's `infra/`) |
| Foreign key with cascade | migration `20261002160000-knowledge-base.js:20` | catalog `Product` (`REFERENCES "Product"("id") ON DELETE CASCADE`) | plain id column; deletion by **R3** event `catalog.product_deleted` |
| Re-provided foreign service | `knowledge.module.ts:10,39` | billing `UsageService` (constructed again with the assistant's wiring) | **R3**: no direct call; S18 consumes `llm.call_completed` |
| Foreign module import for guards | `api/knowledge.controller.ts:7-8` | identity `Firewall`, `User`, `Role`; tenancy `ShopScoped` | allowed: exported decorators and guards from the owners' entry points (X.4); keep imports to `@app/domains/identity` and `@app/domains/tenancy` entry points only |
| Foreign model in a spec | `knowledge.e2e-spec.ts:17,26` | tenancy `ShopModel`, `ShopMembershipModel` | test seeds (allowed in test code, IX.6); move to the shared seed helpers |
| Own tables, raw SQL (allowed) | `application/knowledge.service.ts`, `infra/retriever.ts` | `KnowledgeDocument`, `KnowledgeChunk` | stays, but moves into `infra/` repositories behind domain ports (D-6, G46) |

The hydration query joins `KnowledgeChunk` and `KnowledgeDocument` (`infra/retriever.ts:98-103`): both are owned by this domain (`db/ownership.ts:166-167`), so the join is allowed (IX.4 forbids joins only across owners).

## Order of work (suggested)

1. Contracts: `packages/contracts` schemas (G2); coordinate with S05 (`getProductsByIds`), S03 (`getShopsByIds` with `status`, events), S46 (moderation port and recorder location), S18 (`llm.rag.tokens`, `anonymous`), S50 (`rag.ingest`).
2. Boundaries: ports, repositories, remove foreign SQL and foreign keys (expand/contract with `lock_timeout`), entry point cleanup (G10, G46 – G51, D-6, D-7, D-8, D-12).
3. Documents API: DTOs, validation, state machine with conditional updates, lease, retry, cursor list, cap, rate limit (G1 – G15, G17, G20).
4. Ingestion resilience: single retry layer, dead-letter handling, sweep job, orphan cleanup, re-index and model column (G16, G18, G19, G21 – G24).
5. Retrieval: scope and status in the candidate queries, model filter, embedding timeout and keyword fallback, deadline, cache tests (G25 – G29).
6. Answers: admission order, moderation, pre-stream rejections, deadlines, recorder (D-14), `sources.mode`, `grounded`, citation unit tests (G30 – G38).
7. Lifecycle consumers in `KnowledgeProjectorModule` with inbox, zod validation and DLQ (G23).
8. Eval harness on `KnowledgeSearchService` with exit codes (G39); configuration schema and startup guards (G40, G41); metrics and log hygiene (G42).
9. Tests per `test-plan.md`: split `knowledge.e2e-spec.ts`, move RRF to `domain/rrf.spec.ts`, add the missing rows (G43, G44); web `AskProduct` update (G45, W02).
10. Close D-6, D-7, D-8, D-12, D-14 rows in `docs/architecture/debt-register.md` with the actual commit, once `pnpm check:table-ownership --strict` and `pnpm check:boundaries` are green for this domain.
