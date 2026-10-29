# arch-46. Live order tracking in the browser at scale

*Realtime · Easy*

## The question

"After a customer orders, our food delivery app shows the order status (accepted, preparing, picked up, delivered) and, during delivery, the courier's position on a map. Status changes come from restaurant tablets and courier apps; courier GPS arrives every 5 s. At the Friday dinner peak ~150k orders are in progress, and we run 20 API instances behind an ALB. How do you get these updates to customers' browsers and apps without them refreshing?"

**Then:** "You deploy at 19:00 on a Friday. What happens to the open connections, and does the design hold?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who watches? → assume: the customer who placed the order; ~60% of active orders have the app or page open, so ~90k open streams, ~4.5k per instance.
- Message volume? → assume: ~6 status changes per order over ~40 min; ~50k orders in the delivery leg × one GPS fix per 5 s = 10k positions/s, of which ~6k/s have a viewer. At ~200 bytes each that's ~1.2 MB/s of fan-out. Small.
- Latency target? → assume: status within 2-3 s; the map may lag 5-10 s.
- Does the client send anything on this channel? → assume: no, server → client only.
- Backgrounded mobile app? → assume: gets push notifications for key states, not a socket.
- Auth? → assume: same-site cookie session on web; bearer token in the app.

## Design

1. **Sources of truth.** Order status lives in Postgres; a status change commits with an outbox row `order.status_changed {orderId, status, version}`. Courier positions are ephemeral: the latest fix per courier goes to Redis (`courier:{id}:pos`, TTL 2 min), history to a stream for analytics. Positions never go through Postgres row updates.
2. **Fan-out between instances.** The outbox relay and the courier-location service publish to the Redis pub/sub channel `order:{orderId}`. An API instance subscribes when a client opens that order's stream and unsubscribes when it closes.
3. **Transport: Server-Sent Events.** `GET /orders/:id/events` returns `text/event-stream`. Status events carry `id: <version>`; `EventSource` reconnects on its own and sends `Last-Event-ID`. The native apps use an SSE client while in the foreground.
4. **Snapshot on connect.** Every (re)connect first sends the current status (Postgres, by primary key) and the last position (Redis), then live events. Redis pub/sub drops messages when nobody is subscribed; the snapshot closes that gap.
5. **Order and conflation.** Status has a monotonic `version`; the client ignores anything older. Position is last-value-wins: if `res.write()` returns false (slow client), the server keeps only the newest position for that stream and drops older ones instead of buffering.
6. **Keep-alive:** a comment line every 20 s. The ALB idle timeout defaults to 60 s and silently cuts quiet connections.
7. **HTTP/2 on the ALB:** under HTTP/1.1 browsers allow about 6 connections per host, so a few tabs with streams block normal API calls; HTTP/2 multiplexes them.
8. **Only while it matters.** The stream opens while the order is active and closes at `delivered`. If SSE fails (some proxies buffer streams), poll `GET /orders/:id` every 5-10 s.
9. **Background:** push notifications for "picked up", "arriving" and "delivered"; a fresh GET when the app returns to the foreground.

**Twist.** On SIGTERM the instance stops accepting streams, sends `retry: <random 1000-5000>` and closes them, so ~4.5k reconnects spread over 5 s land on other instances; each costs one primary-key read and one Redis GET. Roll one or two instances at a time, never all at once.

## Deep dives

**1. SSE vs WebSocket vs polling.**
Problem: one-way updates; status rarely, position every 5 s.
Approach: SSE. Plain HTTP, cookie auth on web, built-in reconnect with `Last-Event-ID`, works through the ALB.
Rejected: WebSocket. Two-way isn't needed, and reconnect and resume are ours to write (API Gateway WebSocket APIs also cap connections at 2 hours and 10 minutes idle). Polling alone: 90k clients every 5 s = 18k req/s of mostly unchanged answers; fine only as the fallback.

**2. Getting the event to the right instance.**
Problem: the courier's ping lands on instance 2; the customer's stream is on instance 14.
Approach: Redis pub/sub per order channel; every producer publishes, the instance holding the stream delivers. In Redis Cluster, classic pub/sub broadcasts every message to all nodes; Redis 7 sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`) keeps a channel on one shard.
Rejected: Postgres `LISTEN/NOTIFY`. 10k positions/s through the primary for data nobody keeps, and each listener needs a dedicated session connection that can't go through a transaction-mode pooler. Rejected: sticky routing to "the order's instance": needs a registry and breaks on every deploy.

**3. Lost and out-of-order events.**
Problem: pub/sub is at-most-once; reconnects lose messages; a late "preparing" can arrive after "picked up".
Approach: snapshot on reconnect + version per order. Lost positions don't matter: the next one replaces them. Make sure the Redis client re-subscribes after a Redis reconnect (ioredis does by default).

## Traps

- **Writing every GPS fix as a Postgres update**: 10k writes/s of data that's stale in 5 seconds.
- **Buffering every position for a slow client**: per-stream memory grows until the Node process dies.
- **No snapshot on reconnect**: a lost message leaves the screen stuck on "preparing".
- **No heartbeat**: the ALB or a corporate proxy drops idle streams with no error on either side.
- **A stream per logged-in user, always**: connection count grows with all users instead of active orders.
- **Delivering only to sockets on the instance that received the event**: the customer is usually connected elsewhere.

## Say it (60–90 s)

Order status stays in Postgres: a status change commits with an outbox event carrying the order id, the status and a version. Courier positions are ephemeral, so the latest fix goes to Redis, never to a Postgres row. Both are published to a Redis pub/sub channel per order, and the API instance holding that customer's stream subscribes to it. The client opens a Server-Sent Events stream only while the order is active. SSE fits because updates only go one way, it's plain HTTP, and EventSource reconnects by itself. Pub/sub can drop messages, so on every connect the server first sends the current status and the last position, then live events, and the client ignores older versions. Position is last-value-wins: for a slow client I keep only the newest one instead of buffering. A heartbeat every twenty seconds keeps the ALB from closing idle streams, HTTP/2 avoids the browser's connection limit, and polling is the fallback. At peak that's about four and a half thousand streams per instance, which Node handles easily. On deploy, each instance closes its streams with a random retry delay, so reconnects spread out, and each one costs a primary-key read and a Redis get.

## Follow-ups

**Q:** How do you authenticate the stream? Browser `EventSource` can't set headers.
**A:** Same-site session cookie on web. The native apps' SSE client can send the bearer token in a header. If a browser needs tokens, use a short-lived single-use ticket in the URL, never the long-lived token (URLs end up in logs).

**Q:** When would you switch to WebSockets?
**A:** When the client sends frequent messages on the same channel, e.g. in-app chat with the courier.

**Q:** Does Redis become the bottleneck?
**A:** Not at ~10k messages/s; a single node handles far more. Watch CPU and output buffers for slow subscribers. If it grows, shard channels across nodes (sharded pub/sub in Redis 7).

</details>

## Theory in the notes

- [10-system-design/06-realtime-and-collaboration.md](../../10-system-design/06-realtime-and-collaboration.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [02-nodejs/02-streams-and-backpressure.md](../../02-nodejs/02-streams-and-backpressure.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
