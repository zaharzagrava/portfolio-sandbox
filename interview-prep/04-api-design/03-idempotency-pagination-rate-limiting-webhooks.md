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

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): The Payment row is created with ON CONFLICT ("idempotencyKey") DO NOTHING and then read back, so retried or duplicate messages share one row, enforced by a unique constraint. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [`RefundPaymentIntent`](../../packages/payments/internal/stripe/stripe.go#L123): RefundPaymentIntent sends an idempotency key to Stripe, so the external call is idempotent too. _(stripe.go)_
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

### Consuming webhooks
- Verify the signature over the **raw body**. Parsing JSON first and re-serializing changes the bytes; in Nest, enable `rawBody: true`.
- Use **constant-time comparison** (`crypto.timingSafeEqual`).
- **Respond 2xx fast** and process asynchronously (put it on a queue). Providers time out after a few seconds.
- **Idempotent processing**: store processed `event.id`s (unique constraint).
- Don't trust the payload completely. For critical actions, re-fetch the object from the provider's API.

```ts
function verify(rawBody: Buffer, header: string, secret: string) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new Error('stale');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
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

---

## Interview Q&A

**Q: How do you make POST /payments safe to retry?**
A client-supplied `Idempotency-Key`. The server atomically claims the key (unique constraint), stores a request fingerprint, executes, stores and replays the response, returns 409 for concurrent duplicates and 422 for key reuse with a different body, and the key expires after 24 h. Downstream calls to the bank carry our own reference so the bank dedupes as well. A reconciliation job covers the crash window.

**Q: Offset vs cursor pagination?**
Offset is simple but degrades linearly with depth and skips or duplicates rows while data changes. Keyset/cursor pagination uses an index seek on `(sort_key, id)` and stays stable. Use offset for small admin tables and cursors for feeds, APIs, and syncs.

**Q: How do you handle third-party rate limits when syncing data?**
A shared distributed limiter (Redis-backed) so every worker respects one budget, honoring `Retry-After`, exponential backoff with jitter for retryable errors, queue-based work distribution with checkpointed cursors, bulk and incremental endpoints to cut call volume, and metrics and alerts on 429 rate and sync lag.
