# SD-43 — "Ask This Product" & Seller Help Center (RAG)

Status: ☑ done (typechecked; specs written, not run) · Phase 7 · Depends on: F-02 (pgvector, S3), SD-27 (ingestion), SD-42, SD-02 (permissions) · Extends README #17 (k-NN)

## Marketplace adaptation
Buyers ask questions about a product ("does it support eSIM?") answered from manuals, spec sheets, seller FAQ and Q&A threads — **with citations**. Shops get a private help center over **their own** documents (supplier contracts, policies) that other shops must never see.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Ingestion: upload/URL → SQS → parse (PDF → text) → **structure-aware chunking** (headings, 300–800 tokens, overlap, heading path kept) → batched embeddings → **pgvector** (HNSW index) | 10/10 #43 |
| Content-hash skip for unchanged docs; delete chunks of deleted docs (events) | 10/10 #43 |
| **Hybrid retrieval**: pgvector kNN + Postgres FTS (BM25-like `ts_rank_cd`) merged by **reciprocal rank fusion**, optional reranker | 10/10 #43 |
| **Permissions inside the query**: `WHERE (visibility='public' OR shop_id = :shopId)` in the same SQL as the vector search — never post-filter | 10/10 #43, 05/02 §7 |
| Answer only from context, cite chunk IDs, "not found" below similarity threshold | 10/10 #43 |
| Evaluation harness: golden questions → expected source docs, retrieval recall@k script | 10/10 #43 |
| Embedding provider port (Voyage / OpenAI-compatible / local) + fake deterministic embedder for tests | D9 |

## Steps
- [x] Migration: `KnowledgeDocument`, `KnowledgeChunk(embedding halfvec(1024), tsv tsvector)` + HNSW + GIN indexes (Q66).
- [x] Ingestion worker (SQS), chunker (pure, unit-tested), embedder port.
- [x] Retriever (hybrid + RRF — pure fusion function unit-tested), answer service via the SD-42 provider port with citations.
- [x] e2e (hashing embedder / scripted LLM): shop A's private doc never retrieved for shop B; answer cites the right chunk.

## Scale
- Target: 10M chunks, 2k questions/s.
- Hot path: one SQL query (HNSW + filter) on **read replicas**; embeddings of questions cached by hash.
- First bottleneck: HNSW memory (~10M × 1024 dims × 4 B = 40 GB) → halfvec (2 B) or quantisation, partition by visibility/shop; beyond 50M → dedicated vector DB (ADR).

## Implementation notes (2026-10-02)
- **Where:** `libs/common/src/knowledge/`.
  - `KnowledgeModule` (document management + answers) runs in core; `KnowledgeWorkerModule` (SQS `knowledge-ingest`, DLQ after 5 receives) runs in the worker.
  - The LLM comes from the shared `LlmModule` (SD-42 port), and metering goes through the shared `LlmMeter` (purpose `rag`).
- **Documents:** markdown inline, or PDF through a presigned PUT pinned to the declared SHA-256 and size, then `…/uploaded` → QUEUED.
  - **Idempotency:** the same bytes in the same scope are the same document (partial unique index on the content hash, race loser returns the winner). An ingest of an already-indexed hash is a no-op (`indexedHash`).
  - **Delete:** status and chunks change in one transaction, so a deleted document is unsearchable as soon as the call returns.
- **Parsing:** `unpdf` (pdf.js) per page (verified locally on a generated two-page PDF). A section never spans pages, so citations can name the page.
  - Poison input (not a PDF, unparseable, no text, > 2000 chunks) → FAILED, no SQS retry. Embedding-provider errors are rethrown for SQS retry.
- **Chunker** (`chunker.ts`, pure):
  - **Sections:** markdown headings outside code fences; numbered and ALL-CAPS heading lines in PDFs.
  - **Packing:** ~300-800 tokens from paragraphs → sentences → character slices, with ~80-token overlap.
  - **Small sections:** tiny sibling sections (FAQ entries) are merged under their parent heading.
  - **Heading path:** embedded and indexed with the chunk (FTS weight A).
  - Verified locally; it found and fixed a lowercase-heading miss ("1.1 eSIM support").
- **Embeddings:** an `Embedder` port with Voyage (`voyage-3.5`, 1024 dims, `input_type` document/query, batches of 128, backoff + jitter) and a deterministic feature-hashing embedder for e2e and keyless dev. Query embeddings are cached in Redis by normalized-question hash.
- **Retrieval:** ONE round trip that runs two candidate queries, HNSW kNN and `websearch_to_tsquery` + `ts_rank_cd`, each with the scope filter **inside** the SQL.
  - **Filtered HNSW:** `hnsw.iterative_scan = relaxed_order` keeps selective filters from starving top-k.
  - **Fusion:** RRF (`rrf.ts`, pure, k = 60).
  - **Similarity floor:** vector hits below `rag_min_similarity` count only if FTS also found them, so an off-topic question returns nothing.
- **Scopes:**
  - Product (buyers): that product's public docs + the shop's public product-less docs.
  - Shop help center (members): platform articles + the shop's public and private docs.
  - Platform articles are created by admins.
- **Answers:** chunks go to Claude as **`search_result` blocks with citations enabled**, so the API returns which result supports each sentence (`search_result_location` → our `sources[n]`), with no parsing of "[1]" markers.
  - Frozen, cached system prompt: answer only from results, say when not found, treat documents as data.
  - Effort `low`, no tools.
  - Nothing retrieved → `not_found` **without a model call**.
  - SSE straight to the response (`sources` → `text`… → `done {citations}`). A client disconnect aborts the provider call. Short answers, so no resume buffer (Q69).
  - Rate limits: `rag.ask` (10/min per user or IP) + the fleet-wide provider TPM bucket.
- **Eval harness:** `pnpm rag:eval <golden.json> [k]` reports recall@k + MRR over golden questions (retrieval only, no LLM cost) and exits 1 below `RAG_EVAL_MIN_RECALL` (CI gate). `scripts/rag-eval/golden.example.json` shows the format.

## Test plan
| Scenario | API e2e (`knowledge.e2e-spec.ts`) | UI journey (web / mobile) | Unit |
|---|---|---|---|
| Markdown → chunks with heading paths, embeddings, FTS | "markdown → structure-aware chunks…" | — | `chunker.spec.ts` |
| PDF pages + numbered headings → page-aware chunks | "PDF: pages and numbered headings…" | web (seller): upload a PDF manual, see it READY (happy path) | `chunker.spec.ts` |
| Corrupt PDF → FAILED once, no retry storm | "a corrupt PDF…" | — | — |
| Same bytes twice → one document; redelivery no-op | "content-hash idempotency…" | — | — |
| Shop B never retrieves shop A's private docs; buyers never see private/platform docs | "permissions are inside the query…" | — | — |
| FTS finds exact model numbers even with vector hits filtered out | "hybrid retrieval…" | — | `chunker.spec.ts` (RRF) |
| Ask this product → sources, streamed text, citations to the right chunk | "ask this product…" | web + mobile: ask on the product page, answer with source chips (happy path) | — |
| Nothing relevant → not_found without a model call | "nothing relevant retrieved…" | — | — |
| Deleted document disappears immediately | "a deleted document…" | — | — |
| Membership / product-ownership checks over HTTP | "HTTP: only members…" | — | — |
