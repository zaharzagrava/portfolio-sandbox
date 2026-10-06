# Showcase Program — Index & Progress

Implements every design from `Interview-Prep/10-System-Design` and the patterns from the other lesson folders, adapted to the marketplace. Read first: [DECISIONS](DECISIONS.md) · [DOUBTS](DOUBTS.md) (your review list) · [CONVENTIONS](CONVENTIONS.md). Lesson → feature traceability: [`lessons/`](lessons/).

Status legend: ☐ planned · ◐ in progress · ☑ done (typechecked; e2e written, not run) · ⏸ blocked

## Build order

### Phase 0 — Foundations

| # | Section | Status | Notes |
|---|---|---|---|
| 1 | [F-01 — Platform Toolkit (cross-cutting backend foundations)](sections/F-01-platform-toolkit.md) | ☑ | CLS, CLS transactions, health, graceful shutdown, load shedding, resilient HTTP, pino |
| 2 | [F-02 — Local Infra & Storage Drivers](sections/F-02-local-infra-and-drivers.md) | ☑ | PostGIS+pgvector image, MinIO, ElasticMQ, DynamoDB Local, ScyllaDB, Mailpit, ClamAV + Nest ports/adapters |
| 3 | [F-04 — Test Harness (e2e against real docker-compose DBs)](sections/F-04-test-harness.md) | ☑ | test compose, jest-e2e, cleanup registry, helpers, specs for payment idempotency/OCC + outbox |
| 4 | [F-05 — CQRS Projection Framework (Outbox / Debezium CDC → Kafka → Read Models)](sections/F-05-cqrs-projection-framework.md) | ☑ | envelopes, outbox fix (Q14), projection runner + versioned sinks, projector app, Debezium |
| 5 | [F-03 — Realtime Push Hub (generalised SSE gateway)](sections/F-03-realtime-push-hub.md) | ☑ | topic SSE with Last-Event-ID replay, ref-counted hub, policies |
| 6 | [SD-29 — Distributed Job Scheduler / Background Jobs](sections/SD-29-job-scheduler.md) | ☑ | partitioned jobs table, SKIP LOCKED leases, fencing, cron leader, `apps/worker` |
| 7 | [SD-28 — Distributed Rate Limiter (edge + gateway + business limits)](sections/SD-28-rate-limiter.md) | ☑ | Lua token bucket/sliding window/concurrency, leases, fail modes, edge sliding window |
| 8 | [SD-34 — Distributed Cache Toolkit (L1/L2, stampede, SWR, write-behind, hot keys)](sections/SD-34-distributed-cache.md) | ☑ | L1/L2, single-flight+lock, XFetch, SWR, negative cache, bloom, write-behind views, ETag |

### Phase 1 — Identity & tenancy

| # | Section | Status | Notes |
|---|---|---|---|
| 9 | [SD-39 — Authentication / SSO Service](sections/SD-39-auth-sso.md) | ☑ | JWKS rotation (ES256), argon2id, Dynamo sessions + refresh reuse detection, TOTP, OIDC PKCE |
| 10 | [SD-02 — Multi-Tenant Shops (B2B SaaS for sellers)](sections/SD-02-multi-tenant-shops.md) | ☑ | shops/memberships/RBAC, BOLA-safe guard, RLS backstop, write-skew-safe owners, cells, per-shop SSO, expand/contract backfill |

### Phase 2 — Commerce core

| # | Section | Status | Notes |
|---|---|---|---|
| 11 | [SD-19 — Cart, Checkout & Inventory (incl. flash sales)](sections/SD-19-checkout-inventory.md) | ☑ | Dynamo carts, idempotent checkout, conditional stock, Redis bucketed flash stock, order state machine, saga listener, Stripe webhook inbox |
| 12 | [SD-20 — Payments & Ledger: Reconciliation, Unknown Outcomes, Hot Accounts, Payouts](sections/SD-20-payments-ledger-reconciliation.md) | ☑ | partitioned ledger + DB-enforced balanced journals, UNKNOWN resolver, daily recon, settlement, payouts, balance projection |
| 13 | [SD-21 — Launch Event Booking (Ticketmaster → "iPhone launch event seats")](sections/SD-21-launch-event-booking.md) | ☑ | sharded waiting room + admission tokens, Redis NX + Dynamo conditional holds, bitmap seat map |
| 14 | [SD-22 — Limited-Drop Auctions (eBay → collectibles & limited editions)](sections/SD-22-limited-drop-auctions.md) | ☑ | atomic Lua proxy bidding + anti-snipe + log, stream relay to partitioned bids, exactly-once close, second chance |
| 15 | [SD-24 — Subscription Billing (Marketplace Plus for buyers, Pro plans for shops)](sections/SD-24-subscriptions-billing.md) | ☑ | versioned prices, anchored periods, proration = preview, ClickHouse metering + late adjustments, dunning, entitlements |
| 16 | [SD-41 — Seller Statements & "As-Of" Reporting (bitemporal)](sections/SD-41-payout-statements-as-of.md) | ☑ | bitemporal rates + exclusion constraint, LATERAL as-of, snapshots + adjustments, streamed CSV from replica |

### Phase 3 — Social & discovery

| # | Section | Status | Notes |
|---|---|---|---|
| 17 | [SD-11 — Product Discussions (Reddit-style posts, nested comments, voting, ranking)](sections/SD-11-product-discussions.md) | ☑ | Scylla posts/threads by materialized path, Redis hot/top/best, write-behind vote counters + exact recount, sanitized markdown |
| 18 | [SD-09 — Follow Feed (Twitter-style home timeline of shops & brands)](sections/SD-09-follow-feed.md) | ☑ | hybrid fan-out (push to active, pull celebrities), heap k-way merge, rebuild-on-return |
| 19 | [SD-08 — Share & Affiliate Links (URL shortener)](sections/SD-08-share-links.md) | ☑ | id leases + Feistel/base62, Dynamo KV, bloom + negative cache, edge-cached 302 + edge click events, ClickHouse stats |
| 20 | [SD-12 — Search Autocomplete (query-log top-K + catalog completions)](sections/SD-12-autocomplete.md) | ☑ | ClickHouse query logs → hourly top-K trie snapshot → in-memory hot-swap, ES with 40 ms budget, CDN-cacheable |
| 21 | [SD-13 — "Available Near Me" (Proximity search for pickup points & local stock)](sections/SD-13-pickup-near-me.md) | ☑ | PostGIS truth + ES geo_distance/collapse/geotile, versioned availability projection |
| 22 | [SD-37 — Product Search: Index Sync, Zero-Downtime Reindex, Relevance](sections/SD-37-product-search-sync.md) | ☑ | alias reindex w/ catch-up, Synonyms API, function_score boosts, PG FTS+trigram for shop admin, CTR/MRR from ClickHouse |
| 23 | [X-01 — "Bought Together" Graph Recommendations (README #18)](sections/X-01-graph-recommendations.md) | ☑ | ClickHouse baskets → nightly cosine co-occurrence → Redis ZSETs, 2-hop BFS for cold products |

### Phase 4 — Realtime

| # | Section | Status | Notes |
|---|---|---|---|
| 24 | [SD-17 — Notification System (email / SMS / push / in-app)](sections/SD-17-notifications.md) | ☑ | event router → per-channel SQS bulkheads, provider failover + breakers, Scylla inbox, quiet hours/caps, signed SNS/Twilio webhooks, suppression |
| 25 | [SD-15 — Live Launch Stream Comments & Reactions](sections/SD-15-live-launch-stream.md) | ☑ | firehose → per-gateway reservoir batcher (250 ms), sharded per-second reaction counters + leased ticker, Dynamo time-bucketed history, async moderation |
| 26 | [SD-18 — Seller Leaderboards & Live Sales Dashboard](sections/SD-18-leaderboard-live-dashboard.md) | ☑ | Lua-atomic ZSET boards with exact revenue + encoded tie-break, replay-safe, snapshots to PG; per-second Redis dashboard pushed only to watched shops; ClickHouse minute rollups |
| 27 | [SD-14 — Product Chat: Delivery Guarantees, Receipts, Presence, Unread (NestJS side)](sections/SD-14-chat-guarantees.md) | ☑ | DB-trigger seqs (Rust-compatible) + trigger outbox, idempotent send, LATERAL sync + content-addressed tail cache, monotonic receipts over SSE, presence transitions, delayed offline push via SQS |
| 28 | [SD-16 — Collaborative Product Listing Editor (Google Docs-lite for shop teams)](sections/SD-16-collaborative-listing-editor.md) | ☑ | new apps/collab: y-websocket rooms with per-message permission checks, consistent-hash ring routing (256 vnodes), Dynamo update log + S3 compaction, tickets, versions, publish via outbox |
| 29 | [SD-23 — Same-Day Courier Delivery (Uber-style dispatch)](sections/SD-23-same-day-courier-delivery.md) | ☑ | city-tagged Redis GEO + ordered-location Lua, SET NX offer locks, SQS-delayed offer expiry, conditional state machine, Dynamo GPS track, geohash surge |

### Phase 5 — Developer platform & growth

| # | Section | Status | Notes |
|---|---|---|---|
| 30 | [SD-07 — Seller Public API & Developer Platform](sections/SD-07-seller-public-api.md) | ☑ | apps/public-api: hashed prefixed keys + Redis cache, sandbox shadow shops, scopes, Stripe-style date versions + transformers, deprecation headers, reusable Idempotency-Key store, bulk/batch, ClickHouse request logs |
| 31 | [SD-30 — Webhook Delivery Platform (for shops' systems)](sections/SD-30-webhook-delivery.md) | ☑ | SQS FIFO per-endpoint groups, HMAC t.body signatures with dual secrets, SSRF guard with pinned IP, breaker + FIFO→job-lane backoff + auto-disable, Dynamo attempt log + replay, Lambda handler |
| 32 | [SD-38 — Feature Flags & Remote Config](sections/SD-38-feature-flags.md) | ☑ | in-memory local-eval SDK (murmur3 sticky rollouts, ordered rules) with pub/sub push + poll fallback, versioned CAS-published rulesets, audit, kill switch, pre-evaluated client flags, stale report |
| 33 | [SD-31 — Analytics Event Ingestion & A/B Testing](sections/SD-31-analytics-ab-testing.md) | ☑ | edge /collect → Kafka → ClickHouse Kafka engine (+error-stream DLQ), event-time partitions, dedupe by event_id, layered murmur3 assignment with DB-enforced exclusion, z-test + SRM readouts |
| 34 | [SD-32 — Trending Products (top-K) & Sponsored Listing Click Billing](sections/SD-32-trending-sponsored-clicks.md) | ☑ | Count-Min + top-K heap over event-time tumbling windows → Redis merged trending; signed impression click tokens, salted hot keys, Kafka-transaction exactly-once aggregation, idempotent hourly billing + daily raw reconciliation into the ledger |
| 35 | [SD-01 — Embeddable "Buy on Marketplace" Storefront Widget](sections/SD-01-storefront-widget.md) | ☑ | pk site keys bound to exact origins, per-site frame-ancestors on the embed page, shop-signed single-use identity hand-off → in-memory widget token, edge-served 2.5 KB loader with origin-checked postMessage, kill switch |
| 36 | [SD-04 — Backend-for-Frontend (mobile/web) with GraphQL aggregation](sections/SD-04-bff-graphql.md) | ☑ | apps/bff (no DB): parallel aggregate with per-section budgets + partial errors, code-first GraphQL with per-request DataLoaders over core batch endpoints, depth/cost rule, persisted-query allowlist |
| 37 | [SD-05 — Brand Stories CMS & Edge-Cached Content (Jamstack/ISR backend half)](sections/SD-05-cms-brand-stories.md) | ☑ | versioned multi-locale stories with write-time sanitized blocks, scheduled publish, Redis read model + s-maxage/SWR/Cache-Tag/ETag, tag purge (Cloudflare + Next revalidate) via outbox, streamed sitemaps, signed previews |
| 38 | [SD-06 — Offline-First Inventory Sync (pop-up store / warehouse app backend)](sections/SD-06-offline-inventory-sync.md) | ☑ | client opId idempotency, commutative stock deltas (count → delta vs device base), per-field LWW by HLC, trigger-fed per-shop change log for pull, oversell conflicts for review |

### Phase 6 — Media, files & data pipelines

| # | Section | Status | Notes |
|---|---|---|---|
| 39 | [SD-03 — Serverless Workers (SQS + Lambda)](sections/SD-03-serverless-lambdas.md) | ☑ | Lambda toolkit: partial-batch helper (FIFO-group aware), Dynamo idempotency records, cached Nest context vs small handlers, EMF metrics, manifest-driven local runner + tsc→esbuild bundles |
| 40 | [SD-10 — Product & Review Photos (Instagram-style media pipeline)](sections/SD-10-review-photos.md) | ☑ | presigned POST (policy-enforced), Nest-free sharp Lambda: sniffed format, pixel-bomb guard, EXIF/GPS strip, content-hashed immutable WebP variants, dHash + LSH bands for stolen-photo detection, outbox ready event |
| 41 | [SD-27 — Bulk Catalog Import (large file upload & processing)](sections/SD-27-bulk-catalog-import.md) | ☑ | S3 multipart presigned parts, ClamAV INSTREAM scan, sniffing, streaming parse with natural backpressure, 1k-row idempotent upserts + checkpoints/resume, per-shop fairness, streamed error report; cursor-streamed order export |
| 42 | [SD-25 — Seller Asset Library & Digital Product Delivery (Dropbox-style)](sections/SD-25-seller-media-library.md) | ☑ | FastCDC content-defined chunks (1 of 105 changes on a mid-file insert), per-shop dedupe with checksum-signed PUTs, delta sync, conflicted copies, refcount GC with grace, change journal, capped share links, buyer-bound digital downloads |
| 43 | [SD-26 — Product Video & Launch VOD (adaptive streaming)](sections/SD-26-product-video.md) | ☑ | transcoding DAG (Kahn topo-sort, fan-out renditions on separate workers, row-locked fan-in), aligned-GOP H.264 HLS ladder without upscaling, killable ffmpeg tasks, signed-cookie playback for unlisted videos |
| 44 | [SD-36 — Shop Integrations: Shopify/WooCommerce Catalog & Stock Sync (ETL)](sections/SD-36-shop-integrations-sync.md) | ☑ | provider port + zod ACL (Shopify adapter, fake), watermark+overlap incremental sync with page checkpoints, quarantine on drift, hash-based echo suppression both ways, per-credential buckets, webhook HMAC + fast ACK, separate backfill queue, nightly reconcile |
| 45 | [SD-35 — Competitor Price Monitor (Web crawler)](sections/SD-35-competitor-price-monitor.md) | ☑ | Redis frontier with per-host leases + Crawl-delay, RFC 9309 robots, pinned SSRF-safe fetches re-guarded per redirect, JSON-LD/meta price extraction, SimHash+price change detection with adaptive recrawl, shared fetch per URL, undercut alerts, ClickHouse history |
| 46 | [SD-40 — Shop Functions: Seller Code in a Sandbox (Online judge adaptation)](sections/SD-40-shop-functions-sandbox.md) | ☑ | seller JS in isolated-vm isolates (memory cap, timeout, no Node APIs; verified), judge with per-case verdicts, zod-validated + host-clamped output, optional checkout port with 5 ms budget, fail-safe pricing, breaker, memoization |

### Phase 7 — AI

| # | Section | Status | Notes |
|---|---|---|---|
| 47 | [SD-42 — Shopping Assistant (LLM chat, streamed)](sections/SD-42-shopping-assistant-llm.md) | ☑ | Claude via a provider port (adaptive thinking, effort, cached frozen prefix, server-side refusal fallbacks), append-only Scylla transcript replayed verbatim + one-summary compaction, read-only strict tools, Redis Stream buffer with Last-Event-ID resume, abort on disconnect, three-layer quotas, ClickHouse cost/TTFT |
| 48 | [SD-43 — "Ask This Product" & Seller Help Center (RAG)](sections/SD-43-rag-help-center.md) | ☑ | structure-aware chunker (md + PDF pages), Voyage/hashing embedder port, halfvec HNSW + FTS in one round trip with in-query scope filters, RRF + similarity floor, search_result citations, not_found without a model call, content-hash idempotent SQS ingestion, recall@k/MRR eval |
| 49 | [SD-44 — Seller Onboarding: AI Document Processing (KYC) + Staged Questionnaire](sections/SD-44-seller-onboarding-doc-ai.md) | ☑ | Redis-staged zod-validated questionnaire → one-transaction submit + outbox, hash-deduped KYC uploads, Claude structured-output extraction (PDF/image) with cheap→strong escalation, IBAN/VAT/name rules, sealed PII, human review with recorded corrections, Lambda with partial batch failures, retention purge |

### Phase 8 — Operations & cloud

| # | Section | Status | Notes |
|---|---|---|---|
| 50 | [SD-33 — Observability Platform (metrics, logs, traces, alerting)](sections/SD-33-observability-platform.md) | ☑ | OTel bootstrap per app (instrument.ts first), per-instrument attribute allowlists + series caps, collector with PII scrub + tail sampling, Prometheus/Alertmanager/Loki/Alloy/Grafana as code, cause alerts + SLO-generated multi-window burn-rate rules and k6 thresholds, 5 dashboards |
| 51 | [O-01 — SLOs, Error Budgets, Runbooks, Incident Process](sections/O-01-slo-runbooks.md) | ☑ | 9 SLO YAMLs → generated burn-rate rules + k6 thresholds, severity/paging + error budget policy, 8 runbooks with exact triage queries, blameless postmortem template + worked flash-sale drift example |
| 52 | [O-02 — Production Dockerfiles & CI/CD (GitHub Actions → ECR → CodeDeploy / Lambda)](sections/O-02-docker-ci-cd.md) | ☑ | one multi-stage Dockerfile (fetch-cached, prod-only deps, tini, non-root, cgroup-sized heap) + migrator target, CI with config validation + compose e2e, OIDC/SBOM/Trivy builds, ordered deploy: migrations → blue/green APIs → instance refresh → Lambda canary, drain hooks |
| 53 | [O-03 — Terraform AWS Infrastructure (no Kubernetes)](sections/O-03-terraform-aws.md) | ☑ | 19 modules + one stack for demo/prod sizing: tiered VPC, ALB path routing, Spot-mixed ASGs with SSM-pinned image + drain hooks + CodeDeploy blue/green, RDS/Valkey/OpenSearch/ClickHouse, schema-from-source DynamoDB/Keyspaces/SQS/Lambda, OIDC roles, gating alarms, budgets, cost table |

## Why this order

- **Phase 0** builds what everything else stands on: request context/errors/shutdown, local stores, test harness, the CQRS projection framework (D26), realtime push, jobs, rate limiting, caching.
- **Phase 1** introduces shops as tenants and modern auth early, so later features are tenant-scoped from day one instead of retrofitted.
- **Phases 2–7** go from the money path outward. Each phase reuses earlier building blocks (e.g. SD-21 waiting room is reused for flash sales; SD-03 Lambdas serve media, webhooks and AI pipelines).
- **Phase 8** wraps it in observability, SLOs, CI/CD and Terraform for the cheap `demo` / full `prod` AWS environments (D15, D16).

## Log

- 2026-10-01 — Plan written: 53 section files, 10 lesson maps, decisions D1–D26, doubts Q1–Q8.
- 2026-10-01 — F-01 implemented. Baseline had 9 pre-existing tsc errors (Sentry `@sentry/node` import, Stripe apiVersion literal, outbox-publisher tx typing, request.service axios generic, two stale e2e specs) — untouched; no new errors introduced.
- 2026-10-01 — F-02 implemented (compose edited, nothing started).
- 2026-10-01 — F-04 implemented. Baseline tsc errors 9 → 7 (two stale e2e specs replaced).
- 2026-10-01 — F-05 implemented. Outbox publisher double-publish bug fixed (Q14). Search indexing moved to `apps/projector` (run `pnpm start:dev:projector`). Baseline tsc errors 7 → 6.
- 2026-10-01 — F-03 implemented.
- 2026-10-01 — SD-29 implemented (new app `apps/worker`).
- 2026-10-01 — SD-28 implemented (login + search limited; global throttler now Redis-backed).
- 2026-10-01 — SD-34 implemented. **Phase 0 complete.**
- 2026-10-01 — SD-39 implemented. Login/register responses gained `refreshToken`, `sessionId` (additive); access tokens are now ES256 with `kid` (legacy RS256 still verified).
- 2026-10-01 — SD-02 implemented. **Phase 1 complete.** To migrate existing sellers into shops: enqueue `tenancy.backfill-shops` once (worker runs it in batches, then validates the contract constraint).
- 2026-10-01 — SD-19 implemented.
- 2026-10-01 — SD-20 implemented (README #11 partitioning done as part of it).
- 2026-10-01 — SD-21 implemented.
- 2026-10-01 — SD-22 implemented.
- 2026-10-01 — SD-24 implemented (auction creation now requires the `auctions` entitlement → Pro plan).
- 2026-10-01 — SD-41 implemented. **Phase 2 (commerce core) complete.**
- 2026-10-01 — SD-11 implemented.
- 2026-10-01 — SD-09 implemented.
- 2026-10-01 — SD-08 implemented.
- 2026-10-01 — SD-12 implemented.
- 2026-10-01 — SD-13 implemented.
- 2026-10-01 — SD-37 implemented. Paused here (user break). Next: X-01 graph recommendations, then Phase 4 (SD-17, 15, 18, 14, 16, 23).
- 2026-10-01 — X-01 implemented. Phase 3 complete.
- 2026-10-01 — SD-17 implemented.
- 2026-10-01 — SD-15 implemented.
- 2026-10-01 — SD-18 implemented.
- 2026-10-01 — SD-14 implemented.
- 2026-10-01 — SD-16 implemented.
- 2026-10-01 — SD-23 implemented. **Phase 4 complete.**
- 2026-10-01 — SD-07 implemented.
- 2026-10-01 — SD-30 implemented.
- 2026-10-01 — SD-38 implemented.
- 2026-10-01 — SD-31 implemented.
- 2026-10-01 — SD-32 implemented.
- 2026-10-01 — SD-01 implemented.
- 2026-10-01 — SD-04 implemented.
- 2026-10-01 — SD-05 implemented.
- 2026-10-01 — SD-06 implemented. **Phase 5 complete.** Paused here. Next: Phase 6 (SD-03, 10, 27, 25, 26, 36, 35, 40), then Phase 7 (SD-42, 43, 44), Phase 8 (SD-33, O-01..03).
- 2026-10-02 — SD-03 implemented.
- 2026-10-02 — SD-10 implemented.
- 2026-10-02 — SD-27 implemented.
- 2026-10-02 — SD-25 implemented.
- 2026-10-02 — SD-26 implemented.
- 2026-10-02 — SD-36 implemented.
- 2026-10-02 — SD-35 implemented.
- 2026-10-02 — SD-40 implemented. **Phase 6 complete.**
- 2026-10-02 — SD-42 implemented.
- 2026-10-02 — SD-43 implemented.
- 2026-10-02 — SD-44 implemented. **Phase 7 complete.**
- 2026-10-02 — SD-33 implemented.
- 2026-10-02 — O-01 implemented.
- 2026-10-02 — O-02 implemented.
- 2026-10-02 — O-03 implemented. **All 53 sections done.**
