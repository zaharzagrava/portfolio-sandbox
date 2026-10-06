# Research & Decisions: Phase 2 Batch 5

## R1. Placement of the harder files {#r1}

| File | Layer | Why |
|---|---|---|
| `public-api/versioning.ts` | domain | Date-version transformers. No imports; pure. |
| `public-api/api-key-format.ts` | domain | Key prefix, hashing, and format rules (`node:crypto`). |
| `public-api/api-key.guard.ts`, `public-api.interceptor.ts` | api | Request pipeline: guard and interceptor (II.2). |
| `webhooks/webhook-events.ts` | domain | Event-type catalog and delivery shape. No imports. |
| `webhooks/signature.ts` | domain | HMAC signing and verification. |
| `webhooks/http-sender.ts` | infra | SSRF-guarded HTTPS client. |
| `ads/click-token.ts`, `share-links/codes.ts` | domain | Signed click tokens; base62 + Feistel codes. |
| `ads/click-aggregator.service.ts` | infra | Kafka consumer (read-process-write). |
| `share-links/id-lease.ts` | infra | Redis ID-range leases. |
| `flags/evaluator.ts`, `flags-context.ts` | domain | Rule evaluation; it now imports only `@app/common/core/murmur3`. |
| `flags/flags.client.ts` | infra | SDK client: ruleset load and pub/sub updates over Redis and Sequelize. |
| `flags/flags.guard.ts` | api | Route guard. |
| `analytics/event-schema.ts`, `experiments.ts`, `stats.ts` | domain | zod schema, hash-based assignment, z-test and SRM statistics. |
| `assistant/assistant-stream.ts` | api | Writes the SSE response (Express). |
| `assistant/assistant.prompt.ts`, `assistant-tools.ts`, `assistant-errors.ts` | application | Prompt assembly and tool implementations use the Anthropic SDK types and call catalog and fulfilment (R1), so they aren't pure. |
| `assistant/conversation.store.ts`, `generation-buffer.ts` | infra | ScyllaDB transcript store and Redis stream buffer. |
| `knowledge/chunker.ts`, `rrf.ts` | domain | Pure chunking and reciprocal-rank fusion. |
| `knowledge/embedder.ts`, `retriever.ts` | infra | Embedding adapter; pgvector + FTS SQL. |

## R2. The LLM adapter stays in assistant for now (D-14) {#r2}

- **Observation.** `assistant/llm/` (provider port, Anthropic and scripted providers, pricing, meter,
  module) is used by assistant, knowledge, seller-onboarding (`ExtractionService`), and the
  document-extractor Lambda. By the X.7 placement test ("talks to an external system and is used by
  several domains") it belongs in `libs/infrastructure/llm`.
- **Blocker.** `llm-meter.ts` imports `@app/domains/billing` (usage quotas) and assistant's
  `llm.call_completed` event. An infrastructure lib may not import a domain (X.3), so moving it now would
  break X.3 instead of fixing X.7.
- **Decision.** Move `llm/` intact to `assistant/infra/llm/`. Other domains reach it through the
  assistant barrel (`LLM_PROVIDER`, `LlmModule`, `LlmMeter`, `ScriptedLlmProvider`).
- **Follow-up (S46).** Make metering publish `llm.call_completed` and let billing consume it. Then the
  provider port and adapters move to `libs/infrastructure/llm` with no domain imports.

## R3. `check:table-ownership` as the first IX.5 check {#r3}

- **Why now.** The batch 4 debt note (D-12) named discovery and community only. A scan in this batch
  showed raw-SQL access to other domains' tables in 21 of 25 domains. Hand-written lists go stale, so
  each capability spec needs a live, per-domain list.
- **How it works.**
  - It loads `db/ownership.ts`.
  - It scans every non-spec `.ts` file under `libs/domains/<d>`:
    - a quoted identifier owned by another domain is reported as `SQL`;
    - an imported `*Model` from another domain's barrel is reported as `MODEL`.
  - It's lexical, so a quoted table name inside a non-SQL string would also count. That's acceptable for
    a report; review findings before acting on them.
- **Modes.** The default reports and exits 0. `--strict` exits 1 on any finding. Add it to the SDD gate
  when the report is empty (debt register footer).
- **Alternatives considered.** A full SQL parser: heavy, and Sequelize query strings are templates.
  Database permissions: rejected by the constitution (IX is logical isolation).

## R4. The domain cycle found by the full graph check {#r4}

An SCC (Tarjan) pass over the domain → barrel import graph (spec files excluded) found one component:
{catalog, discovery, experimentation, orders, payments}. The file-level edges that close it:

| Edge | Through | Debt |
|---|---|---|
| catalog → discovery | `catalog/api/product.controller.ts` uses `SearchQueryLogger` | D-15 |
| discovery → catalog | `ProductModel` in 5 discovery files | D-12 / D-7 |
| discovery → experimentation | `ANALYTICS_TOPIC` (trending consumer) | legitimate (shared topic name) |
| experimentation → orders | `OrderPaid` event contract | legitimate (X.5 allows event contracts) |
| orders → catalog | `ProductModel` (checkout, models, controller) | D-7 |
| orders ↔ payments | `PaymentModel` / `BisOrderModel`, `OrderPaid` | D-11 |

Removing D-15, D-12, D-7, and D-11 removes every back edge. The event-contract edges alone are acyclic.
This cycle has been present since batch 4 (catalog ↔ discovery). The batch 4 plan's "no cycle" claim
compared only new edges, and has been corrected.
