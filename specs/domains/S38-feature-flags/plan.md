# Implementation Plan: S38 — Feature flags and remote config (domain `experimentation`)

**Branch**: `S38-feature-flags` (working branch `sdd/auto`) | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-58, FR-001–FR-064, SC-001–SC-010), `test-plan.md`, `gaps.md` (G1–G24, B1–B8, debt D-6/D-8/D-15, ownership output, migration notes), `questions.md` (defaults accepted as written; no line was edited by a human), the constitution (3.1.0), and the follow-ups left by S30, S48 and S51 (below).

## Summary

Rebuild the flags half of `experimentation` so that a kill is a state nobody can undo by saving, two admins never overwrite each other, every SDK converges on the database truth even when the cache loses a message or is flushed, and a browser sees only its own pre-evaluated answers:

1. **Write path** (`apps/core`): thin `FlagsAdminController` → `FlagCommandService` (`save | kill | restore | archive`). One transaction through `TransactionRunner.run` (S54): lock the single `FlagRuleset` row (global lock order: ruleset row, then flag row, so no deadlocks), read the flag `FOR UPDATE`, decide with the pure `domain/flag-lifecycle.ts` (state machine, `assertNever`) and `domain/flag-validation.ts` (all semantic errors at once). A decision of "nothing changes" returns before the version is bumped (FR-014). An applied change does, in the same transaction: conditional update of the flag (`WHERE key = :k AND version = :v`, one row asserted), ruleset version `+1` and returned, one `FlagAudit` row, one outbox row `experimentation.flag_changed`. Creates count non-archived flags under the ruleset lock, so the 500-flag cap cannot be exceeded by concurrent creates (III.6).
2. **Publish** (after commit, never inside the transaction): `RulesetPublisher` port; the Redis adapter builds the snapshot from the database, writes it with a 1 h TTL only if newer (Lua), and pushes the version over the `flags` realtime channel, all under a 500 ms timeout; failure is counted (`flags_publish_failures_total`) and never fails the write. A **repair job** (single run per schedule across replicas) republishes when the cache has no snapshot or an older one.
3. **SDK** (`FlagsClient`, every app): `RulesetSource` port (cache 500 ms → database 2 s), snapshot zod schema, strictly-newer rule, counted ignores/rejects, push + 30 s ± 5 s jitter polling, `ready`, cold start with both stores down never blocks boot (retry every 5 s), evaluation counters kept on a failed flush and flushed at shutdown.
4. **Evaluation**: `domain/evaluator.ts` stays pure (no clock, no I/O), gains `killed`, `ruleset_unavailable`, `flagVersion`, the asked key on unknown flags, and one exported `bucketOf` in `domain/bucket.ts` (the P0811 hash S39 reuses).
5. **Client endpoint and gate**: `ClientFlagsService.forContext(ctx)` (one application call), context built only from the authenticated principal and the verified shop, anonymous id 8–64 `[A-Za-z0-9_-]`, platform enum, country only with the edge credential, `Cache-Control: private, no-store`, `Vary`, 120/min. `RequireFlag` answers the platform's undefined-route 404 problem body.
6. **Contracts and operations**: seven schemas in `packages/contracts/src/experimentation/flags.ts`; the BFF's loose `flagsResponseSchema` is replaced by `clientFlagsSchema` under the same exported name; rate-limit policies `flags.admin.write` and `flags.client.read`; metrics `flags_*`; one structured admin-write log line; new migration (expand only); barrel exports the SDK, gate and types, no infrastructure class.

Why Postgres stays the system of record and Redis stays a derived cache: the ruleset is a few hundred rows, written 30 times a minute at most; the strongly consistent invariants (version, count, kill) need one store (III.6), and the cache only accelerates convergence (III.9). Why the flag, ruleset-version, audit and outbox rows share one transaction: IX.6 allows exactly this technical-table exception.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, Sequelize 6 (raw SQL moves to the repository), Postgres 16, Redis
**Primary Dependencies**: `TransactionRunner` (`@app/infrastructure/context`), `OutboxService.append` (`@app/infrastructure/outbox`), `defineEvent` (`@app/infrastructure/events`), `RedisService` + `CacheService`, `RealtimePublisher`, `TopicRegistry`, `RealtimeSubscriptions`/`TopicSubscriber` (`@app/infrastructure/realtime`), `definePolicies` + `@RateLimit` (`@app/infrastructure/rate-limit`), `Clock` (`@app/common/core/clock`), jobs/advisory lock for the repair run (`@app/infrastructure/jobs`), metrics registry (`@app/common/telemetry`), identity `Firewall`/`User`/`Role`
**Storage**: PostgreSQL `FeatureFlag`, `FlagAudit`, new `FlagRuleset` (owner `domain:experimentation`); Redis `flags:ruleset` (snapshot, TTL 1 h), `flags:evals:<day>` (hash, TTL 40 d); no new store
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (six `flags-*.e2e-spec.ts` files, replacing `flags.e2e-spec.ts`), unit `domain/evaluator.spec.ts`, `domain/flag-validation.spec.ts`, `domain/bucket.spec.ts` (vectors move here from the evaluator spec), one W06 Playwright journey (not owned here)
**Target Platform**: Linux; `apps/core` (HTTP + SDK), `apps/worker` (SDK + repair), `apps/sse-gateway` (topic registry, SDK stays as today), every other app that already imports `FlagsSdkModule`
**Project Type**: backend domain module + contracts package (admin screens are W06)
**Performance Goals**: evaluator > 1,000,000 evals/s/core and client endpoint p99 < 50 ms at 500 flags: both ops artifacts (SC-001, SC-008)
**Constraints**: cache 500 ms (refresh, publish), database 2 s (refresh), publish never delays a write beyond 1.5 s total, admin body ≤ 256 KiB, ruleset ≤ 500 flags / 5 MiB, poll 30 s + ≤ 5 s jitter, cold-start retry 5 s, repair 30 s, snapshot TTL 1 h
**Scale/Scope**: 500 flags, 20 variants, 50 rules, 30 admin writes/min, 120 client reads/min/principal

**Connection arithmetic (III.12)**: S38 opens no new pool. A write holds one connection for one short transaction (two row locks, four inserts/updates, no network I/O); at the 30/min/admin cap and the serialised ruleset lock at most one write transaction progresses per instance at a time, so the capability adds at most 1 connection per concurrent write on top of the shared pool. The SDK reads the database once per refresh (≤ 1 query, 2 s timeout) and only when the cache failed or is behind; the repair job holds one connection for its advisory-locked run. The pool-size × instances budget is unchanged from the platform's (`DB_POOL_MAX`, documented in the S54 plan).

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.4) | PASS after work (D-6, B1, B2, B3, B6, B8) | ports + tokens in `domain/` (`FLAG_REPOSITORY`, `RULESET_PUBLISHER`, `RULESET_SOURCE`, `EVAL_COUNTER_STORE`); adapters in `infra/` (Sequelize models `FeatureFlagModel`, `FlagAuditModel`, `FlagRulesetModel`, Redis publisher/source/counters); `application/` and `api/` import no `infra/`; `FlagsClient` moves to `application/` (it is orchestration over ports); `domain/` reads no clock (`now` parameter) and imports no Nest/ORM/Redis |
| 2 Pipeline (II) | PASS after work (G18, B8) | controllers make one call; shape validation by zod schemas from `contracts` through the global pipe; domain errors with `code`/`status` rendered by the global problem+json filter (no `HttpException` thrown from `application/`); `Firewall({roles:[ADMIN]})` on admin routes, `Firewall({anonymous:true})` on `GET /flags`; rate limits through `@RateLimit` |
| 3 Data access (III) | PASS after work (B2, B5) | only `infra/` repositories run SQL (parameterised, fixed column lists); transactions by `TransactionRunner.run` (no new direct `sequelize.transaction`; the two `// S54 T037 audit` sites in `flags-admin.service.ts` are migrated and their comments deleted, `.tx.baseline` falls from 2 to 0); no network I/O inside the transaction (publish is after commit); count cap, version and transitions by locked row + conditional update asserting one row; keyset cursors for list and history; snapshot and counter keys have TTLs, no `KEYS` |
| 4 Messaging (IV) | PASS after work | `experimentation.flag_changed` v1 via `defineEvent` + outbox in the transaction; no consumer exists (nothing to make idempotent); realtime channel carries only the version (IV.3); every Redis/DB call in the SDK, publisher and repair has an explicit timeout; no retry layer except the 5 s cold-start loop |
| 5 Contracts (V) | PASS after work | `flagSchema`, `flagInputSchema`, `flagPageSchema`, `flagAuditPageSchema`, `clientFlagsSchema`, `staleFlagsSchema`, `flagRulesetSnapshotSchema`, `flagChangedEventSchema` in `packages/contracts`; explicit response mappers (no `SELECT *` to the wire); problem+json with stable `type` codes; `GET`s change no state (the client endpoint only counts evaluations in memory); breaking shapes listed in `contracts/flags-api.md`. V.6 does not apply (no order/payment/booking POST); replay safety is by definition equality |
| 6 Frontend (VI) | N/A here | W06 owns the screens; `packages/web/lib/api/admin.ts` payload helpers are touched only to follow the new request shape (G24) |
| 7 Tests (VII) | PASS after work | all 58 scenarios mapped in `test-plan.md`; every fallback forced (VII.9); `Promise.all` for AS-06/07/12/26/31/33; real Postgres/Redis, only the token verifier, time and the edge credential are faked; contract schemas parse every body |
| 8 Operations (VIII) | PASS after work | `flags_*` metrics; one admin log line without bodies; SDK never fails liveness/readiness; shutdown flushes counters before closing connections (order kept); repair job single-run via advisory lock and idempotent; config for the edge credential validated at startup |
| 9 DB isolation (IX) | PASS after work (B3) | `FlagRuleset` registered under `domain:experimentation` in `db/ownership.ts` in the same change; no join with `users`; outbox reached only through `OutboxService.append`; `check:table-ownership --strict` prints no `experimentation` line |
| 10 Monorepo (X) | PASS after work (D-8, G22, G23) | barrel exports the two modules, `FlagTopicsModule`, `FlagsClient`, `RequireFlag`, `EvalContext`, `FlagValue`, `Evaluation`, `bucketOf`, `flagChangedEventSchema`; no repository/model/query helper; S38 adds no domain edge (imports `identity` only, D-15 unchanged) |

Re-check after design (Phase 1): unchanged, every row still PASS after work. No Complexity Tracking entry is needed.

## Follow-ups from built sibling specs (treated as requirements)

1. **S30/S48 → S38** (loose BFF schemas): `flagsResponseSchema` in `packages/contracts/src/bff/upstream.ts` is replaced by an alias of our `clientFlagsSchema` under the same exported name (and `FlagsResponse` type); the BFF page specs still pass. Task: contracts + one BFF contract check.
2. **S48 → S38** (`Vary`): `GET /api/flags` stays anonymous-capable and answers `Vary: Authorization, X-Anonymous-Id` (FR-040, AS-37, test in CLI).
3. **S51 → S38** (`TopicRegistry.define`, one rule per route): `FlagTopics` already registers the singleton `flags` through `define`; the plan keeps exactly one definition (policy `SERVICE` only), keeps the `RealtimeTopicPrefixes` augmentation, and adds a CLI/SDK assertion that a viewer without the `SERVICE` role is refused and the duplicate definition throws `DuplicateTopicRouteError` (no second registration anywhere, e.g. `sse-gateway.module.ts:101` imports the module once).
4. **S54 toolkit**: migrate both direct `sequelize.transaction` sites (`flags-admin.service.ts` `upsert` and `kill`) to `TransactionRunner.run`, delete their `// S54 T037 audit` comments, add none.
5. **Living specification** (rule 0): `docs/spec/capabilities/` has no S38 page. The first implementation task creates `docs/spec/capabilities/S38-feature-flags.md` (rules + behaviors with `[proof: S38 AS-nn]` / `[code: …]` anchors, modelled on S37's page) *before* code changes land and keeps it true; `python3 scripts/livespec/check.py` must pass. No `*.reviewed.json` is created or edited; nothing signed by a human changes (`gaps.md` "Spec changes" says so).
6. **Unverified criteria** (rule 2): SC-001 and SC-008 (benchmark / p99 at 500 flags) are ops artifacts in `quickstart.md` and rows in `specs/UNVERIFIED.md` (added at plan time, status "not run"). SC-002…SC-007, SC-009, SC-010 are proven by named scenarios.
7. **Sibling-spec follow-ups** are listed in `gaps.md` (W06, S39, S03/BFF, S25).
8. **Known failure classes**: L-015/L-004 (boot `apps/core`, `apps/worker`, `apps/sse-gateway` for real after the module changes; if the sandbox denies it, record `blocked` as S36 and S47 did, never claim it verified), L-001 (the realtime/outbox options are validated where the message is created: `flag_changed` is a standard-topic event, no `groupId`), L-002/L-011 (no new queue; the migration creates `FlagRuleset` and the test stack applies real migrations), L-003 (no "A or B" assertions: AS-33 asserts the final status, plus which of the two allowed outcomes occurred, and the 20-run loop asserts both outcomes are counted separately), L-005/L-006 (every e2e creates its own flags and truncates in `beforeEach`), L-007 (frozen clock, no real sleeps in SDK tests), L-008 (the six files run as separate processes), L-013 (tests that break Redis or the audit write restore them in `afterEach`), L-016 (the repair path survives the failure it repairs: it catches cache errors and counts them), L-017 (the scenario table in `test-plan.md` is the contract; if a file is split or renamed, the scenario id stays in the `it` title).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S38-feature-flags/
├── plan.md              # this file
├── research.md          # decisions and the gap traceability table
├── data-model.md        # tables, snapshot, keys, state machine
├── contracts/
│   └── flags-api.md     # HTTP, schemas, event, SDK surface, breaking changes
├── quickstart.md        # runnable validation + ops artifacts
└── tasks.md             # (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/backend/libs/domains/experimentation/
├── api/
│   ├── flags-admin.controller.ts      # admin routes, one call each
│   ├── flags-client.controller.ts     # GET /flags
│   ├── flags.guard.ts                 # RequireFlag (404 like an undefined route)
│   ├── body-size.guard.ts             # 256 KiB → 413 on the admin PUT
│   ├── request-context.ts             # contextFromRequest (hardened) – pure helper
│   └── realtime-topics.ts             # FlagTopics (define, unchanged policy)
├── application/
│   ├── flag-command.service.ts        # save | kill | restore | archive
│   ├── flag-query.service.ts          # list, get, history, stale
│   ├── client-flags.service.ts        # forContext(ctx)
│   ├── flags-client.service.ts        # FlagsClient (SDK) over ports
│   ├── ruleset-publisher.service.ts   # after-commit publish with timeout + metrics
│   ├── ruleset-repair.service.ts      # republish when cache missing/older
│   └── flags-metrics.ts
├── domain/
│   ├── evaluator.ts / evaluator.spec.ts
│   ├── bucket.ts / bucket.spec.ts     # bucketOf + vectors
│   ├── flag-validation.ts / flag-validation.spec.ts
│   ├── flag-lifecycle.ts              # status transitions, no-op detection, definition equality
│   ├── flag-errors.ts                 # FlagError(code, status, extra) → global filter
│   ├── flag-cursor.ts                 # opaque keyset cursors
│   ├── flag-events.ts                 # flag_changed event definition
│   └── ports.ts                       # tokens + interfaces
├── infra/
│   ├── models/{feature-flag,flag-audit,flag-ruleset}.model.ts
│   ├── sequelize-flag.repository.ts
│   ├── redis-ruleset.publisher.ts / redis-ruleset.source.ts / redis-eval-counters.ts
│   └── (purchase-events.projector.ts — S39's, untouched)
├── flags.module.ts (FlagsSdkModule) · flags-admin.module.ts · flags-worker.module.ts (repair) · realtime-topics.module.ts
├── rate-limit-policies.ts             # flags.admin.write, flags.client.read
├── flags-admin.e2e-spec.ts · flags-lifecycle.e2e-spec.ts · flags-sdk.e2e-spec.ts
├── flags-client.e2e-spec.ts · flags-audit.e2e-spec.ts · flags-gate.e2e-spec.ts
└── index.ts

packages/backend/migrations/<next>-flags-lifecycle.js   # expand only
packages/backend/db/ownership.ts                        # + FlagRuleset
packages/contracts/src/experimentation/flags.ts         # + export, + bff/upstream.ts alias
packages/web/lib/api/admin.ts                           # expectedVersion, status (G24)
docs/spec/capabilities/S38-feature-flags.md
```

**Structure Decision**: keep the existing two Nest modules (`FlagsSdkModule` global, `FlagsAdminModule`) and add one small worker module for the repair job; split the one fat `flags-admin.service.ts` and `flags.controller.ts` by role, not by endpoint. `apps/core.module.ts`, `apps/worker.module.ts`, `apps/sse-gateway.module.ts` only change if the new module needs importing.

## Complexity Tracking

No constitution violation is introduced. The one judgement call, serialising every flag write on one `FlagRuleset` row, is intentional (30 writes/min cap; it is what makes the version strictly increasing and the count cap exact) and needs no exception.
