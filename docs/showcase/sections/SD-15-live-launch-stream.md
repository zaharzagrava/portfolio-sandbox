# SD-15 — Live Launch Stream Comments & Reactions

Status: ☑ done (typechecked; specs written, not run) · Phase 4 · Depends on: F-03, F-02 (Dynamo), SD-28 · Pairs with SD-21 (launch events) and SD-26 (video)

## Marketplace adaptation
During a brand's **live launch stream** ("iPhone 18 reveal"), millions of viewers comment and spam ❤️🔥 reactions; the "Buy now" pin appears live. Nobody can read 5k comments/s — so sample.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Comment ingest: sync lightweight moderation (banned words, per-user rate limit SD-28) → publish to stream topic → async persistence | 10/06 #15 |
| **Comment history in DynamoDB** `StreamComments` (PK `STREAM#<id>#<minuteBucket>`, SK commentId) — write-heavy, time-bucketed partitions avoid hot partitions | D24 |
| **Tiered fan-out over SSE**: stream topic → regional fan-out → gateways (F-03) | 10/06 #15 |
| **Sampling**: per-viewer cap 20 comments/s via **reservoir sampling** per 250 ms window, always including friends'/highlighted/shop-pinned comments | 10/06 #15 |
| **Batching**: deliver every 250 ms in one SSE event | 10/06 #15 |
| **Reaction aggregation**: `HINCRBY` per second bucket → broadcast counts (`{❤️: 3412, 🔥: 901}`) not individual events | 10/06 #15 |
| Late joiners: last N comments from Redis list | 10/06 #15 |
| Async moderation removes comments later → "delete" events | 10/06 #15 |
| Pinned commerce events ("Buy now — 500 left") via the same topic | — |

## Steps
- [x] `LiveStreamModule`: `POST /streams/:id/comments`, `POST /streams/:id/reactions`, SSE topic `stream:{id}` with batcher service (one per gateway instance per stream: aggregates + samples).
- [x] Reservoir sampler (pure, unit-tested).
- [x] Dynamo persistence consumer (batch write 25 items).
- [x] e2e: 500 comments in 1 s → subscriber gets ≤ 5 batches with ≤ cap comments each, pinned always present; reactions arrive as counts.

## Scale
- Target: 2M concurrent viewers, 5k comments/s, 200k reactions/s.
- Hot path: reaction → Redis HINCRBY only (no persistence per reaction; per-second totals to ClickHouse). Comment → Redis publish + Kafka for persistence. Delivery → gateways batch per 250 ms.
- First bottleneck & fix: fan-out = 5k × 2M deliveries/s impossible → sampling to 20/s/viewer and batching → 2M × 4 batches/s = 8M small writes/s across ~40 gateway instances (50k conns each, 200k writes/s each).
- Capacity model: 40 gateways × 50k = 2M connections; Redis reactions 200k HINCRBY/s → 2–4 shards with per-second key sharding.
- Proof: k6 SSE fan-out at 5k conns + comment flood; delivery p99 < 1 s.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001240000-live-streams` holds metadata only. History goes to DynamoDB `LiveComments` (`dynamodb/LiveComments.json`, PK `STREAM#<id>#<minute>`, SK uuidv7, 30-day TTL).
- **Write side** (`LiveService`, core):
  - Comments:
    - Sync moderation (links, normalized/leet/letter-spaced banned words); mute list; `live.comment` token bucket.
    - Then a Redis MULTI (recent list, 50 entries) plus a PUBLISH on the private firehose channel `livefeed:<id>` (not a client-subscribable topic), then Kafka `live.events`.
  - Reactions: clients pre-batch (`{"❤️": 7}`, ≤ 20 per emoji per request). Each call does one HINCRBY on `live:rx:<id>:<second>:<shard 0-7>`; these keys are deliberately not hash-tagged, so they spread across cluster shards.
  - Shop staff: start/end, pin ("Buy now — 500 left"), remove comments, mute users.
- **Delivery tier** (`apps/sse-gateway/src/live`):
  - `LiveBatcherRegistry` keeps one `StreamBatcher` per (instance, stream), with one firehose subscription however many local viewers there are.
  - Every 250 ms it sends one `comments` event per viewer: staff/priority comments + the viewer's own comments + a reservoir sample (k = 5, i.e. 20/s), plus the observed rate.
  - Control events (`pin`, `comment_removed`, `stats`, `status`) pass straight through.
  - `GET /api/live/:id/events` opens with a `snapshot` (recent + pin). Slow viewers are dropped past 256 KB buffered, and there is no replay (chat is ephemeral).
  - Viewer counts are reported per instance every 5 s.
- **`LiveTicker`** (apps/worker): once per second per live stream it takes a per-stream lease (Lua acquire-or-renew), sums the 8 reaction shards of the finished second and the fresh viewer entries, and publishes `stats`.
- **Consumers** (apps/projector): `LiveCommentsProjector` writes history via BatchWriteItem in 25s, with UnprocessedItems backoff; removals are marked via the uuidv7 time prefix. `LiveModerationConsumer` runs the async classifier port (heuristic default; Perspective/LLM adapter slot) and retracts comments scoring ≥ 0.7.
- **Specs:** `live/reservoir.spec.ts` (uniformity) and `apps/sse-gateway/src/live/live.e2e-spec.ts` (600-comment burst → ≤ 10 batches of ≤ 5 sampled with staff always included; reaction totals and viewer count; moderation reject/retract/mute).
