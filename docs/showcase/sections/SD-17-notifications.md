# SD-17 — Notification System (email / SMS / push / in-app)

Status: ☑ done (typechecked; specs written, not run) · Phase 4 · Depends on: F-02 (SQS, Scylla, Mailpit), F-03, SD-29, SD-28

## Marketplace adaptation
Order shipped, outbid, price drop on a wishlist item, drop starting in 10 min, payout sent, new chat message while offline. Users choose channels per category; quiet hours by time zone; marketing vs transactional priorities.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Kafka domain events → **notification router** (resolve recipients, preferences, templates/i18n, dedupe key = eventId+user+channel) → **per-channel SQS queues** (bulkhead: SMS outage doesn't block email) | 10/02 Ex4, D18 |
| Priority: separate transactional vs marketing queues | 10/02 Ex4 |
| Channel workers: provider rate limits (token bucket SD-28), retries with backoff, DLQ, **provider failover** (SES → SMTP/Mailpit fallback; Twilio fake) behind circuit breakers | 06/03 |
| Quiet hours / user time zone → delayed send (SQS delay ≤ 15 min, else SD-29 job) | 10/02 Ex4 |
| Per-user frequency caps ("max 3 pushes/hour") in Redis | 10/06 #17 |
| **In-app inbox in ScyllaDB** `inbox_by_user(user_id, bucket, notif_id DESC)` + unread counter in Redis + realtime push via F-03 | 10/06 #17, D24 |
| Delivery status webhooks from providers (signed) → status table (Scylla) → ClickHouse analytics | 04/03 §5 |
| Unsubscribe links (signed tokens), suppression list (bounces/complaints) | 10/02 Ex4 |
| Dedupe table with TTL (Redis `SET NX EX`) | 10/02 Ex4 |

## Steps
- [x] `NotificationsModule`: preferences (Postgres, cached), templates (handlebars, i18n), router consumer (Kafka), channel workers (SQS consumers), providers (ports + fakes + nodemailer SMTP adapter).
- [x] In-app inbox (Scylla) + `GET /notifications`, `POST /notifications/read` + unread badge + SSE push.
- [x] Quiet hours computation (Luxon, pure — unit tested, shared with SD-29 cron tz logic).
- [x] Provider webhook endpoint + suppression list.
- [x] e2e: `order.shipped` event → email captured by provider spy + inbox row + unread=1; duplicate event → no second email; quiet hours → delayed job created.

## Scale
- Target: 10M notifications/day avg (115/s), 20k/s marketing bursts; inbox reads 30k RPS.
- Hot path: Kafka → router (stateless, batch preference lookups from Redis) → SQS per channel → workers autoscaled on queue depth (Lambda-style). Inbox writes → Scylla; reads → Scylla + Redis unread counter.
- First bottleneck & fix: provider rate limits → token buckets per provider; marketing burst → separate low-priority queue drained at capped rate.
- Partitioning: Kafka by userId (per-user ordering); Scylla inbox by user_id+month.
- Capacity model: 20k/s burst → SQS unlimited; workers 200 concurrency × 100 ms ≈ 2k/s each → 10 workers.
- Proof: k6 event burst; time-to-inbox p99 < 2 s; zero duplicates.

## FE visualisation (phase 2)
Bell icon with live unread count, preferences matrix.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001230000-notifications` adds `NotificationSettings` (tz, locale, quiet hours, phone), sparse `NotificationPreference` overrides, `PushDevice` and `NotificationSuppression`. Scylla tables in `cql/030_notifications.cql`: `inbox_by_user` (user+month partitions, 180-day TTL), `deliveries` and `deliveries_by_provider_id`.
- **Catalog** (`catalog.ts`): typed registry of notification types with category, priority, default channels, mandatory flag, link and localized templates (en/uk). The opt-in channel is SMS.
- **Templates** (`templates.ts`): logic-less `{{var}}`; HTML-escaped in HTML templates; a missing variable throws; locale fallback goes exact → language → en.
- **Quiet hours** (`quiet-hours.ts`): Luxon, DST-aware, overnight windows. Unit spec `quiet-hours.spec.ts` covers the Kyiv DST night.
- **Event mapping** (`NotificationRouterProjector`, apps/projector):
  - `order.paid` → `order.confirmed`; `order.cancelled` → `order.cancelled`.
  - New `auction.leader_changed` → `auction.outbid`. The bid relay records it in its transaction via a `prev` CTE that reads the old leader.
  - `auction.closed` → `auction.won`.
  - `billing.invoice_payment_failed` → `billing.payment_failed`, sent to the user or to shop OWNERs.
  - `OrderPaid` gained optional `currency`.
- **`NotificationRouter`**, in order:
  1. Cached recipient (one Postgres query, CacheService with SWR).
  2. Render once.
  3. In-app inbox: idempotent upsert with a time-UUID derived from the dedupe key, `SET NX`-guarded unread INCR, realtime push on `user:{id}`.
  4. Per external channel: marketing frequency caps, then quiet hours for push/SMS, then the channel's SQS queue (marketing gets its own queue). Delays over 15 min go through the SD-29 `notifications.deliver` job.
  5. Deterministic delivery ids; the "done" marker is written last.
- **`NotificationWorkers`** (apps/worker), per message: dedupe (`notif:sent:`), then the suppression check (cached, negative-cached), then the provider rate limit (`notify.*` token buckets, re-enqueued with a delay instead of burning a receive), then failover.
  - `ChannelSender`: opossum breakers per provider. Permanent errors are not failed over; they suppress the address (push: dead tokens are deleted).
  - Providers: SES v2 (List-Unsubscribe one-click headers), SMTP/nodemailer (Mailpit locally), Twilio REST, FCM (`sendEachForMulticast`), log fakes when no credentials.
- **Webhooks:**
  - SES via SNS: signature verified (cert host pinned to `sns.*.amazonaws.com`, SHA1/SHA256, 1 h replay window) plus TopicArn pinning. Hard bounce/complaint → suppression; complaint → marketing email off.
  - Twilio: `X-Twilio-Signature` HMAC; error 21610 (STOP) → suppression.
- **Unsubscribe:** HMAC token without expiry. GET only describes it (mail scanners pre-fetch links); POST performs it (RFC 8058).
- **API:** `GET /api/notifications`, `GET /unread-count`, `POST /read` (ids with an LWT, or `all` via an O(1) watermark), `GET|PUT /preferences`, `PUT /settings`, `POST|DELETE /devices`, `GET|POST /unsubscribe`, `POST /webhooks/{ses,twilio}`.
- **Spec** `notifications/notifications.e2e-spec.ts` covers: delivery + inbox + badge, replay without duplicates, quiet hours → scheduled job, one-click unsubscribe, and a signed SNS complaint (forged and foreign-topic messages rejected) → suppressed.
