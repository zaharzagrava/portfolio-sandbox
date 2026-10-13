# F-03 — Realtime Push Hub (generalised SSE gateway)

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 0 · Depends on: F-01 · Used by: SD-15, 17, 18, 21, 22, 23, 27, 38, 42

## Why
Today `apps/sse-gateway` streams payment status only. Booking seat maps, auction prices, notifications, live comments, import progress and courier tracking all need "push to user X / topic Y". Generalise it once.

## Existing code to reuse
`apps/sse-gateway` (payment-stream, realtime-notifier, redis-pubsub), README showcases #24 (SSE) and #30 (ref-counted fan-out).

## Patterns showcased
| Pattern | Lesson / design |
|---|---|
| Topic-based SSE streams over a Redis pub/sub backplane, ref-counted subscriptions per instance | 10/06 shared block |
| **Resume with `Last-Event-ID`**: per-topic Redis Stream (`XADD` with `MAXLEN ~`) as a short replay buffer | 10/06 shared block, 04/01 §2.8 |
| Heartbeats (comment lines every 15 s) for LB idle timeouts; `X-Accel-Buffering: no` | 04/01 §2.8 |
| Authorization per topic (user can only subscribe to own `user:{id}` / shop topics) using the existing short-lived ticket idea (#32) | 05/02 |
| Backpressure: drop slow consumers (bounded per-connection buffer) | 02/02 |
| Publisher API in `libs/common` (`RealtimePublisher.publish(topic, event)`) used by all domains | — |

## Steps
- [x] `libs/infrastructure/realtime/` — `RealtimePublisher` (XADD + PUBLISH), topic naming helper with template-literal types (`user:${string}` | `auction:${string}` ...).
- [x] `libs/infrastructure/realtime/stream/` — `GET /streams?topics=...` SSE endpoint, Last-Event-ID replay, heartbeats, per-connection bounded queue.
- [x] Topic authorization policy registry (each domain registers `canSubscribe(user, topic)`).
- [ ] Keep payment-stream working (migrate it onto the hub). → kept as-is for now (works, owner check is payment-specific); new features use the hub. Its per-viewer unsubscribe bug is avoided in the hub (ref-counting).
- [x] e2e (real Redis): publish 5 events, reconnect with Last-Event-ID=2 → receives 3..5; unauthorised topic → 403.
- [x] k6: 5k concurrent SSE connections script (`loadtest:sse`).

## FE visualisation (phase 2)
`useEventStream(topics)` hook in web.

## Scale
- Target: 50k concurrent SSE connections per gateway instance (idle-heavy), 5k events/s published.
- Hot path: publisher → Redis PUBLISH (+ XADD capped stream for replay) → only instances with local subscribers receive → in-memory fan-out. No DB on the push path.
- First bottleneck & fix: single Redis pub/sub node → shard channels across Redis Cluster nodes by topic hash (sharded pub/sub `SPUBLISH`); per-instance memory → bounded per-connection buffers.
- Proof: k6 `loadtest:sse` 5k connections × 10 events/s; thresholds: delivery p99 < 500 ms, 0 dropped for healthy consumers.

## Implementation notes (2026-10-01)
- `libs/infrastructure/realtime/` (S51 moved everything here from `libs/common/src/realtime/` and `apps/sse-gateway/src/topic-stream/`): `topics.ts` (template-literal `RealtimeTopic`, route resolution, multi-topic cursor encode/decode for Last-Event-ID, resync decision), `publish/` (`RealtimePublisher`: one atomic script, capped and expiring `rt:s:<topic>` + `rt:c:<topic>`), `topic-registry.ts` (one rule per route; unknown routes denied), `hub/` (`SubscriptionHub` ref-counted channels, `TopicSubscriber`, `RealtimeSubscriptions`), `stream/` (`TopicStreamController` `GET /api/streams?topics=` and `StreamService`: subscribe → buffer → paged replay → flush without duplicates, `resync` when the gap cannot be covered; heartbeats 15 s; `X-Accel-Buffering: no`; slow consumers dropped at 1 MiB buffered; lifetime and drain).
- The gateway app only composes `RealtimeStreamModule` (`apps/sse-gateway/src/sse-gateway.module.ts`).
- Specs: the 12 `*.e2e-spec.ts` files beside the engine (scenario → file map in `specs/domains/S51-realtime-push/test-plan.md`), the gateway composition spec `apps/sse-gateway/src/topic-stream/topic-stream.e2e-spec.ts`, and `packages/backend/test/utils/sse-client.ts`.
- k6 `scripts/load-tests/sse.test.js` (`pnpm loadtest:sse`, needs xk6-sse): viewers + Redis publisher measuring delivery latency.
- Found: legacy `payment-stream` unsubscribes the Redis channel per viewer (second viewer of the same payment stops receiving when the first leaves). Left untouched, logged as Q18.
