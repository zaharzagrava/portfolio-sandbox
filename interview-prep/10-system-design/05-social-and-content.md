# Social and Content Designs

Designs 8–13 of the practice catalog (`03-practice-catalog.md`). Common themes: **read-heavy** traffic, caching, ID generation, fan-out, ranking, and search.

---

## 8. URL shortener (bit.ly)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Creating and resolving share links](../../docs/humans/concepts/domain-marketing/share-short-links.md): ShareLinkService/ShareLinksController create short links and resolve them with a 302 redirect to a marketplace page. [`ShareLinksController`](../../packages/backend/libs/domains/marketing/api/share-links.controller.ts#L17), [`ShareLinkService`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L47)
> - [`ShareLinkService`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L47): ShareLinkService creates and resolves short links, records clicks, and lists user links. _(share-link.service.ts)_ · [Link click attribution and stats](../../docs/humans/concepts/domain-marketing/link-click-analytics.md)
<!-- theory-links:end -->

### Clarify
- Custom aliases? Expiration? Click analytics? Editable destinations?
- Scale assumption: 100M new links/month (~40 writes/s), 10B redirects/month (~4k reads/s avg, 40k peak) → **read:write ≈ 100:1**.
- Storage: 100M × 12 months × 5 years × ~500 B ≈ **3 TB** over 5 years.

### Design
```
POST /links {url, alias?} ─► API ─► ID generator ─► DB (code → url, owner, created, expires)
GET /{code} ─► CDN/edge ─► redirect service ─► Redis (hot codes) ─► DB
                                    └─► click event → queue → analytics (async, never in the redirect path)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShareLinkService`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L47): ShareLinkService is the core of the design: create, resolve, record click, stats. _(share-link.service.ts)_ · [Link click attribution and stats](../../docs/humans/concepts/domain-marketing/link-click-analytics.md)
> - [Look up a code through Bloom filter, cache and DynamoDB](../../docs/humans/concepts/domain-marketing/resolve-pipeline.md): resolve checks code format, then Bloom filter, then cache, then DynamoDB. [`resolve`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L41), [`RedisBloomFilter`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L9)
> - [Link click attribution and stats](../../docs/humans/concepts/domain-marketing/link-click-analytics.md): Each redirect fires a click event to Kafka; a projector stores it in ClickHouse, and the owner reads stats. [`LinkClicked`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L17), [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts)
<!-- theory-links:end -->
### Deep dives
- **Short code generation**:
  - **Counter + base62**: a global sequence (Postgres sequence, or ranges handed out to each app instance, e.g. 1,000 IDs at a time from a ticket server) encoded in base62. 7 characters = 62^7 ≈ 3.5 trillion codes. No collisions; but sequential codes are guessable (enumeration). Shuffle with a bijective scramble if that matters.
  - **Random 7-char codes**: unguessable; insert with a unique constraint and retry on collision (rare while the space is sparse).
  - **Hash of the URL** (first N chars of SHA-256): the same URL maps to the same code (dedupe), but collisions need handling, and different users may need different links for the same URL.
- **Redirect**: `301` (permanent, browsers cache it, so fewer hits but analytics are lost and destinations can't change) vs **`302`/`307`** (every click comes to you: analytics, editable links). Most shorteners use 302.
- **Read path**: cache-aside in Redis (most traffic hits a small set of hot links), cache negative lookups (non-existent codes) briefly, or serve redirects at the edge (CDN workers with a KV store).
- **Analytics** asynchronously: the redirect emits an event to a queue and returns immediately; aggregation happens downstream (design 31).
- **Abuse**: malicious URLs (Safe Browsing check on create), rate limits per user/IP.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`scramble`](../../packages/backend/libs/domains/marketing/domain/codes.ts#L39): scramble turns a sequential 40-bit ID into a random-looking code with a keyed Feistel cipher, which stops enumeration. _(codes.ts)_ · [Creating and resolving share links](../../docs/humans/concepts/domain-marketing/share-short-links.md)
> - [Hand out ids in blocks of 1,000 from Redis](../../docs/humans/concepts/domain-marketing/id-lease.md): IdLease leases blocks of 1,000 sequential IDs from Redis, like the ticket-server range idea. [`IdLease`](../../packages/backend/libs/domains/marketing/infra/id-lease.ts#L9)
> - [`toBase62`](../../packages/backend/libs/domains/marketing/domain/codes.ts#L9): toBase62 encodes the number into a 7-character code (CODE_LENGTH). _(codes.ts)_ · [Creating and resolving share links](../../docs/humans/concepts/domain-marketing/share-short-links.md)
<!-- theory-links:end -->

### Trade-offs and pitfalls
- KV store (DynamoDB) vs Postgres: both work at this scale; the access pattern is pure key lookup. Postgres is fine up to many TB with caching in front.
- Pitfalls: doing analytics writes synchronously in the redirect path; 301s when you need analytics.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Recording a click without slowing the redirect](../../docs/humans/concepts/domain-marketing/fire-and-forget-click-recording.md): recordClick sends the Kafka event without awaiting it and ignores failures, so analytics never slow the redirect. [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts), [`share-links.controller.ts`](../../packages/backend/libs/domains/marketing/api/share-links.controller.ts)
> - [Cache lookup that also remembers missing links](../../docs/humans/concepts/domain-marketing/cache-with-negative-caching.md): getOrLoad caches links and briefly remembers missing codes (negative caching). [`resolve`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L41), [`linkCacheKey`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L35)
> - [Bloom filter that rejects codes that never existed](../../docs/humans/concepts/domain-marketing/bloom-filter-gate.md): A Redis Bloom filter rejects codes that never existed before the cache or DynamoDB. [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts), [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts)
<!-- theory-links:end -->

### Theory
`03-Databases/04` (cache-aside, negative caching), `03-Databases/03` (IDs), `04-API-Design/01` (status codes).

---

## 9. Twitter / news feed

### Clarify
- Core: post tweets, follow users, home timeline (posts from people I follow), user timeline. Likes/retweets, media, search out of scope unless asked.
- Scale assumptions: 200M DAU, 100M tweets/day (~1.2k writes/s), timeline reads ~50 per user/day → **~100k reads/s**. Average 200 followers, some accounts with 100M followers.
- Timeline freshness: a few seconds of delay is acceptable (eventual consistency).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FeedController`](../../packages/backend/libs/domains/community/api/feed.controller.ts#L10): FeedController handles following and timeline retrieval. _(feed.controller.ts)_
<!-- theory-links:end -->

### Design
```
POST /tweets ─► Tweet service ─► tweets DB (sharded by tweet_id, Snowflake IDs ≈ time-ordered)
                     │ event TweetCreated
                     ▼
               Fan-out workers ─► timeline cache: Redis list per user  timeline:{userId} → [tweetIds]
GET /timeline ─► Timeline service ─► read timeline:{me} (IDs) ─► hydrate tweets (cache) ─► merge celebrity tweets
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FeedService`](../../packages/backend/libs/domains/community/application/feed.service.ts#L43): FeedService implements the hybrid fan-out home timeline. _(feed.service.ts)_
> - [`FeedPublisher`](../../packages/backend/libs/domains/community/application/feed-publisher.service.ts#L28): FeedPublisher stores feed items and triggers async Kafka fan-out to followers. _(feed-publisher.service.ts)_
> - [`FeedFanoutConsumer`](../../packages/backend/libs/domains/community/infra/fanout.consumer.ts#L21): FeedFanoutConsumer pushes items into active followers' timelines. _(fanout.consumer.ts)_
<!-- theory-links:end -->
### Deep dives
- **Fan-out on write (push)**: when a user tweets, push the tweet ID into each follower's timeline cache. Reads are a single cache read (fast), writes are heavy. Great for normal users.
- **Fan-out on read (pull)**: build the timeline at read time by fetching recent tweets of everyone I follow. Cheap writes, expensive reads.
- **Hybrid** (what Twitter did): push for normal accounts; for **celebrities** (followers > ~10k–100k) don't fan out. At read time, merge the precomputed timeline with recent tweets from the celebrities I follow.
- **Timeline storage**: keep only the latest ~800 IDs per user in Redis (`LPUSH` + `LTRIM`); only active users get precomputed timelines (inactive users get built on demand when they return).
- **Hydration**: timeline holds IDs only; tweet bodies come from a tweet cache (multi-get), with author info batched (DataLoader-style).
- **IDs**: Snowflake-style 64-bit IDs (timestamp + machine + sequence) are sortable by time, generated without coordination, and give pagination cursors for free (`max_id`).
- **Counters** (likes, retweets): write to Redis counters and periodically flush to the DB; exact consistency isn't required.
- **Deletes and privacy**: deleted or protected tweets must be filtered at hydration time (fan-out already happened).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CELEBRITY_THRESHOLD`](../../packages/backend/libs/domains/community/application/feed.service.ts#L10): CELEBRITY_THRESHOLD (10k followers) switches an author from push to pull at read time. _(feed.service.ts)_
> - [`TIMELINE_LENGTH`](../../packages/backend/libs/domains/community/application/feed.service.ts#L11): TIMELINE_LENGTH caps the cached Redis timeline at 800 entries. _(feed.service.ts)_
> - [`ACTIVE_TTL_SEC`](../../packages/backend/libs/domains/community/application/feed.service.ts#L12): ACTIVE_TTL_SEC marks users as active, so only active followers get pushes and the timeline is rebuilt on expiry. _(feed.service.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Push = fast reads, write amplification (a tweet from a 1M-follower account = 1M writes). Pull = cheap writes, slow reads. Hybrid trades complexity for both.
- Pitfalls: fanning out celebrity tweets synchronously; storing full tweet bodies in each timeline; offset pagination on timelines.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FeedItemView`](../../packages/backend/libs/domains/community/application/feed.service.ts#L22): FeedItemView is a compact item, so timelines hold IDs and light views, not full bodies. _(feed.service.ts)_
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/01` (queues, async fan-out), `03-Databases/04` (Redis lists, counters), `03-Databases/01` §7 (cursor pagination).

---

## 10. Instagram-style photo sharing

### Clarify
- Upload photos (and short videos?), feed, likes/comments, profile grid. Stories? Filters?
- Scale: 50M uploads/day (~600/s), each ~2 MB original → ~100 TB/day of originals.

### Design
```
Client ─► POST /uploads (get presigned S3 URL) ─► client uploads directly to S3
S3 event ─► queue ─► media workers: validate, strip EXIF/GPS, resize (thumb, feed, full), WebP/AVIF ─► S3 (derived)
          ─► mark post "ready" ─► fan-out to followers' feeds (design 9 hybrid)
Readers ─► CDN ─► S3 (images)    feed API ─► feed cache ─► post metadata (Postgres/Cassandra)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VARIANTS`](../../packages/backend/libs/domains/media/infra/image-pipeline.ts#L8): VARIANTS defines thumb, feed and full resize widths served through the CDN. _(image-pipeline.ts)_
> - [`S3ObjectStorage`](../../packages/backend/libs/infrastructure/storage/s3-object-storage.ts#L21): S3ObjectStorage supports presigned and multipart uploads. _(s3-object-storage.ts)_
<!-- theory-links:end -->
### Deep dives
- **Upload path**: never stream big files through the API. Presigned S3 PUT (or multipart for large videos) with size and content-type limits. The post is created in a `processing` state and becomes visible when derivatives are ready.
- **Processing pipeline**: idempotent workers (re-running produces the same files), DLQ for corrupt files, separate queues for images vs video (video transcoding is much heavier; design 26).
- **Storage tiers**: originals to infrequent-access/Glacier after N days; serve derived sizes only.
- **Delivery**: CDN with long cache TTLs and content-hashed (immutable) URLs; responsive sizes per device.
- **Privacy**: strip GPS EXIF data; private accounts need signed URLs or authorization at the CDN (signed cookies).
- **Feed**: same as design 9; likes/comments counters in Redis with async persistence.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VideoService`](../../packages/backend/libs/domains/media/application/video.service.ts#L35): VideoService orchestrates uploads and transcoding via the SQS VIDEO_QUEUE. _(video.service.ts)_
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/media-processing.ts#L48): The media-processing handler is an idempotent SQS batch worker that writes results to S3 and PostgreSQL. _(media-processing.ts)_
> - [`RejectedImageError`](../../packages/backend/libs/domains/media/infra/image-pipeline.ts#L11): RejectedImageError is raised when image validation fails. _(image-pipeline.ts)_
<!-- theory-links:end -->

### Theory
`08-DevOps-Cloud/03` (S3, presigned URLs, CloudFront), design 27 (upload pipeline), design 9 (feed).

---

## 11. Comments / Reddit-style voting and ranking

### Clarify
- Nested comment threads? How deep? Sort orders (top, new, controversial, "hot")?
- Vote integrity: one vote per user per item, changeable.
- Scale: hot threads with 50k comments and bursts of votes.

### Design
- Tables: `posts`, `comments(id, post_id, parent_id, path, author_id, created_at, score)`, `votes(user_id, target_id, value, PRIMARY KEY (user_id, target_id))`.
- Voting: upsert into `votes` (the primary key guarantees one vote per user), then **adjust the counter by the delta** (`+1`, `−1`, or `±2` when flipping). Counters live in Redis and are flushed to the DB in batches; or computed asynchronously from vote events.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VoteService`](../../packages/backend/libs/domains/community/application/vote.service.ts#L22): VoteService handles votes, scoring and reranking, and persists them. _(vote.service.ts)_
> - [`VOTE_DELTAS`](../../packages/backend/libs/domains/community/application/vote.service.ts#L10): VOTE_DELTAS is a Redis write-behind buffer that accumulates vote deltas. _(vote.service.ts)_
> - [`VoteValue`](../../packages/backend/libs/domains/community/application/vote.service.ts#L9): VoteValue allows -1, 0 and 1, so a vote can be changed or cleared. _(vote.service.ts)_
<!-- theory-links:end -->

### Deep dives
- **Ranking**:
  - *Hot* (Reddit): score combines `log10(max(|ups − downs|, 1))` with post age, so new posts can compete with old high scorers. Precompute and update on votes; keep top-N per subreddit in a Redis sorted set.
  - *Best* comments: Wilson score lower bound of the upvote proportion (penalizes items with few votes).
  - *Top*: plain score within a time window.
- **Nested comments storage**:
  - adjacency list (`parent_id`) + recursive CTE to load a subtree;
  - **materialized path** (`path = '0001.0005.0012'`, ltree in Postgres) → one indexed query loads a thread in order;
  - load the first N top-level comments + first few replies, then "load more" per branch (avoid loading 50k comments).
- **Hot threads**: cache the rendered first page of a thread for a few seconds; aggregate votes in Redis to avoid row-lock contention on a single counter row.
- **Abuse**: vote manipulation detection (new accounts, same IP clusters), rate limits, shadow-banning.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`hotScore`](../../packages/backend/libs/domains/community/domain/ranking.ts#L14): hotScore combines log net votes with a time-decayed recency bonus. _(ranking.ts)_
> - [`wilsonLowerBound`](../../packages/backend/libs/domains/community/domain/ranking.ts#L27): wilsonLowerBound ranks by the Wilson 95% lower bound of the upvote proportion. _(ranking.ts)_
> - [`boardKey`](../../packages/backend/libs/domains/community/application/discussion.service.ts#L38): boardKey is the Redis ZSET key for hot/top board rankings. _(discussion.service.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/02` (contention on hot rows, atomic updates), `03-Databases/04` (sorted sets, counters).

---

## 12. Search autocomplete / typeahead

### Clarify
- What is searched (products, users, queries)? Personalized suggestions? Typo tolerance?
- Latency target: < 100 ms end to end (users type fast; requests per keystroke).
- Scale: 10k QPS of prefix lookups.

### Design
- **Offline**: aggregate historical queries (or catalog terms) with their frequency → top-K completions for every prefix → build a **trie** (or prefix → top-K map) → ship to the serving layer periodically (hourly/daily).
- **Online**: `GET /suggest?q=iph` → in-memory trie lookup in the serving nodes (or Redis sorted sets / Elasticsearch `completion` suggester) → top 10.
```
query logs ─► batch job (counts, filters) ─► prefix → top-K index ─► serving nodes (in memory) ◄─ GET /suggest
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TopKTrie`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L22): TopKTrie is a prefix trie with precomputed top-K completions per node. _(top-k-trie.ts)_
> - [`AutocompleteBuilderJobs`](../../packages/backend/libs/domains/discovery/infra/autocomplete-builder.jobs.ts#L29): AutocompleteBuilderJobs rebuilds the autocomplete snapshot hourly. _(autocomplete-builder.jobs.ts)_
> - [`AutocompleteController`](../../packages/backend/libs/domains/discovery/api/autocomplete.controller.ts#L8): AutocompleteController serves CDN-cacheable suggestions. _(autocomplete.controller.ts)_
<!-- theory-links:end -->
### Deep dives
- **Precompute top-K per prefix** so a lookup doesn't traverse the subtree. Memory is bounded by limiting prefix length and K.
- **Client side**: debounce (~100–150 ms), cancel stale requests (AbortController) so slow responses don't overwrite newer ones, cache results per prefix in the client, `Cache-Control` on suggestions (CDN-cacheable for popular prefixes).
- **Freshness**: trending terms via a streaming top-K (design 32) merged with the batch index.
- **Typo tolerance**: fuzzy matching (Elasticsearch, edit distance), `pg_trgm` for smaller datasets.
- **Filtering**: block offensive or sensitive suggestions; personalization blends user history with global popularity.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`normalizeQuery`](../../packages/backend/libs/domains/discovery/domain/top-k-trie.ts#L79): normalizeQuery canonicalizes queries (lowercase, trimmed, max 100 chars) before they go into the trie. _(top-k-trie.ts)_
> - [`AUTOCOMPLETE_POINTER`](../../packages/backend/libs/domains/discovery/infra/autocomplete-builder.jobs.ts#L16): AUTOCOMPLETE_POINTER holds the current snapshot version, so serving nodes pick up fresh data. _(autocomplete-builder.jobs.ts)_
<!-- theory-links:end -->

### Theory
`11-Algorithms-Coding/03` (trie), `03-Databases/01` §4.3 (trigram indexes), `09-Frontend-React-Next/02` (race conditions in fetching).

---

## 13. Proximity search (Yelp, "restaurants near me")

### Clarify
- Search by location + radius + category/filters; business pages and reviews.
- Scale: 100M businesses, 10k search QPS; businesses change rarely.

### Design
- **Geo index options**:
  - **PostGIS** (`geography` column + GiST index, `ST_DWithin`): accurate, simple, fine for millions of rows with read replicas.
  - **Geohash**: encode lat/lng into a string where a shared prefix means nearby (precision by length). Query the user's cell + 8 neighbors (to handle edge effects), then filter by exact distance. Works in any KV store or B-tree index.
  - **Quadtree**: in-memory tree that splits dense areas into smaller cells. Good for very dense, uneven data.
  - **Elasticsearch / OpenSearch** `geo_point` with `geo_distance` filters + text relevance + facets, the typical choice when search combines text, filters, and location.
  - **Redis GEO** (`GEOSEARCH`) for simple, hot "nearby" lookups.
- Read path: search service → geo index → candidate IDs → filter/rank (distance, rating, open now) → hydrate from cache.
- Reviews: separate service and table; rating aggregates precomputed (avg, count) and updated asynchronously.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AvailabilityIndex`](../../packages/backend/libs/domains/fulfilment/infra/availability-index.ts#L31): AvailabilityIndex runs location-based search on an Elasticsearch geo index and map clustering. _(availability-index.ts)_
> - [`PickupController`](../../packages/backend/libs/domains/fulfilment/api/pickup.controller.ts#L32): PickupController exposes the geo-spatial nearby search endpoint. _(pickup.controller.ts)_
> - [`PickupPointNear`](../../packages/backend/libs/domains/fulfilment/application/pickup.service.ts#L8): PickupPointNear carries the location and distance of each nearby result. _(pickup.service.ts)_
<!-- theory-links:end -->

### Deep dives
- Edge cases: radius crossing cell boundaries (neighbors), very dense cities (adaptive cell size), the antimeridian/poles (rarely matters for businesses).
- Data freshness: business edits propagate to the search index via CDC/outbox.

### Theory
`03-Databases/01` (GiST indexes), `09-data-and-infrastructure.md` design 37 (search index sync).
