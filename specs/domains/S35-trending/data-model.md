# Data Model: S35

No Postgres or ClickHouse tables (the ownership registry gets no entry, AS-38). All durable state is Redis, owned by `infra/trending-keys.ts`. Working state exists in memory only while a window is open. Types live in `domain/`; wire schemas in `packages/contracts`.

| Entity | Store and shape | Rules |
|---|---|---|
| Interaction event | consumed from `analytics.events`, validated by `storedAnalyticsEventSchema`; used fields `event_id`, `name`, `anonymous_id`, `ts`, `received_at`, `props.product_id`, `props.category` | only `product_view` (weight 1) and `add_to_cart` (weight 5) with UUID `product_id` count; event time = `min(ts, received_at)`; never stored or logged |
| Window | in memory per (partition, `windowStart` ms); `open → closed → merged` | `[start, start + 60 s)`; closes when the partition watermark ≥ end; a closed window never reopens; late events go to the correction buffer |
| Partition state | in memory: `maxEventTime`, `maxReceivedAt`, `lastMessageAt`, `watermark`, open windows, correction buffer, `firstOffset` per window | watermark = `min(maxEventTime, maxReceivedAt) − lateness`; idle advance to `now − lateness` after `idleMs` without a message |
| Sketch and heap | in memory per window × tracked category (and `all`): `Uint32Array(width × depth)` + min-heap of K `{productId, estimate}` | never persisted; saturating add; `all` 2^16 × 4, categories 2^14 × 4; ≤ 100 tracked categories; `trackedBytes` bounded by the memory budget |
| Visitor / event filters | in memory per open window: two Bloom bit arrays | no false "unseen"; false "seen" ≤ 1%; dropped at merge; hold only hashes |
| Window aggregate | Redis ZSET `trending:{category}:{windowStartMs}`, member = productId, score = weighted count | ≤ K members per partition merged in; TTL `retentionSeconds` (default 3 h, ≥ 60 min + lateness + correction horizon, ≤ 3 h); read by computed key names; rebuildable from the topic; never the source of truth |
| Merge record | Redis string `trending:merge:{partition}:{windowStartMs}` (value `firstOffset-lastOffset`); correction: `trending:merge:{partition}:{windowStartMs}:c:{first}-{last}` | created with `NX` inside the merge script; lives as long as the aggregate (same TTL); presence ⇒ merge skipped, counted `merge_replayed` |
| Correction dedupe | Redis string `trending:seen:{eventId}` | `SET NX EX retention`; only for events on the correction path |
| Ranking cache entry | Cache key `trending:rank:{category}:{boundaryMs}` → first 60 `{productId, score}` | TTL 30 s, single flight; holds no product facts |
| Trending item | response only: `{rank, productId, title, priceMinor, currency, category, score}` | facts from R1 at request time; `category` is the catalog category |
| Dead letter | `discovery-trending-topk.dlq` (S53 writer): original bytes + code `INVALID_PAYLOAD` + reason (schema paths only) | no side effect on counters other than `invalid` |

State transitions: Window `open → closed → merged` (merge failure keeps it `closed`, retried next tick, the commit floor stays behind it). Merge record `absent → present(TTL)`. A correction is `absent → merged(own record)`.

Commit floor (pure, `commit-floor.ts`): per partition `min(firstOffset of every window or correction buffer not yet merged)`, else `lastConsumedOffset + 1`. Offsets are committed to the floor only.

Serving window set (pure, `trending-ranking.ts`): `boundary = floor(now / 60 s) × 60 s`; the 60 windows with starts `boundary − 60 min … boundary − 1 min`.

Ranking order: score descending, then `productId` ascending by code unit; ranks 1.. after visibility filtering.
