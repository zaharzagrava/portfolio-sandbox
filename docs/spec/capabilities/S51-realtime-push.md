---
id: S51
title: Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S01, S03, S50, S54]
concepts: [realtime-topic-stream, problem-json-errors, rate-limit-policy, access-token-session, tenant-shop-rbac]
models: []
scope:
  - packages/backend/apps/sse-gateway/src/live/**
  - packages/backend/libs/domains/asset-library/**
  - packages/backend/libs/domains/auctions/**
  - packages/backend/libs/domains/catalog-sync/**
  - packages/backend/libs/domains/chat/**
  - packages/backend/libs/domains/experimentation/**
  - packages/backend/libs/domains/fulfilment/**
  - packages/backend/libs/domains/identity/**
  - packages/backend/libs/domains/launch-events/**
  - packages/backend/libs/domains/notifications/**
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/domains/payments/**
  - packages/backend/libs/domains/seller-insights/**
  - packages/backend/libs/domains/tenancy/**
  - packages/backend/libs/infrastructure/realtime/**
---
# S51 - Realtime push hub
## Purpose
Domains need to push events to browsers and to other processes. This capability gives them one stream endpoint, one publisher and one in-process subscriber. It resumes after a disconnect, and each topic has its own access rule. It shares one backplane subscription per topic and per instance, whatever the number of viewers.

## Entry points
- `GET /api/streams?topics=<t1>,<t2>,…`: the only way for a client to subscribe. It answers a `text/event-stream` response or a problem+json refusal. [code: packages/backend/libs/infrastructure/realtime/stream/topic-stream.controller.ts#TopicStreamController]
- `publish(topic, type, data, options?)`: any domain publishes an event. It resolves `{ published, id }` and does not throw on store faults. [code: packages/backend/libs/infrastructure/realtime/publish/realtime-publisher.service.ts#RealtimePublisher]
- `subscribe(topic, handler)`: an in-process listener that shares the ref-counted subscription. [code: packages/backend/libs/infrastructure/realtime/hub/topic-subscriber.service.ts#TopicSubscriber]
- `revoke({ userId?, prefix, id, suffix? })`: ends matching open subscriptions on every instance.
- `topicsWithSubscribers(prefix, suffix?)`: lists the topics that have viewers on any instance.
- `define(...)`: a domain registers a topic route and its rule while modules initialize. [code: packages/backend/libs/infrastructure/realtime/topic-registry.ts#TopicRegistry]
- Rate policy `realtime.connect`, declared into {{cap:S50}}. [code: packages/backend/libs/infrastructure/realtime/realtime-rate-policies.ts#realtimeRatePolicies]
- Web client: `EventSource` wrapper. [code: packages/web/lib/api/sse.ts#createEventStream]

## Rules
- **S51.R-01** The endpoint MUST answer `200` with `Content-Type: text/event-stream; charset=utf-8` and `Cache-Control: no-cache, no-transform`, uncompressed. [proof: S51 AS-01] [code: packages/backend/libs/infrastructure/realtime/stream/stream.service.ts#StreamService]
- **S51.R-02** A request MUST name 1 to 10 topics, and duplicate topics MUST collapse into one subscription. [proof: S51 AS-04, S51 AS-05]
- **S51.R-03** A malformed topic list or an extra query parameter MUST answer `400` problem+json (`invalid_topics` or `invalid_query`) and create no subscription. [proof: S51 AS-04] [code: packages/backend/libs/infrastructure/realtime/stream/stream-errors.ts#StreamInvalidTopicsError]
- **S51.R-04** A client MUST receive only events of the topics it asked for. [proof: S51 AS-03]
- **S51.R-05** A payload MUST NOT inject a field, comment or frame into the stream. The `data` line is one line of JSON that parses back to the original payload. [proof: S51 AS-06] [code: packages/backend/libs/infrastructure/realtime/frame.ts#formatFrame]
- **S51.R-06** A replayable event MUST carry an `id:` with the cursor of all topics seen, and a `replay: false` event MUST carry no `id:`. [proof: S51 AS-02, S51 AS-07] [code: packages/backend/libs/infrastructure/realtime/topics.ts#encodeCursor]
- **S51.R-07** Replay MUST deliver every stored event after the cursor in order, across page boundaries, including events published during the replay. [proof: S51 AS-08, S51 AS-09, S51 AS-10]
- **S51.R-08** Replay MUST NOT change stored state, and the same cursor MUST give the same sequence. [proof: S51 AS-11]
- **S51.R-09** A first connection without a cursor MUST receive a baseline frame and no historical data event. [proof: S51 AS-13]
- **S51.R-10** The hub MUST ignore an unusable `Last-Event-ID` entry and MUST ignore the whole header when it exceeds 2,048 characters. [proof: S51 AS-15]
- **S51.R-11** When the hub cannot prove that no event was lost, it MUST send one `resync` frame with `reason: "replay-gap"` instead of a partial replay. [proof: S51 AS-16, S51 AS-17]
- **S51.R-12** A live message with a position not greater than the connection cursor MUST NOT be written. [proof: S51 AS-19]
- **S51.R-13** The replay buffer MUST keep at least 1,000 and at most 1,200 events per topic, for at most one hour. [proof: S51 AS-20]
- **S51.R-14** A connection MUST be admitted for all requested topics or for none. Refusal is `401` for an anonymous viewer and `403` for an authenticated viewer. [proof: S51 AS-21, S51 AS-23]
- **S51.R-15** The `403` response for a topic that is not yours MUST equal the response for a topic that does not exist. [proof: S51 AS-24]
- **S51.R-16** A rule that throws or exceeds 2 s MUST answer `503` `realtime_policy_unavailable`. [proof: S51 AS-26]
- **S51.R-17** A rule MUST run once per topic on admission, never per event. [proof: S51 AS-27]
- **S51.R-18** A presented but invalid, expired or wrong-audience credential MUST answer `401`, even for a public topic. [proof: S51 AS-28]
- **S51.R-19** `publish` MUST store and announce an event in one step, and 200 parallel publishes MUST return distinct, strictly ordered ids. [proof: S51 AS-29, S51 AS-30]
- **S51.R-20** `publish` MUST NOT throw on a store fault or a store answer later than 1 s. It MUST make one attempt and resolve `{ published: false, id: null }`. [proof: S51 AS-32] [code: packages/backend/libs/infrastructure/realtime/publish/realtime-publisher.service.ts#RealtimePublisher]
- **S51.R-21** An instance MUST hold at most one backplane subscription per topic, and admission MUST wait for its confirmation. [proof: S51 AS-35, S51 AS-36, S51 AS-37]
- **S51.R-22** A failed subscribe MUST answer `503` `realtime_unavailable` and leave no state. [proof: S51 AS-38, S51 AS-67]
- **S51.R-23** A failing listener MUST NOT stop delivery to the other listeners. [proof: S51 AS-41]
- **S51.R-24** A user MUST NOT hold more than 20 connections (`429 too_many_connections`, `Retry-After: 5`). [proof: S51 AS-47]
- **S51.R-25** An instance at its connection limit MUST answer `503 realtime_capacity` with `Retry-After` of 1 to 5 seconds. [proof: S51 AS-48]
- **S51.R-26** The hub MUST close a connection with more than 1 MiB pending (`slow`) or a write blocked over the stall limit (`stalled`). [proof: S51 AS-44, S51 AS-45]
- **S51.R-27** `revoke` MUST end matching subscriptions fleet-wide with a `revoked` frame, MUST NOT ban the user from reconnecting, and MUST apply to a connection still being admitted. [proof: S51 AS-54, S51 AS-56, S51 AS-58]
- **S51.R-28** Two definitions of the same route MUST fail the boot, and `define` after startup MUST throw `TopicRegistryFrozenError`. [proof: S51 AS-63, S51 AS-65]
- **S51.R-29** A connection MUST end normally after its maximum lifetime (30 min), or at the credential expiry when the principal supplies one and it comes sooner, so a reconnect with the cursor loses nothing and a stale credential answers `401`. [proof: S51 AS-52] [code: packages/backend/libs/infrastructure/realtime/stream/connection.ts#StreamConnection]
- **S51.R-30** An idle connection MUST receive a `: ping` comment every heartbeat interval, and the first frame MUST carry a `retry:` between 2000 and 5000 ms drawn per connection. [proof: S51 AS-50, S51 AS-51]
- **S51.R-31** On shutdown the hub MUST stop admitting streams, end every connection at a random point of the drain window with complete frames, and close the backplane connection after the drain. [proof: S51 AS-53] [code: packages/backend/libs/infrastructure/realtime/stream/stream.service.ts#StreamService]
- **S51.R-32** `topicsWithSubscribers(prefix, suffix?)` MUST return the sorted topics of exactly that route that have a listener on any instance, capped at 10,000 with a warning, and MUST reject `RealtimeUnavailableError` within 1 s when the store is unreachable. [proof: S51 AS-60, S51 AS-61] [code: packages/backend/libs/infrastructure/realtime/hub/realtime-subscriptions.service.ts#RealtimeSubscriptions]
- **S51.R-33** An in-process subscriber MUST receive replayable and live-only events as `{ id, topic, type, data }`, share the ref-counted subscription with HTTP viewers, and stop receiving after an idempotent release. [proof: S51 AS-39, S51 AS-59]
- **S51.R-34** The hub MUST record connections, subscriptions, delivered events, publish results, closes, refusals, resyncs, revocations, ignored cursors, listener errors, replay overflows and delivery latency with label values from closed lists only, and MUST log one structured line at open and one at close with the request id and without any cookie, token, cursor or payload. Replayed events are not sampled in the delivery latency. [proof: S51 AS-69, S51 AS-70] [code: packages/backend/libs/infrastructure/realtime/metrics/realtime-metrics.ts#RealtimeMetrics]

## Behaviors
- **S51.B-01** Given a public topic, when a client connects and a domain publishes two events, then the client receives both in order with a cursor `id:`. [proof: S51 AS-01]
- **S51.B-02** Given a signed-in user on two topics, when one event is published to each, then the second frame carries a cursor naming both topics. [proof: S51 AS-02]
- **S51.B-03** Given the client saw price 2 of 5, when it reconnects with `Last-Event-ID`, then it receives prices 3, 4 and 5. [proof: S51 AS-08]
- **S51.B-04** Given 50 events published during a 200-event replay, when the replay runs, then the client gets events 2 to 250 with no gap or duplicate. [proof: S51 AS-09]
- **S51.B-05** Given a trimmed buffer, when the client reconnects, then it receives a `resync` frame for that topic. [proof: S51 AS-16]
- **S51.B-06** Given a cursor equal to the latest position, when the client reconnects, then it receives no replay and no `resync`. [proof: S51 AS-18]
- **S51.B-07** Given user B and the topic `user:<A>`, when B connects, then the answer is `403`, and an anonymous client gets `401`. [proof: S51 AS-21]
- **S51.B-08** Given a public topic, when an anonymous client connects, then it receives events. [proof: S51 AS-22]
- **S51.B-09** Given a rule that takes 300 ms, when a client connects, then the connection waits for the answer. [proof: S51 AS-25]
- **S51.B-10** Given 100 viewers of one topic on one instance, when an event is published, then the backplane shows one subscriber and each viewer receives the event once. [proof: S51 AS-35]
- **S51.B-11** Given viewers on two instances and none on a third, when an event is published, then both viewers receive it and the third instance is not subscribed. [proof: S51 AS-40]
- **S51.B-12** Given no viewer, when a domain publishes a replayable event, then the buffer holds it and a later viewer replays it. [proof: S51 AS-33]
- **S51.B-13** Given the store is down, when a domain publishes, then the call resolves `{ published: false, id: null }` in about 1 s. [proof: S51 AS-32]
- **S51.B-14** Given a viewer that stops reading, when a publisher sends 5 MiB, then the hub closes only that connection. [proof: S51 AS-44]
- **S51.B-15** Given 100 replayable events during a replay with a buffer limit of 10, then the connection stays open and all 100 arrive once in order. [proof: S51 AS-46]
- **S51.B-16** Given the 61st connection within a minute, then the answer is `429 rate_limited` and nothing is subscribed. [proof: S51 AS-49]
- **S51.B-17** Given a backplane outage with 3 replayable events published, when the connection recovers, then each viewer receives the 3 events once without reconnecting. [proof: S51 AS-66]
- **S51.B-18** Given a replay read that fails midway, then the connection ends without a truncated frame and a reconnect completes the replay. [proof: S51 AS-68]
- **S51.B-19** Given a revoked connection whose only topic is revoked, then the response ends after the `revoked` frame. [proof: S51 AS-55]
- **S51.B-20** Given `revoke` without `userId`, then every viewer of `shop:X:*` receives `revoked`. [proof: S51 AS-57]

## Lifecycles
No status model exists. A connection is open until the client, the lifetime limit, a limit breach, a revocation or a shutdown closes it.

## Owns
- Shared-store keys under the prefix `rt:`: the per-topic replay buffer and the channels. [code: packages/backend/libs/infrastructure/realtime/keys.ts#streamKey]
- Metrics (FR-054) and structured logs (FR-055).
- Rate policy `realtime.connect`: 60 new connections per minute per user or address, fail open.
- Configuration: heartbeat (15 s), lifetime (30 min), stall (30 s), drain (10 s), buffer bounds, caps, retention (1 h), page size and timeouts. [code: packages/backend/libs/infrastructure/realtime/config/realtime.config.ts#realtimeConfigSchema]
- Zod contracts in `packages/contracts/src/realtime.ts`.

## Decisions
- One endpoint and one `topics` parameter make the credential, rule and limits apply in one place.
- A random `retry:` of 2000 to 5000 ms prevents a fleet-wide lockstep reconnect.
- Publishing is best effort and never retries, because the REST state is the truth.
- A refusal never reveals whether a topic exists, so the answers for "not yours" and "missing" are identical.
- A new topic type is private until its owner defines a rule.
- Revocation closes open connections but does not ban, because refusing new ones is the job of the rule ({{cap:S03}}).

## Known gaps
- No authenticator supplies `credentialExpiresAt` yet ({{cap:S01}} must); the credential-expiry end is proven with an injected principal only.
- AS-34 and AS-31 are compile-time and validation tests. The proof list has them, but this page states no rule on publish validation or topic types.
- This page lists no rule for AS-12, AS-42, AS-43, AS-62 and AS-64 (grammar), so those are unstated.
- The raw `libs/infrastructure/redis-pubsub` is still used by chat; the gateway-local relays, `payment-stream` and `realtime-notifier` are gone.