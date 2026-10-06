# Feature Specification: S51 — Realtime push hub

**Feature Branch**: `S51-realtime-push` (spec directory only; no branch is created by this run)

**Created**: 2026-10-06

**Status**: Draft

**Domain**: `infrastructure` (lib `libs/infrastructure/realtime`, deployed by the SSE gateway app; no table; shared-store key prefix `rt:` owned by this lib per constitution I.4)

**Input**: "Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out"

## Summary

Booking seat maps, auction prices, order and payment status, notifications, import and export progress, courier tracking and the live seller dashboard all need the same thing: "tell user X, or everyone watching topic Y, that something changed, right now, without polling". This capability is that one mechanism, built once for every domain.

It gives the platform:

1. **Topic streams over plain HTTP.** A browser or client opens one long-lived `GET` and names up to ten topics. The server writes events as they happen (Server-Sent Events). One page needs one connection, not one per widget.
2. **Resume without loss or duplicates.** Each replayable event has a position. A client that reconnects after a network drop, a deploy or a sleeping laptop sends the last position it saw, and receives exactly what it missed, then continues live. If too much was missed, it is told to refetch instead of being silently left with a hole.
3. **Authorization per topic, decided by the topic's owner.** The hub knows no business topics. Each domain defines its own topic names and the rule for who may listen. Anything undefined is private. A denial never reveals whether the thing exists.
4. **Cheap fan-out.** One instance holds one backplane subscription per topic however many viewers it has, and holds none for topics nobody on that instance watches. A viewer leaving never disturbs another viewer.
5. **Protection of the server.** Slow readers are dropped, every buffer is bounded, connections per user and per instance are capped, and every long-lived connection ends gracefully and is re-authorized on a schedule.
6. **Control for domains.** Publishing from any process (best effort, validated, atomic with the replay buffer), in-process subscribing for server-side consumers, "which topics have viewers right now" for workers that only produce for watched topics, and **revocation** so a removed shop member stops receiving that shop's events at once.

The hub is a delivery accelerator, not a source of truth. Every domain keeps a REST read that returns the same state, and a client that misses a push can always fetch it.

## Scope

In scope:

- The stream endpoint: wire format, headers, topic validation, credentials, per-topic authorization, replay, heartbeat, limits, lifetime, shutdown.
- The publisher used by every domain, and its validation and failure behaviour.
- The topic registry: how a domain defines a topic route and its policy; startup checks; compile-time topic names.
- Ref-counted fan-out across instances; the in-process subscriber facility; backplane loss and recovery.
- Revocation of open subscriptions; discovery of topics that currently have viewers.
- Metrics and logs of the hub; configuration of its limits.
- Removal of the legacy per-viewer Redis relays (the raw pub/sub lib and the gateway's local copy, once their callers have moved: see `gaps.md`).

Out of scope (owned elsewhere, named so nobody re-specifies them):

- **Which topics exist, their event names and payloads, and who may listen.** Each domain's spec: `user:` (S01 identity), `shop:<id>:live` (S03, published by S40), `shop:<id>:assets` (S31), `auction:` (S21), `queue:` (S22), `delivery:` (S20), `chat:` (S24), `import:` (S07), `order-export:` (S12), `stream:` and the live-comments firehose (S23), flags (S38).
- **Token, session and cookie issuing and validation**: S01. This capability consumes the authenticated principal.
- **The rate-limit engine and the response headers on `429`**: S50. This capability declares one policy into it.
- **Problem+json rendering, graceful-shutdown ordering, metrics registry, configuration validation, proxy and CORS bootstrap**: S54.
- **Consumers of domain events** (for example "member removed → revoke"): the owning domain, using S53's consumer framework. This capability only offers the revocation call.
- **The LLM token stream of the shopping assistant** (`AssistantStreamer`, S46): it is a per-request streamed response, not a topic.
- **The live-comment batcher and sampling** (S23): it consumes this hub through the in-process subscriber.
- **Web client behaviour** (`useEventStream`, reconnect UX): W03, W04, W05. This spec fixes the wire contract they rely on.
- **Sharded pub/sub and multi-region fan-out**: a scale step named in the notes; the hub's contract does not change with it (Assumptions).

## User Scenarios & Testing *(mandatory)*

Actors: **a viewer** (a browser, an anonymous visitor or a signed-in user), **a domain service** (publishes events and defines topics), **a server-side consumer** (a worker that subscribes in process), **an operator** (watches metrics, deploys, scales), **a gateway instance**.

Time in tests: heartbeat, lifetime, stall, drain and retention intervals are configuration values (FR-050), so tests set them to milliseconds and never use fixed sleeps. Tests that wait use polling helpers with a deadline. "Topic `T`" below means any registered test topic; "S" is a gateway instance. Frame examples use the wire format of FR-004.

### User Story 1 - A viewer receives events as they happen (Priority: P1)

A viewer opens one stream for the topics it needs. Events published to those topics arrive in order, each exactly once, each labelled with its topic. Nothing from other topics leaks in.

**Why this priority**: it is the capability. Everything else protects or extends it.

**Independent Test**: open a stream, publish, read frames.

**Acceptance Scenarios**:

1. **AS-01** — **Given** public topic `stream:s1` and **When** a client sends `GET /api/streams?topics=stream:s1` (with `Accept-Encoding: gzip`) and then a domain publishes `comment {"text":"first"}` and `comment {"text":"second"}`, **Then** the response is `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` and **no** `Content-Encoding`; the first frame is `retry: <n>`; then two event frames arrive in publish order, each `event: comment` with `data: {"topic":"stream:s1","data":{"text":"…"}}` and an `id:` cursor of the form `stream:s1~<position>`.
2. **AS-02** — **Given** a signed-in user `U` and public topic `auction:a1`, **When** `U` opens `?topics=auction:a1,user:<U>` and one event is published to each, **Then** both arrive, each frame's `data.topic` names its own topic, and the `id:` of the second frame carries a cursor with **both** topics (`auction:a1~<p1>|user:<U>~<p2>` in either order).
3. **AS-03** — **Given** a viewer of `auction:a1`, **When** an event is published to `auction:a2`, **Then** the viewer receives nothing for 500 ms of polling while an event published to `auction:a1` afterwards arrives.
4. **AS-04** — **Given** the endpoint, **When** each of these requests is sent, **Then** each answers `400` `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `requestId`; code `invalid_topics` or `invalid_query`) and creates no subscription (the backplane shows zero subscribers for the topics named): `topics` missing; `topics=` empty; 11 distinct topics; `user:` (empty id); `USER:abc` (case); `auction:a1:x:y` (too many segments); an id of 65 characters; `auction:a.1` (illegal character); `nosuch:1` (prefix nobody defined); `flags:x` (singleton with an id); `shop:s1:assets` when no route `shop`+`assets` is defined; and `?topics=auction:a1&access_token=abc` or `&ticket=abc` (any query parameter other than `topics`, which also keeps credentials out of URLs and logs).
5. **AS-05** — **Given** `?topics=auction:a1,auction:a1,auction:a1`, **When** one event is published to `auction:a1`, **Then** the viewer receives it once and the instance holds one listener for the connection on that topic.
6. **AS-06** — **Given** a payload that contains `\n\n`, `data: x`, `id: 9`, `event: hack`, a `\r`, U+2028 and a 30 KiB string, **When** it is published and delivered, **Then** the client receives exactly one well-formed frame, whose `data` line is a single line of JSON that parses back to the original payload; no extra field, comment or event is injected.
7. **AS-07** — **Given** a viewer of `chat:c1`, **When** a domain publishes `presence {"userId":"u1"}` with `replay: false` and then `read {"seq":4}` with replay on, then `presence {"userId":"u2"}` with `replay: false` again, **Then** all three arrive in order; the two `presence` frames carry **no** `id:` line and the cursor of the next frame is that of the `read` event; a later reconnect with that cursor does not replay either `presence` event.

### User Story 2 - A reconnecting viewer picks up exactly where it left off (Priority: P1)

Networks drop, deploys roll, tabs sleep. The browser reconnects by itself and sends the last cursor it saw. The server replays what was missed and continues live without a gap and without repeating anything. If the replay window no longer covers what was missed, the viewer is told to refetch.

**Why this priority**: without it a push channel is a lossy toy, and every domain would need polling as a crutch.

**Independent Test**: publish five events, reconnect with the cursor of the second.

**Acceptance Scenarios**:

1. **AS-08** — **Given** five replayable events published to `auction:a1` with prices 1..5 and the client having seen up to price 2 (cursor `auction:a1~<id2>`), **When** it reconnects with `Last-Event-ID: auction:a1~<id2>`, **Then** it receives prices 3, 4, 5 in order, the `id:` of the last frame is `auction:a1~<id5>`, and an event published afterwards arrives live.
2. **AS-09** — **Given** 200 stored events and a client reconnecting from the first one, **When** a publisher publishes 50 more events to the same topic **while** the replay is being written, **Then** the client receives 249 events (events 2..250): ids strictly increasing, no id twice, none missing.
3. **AS-10** — **Given** the replay buffer holds 1,000 events (more than one replay page) and the client's cursor is the first of them, **When** it reconnects, **Then** all 999 later events are delivered in order; replay is never silently cut at a page boundary.
4. **AS-11** — **Given** the same `Last-Event-ID` sent twice by two reconnects with no publishing in between, **Then** both receive an identical sequence (same ids, same data); replaying consumes nothing and changes no stored state.
5. **AS-12** — **Given** topics `auction:a1` and `auction:a2` with cursor `auction:a1~<x2>|auction:a2~<y1>` and five stored events on each, **When** the client reconnects asking for both, **Then** it receives `a1` events 3..5 and `a2` events 2..5 and nothing else; per topic the order is the publish order.
6. **AS-13** — **Given** topics `auction:a1` and `auction:a2` with 3 events already stored on `a2` and none on `a1`, **When** a client connects for the first time (no `Last-Event-ID`), **Then** it receives **no** data event, and receives a baseline frame (an `id:` with no event) whose cursor names every requested topic that has a stored position (`auction:a2~<last>`); history from before the first connection is not delivered.
7. **AS-14** — **Given** the client of AS-13 disconnects, and 2 events are published to `auction:a2` while it is away, **When** it reconnects with the cursor it last received, **Then** it receives exactly those 2 events.
8. **AS-15** — **Given** the header `Last-Event-ID` is: `garbage`; `auction:a1~abc`; `auction:a1~1-1|auction:a1~2-2` (duplicate entries: the first wins); an entry for a topic that was not requested; an entry for an unknown topic; an id whose time part is more than one minute in the future; an empty string; or longer than 2,048 characters, **When** the client connects, **Then** the connection opens with `200` and each unusable entry is ignored (the whole header when too long); the topic behaves as in a first connection (AS-13); no error is returned and each ignored entry increments the ignored-cursor counter.
9. **AS-16** — **Given** a topic whose replay buffer was trimmed so that at least one event after the client's cursor no longer exists, **When** the client reconnects with that cursor, **Then** it receives one `event: resync` frame `data: {"topic":"<T>","data":{"reason":"replay-gap"}}` for that topic, no partial replay of the topic, then live events; the cursor in the following frames starts from the topic's latest position; other topics in the same connection replay normally.
10. **AS-17** — **Given** a cursor whose time part is older than the retention age, and the topic's buffer has expired entirely (empty), **When** the client reconnects, **Then** it receives the same `resync` frame (`reason: "replay-gap"`), because the hub cannot prove nothing was lost.
11. **AS-18** — **Given** a cursor equal to the topic's latest position, **When** the client reconnects, **Then** no replayed event and no `resync` is sent, and the next published event arrives live.
12. **AS-19** — **Given** a viewer whose cursor for `auction:a1` is `<p5>`, **When** a message with position `<p3>` (stale, or the same `<p5>` again) reaches the instance from the backplane, **Then** it is not written to the viewer; per topic, delivered positions are strictly increasing.
13. **AS-20** — **Given** retention of 1,000 events and one hour, **When** 2,500 replayable events are published to one topic, **Then** the buffer keeps at least the newest 1,000 and at most 1,200 events, and its remaining lifetime is greater than zero and at most the retention age; an event published with `replay: false` creates or changes no buffer; a topic with no publishes for the retention age has no buffer left (checked through the remaining lifetime, not by waiting).

### User Story 3 - Only the right people hear a topic (Priority: P1)

A topic's owner decides who may subscribe. The hub asks the owner's rule once per topic per connection, treats any doubt as "no", and answers in a way that gives nothing away.

**Why this priority**: topics carry private data (orders, payments, shop activity). A cross-user leak is the worst failure of this capability.

**Independent Test**: two users, one private topic.

**Acceptance Scenarios**:

1. **AS-21** — **Given** topic `user:<A>` whose rule is "only user A", **When** A connects with a valid credential, **Then** `200`; **When** user B (valid credential) connects for `user:<A>`, **Then** `403` problem+json; **When** an anonymous client connects, **Then** `401` problem+json; in both refusals no subscription is created and an event published to `user:<A>` reaches nobody.
2. **AS-22** — **Given** public topic `auction:a1` (its rule admits everyone), **When** an anonymous client connects, **Then** `200` and it receives events.
3. **AS-23** — **Given** `?topics=auction:a1,user:<A>` sent by B, **Then** `403`, **and** nothing is subscribed (not even `auction:a1`): a connection is accepted for all requested topics or none, and no event is ever delivered on a refused connection.
4. **AS-24** — **Given** shop `S1` (exists, B is not a member) and shop `S2` (does not exist), **When** B asks for `shop:S1:live` and for `shop:S2:live`, **Then** both answers have the same status (`403`), the same `type`, `title`, `detail` and headers (only `instance` and `requestId` differ), and `detail` does not name the topic or say whether it exists.
5. **AS-25** — **Given** a topic whose rule is asynchronous and consults another domain's exported service with the viewer's user id (an R1 call, for example "current member of the shop with the required permission"), **When** it takes 300 ms to answer, **Then** the connection waits, then admits or refuses by the answer; the rule received `viewer.userId`, `viewer.roles`, the topic, its id and its suffix.
6. **AS-26** — **Given** a topic whose rule throws, or does not answer within 2 s, **When** a client connects, **Then** the response is `503` problem+json with a generic `detail`, code `realtime_policy_unavailable`, `Retry-After`; nothing is subscribed; the error is logged with the requestId and counted; the client does **not** get `403` (an outage is not a verdict).
7. **AS-27** — **Given** `?topics=auction:a1,auction:a2` and counting rule, **When** the client connects and ten events are delivered, **Then** each rule ran exactly once for its topic (2 calls in total): rules run on admission, never per event.
8. **AS-28** — **Given** a client presents an expired, tampered or wrong-audience credential (bearer or session cookie), **When** it asks for a public topic, **Then** `401` (it is **not** treated as anonymous), so the client knows to refresh; a valid cookie and a valid `Authorization: Bearer` header are each accepted.

### User Story 4 - A domain publishes with one call, and a failure never breaks its business flow (Priority: P1)

Any process can publish an event to a topic. The call validates what it is given, writes the replay buffer and the live fan-out as one step with one identity, and, because the push is only a convenience, a store problem never throws into the caller's business operation.

**Why this priority**: twelve capabilities publish after their own commits; a publisher that throws or lies would corrupt their flows or their clients.

**Independent Test**: call `publish` against the real store.

**Acceptance Scenarios**:

1. **AS-29** — **Given** a viewer of `auction:a1`, **When** a domain calls `publish('auction:a1', 'price', {price: 7})`, **Then** the call resolves `{ published: true, id: <p> }`; the viewer's frame carries cursor `auction:a1~<p>` with the same `<p>`; a reconnect from the cursor before it replays that same event with the same `<p>`.
2. **AS-30** — **Given** 200 `publish` calls issued in parallel to one topic from two processes, **Then** the 200 returned ids are distinct and strictly ordered; a viewer receives all 200 in id order exactly once; a replay from the start returns the same 200.
3. **AS-31** — **Given** each of: a topic that breaks the grammar; an event type that is empty, longer than 64 characters, contains a space, a newline, an upper-case letter, or is one of the reserved names `open`, `error`, `resync`, `revoked`; a payload whose serialized form exceeds 32 KiB; a payload that cannot be serialized (circular, `BigInt`); `undefined` data, **When** `publish` is called, **Then** it rejects before touching the store with a typed error (`InvalidRealtimeTopicError`, `InvalidRealtimeEventTypeError`, `RealtimePayloadTooLargeError`, `InvalidRealtimePayloadError`), the store holds nothing new, and valid names such as `payment.status`, `delivery_offer`, `assets.changed` are accepted.
4. **AS-32** — **Given** the store is unreachable, or answers later than 1 s, **When** a domain calls `publish`, **Then** it resolves within about 1 s with `{ published: false, id: null }`, does not throw, makes exactly one attempt (no retry), logs a warning with the requestId and the topic, and increments the publish-failure counter; the caller's surrounding flow completes.
5. **AS-33** — **Given** no viewer anywhere, **When** a domain publishes a replayable event, **Then** `{ published: true, id }`, the replay buffer holds it, and no subscription or other residue exists in the hub; a viewer connecting later with a cursor older than it receives it (AS-08).
6. **AS-34** — **Given** the compile step, **Then** `publish` and the in-process subscriber accept only topics whose prefix some domain declared in the shared topic type; a topic for an undeclared prefix, or a string without the `<prefix>:<id>` shape, fails to compile (a type-level test with `@ts-expect-error`), and each domain's topic builder returns a typed topic.

### User Story 5 - Fan-out costs track viewed topics, and viewers cannot disturb each other (Priority: P1)

An instance subscribes to the backplane once per topic that has local viewers, and stops when the last one leaves. A viewer leaving, crashing or being slow affects nobody else.

**Why this priority**: it is what lets one instance hold tens of thousands of idle connections, and the old payment stream's bug (the second viewer stopped receiving when the first left) must not exist here.

**Independent Test**: connect many viewers to one topic, disconnect some.

**Acceptance Scenarios**:

1. **AS-35** — **Given** 100 viewers of `auction:a1` on one instance, **Then** the backplane shows exactly one subscriber for that topic's channel from that instance; **When** one event is published, **Then** every viewer receives it once.
2. **AS-36** — **Given** viewers A and B of `auction:a1` on one instance, **When** A disconnects, **Then** B still receives the next event and the channel stays subscribed; **When** B also disconnects, **Then** the channel is unsubscribed (zero subscribers).
3. **AS-37** — **Given** a topic nobody on the instance watches, **When** 50 connections ask for it at the same moment (`Promise.all`), **Then** one backplane subscribe command is issued, and every one of the 50 connections is admitted only after that subscription is confirmed: an event published right after the last baseline frame is received by all 50.
4. **AS-38** — **Given** the backplane refuses the subscribe (store down), **When** a client connects, **Then** `503` problem+json (`realtime_unavailable`, `Retry-After`) and the instance keeps **no** entry for the topic; after the store recovers, the next client connects and receives events (no dead topic remains).
5. **AS-39** — **Given** a server-side subscription whose release function is called twice, **Then** the count decreases once; other listeners of the topic keep receiving.
6. **AS-40** — **Given** instances S1 and S2 each with a viewer of `auction:a1`, and S3 with none, **When** an event is published from a fourth process, **Then** both viewers receive it once; the backplane shows two subscribers for the channel and S3 is not among them.
7. **AS-41** — **Given** two in-process listeners on one topic, one of which throws on every message, **When** an event is published, **Then** the other still receives it, the exception is logged and counted, the throwing listener stays subscribed, and no connection is closed because of it.
8. **AS-42** — **Given** 500 connect-then-close cycles and 100 abrupt client aborts (some during connect, some during replay), **Then** afterwards: open connections 0, listeners 0, backplane subscribers 0, no heartbeat or lifetime timer pending, no unhandled rejection and no write after end.
9. **AS-43** — **Given** a client that aborts while its replay (1,000 events) is being written, **Then** replay stops at once, nothing more is written, and the subscription is released.

### User Story 6 - Slow or greedy clients cannot hurt the instance (Priority: P1)

Memory per connection is bounded. A client that cannot keep up is dropped and reconnects to replay. One user cannot open unlimited connections, and an instance sheds load before it falls over.

**Why this priority**: 50,000 held-open connections per instance only works if the worst one is bounded.

**Independent Test**: a client that never reads; 21 connections for one user.

**Acceptance Scenarios**:

1. **AS-44** — **Given** a viewer that stops reading and a publisher that sends 5 MiB to its topic, **Then** the server closes that connection when more than 1 MiB is pending for it (configurable), buffered output never exceeds that bound plus one frame, the dropped counter (reason `slow`) increases by 1, healthy viewers of the same topic lose nothing, and a reconnect with the last cursor replays what the retained buffer holds.
2. **AS-45** — **Given** a connection whose write is blocked for longer than the stall limit (30 s; 400 ms in tests) while under the byte bound, **Then** it is closed with reason `stalled`.
3. **AS-46** — **Given** a replay in progress (buffer limit set to 10 for the test) and 100 replayable events published during it, **Then** the connection is not closed; the live messages beyond the bound are discarded from memory and the replay continues until it reaches the end of the buffer, so all 100 arrive once, in order; live-only events in that window are not delivered (documented loss), and the overflow counter increases.
4. **AS-47** — **Given** user `U` holding 20 open connections, **When** the 21st is attempted, **Then** `429` problem+json `too_many_connections` with `Retry-After: 5`; closing one connection frees a slot for the next attempt; anonymous clients are capped at 10 per client address (the address resolved by the platform proxy rules); another user is not affected.
5. **AS-48** — **Given** an instance at its connection limit (3 in the test), **When** a new connection arrives, **Then** `503` problem+json `realtime_capacity` with `Retry-After` between 1 and 5 seconds (jittered), existing connections keep receiving, and the capacity-refusal counter increases; after one closes, a new one is accepted.
6. **AS-49** — **Given** the connect-rate policy `realtime.connect` (60 new connections per minute per user or address), **When** a client opens a 61st connection within the minute, **Then** `429` problem+json `rate_limited` with the standard rate-limit headers, and nothing is subscribed; when the limiter itself is down, connections are admitted (the policy fails open).

### User Story 7 - Connections are kept alive, spread out, and always end cleanly (Priority: P2)

Idle connections survive proxies. Reconnect storms are spread. Every connection has a bounded life after which the client re-authenticates, and a deploy drains instances without a stampede.

**Why this priority**: operational correctness for the scale target, and the bound on how long a stale authorization can last.

**Independent Test**: idle connection, short lifetime, shutdown signal.

**Acceptance Scenarios**:

1. **AS-50** — **Given** an idle connection and a heartbeat interval of 100 ms (15 s in production), **Then** at least two comment frames `: ping` arrive within 250 ms, a client that parses events receives none of them as events, and after the client closes no timer remains.
2. **AS-51** — **Given** 200 connections opened, **Then** the `retry:` value of every first frame is an integer from 2000 to 5000 inclusive, and the 200 values are not all equal.
3. **AS-52** — **Given** a connection lifetime of 1 s (30 min in production), **When** it elapses, **Then** the server ends the response normally (a complete final frame, then end of stream); a browser-style reconnect with the last cursor loses nothing (AS-08 semantics); **and Given** a principal whose credential expires sooner than the lifetime, **Then** the connection ends at that expiry, and the reconnect then answers `401`.
4. **AS-53** — **Given** a gateway instance receiving the shutdown signal while 100 connections are open, **Then** readiness turns failing first (S54), connections are then ended spread over the drain window (at most 10 s; 1 s in tests) rather than all at once, every frame on the wire is complete, every subscription is released, and the backplane connection is closed last.

### User Story 8 - Removing someone's access ends their stream (Priority: P1)

When a domain withdraws a person's right to a topic (a member removed from a shop), their open connections must stop receiving it, on whichever instance holds them, without waiting for a reconnect.

**Why this priority**: "new connections are refused" is not enough: access that continues after removal is a leak.

**Independent Test**: open a stream, revoke, publish.

**Acceptance Scenarios**:

1. **AS-54** — **Given** user `U` connected on instance S1 to `shop:X:live`, `shop:X:assets` and `auction:a1`, and member `V` connected to `shop:X:live`, **When** a domain calls `revoke({ userId: U, prefix: 'shop', id: 'X' })` on a **different** instance S2, **Then** within 2 s `U` receives `event: revoked` `data: {"topic":"shop:X:live","data":{}}` and the same for `shop:X:assets`; events published to those topics afterwards do not reach `U`; `auction:a1` continues; `V` is unaffected.
2. **AS-55** — **Given** a connection whose only topic is revoked, **Then** after the `revoked` frame the response ends normally and its subscriptions are released.
3. **AS-56** — **Given** a connection being admitted whose rule is still running (held open by the test), **When** `revoke` for that user and topic is called during the wait and the rule then returns "allowed", **Then** the topic ends up revoked: the client receives `revoked` for it and no event of it; a revocation arriving during admission is never lost.
4. **AS-57** — **Given** `revoke({ prefix: 'shop', id: 'X' })` without `userId`, **Then** every viewer of `shop:X:*` on every instance receives `revoked`.
5. **AS-58** — **Given** a revoked user whose rule still admits them, **When** they reconnect, **Then** the connection is admitted: revoke closes what is open, it does not ban; refusing new connections is the rule's job (S03).

### User Story 9 - Server-side code can listen and can ask who is watching (Priority: P2)

A worker in the same codebase subscribes to a topic in process through the same ref-counted mechanism, and a producer that only wants to produce for watched topics can list which topics currently have viewers.

**Why this priority**: S23's comment batcher and S40's dashboard ticker need it; both would otherwise reach into Redis directly.

**Independent Test**: subscribe in process, list topics.

**Acceptance Scenarios**:

1. **AS-59** — **Given** an in-process `subscribe('stream:s1', handler)`, **When** events are published (one replayable, one with `replay: false`), **Then** the handler receives both as `{ id, topic, type, data }` (`id` is `'0-0'` for the live-only one) after it was registered; **When** the returned release function is called, **Then** it receives nothing more; one HTTP viewer plus one in-process subscriber on the same instance share one backplane subscription.
2. **AS-60** — **Given** viewers of `shop:A:live`, `shop:B:live` and `shop:B:assets` spread over two instances, **When** a worker asks `topicsWithSubscribers('shop', 'live')`, **Then** it gets exactly `['shop:A:live', 'shop:B:live']` (sorted), never the `assets` topic; after the last viewer of `shop:A:live` leaves, it no longer appears within 1 s.
3. **AS-61** — **Given** a cap of 3 results (10,000 in production) and 5 matching topics, **Then** the first 3 in sorted order are returned and a warning is logged; **Given** the store is unreachable, **Then** the call rejects with `RealtimeUnavailableError` within the 1 s timeout (the caller chooses its own fallback).

### User Story 10 - Topics are defined by their owners, safely (Priority: P1)

Each domain defines the topic routes it owns and the rule for each. Two domains can share a prefix with different suffixes. A mistake is caught at startup, not in production traffic.

**Why this priority**: it is how the hub stays free of business names (X.3) and private by default.

**Independent Test**: boot with one, two and conflicting definitions.

**Acceptance Scenarios**:

1. **AS-62** — **Given** definitions `order-export` (no suffix), `shop` with suffix `live` (tenancy) and `shop` with suffix `assets` (assets), **Then** `order-export:<uuid>` is valid (a hyphen is allowed in a prefix); `shop:X:live` uses only the tenancy rule and `shop:X:assets` uses only the assets rule; `shop:X` (bare) and `shop:X:other` are invalid (`400`).
2. **AS-63** — **Given** two definitions of the same route (same prefix and same suffix, or same prefix both bare), **When** the application boots, **Then** boot fails with an error naming both owners; rules are never combined with "or".
3. **AS-64** — **Given** a singleton definition `flags` (the bare topic), **Then** `flags` is valid and `flags:x` is not; **Given** a definition with an upper-case prefix, an illegal suffix, a prefix longer than 32 characters, a missing rule or an empty suffix list, **Then** boot fails naming the offending definition.
4. **AS-65** — **Given** the application has finished starting, **When** code calls `define`, **Then** it throws `TopicRegistryFrozenError`; definitions are made only while modules initialize.

### User Story 11 - A lost or restarted backplane heals without clients noticing (Priority: P1)

The backplane (Redis pub/sub) can drop its connection. Open viewers must not be left with a silent hole.

**Why this priority**: the client's connection is still healthy, so it will never reconnect on its own; the server must close the gap itself.

**Independent Test**: kill the subscriber connection while viewers are open.

**Acceptance Scenarios**:

1. **AS-66** — **Given** open viewers of replayable topic `auction:a1`, **When** the hub's backplane connection is killed, 3 replayable events and 1 live-only event are published during the outage, and the connection recovers, **Then** every viewer receives the 3 replayable events exactly once, in order, without reconnecting (the live-only event is lost, with no error frame), and later live events continue.
2. **AS-67** — **Given** the backplane is down when a client connects, **Then** `503` (AS-38 behaviour); no half-open stream is returned.
3. **AS-68** — **Given** the replay read fails midway (store error), **Then** the connection ends without a truncated frame, the failure is logged and counted, and the client's reconnect with its last cursor completes the replay.

### User Story 12 - Operators can see the hub (Priority: P2)

**Why this priority**: scale and security claims need numbers; failures must be diagnosable without reading client logs.

**Independent Test**: scrape the metrics registry after a scenario run.

**Acceptance Scenarios**:

1. **AS-69** — **Given** a run that opens, drops, rejects, publishes and replays, **Then** the metrics registry shows (names in FR-054): the connection gauge returns to 0; counters moved exactly as the scenario implies (events delivered, publish ok and failed, dropped by reason, refused by reason, resyncs, revocations, ignored cursors, listener errors, policy faults); the delivery-latency histogram has a sample per delivered event; label values come only from the closed lists in FR-054 (never a topic id, user id or cursor).
2. **AS-70** — **Given** any connection, **Then** a structured JSON log line is written at open (`requestId`, topic count, principal kind, instance) and at close (`requestId`, duration, events delivered, reason); no line contains a cookie, bearer token, `Last-Event-ID` value or event payload.

### Edge Cases

- A client that connects, reads the baseline, and never sends anything: it receives heartbeats until its lifetime ends (AS-50, AS-52).
- A topic with 10,000 viewers on one instance and a 31 KiB payload: each viewer's frame is written separately; bounded per-connection memory is AS-44's guarantee, not a hub-level queue.
- Cursor names a topic the viewer is no longer allowed to read: the rule is evaluated on every connection (AS-27), so a topic that is now refused refuses the whole connection (AS-23); stored events are never replayed to a viewer the rule has not admitted.
- Two tabs of one user each open a connection: each is separate and counted against the per-user cap (AS-47); the browser's HTTP/1.1 limit of six connections per site is the client's concern: a page uses one connection for all its topics (FR-008).
- Event ids from different topics are not comparable; the cursor is a per-topic map (FR-005).
- Clock skew between instances: positions come from the store, never from an instance clock; instance clocks are used only for lifetimes and the future-cursor check with one minute of tolerance (AS-15).
- A replay buffer entry that cannot be parsed (corrupted): the entry is skipped, counted and logged, and the stream continues (FR-014).
- Publishing during a deploy when the gateway has zero instances: events are stored for replay (AS-33) and viewers resume when new instances start.

## Requirements *(mandatory)*

### Functional Requirements

**Stream endpoint and wire format**

- **FR-001**: The hub MUST serve `GET /api/streams?topics=<t1>,<t2>,…` as the only way for a client to subscribe. It MUST accept exactly one query parameter, `topics` (comma-separated, spaces trimmed, empty items dropped), and answer `400` for any other parameter, so credentials are never carried in the URL (AS-04).
- **FR-002**: A successful response MUST carry `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, and MUST NOT be compressed or buffered even when the application otherwise compresses responses (AS-01).
- **FR-003**: The first frame MUST be `retry: <n>` with `n` drawn uniformly from 2000 to 5000 per connection, so a fleet-wide disconnect does not reconnect in lockstep (AS-51).
- **FR-004**: An event MUST be written as `[id: <cursor>\n]event: <type>\ndata: <json>\n\n`, where `<json>` is a single line `{"topic": <topic>, "data": <payload>}`. The serialization MUST escape every character that could end the line or the frame, so a payload cannot inject fields or events (AS-06). The event type is exactly the type the domain published.
- **FR-005**: Every replayable event MUST carry an `id:` whose value is the connection's cursor: for each topic that has delivered or been baselined, `<topic>~<position>`, joined by `|`, where `<position>` is the topic's per-topic, strictly increasing position in the store (AS-02). Events published with `replay: false` MUST carry no `id:` and MUST NOT change the cursor (AS-07).
- **FR-006**: On a connection with no usable cursor entry for a requested topic, after subscribing and before going live, the hub MUST send a baseline frame (an `id:` line and no event) naming each requested topic that has a stored position, and MUST NOT deliver stored history (AS-13, AS-14).
- **FR-007**: A request that cannot be served MUST fail **before** the stream starts with an RFC 9457 problem (`type`, `title`, `status`, `detail`, `instance`, `requestId`; V.3), with codes: `invalid_topics` and `invalid_query` (400), `unauthenticated` (401), `forbidden` (403), `too_many_connections` and `rate_limited` (429), `realtime_policy_unavailable`, `realtime_unavailable`, `realtime_capacity` (503). Once the stream has started, problems are signalled only in band (`resync`, `revoked`) or by ending the response. `5xx` details are generic (AS-04, AS-21, AS-26, AS-38, AS-47, AS-48, AS-49).
- **FR-008**: A connection MUST accept 1 to 10 distinct topics. Duplicates MUST collapse into one subscription (AS-04, AS-05).
- **FR-009**: Reserved in-band events (never publishable): `resync` with `data: {"topic":"<T>","data":{"reason":"replay-gap"}}` (FR-017) and `revoked` with `data: {"topic":"<T>","data":{}}` (FR-039). `open` and `error` are reserved because they collide with built-in browser event names (AS-31).

**Credentials and per-topic authorization**

- **FR-010**: A client authenticates with the platform session cookie (browsers, `EventSource` with credentials) or `Authorization: Bearer`. A presented but invalid, expired or wrongly scoped credential MUST answer `401`, even for public topics. No credential means anonymous, which is allowed only where every requested topic's rule admits it (AS-21, AS-22, AS-28).
- **FR-011**: A topic route's rule MUST be allowed to be asynchronous and MUST receive `(viewer, topic, id, suffix)` where `viewer = { userId?, roles }` comes from the authenticated principal only, never from the request. Rules run once per requested topic per connection, on admission, never per event (AS-25, AS-27). A rule that throws or exceeds 2 s MUST yield `503 realtime_policy_unavailable`, never `403` and never admission (AS-26).
- **FR-012**: A connection MUST be admitted for all requested topics or none: any refused topic refuses the connection (AS-23). Refusal status: anonymous viewer → `401`; authenticated viewer → `403`. The `403` body MUST be identical for "not yours" and "does not exist" and MUST NOT name the topic (AS-24).
- **FR-013**: A topic route that no domain defined MUST be unsubscribable (`400`); a new topic type is private until its owner defines a rule (AS-04).

**Replay and delivery guarantees**

- **FR-014**: To resume, the hub MUST subscribe to the live channel first and buffer live messages, then replay every stored event after the cursor in pages until it reaches the end of the stored buffer, then flush the buffered messages, skipping any whose position is not greater than the topic's cursor. The result per topic: no gap, no duplicate, strictly increasing positions (AS-08, AS-09, AS-10). A stored entry that cannot be parsed MUST be skipped, logged and counted without ending the connection.
- **FR-015**: Replay MUST be read-only and repeatable (AS-11). A cursor entry for each requested topic is used independently (AS-12).
- **FR-016**: A `Last-Event-ID` entry is usable only if its topic was requested, its position has valid shape and is not more than one minute in the future; the first entry for a topic wins; a header longer than 2,048 characters is ignored whole; unusable entries are ignored, counted, and never produce an error (AS-15).
- **FR-017**: If the hub cannot prove that no event after the cursor was lost (the buffer was trimmed past it, expired, or the cursor is older than the retention age), it MUST send one `resync` for that topic instead of a partial replay and continue from the topic's latest position (AS-16, AS-17). A cursor equal to the latest position replays nothing and sends no `resync` (AS-18).
- **FR-018**: A live message whose position is not greater than the connection's cursor for its topic MUST be dropped (AS-19). Live-only messages are not subject to this check (AS-07).
- **FR-019**: Delivery is **at most once for live-only events and exactly once, in order, for replayable events within the retention window** while a client keeps resuming; beyond it the client is told to refetch (FR-017). No event is ever delivered on a connection the rule did not admit.
- **FR-020**: The replay buffer MUST keep at least the newest 1,000 events per topic and at most 1,200, discard events older than the retention age (one hour), and expire as a whole when the topic is idle for the retention age. `replay: false` events MUST never be stored (AS-20, AS-07).

**Publisher**

- **FR-021**: The hub MUST export `publish(topic, type, data, options?: { replay?: boolean })` (default `replay: true`) resolving `{ published: boolean, id: string | null }`. It MUST validate before touching the store: topic grammar (FR-049), event type `^[a-z][a-z0-9_.-]{0,63}$` and not reserved (FR-009), serialized payload at most 32 KiB, serializable data. Violations MUST reject with `InvalidRealtimeTopicError`, `InvalidRealtimeEventTypeError`, `RealtimePayloadTooLargeError` or `InvalidRealtimePayloadError` (AS-31).
- **FR-022**: Storing the event in the replay buffer and announcing it to live subscribers MUST be one atomic step that yields one position, so a live viewer never sees a position the buffer lacks, and per-topic order is the same live and in replay (AS-29, AS-30). A live-only publish skips the buffer.
- **FR-023**: Publishing is best effort. A store fault or a store answer later than 1 s MUST resolve `{ published: false, id: null }` after exactly one attempt (retries belong to no layer here: the REST state is the truth), log a warning and count a failure; it MUST NOT throw into the caller (AS-32). Publishing with nobody listening MUST succeed (AS-33).
- **FR-024**: Topic types MUST be checked at compile time: the set of known prefixes is an augmentable type, topics are template-literal types over it, and each domain exports typed builders (AS-34).

**Fan-out**

- **FR-025**: The hub MUST hold at most one backplane subscription per topic per instance, created when the first local listener (HTTP viewer or in-process subscriber) arrives and removed when the last leaves (AS-35, AS-36, AS-59).
- **FR-026**: Admission MUST wait until the subscription is confirmed. Concurrent first listeners MUST share one subscribe command (AS-37). A failed subscribe MUST leave no state behind (AS-38). Releasing a listener MUST be idempotent (AS-39).
- **FR-027**: A listener's failure MUST NOT stop delivery to other listeners or close their connections (AS-41).
- **FR-028**: Every per-connection and per-topic structure MUST be bounded and released on close, abort, drain or drop, wherever the close arrives from (including during connect and during replay) (AS-42, AS-43).
- **FR-029**: Delivery works across instances: only instances with local listeners subscribe, and each delivers to its own viewers once (AS-40).

**Protection**

- **FR-030**: Pending output per connection MUST be bounded (default 1 MiB). A connection over the bound MUST be closed and counted (`slow`); healthy connections are unaffected (AS-44).
- **FR-031**: A connection whose write stays blocked longer than the stall limit (default 30 s) MUST be closed and counted (`stalled`) (AS-45).
- **FR-032**: The messages buffered while a replay runs MUST be bounded (default 1,000). On overflow the hub MUST discard them and let the replay continue to the end of the buffer instead of closing the connection (AS-46).
- **FR-033**: An authenticated user MUST NOT hold more than 20 connections at once, and an anonymous client address no more than 10, per instance; excess answers `429 too_many_connections` with `Retry-After: 5` (AS-47).
- **FR-034**: An instance MUST refuse new connections beyond its configured maximum with `503 realtime_capacity` and a jittered `Retry-After` of 1 to 5 seconds (AS-48).
- **FR-035**: The hub MUST declare the rate policy `realtime.connect` into S50: 60 new connections per minute per user-or-address, fail open (AS-49).

**Lifecycle**

- **FR-036**: A heartbeat comment frame `: ping` MUST be written every heartbeat interval (default 15 s) to every idle connection and its timer MUST be cleared on close (AS-50).
- **FR-037**: A connection MUST end normally at the earlier of its maximum lifetime (default 30 min) and the principal's credential expiry when the principal supplies one (S01 contract), after a complete final frame (AS-52).
- **FR-038**: On shutdown the hub MUST end connections spread across a drain window (default at most 10 s), never writing a partial frame, release subscriptions, and close the backplane connection last (AS-53).

**Revocation and discovery**

- **FR-039**: The hub MUST export `revoke({ userId?, prefix, id, suffix? })`. It MUST end, fleet-wide, every matching open subscription (all suffixes of `prefix:id` when `suffix` is omitted, all users when `userId` is omitted), sending `revoked` per topic; the connection continues with its remaining topics, or ends when none remain (AS-54, AS-55, AS-57). Effect within 2 s on every instance.
- **FR-040**: A revocation that arrives while a connection is still being admitted MUST apply to it (AS-56). Revocation does not forbid reconnecting (AS-58). Revocation is best effort over the backplane; the connection lifetime (FR-037) bounds the worst case when a notice is missed.
- **FR-041**: The hub MUST export `subscribe(topic, handler): Promise<() => Promise<void>>` for in-process listeners, receiving `{ id, topic, type, data }`, sharing the ref-counted subscription of FR-025 (AS-59).
- **FR-042**: The hub MUST export `topicsWithSubscribers(prefix, suffix?)` returning, sorted, the topics of that route that have at least one listener on any instance, capped at 10,000 (warning logged when capped), and rejecting `RealtimeUnavailableError` within 1 s when the store is unreachable (AS-60, AS-61).

**Registry**

- **FR-043**: A route is a (prefix, suffix) pair; `define({ prefix, suffixes?, singleton?, owner?, policy })` registers one route per listed suffix, or the bare `<prefix>:<id>` route when no suffix is listed, or the bare `<prefix>` when `singleton` is set. Grammar: prefix `^[a-z][a-z-]{0,31}$`; suffix the same; id `^[A-Za-z0-9_-]{1,64}$` (AS-62, AS-64).
- **FR-044**: A route defined twice MUST fail the boot naming both owners; an invalid definition MUST fail the boot naming it; rules of different definitions are never combined (AS-63, AS-64).
- **FR-045**: The registry MUST freeze when the application has started; later `define` calls throw `TopicRegistryFrozenError` (AS-65).

**Backplane faults**

- **FR-046**: After the backplane connection is lost and restored, every open connection MUST catch up the replayable events it missed from its cursor, exactly once and in order, without the client reconnecting (AS-66).
- **FR-047**: With the backplane unavailable, new connections MUST be refused with `503 realtime_unavailable` (AS-38, AS-67). A replay read that fails midway MUST end the connection cleanly so the client resumes (AS-68).

**Observability, configuration, boundaries**

- **FR-048**: The hub MUST emit the metrics of FR-054 and the logs of FR-055 (AS-69, AS-70).
- **FR-049**: A topic is `<prefix>:<id>[:<suffix>]` or a bare singleton `<prefix>` under FR-043's grammar; no other shape is a topic.
- **FR-050**: Limits and intervals named in this spec (heartbeat, lifetime, stall, drain, buffer bounds, caps, retention, page size, policy and publish timeouts) MUST be configuration with the defaults stated here, validated at startup (out-of-range values fail the boot; VIII.5).
- **FR-051**: The stream endpoint and its engine MUST live in this capability's lib and be hosted by the gateway app, which contains only bootstrap and composition (I.5, X.1). The hub MUST contain no domain topic names (X.3).
- **FR-052**: The shared-store keys of the hub MUST live under the prefix `rt:` owned by this lib (I.4); no other module reads or writes them. The raw pub/sub lib and the gateway's local copy MUST be removed once nothing imports them.
- **FR-053**: The request and response shapes of the endpoint (`topics` query, event envelope `{topic, data}`, `resync` and `revoked` payloads, the cursor format) MUST be zod schemas in `packages/contracts` (V.2) used by the e2e specs (VII.6) and by the web client.

**Metrics and logs**

- **FR-054**: Metrics (labels are closed sets): `realtime_connections` (gauge); `realtime_topic_subscriptions` (gauge); `realtime_events_delivered_total{kind="replayable|live_only|replayed"}`; `realtime_publish_total{result="ok|failed|rejected"}`; `realtime_connections_closed_total{reason="client|slow|stalled|lifetime|shutdown|revoked|error"}`; `realtime_connections_refused_total{reason="invalid|unauthenticated|forbidden|too_many|rate_limited|policy_unavailable|unavailable|capacity"}`; `realtime_resync_total`; `realtime_revocations_total`; `realtime_cursor_ignored_total`; `realtime_listener_errors_total`; `realtime_replay_overflow_total`; `realtime_delivery_latency_seconds` (histogram, publish to write).
- **FR-055**: Logs are structured JSON with `requestId` (VIII.1). Open: topic count, principal kind (`user|anonymous`), instance. Close: duration, events delivered, reason. Warnings for publish failures, policy faults, listener errors, capped discovery. Cookies, tokens, cursors and payloads are never logged.

### Key Entities

- **Topic**: a named channel, `<prefix>:<id>[:<suffix>]` or a bare singleton. Owned by one route definition.
- **Route definition**: (prefix, suffix or bare, rule, owner). The rule answers "may this viewer listen". One per route.
- **Viewer**: the authenticated principal (`userId`, `roles`) or anonymous.
- **Connection**: one open HTTP response with up to 10 topics, a cursor, a lifetime and bounded buffers.
- **Event**: `{ id, topic, type, data }`; replayable events have a position `id`; live-only events have none.
- **Cursor**: the per-topic map of last delivered positions, sent as `id:` and returned as `Last-Event-ID`.
- **Replay buffer**: the short per-topic history (newest 1,000 to 1,200 events, at most one hour old).
- **Subscription**: the instance's single backplane interest in a topic, shared by all local listeners.
- **Revocation notice**: `{ userId?, prefix, id, suffix? }` sent fleet-wide.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An instance holds **50,000 idle connections** and a publisher sustains **5,000 events per second** to them; at 5,000 connections each receiving 10 events per second, **99% of events reach the viewer within 500 ms of publication and healthy viewers lose none**. (Load script `pnpm loadtest:sse`; an operations proof, not an e2e row.)
- **SC-002**: After a disconnect of any length up to the retention window, a reconnecting viewer receives **100% of the replayable events it missed, none twice**, in 100 repetitions of the reconnect scenario; beyond the window it is told to refetch **100%** of the time, never left with a silent hole.
- **SC-003**: **0** events are delivered to a viewer who was refused by the topic's rule, across the full cross-user suite (AS-21 to AS-28, AS-54 to AS-58).
- **SC-004**: After a member loses a shop, **100%** of their open shop streams stop receiving that shop's events **within 2 seconds**, on any instance.
- **SC-005**: A client that stops reading is dropped before it holds more than **1 MiB**, and the **memory of an instance returns to its starting level** after 10,000 connect-and-close cycles with no leaked subscription, timer or listener.
- **SC-006**: A backplane interruption causes **0 permanently lost replayable events** for open viewers.
- **SC-007**: A deploy that restarts every instance reconnects all viewers within **10 seconds** at 5,000 connections per instance without any instance exceeding its connection limit for more than the drain window (reconnects are spread by the jittered retry).
- **SC-008**: A publishing domain's request latency is affected by the hub's outage by **at most 1 second** and its success is affected **never**.
- **SC-009**: **100%** of the 70 acceptance scenarios have a passing automated check, each at the layer named in `test-plan.md`.

## Assumptions

Each assumption is also a line in `questions.md`.

- **A-01 (credentials)**: browsers authenticate with the session cookie and other clients with a bearer header. A URL ticket (the short-lived scoped ticket of the notes' WebSocket lesson) is **not** added: it is needed only by clients that can send neither cookies nor headers, and the notes call a URL credential the worse option. Any query parameter but `topics` is rejected (FR-001).
- **A-02 (refusal codes)**: anonymous refusals are `401`; authenticated refusals are `403`, identical for "not yours" and "does not exist". The notes name `403` for an unauthorized topic; `401` for an unauthenticated one follows V.4.
- **A-03 (one rule per route)**: rules are not combined with "or". The old combination existed only for the shared `job:` prefix, which S07 and S12 remove.
- **A-04 (routes)**: a route is (prefix, suffix); this lets tenancy own `shop:<id>:live` and assets own `shop:<id>:assets` without sharing a rule. The bare `shop:<id>` is no longer valid.
- **A-05 (publish is best effort)**: `publish` never throws for store faults; it reports `published: false`. Callers publish after commit, and the REST state is the truth (S13, S31 already assume this).
- **A-06 (retention)**: 1,000 to 1,200 events and one hour per topic. Enough for reconnects (browsers retry in seconds, phones in minutes); bounded memory. Beyond it the client refetches.
- **A-07 (resync)**: instead of replaying a trimmed buffer partially, the hub sends `resync`; clients treat it as "refetch this topic's state".
- **A-08 (limits)**: 10 topics per connection, 20 connections per user, 10 per anonymous address, 30 min lifetime, 1 MiB pending bytes, 30 s stall, 32 KiB payload, 2 s rule timeout, 1 s publish timeout, 15 s heartbeat: production defaults, all configurable (FR-050).
- **A-09 (revocation is not a ban)**: the owner's rule is the only authority for new connections. Revocation only closes what is open.
- **A-10 (who calls `revoke`)**: the owning domain's topic module reacts to its own event (for example S03 on `tenancy.member_removed`) and calls `revoke`. The hub consumes no domain events (X.3).
- **A-11 (the backplane)**: Redis pub/sub is the realtime fan-out backplane only (IV.3); nothing that must be delivered depends on it. Replay and REST cover loss. Sharded pub/sub for a single hot node is the notes' scale step and changes no contract here.
- **A-12 (topics in process)**: server-side subscribers (S23, S06) use `subscribe`; the raw pub/sub lib disappears.
- **A-13 (clients)**: the browser `EventSource` reconnects by itself; non-browser clients are expected to send `Last-Event-ID` on retry. A refused connection (`401`, `403`) is final for `EventSource`: the web client recreates it after refreshing credentials (W03, W04, W05).
- **A-14 (one connection per page)**: pages open one stream with all their topics, because HTTP/1.1 allows six connections per site.
- **A-15 (events are small)**: payloads are notifications or small state deltas (32 KiB cap). Bulk state is fetched by REST (the notes: "send a lightweight change notification and let the client fetch, or push the change itself").

## Cross-capability contracts

### Provides

Exported by `@app/infrastructure/realtime` (global `RealtimeModule`; the gateway app hosts the stream endpoint). Other specs read these names exactly.

- **`RealtimePublisher.publish<T>(topic: RealtimeTopic, type: string, data: T, options?: { replay?: boolean }): Promise<{ published: boolean; id: string | null }>`**: R1. `replay` defaults to `true`. Never throws for store faults. Throws only the four typed validation errors of FR-021. `id` is the topic position (null when live-only or not published). Guarantees: atomic with the replay buffer; per-topic order is publish order; one attempt, 1 s timeout; payload at most 32 KiB; type `^[a-z][a-z0-9_.-]{0,63}$`, not `open|error|resync|revoked`. Used by S10 (`user:<id>` `order.status {orderId, status, orderVersion}`), S13 (`user:<id>` `payment.status {paymentId, orderId, status, version}`), S20, S21, S22, S24, S28, S31, S40 (`replay: false`), S07, S12, S23.
- **`TopicRegistry.define({ prefix, suffixes?, singleton?, owner?, policy })`**: called in a domain topics module's init, before the app starts. `policy: (viewer: { userId?: string; roles: string[] }, topic: RealtimeTopic, id: string, suffix?: string) => boolean | Promise<boolean>`: asynchronous allowed, may call another domain's exported service (R1), runs once per topic per connection, 2 s timeout (timeout or throw → 503). One definition per (prefix, suffix); duplicates fail boot. Prefix grammar allows hyphens (`order-export`). Honours S07, S12, S20, S21, S22, S24, S31, S03.
- **`TopicSubscriber.subscribe(topic: RealtimeTopic, handler: (message: RealtimeMessage) => void): Promise<() => Promise<void>>`**: in-process listener; `RealtimeMessage = { id: string; topic: string; type: string; data: unknown }` (`id` is `'0-0'` for live-only events); release is idempotent; shares the ref-counted subscription with HTTP viewers; a throwing handler does not affect others. Asked by S23 (batcher); also the answer to S06's "best-effort subscribe".
- **`RealtimeSubscriptions.topicsWithSubscribers(prefix: string, suffix?: string): Promise<string[]>`**: sorted topics of the route with at least one listener on any instance (HTTP or in-process), at most 10,000; rejects `RealtimeUnavailableError` within 1 s on store fault. Asked by S40 (the name `topicsWithSubscribers('shop', 'live')`).
- **`RealtimeSubscriptions.revoke({ userId?: string; prefix: string; id: string; suffix?: string }): Promise<void>`**: ends matching open subscriptions fleet-wide within 2 s, sending `event: revoked` per topic; not a ban. Called by the owning domain's topics module (S03 on `tenancy.member_removed`; S31 may call it for assets). Resolves after the notice is published; best effort.
- **Errors**: `InvalidRealtimeTopicError`, `InvalidRealtimeEventTypeError`, `RealtimePayloadTooLargeError`, `InvalidRealtimePayloadError`, `RealtimeUnavailableError`, `TopicRegistryFrozenError`.
- **HTTP**: `GET /api/streams?topics=` as FR-001 to FR-009. Wire contract for W03 (notifications on `user:<id>`, event `notification`), W04 (progress on `import:`, `order-export:`, `shop:<id>:live`), W05 (chat on `chat:<id>`). Frames: `event: <type>`, `data: {"topic","data"}`; in-band `resync` and `revoked`; cursor in `id:` and `Last-Event-ID`; zod schemas in `packages/contracts` (FR-053).
- **Rate policy declared into S50**: `realtime.connect` (sliding window, 60 per minute, key user-or-address, fail open).
- **Metrics and logs**: FR-054, FR-055.
- **Guarantees**: no gap and no duplicate for replayable events within the retention window; refused viewers get nothing; one backplane subscription per topic per instance; bounded memory per connection; hub holds no domain topic names.

### Requires

- **S01 (identity and sessions)**: (1) guards that put `request.user = { id, role }` on the request for a valid cookie or bearer credential, **reject an invalid or expired credential with `401` even on routes marked anonymous-allowed**, and leave `request.user` empty when no credential is presented; an anonymous-allowed route marker (replacing `Firewall({ anonymous: true, skipThrottle: true })`); (2) optionally `request.user.credentialExpiresAt` (a date) so FR-037 can end the connection at expiry; absent means only the lifetime applies; (3) `IdentityTopicsModule` defining `prefix: 'user'`, policy `viewer.userId === id` (self only), which S10, S13, S20 (`user:<courierId>`) and S28 publish into.
- **S50 (rate limiter)**: `RateLimitModule.forFeature` accepting the policy `realtime.connect` and `@RateLimit('realtime.connect')` on the stream route, with the `429` problem and `RateLimit` headers of S50; fail-open behaviour on limiter outage.
- **S54 (platform toolkit)**: the global exception filter producing the problem+json of FR-007 (with the extension `code`); the resolved client address honouring the trusted proxy chain; compression middleware that skips `text/event-stream`; the shutdown registry with an ordered "readiness fails → drain connections → close backplane" sequence and a per-task timeout; the metrics registry and structured logger with `requestId`; startup configuration validation (FR-050); CORS with credentials for the web origin.
- **Shared store client** (`infrastructure/redis`, no capability ID): explicit per-call timeout, scripting support, and a dedicated connection for subscribing that reports loss and restoration.
- **Owning domains (S03, S07, S12, S20, S21, S22, S24, S31, S23, S38 and any later one)**: each defines its routes through `TopicRegistry.define` in a topics module loaded by the gateway app, with the policy shapes stated in its own spec (S03: members of `ACTIVE`/`SUSPENDED` shops for `shop:<id>:live`; S22: owner of the ticket for `queue:<ticket>`; S24: active members for `chat:<id>`; S31: members with `products.read` for `shop:<id>:assets`; S07, S12: members with `products.read` / `orders.manage` for `import:` and `order-export:`), reaching other domains only through R1 exported services (never their models: debt D-7, D-12).
- **S03**: its topics module reacts to `tenancy.member_removed` (through S53's consumer framework, idempotent) and calls `revoke({ userId, prefix: 'shop', id: shopId })`.
- **S13**: removes the payment SSE endpoint and its relay modules from the gateway app; S10 and S13 publish through the hub.

## Pattern coverage (pattern-map rows whose Specs column names S51)

| Pattern | Where it is a requirement and a scenario |
|---|---|
| **P0105** Closures and leaks: bounded maps, listener cleanup | FR-025, FR-026, FR-028, FR-030 to FR-033, FR-036; AS-36, AS-39, AS-41 to AS-46, AS-50 |
| **P0111** Conditional / mapped / template-literal types (topics) | FR-024, FR-043, FR-049; AS-34, AS-62, AS-64 |
| **P0209** SSE / streaming responses | FR-001 to FR-009, FR-036; AS-01, AS-04, AS-06, AS-07, AS-50, AS-51 |
| **P0323** Redis structures: streams (replay buffer; ids as cursors; capped retention) | FR-005, FR-006, FR-014 to FR-017, FR-020, FR-022; AS-08 to AS-20, AS-29, AS-30 |
| **P0406** Push instead of poll (SSE, replay, heartbeat, backplane, "lightweight notification") | FR-014, FR-019, FR-029, FR-036, FR-046; Summary, AS-01, AS-08, AS-40, AS-66; Assumption A-15 |
