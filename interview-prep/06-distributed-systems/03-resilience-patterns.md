# Resilience Patterns: Timeouts, Retries, Circuit Breakers, Bulkheads, Load Shedding

Core principle: **in a distributed system, dependencies will be slow or down. Design so one slow dependency can't take the whole system with it.**

---

## 1. Timeouts (the most important and most often missing one)

- **Every** network call needs a timeout: HTTP, DB queries, Redis, queue operations, DNS.
- Without one, a hung dependency holds sockets, memory, and DB connections. Requests pile up, the event loop and pools saturate, and the whole service fails (cascading failure).
- Kinds: **connect timeout** (short, ~1–3 s), **request/read timeout** (based on the dependency's p99.9 latency plus margin), **overall deadline** for the user request.
- **Deadline propagation**: when the user request has 2 s left, downstream calls get `min(own timeout, remaining budget)`. gRPC propagates deadlines natively. Over HTTP, pass a header such as `X-Request-Deadline`.

```ts
const res = await fetch(url, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(1500)]) });
// pg: statement_timeout per role/connection; pool acquire timeout (connectionTimeoutMillis)
// ioredis: commandTimeout
```
- Choose timeouts from **measured latency distributions**, not guesses, and revisit them.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ResilientHttpClient`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L44): ResilientHttpClient applies connect/request timeouts, retries and connection pooling to outbound HTTP calls. _(resilient-http-client.ts)_
> - [`HttpRequestOptions`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L7): HttpRequestOptions carries the per-request timeout and abort signal that every call is configured with. _(resilient-http-client.ts)_
> - [`ProductPageService`](../../packages/backend/libs/composition/bff/product-page.service.ts#L29): ProductPageService fans out to core with a per-section timeout and AbortSignal so a slow section cannot hang the page. _(product-page.service.ts)_
<!-- theory-links:end -->

---

## 2. Retries done right

- Retry only **transient** failures: timeouts, connection resets, 502/503/504, 429 (honor `Retry-After`), DB serialization or deadlock errors.
- Retry only **idempotent** operations, or ones made idempotent with keys.
- Use **exponential backoff with jitter**. Without jitter, all clients retry in sync, which is a thundering herd.
  ```ts
  // "Full jitter" (AWS Architecture Blog)
  const delay = Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
  ```
- **Cap attempts** (2–3 for synchronous user requests; more for async jobs).
- **Retry amplification**: when each of 4 layers retries 3 times, one failure turns into 3^4 = 81 calls to the bottom service. Retry at **one layer** (usually the closest to the failing dependency, or the edge), and use **retry budgets**: retries limited to, say, 10% of the request volume (Envoy, Finagle).
- Don't retry when the dependency is overloaded, because that makes it worse. Combine retries with a circuit breaker.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`fullJitterBackoff`](../../packages/backend/libs/common/core/backoff.ts#L11): fullJitterBackoff computes a random delay in [0, min(max, base*2^attempt)] to avoid synchronized retries. _(backoff.ts)_
> - [`parseRetryAfter`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L129): parseRetryAfter converts the Retry-After header (seconds or date) into a delay that the retry logic honors. _(resilient-http-client.ts)_
> - [`HttpRequestError`](../../packages/backend/libs/infrastructure/http-client/resilient-http-client.ts#L25): HttpRequestError carries the status code and a retryable flag so only transient failures are retried. _(resilient-http-client.ts)_
<!-- theory-links:end -->

---

## 3. Circuit breaker

States:
```
CLOSED ──(failure rate > threshold in window)──► OPEN ──(after cooldown)──► HALF-OPEN
   ▲                                                                          │
   └──────────────(trial requests succeed)────────────────────────────────────┘
                   (trial fails) → back to OPEN
```
- **Open**: fail fast (or fall back) without calling the dependency. That saves resources and gives the dependency time to recover.
- Configure a minimum request volume, a failure rate threshold (e.g. 50% over 10 s), slow-call counting (latency above X counts as a failure), and the cooldown.

```ts
import CircuitBreaker from 'opossum';
const breaker = new CircuitBreaker(callBankApi, {
  timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30_000, volumeThreshold: 20,
});
breaker.fallback(() => ({ status: 'queued' }));       // degrade: queue the operation
breaker.on('open', () => metrics.inc('cb_open', { dep: 'bank' }));
```
- Keep breakers **per dependency** (and sometimes per endpoint or host). Breaker state is per pod, which is fine.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Client`](../../packages/payments/internal/stripe/stripe.go#L50): The Go Stripe Client wraps Stripe API calls in a circuit breaker configured through NewClient. _(stripe.go)_
> - [`StripeService`](../../packages/backend/libs/infrastructure/stripe/stripe.service.ts#L16): StripeService (NestJS) applies a circuit breaker around Stripe payment operations. _(stripe.service.ts)_ · [stripe](../../docs/humans/concepts/platform-stripe/stripe.md)
> - [`Domain_CircuitBreakerOpenError`](../../packages/backend/libs/infrastructure/stripe/stripe.errors.ts#L4): Domain_CircuitBreakerOpenError is the fail-fast error raised when the Stripe breaker is open. _(stripe.errors.ts)_ · [stripe](../../docs/humans/concepts/platform-stripe/stripe.md)
<!-- theory-links:end -->

---

## 4. Bulkheads

Isolate resources so one failing area can't use up everything:
- **Separate connection pools / concurrency limits per dependency**: the slow reporting DB can't take the connections the payments path needs.
- **Separate deployments** for different workloads: API pods vs worker pods vs report pods, each with its own scaling and resource limits.
- **Separate queues** per priority or tenant, so a big tenant's backfill doesn't starve everyone else.
- In Node: a `p-limit` style semaphore per dependency.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobHandlerOptions`](../../packages/backend/libs/infrastructure/jobs/job-handler.decorator.ts#L6): JobHandlerOptions sets lease time and concurrency limits per job handler, bounding concurrency for each workload. _(job-handler.decorator.ts)_
> - [`NotificationWorkers`](../../packages/backend/libs/domains/notifications/infra/notification-workers.service.ts#L25): NotificationWorkers consume separate SQS queues with their own rate limiting, isolating notification channels. _(notification-workers.service.ts)_
> - [`ChannelSender`](../../packages/backend/libs/domains/notifications/infra/providers/channel-sender.ts#L19): ChannelSender isolates each delivery provider behind its own circuit breaker. _(channel-sender.ts)_
<!-- theory-links:end -->

---

## 5. Load shedding and admission control

When overloaded, **reject early and cheaply** rather than accepting everything and timing out everywhere:
- Return `503` + `Retry-After` when event-loop delay, in-flight requests, or queue wait exceed thresholds (`@fastify/under-pressure` does this on event loop delay, heap, and RSS).
- **Prioritize**: shed analytics and background traffic before checkout or payments.
- Bounded queues everywhere. An unbounded queue just converts overload into latency and memory exhaustion.
- **Adaptive concurrency limits** (Netflix's concurrency-limits, a TCP Vegas–like algorithm): lower the allowed concurrency when latency rises.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LoadSheddingMiddleware`](../../packages/backend/libs/common/load-shedding/load-shedding.middleware.ts#L15): LoadSheddingMiddleware rejects requests with 503 when event-loop lag exceeds a threshold. _(load-shedding.middleware.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
> - [`EventLoopMonitor`](../../packages/backend/libs/common/load-shedding/event-loop-monitor.service.ts#L12): EventLoopMonitor measures event-loop delay and publishes p99 metrics that drive shedding decisions. _(event-loop-monitor.service.ts)_ · [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md)
> - [`WaitingRoomService`](../../packages/backend/libs/domains/launch-events/application/waiting-room.service.ts#L39): WaitingRoomService provides fair-queue admission control for high-traffic launch events. _(waiting-room.service.ts)_
<!-- theory-links:end -->

---

## 6. Fallbacks and graceful degradation

- Serve **stale cache** when the source is down (stale-if-error).
- Hide non-critical widgets (recommendations, notifications) when they fail. That's what partial responses in aggregate endpoints are for.
- **Queue writes** for later when the dependency is down (accept the order, process it when payment recovers), if the business allows it.
- Feature flags / kill switches to turn off expensive features under load.
- Fallbacks must be **tested** (chaos experiments, game days). An untested fallback usually doesn't work when you need it.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`GetOrLoadOptions`](../../packages/backend/libs/infrastructure/cache/cache.service.ts#L26): GetOrLoadOptions configures the stale-while-revalidate window and negative caching, so old copies are served when the source is slow. _(cache.service.ts)_
> - [`ProductPageService`](../../packages/backend/libs/composition/bff/product-page.service.ts#L29): ProductPageService returns partial results when a section fails or times out, hiding non-critical parts. _(product-page.service.ts)_
> - [`AnthropicLlmProvider`](../../packages/backend/libs/domains/assistant/infra/llm/anthropic.provider.ts#L27): AnthropicLlmProvider supports fallback refusal handling as a degraded path for the assistant. _(anthropic.provider.ts)_
<!-- theory-links:end -->

---

## 7. Other patterns

- **Hedged requests**: send a second request if the first hasn't answered by p95 latency, take the first response, and cancel the other. It cuts tail latency at the cost of extra load. Only for idempotent reads.
- **Queue-based load leveling**: put a queue between a spiky producer and a steady consumer.
- **Health-based routing**: the LB or mesh does outlier detection and ejects bad instances.
- **Idempotency + retries + timeouts** together form the base of reliable at-least-once systems.
- **Cell-based architecture / shuffle sharding** (AWS): limit the blast radius by isolating customers into cells.

---

## 8. Cascading failure: a scenario to tell

> Postgres slows down (a missing index after a deploy) → API requests hold connections longer → the pool is exhausted → requests wait for the pool → event-loop handlers pile up, memory grows → readiness probes time out → K8s removes pods → the remaining pods get more load → they fail too → total outage.

Defenses at each step: query timeouts (`statement_timeout`), a pool acquire timeout with fail-fast, load shedding, **readiness probes that don't depend on the shared DB in a way that removes every pod at once** (see the K8s probes doc), circuit breakers, an autoscaler with a max, and canary deploys that catch the regression first.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ReadinessService`](../../packages/backend/libs/infrastructure/health/readiness.service.ts#L23): ReadinessService reports dependency health and shutdown state to the load balancer, as in the readiness-probe step of the cascade. _(readiness.service.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
> - [`AllProvidersFailedError`](../../packages/backend/libs/domains/notifications/infra/providers/channel-sender.ts#L6): AllProvidersFailedError surfaces when every notification provider has failed, ending the fallback chain. _(channel-sender.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you call an unreliable third-party API from a request path?**
A strict timeout from its latency profile, limited retries with jittered exponential backoff for transient errors on idempotent calls, a circuit breaker with a fallback (cached data or queue for later), a concurrency limit (bulkhead), and metrics on latency, errors, and breaker state. If it's not essential to the response, take it off the request path and put it on a queue.

**Q: Why are retries dangerous?**
They multiply load during an incident, especially across layers (amplification), and they cause duplicates for non-idempotent operations. Mitigate with jitter, caps, retry budgets, retrying at one layer only, idempotency keys, and circuit breakers.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StripeService`](../../packages/backend/libs/infrastructure/stripe/stripe.service.ts#L16): StripeService wraps the third-party Stripe API with a circuit breaker and resilience patterns. _(stripe.service.ts)_ · [stripe](../../docs/humans/concepts/platform-stripe/stripe.md)
> - [UNKNOWN status: provider call timed out](../../docs/humans/concepts/domain-payments/unknown-status.md): The UNKNOWN payment status handles a timed-out Stripe call, resolved later by querying Stripe by idempotency key. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33), [`Payment`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L23)
<!-- theory-links:end -->
