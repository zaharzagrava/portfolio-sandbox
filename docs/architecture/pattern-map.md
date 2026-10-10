# Pattern Map

Every engineering pattern from `interview-prep`: where it lives in the codebase, which
capability spec must prove it, and how far it has got. It supersedes the per-lesson tables in
`docs/showcase/lessons/` (their paths predate the domain refactor and every status still says "planned").

- **Where**: the owning domain (`libs/domains/<d>`), infrastructure / common lib, composition lib, app, or
  ops artifact. Domain names, not file paths, so the map survives moves.
- **Specs**: capability IDs from [`scripts/sdd/capabilities.tsv`](../../scripts/sdd/capabilities.tsv).
  `/speckit-specify` for that capability must turn the pattern into requirements and acceptance scenarios
  (see [`sdd-runbook.md`](sdd-runbook.md)). `S…` = backend, `W…` = web app, `J…` = cross-domain journey;
  `ops` = proven by an ops artifact, not an e2e spec.
- **Status**:
  - `implemented`: code exists (showcase sections are all ☑).
  - `spec'd`: the capability spec covers it.
  - `verified`: its tests pass in the SDD gate.
  - `skipped`: deliberately not built (decisions D6/D7).

  The implementation loop moves rows from `implemented` to `verified`.

## 01 · JavaScript & TypeScript

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0101 | Bounded concurrency, `allSettled` for partial responses | 01/01 promises | common/core (promise-pool); composition/bff; community (feed hydration) | S48, S26 | implemented |
| P0102 | Async iteration / generators over paged and streamed sources | 01/01 | payments (PSP pagination); orders (export); assistant (LLM stream) | S14, S12, S46 | implemented |
| P0103 | Money in integer minor units, largest-remainder allocation, explicit rounding | 01/01 money | common/money; orders; billing | S10, S17 | implemented |
| P0104 | Dates and time zones (UTC storage, Luxon, DST, month-end anchors) | 01/01 | infrastructure/jobs (cron tz); notifications (quiet hours); billing (anchors) | S49, S28, S17 | implemented |
| P0105 | Closures and leaks: bounded maps, listener cleanup | 01/01 | infrastructure/realtime (per-connection buffers); infrastructure/cache (bounded L1) | S51, S52 | implemented |
| P0106 | Workers / SharedArrayBuffer / Atomics | 01/01 | none | — | skipped (D6) |
| P0107 | ESM vs CJS bundling | 01/01 | apps/lambdas (esbuild) | S55 | implemented |
| P0108 | Proxy / Reflect / Symbols | 01/01 | none | — | skipped (D6) |
| P0109 | Branded / nominal IDs | 01/02 §1 | common/core (brand); all domains | all | implemented |
| P0110 | Discriminated unions + `assertNever` state machines | 01/02 §2 | orders, billing, auctions, fulfilment, launch-events; infrastructure/jobs (job types) | S10, S17, S21, S20, S22, S49 | implemented |
| P0111 | Conditional / mapped / template-literal types | 01/02 §5 | infrastructure/realtime (topics); infrastructure/events (event map) | S51, S53 | implemented |
| P0112 | Runtime validation at boundaries (class-validator HTTP, zod messages) | 01/02 §8 | infrastructure/events; developer-platform (webhooks); catalog-sync (integrations); seller-onboarding; shop-functions | S53, S43, S08, S04, S45 | implemented |
| P0113 | `satisfies` / `as const` policy tables | 01/02 §7 | infrastructure/rate-limit (policies); state transition tables | S50 | verified |
| P0114 | Module augmentation (request context, job registry) | 01/02 §9 | infrastructure/context; infrastructure/jobs (`JobTypes`) | S54, S49 | implemented |
| P0115 | tsconfig strictness review | 01/02 §10 | repo tsconfig | ops | implemented |

## 02 · Node.js

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0201 | Event-loop lag detection + load shedding | 02/01 | common/load-shedding | S54 | implemented |
| P0202 | libuv thread-pool sizing (argon2, crypto, fs) | 02/01 | identity (argon2); Dockerfile env | S01, ops | implemented |
| P0203 | `child_process.spawn` with streams, timeouts, kill on abort | 02/01 | media (ffmpeg) | S30 | implemented |
| P0204 | `worker_threads` | 02/01 | none (only if profiling demands, D7) | — | skipped (D7) |
| P0205 | AsyncLocalStorage request context | 02/01 §5 | infrastructure/context (nestjs-cls) | S54 | implemented |
| P0206 | HTTP keep-alive agents; server `keepAliveTimeout` above ALB idle | 02/01 | infrastructure/http-client; ALB settings | S54, ops | implemented |
| P0207 | Streams, backpressure, `pipeline`, object-mode Transform | 02/02 | catalog-sync (import); orders (export); statements (CSV); content (sitemap) | S07, S12, S16, S27 | implemented |
| P0208 | Web Streams ↔ Node streams | 02/02 | assistant (provider stream → SSE) | S46 | implemented |
| P0209 | SSE / streaming responses | 04/01 §2.8 | infrastructure/realtime; assistant | S51, S46, W05 | implemented |
| P0210 | Container heap limits, heap snapshot on signal | 02/03 | Dockerfile | ops | implemented |
| P0211 | Profiling and load testing (k6 per capability) | 02/03 | scripts/load-tests | ops | implemented |
| P0212 | Error taxonomy, async propagation, mapping to HTTP | 02/04 §1–3 | common/exceptions-filter, common/errors | S54 | implemented |
| P0213 | Graceful shutdown order, PID 1, startup ordering | 02/04 §4–5 | common/lifecycle; Dockerfile (`tini`) | S54 | implemented |
| P0214 | Nest request lifecycle placement (middleware → guards → interceptors → pipes → filters) | 02/05 §1 | common/platform; identity guards; infrastructure/rate-limit; developer-platform (ApiKeyGuard) | S54, S01, S50, S42 | verified |
| P0215 | DI scopes: no REQUEST scope on hot paths, dynamic modules | 02/05 §2 | infrastructure modules (`forRootAsync`); composition/bff (DataLoaders via CLS) | S54, S48 | implemented |
| P0216 | CLS-managed transactions across services | 02/05 §4 | infrastructure/context (transaction runner) | S54 | implemented |
| P0217 | Cron with replicas (leader election) | 02/05 §6 | infrastructure/jobs | S49 | implemented |

## 03 · Databases

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0301 | `pg_stat_statements`, unused / redundant index queries | 03/01 | ops admin endpoint + runbook | ops | implemented |
| P0302 | Composite index order, `shopId`-leading indexes | 03/01 | tenancy migrations (all shop-scoped tables) | S03 | implemented |
| P0303 | Covering indexes (`INCLUDE`) for index-only scans | 03/01 | orders (order history) | S10 | implemented |
| P0304 | Partial indexes | 03/01 | launch-events (`UNIQUE(eventId, seatId) WHERE status='BOOKED'`); infrastructure/jobs | S22, S49 | implemented |
| P0305 | Expression indexes | 03/01 | identity (`lower(email)`) | S01 | implemented |
| P0306 | Keyset pagination with deterministic tiebreaker | 03/01, 04/03 §2 | every list endpoint | all | implemented |
| P0307 | ORM traps: N+1, unbounded includes | 03/01 | composition/bff (DataLoader); per capability | S48, all | implemented |
| P0308 | Postgres FTS vs Elasticsearch | 03/01 §9 | discovery (shop-admin FTS); assistant (hybrid BM25) | S32, S47 | implemented |
| P0309 | MVCC / VACUUM, HOT updates (`fillfactor`) | 03/02 §1 | infrastructure/jobs (`Job` fillfactor 70) | S49 | implemented |
| P0310 | Write skew: SERIALIZABLE + retry | 03/02 §3–4 | tenancy ("shop keeps ≥ 1 owner") | S03 | implemented |
| P0311 | Lost-update prevention (atomic update, OCC, `FOR UPDATE`, conditional) | 03/02 §4 | orders; launch-events; auctions; payments (OCC) | S10, S22, S21, S13 | implemented |
| P0312 | Row locks, `SKIP LOCKED`, advisory locks | 03/02 §5 | infrastructure/jobs; launch-events (GA variant) | S49, S22 | implemented |
| P0313 | Deadlock avoidance (sorted lock order) | 03/02 §7 | orders (multi-item); payments (transfers) | S10, S14 | implemented |
| P0314 | DDL lock safety (`lock_timeout`, `CONCURRENTLY`) | 03/03 §1 | every migration (constitution III.11) | ops | implemented |
| P0315 | Expand / contract migrations + batched backfill | 03/03 §1 | tenancy (`shopId` backfill); payments (ledger partitioning) | S03, S14 | implemented |
| P0316 | Connection pooling (PgBouncer transaction mode, RDS Proxy, `SET LOCAL`) | 03/03 §2 | infrastructure/database; tenancy (RLS `SET LOCAL`) | S03, ops | implemented |
| P0317 | Read replicas, replica lag, read-your-writes | 03/03 §3 | infrastructure/projections (`minVersion`) | S53 | implemented |
| P0318 | Table partitioning | 03/03 §4 | infrastructure/jobs (daily); payments (ledger, monthly); chat (monthly); auctions (bids) | S49, S14, S24, S21 | implemented |
| P0319 | Sharding / cells by `shopId` | 03/03 §5 | tenancy (`ShopDirectory`) | S03 | implemented |
| P0320 | IDs: UUIDv7, timeuuid, ID-range leases | 03/03 §6 | all; community (timeuuid); marketing (link ID leases) | S25, S37 | implemented |
| P0321 | Temporal / bitemporal data | 03/03 §7 | statements | S16 | implemented |
| P0322 | CDC (Debezium) | 03/03 §9 | infrastructure/projections | S53 | implemented |
| P0323 | Redis structures: ZSET, GEO, bitmap, streams, HLL, hashes | 03/04 §2 | community, seller-insights, launch-events (ZSET, bitmap); fulfilment (GEO); infrastructure/realtime (streams) | S25, S40, S22, S20, S51 | implemented |
| P0324 | Cache-aside, write-behind, SWR, stampede, avalanche, penetration, hot / big keys | 03/04 §3–4 | infrastructure/cache; catalog (product cache); orders (flash-sale stock buckets = hot-key splitting) | S52, S05, S11 | implemented |
| P0325 | Eviction policies (separate cache vs state clusters) | 03/04 §5 | ElastiCache parameter groups | ops | implemented |
| P0326 | Distributed locks + fencing tokens | 03/04 §6 | infrastructure/cache; launch-events | S52, S22 | implemented |
| P0327 | Rate limiting in Redis (Lua) | 03/04 §7 | infrastructure/rate-limit | S50 | verified |
| P0328 | Geo queries: PostGIS `ST_DWithin` as truth, ES `geo_distance` + geohash clustering, Redis GEO for live positions | 03/01, 10/05 #13, 10/07 #23 | fulfilment (pickup near me, courier positions) | S19, S20 | implemented |

## 04 · API design

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0401 | HTTP/2 / keep-alive between BFF and services | 04/01 §1.1 | composition/bff | S48 | implemented |
| P0402 | Aggregate endpoints / BFF with per-call budgets and partial responses | 04/01 §2.1–2.2 | composition/bff | S48, W02 | implemented |
| P0403 | `expand` / sparse fieldsets with depth limits | 04/01 §2.3–2.4 | developer-platform (public API) | S42 | implemented |
| P0404 | Batch / bulk endpoints | 04/01 §2.5 | developer-platform (`/v1/batch`, bulk stock) | S42 | implemented |
| P0405 | GraphQL + DataLoader + complexity limits + persisted queries | 04/01 §2.6 | composition/bff | S48 | implemented |
| P0406 | Push instead of poll (SSE) | 04/01 §2.8 | infrastructure/realtime | S51, W05, W04 | implemented |
| P0407 | Async request-reply (202 + status / SSE) | 04/01 §2.9 | orders (checkout); catalog-sync (import); payments | S10, S07, S13 | implemented |
| P0408 | CQRS read models | 04/01 §2.10 | infrastructure/projections; discovery | S53, S32 | implemented |
| P0409 | RFC 9457 problem details, stable error codes, precise status codes | 04/01 §3 | common/exceptions-filter | S54, all | implemented |
| P0410 | HTTP caching: ETag / `If-None-Match`, `Cache-Control`, SWR | 04/01 §3 | infrastructure/cache (ETag interceptor); content | S52, S27 | implemented |
| P0411 | Versioning: URI major + date-pinned versions, transformers | 04/02 §2 | developer-platform | S42 | implemented |
| P0412 | Deprecation policy: `Deprecation` / `Sunset` headers, telemetry, ownership | 04/02 §3–7 | developer-platform | S42 | implemented |
| P0413 | Webhook and event versioning | 04/02 §8 | developer-platform (webhooks); infrastructure/events | S43, S53 | implemented |
| P0414 | Idempotency keys (replay, in-flight 409, different-body 422, TTL) | 04/03 §1 | infrastructure/idempotency; orders; launch-events; auctions; developer-platform; payments (intents, payout transfers keyed by payout ID) | S10, S22, S21, S42, S13, S15, W03, J01 | implemented |
| P0415 | Cursor pagination (opaque, signed) | 04/03 §2 | every list endpoint | all | implemented |
| P0416 | Rate limiting as provider (algorithms, `RateLimit` headers, 429) | 04/03 §3 | infrastructure/rate-limit; edge-be | S50 | verified |
| P0417 | Consuming rate-limited APIs (token bucket per credential, `Retry-After`) | 04/03 §4 | catalog-sync (integrations); assistant (LLM provider) | S08, S46 | implemented |
| P0418 | Webhooks as provider (signing, retries, auto-disable) | 04/03 §5 | developer-platform | S43 | implemented |
| P0419 | Webhooks as consumer (verify raw body, fast 2xx, dedupe event ID) | 04/03 §5 | orders (Stripe); notifications (provider status); catalog-sync (Shopify) | S10, S28, S08 | implemented |

## 05 · Security

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0501 | XSS: output encoding, sanitised user markdown / HTML | 05/01 §1 | community (discussions); content (story blocks) | S25, S27 | implemented |
| P0502 | CSP (strict, nonce), `frame-ancestors` per site | 05/01 §2 | developer-platform (widget embed pages); web | S44, W07 | implemented |
| P0503 | Security headers (HSTS, nosniff, CORP / COOP, Referrer-Policy) | 05/01 §2.7 | common/platform | S54 | implemented |
| P0504 | CSRF (double-submit / SameSite / Origin) for cookie-authenticated mutations | 05/01 §3 | identity; composition/bff; developer-platform (widget) | S01, S48, S44, W01 | implemented |
| P0505 | Strict CORS allowlist (not a security boundary) | 05/01 §4 | common/platform | S54 | implemented |
| P0506 | Safe error messages, anti-enumeration | 05/01 §5 | common/exceptions-filter; identity (login, reset) | S54, S01 | implemented |
| P0507 | SSRF guard (resolve, block private ranges, re-check per redirect) | 05/01 §6 | infrastructure/net; developer-platform (webhooks); seller-insights (crawler) | S43, S41 | implemented |
| P0508 | Injection: parameterised raw SQL, prepared CQL | 05/01 §6 | all raw queries | all | implemented |
| P0509 | Upload security (separate domain, nosniff, attachment, AV scan, magic bytes) | 05/01 §1, 10/08 | media; catalog-sync (import) | S29, S07 | implemented |
| P0510 | Untrusted code isolation (`vm` is not a sandbox) | 05/01 §7 | shop-functions | S45 | implemented |
| P0511 | Sessions vs JWT; JWT pitfalls (alg pinning, kid, exp / aud / iss) | 05/02 §1–2 | identity | S01 | implemented |
| P0512 | Token storage in the browser (BFF holds tokens, HttpOnly cookie) | 05/02 §3 | composition/bff; identity | S48, S01, W01 | implemented |
| P0513 | OAuth 2 / OIDC + PKCE, state, nonce | 05/02 §4 | identity; tenancy (per-shop SSO) | S02, S03 | implemented |
| P0514 | Password hashing (Argon2id, rehash on verify), brute-force protection | 05/02 §5 | identity | S01 | implemented |
| P0515 | RBAC / ABAC / permission matrix | 05/02 §6 | tenancy | S03, W06 | implemented |
| P0516 | Record-level security, Postgres RLS, BOLA tests | 05/02 §7 | tenancy; developer-platform; every shop-scoped endpoint | S03, S42, all | implemented |
| P0517 | Service-to-service auth (audience-scoped internal JWT) | 05/02 §8 | identity | S01 | implemented |
| P0518 | Secrets management, envelope-encrypted fields | 05/02 §9 | identity (SecretBox); developer-platform; catalog-sync; seller-onboarding | S01, S43, S08, S04 | implemented |
| P0519 | OWASP API Top 10 mapping | 05/02 §10 | developer-platform docs | S42 | implemented |

## 06 · Distributed systems

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0601 | Queue vs log; fan-out vs competing consumers (Kafka → SQS bridge) | 06/01 §1 | notifications (router); infrastructure/events | S28, S53, J01 | implemented |
| P0602 | SNS → SQS fan-out | 06/01 §1.2 | prod topology (Terraform) | ops | implemented |
| P0603 | Idempotent producer, Kafka transactions (exactly-once in Kafka) | 06/01 §2 | infrastructure/events; marketing (click aggregator) | S53, S36 | implemented |
| P0604 | SQS standard vs FIFO, `MessageGroupId`, dedup IDs, visibility, DLQ / redrive, partial batch failures | 06/01 §3 | developer-platform (webhooks); apps/lambdas | S43, S55 | implemented |
| P0605 | Consumer groups, partition assignment, cooperative rebalancing | 06/01 §4 | infrastructure/projections | S53 | implemented |
| P0606 | Transactional outbox / inbox, idempotent consumers | 06/01 §5 | infrastructure/outbox, infrastructure/projections; every consumer | S53, all, J01, J02, J03, J04, J05 | implemented |
| P0607 | Per-key ordering | 06/01 §6 | infrastructure/events; auctions; chat | S53, S21, S24 | implemented |
| P0608 | Event design: envelope, versioning, thin vs fat | 06/01 §7 | infrastructure/events; developer-platform (webhooks) | S53, S43 | implemented |
| P0609 | Consumer backpressure | 06/01 §8 | infrastructure/projections; community (fan-out) | S53, S26 | implemented |
| P0610 | Consistency models per feature (strong for holds and bids, eventual for read models) | 06/02 §1 | per capability spec | all | implemented |
| P0611 | Sagas with compensations | 06/02 §2 | orders ↔ payments | S10, S13, J01 | implemented |
| P0612 | Bidirectional sync, echo suppression, conflict queue | 06/02 §3 | catalog-sync (integrations, offline sync) | S08, S09, J04 | implemented |
| P0613 | Incremental ETL with watermark + overlap, backfill separation | 06/02 §4 | catalog-sync (integrations) | S08 | implemented |
| P0614 | Reconciliation and period close | 06/02 §5 | payments; marketing (ad billing); catalog-sync; statements; billing (late usage → adjustment lines) | S14, S36, S08, S16, S18, J01 | implemented |
| P0615 | Clocks and ordering (server time authority, HLC) | 06/02 §6 | auctions; catalog-sync (offline sync) | S21, S09 | implemented |
| P0616 | Timeouts, retries with jitter, retry budgets | 06/03 §1–2 | infrastructure/http-client | S54 | implemented |
| P0617 | Circuit breakers (per dependency / per endpoint) | 06/03 §3 | infrastructure/stripe; developer-platform (webhooks); assistant | S13, S43, S46 | implemented |
| P0618 | Bulkheads | 06/03 §4 | notifications (per-channel queues); tenancy (noisy neighbours) | S28, S03 | implemented |
| P0619 | Load shedding and admission control | 06/03 §5 | common/load-shedding; launch-events (waiting room); orders (flash-sale admission) | S54, S22, S11 | implemented |
| P0620 | Fallbacks / graceful degradation (tested) | 06/03 §6 | composition/bff (partial); shop-functions (no-discount); assistant (fallback model) | S48, S45, S46 | implemented |

## 07 · Observability & reliability

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0701 | SLI / SLO definitions, error budgets and policy | 07/01 | docs/slo | ops | implemented |
| P0702 | Burn-rate alerts, cause-based thresholds | 07/01 | generated alert rules | ops | implemented |
| P0703 | Runbooks, incident process, postmortems | 07/01 | docs/runbooks | ops | implemented |
| P0704 | Metric types, RED / USE, cardinality caps | 07/02 §2 | common/telemetry | S54 | implemented |
| P0705 | Structured logs (pino), redaction, correlation IDs | 07/02 §3 | common/logging | S54 | implemented |
| P0706 | Tracing (OTel) with context propagation across Kafka / SQS | 07/02 §4 | common/telemetry; infrastructure/events (`traceparent`); apps/lambdas | S53, S55 | implemented |
| P0707 | Tail sampling, collector architecture | 07/02 §4–5 | collector config | ops | implemented |
| P0708 | Dashboards | 07/02 §6 | dashboards | ops | implemented |

## 08 · DevOps & cloud

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0801 | Liveness vs readiness vs startup semantics | 08/01 §1–4 | infrastructure/health | S54 | implemented |
| P0802 | Deployment strategies (rolling, blue/green, canary, flags) | 08/01 §5 | CodeDeploy; experimentation (flags) | ops, S38 | implemented |
| P0803 | Autoscaling (target tracking, queue depth, lag) | 08/03 | Terraform | ops | implemented |
| P0804 | Config and secrets | 08/02, 05/02 §9 | common/config; Terraform | S54, ops | implemented |
| P0805 | Production Dockerfile (multi-stage, non-root, `tini`) | 08/02 | infra/docker | ops | implemented |
| P0806 | CI pipeline, caching, affected builds | 08/02 | .github/workflows | ops | implemented |
| P0807 | GitOps (ArgoCD) | 08/02 | replaced by Git-driven Actions + CodeDeploy (D10) | — | skipped (D10) |
| P0808 | Terraform modules, state, environments | 08/02 | infra/ | ops | implemented |
| P0809 | AWS service choices (Lambda, SQS, RDS Proxy, DynamoDB, Keyspaces, VPC endpoints, IAM, cost) | 08/03 | Terraform; apps/lambdas | ops, S55 | implemented |
| P0810 | Testing strategy: unit / integration with real DBs / contract / e2e / load / chaos | 08/04 | packages/backend/test; constitution VII | all | implemented |
| P0811 | A/B testing correctness: deterministic hash assignment, SRM chi-square, exposure events, event-ID dedupe | 08/04 §8, 10/02 Ex2 | experimentation (analytics, flags share the assignment hash) | S39, S38 | implemented |

## 09 · Frontend (React / Next.js)

| ID | Pattern | Notes | Where | Specs | Status |
|---|---|---|---|---|---|
| P0901 | Server vs client state; Context vs reducer vs store; URL state | 09/01 | packages/web | W02, W03, W04, W06 | implemented |
| P0902 | Rendering and performance (keys, memoisation, virtualisation) | 09/02 | packages/web | W02, W07 | implemented |
| P0903 | Next.js App Router: RSC, Server Actions, caching layers, authorization not only in middleware | 09/03 | packages/web | W01, W07 | implemented |
| P0904 | ISR revalidation and cache tags (backend half) | 09/03, 10/04 #5 | content | S27 | implemented |
| P0905 | Offline-first PWA (backend half) | 10/04 #6 | catalog-sync (offline sync) | S09 | implemented |

## 11 · Algorithms (only where a feature needs them, D6)

| ID | Algorithm | Where | Specs | Status |
|---|---|---|---|---|
| P1101 | Trie with per-node top-K | discovery (autocomplete) | S33 | implemented |
| P1102 | Count-Min Sketch + min-heap top-K | discovery (trending) | S35 | implemented |
| P1103 | Bloom filter | seller-insights (crawler seen-set); infrastructure/cache (penetration) | S41, S52 | implemented |
| P1104 | SimHash change detection | seller-insights (crawler) | S41 | implemented |
| P1105 | Consistent hashing with virtual nodes | catalog (collab room routing); fulfilment (city ownership) | S06, S20 | implemented |
| P1106 | Reservoir sampling | launch-events (live comments) | S23 | implemented |
| P1107 | Topological sort (DAG scheduling) | media (transcoding) | S30 | implemented |
| P1108 | Hot / Wilson score ranking | community (discussions) | S25 | implemented |
| P1109 | Base62 + Feistel bijection | marketing (share links) | S37 | implemented |
| P1110 | Largest-remainder allocation | common/money; orders; billing | S10, S17 | implemented |
| P1111 | BFS with decay (2-hop) | discovery (recommendations) | S34 | implemented |
| P1112 | k-way merge by ID | community (celebrity feed merge) | S26 | implemented |
| P1113 | Content-defined chunking (FastCDC) | asset-library | S31 | implemented |
| P1114 | Reciprocal rank fusion | assistant (RAG) | S47 | implemented |
| P1115 | Dynamic programming | none | — | skipped (D6) |

## Coverage check

Every capability in `capabilities.tsv` should own at least one pattern row, and every non-`ops`,
non-`skipped` row should name at least one capability. To list the capabilities a pattern ID maps to:

```bash
grep -E '^\| P[0-9]+ ' docs/architecture/pattern-map.md | awk -F'|' '{print $2, $(NF-2)}'
```
