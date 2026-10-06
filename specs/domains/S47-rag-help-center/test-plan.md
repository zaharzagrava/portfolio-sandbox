# Test plan: S47 — "Ask this product" and shop help center (constitution VII.8)

One row per acceptance scenario of `spec.md`. A scenario is proven at the lowest layer that can prove it; `—` means not tested at that layer. UI journeys are happy paths only (VII.7). The embedding provider is the deterministic hashing embedder (a fake that can be told to fail or stall), the model is the scripted provider, moderation is a stub (system edge only); Postgres, the cache store, the task queue and object storage are real engines from `docker-compose.test.yaml` with real migrations; time is frozen. Every e2e test asserts the response body **and** the persisted state (documents, passages, queue tasks, outbox rows, counters).

Spec files (all under `packages/backend/libs/domains/assistant/` unless a path is given; each top-level `describe` names its feature):

| Short name | File | Top-level `describe` |
|---|---|---|
| ASK | `knowledge-ask.e2e-spec.ts` | `RAG: ask this product and the shop help center` |
| DOCS | `knowledge-documents.e2e-spec.ts` | `RAG: document management API` |
| INGEST | `knowledge-ingest.e2e-spec.ts` | `RAG: ingestion pipeline (queue consumer)` |
| RETRIEVE | `knowledge-retrieval.e2e-spec.ts` | `RAG: hybrid retrieval and in-query permissions` |
| ADMIN | `knowledge-admin.e2e-spec.ts` | `RAG: platform articles, re-index and sweeps` |
| EVENTS | `knowledge-events.e2e-spec.ts` | `RAG: product and shop deletion consumers` |
| EVAL | `scripts/rag-eval/rag-eval.e2e-spec.ts` (under `packages/backend/`) | `RAG: evaluation harness` |
| BOOT | `knowledge-platform.e2e-spec.ts` | `RAG: configuration, observability, boundaries` |
| WEB | `packages/web/tests/knowledge.spec.ts` (Playwright) | `Ask this product and help documents` |
| UNIT | files under `domain/` of this lib (`*.spec.ts`) | named per file |

Static layer (VII.1) for every row: `tsc --noEmit`, ESLint, `pnpm check:boundaries` and `pnpm check:table-ownership --strict` pass for the touched packages. Contract layer (VII.6): every e2e response and stream event is parsed with the matching `packages/contracts` schema.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 answer with citations | ASK: "streams sources → text → done with citations mapped to the cited passage; model request shape; one usage record" | WEB: buyer asks on the product page, answer streams in with source chips (once on web; mobile has no client yet) | — |
| AS-02 anonymous buyers | ASK: "anonymous caller is served; invalid token is 401; usage subject is `anonymous`" | — | — |
| AS-03 nothing relevant → not found | ASK: "off-topic question → not_found, model never called, no usage record" | — | — |
| AS-04 product not askable | ASK: "unknown, archived and inactive-shop products answer the same 404; restore serves again" (`it.each`) | — | — |
| AS-05 question validation classes | ASK: "rejects every invalid question class with no side effect" (`it.each` over the table, plus both boundaries accepted) | — | — |
| AS-06 moderation, sensitive data | ASK: "flagged, sensitive-data and moderator-down questions are rejected with no side effect" | — | — |
| AS-07 rate limit | ASK: "11th ask in a minute is 429 with Retry-After; other caller unaffected; limiter down is 503" | — | — |
| AS-08 provider budget | ASK: "exhausted fleet budget is 429 assistant_busy before the stream, nothing recorded" | — | — |
| AS-09 provider failures and timeouts | ASK: "provider unavailable, first-token and whole-answer timeouts end with an error event and a failed usage record" (`it.each`, forced paths, frozen clock) | — | — |
| AS-10 provider refusal | ASK: "refusal ends the stream with no done; usage recorded" | — | — |
| AS-11 client disconnect | ASK: "closing the connection aborts the provider call within 1 s and records an aborted estimate" | — | — |
| AS-12 citation integrity | — | — | `domain/citations.spec.ts` (`it.each`: out-of-range, negative, other location kind, duplicates, empty text, none → `grounded: false`) |
| AS-13 documents are data | ASK: "injection text in a document stays inside passage blocks; instruction block is byte-identical" | — | — |
| AS-14 admission order | ASK: "the first failing check decides the answer" (`it.each` over the four table rows) | — | — |
| AS-15 markdown → ready | DOCS: "creates, queues, indexes and reports READY; no internal fields in the body" + INGEST: "markdown → structure-aware passages with embeddings and keyword entries" | — | — |
| AS-16 PDF flow | DOCS: "PDF create returns a bound upload grant; uploaded queues once" + INGEST: "PDF pages and numbered headings survive into passages" | WEB: seller uploads a PDF manual on the dashboard and sees READY (pending W04 owning the screen; skipped until then) | — |
| AS-17 validation classes, create | DOCS: "rejects every invalid create class with no side effect; accepts the exact limits" (`it.each`) | — | — |
| AS-18 unauthenticated | DOCS: "401 on every route" (`it.each` over the shop, admin and help-center routes) | — | — |
| AS-19 authorization matrix | DOCS: "non-member 404, missing permission 403, suspended and offboarding gates, non-admin 403 on admin routes" (`it.each` over route × principal) | — | — |
| AS-20 product ownership | DOCS: "another shop's or unknown product is 404, archived is 409, nothing stored" | — | — |
| AS-21 same bytes → same document | DOCS: "repeat is 200 deduplicated; other scope creates a new document; deleted bytes can be re-added" | — | — |
| AS-22 concurrent identical creates | DOCS: "five parallel identical creates → one 201, four 200, one row, one task" | — | — |
| AS-23 uploaded transitions | DOCS: "upload_missing, replays, FAILED is 409, concurrent calls queue once" | — | — |
| AS-24 poison input | INGEST: "each poison input ends FAILED once with its failureCode and is acknowledged" (`it.each` over six inputs) | — | — |
| AS-25 transient failure, retry, dead letter | INGEST: "transient errors requeue and then succeed; five receives dead-letter and keep previous passages" | — | — |
| AS-26 redelivery and concurrent delivery | INGEST: "redelivery is a no-op; two workers at once embed once; expired lease is taken over" | — | — |
| AS-27 invalid queue payload | INGEST: "invalid payloads are dead-lettered with no effect; unknown id is acknowledged" (`it.each`) | — | — |
| AS-28 delete | DOCS: "delete is immediate for list, get and questions; repeat is 404; concurrent deletes → one 204" | — | — |
| AS-29 delete during ingestion | INGEST: "document deleted while embedding stays DELETED with zero passages" | — | — |
| AS-30 retry a failed document | DOCS: "retry from FAILED is 202; every other status is 409; concurrent retries → one 202" | — | — |
| AS-31 list and read | DOCS: "keyset paging, status filter, limits, invalid cursor, scope isolation, contract schema" | — | — |
| AS-32 per-shop document cap | DOCS: "cap reached is 422; duplicate still 200; delete frees a slot" | — | — |
| AS-33 ingestion rate limit | DOCS: "31st create in a minute is 429; other shop unaffected" | — | — |
| AS-34 structure-aware chunking | — | — | `domain/chunker.spec.ts` (`describe.each` over headings, fences, FAQ merge, long paragraph, giant sentence, PDF pages; fast-check property: every sentence appears; determinism) |
| AS-35 buyer scope | RETRIEVE: "buyer scope returns only the product's and the shop-level public passages" | — | — |
| AS-36 help-center scope | RETRIEVE: "member scope returns platform plus own public and private, never another shop's" | — | — |
| AS-37 filter before ranking | RETRIEVE: "300 stronger foreign passages never starve the caller's 3" | — | — |
| AS-38 end to end over HTTP | ASK: "another shop's private text never reaches the stream or the model request" | — | — |
| AS-39 help-center answer | ASK: "member asks the help center: platform article cited, usage subject is the user, suspended shop allowed" | WEB: seller asks the help center and sees a cited answer (pending W04; skipped until then) | — |
| AS-40 platform documents | ADMIN: "administrator creates, lists, deletes platform articles; shop routes cannot touch them; buyers never see them" | — | — |
| AS-41 embedding model change | ADMIN: "stale-model passages leave meaning search, stay keyword-findable, re-index is idempotent and swaps atomically" | — | — |
| AS-42 sweeps | ADMIN: "abandoned uploads, lost enqueues and expired leases are repaired once; tombstones purged; concurrent runs are single" (frozen clock) | — | — |
| AS-43 hybrid: meaning and exact terms | RETRIEVE: "paraphrase found by meaning, model number found by keywords with the floor raised, heading words match" | — | — |
| AS-44 reciprocal rank fusion | — | — | `domain/rrf.spec.ts` (`it.each` with exact scores: both-lists beats single #1, ties stable, empty, duplicate in list, k = 60) |
| AS-45 relevance floor | RETRIEVE: "below-floor meaning hits count only with a keyword hit; off-topic yields empty" | — | — |
| AS-46 embedding provider down → keyword-only | RETRIEVE: "failing and stalled embedder degrade to mode keyword; counter increments; no keyword match → empty" (forced path) | — | — |
| AS-47 question-embedding cache | RETRIEVE: "case and whitespace variants embed once; key includes model; cache down still answers" (forced path) | — | — |
| AS-48 retrieval store slow | ASK: "a held table lock makes the ask 503 before the stream with a generic body" (forced path) | — | — |
| AS-49 evaluation harness | EVAL: "reports recall@k and MRR, exits 1 below the minimum, exits 2 on a malformed file, makes no model call" | — | `domain/retrieval-metrics.spec.ts` (`it.each`: rank 1, rank k, rank k+1, no expected, empty list) |
| AS-50 product deleted | EVENTS: "product_deleted removes its documents, passages and bytes; duplicate delivery is a single effect; other documents unchanged" | — | — |
| AS-51 shop deleted | EVENTS: "shop_deleted purges only that shop; duplicate delivery is a single effect" | — | — |
| AS-52 invalid event payloads | EVENTS: "invalid payloads are dead-lettered with no effect and do not block the next message" (`it.each`) | — | — |
| AS-53 observability, no private text | BOOT: "metrics move; no log, metric label or trace attribute contains question, document text or title, or a presigned address" | — | — |
| AS-54 startup configuration | BOOT: "production refuses the test embedder, the scripted provider and a wrong dimension; development allows the test embedder" | — | — |
| AS-55 domain boundaries | BOOT: "no foreign keys from the domain's tables; ownership registry lists both tables under `domain:assistant`" + static gate `pnpm check:table-ownership --strict` and `pnpm check:boundaries` | — | — |

## Coverage notes

- Every edge case from the notes (§43: permissions inside the query, content-hash skip, delete of chunks of deleted documents, "not found" below the threshold, golden-set evaluation, batched embeddings, hybrid merge) maps to exactly one row: AS-35 – AS-38, AS-21/22/26, AS-28/50/51, AS-03/45, AS-49, AS-15, AS-43/44.
- Concurrency rows (AS-22, AS-23, AS-26, AS-28, AS-30, AS-42) use `Promise.all` and assert the invariant on persisted state (one document, one task, one claim, one winner).
- Idempotent replay rows: AS-21, AS-23, AS-26, AS-41, AS-42, AS-50, AS-51. Illegal transitions: AS-23, AS-30. Cross-tenant: AS-19, AS-20, AS-28, AS-31, AS-35 – AS-38, AS-40. Limits: AS-17, AS-24, AS-32, AS-33, AS-07. Timeouts: AS-09, AS-46, AS-48. Consumers: AS-25 – AS-27 (queue), AS-50 – AS-52 (events), each with duplicate and invalid-payload cases (VII.4).
- Existing specs to migrate: `knowledge.e2e-spec.ts` (10 tests) is split across ASK, DOCS, INGEST and RETRIEVE; `domain/chunker.spec.ts` keeps the chunker tests and loses the RRF block, which moves to `domain/rrf.spec.ts`.
- Pattern rows: P0308 → AS-43, AS-45, AS-46; P1114 → AS-44 (unit) and AS-43 (end to end).
