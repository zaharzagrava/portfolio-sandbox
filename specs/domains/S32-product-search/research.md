# Research: S32 — Product Search

Every `NEEDS CLARIFICATION` from the Technical Context is resolved here. `questions.md` defaults are accepted as written; where this file narrows or interprets one, it says so (R-07 is the only interpretation that needs a human look).

Facts read from the repository on 2026-10-10 that the design depends on:

- `catalog` emits `ProductCreated|Updated|Archived|Restored|Deleted` on `products.events` (`PRODUCTS_AGGREGATE`, retention `latest-per-key`), with `aggregateVersion = productVersion` rising by 1 per event including delete (`catalog/application/events/product-events.ts`). Exported from `@app/domains/catalog` (`index.ts:36-54`).
- `tenancy` exports `ShopStatusChanged` (has `shopVersion`), `ShopPlanChanged`, `ShopOffboardingStarted|Cancelled`, `ShopDeleted` (no `shopVersion`), `ShopQueryService`, `ShopScoped` from its entry point. Topic constant `SHOP_EVENTS_TOPIC = 'shop.events'`.
- `media` has **no** `media.gallery_changed` event and **no** `MediaQueryService.getReadyMediaByIds` yet (S29 not built). `marketing` has no sponsorship event (S36 not built).
- S53 provides `Projector` (`name`, `topics`, `idempotency`, `handles`, `coalesce`, `attempts`, `project`), `ProjectionsModule.forProjectors`, `ProjectionAdmin.rebuild` (resets an in-place group), `EsVersionedSink` (external versioning, built on the product-index client, to be moved by S32, D-16).
- S49 `declareJobType` + `JobsService`; S50 rate-limit registry (`catalogRatePolicies` still carries `search.query`, used by six other controllers).
- Test stack: Elasticsearch 8.15.3 and a Redpanda Kafka stand-in in `docker-compose.test.yaml`; `test/fakes/tcp-fault-proxy.ts` exists.
- `catalog/application/product.service.ts:69` still calls `ElasticsearchService.searchProducts` and `catalog/api/product-id.pipe.ts:12` still reserves `search`; `catalog` no longer imports `SearchQueryLogger` (grep clean). `catalog/infra/product-search.projector.ts` is already gone, so the index has no feed until T-projection lands.
- No `// S54 T037 audit` comment in `libs/domains/discovery`; the domain opens no transaction directly today. New code uses `TransactionRunner.run` / `@Transactional` only.

## R-01 Engine client split (D-16)

- **Decision**: `libs/infrastructure/elasticsearch` becomes a generic `SearchEngineClient` (search, mget, bulk, count, index create/delete/exists, atomic alias actions incl. `remove_index`, update-by-query, delete-by-query, synonyms-set API, per-call timeout, error classification into `EngineUnavailableError` / `EngineRejectedError`). No product names. `EsVersionedSink` (S53) is rewired onto it (same public methods). Product mapping, `searchProducts`, `suggestTitles`, `bulkUpsertProducts`, `ensureProductsIndex`, `stubEmbed`, `PRODUCTS_INDEX`, `SYNONYMS_SET`, `PRODUCT_EMBEDDING_DIMS`, `types.ts` move to `discovery/infra/product-index.adapter.ts` behind `ProductIndexPort`. `fulfilment` (`pickup-availability.projector.ts`, `availability-index.ts`) is moved to the generic client in the same task (compile-time break otherwise).
- **Rationale**: X.3 / X.7 placement test; AS-80 asserts the generic client has no product knowledge.
- **Alternatives**: keep `ElasticsearchService` and add methods (rejected: keeps D-16); duplicate client inside discovery (rejected: S53 sink and `fulfilment` need the generic part).

## R-02 Document model and per-source guards

- **Decision**: one engine document per product (`_id = productId`) holding product fields, derived fields (`inStock`, `embedding`, `embeddingPending`, `browseScore`, `hasProduct`, `visibleProduct`), signals (`shopStatus`, `shopHidden`, `shopTier`, `shopStateVersion`, `imageUrl`, `galleryVersion`, `sponsored`, `sponsorshipVersion`, `popularityBucket`, `popularityAt`) and a delete marker (`deleted`, `deletedAt`). Each source writes **only its fields** with a bulk scripted update (`scripted_upsert`, `retry_on_conflict: 5`) whose Painless script repeats the pure guard on the stored per-source version. The projector first `mget`s the stored versions of the batch and decides with the pure `projection-guard` (AS-81) so counters distinguish `applied`, `duplicate`, `stale`; the script is the race-safe backstop and turns a lost race into `noop`.
- **Rationale**: external versioning (`version_type: external`) is per document, so one flat version cannot guard five independent sources (gap A12). A signal-only document (sponsorship or image before the product) has `hasProduct: false` and is excluded by the visibility filter (AS-31, AS-32).
- **Alternatives**: separate signal documents joined at query time (rejected: join cost on the hot path); full re-index of the document per event (rejected: loses signals, FR-019); external versioning plus read-modify-write (rejected: lost updates).
- `browseScore` (double) is precomputed from stock, rating, popularity bucket, tier, sponsorship and capped at 4 (AS-86), so browse mode sorts on `[browseScore desc, productId asc]`. Lexical mode uses `function_score` with the same capped multiplier (`boost_mode: multiply`, `max_boost: 4`).

## R-03 Visibility

- **Decision**: every query, aggregation, kNN filter and title suggestion carries one shared filter built in `domain/visibility-filter.ts`: `hasProduct = true AND deleted = false AND status = ACTIVE AND shopHidden = false`. Sandbox products are never written to the public index (ignored at projection, counted `search_ignored_total{reason="sandbox"}`). `shopHidden` is true for `SUSPENDED`, `DELETING`, `DELETED` and offboarding-started. Unknown shop = visible.
- **Shop state propagation**: the shop-state consumer writes the Postgres copy (`SearchShopState`, version guard) **then** runs `update_by_query` on `shopId` to stamp `shopHidden/shopTier/shopStateVersion` (script guards on `shopStateVersion`). New product documents are stamped from the copy at creation (batched lookup, in-process 1 s cache); an existing document keeps its stamp. Residual race (a creation that read the old state, indexed after the `update_by_query` snapshot) is closed by a second `update_by_query` pass after two refresh intervals and by `search.backfill-shop-state`.
- **Offboarding events without `shopVersion`** (`started`, `cancelled`, `deleted`): ordered by the envelope `occurredAt` against `lastEventAt` of the copy (`questions.md` S03 default). A sibling follow-up asks S03 for `shopVersion` on all three.
- **Rationale**: FR-004, FR-022; query-time cost is a single term filter set.

## R-04 Tombstones

- **Decision**: delete writes a tombstone document (`deleted: true`, `productVersion`, `deletedAt`, product fields dropped, vector dropped). Guard rules per AS-81. `search.purge-tombstones` (daily) runs `delete_by_query` on `deleted = true AND deletedAt < now − 30 d`; the shop-search table does the same with `deletedAt` on the row.
- **Alternatives**: engine-side deleted-version retention (`index.gc_deletes`) (rejected: memory bound, not queryable, not rebuilt by a run).

## R-05 Index names, alias, write set

- **Decision**: alias `products` → `products_m<mappingVersion>_<yyyymmddhhmmss>`. First start: `PUT` the index with `aliases` in one call, guarded by `index already exists` as success (race-safe between two instances; `resource_already_exists_exception` is swallowed, then the alias target is read back). Existing indices are never mutated at startup. Legacy concrete index `products`: switch with a single `_aliases` call `[{remove_index: products}, {add: new→products}]` (atomic). Rollback is the same call in reverse.
- **Write set** (dual-write): `{index behind alias} ∪ {active run's index} ∪ {retained previous index}`, resolved by `SearchIndexRegistry` from `SearchReindexRun` rows with a 1 s in-process cache. A run moves `QUEUED → BUILDING` only after waiting two cache TTLs, so every projector instance writes to the new index before the replay starts.
- **Mapping version / model version**: constants in `domain/index-definition.ts`; stored as index `_meta`; `outdated = live._meta.mappingVersion < expected`.
- **Synonyms**: the analyzer's search-time filter is `synonym_graph` with `synonyms_set: "product-synonyms"`, `updateable: true`; the set lives in the engine's synonyms API, so editing it changes search without reindex (FR-043) and new indices reference the same set (FR-045).

## R-06 Synonym edit protocol (no network call inside a transaction, III.3 / III.6)

- **Decision**: `SearchSynonymSet` is one row `{version, rules, updatedBy, updatedAt, pendingVersion, pendingRules, pendingAt}` plus `SearchSynonymVersion` history.
  1. Parse and normalise (pure). If the normalised rules equal current → `200 unchanged: true`, no engine call (AS-57, also for a stale `expectedVersion`).
  2. Claim: `UPDATE … SET pending* = … WHERE version = :expected AND (pendingVersion IS NULL OR pendingAt < now − 30 s)`; zero rows → re-read, `409 synonyms_version_conflict {currentVersion}`. Exactly one concurrent writer wins (AS-56).
  3. Engine `PUT _synonyms/product-synonyms` (timeout 5 s). Failure → clear the claim conditionally, `503 search_unavailable`; active rules and version untouched (AS-58).
  4. Commit in one transaction: promote pending to current, insert a history row, prune to 20 versions / 90 days. Audit log line `{actorId, version, ruleCount}`.
  A crash between 3 and 4 leaves a stale claim that expires in 30 s; `search.retire-previous-index` (hourly) also re-pushes the committed rules when the engine copy differs (reconcile).
- **Seed**: a data migration inserts version 1 from the old code defaults.

## R-07 Reindex build, dual-write and verification gate (interpretation to review)

- **Decision**: a run reads `products.events` from the beginning with its own consumer group `search-reindex-<runId>` up to the end offsets captured when the run enters `BUILDING` (the group's committed offsets are the resume position, mirrored into `replayPosition` for observability). The live projector dual-writes everything after that moment (R-05), so the replay only needs the history up to the watermark. Replay documents take signals from the live index (`mget` per batch) and the Postgres shop-state copy; vectors are copied unless the embedding model version changed. `CATCHING_UP` waits until the live projector group's lag is below 10 s on the topic. The shop-search table is re-applied from the same replay under its version guard (FR-039).
- **Verification gate**: (a) event accounting: events read = applied + duplicate + stale + ignored + tombstoned, with zero engine-rejected documents; (b) `count(new, visible-eligible)` equals `count(live, visible-eligible)` once both are refreshed and lag is below 10 s, retried for up to 30 s while in-flight writes drain.
- **Interpretation to review**: `questions.md` says "exact count equality with the history's expected non-deleted documents". Computing the distinct-key set of a 50 M-product history exactly needs either memory proportional to the catalog or a scratch table; neither is justified for one comparison. The live index is dual-written from the same history, so its eligible count is the expected count whenever the live projection is healthy; a drifted live index fails the gate (`verification_failed`, with both counts in `failureReason` detail) and is repaired by an in-place `ProjectionAdmin.rebuild` instead. The human may prefer the scratch-table variant; it changes only `VerifyReindexUseCase`.
- **Resume / crash**: a re-claimed job reads the run row; in `CATCHING_UP` it first checks whether the alias already targets `run.index` and, if so, records `COMPLETED` without a second switch (AS-45).
- **Cancel vs switch arbitration** (III.6): the switch step claims `UPDATE … SET switchingAt = now() WHERE id = :id AND status = 'CATCHING_UP' AND switchingAt IS NULL`; cancel is `UPDATE … SET status = 'CANCELLED' WHERE id = :id AND status IN (…) AND switchingAt IS NULL`. Exactly one wins; the loser answers `409 invalid_transition`.
- **Single active run**: a partial unique index on a constant expression `WHERE status IN ('QUEUED','BUILDING','CATCHING_UP')` makes the second concurrent `POST` fail with a unique violation mapped to `409 reindex_in_progress` carrying the active `runId`.
- **Completion**: after the alias switch, one transaction does `CATCHING_UP → COMPLETED` (conditional), the history row, `previousIndex`/`retiresAt`, and `outbox.append(search.reindex_completed)`.

## R-08 Semantic mode

- **Decision**: `EmbeddingProvider` port with `embed(text, signal): Promise<number[]>` and `modelVersion`. Default adapter: deterministic local token-hash embedder (64 dims, L2-normalised); tests swap in a phrase-table provider. Query path: embedding under a 300 ms `AbortSignal` budget; on timeout or error → lexical search with `degraded: ["semantic_unavailable"]`. kNN: `knn: {field: embedding, query_vector, k: limit, num_candidates: max(100, 10·limit), filter: [visibility, user filters]}`, no lexical clause. `facets`/`cursor` with `semantic=true` → `422 unsupported_combination`; `semantic` without `q` → `422 semantic_requires_query`. Documents without a vector are absent from kNN (`embeddingPending: true`).
- **Indexing**: vectors computed in the projector only when `changedFields ∩ {title, description, brand, category, tags} ≠ ∅` or on creation; failure indexes the document with `embeddingPending: true`; `search.backfill-embeddings` fills in batches.

## R-09 Query building

- **Decision**: `q` is normalised (NFKC, control characters removed, whitespace collapsed, trimmed, ≤ 100) and sent only inside `multi_match` `query` strings (`fields: title^4, brand^2, description^1, tags^0.5`; `fuzziness: AUTO`, `prefix_length: 1`, `max_expansions: 50`), never `query_string`, so operators and wildcards are plain text. An exact-phrase `match_phrase` on title is added as a `should` boost. Filters are `filter` clauses (unscored). Sorts: `relevance` → `[_score desc, productId asc]`; `price-asc|desc` → `[priceMinor, productId asc]`; `newest` → `[createdAt desc, productId asc]`; browse → `[browseScore desc, productId asc]`.
- **Paging**: `search_after` with the cursor codec (AS-84): base64url of `{sv: sort values, id, fp}` where `fp` is a hash of `(q, filters, sort, mode)`; not tied to a physical index.
- **Totals**: `track_total_hits: 10001`; `exact = relation === 'eq'`, value capped at 10,000 when `gte`.
- **Facets**: `post_filter` carries all filters; each facet is a `filter` aggregation holding every filter except its own (`inStock` and `minRating` apply to all). Terms aggs `size: 20` ordered by `_count desc, _key asc`; price bands via `range` aggregation with keyed buckets; `avg` aggregation rounded to 2 decimals in the DTO mapper. Brands without a keyword are excluded by `exists`. Still exactly one engine request (FR-013).
- **Timeout**: the client call passes `timeout: '900ms'` to the engine and a 1000 ms abort to the HTTP request; a timeout or connection error → `SearchUnavailableError` → `503 search_unavailable`, `Retry-After: 1`.

## R-10 Shop product search (P0308)

- **Decision**: table `SearchShopProduct` (Postgres, owned by `discovery`) with `searchVector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(brand,''))) STORED`, GIN on it, a GIN `gin_trgm_ops` index on `lower(title)`. Query: `WHERE shopId = :shopId AND deletedAt IS NULL [AND status = :s] AND searchVector @@ plainto_tsquery('simple', :q)`; if zero rows, per-word trigram fallback (≤ 8 words, mean `word_similarity` ≥ 0.3) over the same `shopId` predicate. Order `rank DESC, id ASC`; keyset on `(rank, id)` with the rank recomputed deterministically; cursor fingerprint binds `(shopId, q, status)`. `priceMinor` is `bigint`, serialised as a number (the platform's max price fits 2^53), `currency` char(3). All values go through bind parameters; the word list is passed as a `text[]` bind, never concatenated.
- **Rationale**: III.4 (principal in the predicate), III.5, III.8, III.10, P0308.

## R-11 Projection consumers (S53 framework)

- **Decision**: five `Projector`s in `discovery/infra/projectors/`, all `idempotency: 'versionGuard'`, own group names, `aggregateIdSchema: uuid`:
  | Group | Topic | Handles | Staleness accepted |
  |---|---|---|---|
  | `search-indexer` (kept) | `products.events` | product created/updated/archived/restored/deleted → public index + `SearchShopProduct` | 10 s p95 public, 5 s p95 shop table |
  | `search-shop-state` | `shop.events` | status changed, plan changed, offboarding started/cancelled, deleted | 10 s p95 |
  | `search-media` | gallery events | image | 30 s |
  | `search-sponsorship` | sponsorship events | sponsored flag | 30 s |
  | `search-clicks` / `search-queries` (existing, moved) | `search.events` | click and query rows to ClickHouse | 60 s |
  `coalesce: true` for the product group (full snapshots). A product event writes the public index and the shop table in two independent steps; each is idempotent and version-guarded, a failure of either retries the whole event (neither step is a transaction with the other, IX.4).
- **Consumed event contracts that do not exist yet** (`media.gallery_changed`, `marketing.product_sponsorship_changed`): defined as zod schemas in `discovery/domain/consumed-events.ts` (the owner's contract, to be replaced by an import from the owner's entry point when S29 / S36 publish them); listed as sibling follow-ups. Until the media event exists the image stays `null` (neutral, AS-05 behaviour).
- **Image resolution**: `ProductImageResolver` port; the adapter calls `MediaQueryService.getReadyMediaByIds` (R1) once S29 exports it; until then the null adapter is bound by module configuration. The AS-32 e2e runs against a fake resolver standing in for the other domain's R1 service (a system-edge fake, allowed by VII.2), so the scenario is proven now and re-pointed at the real service when S29 lands.
- **Engine outage**: `TransientError` (framework backoff with jitter, no commit). Per-document permanent rejection: `PermanentError` after the framework's attempts → DLQ; the rest of the batch is applied first.

## R-12 Measurement

- **Decision**: `searchId` = `v1.<base64url(JSON{sid, q, iat})>.<base64url(HMAC-SHA256(search_id_signing_key))>`; validation uses `timingSafeEqual` and the injected clock (24 h window). `search.performed` and `search.result_clicked` go through the generic event publisher (direct producer, fire-and-forget, `search_events_dropped_total` on failure, key `searchId`). Redaction (`domain/query-text.ts`): emails, runs of ≥ 9 digits, card-like numbers (13–19 digits with separators) → `[redacted]`; queries shorter than 2 characters not logged. `userHash` = HMAC-SHA256(`search_log_secret`, principal-or-address), truncated to 16 hex characters. ClickHouse: migration adds `TTL … + INTERVAL 90 DAY` to `search_queries` and `search_clicks`. Quality report query uses parameterised ClickHouse queries and bounds `days` 1–90, `limit` 1–100.
- **Popularity**: job reads 30-day click counts per product from ClickHouse, computes the bucket `min(10, floor(log2(1 + clicks)))`, `mget`s current buckets, bulk-updates only changed ones through the popularity guard (`popularityAt`), also refreshing `browseScore`.

## R-13 Capacity, pools and shard sizing (III.12; stated for FR-029 and the notes' capacity model)

- Search: 100,000 searches/s at 50 M products → 24 primary shards (≈ 2 M docs, ≈ 3 GB per shard incl. 64-dim vector), 2 replicas, `refresh_interval: 5s`, bulk 1,000 documents / 5 MB, `number_of_routing_shards` multiple for later split. These are mapping/template settings in `index-definition.ts`.
- Postgres connections: discovery adds low-volume work (shop search reads, run/synonym rows). Pool per process stays `db_pool_max` (default 10); `core` instances ≤ 20 and `projector`/`worker` ≤ 6 each at the current deployment sizes → 20·10 + 6·10 + 6·10 = 320, below the 500 limit configured in the compose profile; the arithmetic is re-stated in `quickstart.md` ops notes. Shop-search statements run under the pool's `statement_timeout`.
- Redis: only rate-limit keys (S50); nothing new.

## R-14 What stays out

`video.ready`, `assets.digital_product_*` (S30/S31) are not consumed; "near me" (S19) shares nothing; "did you mean", highlighting, personalisation not built.

## R-15 Rate-limit policies

- **Decision**: `discovery/rate-limit-policies.ts` declares `discovery.search.query` (120/min, user-or-IP, fail open), `discovery.shop-search` (120/min per user+shop, fail open), `discovery.search-click` (300/min per IP, fail open), `discovery.search-admin` (30/min per admin, fail closed). `search.query` stays declared by `catalog` (its other call sites move in their own capabilities, G-35); the S32 routes stop using it. Replacing `search.query` at the non-S32 call sites is not S32's (see `gaps.md` Sibling-spec follow-ups).

## R-16 Follow-ups from built specs (requirements, mapped to tasks in `plan.md`)

| Follow-up | Resolution |
|---|---|
| S03: no `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw tenancy SQL | Search code uses `ShopScoped`, `ShopQueryService.getShopsByIds`; the legacy `search-reindex.e2e-spec.ts` `ShopModel` registration disappears with the rewrite; retest `403 shop_suspended` / `409 shop_offboarding` / `404 DELETED` (AS-64) |
| S05: host both search routes, projector, logger, popularity, `search.query` | Plan phases 4–8; popularity from clicks (CONTRACT in `questions.md`); remove `RESERVED_PRODUCT_SEGMENTS` entry by mounting the search controller **before** the catalog controllers (module import order) and then deleting the entry in a catalog-owned file only if the S05 spec allows — otherwise left (sibling follow-up) |
| S05: `embedding` mapped TRANSITIONAL, `searchVector` unmapped, old search cases in `product.e2e-spec.ts` | Reindex no longer reads `p.embedding`; the cases move to `search-query.e2e-spec.ts`; the catalog columns drop is S05's contract step after S32 is live (sibling follow-up) |
| S49: `declareJobType` for six job names, `InvalidScheduleError`, cancel result | Task: job-type declarations next to the `JobPayloads` augmentation; handle the discriminated `cancel` result in the reindex cancel path |
| S50: policies of G-35 | R-15 |
| S53: take over `ProductSearchProjector`, no `"Shop"` SQL, own the generic ES client under `EsVersionedSink` | R-01, R-03, R-11 |
