# README archive

Moved out of the root README when its feature list was rewritten as a problem index. The old numbered showcase sections (1–32) are in git history before this change.

# TODO

First batch:

- 🚦 20. Distributed Rate Limiting
- 🦬 21. Cache Stampede Prevention
- 📥 22. Write-Behind (Write-Back) Caching

- 🧪 25. Checkout Funnel Analytics (ClickHouse `windowFunnel`)
- 🎲 26. Unique Payers at Scale (HyperLogLog / `uniqCombined`)
- ⏱️ 27. FX Rate Alignment (ClickHouse `ASOF JOIN`)
- 📡 28. Streaming Aggregates (Kafka → ClickHouse Materialized Views)

Later:

- 🕸️ 18. Graph/Network Recommendations
- 🚀 12. End-to-End Type Safety & Contract Testing
- 🗄️ 11. Database Table Partitioning (Time-Series)
- ⏳ 23. Stale-While-Revalidate (SWR) Caching
- 📡 24. Real-Time Push (Server-Sent Events / SSE)

---

# Ideas

New ideas for the future:

- Code generator 6-digit without repetitions
- Groundcover logs search, how it's implemented
- Localisation
- feature flags, A/B testing
- continuous deploys
- notifications
- rbac system for merchant and user accounts, OAuth
- Immutable audit logging to track all entity state changes for strict financial and security compliance.
- Active Directory (AD) or SAML-based Enterprise SSO integration for corporate identity management.
- Master Data Management (MDM) architecture to maintain a single source of truth for core business entities across all microservices.
- Multi-region active-active database deployment to handle global traffic and cross-border latency.
- Advanced Order Management System (OMS) state-machine with multi-warehouse geospatial inventory allocation.
- Internal B2B billing engine for cross-department chargebacks and automated automated ledger reconciliation.
- Telephony (CTI) and SMS integration for real-time transactional alerts and customer support routing.


<a id="adr"></a>

# ADR (Architecture Decision Records)

This section explains the core design choices across the system in a logical chain of Questions and Answers.

### Edge Gateway & Caching

**Why do you use Cloudflare?**

Because it protects against DDoS attacks and saves money.

**Why does Cloudflare save money?**

Because Cloudflare Workers use V8 isolates which are very cheap to run with instant cold starts.

**How do you draw a line of what to put into a Cloudflare worker?**

Any stateless logic (like request validation, JWT authentication, and token bucket rate limiting) goes to the edge. This stops bad actors before they consume core API resources.

You cannot put everything on the edge, since cloudflare workers are very limited in CPU time and memory. Though edge compute is evolving rapidly, it is not yet mature enough to handle the complexities of a full-fledged application.

**Why use Redis at the edge?**

To maintain a shared state for distributed rate limiting and cache stampede prevention (using Redlock) across distributed Cloudflare workers.

**Why implement a Write-Behind cache? (TODO)**

To absorb massive spikes of low-value, high-frequency writes (like view counts). For example, updating a Redis counter on every request and flushing it to Postgres in bulk every 10 seconds prevents DB disk I/O bottlenecks.

**Why use Stale-While-Revalidate (SWR) caching? (TODO)**

To guarantee sub-50ms page loads. It serves slightly outdated data instantly while silently fetching fresh data in the background, masking all network/DB latency.

### Payments Platform & Reliability

**Why do you put writes into Kafka instead of a direct DB insert?**

To handle high loads and traffic spikes gracefully, instantly acknowledging user intent while the heavy processing finishes in the background.

**Why can't your main server handle it?**

Because compute instances don't scale instantly, and database connection pools could become exhausted during a spike.

**Why do you use the Outbox pattern alongside Kafka?**

To guarantee zero data loss. For example, if we insert a `Payment` record and publish a Kafka event, but Kafka is down, the event is lost. By inserting the `Payment` and an `OutboxEvent` in the _same Postgres transaction_, we guarantee atomicity. A separate worker picks up the outbox event and publishes it reliably.

**Why implement idempotency keys?**

To safely collapse identical request retries into a single execution. For example, if a user has a spotty network and double-clicks "Pay", the key ensures the database unique constraint collapses the second request, preventing a double-charge.

**Why use double-entry bookkeeping?**

To mathematically ensure money cannot be created or destroyed. Every transaction (which corresponds to a single `Payment` record, each connected to a set of `LedgerEntry` records) requires equal debit and credit entries, keeping strict financial auditability.

**Why use Optimistic Concurrency Control (OCC) instead of pessimistic locks? (TODO)**

To avoid deadlocks and maintain high throughput. We use a version column for inventory reservation, allowing thousands of reads but rejecting concurrent writes with HTTP 412 if the version changed mid-flight.

**Why physically separate read and write databases (CQRS)? (TODO)**

So the storefront (read-heavy, Elasticsearch) can scale infinitely for complex queries without affecting order processing (write-heavy, Postgres).

**Why use a Distributed Saga instead of 2-Phase Commits? (TODO)**

To manage multi-step workflows (e.g., Payment → Inventory → Ledger) across microservices without locking remote databases. If inventory fails, a compensating transaction automatically refunds the payment.

**Why implement the Circuit Breaker pattern? (TODO)**

To protect the main API from going down when 3rd parties (like Stripe) fail. Instead of waiting 30 seconds for a timeout and exhausting connection pools, the circuit "trips" and fails instantly.

**Why use Cursor-Based Pagination? (TODO)**

Standard offset pagination (`LIMIT 10 OFFSET 100000`) crawls to a halt on deep pages. Cursors ensure consistent $O(1)$ query time regardless of page depth.

**Why use Database Table Partitioning? (TODO)**

Massive append-only tables (like ledgers) slow down over time. Slicing them into physical monthly chunks keeps recent data queries fast and makes data deletion effortless (dropping a partition).

**Why use Zod/TypeBox end-to-end? (TODO)**

To guarantee API contract safety. It ensures the frontend, backend, and DB migrations never drift out of sync, preventing silly integration bugs during refactors.

### Search & Discovery (TODO)

**Why use Elasticsearch instead of Postgres for product search?**

Because Elasticsearch natively supports fuzzy search, relevance scoring (BM25), and fast faceting which Postgres struggles with at scale.

**Why is fuzzy search important?**

It gracefully handles user spelling mistakes (edit distance), massively boosting conversion rates by preventing "zero-result" dead ends.

**Why use Edge N-Grams for Autocomplete?**

It predicts exact search results keystroke-by-keystroke, guiding users to known inventory before they even hit "Enter", offloading heavier fuzzy queries.

**Why use Semantic Vector Search (k-NN)?**

To find related items by _meaning_ rather than exact keyword matches (e.g., searching "winter coat" finds "cold weather jacket").

**Why implement Graph Recommendations?**

To map non-obvious relationships (e.g., "Users who bought X also bought Y") using instantaneous adjacency list lookups instead of expensive SQL `JOIN` avalanches.

### Observability & Analytics (TODO)

**Why use k6 with OpenTelemetry?**

To inject massive synthetic load while tracking distributed traces. It identifies queue backpressure, p99 latency guarantees, and DB limits before live users do.

**Why use ClickHouse for analytics?**

It uses columnar storage and vectorized execution, allowing for massive data aggregations and window functions without choking the transactional DB (Postgres).

**Why use the `windowFunnel` function in ClickHouse?**

To measure conversion drop-off (homepage → cart → checkout → paid) sequentially within strict time windows without slow multi-table self-joins.

**Why use HyperLogLog for unique counts?**

Because it answers "how many unique payers?" using probabilistic sketches with tiny memory overhead, preventing Out-Of-Memory (OOM) errors during COUNT DISTINCT storms.

**Why use ClickHouse `ASOF JOIN`?**

To accurately attach each payment to the most recent FX rate valid _at or before_ the transaction timestamp, which is critical for tick-level financial data alignment.

**Why stream Kafka directly into ClickHouse Materialized Views?**

To compute minute/hour rollups in-flight for sub-second dashboard freshness, writing only the aggregates to disk and bypassing Postgres entirely.

**Why use Real-Time Push (SSE)?**

To eliminate database polling. Instead of the UI asking "Is it done yet?" every second, the server pushes a message the exact millisecond a background job finishes.

### Realtime Chat & WebSocket Gateway

**Why is chat split between NestJS and a separate Rust service instead of just doing it all in NestJS?**

Because the two halves have completely different latency/resource profiles. Channel creation, moderation actions, and history reads are ordinary low-volume request/response work — NestJS is fine there. Holding tens of thousands of WebSocket connections open and fanning out messages to them is a different problem: Node's event loop and GC pauses become the bottleneck long before Rust's would. So the connect/subscribe/send hot path moved to Rust; everything else stayed in NestJS.

**Why one WebSocket connection per client instead of one per channel?**

Browsers and OS file descriptors both have real per-connection overhead. A user subscribed to 20 product chats would otherwise open 20 sockets. Instead, one socket carries `subscribe`/`unsubscribe`/`send` frames naming the channel, the same way Discord's own gateway multiplexes every server and DM a client is in over a single connection.

**How does a message sent to one gateway instance reach a client connected to a different instance?**

Through Redis pub/sub as the cross-instance backplane. The instance that receives a `send` writes the message to Postgres, then publishes it to that channel's Redis topic. Every gateway instance with a local subscriber for that channel is listening on the same topic and rebroadcasts to its own connections — including the sender's, which is what it means for the sender to see their own message the same way everyone else does, rather than getting a special-cased direct echo.

**Why does an instance only subscribe to Redis for channels it actually has a local listener for?**

To avoid a fleet of N gateway instances each paying the subscription cost of every channel that has ever existed, most of which have zero currently-connected users. Ref-counting local subscribers (via `broadcast::Sender::receiver_count()`) means Redis subscription cost tracks actual concurrent interest, not total channel count.

**Why maintain a membership cache at all if moderation actions are pushed over pub/sub?**

Because the cache is the fast path (avoids a Postgres round-trip on every single message send), and the pub/sub push is what keeps it _correct_ under revocation — the cache's short TTL is only a backstop for the rare case a gateway instance misses the eviction message (e.g. mid-reconnect to Redis), not the primary mechanism a ban relies on.

**Why not just put the browser's normal access token in the WebSocket URL?**

Because URLs get logged — by reverse proxies, browser history, server access logs — and a long-lived credential sitting in plaintext logs is a real leak surface. Minting a 60-second, purpose-scoped ticket (carrying a claim a normal access token doesn't have, so the two can't be swapped for each other) bounds the blast radius of that URL ending up somewhere it shouldn't.

## Cases that didn't make it into the code

### Sorting Boundary

I initally wanted to filter `Payment` table by `userId` inside `BisOrder` table, and add a query like this for a history of transactions:

```sql
SELECT * FROM "Payment"
  INNER JOIN "BisOrder" ON "Payment"."bisOrderId" = "BisOrder"."id"
WHERE "BisOrder"."userId" = :userId AND "Payment"."id" < :cursorId
ORDER BY "Payment"."id" DESC
LIMIT 10;
```

But I realized this is not efficient and may lead to performance issues when the `BisOrder` table grows large, so I decided to add a `userId` column to the `Payment` table and filter by `userId` directly.
