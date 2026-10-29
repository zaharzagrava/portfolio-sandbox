# arch-24. Outbound webhooks platform for customers

*Integrations · Medium*

## The question

"We're a shipping API platform. Merchants subscribe to webhooks like `label.created`, `shipment.in_transit`, `shipment.delivered` and `shipment.exception`. ~5,000 endpoints, ~30M events a month, peaks around 2,000 events/s at night when carriers upload scan batches. Some merchant endpoints are slow or down for hours. Design delivery."

**Then:** "One merchant's endpoint returned 500s for 6 hours on Black Friday, and now they ask us to resend everything they missed. Another reports getting `shipment.delivered` before `shipment.in_transit` for the same parcel."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Delivery guarantee? → assume: at-least-once; every event has a stable ID for dedupe.
- Ordering promise? → assume: none across events; each payload carries the object's version and `occurred_at`.
- Payload: snapshot or thin? → assume: snapshot of the shipment at event time + version; merchants can fetch current state from our API.
- Retry policy? → assume: exponential backoff with jitter for ~3 days, then the delivery is marked dead.
- Timeout and success? → assume: 10 s timeout; only 2xx counts.
- Signing? → assume: HMAC-SHA256 with a per-endpoint secret and timestamp, in the Standard Webhooks format.
- Numbers → assume: 30M events/month, ~1.5 subscribed endpoints per event → ~45M deliveries/month; peak ~3,000 deliveries/s. Concurrency = rate × latency: 3,000/s × 0.3 s typical = ~900 requests in flight; one endpoint timing out at 10 s with 200 events/s would need 2,000 in flight by itself.

## Design

1. **Source:** the shipment transaction writes an outbox row. A fan-out worker turns it into one event and one delivery per subscribed endpoint:
```sql
webhook_events(id uuid, type, object_id, object_version int, payload jsonb, created_at)
webhook_deliveries(id, event_id, endpoint_id, status,   -- pending | succeeded | dead
  attempts int, next_attempt_at, last_status int, last_error, UNIQUE (event_id, endpoint_id))
webhook_endpoints(id, merchant_id, url, secrets jsonb, event_types text[],
  status,                                               -- active | degraded | disabled
  max_in_flight int DEFAULT 10)
```
2. **Dispatchers** claim due deliveries with `SKIP LOCKED` in batches of 100, fair across endpoints: round-robin by endpoint, at most `max_in_flight` concurrent requests per endpoint (a Redis counter per endpoint, decremented in `finally`, with a TTL guard).
3. **Send:** `POST` with `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`. HTTPS only, 10 s timeout, no redirects, keep-alive connection pools per host.
4. **Outcome:** 2xx → `succeeded`. Otherwise `attempts++`, `next_attempt_at = now + backoff(attempts)` (30 s, 2 m, 10 m, 1 h, then every ~6 h, ±20% jitter); after ~3 days → `dead`. A 410 Gone disables the endpoint.
5. **Endpoint health:** consecutive failures → `degraded`: one probe delivery at a time; the rest wait without using workers. A 2xx recovers it, and the backlog drains at a ramped rate. Failing for days → `disabled`, merchant emailed.
6. **Replay:** `POST /webhook-endpoints/:id/replay {from, to, types}` creates new deliveries for the same event IDs. Plus `GET /events?after=<cursor>` so merchants can pull what they missed.
7. **Security:** SSRF guard: resolve DNS, reject private, loopback and link-local ranges (incl. 169.254.169.254), connect to the resolved IP. Secret rotation: two active secrets, both signatures sent during the overlap.
8. **Retention:** deliveries partitioned by month, dropped after 30 days; events kept 90 days for replay.

## Deep dives

**1. Per-endpoint isolation.** With one shared queue, a slow endpoint holds workers for 10 s per request and everyone else's deliveries wait. Chosen: per-endpoint concurrency cap + fair claiming + `degraded` mode; a broken endpoint only delays itself. Rejected: one SQS queue for all (no per-endpoint fairness); one queue per endpoint (5,000 queues to manage; reasonable later at larger scale).

**2. Ordering (twist, part 2).** Retries finish out of order, so `delivered` (version 4) can land before `in_transit` (version 3), especially at night when carriers upload scans in batches. We don't promise order; every payload has `object_version` and `occurred_at`. Documented rule: ignore an event whose version ≤ the one you stored, or fetch the shipment. Rejected: strict per-object ordering (one failing event blocks every later event for that parcel, and replays break it anyway).

**3. 6-hour outage and replay (twist, part 1).** Automatic retries already cover 6 hours, so nothing is lost; when the endpoint recovers, the backlog drains at a ramped rate so the merchant isn't overloaded on their busiest day. Replay is for longer gaps or merchant-side data loss; it reuses event IDs, so a merchant that dedupes isn't harmed. Snapshot payloads are as of event time; merchants that want current state fetch it.

**4. HMAC vs asymmetric signatures.** HMAC is simple and widely supported. Ed25519 lets merchants verify with a public key and proves we sent it, since they can't forge it. Chosen: HMAC now, asymmetric if merchants need non-repudiation.

## Traps

- Making HTTP calls inside the domain transaction.
- No stable event ID, so merchants can't dedupe retries.
- Fixed-interval retries without jitter: recovery becomes a spike that takes the endpoint down again.
- Following redirects or calling URLs without SSRF checks.
- Promising exactly-once or global ordering.
- Retrying forever: the table grows and dead endpoints consume workers.

## Say it (60–90 s)

Delivery is at-least-once with a stable event ID and an object version in every payload. The shipment transaction writes an outbox row, and a fan-out worker creates one delivery row per subscribed endpoint. Dispatchers claim due deliveries from Postgres with SKIP LOCKED, fairly across endpoints, with a cap on in-flight requests per endpoint, because three thousand deliveries a second at ten-second timeouts would otherwise let one slow merchant hold every worker. Each request is signed with HMAC-SHA256 over the ID, timestamp and body in the Standard Webhooks format, has a ten-second timeout, and only goes to public IPs after DNS resolution, to block SSRF. Failures retry with exponential backoff and jitter for about three days; an endpoint that keeps failing goes into degraded mode with one probe at a time, and when it recovers the backlog drains at a ramped rate. For the six-hour outage, retries already cover it, and a replay API re-sends the same event IDs for longer gaps, plus an events endpoint they can pull from. On ordering, I don't promise it: merchants compare the object version or fetch the shipment.

## Follow-ups

**Q:** A merchant says our signatures don't verify.
**A:** They must verify the raw body bytes before parsing, use the right secret during rotation, and keep their clock within the timestamp tolerance (5 min). Give them a test-send button and a sample signature.

**Q:** How does a merchant know they missed events?
**A:** A delivery log in their dashboard, the `GET /events?after=` endpoint, and an email when an endpoint becomes degraded.

**Q:** 10× volume?
**A:** Batch claims and partition deliveries first. Then move dispatch to SQS (or Kafka) with per-endpoint concurrency limits in Redis, or buy a managed webhook service if it isn't core to the business.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
