# Implementation Plan: S08 — Shopify/WooCommerce Catalog and Stock Sync (domain `catalog-sync`)

**Branch**: `S08-integrations` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `.specify/memory/constitution.md`.

## Summary

Rebuild `libs/domains/catalog-sync` integrations (today: 248-line `IntegrationSyncService` with raw `Product` SQL, a fake provider in production wiring, one Shopify adapter) into the design of the spec: OAuth/API-key connect with sealed, context-bound credentials; an SSRF-safe, rate-limited, breaker-guarded provider port with Shopify and WooCommerce adapters; a lease-fenced incremental/backfill engine with checkpoints, budgets and continuations; webhooks as a verified fast path; an anti-corruption layer (decimal money, normalisation, quarantine); catalog writes only through S05's `upsertFromExternal` / `applyStockDelta`; a three-way stock merge on `syncedStock` with a conflict queue; nightly immutable reconciliation; management routes; tenancy lifecycle consumers; retention; events on `catalog-sync.events`.

Approach: pure domain core first (merge, money, normalisation, status machine, watermark, retry, breaker, classification), ports in `domain/`, adapters in `infra/`, thin use-case services in `application/`, then HTTP, consumers and jobs. Every item of `gaps.md` (A1–A45, B: D-6/D-7/D-8/D-12, C ownership lines, D work list) is mapped in [research.md](research.md#gap-coverage) and has a task home.

Follow-ups left for this capability by built specs — each is a requirement here:

| From | Follow-up | Where handled |
|---|---|---|
| S01 | `SecretBox.seal/open` `context` for new columns | credentials sealed with `integration:<id>` (FR-007, AS-79); data step re-seals old rows (A17/A45) |
| S05 | write only via `upsertFromExternal` / `applyStockDelta`; no `catalog.product_changed`, no `INSERT/UPDATE "Product"`; `priceMinor` rename; `quantity` ≥ 0 | engine catalog gateway; items carry `priceMinor`; negative merges clamp to 0 + conflict; AS-80 trigger test |
| S49 | `declareJobType` with payload contract next to `JobPayloads`; adapt to discriminated `JobsService.cancel`; catch `InvalidScheduleError` | three jobs declared in `infra/integrations.jobs.ts`; schedule registration catches `InvalidScheduleError`; `cancel` is not called (documented) |
| S49 | `removeSchedule` for renamed schedules | startup step removes `integrations.sync-all` and `integrations.reconcile-all` after registering the `catalog-sync.*` ones |
| S50 | `penalize(policy, subject, ms)`; other workers' `check` returns `reason: 'paused'` | resilience layer calls `penalize` on 429; `paused` treated as "yield with retryAfterMs", not an error |

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22, NestJS 11 monorepo (`packages/backend`, `packages/contracts`, `packages/web` for the W04 journey only).

**Primary Dependencies**: NestJS, Sequelize (raw SQL against own tables), `zod` (contracts + adapter validation), `fast-check` (property tests), existing infra: `TransactionRunner`/`@Transactional`, outbox (`outbox.append`), task queue (`delaySeconds` exists), idempotent consumer framework, `RateLimiterService` (`check`, `penalize`), `JobsService`/`declareJobType`, `SecretBox`, `@app/infrastructure/net` (`safeRequest`, `checkSafeUrl`, SSRF guard) and `http-client` (resilient client, retry budget), metrics registry, injected clock.

**Storage**: PostgreSQL (own tables only: `Integration`, `ExternalLink`, `SyncCursor`, `SyncQuarantine` + new `IntegrationHistory`, `IntegrationInstall`, `SyncRun`, `StockConflict`, `WebhookReceipt`, `ReconciliationRun`); Redis (rate buckets via S50); Kafka topic `catalog-sync.events` (out), `products.events` and `tenancy.*` (in); SQS queues `integration-sync`, `integration-backfill` (+ DLQs; defined in `elasticmq.conf` and terraform already — verified in T-checks, L-002/L-020).

**Testing**: Jest e2e (real modules, real Postgres/Redis/Kafka/SQS stand-ins, run via `scripts/sdd/test-spec.sh`), unit `it.each` + `fast-check` for pure logic, fake Shopify/WooCommerce **HTTP servers**, stub DNS resolver, frozen clock; Playwright journey owned by W04. Layout and scenario mapping: [test-plan.md](test-plan.md).

**Target Platform**: Linux containers: `apps/core` (HTTP + webhook + OAuth callback), a worker app (queue consumers, jobs), `apps/projector` (events consumers); `apps/local-monolith` hosts all.

**Project Type**: backend domain module (web-service + workers).

**Performance Goals**: SC-001 (50k variants in 15 min), SC-002/003 (≤30 s p99 propagation), SC-006 (provider never exceeds bucket).

**Constraints**: no network call inside a DB transaction (FR-091); catalog calls outside transactions; run ends before its message visibility (300 s / 900 s); every provider call through one shared bucket per credential, fail closed; webhook route fails open on limiter outage.

**Scale/Scope**: 5 integrations/shop, 100k-variant stores, 80 acceptance scenarios, 13 FR groups.

No `NEEDS CLARIFICATION` remain; unknowns resolved in [research.md](research.md).

## Constitution Check

*GATE: passes before Phase 0 and after Phase 1 design.* Read from `.specify/memory/constitution.md` principles I–X and PR gates.

| Principle | Status | How |
|---|---|---|
| I Layered modules (D-6) | PASS | New code: `domain/` pure + ports with DI tokens, `infra/` adapters, `application/` use cases, `api/` controllers; `application/` no longer imports `infra/` |
| II Pipeline/routing | PASS | Prod pipe/filter; webhook and callback use `Firewall({anonymous, skipThrottle})`; raw body via S54 capture; deterministic route order (static `/integrations/shopify/callback` vs param routes) |
| III Data access & transactions | PASS | `TransactionRunner.run` / `@Transactional` only; no new `sequelize.transaction`; status change = conditional UPDATE + history + outbox in one tx; catalog call outside tx with deterministic `externalSku`/`operationId` recovery (A26) |
| IV Module communication | PASS | Catalog via R1 services, tenancy via `ShopQueryService`, product events consumed with event copy (IX.8); own events through outbox |
| V API contracts | PASS | zod schemas in `packages/contracts` first; problem+json codes of FR-073; keyset cursors (opaque, HMAC-tamper-evident); no Idempotency-Key (documented) |
| VI Frontend | N/A | W04 owns screens; only the journey test |
| VII Testing | PASS | e2e per feature file, unit only for pure logic, fakes at system edge only; Gate 9 faults forced (AS-31/43/55/56/58/59/63) |
| VIII Operational safety | PASS | Config validated at startup; metrics FR-102; graceful shutdown stops runs at next checkpoint; no secret in logs (AS-78) |
| IX DB isolation | PASS | Drop `Integration.shopId → Shop` FK (expand/contract, `lock_timeout`); register 6 new tables in `db/ownership.ts`; `check:table-ownership --strict` clean (AS-80) |
| X Monorepo/boundaries | PASS | Barrel exports exactly `IntegrationsModule`, `IntegrationsWorkerModule`, `IntegrationsProjectorModule` (D-8); `apps/projector` imports the module |

**Debt register**: D-12, D-7, D-6, D-8 are closed for this domain's integration files; D-10 (order export, S12) untouched. **Complexity Tracking**: none — no unjustified violation. Transaction audit: the integration files contain no direct `sequelize.transaction` (verified; they already use `TransactionRunner`), no `// S54 T037 audit` comment to migrate; the count in this domain must not rise (task T-final gate).

**Known failure classes (checked before design)**: L-018/L-015/L-004 → tasks T90–T92 boot `core`, worker, projector **standalone** and the monolith; L-001 → queue options (`delaySeconds` only; `groupId` never) validated in `SyncQueue` port at message creation; L-010 → install/connect are idempotent (409/200 on repeat); L-002/L-020 → both queues + DLQs verified in `elasticmq.conf`, queue reload command; L-011 → new tables in migration + doctor compare; L-003 → no "A or B" assertions, limiter-down/ environment limits reported as blocked; L-005/L-006 → tests create own shop/integration/product; L-007 → runner timeouts; L-008 → e2e run in batches per file; L-013 → fault triggers dropped in `afterEach`; L-017 → scenario ↔ test mapping kept in test-plan on any rename; L-019 → boot/empty-stack runs done by the final checkpoint with scripts.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S08-integrations/
├── plan.md              # this file
├── research.md          # decisions, gap coverage, risks
├── data-model.md        # tables, states, migrations
├── quickstart.md        # validation scenarios + Ops artifacts
├── contracts/
│   ├── http-api.md      # routes, schemas, error codes
│   ├── events-and-messages.md  # outbox events, queue messages, consumed events, jobs, policies
│   └── ports.md         # domain ports and R1 calls
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
docs/spec/capabilities/S08-integrations.md      # living-spec page: written FIRST (rule 0); no .reviewed.json touched

packages/contracts/src/catalog-sync/            # integration*.ts zod schemas, problem codes, integrationEventSchemas
packages/backend/libs/infrastructure/rate-limit/ # + policies: integrations.woocommerce, catalog-sync.* (see events-and-messages.md)
packages/backend/libs/domains/catalog-sync/
├── domain/                  # pure: money, normalise(-shopify/-woo), stock-merge, integration-status,
│                            #   watermark, retry-policy, breaker, reconcile-classify, webhook-verify,
│                            #   store-address; ports/ (repositories, ProviderGateway, Clock, SyncQueue,
│                            #   CatalogGateway, ShopStatusGateway); *.spec.ts beside code
├── application/             # connect.service, oauth.service, sync-engine (lease, run, pages),
│                            #   link-apply.service, stock-sync.service, quarantine.service,
│                            #   webhook.service, reconcile.service, integration-admin.service,
│                            #   lifecycle.service, retention.service
├── infra/                   # repositories (raw SQL on own tables), shopify.adapter, woocommerce.adapter,
│                            #   provider-http (shared bucket + penalize + breaker + safeRequest),
│                            #   queue consumers, product-events.consumer, tenancy-events.consumer,
│                            #   integrations.jobs (declareJobType + schedules), metrics
├── api/                     # integrations.controller, integration-oauth.controller,
│                            #   integration-webhook.controller, quarantine/conflict/reconcile controllers
├── integrations.module.ts   # IntegrationsModule / IntegrationsWorkerModule / IntegrationsProjectorModule
├── index.ts                 # barrel: the three modules only
├── migrations: packages/backend/migrations/2026101x*-catalog-sync-integrations-*.js (expand, data, contract)
├── test/fakes/fake-shopify.ts, fake-woocommerce.ts, stub-resolver.ts
└── integration-{connect,sync,webhooks,stock,quarantine,resilience,reconcile,manage,lifecycle,boundary}.e2e-spec.ts
packages/backend/db/ownership.ts                # + 6 tables as domain:catalog-sync
packages/backend/apps/projector/src/projector.module.ts  # import IntegrationsProjectorModule (not StockPushProjector)
packages/web/tests/seller-integrations.spec.ts  # W04 happy path (blocked until W04 page exists → UNVERIFIED if so)
```

Deleted: `infra/fake.provider.ts`, `fake` branches, `integrations.e2e-spec.ts` (its 5 scenarios map to AS-47/16/36/26/62 per test-plan).

**Structure Decision**: single backend domain with hexagonal layers inside `libs/domains/catalog-sync`; contracts in the shared package; no new app.

## Phases and ordering (input to `/speckit-tasks`)

0. **Living spec + contracts** — write `docs/spec/capabilities/S08-integrations.md` rules first; zod contracts; rate-limit policies; run `python3 scripts/livespec/check.py`.
1. **Migrations** — expand (new columns/tables, drop Shop FK, partial unique, reconciliation immutability trigger, ownership registry), data (rename link ids, re-seal credentials, `ERROR→NEEDS_REAUTH`), contract (narrow checks). Doctor: all tables exist in the test stack (L-011).
2. **Pure domain + unit specs** (A5,A6,A10–A12,A18,A33,A36).
3. **Adapters + fakes** (Shopify, WooCommerce, safe HTTP, resilience layer; remove `fake`).
4. **Connect/OAuth/management API** (A14,A15,A35) → e2e C, M.
5. **Sync engine** (lease/fence, runs, checkpoints, budgets, scheduler, queue validation; A23–A29) → Y.
6. **Catalog gateway + link apply** (A1–A4, A26, A31) → Y, Q.
7. **Stock** (merge, push, product-events consumer, conflicts; A4–A9) → K.
8. **Quarantine** (A30) → Q. **Webhooks** (A20–A22) → W. **Resilience** (A32,A33) → R.
9. **Reconciliation + lag** (A36,A37) → N.
10. **Lifecycle, retention, events, metrics, barrel/apps wiring, schedule renames** (A34,A38,A39,A42) → L, B.
11. **Final checkpoint**: whole capability suite in per-file batches; `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`; boot `core`, worker, projector standalone and monolith (L-015/L-018); empty-stack run (`scripts/qa/fresh-run.sh`, L-012); livespec check; update `specs/UNVERIFIED.md` rows.

## Complexity Tracking

No violations to justify.
