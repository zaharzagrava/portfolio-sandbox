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
- **S51.R-01** The endpoint MUST answer `200` with [`Content-Type: text/event-stream; charset=utf-8` ↗](../sw-external-terms.md#server-sent-events) and [`Cache-Control: no-cache, no-transform` ↗](../sw-external-terms.md#cache-control), uncompressed. [proof: S51 AS-01] [code: packages/backend/libs/infrastructure/realtime/stream/stream.service.ts#StreamService]
- **S51.R-02** A request MUST name 1 to 10 [topics](../terms/realtime-topic.md), and duplicate topics MUST collapse into one [subscription](../terms/realtime-subscription.md). [proof: S51 AS-04, S51 AS-05]
- **S51.R-03** A malformed topic list or an extra query parameter MUST answer `400` [problem+json ↗](../sw-external-terms.md#problem-json) ([`invalid_topics`](../terms/invalid-topics.md) or [`invalid_query`](../terms/invalid-query.md)) and create no subscription. [proof: S51 AS-04] [code: packages/backend/libs/infrastructure/realtime/stream/stream-errors.ts#StreamInvalidTopicsError]
- **S51.R-04** A client MUST receive only [events](../terms/realtime-event.md) of the topics it asked for. [proof: S51 AS-03]
- **S51.R-05** A [payload](../terms/event-payload.md) MUST NOT inject a field, comment or [frame](../terms/stream-frame.md) into the stream. The [`data` line](../terms/sse-data-line.md) is one line of JSON that parses back to the original payload. [proof: S51 AS-06] [code: packages/backend/libs/infrastructure/realtime/frame.ts#formatFrame]
- **S51.R-06** A [replayable event](../terms/replayable-event.md) MUST carry an [`id:`](../terms/sse-event-id.md) with the [cursor](../terms/replay-cursor.md) of all topics seen, and a [`replay: false`](../terms/replay-false.md) event MUST carry no `id:`. [proof: S51 AS-02, S51 AS-07] [code: packages/backend/libs/infrastructure/realtime/topics.ts#encodeCursor]
- **S51.R-07** [Replay](../terms/event-replay.md) MUST deliver every stored event after the cursor in order, across [page boundaries](../terms/replay-page.md), including events published during the replay. [proof: S51 AS-08, S51 AS-09, S51 AS-10]
- **S51.R-08** Replay MUST NOT change [stored state](../terms/replay-buffer.md), and the same cursor MUST give the same sequence. [proof: S51 AS-11]
- **S51.R-09** A first connection without a cursor MUST receive a [baseline frame](../terms/baseline-frame.md) and no [historical data event](../terms/replayable-event.md). [proof: S51 AS-13]
- **S51.R-10** The [hub](../terms/realtime-hub.md) MUST ignore an unusable [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id) entry and MUST ignore the whole header when it exceeds 2,048 characters. [proof: S51 AS-15]
- **S51.R-11** When the [hub](../terms/realtime-hub.md) cannot prove that no event was lost, it MUST send one [`resync` frame](../terms/resync-frame.md) with `reason: "[replay-gap](../terms/resync-frame.md)"` instead of a partial replay. [proof: S51 AS-16, S51 AS-17]
- **S51.R-12** A [live message](../terms/stream-frame.md) with a position not greater than the [connection cursor](../terms/replay-cursor.md) MUST NOT be written. [proof: S51 AS-19]
- **S51.R-13** The [replay buffer](../terms/replay-buffer.md) MUST keep at least 1,000 and at most 1,200 events per [topic](../terms/realtime-topic.md), for at most one hour. [proof: S51 AS-20]
- **S51.R-14** A connection MUST be [admitted](../terms/connection-admission.md) for all requested topics or for none. Refusal is `401` for an [anonymous viewer](../terms/viewer.md) and `403` for an [authenticated viewer](../terms/viewer.md). [proof: S51 AS-21, S51 AS-23]
- **S51.R-15** [The `403` response for a topic that is not yours](../terms/identical-not-found.md) MUST equal the response for a topic that does not exist. [proof: S51 AS-24]
- **S51.R-16** [A rule](../terms/realtime-topic-access-rule.md) that throws or exceeds 2 s MUST answer `503` [`realtime_policy_unavailable`](../terms/realtime-policy-unavailable.md). [proof: S51 AS-26]
- **S51.R-17** [A rule](../terms/realtime-topic-access-rule.md) MUST run once per topic on [admission](../terms/connection-admission.md), never per event. [proof: S51 AS-27]
- **S51.R-18** A presented but invalid, expired or [wrong-audience ↗](../sw-external-terms.md#jwt-aud) [credential](../terms/credential.md) MUST answer `401`, even for a [public topic](../terms/realtime-topic-access-rule.md). [proof: S51 AS-28]
- **S51.R-19** [`publish`](../terms/realtime-publish.md) MUST store and announce an event in one step, and 200 parallel publishes MUST return distinct, [strictly ordered ids](../terms/realtime-publish.md). [proof: S51 AS-29, S51 AS-30]
- **S51.R-20** [`publish`](../terms/realtime-publish.md) MUST NOT throw on a [store fault](../terms/realtime-store.md) or a store answer later than 1 s. It MUST make one attempt and resolve [`{ published: false, id: null }`](../terms/realtime-publish.md). [proof: S51 AS-32] [code: packages/backend/libs/infrastructure/realtime/publish/realtime-publisher.service.ts#RealtimePublisher]
- **S51.R-21** An instance MUST hold at most one [backplane subscription](../terms/realtime-backplane.md) per [topic](../terms/realtime-topic.md), and [admission](../terms/connection-admission.md) MUST wait for its confirmation. [proof: S51 AS-35, S51 AS-36, S51 AS-37]
- **S51.R-22** A failed subscribe MUST answer `503` [`realtime_unavailable`](../terms/realtime-unavailable.md) and leave no state. [proof: S51 AS-38, S51 AS-67]
- **S51.R-23** A failing [listener](../terms/realtime-listener.md) MUST NOT stop delivery to the other listeners. [proof: S51 AS-41]
- **S51.R-24** A user MUST NOT hold more than [20 connections](../terms/user-connection-cap.md) ([`429 too_many_connections`](../terms/too-many-connections.md), [`Retry-After: 5` ↗](../sw-external-terms.md#retry-after)). [proof: S51 AS-47]
- **S51.R-25** An instance at its [connection limit](../terms/realtime-instance-limit.md) MUST answer [`503 realtime_capacity`](../terms/realtime-capacity.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after) of 1 to 5 seconds. [proof: S51 AS-48]
- **S51.R-26** The [hub](../terms/realtime-hub.md) MUST close a connection with more than 1 MiB pending ([`slow`](../terms/slow-consumer-close.md)) or a write blocked over the [stall limit](../terms/slow-consumer-close.md) ([`stalled`](../terms/slow-consumer-close.md)). [proof: S51 AS-44, S51 AS-45]
- **S51.R-27** [`revoke`](../terms/realtime-revoke.md) MUST end matching [subscriptions](../terms/realtime-subscription.md) [fleet-wide](../terms/fleet-wide-limit.md) with a [`revoked` frame](../terms/stream-frame.md), MUST NOT ban the user from reconnecting, and MUST apply to a connection [still being admitted](../terms/connection-admission.md). [proof: S51 AS-54, S51 AS-56, S51 AS-58]
- **S51.R-28** Two definitions of the same [route](../terms/realtime-topic.md) MUST fail the boot, and [`define`](../terms/topic-registry.md) after startup MUST throw [`TopicRegistryFrozenError`](../terms/topic-registry.md). [proof: S51 AS-63, S51 AS-65]

## Behaviors
- **S51.B-01** Given a [public topic](../terms/realtime-topic-access-rule.md), when a client connects and a domain publishes two events, then the client receives both in order with a [cursor `id:`](../terms/replay-cursor.md). [proof: S51 AS-01]
- **S51.B-02** Given a signed-in user on two topics, when one event is published to each, then the second [frame](../terms/stream-frame.md) carries a [cursor naming both topics](../terms/replay-cursor.md). [proof: S51 AS-02]
- **S51.B-03** Given the client saw price 2 of 5, when it reconnects with [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id), then it receives prices 3, 4 and 5. [proof: S51 AS-08]
- **S51.B-04** Given 50 events published during a 200-event [replay](../terms/event-replay.md), when the replay runs, then the client gets events 2 to 250 with no gap or duplicate. [proof: S51 AS-09]
- **S51.B-05** Given a [trimmed buffer](../terms/replay-buffer.md), when the client reconnects, then it receives a [`resync` frame](../terms/resync-frame.md) for that [topic](../terms/realtime-topic.md). [proof: S51 AS-16]
- **S51.B-06** Given a [cursor](../terms/replay-cursor.md) equal to the latest position, when the client reconnects, then it receives no replay and no `resync`. [proof: S51 AS-18]
- **S51.B-07** Given user B and the topic [`user:<A>`](../terms/user-prefix.md), when B connects, then the answer is [`403`](../terms/permission-denied.md), and an anonymous client gets `401`. [proof: S51 AS-21]
- **S51.B-08** Given a [public topic](../terms/realtime-topic-access-rule.md), when an anonymous client connects, then it receives events. [proof: S51 AS-22]
- **S51.B-09** Given a [rule](../terms/realtime-topic-access-rule.md) that takes 300 ms, when a client connects, then the connection waits for the answer. [proof: S51 AS-25]
- **S51.B-10** Given 100 viewers of one topic on one instance, when an event is published, then the [backplane](../terms/realtime-backplane.md) shows [one subscriber](../terms/ref-counted-fan-out.md) and each viewer receives the event once. [proof: S51 AS-35]
- **S51.B-11** Given viewers on two instances and none on a third, when an event is published, then both viewers receive it and the third instance is [not subscribed](../terms/ref-counted-fan-out.md). [proof: S51 AS-40]
- **S51.B-12** Given no viewer, when a domain publishes a [replayable event](../terms/replayable-event.md), then the [buffer](../terms/replay-buffer.md) holds it and a later viewer replays it. [proof: S51 AS-33]
- **S51.B-13** Given [the store is down](../terms/realtime-store.md), when a [domain publishes](../terms/realtime-publish.md), then the call resolves [`{ published: false, id: null }`](../terms/realtime-publish.md) in about 1 s. [proof: S51 AS-32]
- **S51.B-14** Given a [viewer](../terms/viewer.md) that stops reading, when a publisher sends 5 MiB, then the [hub](../terms/realtime-hub.md) [closes only that connection](../terms/stream-connection.md). [proof: S51 AS-44]
- **S51.B-15** Given 100 [replayable events](../terms/replayable-event.md) during a [replay](../terms/event-replay.md) with a [buffer limit](../terms/replay-buffer.md) of 10, then the connection stays open and all 100 arrive once in order. [proof: S51 AS-46]
- **S51.B-16** Given the 61st connection within a minute, then the answer is [`429 rate_limited`](../terms/rate-limited.md) and nothing is [subscribed](../terms/realtime-topic.md). [proof: S51 AS-49]
- **S51.B-17** Given a [backplane](../terms/realtime-backplane.md) outage with 3 [replayable events](../terms/replayable-event.md) published, when the connection recovers, then each [viewer](../terms/viewer.md) receives the 3 events once without reconnecting. [proof: S51 AS-66]
- **S51.B-18** Given a [replay read](../terms/event-replay.md) that fails midway, then the connection ends without a [truncated frame](../terms/stream-frame.md) and a [reconnect](../terms/replay-cursor.md) completes the replay. [proof: S51 AS-68]
- **S51.B-19** Given a [revoked connection](../terms/realtime-revoke.md) whose only [topic](../terms/realtime-topic.md) is revoked, then the response ends after the [`revoked` frame](../terms/stream-frame.md). [proof: S51 AS-55]
- **S51.B-20** Given [`revoke`](../terms/realtime-revoke.md) without [`userId`](../terms/realtime-revoke.md), then every [viewer](../terms/viewer.md) of [`shop:X:*`](../terms/realtime-topic.md) receives [`revoked`](../terms/stream-frame.md). [proof: S51 AS-57]

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
- No test carries the ids AS-14, AS-52, AS-53, AS-59, AS-60, AS-61, AS-69 and AS-70. Rules for the lifetime, shutdown drain, in-process subscriber, topic discovery, metrics and logs are unproven.
- AS-14 (reconnect after a baseline) has no test.
- AS-34 and AS-31 are compile-time and validation tests. The proof list has them, but this page states no rule on publish validation or topic types.
- The heartbeat (AS-50) has no tagged test.
- Tests AS-18, AS-12, AS-37 and AS-42 are tagged too. This page lists no rule for AS-12, AS-42, AS-43, AS-62 and AS-64 (grammar), so those are unstated.
- The files list contains legacy code such as `live-batcher.service.ts`. The removal of the legacy Redis relays is not verified.