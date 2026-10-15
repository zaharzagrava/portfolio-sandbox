# Research: S08 — Catalog Sync Integrations

All spec unknowns are resolved by `questions.md` defaults (accepted as written). This file records the technical decisions that the plan relies on, checked against the repository on 2026-10-15.

## Repository facts verified

- `TransactionRunner.run` (CLS-propagated, `join` default) exists; integration files already use it and contain no direct `sequelize.transaction` and no `// S54 T037 audit` comment.
- `SecretBox.seal(plaintext, context?)` / `open(sealed, context?)` exist (`identity/infra/crypto/secret-box.ts`).
- `RateLimiterService.penalize(policy, subject, ms)` exists (token buckets only, capped by config); `check` can answer `reason: 'paused'`.
- `declareJobType` (runtime contract + `JobPayloads` augmentation) and `JobsService.removeSchedule(name)` exist. The current code already declares `integrations.sync-all` / `integrations.reconcile-all` in `infra/integrations.workers.ts`.
- Task queue accepts `delaySeconds` (`sqs/sqs-task-queue.ts`); FIFO-only `groupId`/`dedupeId` are validated in `sqs/enqueue-options.ts` (L-001: never pass them to the standard sync queues).
- `@app/infrastructure/net` provides `safeRequest/safeGet` (pinned-address requests), `checkSafeUrl`, an SSRF guard with specs — reused for every outbound call (store URL, redirects, `Link` targets, webhook registration). Its redirect default must be "refuse"; gaps in it (port 443 only, IP literals, user-info) are covered by `store-address` rules in this domain and by test AS-07.
- `rawBody: true` is set in `apps/core` and `apps/local-monolith` `main.ts`; the webhook controller reads `req.rawBody` only (no `JSON.stringify` fallback, A20). The worker/projector apps do not serve HTTP.
- `integrations.manage` exists in tenancy permissions (`OWNER`, `ADMIN`); `PLATFORM_CURRENCY` exists in `api-config.service.ts`.
- `ProductImportService`, `ProductStockService`, `ProductQueryService` (catalog) and `ShopQueryService` (tenancy) exist.
- `docs/spec/capabilities` has no S08 page yet → created first (cross-spec rule 0). No `*.reviewed.json` is created or edited.

## Decisions

1. **Layering**: pure `domain/` (no I/O, no clock) + ports with DI tokens → adapters in `infra/`. *Why*: D-6, testability (unit specs only for pure logic). *Rejected*: keeping `IntegrationSyncService` as a god-service.
2. **Catalog writes**: `upsertFromExternal` in batches ≤ 500 outside any transaction; link written in the domain's own transaction afterwards. Recovery by deterministic `externalSku` (`<provider>:<integrationId>:<externalId>`) so the retry finds the product `unchanged`/`updated`; stock by deterministic `operationId` (`sync:<I>:<digest(externalId, base, remote, remoteUpdatedAt)>`, suffix `:n` when |delta| > 1,000,000). *Why*: FR-017/FR-091, A26. `quantity` is passed only for items with no link ([CONTRACT] S05).
3. **Stock merge**: one pure function `merge(B, L, R)` → `{action, localDelta, pushValue, result, conflict?}`; clamp `[0, 1e9]`; negative or clamped result → conflict + both sides set to the clamped value. Inbound = delta; outbound = conditional absolute set (Shopify `inventory_levels/set` with `changeFromQuantity`; WooCommerce read-then-write with a re-read compare). *Why*: AS-35–AS-45.
4. **Outbound trigger**: consumer of `products.events` via S53 framework (inbox record, schema validation, coalescing per productId within a batch, DLQ). Quantity from event copy; `lastLocalVersion` on the link is the version guard; `shopId` in the link predicate. No product-table read.
5. **Single runner**: lease row on `SyncCursor` (`holder`, `expiresAt`, `fence`), TTL 5 min, renewed every 60 s; every checkpoint/watermark write is `UPDATE … WHERE fence = :fence` (fencing) and the watermark update is `GREATEST`-guarded. Advisory locks rejected (no fence).
6. **Budgets**: 40 pages or 4 min (incremental) / 12 min (backfill); on exhaustion store checkpoint, enqueue exactly one continuation (`delaySeconds` for `Retry-After` > 60 s, capped 15 min), outcome `yielded`. Budgets configuration-driven so tests set 3 pages.
7. **Provider call stack** (one `ProviderHttp` per credential): limiter `check` (fail closed → `yielded rate_limiter_unavailable`; `paused`/`retryAfterMs` → short inline wait only if ≤ budget else yield) → breaker gate → `safeRequest` with 15 s timeout → classify → retry (≤ 3, full-jitter 500 ms…8 s, idempotent ops only) → on 429 `penalize` → on 401 single-flight refresh (Redis lock keyed by integration + re-read of stored token) → else `NEEDS_REAUTH`. Breaker state on the `Integration` row (survives Redis flush, visible in the API).
8. **Webhooks**: controller → `WebhookService.accept`: resolve integration (unknown/malformed/DISCONNECTED → same 401), verify signature on raw bytes (constant-time), timestamp rule, body ≤ 1 MiB, rate limits (fail open), `PAUSED/NEEDS_REAUTH` ack-only, then in one step `INSERT receipt ON CONFLICT DO NOTHING` + enqueue; enqueue failure → delete the receipt created by this request and answer 503 (receipt and enqueue are not atomic across stores; the receipt is removed on failure, and a lost delete only turns a retry into a duplicate-ack, healed by the scheduled pull — documented in AS-31 test).
9. **Quarantine**: unique `(integrationId, entity, dedupeKey)` where dedupeKey = externalId or payload digest; `INSERT … ON CONFLICT DO UPDATE occurrences+1, lastSeenAt` (no duplicate rows under concurrency); auto-resolve on successful apply; per-run counter halts at 1,000 (`halted_schema_drift`).
10. **Reconciliation**: one `reconcile` message per integration on `integration-backfill`; chunked comparison (provider listing streamed to a temp comparison by digest, links read keyset-paged, local quantities via `getProductsByIds` ≤ 500 per call); mass-delete guard ≥ 10 links and > 20%; findings ≤ 1,000 stored, rest counted; finished rows immutable via DB trigger (`BEFORE UPDATE … WHEN OLD.finishedAt IS NOT NULL → RAISE`).
11. **Connect uniqueness**: partial unique index `(provider, externalShop) WHERE status <> 'DISCONNECTED'`; per-shop limit: inside the connect transaction take `pg_advisory_xact_lock(hashtext('integration-limit:' || shopId))`, then count the shop's non-`DISCONNECTED` rows and insert (own table only, serialises concurrent connects of one shop). Race tests AS-10/AS-11 prove it.
12. **OAuth state**: 128-bit random, only SHA-256 digest stored; consumed by `UPDATE … SET consumedAt WHERE consumedAt IS NULL AND expiresAt > now() RETURNING` (single use under `Promise.all`). Callback HMAC verified over the sorted query params with the app secret, constant-time; every failure → one identical `400 invalid_oauth_callback`.
13. **Cursors**: opaque base64url of `{createdAt,id}` + HMAC (key from config) → `400 invalid_cursor` on tamper.
14. **Schedule rename**: at worker start register `catalog-sync.*` schedules then `removeSchedule` the two old names (S49 follow-up); `InvalidScheduleError` caught and logged as startup failure (fail fast), not swallowed.
15. **Fake provider removal**: provider type narrowed to `shopify|woocommerce` in DTO, check constraint and wiring; tests use HTTP fakes pointed at by configuration (`SHOPIFY_API_BASE_OVERRIDE`-style test-only config on the *adapter factory in the test module*, never in production wiring — AS-80 asserts production module graph has no fake).

## Gap coverage

| Gaps item | Planned home |
|---|---|
| A1–A4, A31 (raw Product SQL, product event, stock zeroing, join) | Phase 6/7: `CatalogGateway` → R1 services; event-copy quantity; D-12 closed |
| A5–A9, A44-stock | Phase 7: `stock-merge`, `stock-sync.service`, product-events consumer, conflicts |
| A10–A12, A19 | Phase 2/3: `money`, `normalise-*`, envelope validation in adapters |
| A13, A22 | Phase 3: WooCommerce adapter + signature |
| A14–A16, A35 | Phase 4: OAuth, Woo connect, management routes, `integrations.manage`, `fake` removed |
| A17, A45 | Phase 1 data step + `CredentialVault` with context |
| A18, A20, A21 | Phase 3/8: safe HTTP, `Link` host check, raw body, webhook service |
| A23–A25, A27–A29 | Phase 5: lease/fence, watermark clamp, apply lock (`SELECT … FOR UPDATE` on link or advisory per `(I, externalId)`), run budget, message validation |
| A26 | Phase 6: split transaction + deterministic recovery |
| A30 | Phase 8: quarantine dedupe + routes |
| A32–A34 | Phase 3/8: resilience stack, breaker, refresh, config validation |
| A36–A37 | Phase 9 |
| A38–A39, A42 | Phase 10 |
| A40 | Phase 0: `packages/contracts` |
| A41, A43 | Phase 2 ports; Phase 1 migration (FK drop, old hash columns replaced) |
| A44 | Phase 4–10 e2e files (10) + test-plan; old spec removed |
| B: D-6, D-7, D-8, D-12 | Phases 2, 10 (e2e uses tenancy fixture helper, no `ShopModel`) |
| C: all ownership lines | each line closed by the IX.7 mechanism named in gaps.md C; `check:table-ownership --strict` is the gate |
| D: steps 1–13 | Phases 0–11 above |

## Risks

- Real queue visibility (300 s) vs. run budget: budgets are set below visibility; lease expiry (5 min) equals incremental visibility → renewals every 60 s mandatory.
- `upsertFromExternal` semantics for `quantity` on existing products is a [CONTRACT] assumption; a contract test in Y (AS-13) fails loudly if S05 changes it.
- The W04 page may not exist when the journey test is due → journey recorded in `specs/UNVERIFIED.md`.
- Unit-of-work gap between receipt insert and enqueue (decision 8) is accepted and documented.
