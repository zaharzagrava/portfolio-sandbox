---
id: realtime-topic-stream
title: Realtime topics and the stream
kind: concept
status: draft
defined_by: S51
---
# Realtime topics and the stream
## Definition
A topic is a named channel that a domain publishes events to. The stream is the single endpoint that delivers those events to browsers over server-sent events (SSE). The hub gives each topic its own access rule. A client that reconnects with a cursor receives every missed event in order, or a `resync` frame when the hub cannot prove nothing was lost. Publishing never breaks the domain that publishes. One instance shares one backplane subscription per topic, whatever the number of viewers.

## Rules
- **realtime-topic-stream.C-01** The endpoint MUST answer `200` with `Content-Type: text/event-stream; charset=utf-8` and `Cache-Control: no-cache, no-transform`, and a request MUST name 1 to 10 topics, with duplicates collapsed.
- **realtime-topic-stream.C-02** A client MUST receive only events of the topics it asked for. A payload MUST NOT inject a field, comment or frame into the stream.
- **realtime-topic-stream.C-03** A connection MUST be admitted for all requested topics or for none. Refusal is `401` for an anonymous viewer and `403` for an authenticated viewer. The `403` for a topic that is not yours MUST equal the one for a missing topic.
- **realtime-topic-stream.C-04** A replayable event MUST carry an `id:` with the cursor of all topics seen. Replay MUST deliver every stored event after the cursor in order and MUST NOT change stored state.
- **realtime-topic-stream.C-05** When the hub cannot prove that no event was lost, it MUST send one `resync` frame with `reason: "replay-gap"` instead of a partial replay.
- **realtime-topic-stream.C-06** `publish` MUST NOT throw on a store fault or a store answer later than 1 s. It MUST make one attempt and resolve `{ published: false, id: null }`.
- **realtime-topic-stream.C-07** A user MUST NOT hold more than 20 connections (`429 too_many_connections`). An instance at its limit MUST answer `503 realtime_capacity`.
- **realtime-topic-stream.C-08** The replay buffer MUST keep at least 1,000 and at most 1,200 events per topic, for at most one hour.

## How the capabilities use it
- {{cap:S13}} Publishes `payment.status` to the owner's topic only on every status change. A push failure MUST NOT affect the transition.
- {{cap:W03}} Reads the live stream of `user:{userId}` for the notification bell and the payment result.
- {{cap:S51}} Defines the stream endpoint, the publisher, the in-process subscriber, replay, per-topic access rules and `revoke`.

## Known gaps
- The page of S03 lists this concept, but no line of it links the concept. Its use is unknown.
- Details of the `revoke` API, the stall limit and the topic registry are only in the S51 page. No other capability's use of them is stated.

## Used by
<!-- used-by:start -->
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
<!-- used-by:end -->
