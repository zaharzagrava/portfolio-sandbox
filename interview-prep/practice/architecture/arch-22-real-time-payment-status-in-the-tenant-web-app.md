# arch-22. Real-time payment status in the tenant web app

*Integrations · Easy*

## The question

After a tenant clicks Pay, the web app shows "Processing". Status changes arrive from PSP webhooks seconds to days later (cards in seconds, bank debits in days). Product wants the screen to update live without refresh. We have ~50k daily active tenants and 5 API instances behind an ALB. How do you get status changes to the browser?

**Then:** On the 1st, 200k tenants open the app around 9:00. Does your design hold, and what happens to open connections during a deploy?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which screens need live updates? → assume: payment detail and the payments list.
- Latency target? → assume: within 2-3 s of us learning the new status.
- Web only? → assume: web now; a backgrounded mobile app gets push notifications, not a socket.
- Does the browser send anything back on this channel? → assume: no, server → client only.
- Auth? → assume: same-site cookie session.

## Design

1. **Source of truth:** the `payments` row. A status change commits together with an outbox row `payment.status_changed {paymentId, userId, status, version}`.
2. **Fan-out between instances:** the outbox relay publishes to Redis pub/sub channel `user:{userId}`. Each API instance subscribes for the users connected to it.
3. **Transport:** Server-Sent Events. `GET /events` returns `text/event-stream`; each message carries `id: <paymentId>:<version>`. `EventSource` reconnects on its own and sends `Last-Event-ID`.
4. **Snapshot on connect:** on every (re)connect the server first sends the current state of the user's non-final payments from Postgres, then live events. Redis pub/sub drops messages when no one is subscribed, and the snapshot closes that gap. Partial index for it: `CREATE INDEX ON payments (user_id) WHERE status IN ('pending','processing')`.
5. **Ordering:** each payment has a monotonic `version`; the client ignores anything older than what it has.
6. **Keep-alive:** a comment line every 20 s. The ALB idle timeout defaults to 60 s and silently cuts quiet connections.
7. **Open the stream only when needed:** the client opens it while a payment is in a non-final state and closes it at a final state. If `EventSource` fails (some proxies buffer streams), fall back to polling `GET /payments/:id` every 5 s.
8. **HTTP/2 on the ALB:** under HTTP/1.1 browsers allow about 6 connections per host, so several tabs with streams block normal API calls; HTTP/2 multiplexes them on one connection.

**Twist.** 200k open the app, but only tenants with an in-flight payment hold a stream: say 30k. 6k per instance is fine for Node (a few tens of KB each; file descriptors and heartbeats, not CPU). On deploy, a draining instance closes its streams; send `retry: <random 1000-5000>` so reconnects spread out, and each reconnect is one indexed snapshot query.

## Deep dives

**1. SSE vs WebSocket vs polling.**
Problem: one-way updates, rare per payment, sometimes days apart.
Approach: SSE. Plain HTTP, cookie auth, built-in reconnect with `Last-Event-ID`, works through the ALB.
Rejected: WebSocket: two-way isn't needed, and you write reconnect/resume yourself (API Gateway WebSocket APIs also cap connections at 2 hours and 10 minutes idle). Polling alone: 30k users every 5 s = 6k req/s at peak, mostly unchanged answers; acceptable only as the fallback.

**2. Getting the event to the right instance.**
Problem: the webhook lands on instance 2, the user's stream is on instance 4.
Approach: Redis pub/sub per user channel; every instance publishes, the one holding the stream delivers.
Rejected: Postgres `LISTEN/NOTIFY` works at this size (payload up to 8000 bytes, delivered on commit), but each listener needs a dedicated session connection that can't go through a transaction-mode pooler. Fine if Redis isn't already there. Rejected: sticky routing to "the user's instance": needs a registry and breaks on every deploy.

**3. Missed and out-of-order events.**
Problem: pub/sub is at-most-once; reconnects lose messages; a late "processing" can arrive after "succeeded".
Approach: snapshot on reconnect + per-payment version; the screen is always derived from the latest version seen.

## Traps

- **Treating the push channel as the source of truth** (no snapshot on reconnect): lost messages leave the screen stuck on "Processing".
- **No heartbeat**: the ALB or a corporate proxy drops idle streams with no error on either side.
- **A stream per logged-in user, always**: connection count grows with DAU instead of in-flight payments.
- **Polling Postgres inside each SSE handler every second**: moves the polling load to the database.
- **Pushing only to sockets on the instance that received the webhook**: the user is usually connected elsewhere.

## Say it (60–90 s)

The payments table stays the source of truth. When a webhook changes a payment's status, the same transaction writes an outbox event with the payment id, the user, the new status and a version number. A relay publishes it to a Redis pub/sub channel for that user, and every API instance subscribes for the users connected to it. The browser opens a Server-Sent Events stream only while it has a payment in a non-final state. SSE fits because updates only go one way, it's plain HTTP with our cookie auth, and EventSource reconnects by itself. Pub/sub can drop messages, so on every connect or reconnect the server first sends the current state of the user's open payments from Postgres, then live updates, and the client ignores lower versions. I send a heartbeat every twenty seconds because the ALB closes idle connections after sixty, enable HTTP/2 so tabs don't use up the browser's connection limit, and fall back to polling every five seconds if the stream fails. On rent day only tenants with in-flight payments hold a stream, a few thousand per instance, and on deploys a randomized retry value spreads the reconnects.

## Follow-ups

**Q:** How do you authenticate the stream? EventSource can't set headers.
**A:** Same-site session cookie. If tokens are needed, a short-lived single-use ticket in the URL, never the long-lived token (URLs end up in logs).

**Q:** When would you switch to WebSockets?
**A:** When the client sends frequent messages on the same channel, e.g. live chat with support.

**Q:** And for the mobile app?
**A:** Push notifications for final states, and a fresh GET when the app returns to the foreground.

</details>

## Theory in the notes

- [04-api-design/01-rest-design-and-chatty-apis.md](../../04-api-design/01-rest-design-and-chatty-apis.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
