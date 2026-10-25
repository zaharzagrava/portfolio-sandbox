# arch-08. Outbound webhooks to partners

*Integrations · Medium*

## The question

Partners (PMSs and large property managers) want webhooks from us: `payment.succeeded`, `payment.returned`, `payout.paid`. About 300 endpoints, 2M events a month, peaks around 300 events/s on the 1st. Some partner endpoints are slow or down for hours. Design delivery.

**Then:** One partner's endpoint returned 500s for 6 hours on rent day, and now they ask you to resend everything they missed. Another partner reports receiving `payment.returned` before `payment.succeeded` for the same payment.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Delivery guarantee? → assume: at-least-once, every event has a stable id for dedupe.
- Ordering promise? → assume: none across events; each payload carries a per-object version.
- Payload: full snapshot or thin notification? → assume: snapshot of the object at event time + version; partners can fetch current state from our API.
- Retry policy? → assume: exponential backoff with jitter for ~3 days, then the delivery is marked dead.
- Timeout per call? → assume: 10 s; only 2xx counts as success.
- Signing? → assume: HMAC-SHA256 with a per-endpoint secret and timestamp, in the Standard Webhooks header format.

## Design

1. **Source:** the domain transaction writes an outbox row. A fan-out worker turns it into one event and one delivery per subscribed endpoint:
```sql
webhook_events(id uuid, type, object_id, object_version int, payload jsonb, created_at)
webhook_deliveries(id, event_id, endpoint_id, status,   -- pending|succeeded|dead
  attempts int, next_attempt_at, last_status int, last_error, UNIQUE (event_id, endpoint_id))
webhook_endpoints(id, partner_id, url, secrets jsonb, event_types text[], status,  -- active|degraded|disabled
  max_in_flight int DEFAULT 5)
```
2. **Dispatchers** claim due deliveries with `SKIP LOCKED`, fair across endpoints: pick endpoints round-robin, at most `max_in_flight` concurrent requests each (tracked in Redis or by counting claimed rows).
3. **Send:** `POST` with `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`. HTTPS only, 10 s timeout, no redirects.
4. **Outcome:** 2xx → `succeeded`. Otherwise `attempts++`, `next_attempt_at = now + backoff(attempts)` (30 s, 2 m, 10 m, 1 h, then every ~6 h, ±20% jitter); after ~3 days → `dead`.
5. **Endpoint health:** consecutive failures → `degraded`: only one probe delivery at a time, the rest wait without burning workers. Recovers on a 2xx; the backlog is released at a ramped rate. Days of failure → `disabled`, partner emailed.
6. **Replay:** `POST /webhook-endpoints/:id/replay {from, to, types}` creates new deliveries for the same event ids. Plus `GET /events?after=<cursor>` so partners can pull what they missed.
7. **Security:** SSRF guard: resolve DNS, reject private, loopback and link-local ranges (including 169.254.169.254), connect to the resolved IP. Rotation: two active secrets, both signatures sent during the overlap.
8. **Retention:** deliveries partitioned by month, dropped after 30-90 days; events kept for replay per policy.

Capacity: 300 events/s × ~2 endpoints = ~600 deliveries/s at peak; Postgres handles this with batched claims (claim 100 rows per query).

## Deep dives

**1. Per-endpoint isolation.** With one shared queue, a slow endpoint (10 s timeouts) occupies most workers and everyone's deliveries wait. Chosen: per-endpoint concurrency cap + fair claiming + `degraded` mode; a broken endpoint only delays itself. Rejected: one SQS queue for all (no per-endpoint fairness); one queue per endpoint (300 queues to manage; reasonable later at larger scale).

**2. Ordering (twist, part 2).** Retries finish out of order, so `returned` (version 3) can land before `succeeded` (version 2). We don't promise order; every payload has `object_version` and `occurred_at`. Documented rule for partners: ignore an event whose version ≤ the one you stored, or fetch the object. Rejected: strict per-object ordering (one failing event blocks every later event for that object, and it doesn't survive replays).

**3. 6-hour outage and replay (twist, part 1).** Automatic retries already cover 6 hours, so nothing is lost; when the endpoint recovers the backlog drains at a ramped rate so we don't overload them. Replay is for longer gaps or partner-side data loss; it reuses event ids, so a partner that dedupes isn't harmed.

**4. HMAC vs asymmetric signatures.** HMAC is simple and widely supported. Ed25519 lets partners verify with a public key and proves the sender, because they can't forge it. Chosen: HMAC now, asymmetric if partners need non-repudiation.

## Traps

- Making HTTP calls inside the domain transaction.
- No stable event id, so partners can't dedupe retries.
- Fixed-interval retries without jitter; recovery turns into a spike that takes the partner down again.
- Following redirects or calling URLs without SSRF checks.
- Promising exactly-once or global ordering.
- Retrying forever; the table grows and dead endpoints consume workers.

## Say it (60–90 s)

Delivery is at-least-once with a stable event id and a per-object version in every payload. The domain transaction writes an outbox row, and a fan-out worker creates one delivery row per subscribed endpoint. Dispatchers claim due deliveries from Postgres with SKIP LOCKED, but fairly across endpoints, with a cap on in-flight requests per endpoint, so a slow partner only slows itself. Each request is signed with HMAC-SHA256 over the id, timestamp and body, has a 10-second timeout, and goes only to public IPs after DNS resolution, to block SSRF. Failures retry with exponential backoff and jitter for about three days; an endpoint that keeps failing goes into a degraded mode where we send one probe at a time. When it recovers, the backlog drains at a ramped rate. For the 6-hour outage, retries already cover it, and a replay API re-sends the same event ids for longer gaps, plus an events endpoint lets them pull. On ordering, I don't promise it; partners compare the object version or fetch the object.

## Follow-ups

**Q:** A partner says our signatures don't verify.
**A:** They must verify the raw body bytes before parsing, use the right secret during rotation, and keep their clock within the timestamp tolerance (5 min). Give them a test-send button and a sample signature.

**Q:** How does a partner know they missed events?
**A:** Delivery log in their dashboard, the `GET /events?after=` endpoint, and an email when an endpoint becomes degraded.

**Q:** 10× volume?
**A:** Batch claims and partition deliveries first. Then move dispatch to SQS with per-endpoint rate limits in Redis, or buy a managed webhook service if it isn't core to the business.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
