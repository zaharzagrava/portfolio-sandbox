# Idempotency, Pagination, Rate Limiting, Webhooks, Third-Party Integrations

---

## 1. Idempotency keys (critical for payments)

Problem: a client sends `POST /payments` and the response is lost (timeout). It retries. Without protection, the payment is **charged twice**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [idempotency](../../docs/humans/concepts/platform-idempotency/idempotency.md): The platform/idempotency module is a NestJS interceptor that handles retries via the Idempotency-Key header backed by Redis.
> - [Insert that silently skips when the idempotency key already exists](../../docs/humans/concepts/domain-payments/insert-on-conflict-do-nothing.md): executePayment begins with a raw SQL insert that creates the PENDING Payment row and silently skips it if the idempotency key already exists, so a retried request cannot charge twice. [`executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L53)
<!-- theory-links:end -->

### Protocol (Stripe-style, also an IETF draft `Idempotency-Key` header)
```
POST /payments
Idempotency-Key: 6f1c2a1e-...   (client-generated UUID per logical operation)
```
Server behavior:
1. First request with the key: **atomically claim** the key, execute, store the response, and return it.
2. Same key, same request fingerprint, completed: **replay the stored response** (same status and body).
3. Same key while the first request is still processing: **409 Conflict** (or wait).
4. Same key with a **different body**: **422** (key reuse is a client bug).
5. Keys expire after some TTL (e.g. 24 h).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`IdempotencyInterceptor`](../../packages/backend/libs/infrastructure/idempotency/idempotency.interceptor.ts#L30): IdempotencyInterceptor claims the Idempotency-Key in Redis, replays the stored response, returns 409 for in-flight duplicates and 422 for a different body. _(idempotency.interceptor.ts)_ · [idempotency](../../docs/humans/concepts/platform-idempotency/idempotency.md)
<!-- theory-links:end -->

### Implementation (Postgres)
```sql
CREATE TABLE idempotency_keys (
  key text NOT NULL,
  client_id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','completed')),
  response_code int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, key)
);
```
```ts
async function idempotent(clientId: string, key: string, reqHash: string, exec: () => Promise<Resp>) {
  const inserted = await db.query(
    `INSERT INTO idempotency_keys (client_id, key, request_hash, status) VALUES ($1,$2,$3,'processing')
     ON CONFLICT DO NOTHING RETURNING key`, [clientId, key, reqHash]);
  if (inserted.rowCount === 0) {
    const row = await db.one(`SELECT * FROM idempotency_keys WHERE client_id=$1 AND key=$2`, [clientId, key]);
    if (row.request_hash !== reqHash) throw new UnprocessableError('Idempotency key reused with different payload');
    if (row.status === 'processing') throw new ConflictError('Request in progress');
    return { code: row.response_code, body: row.response_body };      // replay
  }
  try {
    const resp = await exec();                                           // ideally in same tx as business writes
    await db.query(`UPDATE idempotency_keys SET status='completed', response_code=$3, response_body=$4
                    WHERE client_id=$1 AND key=$2`, [clientId, key, resp.code, resp.body]);
    return resp;
  } catch (e) {
    await db.query(`DELETE FROM idempotency_keys WHERE client_id=$1 AND key=$2`, [clientId, key]); // allow retry
    throw e;
  }
}
```
Subtle points:
- When the business writes are in the same DB, **store the key in the same transaction**, so the key and the side effects commit together.
- When the side effect is **external** (calling the bank), you need the external system to be idempotent too: pass your own ID as their idempotency/reference key. Otherwise you need a reconciliation step for the "did the bank execute it before we crashed?" window.
- Natural idempotency is even better: `UNIQUE(external_reference)`, or `PUT /payments/{clientGeneratedId}`.
- As middleware: read the `Idempotency-Key` header, scope it per user, fingerprint the request (hash of method + path + body), claim, run the handler, capture status and body, store them, replay on repeats. The claim must be a single atomic insert-if-absent (`ON CONFLICT DO NOTHING`, Redis `SET NX`), so two concurrent retries can't both run the handler. Drill: [node-42](../practice/live-coding/02-nodejs.md#node-42).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): The Payment row is created with ON CONFLICT ("idempotencyKey") DO NOTHING and then read back, so retried or duplicate messages share one row, enforced by a unique constraint. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [Finding and dispatching stuck payments](../../docs/humans/concepts/domain-payments/resolve-method.md): A scheduled job settles payments stuck in UNKNOWN by querying Stripe by idempotency key, which serves as the reconciliation step for external side effects. [`PaymentResolutionJobs`](../../packages/backend/libs/domains/payments/infra/payment-resolution.jobs.ts#L29)
<!-- theory-links:end -->

---

## 2. Pagination

| Type | How | Pros | Cons |
|---|---|---|---|
| Offset | `?limit=50&offset=1000` | simple, jump to page N | slow on deep pages (DB scans & discards), duplicates/skips when data changes |
| **Cursor / keyset** | `?limit=50&cursor=eyJjcmVhdGVkQXQiOi...` | O(log n), stable under inserts | no random page jumps; needs a unique, sortable key |
| Page token (opaque) | server-defined token | can change implementation | — |

- Make cursors **opaque** (base64-encoded JSON, ideally signed/HMAC'd so clients can't tamper with or depend on the internals).
- Sort must be **deterministic**: always add a unique tiebreaker (`ORDER BY created_at DESC, id DESC`).
- Response shape: `{ data: [...], nextCursor: "...", hasMore: true }`. Avoid `totalCount` on huge tables or make it approximate.
- Client side, hide the cursor loop behind an async generator so callers just `for await` over items: [async generators](../01-javascript-typescript/04-fetch-axios-async.md#10-async-generators-and-for-await).
- For syncing ("give me everything changed since X"), use an `updated_since` cursor with care: clock skew and long-running transactions can commit rows with older timestamps **after** you've read past them. Use an overlap window or a monotonic sequence (a change log table with a bigserial).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ApiList`](../../packages/backend/libs/domains/developer-platform/application/public-catalog.service.ts#L25): ApiList is the paginated response wrapper with a data array, a has_more flag and a keyset cursor. _(public-catalog.service.ts)_
> - [`Page`](../../packages/backend/libs/domains/catalog-sync/domain/provider.port.ts#L18): The Page interface returns items plus an optional nextCursor for provider listing. _(provider.port.ts)_
<!-- theory-links:end -->

---

## 3. Rate limiting (as provider)

### Algorithms
| Algorithm | Behavior | Notes |
|---|---|---|
| Fixed window | N per calendar minute | 2N burst at window boundary |
| Sliding window log | exact, timestamps in ZSET | memory O(N) per client |
| Sliding window counter | weighted current+previous window | good approximation, cheap |
| **Token bucket** | capacity B, refill R/s; allows bursts up to B, average R | most common for APIs (AWS API Gateway, Stripe) |
| Leaky bucket | queue drained at constant rate | smooths output; adds latency |
| Concurrency limiter | max in-flight requests per client | protects against slow expensive calls |

**Token bucket implementation**: no timer; refill lazily from elapsed time on each call (a `setInterval` per bucket wastes CPU and drifts). O(1) time and memory per key.
```js
class TokenBucket {
  constructor(capacity, refillPerSec, now = Date.now) {
    Object.assign(this, { capacity, refillPerSec, now, tokens: capacity, last: now() });   // starts full
  }
  tryRemove(cost = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens < cost) return false;     // 429, Retry-After = (cost - tokens) / refillPerSec seconds
    this.tokens -= cost;
    return true;
  }
}
```
**Sliding window log**: per key, keep timestamps of accepted requests, drop those older than the window, allow if fewer than `limit` remain. Exact, but O(limit) memory per key:
```js
const recent = (log.get(key) ?? []).filter((ts) => ts > now - windowMs);
const allowed = recent.length < limit;
if (allowed) recent.push(now);
log.set(key, recent);
```
**Sliding window counter**: keep only the counts of the current and previous fixed windows and estimate `prev × (share of the previous window still inside the sliding window) + current`. In Redis that is two `INCR` keys with a TTL instead of a list per user.

Per-key state lives in a `Map` in one process (evict idle keys, or it grows forever) or in Redis with a Lua script across instances, so read-and-update is atomic. Drills: [node-27](../practice/live-coding/02-nodejs.md#node-27), [node-28](../practice/live-coding/02-nodejs.md#node-28). Throttle and debounce are different tools: [async patterns §11](../01-javascript-typescript/04-fetch-axios-async.md#11-debounce-and-throttle).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TOKEN_BUCKET`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L13): The TOKEN_BUCKET Lua script refills tokens at a set rate up to a capacity. _(lua.ts)_
> - [`SLIDING_WINDOW`](../../packages/backend/libs/infrastructure/rate-limit/lua.ts#L49): The SLIDING_WINDOW Lua script implements the weighted sliding window counter. _(lua.ts)_
> - [`RateLimiterService`](../../packages/backend/libs/infrastructure/rate-limit/rate-limiter.service.ts#L15): RateLimiterService enforces the distributed limits in Redis, with local caching and fallback modes. _(rate-limiter.service.ts)_
<!-- theory-links:end -->

### Dimensions
Per API key / user / IP / tenant / endpoint (expensive endpoints get lower limits), plus a **global** limit protecting the system. Use different tiers per plan.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RateLimitKeySource`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L2): RateLimitKeySource selects the bucketing dimension: IP, user, API key, shop, user-or-IP or email. _(rate-limit.types.ts)_
> - [`RateLimitPolicy`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts#L4): RateLimitPolicy defines the algorithm, limit, window and key source for each named policy. _(rate-limit.types.ts)_
<!-- theory-links:end -->

### Response
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Policy: "default";q=100;w=60
RateLimit: "default";r=0;t=12
```
(IETF `RateLimit` headers draft. Many APIs still use `X-RateLimit-Limit/Remaining/Reset`.)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RateLimitInterceptor`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.interceptor.ts#L25): RateLimitInterceptor enforces the policies and sets the standard rate-limit headers on responses. _(rate-limit.interceptor.ts)_
> - [`Domain_RateLimitedError`](../../packages/backend/libs/infrastructure/rate-limit/rate-limit.interceptor.ts#L11): The rate-limit error returns HTTP 429 with retry guidance. _(rate-limit.interceptor.ts)_
<!-- theory-links:end -->

### Where to enforce it
- Edge (Cloudflare, API Gateway, ingress) for coarse IP limits and DDoS protection.
- In the app with Redis for per-tenant or business limits (`@nestjs/throttler` with a Redis storage backend; the default in-memory store is per pod and wrong with multiple replicas).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RedisThrottlerStorage`](../../packages/backend/libs/infrastructure/rate-limit/redis-throttler.storage.ts#L21): RedisThrottlerStorage implements ThrottlerStorage on Redis, so the throttler limit is shared across replicas. _(redis-throttler.storage.ts)_
> - [edge-be](../../docs/humans/concepts/package-edge-be/edge-be.md): The edge-be Cloudflare Worker acts as the edge gateway for coarse limits.
<!-- theory-links:end -->

---

## 4. Consuming rate-limited third-party APIs

A structured approach for syncing with or calling third-party APIs that enforce rate limits:

1. **Know the limits**: documented quotas, response headers (`X-RateLimit-Remaining`), and per-endpoint costs.
2. **Client-side throttling**: a token bucket or concurrency limiter in front of the client, e.g. `bottleneck` (supports Redis clustering, so **all pods share one budget**) or `p-limit` for concurrency.
   ```ts
   const limiter = new Bottleneck({ reservoir: 100, reservoirRefreshAmount: 100, reservoirRefreshInterval: 60_000, maxConcurrent: 5,
     datastore: 'ioredis', clearDatastore: false, id: 'crm-api' });
   const getDeal = limiter.wrap((id: string) => crm.get(`/deals/${id}`));
   ```
3. **Honor `429` + `Retry-After`** exactly. Otherwise use **exponential backoff with full jitter**: `sleep(random(0, min(cap, base * 2^attempt)))`.
4. **Retry only what's safe**: idempotent reads and writes with idempotency keys. Retry on 429, 502/503/504, and network errors. **Don't retry** other 4xx responses.
5. **Reduce the number of calls**: bulk/batch endpoints, incremental sync (`modified_since`), webhooks instead of polling, caching reference data, and field selection.
6. **Decouple through a queue**: put sync tasks on SQS. Workers pull at the allowed rate, and failures go to a DLQ. A burst of work becomes a steady stream.
7. **Checkpointing**: persist the sync cursor/watermark after each page, so a crash resumes instead of restarting.
8. **Circuit breaker** around the provider, so a long outage doesn't fill the queue with doomed retries.
9. **Observability**: metrics for calls, 429s, remaining quota, and lag of the sync watermark behind "now". Alert on lag.
10. **Reconciliation**: periodic full comparisons catch whatever incremental sync missed (deleted records, missed webhooks).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`parseRetryAfter`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L129): parseRetryAfter converts the Retry-After header into a delay in milliseconds. _(resilient-http-client.ts)_
> - [`ResilientHttpClient`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L44): ResilientHttpClient makes outbound calls with retries, timeouts and tracing. _(resilient-http-client.ts)_
<!-- theory-links:end -->

---

## 5. Webhooks (as provider and consumer)

### Providing webhooks
- **Sign** payloads: `X-Signature: t=1696170000,v1=HMAC_SHA256(secret, t + "." + rawBody)`. Include a timestamp to stop **replay attacks** (reject anything older than about 5 minutes).
- **Retry** with exponential backoff for a day or more, then disable the endpoint and notify the owner.
- At-least-once delivery, so include an `event.id` for deduplication. Ordering isn't guaranteed, so include `created_at`/a sequence number, or send "thin" events that make consumers fetch the latest state.
- SSRF protection: customers supply the URLs, so block private IP ranges and metadata endpoints, and re-check after DNS resolution (DNS rebinding).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`signWebhook`](../../packages/backend/libs/domains/developer-platform/domain/signature.ts#L12): signWebhook signs the body with a timestamp and returns a Stripe-format signature header. _(signature.ts)_
> - [`WebhookDeliverer`](../../packages/backend/libs/domains/developer-platform/application/webhook-deliverer.service.ts#L41): WebhookDeliverer handles delivery, retries, circuit breaking and disabling unhealthy endpoints. _(webhook-deliverer.service.ts)_
> - [`RETRY_SCHEDULE_MIN`](../../packages/backend/libs/domains/developer-platform/application/webhook-deliverer.service.ts#L24): RETRY_SCHEDULE_MIN is the backoff schedule that escalates to 24-hour intervals. _(webhook-deliverer.service.ts)_
<!-- theory-links:end -->

### Consuming webhooks: the reliable receive pipeline
Assume the partner delivers **at-least-once, unordered, with limited retries**. Split receiving from processing:

```
Partner ──POST──► [1] Receiver (thin, always up)                     [2] Worker (polls the inbox table)
                   verify HMAC on raw body ──401 if bad              claim pending work: FOR UPDATE SKIP LOCKED
                   INSERT raw → webhook_events                       map + validate → domain model
                   ◄── 2xx only after the INSERT commits             one tx: dedupe + version-guarded upsert + mark done
                                                                     N fails → status=failed + alert
```
**Postgres is the queue here** ("transactional inbox"). Adding SQS between [1] and [2] would make the receiver do a **dual write** (DB insert + SQS send can't be one transaction), so you'd still need a DB poller to catch lost messages, and then the poller alone suffices. Add SQS / `LISTEN/NOTIFY` only as a latency optimization (wake-up doorbell), or put SQS *instead of* the table only if you don't need the raw log (you do, for audit). At high volume, API Gateway → SQS direct integration removes your code from the receive path.

| Concern | Mechanism | Common mistake |
|---|---|---|
| **Duplicates** | Two different keys, two jobs (see below): dedupe the **delivery** on the partner's event ID, `UNIQUE(partner_id, external_event_id)`, in the same tx as the business write; make the **business write** an upsert on the entity's natural key, `UNIQUE(partner_id, external_lease_id)`. No event ID → hash of the raw body | Relying on SQS FIFO dedup: its window is only **5 min**, partner retries span minutes to hours |
| **Out of order** | Per-entity **version guard**: `UPDATE … WHERE source_updated_at < $incoming` (or source sequence/version). Stale event → record it as `skipped_stale`, don't apply. Alternative: **thin event** → re-fetch current state from the partner API, so order no longer matters | Using *our* receive time, or SQS FIFO (the order is already broken before the message reaches us; FIFO can't fix sender-side reordering) |
| **Our downtime** | Ack (2xx) only after the raw event is durable. Partner retries cover short outages. Keep the receiver tiny and separate from processing, so a worker outage just lets unprocessed rows pile up in the inbox table. **Reconciliation job** (below) catches anything whose retries were exhausted | "SQS will store it": SQS sits *behind* your endpoint; if the endpoint is down nothing reaches SQS |
| **Proof / disputes** | Append-only **raw event log**: raw body bytes, headers, signature, `received_at`, processing status. Postgres table (partitioned by month) for recent, S3 (optionally Object Lock) for long retention. Also enables **replay** after a mapping bug | Adding Cassandra just for audit; storing only the mapped data, which loses what they actually sent |
| **Poison / bad data** | Validate against a schema at mapping time; failures go to DLQ / `status=failed` with the error. Alert on DLQ depth and on "no events from partner X in N hours" | Retrying invalid payloads forever |

**Event ID vs entity key (the two "keys")**
| | `external_event_id` | `external_lease_id` |
|---|---|---|
| Identifies | one **delivery/event** ("lease 42 changed at 10:05") | the **thing** (lease 42) |
| Who creates it | the **partner** (body `id`, or a header like `X-Event-Id`; Stripe: `evt_…`). Every retry of the same event carries the same ID | the partner's primary key for the record |
| Protects against | processing the *same event* twice | creating *two leases* when two different events (created, updated) both say "lease 42" |
| Not this | our own UUID or SQS `MessageId`: both are new on every retry, so they dedupe nothing | — |

**Why events arrive out of order (real causes)**: partner sends from parallel workers/threads; a failed delivery is retried minutes later while newer events succeed; their queue isn't ordered; load balancers + our own parallel consumers; a batch/backfill job replays old data. Example: `lease.updated(rent=1300)` fails at 10:00, `lease.updated(rent=1350)` succeeds at 10:01, the retry of the first lands at 10:05 → without a guard, rent goes back to 1300.

**Why the partner's `updated_at`/version, not ours**: only the source knows the true order of changes. Our receive time reflects network and retry delays, i.e. exactly the reordering we're trying to undo.

| | Timestamp (`updated_at`) | Per-entity sequence/version (1, 2, 3…) |
|---|---|---|
| Tells you which is newer | yes (ties and clock skew between their servers possible) | yes, exactly |
| Tells you **something is missing** | **no**: 10:00 then 10:07 says nothing about a 10:03 | **yes**: 1 then 3 ⇒ 2 is missing (if gapless) |
| Enough for | last-write-wins on full state | strict in-order processing |

**Can the partner manipulate the timestamp/version?** Yes, they control it, but they are already the source of truth for *their* data (they could just send a wrong rent directly), so it gives them nothing extra. The real risks are **bugs**, and the defenses are at the trust boundary:
- A timestamp far in the **future** (clock bug) would make that row "newest" forever and silently block every later update → reject/quarantine `updated_at > now + few min`.
- Keep both their time and our `received_at`; alert on large skew.
- **Know which source owns which fact**: a PMS is authoritative for *what is owed* (leases, rent charges, balances): accept it, but validate it (currency, decimal format, sane ranges, re-fetch before acting on big changes). It is **never** authoritative for *what was paid*: payment status comes only from our ledger + the PSP/bank/open-banking provider (their webhooks are verified separately and re-fetched before moving money).

#### Strict ordering: when events must be applied in sequence
Two kinds of events need different handling:
- **State events** ("lease 42 is now {rent: 1350, status: active}"): order can be made irrelevant. Upsert with a version guard (create and update collapse into one op), tombstone deletes with a version so a late update can't resurrect them, or thin event + re-fetch.
- **Transition / command / delta events** where each step has side effects ("lease created" → create rent schedule, "tenant moved out" → stop autopay, "rent += 50"): order **must** be enforced. Options, from most to least robust:

**Core truth: a consumer can't reconstruct an order the producer never recorded.** Strict ordering needs the partner to stamp each event with its position. Ask about it in requirements.

**Ordering scope**: events often touch several entities (lease + tenant + unit + charges), so a per-entity sequence isn't enough. Order by the **smallest scope that contains every entity an event can touch**, usually the **partner account** (one PMS customer). Serial per account, parallel across accounts. PMS volume per account is low (events/min), so serial is fine. Finer scope (per property) only if events never cross it.

**What the partner should stamp**: a **gapless per-account counter** (1, 2, 3…), e.g. their **changelog position**. A *changelog* is the partner's append-only log of every change (an outbox/change-log table with an increasing ID per account, or the DB's own write-ahead log); the *position* (offset) is the number of the entry, exactly like a Kafka offset: "change #1043 for account X". Two failure modes, and only a counter catches both:
- **Reordering**: #7 arrives before #6 → any increasing stamp detects it.
- **Gaps**: #6 never arrives (retries exhausted, partner bug) → only a **gapless** counter detects it. With timestamps, 10:00 → 10:07 looks complete even if 10:03 was lost.
| Stamp | Orders events | Detects gaps | Note |
|---|---|---|---|
| Gapless counter (changelog offset) | yes | **yes** | best; what TCP, Kafka offsets and DB replication (LSN) do |
| DB sequence / bigserial | yes (per DB) | no | Postgres sequences skip values on rollback |
| UUIDv7 / ULID / UUIDv6 | roughly (ms timestamp + random) | no | clock-based: skew between servers, ties within a ms; v8 = custom layout |
| `updated_at` | roughly | no | fine only for last-write-wins on full state |

**Real cases where order changes the outcome** (an upsert of the final state can't fix these, because each step has its own side effect, often moving money):
| Events (correct order) | Applied in the wrong order |
|---|---|
| `property.owner_changed` (new landlord, new payout account) → `rent.collected` | rent is paid out to the **old owner's** bank account |
| `tenant.payment_method_changed` → `autopay.enabled` | first autopay charge hits the **old/closed bank account** → failed payment, fees |
| `charge.posted $1300` → `charge.voided` → `charge.posted $1250` | void references a charge we don't have yet; balance and late-fee calculation wrong in between |
| `lease.notice_given` → `lease.notice_withdrawn` | we start move-out: stop autopay, release deposit, notify landlord, for a tenant who is staying |
| `tenant.moved_out(unit A)` → `tenant.moved_in(unit B)` → `charges.reassigned` (one transfer, 3 entities) | charges land on the old unit/lease; per-lease ordering can't even see this as one sequence |

**Approaches ranked** (say the first; know the rest as fallbacks):
| # | Approach | Needs from partner | Verdict |
|---|---|---|---|
| 1 | **Resequencer per partner account**: gapless counter, cursor per account, gap filler | gapless per-account counter (+ ideally an event API for gap fill) | **The answer.** Detects reordering and gaps, handles multi-entity events. Cost: head-of-line blocking per account |
| 2 | **Pull from the partner's API in order** (event list endpoint or `modified_since` polling); webhook only wakes the poller | a list endpoint sorted by change order | **Possible under limitations**, when webhooks carry no proper sequence. Latency = poll interval, rate-limit cost. A true changelog endpoint with a cursor is as strong as #1. `modified_since` is weaker: it returns **current rows, not changes**, so two edits between polls collapse into one and the transition is lost; same-timestamp rows can be skipped at page boundaries; their long-running transactions can commit rows with an older `updated_at` after your watermark passed it (needs an overlap); deletes are invisible. Perfectly fine when only the **final state** matters |
| 3 | **Resequencer per entity** (per-lease counter) | per-entity counter | **Worse.** Fine for single-entity events; breaks as soon as one event spans lease + tenant + unit |
| 4 | **Precondition check + delayed retry**: "update lease 42" before it exists → requeue with delay, DLQ after N | nothing | **Fallback only.** Timing-based, can't detect a missing middle event, wasteful at scale |
| 5 | **Derive our own domain events from state diffs** | a state API | **Fallback / reconciliation aid.** Misses intermediate states and multi-entity transitions |

#1 in detail (Enterprise Integration Patterns "Resequencer"). **We** put events back in order: every event is stored first whatever its seq, and the stored table + cursor act as the reordering buffer. Early events are **kept**, not dropped; only already-applied ones are dropped. Arrivals `1, 3, 4, 2` → apply 1; store 3, 4; when 2 arrives apply 2, 3, 4. Correctness lives in the DB, so no broker is needed: workers poll for accounts whose next event is present and claim one with `SKIP LOCKED`:
```
stream_cursors(partner_id, account_id, last_applied_seq)   -- locked: SELECT … FOR UPDATE
seq <= last          → already applied (duplicate), drop
seq == last + 1      → apply + advance cursor in one tx; then apply waiting seq+2, seq+3… in order
seq >  last + 1      → gap: keep it as 'waiting'
gap older than N min → fetch the missing range from the partner's event API; none → alert + full account resync
```
- "Drop if `seq ≤ last`" is the **standard** technique, not a hack: a TCP receiver discards segments it already acknowledged, a Kafka consumer resumes from its committed offset, a DB replica skips WAL records below its applied LSN.
- Trade-off to name yourself: **head-of-line blocking**. If #5 is missing, #6 and #7 of *that account* wait until #5 is filled; other accounts keep flowing. Monitor gap age per account.

On **our** side, processing must be one-at-a-time per ordering scope too (row lock on the cursor, FIFO group = account, or Kafka key = account).

**Reconciliation job**: the safety net for anything webhooks missed (retries exhausted, partner bug, our bug). Two kinds:
| | State reconciliation | Event reconciliation |
|---|---|---|
| Needs from partner | a state API: `GET /leases?modified_since=…` | an event log API: `GET /events?after=<cursor>` or by entity + seq range |
| How | page through changed records (watermark − overlap), compare versions; theirs newer → run the same version-guarded upsert **and** the state-diff logic (4) so side effects still fire | find gaps in our per-entity sequences, fetch exactly the missing events, feed them to the resequencer |
| Recovers | the latest state (intermediate events lost) | the full history, in order |
| Role of version/timestamp | decides which side is newer, so reconciliation never overwrites fresher webhook data with an older snapshot | sequence numbers reveal what's missing |
- Watermark: store the last successful `modified_since`, query with an overlap (minus a few minutes) for clock skew; the version guard makes the overlap harmless.
- A nightly **full** comparison (ids + versions, or hashes) catches deletes that `modified_since` doesn't report.
- **Alert on drift**: a non-zero diff means the real-time path is losing data; track it per partner.

**Mapping bug + replay**: a mapping bug is wrong translation from their schema to ours (parsing `"1,250.00"` as `1`, treating local time as UTC, mapping status `"ended"` to `active`). Because the raw payloads are kept, you fix the mapper and **re-run it over the stored raw events** (e.g. all of partner X since Tuesday) to correct the data, with no need to ask the partner to resend.

**S3 Object Lock**: WORM storage (write once, read many). It doesn't enable replay (any stored copy does); it makes the archive **tamper-proof**, which is what gives it value as evidence in a dispute or audit (SEC 17a-4, FINRA, financial record-keeping).
- Requires **bucket versioning**. Locks apply to an **object version**: an "overwrite" just creates a new version, a "delete" adds a delete marker, and the locked version stays intact and readable.
- **Retention period** = a *retain-until date* per object version, set explicitly or from a **bucket default** (e.g. 7 years). Until that date the version can't be deleted or overwritten. It **can be extended, never shortened** (in compliance mode). After it, normal deletes and lifecycle rules work again.
- **Governance mode**: protected from normal users, but principals with `s3:BypassGovernanceRetention` can delete or shorten retention. Use for testing your setup or internal policy.
- **Compliance mode**: **nobody** can delete the version or shorten retention until the date, **including the root account and AWS support**. A wrong 10-year setting means paying for that storage for 10 years (the only way out is closing the account). Test with governance mode first.
- **Legal hold**: an on/off flag with no expiry, used during **litigation** (a lawsuit or legal dispute, when data that may be evidence must not be destroyed: a "litigation hold"), independent of retention; anyone with `s3:PutObjectLegalHold` can remove it.

**Why not Cassandra for the event log**: the write load is small. Even thousands of webhooks per minute is tens of inserts per second; one Postgres instance handles thousands of inserts per second. Keeping the log in Postgres lets the dedupe insert, raw log and business write share one transaction. Cassandra adds a second datastore, no cross-store transactions and ops cost, worth it only at sustained very high write volumes (hundreds of thousands per second) or multi-region writes. Scale Postgres first with monthly partitions (drop or archive old ones to S3). Numbers: [datastore estimates](../10-system-design/01-system-design-framework.md#2-back-of-the-envelope-numbers).

- Verify the signature over the **raw body** (parsing then re-serializing changes whitespace and key order, so the bytes differ). In Express, `express.json()` has already consumed the body: use `express.raw({ type: 'application/json' })` on the webhook route (or `express.json({ verify })` to keep the buffer), verify, then parse. In Nest, `rawBody: true`.
- Compare with `crypto.timingSafeEqual` ([why](../05-security/02-authentication-authorization.md#0-crypto-building-blocks-hash-hmac-signature-encryption)). It throws if lengths differ, so check lengths first. The timestamp is part of the signed data, so it can't be changed, and the tolerance window blocks replays. Drill: [node-43](../practice/live-coding/02-nodejs.md#node-43).
- HMAC with a shared secret proves the payload came from someone holding the secret, but both sides hold it. For true non-repudiation you need **asymmetric signatures** (partner signs with a private key). In practice, raw log + HMAC + partner's own delivery logs settle disputes. HMAC vs signatures: [crypto building blocks](../05-security/02-authentication-authorization.md#0-crypto-building-blocks-hash-hmac-signature-encryption).
- Don't trust the payload for critical actions (payments, balances): re-fetch the object from the provider's API.
- If you do add SQS: **standard**, not FIFO. The consumer is idempotent and version-guarded anyway; FIFO (group = lease ID) only helps if the *source* order is trustworthy.

```ts
function verify(rawBody: Buffer, header: string, secret: string) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new Error('stale');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'); // bytes, not re-decoded text
  const a = Buffer.from(expected), b = Buffer.from(v1 ?? '');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`verifyWebhook`](../../packages/backend/libs/domains/developer-platform/domain/signature.ts#L18): verifyWebhook checks the signature with a timestamp and replay protection. _(signature.ts)_
> - [`IntegrationsController`](../../packages/backend/libs/domains/catalog-sync/api/integrations.controller.ts#L18): IntegrationsController receives webhook events from providers such as Shopify. _(integrations.controller.ts)_
> - [`ShopifyProvider`](../../packages/backend/libs/domains/catalog-sync/infra/shopify.provider.ts#L30): ShopifyProvider handles webhook verification and normalization for Shopify. _(shopify.provider.ts)_
<!-- theory-links:end -->

### Sending results back to the partner
The response to an incoming webhook is only a **receipt** (2xx = "stored"), never the business result, because processing is async. Results go back one of three ways:
| Way | How | When |
|---|---|---|
| **Write-back: we call their API** | outbox → worker → their API; our ID as their idempotency/reference key; retries with backoff + jitter; their rate limits (§4) | the PMS default, e.g. post a received rent payment into the tenant ledger in the PMS |
| **We send webhooks** | we become the provider (signing, retries, event IDs, per-account sequence numbers) | partner has an endpoint and wants push |
| **They poll us** (async request-reply) | `202 Accepted` + `Location: /operations/{id}` → they `GET` until done; or our `GET /events?after=cursor` feed | partner can't receive webhooks; same idea as a frontend polling job status |

---

## Interview Q&A

**Q: How do you make POST /payments safe to retry?**
A client-supplied `Idempotency-Key`. The server atomically claims the key (unique constraint), stores a request fingerprint, executes, stores and replays the response, returns 409 for concurrent duplicates and 422 for key reuse with a different body, and the key expires after 24 h. Downstream calls to the bank carry our own reference so the bank dedupes as well. A reconciliation job covers the crash window.

**Q: Offset vs cursor pagination?**
Offset is simple but degrades linearly with depth and skips or duplicates rows while data changes. Keyset/cursor pagination uses an index seek on `(sort_key, id)` and stays stable. Use offset for small admin tables and cursors for feeds, APIs, and syncs.

**Q: A partner sends webhooks with at-least-once, unordered delivery and 5 retries. Design the receiving side.**
Thin receiver: verify the HMAC on the raw body, persist the raw event to an append-only inbox table, and return 2xx only after the insert commits (the table is the queue: workers poll it with SKIP LOCKED). Worker: map and validate, then in one transaction insert `(partner_id, external_event_id)` for dedupe and upsert the entity guarded by the source's `updated_at`/version, so stale events are skipped. DLQ plus alerts for bad payloads. A reconciliation job polls the partner API for anything lost after retries ran out. The raw log is the audit trail for disputes and lets you replay after fixing a mapping bug. FIFO isn't needed: its 5-minute dedup window is too short, and it can't fix order the sender already broke.

**Q: What if events must be applied in order, e.g. "update lease" arrives before "create lease"?**
A consumer can't reconstruct an order the producer never recorded, so first ask what the partner stamps on events. Strict order needs a gapless counter per ordering scope; events touch several entities, so the scope is usually the partner account. Best: pull from their ordered event feed with a stored cursor (the webhook is just a wake-up). Otherwise a resequencer: cursor row per account, apply only `last+1`, drop `≤ last`, hold later ones, fill gaps from their event API after a timeout, else alert and resync. Serial per account, parallel across accounts. Full rehearsal: [practice/01](../practice/01-pms-webhook-ingestion.md).

**Q: Token bucket or sliding window?**
Token bucket when bursts are fine as long as the average holds (most public APIs): O(1) per key, refilled lazily from elapsed time. A sliding window log when the limit must be exact over any window (e.g. login attempts); it costs one timestamp per request. The sliding window counter approximates it with two counters. Plain fixed windows let a client send twice the limit around a window boundary.

**Q: How do you handle third-party rate limits when syncing data?**
A shared distributed limiter (Redis-backed) so every worker respects one budget, honoring `Retry-After`, exponential backoff with jitter for retryable errors, queue-based work distribution with checkpointed cursors, bulk and incremental endpoints to cut call volume, and metrics and alerts on 429 rate and sync lag.
