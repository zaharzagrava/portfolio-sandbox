# Gaps: S23 — Live Launch Stream (domain `launch-events`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's `check:table-ownership` lines. This is the implementation agent's to-do list. All paths are under `packages/backend/libs/domains/launch-events/` unless stated; line numbers are from the draft at the time of writing. The code is an imperfect draft; the spec wins.

Existing tests: `domain/reservoir.spec.ts` (uniformity) and `apps/sse-gateway/src/live/live.e2e-spec.ts` (3 tests: burst, reactions/ticker, moderation). They move to the domain and are rewritten against the 54 scenarios; the sse-gateway spec is deleted when its module moves (G-17).

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Authorization and tenancy (`api/live.controller.ts`, `live.module.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-003, AS-35, AS-41 | `:76-118` pin, unpin, remove, mute authorise through `memberships.findOne` on the tenancy model and answer `403` to outsiders; staff routes carry no shop in the path; `live.module.ts:4,10` registers `forFeature([ShopMembership])`. | Move to `/shops/:shopId/live/:streamId/...` with `ShopScoped('products.write')`; stream must belong to the shop (else `404 stream_not_found`); add unmute; drop the model injection (R1). |
| G-02 | FR-011, AS-16 | `:62` every membership (even VIEWER) → `isStaff`; query runs on every comment. | R1 `ShopAccessService.getRole`; priority only for roles with `products.write`; no relational query on the comment path (G-08). |
| G-03 | FR-025, AS-25 | `:63` `authorName = user.email.split('@')[0]` is published to viewers, history and events. | Pure `domain/author-handle.ts` (keyed hash of user + stream); `authorName` carries the handle. |
| G-04 | FR-004, AS-33 | `CreateStreamDto` (`:11-14`) accepts any `launchEventId` UUID: fine as a plain ID; no stream read route for staff. Keep unvalidated. | Keep; contract schemas in `packages/contracts` (`createLiveStreamRequestSchema`, `liveStreamSchema`). |

### Write side (`application/live.service.ts`, `domain/moderation.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-05 | FR-001, FR-002, AS-34 | `:62-73` `status <> 'ENDED'` lets `SCHEDULED → ENDED` and `LIVE → LIVE` pass silently, `start` after `ENDED` is `404`; no outbox events; Redis set write and realtime publish happen outside any transaction. | Pure `domain/live-state.ts`; one conditional update + `outbox.append` (`live.stream_started`, `live.stream_ended`) in one `@Transactional`; `409 stream_ended`; repeat = `200` no event; publish after commit. |
| G-06 | FR-022, AS-23 | `:91-105` Redis list push, publish, then Kafka send: a Kafka failure leaves a visible, never-persisted comment and a retry duplicates it. | Durable event first; visible second; `503 live_unavailable`; `clientId` dedupe (`postCommentRequestSchema`). |
| G-07 | FR-018, AS-17 | `CommentDto` `@Length(1, 200)` counts UTF-16 units, no normalization, no whitelist. | `domain/comment-text.ts` (NFC, strip control/zero-width, collapse whitespace, code points), `forbidNonWhitelisted`. |
| G-08 | FR-026, AS-24, AS-49 | `:85` liveness from the global set `live:active`; controller calls `live.get` (Postgres) on every comment (`live.controller.ts:60`); a Redis wipe makes every live stream answer `409`; random stream IDs hit Postgres. | Per-stream cached state (single-flight refill, 10 s negative cache) from the stream record; set is only for the publisher and is rebuilt by the reconcile job (G-14). |
| G-09 | FR-020, AS-19 | `moderation.ts:30` `\b${w}` is a prefix match (blocks "scampi"); reasons are free text. | Whole-word match after normalization, `reason: 'link' \| 'policy'`, problem `code: comment_blocked`; keep normalization; unit matrix. |
| G-10 | FR-024, AS-21, AS-40 | `:149` mute = Redis set, 7-day TTL; no unmute; staff mutable; user ID unvalidated. | Migration `LiveMute (streamId, userId, mutedBy, mutedAt)` PK `(streamId, userId)`, registered in `db/ownership.ts`; Redis set as cache rebuilt on miss/reconcile; `DELETE` route; `422 cannot_mute_staff` via R1 role. |
| G-11 | FR-029, AS-28, AS-29 | `:113-119` clamps counts to 20, skips unknown emoji silently; no stream state check; `ReactDto` only `@IsObject`; controller (`:76`) does a Postgres read before counting. | Strict zod/class validation (6 emoji, ints 1–20, ≥ 1 key), atomic all-or-nothing counting, `404`/`409` from cached state. |
| G-12 | FR-034–FR-036, AS-36–AS-38 | `:127-135` pin in Redis only (24 h), no product check, no version, any stream state; `PinDto.stockLeft` unbounded. | Columns on `LiveStream` (`pin` jsonb, `pinVersion`), `ProductQueryService.getProductsByIds([id], {shopId})` (R1), `409` unless `LIVE`, identical re-pin no event, clear on end, Redis as cache. |
| G-13 | FR-027, AS-39, AS-44 | `:139-144` `remove` publishes and emits for any ID, no existence check, no dedupe, free-text reason; `infra/live-comments.projector.ts:57` drops a removal that arrives before its comment. | Existence via recent list or history lookup, `404 comment_not_found`, 24 h claim marker, durable-first, `live.comment_removed` v2; projector upserts both event kinds. |

### Statistics, reconcile, history (`infra/`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-14 | FR-041, AS-49, AS-50 | No job rebuilds the active set or the mute cache. | `launch-events.live-reconcile` (S49 recurring, 30 s, single-run). |
| G-15 | FR-030, FR-032, AS-31, AS-32 | `infra/live-ticker.service.ts:36-44` fine in shape (lease, shard sum, `stats {second, reactions, viewers}`); no `live.reactions_aggregated`; set-based stream list; no ended-stream stop test. | Keep lease loop; add aggregation event (once per second); metrics; list from the reconciled set. |
| G-16 | FR-037–FR-039, AS-43–AS-45 | `infra/live-comments.projector.ts:33` `PutRequest` overwrites `removed`; ignores `LiveCommentRemoved` in `topics` (comment at `:22` says "same topic carries both"); one invalid message fails the batch; no `GET` history route. | `UpdateItem` upserts (post and removal commute), per-message schema validation with dead-lettering, retry bound kept, `GET /live/:streamId/history` + `liveHistoryPageSchema`. |
| G-17 | FR-028, AS-47 | `infra/live-moderation.consumer.ts:30-33` awaits the classifier with no timeout; one throw fails the whole batch; removal reason string `auto:0.93`. | Timeout 2 s, 3 retries, dead-letter, `live_moderation_failed_total`; `reason: 'auto'`, `score`; independent consumer group. |

### Delivery tier (`apps/sse-gateway/src/live/` → moves into the domain)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-18 | FR-046, AS-54 | Gateway logic lives in `apps/` (`live-batcher.service.ts`, `live-stream.controller.ts`, `live-gateway.module.ts`) and imports `SubscriptionHub` from app code; domain barrel `index.ts:7-23` exports models, `LiveService`, `Reservoir`, key helpers, projector/consumer classes. | Host `LiveGatewayModule` in the domain; S51 provides `TopicSubscriber` from infrastructure; export only `LiveModule`, `LiveWorkerModule`, `LiveProjectorModule`, `LiveGatewayModule`, `LiveTopicsModule` + contract types; apps import modules (`apps/projector/src/projector.module.ts:10,57`, `apps/sse-gateway/src/sse-gateway.module.ts:24,95`). |
| G-19 | FR-010, AS-03 | `live-batcher.service.ts:11,56` priority capped at 10 per tick, extras silently dropped; own comments also fed to the sampler (fine) but no `mine` flag; ordering of items not guaranteed. | Pure `domain/window-composer.ts`: priority + own + sample, deduped, ascending by ID; no cap; `mine: true`. |
| G-20 | FR-013, AS-07, AS-09 | `live-stream.controller.ts:44-47` snapshot read and sent before `registry.join`: events in between are lost; `pin` has no version. | Join first, snapshot second, flush buffer; `pin.version`; client reducer in `packages/contracts/src/live/live-reducer.ts`. |
| G-21 | FR-006, FR-015, FR-017, AS-11, AS-12 | `live-stream.controller.ts:29` `404` unless in the active set (no `SCHEDULED` pre-show, no `409` for ended); no cap on connections; connections stay open after `ENDED`; `skipThrottle: true` at `:26`. | State from cached stream record; viewer cap (`503 gateway_full`); close after `status ENDED`; `live.events.ip` limit. |
| G-22 | FR-016, AS-13 | `api/realtime-topics.ts:17` registers `stream` inside the shared `LaunchEventTopics` with `policy: () => true`. | Own `LiveTopicsModule` / `LiveTopics`; remove the `stream` line from the shared file (S22 contract). |
| G-23 | FR-021, FR-033, FR-047 | `libs/infrastructure/rate-limit/rate-limit.types.ts:56-57` has `live.comment`, `live.reaction`; no address limits. | Add `live.snapshot.ip` (120/min) and `live.events.ip` (30/min), fail open. |
| G-24 | FR-044, AS-53 | Constants (`TICK_MS`, `SAMPLED_PER_TICK`, buffer, heartbeat) hard-coded. | Validated config (window, sample size, cap, threshold). |
| G-25 | FR-043, AS-52 | No metrics, no structured logs for the live path (`live-ticker.service.ts:35` logs a message string). | Metrics list of AS-52; log fields `streamId`, `requestId`; no content. |
| G-26 | FR-045, FR-047, AS-42 | `GET /live/:streamId` (`live.controller.ts:57-65`) returns `stream + pin + recent` with no cache hint and 3 queries per call; response is not a contract schema. | `liveSnapshotSchema`, `Cache-Control: public, s-maxage=1`, shared refill, `degraded: true` when the fast store is down. |
| G-27 | Tests | `launch-events.e2e-spec.ts` covers booking only; the gateway spec lives in `apps/`; `live.e2e-spec.ts` stubs timing by sleeping. | Six e2e files per `test-plan.md`, injected clock, no fixed sleeps; unit specs listed there. |

## 2. Debt-register rows touching this capability

No open row names `launch-events` or `S23` literally. The open rows that apply to this domain's live code:

| Row | What applies here | Replaced by |
|---|---|---|
| D-6 (I.2) | `api/live.controller.ts:8` imports `Reaction` from `infra/live-keys`; `application/live.service.ts:14-27` imports `infra/live-keys` (keys, constants, `LiveComment` type); services use `@InjectConnection` raw SQL directly. | Repository ports in `domain/` (`LiveStreamRepository`, `LiveMuteRepository`, `CommentHistoryReader`), adapters in `infra/`; shared constants/types move to `domain/`. |
| D-7 (IX.4) | `ShopMembershipModel` injected in `api/live.controller.ts:7,35` and registered in `live.module.ts:4,10`. | **R1** `ShopAccessService.getRole` / `assertMember` plus `ShopScoped`. |
| D-8 (X.4) | Barrel exports infrastructure internals for apps to wire: `LiveCommentsProjector`, `LiveModerationConsumer`, `LiveTicker`, `LiveCoreModule`, key helpers, `Reservoir`, `LiveService` (`index.ts:7-23`). | Apps import `LiveProjectorModule` (projector), `LiveWorkerModule` (worker), `LiveGatewayModule` and `LiveTopicsModule` (sse-gateway), `LiveModule` (core). |
| D-12 (IX.4) | `check:table-ownership` reports no SQL line for `launch-events` today (the raw SQL of `LiveService` touches only `LiveStream`, owned). Keep it that way: product and role data are R1 calls, never SQL on `Product` / `ShopMembership`. | **R1** for product (`ProductQueryService`) and role lookups; **R3**/**R2** not needed. |
| D-15 / D-16 / D-11 / D-17 | Not touched by this capability. | — |

## 3. `check:table-ownership` output for `launch-events`

`pnpm --dir packages/backend check:table-ownership` (run at spec time) lists 2 findings for the domain, both belong to the live part:

```
launch-events  (2)
  MODEL ShopMembershipModel   owned by tenancy   libs/domains/launch-events/api/live.controller.ts
  MODEL ShopMembershipModel   owned by tenancy   libs/domains/launch-events/live.module.ts
```

| Finding | Replaced by |
|---|---|
| `live.controller.ts` injects `ShopMembershipModel` (`:7,35,62,116`) | **R1** `ShopAccessService.getRole` for the poster's role (priority flag) and `ShopScoped('products.write')` for staff routes; the controller no longer touches memberships. |
| `live.module.ts` `SequelizeModule.forFeature([ShopMembership])` (`:4,10`) | Removed with the model: import tenancy's module through its public entry for the guard/service (**R1**). |

Target state: `check:table-ownership --strict` reports nothing for `launch-events` after S22 and S23 are both done (AS-54).

## 4. Schema, registry and contract work

- Migration: add `LiveStream.pin jsonb NULL`, `LiveStream.pinVersion int NOT NULL DEFAULT 0`; new table `LiveMute` (no foreign key to `User`; `streamId` FK to `LiveStream` allowed, same owner); register `LiveMute` in `db/ownership.ts` (`LiveStream` is registered at `:118`). Remove nothing from `LiveStream`.
- DynamoDB `LiveComments`: no key change; items gain `removed`, `removedReason` through upserts; keep TTL attribute.
- `packages/contracts`: add the schemas named in `spec.md` (Provides) and `live-reducer.ts`; event schemas for `live.comment_removed` v2, `live.reactions_aggregated`, `live.stream_started`, `live.stream_ended`.
- `docs/work/architecture/domain-map.md` `launch-events` "Emits": add the new events and v2.
- S22 coordination: remove the `stream` prefix from the shared topics file; keep `LaunchEventTopicsModule` for `event` and `queue`.
- S51 coordination: `TopicSubscriber` export from the infrastructure realtime lib (until then the gateway module keeps a local adapter behind the same interface). **Update (plan time):** `TopicSubscriber` is exported and the batcher already injects it; no local adapter is needed.

## 5. Follow-ups from already-built specs (planned, see plan.md)

| ID | From | Item | Required change |
|---|---|---|---|
| G-28 | S03 | Direct tenancy models and raw SQL | None remain in the controller (it already uses `ShopAccessService`); verify `check:table-ownership` is clean for `launch-events`, drop `forFeature([ShopMembership])` if still present, and add the `403 shop_suspended` / `409 shop_offboarding` cases to `live-streams.e2e-spec.ts` (create, start, pin, mute). |
| G-29 | S49 | `declareJobType`, `InvalidScheduleError` | `application/live.job-types.ts` for `launch-events.live-reconcile`; the schedule bootstrap catches `InvalidScheduleError`. |
| G-30 | S51 | `TopicSubscriber`, `livefeed` prefix, fixed sleeps at `live.e2e-spec.ts:57,79,93,109,111` | Batcher keeps `TopicSubscriber`; the old spec is replaced by `live-delivery.e2e-spec.ts` with a polling helper and the injected clock; no fixed sleep remains. |
| G-31 | IX.4 | `LiveStream.shopId` has a foreign key to `Shop` (migration `20261001240000`) | New migration drops the constraint. |
| G-32 | Docs | No `docs/spec/capabilities/S23-*.md` page exists | Create the page before code (rules, behaviours, `[proof]`/`[code]` markers); `python3 scripts/livespec/check.py` must pass. |

## Verified at tasks time (T001)

`pnpm check:table-ownership` listed the two tenancy findings of section 3 as already gone before this run (the controller already used `ShopAccessService`, the module no longer registered `ShopMembership`). Already true and not redone: G-28 (controller on `ShopAccessService`; the closed-shop answers are now tested), G-30 (batcher on `TopicSubscriber`; the fixed sleeps went with the old spec), the `livefeed` prefix declaration (moved to `api/live-topics.ts`).

## Implementation status (T073)

Every gap is closed. Task that closed it:

| Gap | Closed by | Gap | Closed by |
|---|---|---|---|
| G-01 staff routes under the shop | T050 | G-17 async moderation timeout, retries, dead letter | T056 |
| G-02 priority from tenancy role | T038 | G-18 gateway hosted in the domain, barrel trimmed | T023, T063 |
| G-03 author handle | T035, T038 | G-19 window composer, no priority cap | T021 |
| G-04 contracts for create | T006, T047 | G-20 join first, snapshot second | T024 |
| G-05 lifecycle, outbox, transitions | T046, T047 | G-21 stream states on the connection | T024 |
| G-06 durable first, `clientId` | T038 | G-22 own topics module | T014 |
| G-07 comment text | T033 | G-23 address policies | T012 |
| G-08 cached stream state | T036 | G-24 validated config | T010 |
| G-09 whole-word moderation | T034 | G-25 metrics and structured logs | T061 |
| G-10 durable mutes | T004, T049 | G-26 public snapshot | T051 |
| G-11 strict reactions | T041 | G-27 six e2e files, no fixed sleeps | T013, T018, T032, T040, T045, T054, T059, T069 |
| G-12 durable versioned pin | T048 | G-28 S03 follow-up | T045, T052 |
| G-13 removal | T049 | G-29 S49 follow-up | T011 |
| G-14 reconcile job | T060 | G-30 S51 follow-up | T018, T023, T027 |
| G-15 ticker and aggregation event | T042 | G-31 Shop foreign key dropped | T004 |
| G-16 history upserts | T055 | G-32 living-spec page | T002, T068 |

Differences from the plan text, recorded for the human (none changes a rule of `spec.md`):

- The unpin `pin` event carries `{version, unpinned: true}` (the spec says "payload `null` and `version + 1`"; a bare `null` cannot be ordered by a client). The snapshot (HTTP and event connection) also carries `pinVersion`, so a client orders a late `pin` event against an unpin it never saw. The reducer in `packages/contracts/src/live/live-reducer.ts` implements both.
- Comment ids are uuidv7 built on the injected clock with a counter, so ids made in one millisecond still sort in the order they were made.
- The recent list keeps the newest 100 comments and shows the last 50 non-removed ones, so a removal does not leave a snapshot with 49.
- The staff lookup of the comment path is cached for 15 seconds by this capability (`ShopAccessService` does not cache the answer for non-members, which is every ordinary viewer).
- The e2e kit is `testing/live-test-kit.ts` and the k6 script is `packages/backend/scripts/load-tests/live-stream.test.js` (script entry in `packages/backend/package.json`), following where the repository keeps both.
- `launchEventsRatePolicies` is no longer exported from the barrel (AS-54); `test/utils/global-modules.ts` no longer lists it (the modules register their policies with `RateLimitModule.forFeature`).
- Config keys `live_window_ms`, `live_sample_size`, `live_viewer_cap`, `live_moderation_threshold` (env `LIVE_WINDOW_MS`, `LIVE_SAMPLE_SIZE`, `LIVE_VIEWER_CAP`, `LIVE_MODERATION_THRESHOLD`) are in `libs/common/config/launch-events-config.ts`.
- `packages/backend/.env.test` was a stale copy of `env/test.env.example` (missing settings that other capabilities made required); it was refreshed from the example so the e2e suites can start. It is not tracked.

## Spec changes

No human-signed file (`*.reviewed.json`) exists for S23 or is touched. One text deviation inside `spec.md`, recorded for the human: the outbox topic for `live.stream_started` / `live.stream_ended` is written `launch-events.events`; the implementation uses `launch_events.events` (aggregate type `launch_events`), as S22 settled (aggregate types cannot contain `-`).

`docs/spec/capabilities/S51-realtime-push.md` (not signed, no `*.reviewed.json` exists) lost one line of its front-matter `scope` (`packages/backend/apps/sse-gateway/src/live/**`): that folder moved into the domain (T027) and `python3 scripts/livespec/check.py` reports a scope that matches no file as an error. No rule or behavior of S51 changed.

## Sibling-spec follow-ups

- **S22**: `api/realtime-topics.ts` loses its `stream` prefix (declared in `RealtimeTopicPrefixes` and defined in the registry); `LaunchEventTopics` keeps only `event` and `queue`. Anything of S22 that asserted the `stream` route in the shared module must stop; S23 registers it in `LiveTopicsModule`.
- **S28**: may consume `live.stream_started` / `live.stream_ended` on topic `launch_events.events` (payloads in `contracts/events-and-realtime.md`); no notification is produced by S23.
- **S40**: may read `live.reactions_aggregated` v1 `{streamId, second, reactions}` from the event stream; `live.comment_removed` is now v2 (`reason: 'moderator'|'auto'`, `actorId?`, `score?`).
- **S05**: relies on `ProductQueryService.getProductsByIds([id], { shopId })` returning archived products with their `status` (or omitting them); both lead to `422 product_not_pinnable`.
- **S50**: new policies `live.snapshot.ip` and `live.events.ip` are declared by `launch-events` (registry stays decentralised); `rate-limit.types.ts` needs no edit.
- **J03**: consumes the stream routes (now under `/shops/:shopId/live/...` for staff), `live.stream_started`, the event connection, `stats` and the pin. A `pin` event after an unpin is `{version, unpinned: true}`.
- **S51**: its page scope listed `packages/backend/apps/sse-gateway/src/live/**`; that folder is gone (the event connection is `libs/domains/launch-events/gateway/`, hosted by the sse-gateway app through `LiveGatewayModule`). The scope line was removed (see Spec changes); S51 should decide whether its page names the new location.
- **S22**: nothing in S22's specs asserts the `stream` route; `api/realtime-topics.ts` lost its `stream` and `livefeed` declarations, which now live in `api/live-topics.ts`.
- **S03**: `ShopAccessService.getRole` stays uncached for non-members; every comment asks "is this poster staff", so S23 caches that answer for 15 s itself. A tenancy-side negative entry would let S23 drop its cache.
- **S52**: nothing to adopt; S23 reads the stream state through `CacheService.getOrLoad` with `l1: 'never'` and drops it with `invalidate` before it publishes a change.

## Gate repairs

- AS-09: the reducer tests live in `packages/contracts/src/live/live-reducer.spec.ts`, outside the backend scope that `check-tests.py scenarios` scans. Added `libs/domains/launch-events/domain/live-reducer-contract.spec.ts` (title `S23 AS-09: ...`), which runs the exported reducer from the backend. The full property test stays in contracts.
