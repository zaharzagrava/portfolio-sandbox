# Quickstart: validating S47 RAG help center

Contracts: [knowledge-api.md](contracts/knowledge-api.md), [events-and-queues.md](contracts/events-and-queues.md). Stores: [data-model.md](data-model.md). Scenario → file map: [test-plan.md](test-plan.md).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`: PostgreSQL with `pgvector`, Redis, ElasticMQ with `knowledge-ingest` and `knowledge-ingest-dlq` from `infra/docker/elasticmq/elasticmq.conf`, object storage, Kafka stand-in). L-011 / L-002: compare tables, queues and buckets with the doctor before the first run; readiness must fail while `knowledge-ingest` is missing.
- Migrations applied in order: S47 *expand*, *backfill*; *contract* only after the code of work-order steps 2–4 is in (it drops the two foreign keys and `KnowledgeDocument.error`).
- Configuration (test values come from the config mock; production values are secrets): `voyage_api_key` (absent → deterministic hashing embedder, **refused when `NODE_ENV=production`**), `voyage_model` (`voyage-3.5`, 1,024 dimensions), `rag_model`, `rag_min_similarity`, `rag_candidates`, `rag_top_k`, `rag_query_embed_timeout_ms`, `rag_retrieval_timeout_ms`, `rag_first_token_timeout_ms`, `rag_answer_timeout_ms`, `knowledge_max_documents_per_shop` (3 in tests), `knowledge_max_pages`, `knowledge_processing_lease_ms`, `knowledge_upload_ttl_s`, `knowledge_max_receives` (5, equal to the queue's `maxReceiveCount`), `rag_eval_min_recall`, `moderation_backend` (required in production until S46 supplies the port).

## Run

From `packages/backend` (L-008: batches of fresh processes; each prints a condensed result and the log path; open the full log only if that is not enough):

```bash
pnpm test -- libs/domains/assistant libs/common/config                    # unit specs: chunker, rrf, citations, retrieval-metrics, sensitive-data, document-state, document-cursor, knowledge-config
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-documents.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-ingest.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-retrieval.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-ask.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-admin.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-events.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-platform.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh scripts/rag-eval/rag-eval.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/assistant/knowledge-schema.e2e-spec.ts   # expand / backfill / contract migrations on a scratch database
/opt/sdd/repo/scripts/sdd/test-spec.sh apps/core/src/knowledge-wiring.e2e-spec.ts apps/worker/src/knowledge-wiring.e2e-spec.ts apps/projector/src/knowledge-wiring.e2e-spec.ts   # the real applications (L-015)
pnpm --dir packages/web exec vitest run components/product/ask-product.test.tsx   # the question box
```

The migrations are applied to the test database with `pnpm run db:jest:migrate:up` (expand, backfill, contract in filename order). `scripts/rag-eval/golden.json` is environment-specific (shop and product ids): copy `golden.example.json` and fill the ids from the seeded index.

Expected: every file's summary shows 0 failed. A batch without its summary line is a crash, not a flaky test (L-008). Web (from `packages/web`, runner timeouts `PW_EXPECT_TIMEOUT_MS`, 2 workers, empty stack, L-006/L-007): `pnpm exec playwright test tests/knowledge.spec.ts` (the two W04-dependent rows stay skipped with their reason in the title).

## Static gates (AS-55)

```bash
pnpm --dir packages/backend exec tsc --noEmit -p tsconfig.json
pnpm --dir packages/backend check:boundaries
pnpm --dir packages/backend check:module-graph
pnpm --dir packages/backend check:no-wallclock
pnpm --dir packages/backend check:table-ownership --strict    # no assistant knowledge finding: no MODEL, no SQL on foreign tables, no FK
python3 scripts/livespec/check.py                             # new page docs/spec/capabilities/S47-rag-help-center.md
```

`.tx.baseline` for the domain must read 0 (three audited sites migrated); the count never rises.

## Start the real applications (L-004, L-015)

Boot `apps/core`, `apps/worker` and `apps/projector` for real and check the start-up log lines for `KnowledgeModule` (routes `…/knowledge/…`, `/products/:productId/ask`), `KnowledgeWorkerModule` (consumer `knowledge-ingest`, job `knowledge.sweep` scheduled once) and `KnowledgeProjectorModule` (consumer groups `knowledge-product-deleted`, `knowledge-shop-deleted`). A test that builds its own module cannot see a missing import in the real one. If the sandbox denies starting the apps, report the task as blocked; do not mark it done (see S36 T060 for the precedent).

## Manual smoke (after the stack and apps are up)

1. As a shop owner create a markdown document → `201`, then poll `GET …/documents/:id` until `READY`.
2. `POST /api/products/<id>/ask` anonymously with a question the document answers → stream `sources` → `text` → `done` with `grounded: true`; with an off-topic question → `not_found` and no `llm.call_completed` row.
3. Delete the document → `204`; repeat the question → `not_found`.
4. Evaluation: `pnpm --dir packages/backend rag:eval -- --golden scripts/rag-eval/golden.json --k 6` → prints recall@6 and MRR; exit `1` below `RAG_EVAL_MIN_RECALL`.

## Ops artifacts (success criteria no automated test proves)

Each is also a row in `specs/UNVERIFIED.md` with status `not run`; none is described as verified.

- **SC-002** (first words within 2 s at p95; retrieval and admission under 1 s at 10 M passages and 2,000 questions/s): load script (k6) against a seeded index of 10 M passages with the scripted model's first token fixed at 1 s; record p95 time-to-first-`text` event and the retrieval histogram. Not run.
- **SC-003** (recall@6 ≥ 0.8 on the repository golden set, release gate): the harness test (AS-49) proves the maths and the exit codes with the deterministic embedder; the figure itself needs the real Voyage embedder and the curated golden file: `RAG_EVAL_MIN_RECALL=0.8 pnpm --dir packages/backend rag:eval -- --golden scripts/rag-eval/golden.json --k 6` against an index built with `voyage_api_key`. Not run.
- **SC-004, 60-second half** (a product or shop deletion is invisible within 60 s of the event): AS-50/51 prove the effect after delivery; the latency from event publication to invisibility needs the deployed projector: publish `catalog.product_deleted` for a seeded product and poll the ask route until `not_found`, 100 trials. Not run.
- **SC-006** (a 50-page PDF is `READY` within 2 minutes of upload completion in 95% of cases with the real provider): upload 50-page PDFs, time `uploaded` → `READY`, 100 trials, real `voyage_api_key`. Not run.

SC-001, SC-005, SC-007, SC-008, SC-009 are proven by the e2e rows named in `test-plan.md`. SC-010 is proven for the knowledge suites (AS-53 captures logs, metric labels and spans of those runs); a scan over the full repository suite is not run.
