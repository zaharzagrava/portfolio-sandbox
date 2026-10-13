# Feature Roadmap (plain English)

**Goal:** Make the README showcases (#1–28) actually true in the code.

**Last refreshed:** 2026-08-09, against the real state of the repo (including uncommitted work: Product model, Elasticsearch, ClickHouse scaffolding).

**What exists today:** Edge worker (Cloudflare Worker, `edge-be/`) authenticates + idempotency-locks a payment via Redis, then drops it on Kafka. Nest consumes it, charges Stripe, writes payment + ledger + an Outbox row to Postgres. `GET /products/search` and an Elasticsearch index exist but nothing ever indexes a product into them. A bare ClickHouse client wrapper exists with no analytics logic behind it yet.

**Already done — skip these:**
- **#3 Idempotency** — duplicates don't double-charge (edge Redis lock + Postgres unique constraint)
- **#4 Ledger** — money always balances (debits = credits, bulk-created, validated)

**Numbering note:** the README was renumbered 1–28 to add Search/Edge/Client/Analytics categories. This doc now follows the README's numbering, not the old #1–24 scheme.

---

## Status (one line each)

| # | Name | Reality |
|---|------|---------|
| 1 | Outbox / fault tolerance | You **write** Outbox rows. **Nothing publishes them.** Worse than it looks: the `Outbox` table has **no `processed`/`published` column at all** (a later migration dropped it) — a drain worker can't even be written against the current schema. |
| 2 | Load test + observability | Tracing + k6 exist. No lag/error dashboards. |
| 3 | Idempotency | **Done.** |
| 4 | Double-entry ledger | **Done.** |
| 5 | Async command path | Edge→Kafka accept works. No `POST /payment` REST endpoint on Nest (ingestion is Kafka-only). Client never gets a "done" signal — no payment id returned synchronously, and `payments.responses` never gets published (blocked on #1). |
| 6 | Optimistic Concurrency Control | Schema-only. `Product.quantity`/`Product.version` columns exist, but **zero code reads or writes them** — no create/update/purchase endpoint exists anywhere in the backend. |
| 7 | CQRS | Half: writes happen (Kafka-async), but there's no real read model yet — see #13/#15 below, ES is unindexed. |
| 8 | Saga (multi-step + refunds) | **Not built.** Payment + ledger only; no inventory step, no compensating refund on failure. Blocked on #6 existing. |
| 9 | Circuit breaker | **Not built.** Stripe is called raw from `stripe.service.ts`, no breaker library in use. |
| 10 | Cursor pagination | **Not built.** No list/query method exists on the ledger service at all yet. |
| 11 | Table partitioning | **Not built.** No partition SQL in any migration. |
| 12 | Shared types / contracts | Decorators exist per-service. No shared Zod package between edge and Nest, no contract tests. |
| 13 | Fuzzy search | Code exists (`GET /products/search`), **but the ES index is empty** — seeds never index into it, nothing syncs Postgres→ES. Non-functional today. |
| 14 | Relevance scoring (BM25) | Same as #13 — query logic is written, but there's no data to rank. |
| 15 | Autocomplete | Same as #13 — suggester logic may exist in the ES service, unindexed. |
| 16 | Range filtering & faceting | Same as #13. |
| 17 | Semantic vector search (k-NN) | `Product.embedding` column exists; nothing generates or writes embeddings. |
| 18 | Graph recommendations | **Not built.** No purchase-link data model exists (needs #8's checkout flow first). |
| 19 | Edge ingress / auth | JWT verification works at the edge (jose). Validation is hand-rolled, not a shared schema (see #12). |
| 20 | Distributed rate limiting | Nest's `ThrottlerGuard` is global but **per-instance/local**, not Redis-backed. Edge does an idempotency lock, but **no rate limiting at the edge at all.** |
| 21 | Cache stampede prevention | **Not built.** Redis has **zero usage anywhere in `backend/src`** — fully greenfield. |
| 22 | Write-behind caching | **Not built.** Same as #21. |
| 23 | Stale-while-revalidate | **Not built.** Same as #21. |
| 24 | Real-time push (SSE) | **Not built.** No SSE/WebSocket endpoint exists; clients would have to poll `GET /payment/:id`. Blocked on #1/#6. |
| 25 | Checkout funnel (`windowFunnel`) | **Not built.** ClickHouse client wrapper only — no event schema, no migration, no query. |
| 26 | Unique payers (HyperLogLog) | **Not built.** Same as #25. |
| 27 | FX rate alignment (`ASOF JOIN`) | **Not built.** Same as #25 — also needs an FX-quote data source that doesn't exist yet. |
| 28 | Streaming aggregates (Kafka→ClickHouse MV) | **Not built.** Same as #25 — needs a Kafka→ClickHouse ingestion path (Kafka table engine or a consumer) that doesn't exist yet. |

**Most consequential finding:** the whole **Search & Discovery** section of the README (#13–18) currently demos nothing — the query-side code exists but there's no data in Elasticsearch. That's the smallest gap between "looks done" and "is done" of anything in the list.

---

## Work in these chunks

### Chunk A — Finish the payment story
**Features:** #1, #5, #9, #24

**The blunt problem for #1:** You have a mailbox (`Outbox`). You put letters in it (`notify()`). **You never hired a mailman**, and the mailbox doesn't even have a "was this letter sent" flag anymore. So when Kafka dies, letters sit in the box forever and you can't show "we didn't lose anything — we drained the box when Kafka came back."

**Do this:**

1. **Schema fix** — add back a `processed`/`publishedAt` column (+ index) to `Outbox` so a drain worker has something to query against.
2. **Mailman (outbox publisher)** — background job (cron or poll loop): read unpublished Outbox rows → send to Kafka → mark published. Add jitter to retry delays.
3. **Close the async loop (#5)** — return a payment id / idempotency key synchronously from the edge accept path; once the mailman exists, `payments.responses` messages actually get sent.
4. **Circuit breaker (#9)** — wrap the raw Stripe call; if Stripe is down, fail fast instead of hanging.
5. **Live status (#24)** — push payment succeeded/failed to the browser (SSE) instead of polling.

**Done when:** Kill Kafka → Outbox fills → restart Kafka → messages go out → client sees final status via SSE. Break Stripe → breaker opens.

---

### Chunk B — Products write path + OCC
**Features:** #6 (blocks #8, #18, and gives Chunk D something to index)
**Status:** Schema done, logic not started.

- `Product` model has `quantity`, `version`, `embedding` — but no create/update/purchase endpoint exists.
- Add a purchase/decrement endpoint doing a version-checked compare-and-swap (`WHERE version = :v`), returning 412 on conflict.
- This chunk is a prerequisite for #8 (saga needs a real inventory step) and for seeding real product-created events that Chunk D can index.

**Done when:** Two concurrent "buy last unit" requests → exactly one succeeds, the other gets 412; no negative stock possible.

---

### Chunk C — Edge polish
**Features:** #12, #19, #20

1. One shared Zod schema used by edge **and** Nest (stop hand-validating twice).
2. Rate limit at the edge with Redis (token bucket, works across many edge instances) — currently edge only does idempotency locking, no rate limiting exists there at all.
3. Optional: contract test so edge and backend can't drift.

**Done when:** Bad payload dies at the edge via shared schema; rate limits survive multiple edge instances.

---

### Chunk D — Make search real
**Features:** #13, #14, #15, #16, #17, #7 (CQRS half)
**Status:** Query side wired, **completely unindexed** — this is the "looks done but isn't" chunk.

1. Seed hundreds of products into Postgres (still TODO).
2. Build the Postgres→ES sync path — simplest option is indexing directly in the seed script plus an outbox/Kafka projection for ongoing writes (depends on Chunk A's mailman existing, or a simpler direct-write path if you want this sooner than Chunk A).
3. Wire embedding generation for #17 (semantic search) — needs an embedding source (local model or API call) written into `Product.embedding` at index time.

**Done when:** Typo search, autocomplete, filters, and similar-items all return real results against seeded data; new products show up in search within ~1s of being written.

---

### Chunk E — Caching on product reads
**Features:** #21, #22, #23
**Status:** Fully greenfield — Redis is currently unused anywhere in the backend.

| # | In plain English |
|---|------------------|
| 21 | When a hot product's cache expires, don't let 10k requests all hit the DB at once |
| 22 | View counters pile up in Redis, flush to DB in batches |
| 23 | Serve slightly stale data fast while refreshing in the background |

**Done when:** Cache miss storms don't melt Postgres; view spikes are batched; stale-but-fast reads work.

---

### Chunk F — Checkout under contention
**Features:** #8, #18 (builds on Chunk B's OCC)

| # | In plain English |
|---|------------------|
| 8 | Steps: pay → reserve stock → ledger. If stock fails after pay → refund |
| 18 | "People who bought this also bought…" from purchase links |

**Done when:** No negative stock; failed stock triggers refund; recommendations return something real.

---

### Chunk G — Big lists stay fast
**Features:** #10, #11

| # | In plain English |
|---|------------------|
| 10 | Scroll payment history with cursors (not "page 500" offset) |
| 11 | Split ledger table by month so old data doesn't slow hot queries |

**Done when:** Deep scroll stays fast; ledger is partitioned by time.

---

### Chunk H — Make the stress demo look real
**Features:** #2 leftovers

Add metrics for errors/latency/Kafka lag, a Grafana board, wire k6 into a simple command. Optional: chaos script that kills Kafka during load (proves Chunk A on camera).

**Done when:** One command runs load test + you can see lag/latency while chaos recovers via Outbox.

---

### Chunk I — ClickHouse analytics (new)
**Features:** #25, #26, #27, #28
**Status:** Fully greenfield — only a bare client wrapper exists (`clickhouse.service.ts`), no schema, no queries, no ingestion path.

Needs, roughly in order:
1. An event taxonomy + ClickHouse table(s) for funnel steps (`view`, `cart`, `checkout`, `paid`) — feeds #25.
2. A payer/event table with enough cardinality to make `uniqCombined` interesting — feeds #26.
3. An FX-quote source (even a fake/seeded one) to `ASOF JOIN` against payment timestamps — feeds #27.
4. A Kafka→ClickHouse ingestion path (Kafka table engine, or a consumer writing batches) plus a materialized view rolling up to minute/hour — feeds #28, and is the real dependency for #25/#26 having live data instead of a one-off seed script.

**Done when:** All four ClickHouse showcases return real numbers against data that arrived via the Kafka pipeline, not a manual seed.

---

## Order

1. **A** — payment reliability (schema fix + mailman + completion + breaker + SSE)
2. **B** — products write path + OCC
3. **D** — make search real (can start in parallel with A/B once seeding exists)
4. **C** — shared validation + edge rate limits
5. **E** — caches
6. **F** — OCC checkout + saga + recommendations
7. **G** — pagination + partitions
8. **I** — ClickHouse analytics
9. **H** — dashboards (parallel anytime after A)

---

## Not doing yet

- Full Next.js app (curl / tiny HTML is enough for demos)
- Debezium CDC (polling mailman is enough for the video)
- GraphQL BFF, Keycloak — later

---

## Next

Pick one chunk to brainstorm into a full design spec (`docs/superpowers/specs/`) and implementation plan. Candidates, by how close each is to a visible win:

- **D (make search real)** — smallest gap between "looks done" and "is done"; the fastest visible win.
- **A (outbox mailman)** — the project's headline demo (chaos/fault-tolerance) and the roadmap's original stated priority; needs a schema change first.
- **B (products write path)** — unblocks both D's ongoing sync and F's saga/OCC.
- **I (ClickHouse analytics)** — biggest scope, most greenfield, matches the newest work already in the tree.
