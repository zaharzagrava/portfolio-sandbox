# Implementation Plan: S23 — Live Launch Stream (domain `launch-events`)

**Branch**: `S23-live-stream` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md) (AS-01…AS-54, FR-001…FR-047), [test-plan.md](test-plan.md), [gaps.md](gaps.md) (G-01…G-27, debt D-6/D-7/D-8/D-12, table-ownership lines), [questions.md](questions.md) (defaults accepted as written), and the follow-ups left by S03, S49 and S51.

## Summary

Rebuild the live half of `launch-events` from a Redis-and-Kafka draft into a layered capability. The relational `LiveStream` record becomes the authority for status, pin and pin version, and a new `LiveMute` table the authority for mutes. Redis keeps only derived data (recent list, counters, state cache, active set). Lifecycle changes are one conditional update plus an outbox row in one `@Transactional`. Comments are made durable on the event stream before they become visible. The gateway (sampler, batcher, event connection) moves from `apps/sse-gateway/src/live/` into the domain as `LiveGatewayModule`. Pure logic (`reservoir`, `moderation`, `comment-text`, `live-state`, `window-composer`, `author-handle`, the client reducer) is unit-tested, and everything else is proven by six HTTP/SSE e2e files. The spec wins over the draft.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS (`packages/backend`, `packages/contracts`)
**Primary Dependencies**: Sequelize/Postgres, ioredis, DynamoDB (`DynamoService`), `KafkaProducerService` (high-volume `live.*`), S49 `JobsService`/`declareJobType`, S50 `definePolicies`, S51 `TopicRegistry`/`RealtimePublisher`/`TopicSubscriber`, S52 `CacheService` (single flight, negative cache), S53 `OutboxService` and the `Projector` framework, S54 `TransactionRunner`/`@Transactional`/problem filter/config validation/metrics, `Clock`, S01 (`Firewall`, `@User`), S03 (`ShopScoped`, `ShopAccessService`), S05 (`ProductQueryService`)
**Storage**: Postgres `LiveStream` (+`pin`, `pinVersion`), new `LiveMute`; DynamoDB `LiveComments` (upserts, no key change); Redis (recent list, reaction shards, viewer hash, state cache, active set, mute cache, ticker lease, `clientId` and removal markers)
**Testing**: jest e2e through HTTP/SSE (six files, run with `/opt/sdd/repo/scripts/sdd/test-spec.sh`), table-driven unit specs for pure `domain/`, `fast-check` for the window composer and the client reducer
**Target Platform**: Linux; core, worker, projector and sse-gateway must each boot standalone (L-015, L-018)
**Project Type**: backend domain library plus contracts package
**Performance Goals**: zero relational queries on the warm comment path (SC-012); one upstream subscription per stream per gateway instance; 50,000 viewers per instance (SC-014, ops artifact)
**Constraints**: no new `sequelize.transaction`; no network call inside a DB transaction; injected clock and random source in `application/`; no comment text, e-mail, token or `clientId` in logs, labels or error bodies
**Scale/Scope**: 5,000 comments/s and 200,000 reactions/s per stream, 2M viewers over many gateway instances

No NEEDS CLARIFICATION remain; see [research.md](research.md). The current code is ahead of `gaps.md` in places (S03/S51 follow-ups already landed: `ShopAccessService` in the controller, `TopicSubscriber` in the batcher, `livefeed` prefix declared). Task T001 re-runs `check:table-ownership` and re-reads each gap's cited lines before changing them, and ticks the gaps that are already true.

## Constitution Check

| Principle | Verdict | How |
|---|---|---|
| I/II Layering, thin controllers | Pass after work | Ports in `domain/` (`LiveStreamRepository`, `LiveMuteRepository`, `CommentHistoryReader`, `RecentCommentStore`, `StreamStateStore`, `ToxicityClassifier`), adapters in `infra/`, controllers make one call (G-01…G-13, D-6) |
| III Data access, transactions | Pass | Lifecycle, pin and mute writes are conditional updates; lifecycle plus outbox in one `@Transactional`; Redis never the source of truth; the draft has no `sequelize.transaction` and none is added |
| IV Communication | Pass | Lifecycle events via outbox; high-volume `live.*` on the plain producer (no relational transaction to be atomic with); classifier behind a port (IV.8) |
| V Contracts, errors | Pass | Schemas in `packages/contracts/src/live/`; problem+json with stable `code` and `requestId`; staff routes under the shop give `404` for cross-tenant (V.4) |
| VII Testing | Pass | Six e2e files with 54 scenario rows, concurrency ×20, Gate 9 fault tests, no fixed sleeps (G-27, follow-up from S51 T050), unit specs for pure logic only |
| VIII Operational safety | Pass | Metrics list of AS-52, redaction, per-policy fail-open, validated config (AS-53), graceful shutdown closes viewers first |
| IX Isolation | Pass after work | `ShopMembership` model gone (R1), pin check through `ProductQueryService` (R1), `LiveMute` in `db/ownership.ts`, FK `LiveStream.shopId → Shop` dropped (cross-domain FK, IX.4), outbox append in the domain's own transaction (IX.6), `productTitle` copy taken at pin time (IX.8) |
| X Boundaries | Pass after work | Barrel exports five modules plus contract types; gateway logic hosted in the domain; apps import modules only (D-8) |

No violations, so Complexity Tracking is empty. Post-design re-check: unchanged (design adds owned tables and contract schemas only).

## Follow-ups from already-built specs (treated as requirements)

| From | Item | Plan |
|---|---|---|
| S03 | Replace `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw SQL on tenancy tables with `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`; retest `payouts.read`, `sso.manage`, `ShopScoped` closed-shop answers | Staff routes use `ShopScoped('products.write')` (G-01); poster role from `ShopAccessService.getRole` (G-02); `cannot_mute_staff` from the same. `LiveModule` drops `forFeature([ShopMembership])`. The suspended shop (`403 shop_suspended`) and offboarding shop (`409 shop_offboarding`) answers are tested on create, start, pin and mute in `live-streams.e2e-spec.ts` (AS-41 extension). `payouts.read` and `sso.manage` are not used by this capability; nothing to retest beyond the above. |
| S49 | `declareJobType` with payload contract next to the `JobPayloads` augmentation; catch `InvalidScheduleError`; adapt to the discriminated `cancel` result | `application/live.job-types.ts` declares `launch-events.live-reconcile` (`z.object({}).strict()`); the schedule upsert catches `InvalidScheduleError`. This capability never calls `JobsService.cancel`. |
| S51 | `live-batcher.service.ts` uses `TopicSubscriber`; `livefeed` prefix internal; fixed sleeps in `live.e2e-spec.ts:57,79,93,109,111` (T050) | Already on `TopicSubscriber`; it moves into the domain unchanged in interface. The old spec file is deleted and its three scenarios are rewritten in `live-delivery.e2e-spec.ts` against the injected clock with polling helpers, which removes every fixed sleep. `livefeed` stays declared in `RealtimeTopicPrefixes` with no `TopicRegistry` route. |
| S40 (via S51) | `topicsWithSubscribers`, `publish(..., { replay: false })`, `{ published, id }` | `stats` keeps `replay: false` (already); `pin`, `status` and `comment_removed` keep replay (questions.md LOCAL); the `{ published, id }` result of `publish` is handled where those events are published. `topicsWithSubscribers` is S40's. |
| S22 (same domain) | `LaunchEventTopics` keeps only `event` and `queue` | G-22: the `stream` block and its docs line leave `api/realtime-topics.ts`; `LiveTopicsModule` registers `stream`. |

## Project Structure

### Documentation

```text
specs/domains/S23-live-stream/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http.md, events-and-realtime.md)
└── tasks.md   # by /speckit-tasks
```

### Source Code

```text
packages/contracts/src/live/            # schemas, error codes, event schemas, live-reducer (+ spec)
packages/backend/libs/domains/launch-events/
├── domain/       # reservoir, moderation (whole-word), comment-text, live-state, window-composer, author-handle,
│                 # live-keys, live-constants, ports (LiveStreamRepository, LiveMuteRepository, CommentHistoryReader, ...)
├── application/  # live-stream, live-comment, live-reaction, live-pin, live-moderation, live-snapshot, live-reconcile
│                 # services; live-state cache; events/live-events.ts (+ stream_started/ended, reactions_aggregated,
│                 # removed v2); live.job-types.ts; live-config.ts
├── infra/        # sequelize live-stream and live-mute repositories, redis stores, dynamo history reader/writer,
│                 # live-comments.projector, live-moderation.consumer, live-ticker, live-reconcile job, classifier adapter
├── api/          # live-staff.controller, live-viewer.controller, live-history.controller, live-topics
├── gateway/      # live-batcher, live-stream.controller (SSE), viewer registry, live-gateway.module
├── live.module.ts · live-worker.module.ts · live-projector.module.ts · live-gateway.module.ts · live-topics.module.ts
├── live-{streams,comments,reactions,delivery,history,operations}.e2e-spec.ts
└── index.ts      # five modules + contract types
packages/backend/migrations/            # LiveStream.pin/pinVersion + drop Shop FK; LiveMute (expand only)
packages/backend/db/ownership.ts        # register LiveMute
packages/backend/apps/{core,worker,projector,sse-gateway}/  # import modules only; delete apps/sse-gateway/src/live/
packages/backend/libs/infrastructure/rate-limit/            # live.snapshot.ip, live.events.ip (declared in the domain)
scripts/load-tests/live-stream.test.js  # SC-003 / SC-014 ops artifact
docs/spec/capabilities/S23-live-stream.md  # new page (none exists); proof/code markers true
docs/work/architecture/domain-map.md       # "Emits" for launch-events
```

**Structure Decision**: keep the `launch-events` folder; live files move into the same four layers as S22 plus a `gateway/` folder for the delivery tier that runs inside the sse-gateway app. S22 files are not touched except `api/realtime-topics.ts` (remove `stream`), `index.ts`, `launch-events.e2e-spec` kit imports if they break.

## Order of work

1. Living-spec page first (`docs/spec/capabilities/S23-live-stream.md`: rules and behaviours, then fill `[proof]`/`[code]` as tests land); contracts, error codes, migrations and `db/ownership.ts`.
2. Pure domain modules with their unit specs and the contracts reducer spec.
3. Ports and adapters (repositories, Redis stores, Dynamo reader/writer, classifier); validated config.
4. Application services and controllers: lifecycle with outbox, comment path, reactions, pin, removal, mute, snapshot, history route.
5. Projector (upserts, validation, dead-letter) and moderation consumer (timeout, retry, independent group); worker (ticker, aggregation event, reconcile job).
6. Gateway move into the domain (join-then-snapshot, cap, close on end, config), `LiveTopicsModule`, module split, barrel trim, apps wiring, delete the old gateway folder.
7. Rewrite the e2e files (injected clock, no fixed sleeps), k6 script, `domain-map.md`.
8. Static gates (`tsc`, lint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `python3 scripts/livespec/check.py`), then the whole capability suite once.

## Dependencies and risks found while planning

- **Gaps list is partly stale** (see Technical Context); verify before editing.
- **`ProductDto.status` archived value** (S05) is relied on by AS-37; if `getProductsByIds` hides archived rows the answer is the same (`422 product_not_pinnable`), so either shape passes; the test seeds an archived product through catalog's exported service.
- **`LiveStream.shopId` FK to `Shop`** exists in migration `20261001240000`; dropped in a new migration (IX.4), as S22 did for `LaunchEvent`.
- **Dynamo hot partition**: `STREAM#<id>#<minute>` is one partition per stream-minute (5,000 writes/s). Decision in research D-8: keep the key (spec and notes), spread load by the 25-item batching and note the capacity risk; no sharding.
- **Outbox topic name**: S22 settled `launch_events.events` (aggregate types cannot contain `-`); S23 uses the same (research D-3). Recorded under Spec changes in gaps.md.

## Complexity Tracking

None.
