# Tasks: S23 — Live Launch Stream (domain `launch-events`)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted), [data-model.md](data-model.md), [research.md](research.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested (test-plan.md). Test-first: in every phase the failing test task comes before the code task it proves. Run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <file> [-t "AS-nn"]`; unit specs with `node --experimental-vm-modules node_modules/jest/bin/jest.js <path>`; backend commands from `packages/backend`. After 5 failed fixes of the same test, write the blocker into questions.md.

**Path shorthand**: `D` = `packages/backend/libs/domains/launch-events`, `C` = `packages/contracts/src/live`, `B` = `packages/backend`.

**Rules for every task**: no new `sequelize.transaction` (use `@Transactional`/`TransactionRunner`); injected clock and random source in `application/`; no comment text, e-mail, token or `clientId` in logs, labels or error bodies; no fixed sleeps in specs (polling helpers + injected clock); tasks marked "deferred to the final checkpoint" are done. No task here runs a fresh-stack, standalone-boot, journey or browser check (done by the final checkpoint).

## Format: `- [ ] Tnnn [P] [USn] Description with file path`

Where the implementation differs from the task text, a "Done:" note says how (also summarised in gaps.md "Implementation notes").

---

## Phase 1: Setup

- [X] T001 Re-run `pnpm --dir packages/backend check:table-ownership` and re-read each cited line of gaps.md G-01…G-32 (`D/api/live.controller.ts`, `D/live.module.ts`, `D/index.ts`, `D/api/realtime-topics.ts`, `D/infra/*`, `apps/sse-gateway/src/live/*`); in gaps.md add a "Verified at tasks time" note listing gaps already true (G-28 controller on `ShopAccessService`, G-30 batcher on `TopicSubscriber`, `livefeed` prefix) so no task redoes them.
- [X] T002 Create the living-spec page `docs/spec/capabilities/S23-live-stream.md` first (rules and behaviours for lifecycle, comments, reactions, pin, mute, snapshot, history, delivery; no `*.reviewed.json`); leave `[proof: …]`/`[code: …]` markers to be filled in T120; satisfy gaps G-32.
- [X] T003 [P] Scaffold folders `D/{domain,application,infra,api,gateway}` live files and empty `C/index.ts` exports for the live schemas in `packages/contracts/src/live/` (barrel re-exported from `packages/contracts/src/index.ts`).

## Phase 2: Foundational (blocks all stories)

- [X] T004 Migration in `B/migrations/` (expand only): `LiveStream.pin JSONB NULL`, `LiveStream.pinVersion INT NOT NULL DEFAULT 0`; drop FK `LiveStream.shopId → Shop` created by migration `20261001240000` (G-31, IX.4); create `LiveMute` (`streamId UUID NOT NULL REFERENCES "LiveStream"(id)`, `userId UUID NOT NULL` no FK, `mutedBy UUID NOT NULL`, `mutedAt TIMESTAMPTZ NOT NULL DEFAULT now()`, PK `(streamId, userId)`). Remove nothing else. Done: `20261017000000-live-streams-s23-expand.js`.
- [X] T005 Register `LiveMute: 'domain:launch-events'` in `B/db/ownership.ts` (next to `LiveStream` at `:118`/`:187`), add the `LiveMute` Sequelize model in `D/infra/` and `pin`/`pinVersion` on the `LiveStream` model; run `pnpm check:model-registry`. Done: there was no `LiveStream` model (raw SQL); `infra/models/live-stream.model.ts` and `live-mute.model.ts` are new.
- [X] T006 [P] Contract schemas in `C/`: `createLiveStreamRequestSchema` (title 3–120), `liveStreamSchema`, `pinRequestSchema`, `pinSchema`, `postCommentRequestSchema` (strict; optional `clientId`), `liveCommentSchema`, `reactRequestSchema` (6 emoji, ints 1–20, ≥ 1 key), `liveSnapshotSchema` (+ `degraded?: true`), `liveHistoryPageSchema`, error codes (`stream_not_found`, `stream_ended`, `stream_not_live`, `user_muted`, `comment_blocked`+`reason: 'link'|'policy'`, `client_id_reused`, `live_unavailable`, `gateway_full`, `product_not_pinnable`, `cannot_mute_staff`, `comment_not_found`).
- [X] T007 [P] Event schemas in `C/` via `defineEvent`: `live.comment_posted` v1, `live.comment_removed` **v2** (`reason: 'moderator'|'auto'`, `actorId?`, `score?`), `live.reactions_aggregated` v1, outbox `live.stream_started` v1, `live.stream_ended` v1 (payloads per contracts/events-and-realtime.md; outbox topic `launch_events.events`). Done: payload schemas in `C/schemas.ts`, `defineEvent` in `D/application/events/live-events.ts`.
- [X] T008 [P] Domain constants and keys: move `LiveComment`/`Reaction` types, constants and key helpers from `D/infra/live-keys` to `D/domain/live-keys.ts` and `D/domain/live-constants.ts` (D-6); keep the Redis key table of data-model.md.
- [X] T009 Ports in `D/domain/ports.ts`: `LiveStreamRepository`, `LiveMuteRepository`, `CommentHistoryReader`, `RecentCommentStore`, `StreamStateStore`, `ToxicityClassifier` (IV.8); no Sequelize/Redis imports in `domain/`. Done: in `D/domain/live-ports.ts` (S22's `ports.ts` stays S22's); the stream state cache is `application/live-state-cache.ts` over S52 `CacheService`, so no `StreamStateStore` port.
- [X] T010 Validated config `D/application/live-config.ts` (G-24, AS-53): window ms default 250, sample size default 5, viewer cap default 50,000, toxicity threshold default 0.7; invalid values refuse start naming the setting. Done: the bounds are in `libs/common/config/launch-events-config.ts` (joi), the defaults in `live-config.ts`.
- [X] T011 [P] Job type `D/application/live.job-types.ts`: `declareJobType('launch-events.live-reconcile', z.object({}).strict())` next to the `JobPayloads` augmentation; the schedule bootstrap upserts a 30 s recurring schedule (`overlap: skip`, concurrency 1) and catches `InvalidScheduleError` (G-29, S49 follow-up; this capability never calls `JobsService.cancel`).
- [X] T012 [P] Rate-limit policies `live.comment` (3/10 s user), `live.reaction` (5/1 s user), `live.snapshot.ip` (120/60 s ip), `live.events.ip` (30/60 s ip), all fail open, declared in `D/` policies file via `definePolicies` (G-23; no edit of `rate-limit.types.ts` beyond what the registry needs).
- [X] T013 E2E kit for the six files in `D/live-test-kit.ts`: boots `LiveModule`, `LiveWorkerModule`, `LiveProjectorModule`, `LiveGatewayModule`, `LiveTopicsModule` with production prefix/pipes/filters; seeds shops, members, products, users only via fixture helpers and exported services (no `ShopModel`/`ProductModel`/`UserModel`); injected clock; polling helper (`waitFor`); switchable store wrappers for fault injection (event stream, fast store, outbox, history store, classifier, limiter); streaming SSE client; query counter. Done: `D/testing/live-test-kit.ts` (the boundary rule x6 allows test imports only under `libs/**/testing/`).
- [X] T014 Remove the `stream` prefix block and its docs line from `D/api/realtime-topics.ts` (keep `event`, `queue`); create `D/live-topics.module.ts` with `LiveTopics` registering public `stream:<id>` (`policy: () => true`, events `status`, `pin`, `comment_removed`, `stats`; `stats` published with `replay: false`) and keep `livefeed` declared in `RealtimeTopicPrefixes` with no registry route (G-22). Add a S22 follow-up check: nothing in S22 specs asserts the `stream` route (note only, do not edit S22 specs). Done: `LiveTopics` is `D/api/live-topics.ts`; the prefix declarations moved with it.

**Checkpoint**: migrations apply, `tsc --noEmit` passes, kit boots.

---

## Phase 3: User Story 1 — Viewer follows a huge stream (P1) 🎯 MVP

**Goal**: fair sampling, batching, snapshot-then-live without gaps, control events immediate, shedding and caps (AS-01…AS-14).
**Independent test**: `live-delivery.e2e-spec.ts` + `reservoir`, `window-composer` specs + `live-reducer.spec.ts`.

### Tests first
- [X] T015 [P] [US1] `D/domain/reservoir.spec.ts`: uniformity over 20,000 runs (chi-square bound per position), fewer than `k` kept whole, `k` ≤ 0 rejected, `drain` resets, injected random source (AS-01).
- [X] T016 [P] [US1] `D/domain/window-composer.spec.ts`: `it.each` + `fast-check` — priority and own never dropped, sample ≤ 5, dedupe of priority ∩ sample, ascending by ID, empty input (AS-03, AS-04).
- [X] T017 [P] [US1] `C/live-reducer.spec.ts`: stale `pin.version`, stale `stats.second`, removal of unknown id, removed comment arriving later, `fast-check` any permutation/duplication → same final state (AS-09).
- [X] T018 [US1] `D/live-delivery.e2e-spec.ts` (describe "Live stream: sampling, batching, snapshots and event connections"), written failing: AS-01, AS-02, AS-03, AS-04 (keep-alive after 15 s by clock), AS-05, AS-06, AS-07 (20 concurrent connects with pin changes/removals; reduced client state equals server state), AS-08 (≤ 250 ms), AS-10 (paused reader > 256 KB → closed, `live_viewers_dropped_total{reason="slow"}`), AS-11 (cap 3 → 4th `503 gateway_full` + `Retry-After: 5`), AS-12, AS-13. These replace the three scenarios of `apps/sse-gateway/src/live/live.e2e-spec.ts` without any fixed sleep (G-30).
- [X] T019 [US1] `D/live-reactions.e2e-spec.ts` (describe "Live stream: reactions, statistics and viewer counts") skeleton with AS-14 failing: entries 100 + 50 → `viewers = 150`; one instance silent 15 s → 50.

### Implementation
- [X] T020 [P] [US1] `D/domain/reservoir.ts`: move/keep reservoir with injected random source and `k` ≤ 0 rejection (satisfy T015).
- [X] T021 [P] [US1] `D/domain/window-composer.ts`: priority + own + sample, deduped, ascending by ID, no cap, `mine: true` on the per-viewer copy (G-19; satisfy T016).
- [X] T022 [P] [US1] `C/live-reducer.ts`: client reducer ordering by `pin.version`, `stats.second`, comment id; idempotent; removal-before-comment tolerated (satisfy T017).
- [X] T023 [US1] Move gateway into the domain: `D/gateway/live-batcher.service.ts` (uses `TopicSubscriber`, one comment-feed + one control subscription + one sampler per stream per instance, release ≤ 1 s after last viewer), `D/gateway/live-viewer-registry.ts`, `D/gateway/live-stream.controller.ts`, `D/live-gateway.module.ts` (G-18).
- [X] T024 [US1] Event connection `GET /live/:streamId/events` in `D/gateway/live-stream.controller.ts`: join registry first, snapshot second, flush buffer (G-20); state from cached stream record: unknown `404`, malformed `400`, `ENDED` `409 stream_ended`, `SCHEDULED` opens and gets `status LIVE` (G-21); per-instance cap `503 gateway_full` + `Retry-After: 5`; 256 KB slow-viewer shedding; close after `status ENDED` ≤ 1 s; `live.events.ip` limit replaces `skipThrottle`; `: ping` every 15 s, `retry: 3000`; `pin` carries `version`.
- [X] T025 [US1] Viewer count: per-instance `live:{id}:viewers` hash `<count>:<ts>`, 60 s lifetime, stale instances (>15 s) ignored in the sum (AS-14) in `D/infra/redis-viewer-store.ts`.
- [X] T026 [US1] Make private feed private: `livefeed:<id>` refused like an unknown topic for client subscribers (AS-13); verify against `LiveTopicsModule`.
- [X] T027 [US1] Delete `apps/sse-gateway/src/live/` (including `live.e2e-spec.ts` with its fixed sleeps at `:57,79,93,109,111`); `B/apps/sse-gateway/src/sse-gateway.module.ts` imports `LiveGatewayModule` + `LiveTopicsModule` only.
- [X] T028 [US1] Run T015–T019 specs until green (narrowest first, `-t "AS-nn"`).

---

## Phase 4: User Story 2 — Viewer posts a comment; abuse stopped (P1)

**Goal**: AS-15…AS-25.
**Independent test**: `live-comments.e2e-spec.ts` + `moderation`, `comment-text`, `author-handle` specs.

### Tests first
- [X] T029 [P] [US2] `D/domain/comment-text.spec.ts`: code-point length (emoji sequences), NFC, control and zero-width removal, whitespace collapse (`it.each`) (AS-17).
- [X] T030 [P] [US2] `D/domain/moderation.spec.ts`: term matrix — plain, leet, letter-spaced, stretched, accented, punctuation, whole-word (`scampi`, `fa keyboard` pass) (AS-19).
- [X] T031 [P] [US2] `D/domain/author-handle.spec.ts`: deterministic, stream-scoped, non-reversible shape, no part of the input echoed (AS-25).
- [X] T032 [US2] `D/live-comments.e2e-spec.ts` (describe "Live stream: comment ingest, moderation and mutes"), written failing: AS-15 (zero relational queries), AS-16, AS-17, AS-18, AS-19, AS-20 (limiter down → accepted + counter), AS-21, AS-22 (20 concurrent → one `201`, 19 `200`, one event; repeated ≥ 20×), AS-23 (event stream refusing; feed write failing after durable accept), AS-24 (query counter 0 over 1,000 warm comments; evicted state + 100 concurrent → 1 read; 1,000 unknown IDs ≤ 1 read each, negative cache 10 s), AS-25.

### Implementation
- [X] T033 [P] [US2] `D/domain/comment-text.ts` (NFC, strip control/zero-width, collapse whitespace, length in code points) (G-07).
- [X] T034 [P] [US2] `D/domain/moderation.ts`: whole-word match after normalization, `reason: 'link' | 'policy'`, disguised spellings still covered (G-09).
- [X] T035 [P] [US2] `D/domain/author-handle.ts`: keyed hash of (user, stream) (G-03).
- [X] T036 [US2] Per-stream state cache `D/application/live-state-cache.ts` over S52 `CacheService` (single-flight refill, 10 s negative cache, `{shopId, status}`) with `StreamStateStore` adapter in `D/infra/` (G-08, AS-24). Done: the cache holds the whole stream record (status, pin, version) so the snapshot is served from it too.
- [X] T037 [US2] Repositories: `D/infra/sequelize-live-stream.repository.ts`, `D/infra/sequelize-live-mute.repository.ts` implementing the ports (no raw SQL in services, D-6); mute Redis set as cache rebuilt on miss.
- [X] T038 [US2] Comment service `D/application/live-comment.service.ts` + `POST /live/:streamId/comments` in `D/api/live-viewer.controller.ts`: check order auth → rate limit → body (strict zod, `postCommentRequestSchema`) → stream exists → `LIVE` → mute → sync moderation; role via `ShopAccessService.getRole` (priority only with `products.write`, G-02); durable `live.comment_posted` on the plain producer first, then recent list + publish to `livefeed`; `clientId` dedupe per user, 10 min (`201` new, `200` replay, `422 client_id_reused`); `503 live_unavailable` on failure; blocked attempts consume rate budget; `comment_blocked` with `reason`; metrics `live_comments_total{result,reason}`, `live_limiter_unavailable_total` (G-06). Done: the staff check is `ShopAccessService.assertMember(…, 'products.write')` behind a 15 s cache of ours (ordinary viewers are not members, and tenancy does not cache that answer).
- [X] T039 [US2] Run T029–T032 until green.

---

## Phase 5: User Story 3 — Reactions counted, not streamed (P1)

**Goal**: AS-26…AS-32. **Independent test**: `live-reactions.e2e-spec.ts`.

### Tests first
- [X] T040 [US3] Extend `D/live-reactions.e2e-spec.ts`, failing: AS-26, AS-27 (100 × `{"❤️": 7}` → 700 in next `stats`; empty second still publishes viewers), AS-28 (all-or-nothing; `{"❤️": 20}` accepted), AS-29, AS-30 (limiter down → accepted), AS-31 (two publishers × 3 streams × 30 s each `second` once; takeover ≤ 4 s; ended stops ≤ 2 s; late counter ignored), AS-32 (aggregation run twice → one event).

### Implementation
- [X] T041 [US3] `D/application/live-reaction.service.ts` + `POST /live/:streamId/reactions`: strict `reactRequestSchema` (6 emoji, ints 1–20, ≥ 1 key, `422` whole body), `404` unknown, `409` not `LIVE` from cached state (no Postgres), `202` empty, 8-shard counters `live:rx:<id>:<second>:<shard>` (G-11).
- [X] T042 [US3] `D/infra/live-ticker.service.ts`: keep lease loop (3 s lease, 1 s tick), stream list from reconciled set, publish `stats {second, reactions, viewers}` every second (`replay: false`, handle `{ published, id }` result), `live.reactions_aggregated` once per non-empty second via `live:{id}:agg:<second>` marker, metrics `live_reactions_total`, `live_stats_published_total` (G-15); `LiveWorkerModule` in `D/live-worker.module.ts`.
- [X] T043 [US3] Run T040 until green.

---

## Phase 6: User Story 4 — Staff run the stream (P2)

**Goal**: AS-33…AS-42. **Independent test**: `live-streams.e2e-spec.ts` + `live-state.spec.ts`.

### Tests first
- [X] T044 [P] [US4] `D/domain/live-state.spec.ts`: transition table for all 9 (from, to) pairs incl. repeat no-ops (`it.each`) (AS-34).
- [X] T045 [US4] `D/live-streams.e2e-spec.ts` (describe "Live stream: lifecycle, authorization and pinned commerce"), failing: AS-33…AS-42 per test-plan rows (20 concurrent starts; outbox refused → status unchanged `503`; cross-tenant `404` identical to unknown on every staff route; pin version 1,2,…, survives fast-store wipe; two staff pinning ×20 → distinct consecutive versions; remove ×20 concurrent → one event; mute/unmute; `Cache-Control: public, s-maxage=1`; 1,000 concurrent snapshot reads ≤ 1 relational read/s). Plus S03 follow-up cases: `403 shop_suspended` and `409 shop_offboarding` on create, start, pin and mute; archived product seeded through catalog's exported service.

### Implementation
- [X] T046 [P] [US4] `D/domain/live-state.ts` pure transition table (G-05).
- [X] T047 [US4] `D/application/live-stream.service.ts`: create/start/end as one conditional update (`WHERE id AND "shopId" AND status = :from`, one row asserted) + `outbox.append` (`live.stream_started`, `live.stream_ended`, topic `launch_events.events`) in one `@Transactional`; ending clears `pin`, keeps `pinVersion`; `409 stream_ended`; repeats `200` without event; publish `status` after commit; update state cache and active set. Done: `TransactionRunner.run`.
- [X] T048 [US4] `D/application/live-pin.service.ts`: `ProductQueryService.getProductsByIds([id], {shopId})` (no SQL on `Product`), unknown/foreign/archived → `422 product_not_pinnable`, text and `stockLeft` bounds, `409 stream_not_live`, `productTitle` copied at pin time, conditional update bumping `pinVersion`, identical re-pin no event, unpin `204` + new version, Redis `live:{id}:pin` as cache (G-12). Done: the cache is the stream state entry (dropped before the `pin` event is published); the pin change runs under a row lock.
- [X] T049 [US4] `D/application/live-moderation.service.ts`: remove comment (existence via recent list or history lookup, `404 comment_not_found`, `live:{id}:rm:<commentId>` 24 h claim before durable write, released on failure, durable `live.comment_removed` v2 first then recent list + `comment_removed` publish; `503` if event stream refuses) (G-13); mute/unmute on `LiveMute` (idempotent, `422 cannot_mute_staff` via `getRole`, unknown user `204`). Done: split into `live-removal.service.ts` (removal), `live-moderation.service.ts` (mute, unmute, staff lookup) and `live-mutes.service.ts` (cached mute check and rebuild), so the worker and the projector need no tenancy.
- [X] T050 [US4] `D/api/live-staff.controller.ts`: routes under `/shops/:shopId/live/...` with `ShopScoped('products.write')`, stream must belong to shop else `404 stream_not_found`; thin one-call handlers (G-01, D-7); contracts/http.md route table; no alias for old routes.
- [X] T051 [US4] `D/application/live-snapshot.service.ts` + `GET /live/:streamId` in `D/api/live-viewer.controller.ts`: `liveSnapshotSchema`, `Cache-Control: public, s-maxage=1`, `live.snapshot.ip`, shared single-flight refill, `degraded: true` when fast store down (G-26).
- [X] T052 [US4] `D/live.module.ts`: drop `SequelizeModule.forFeature([ShopMembership])`, wire repositories/services/controllers; import tenancy only through its public entry (G-28); run `pnpm check:table-ownership` for `launch-events`.
- [X] T053 [US4] Run T044–T045 until green.

---

## Phase 7: User Story 5 — Nothing lost; bad comments retracted (P2)

**Goal**: AS-43…AS-48. **Independent test**: `live-history.e2e-spec.ts`.

### Tests first
- [X] T054 [US5] `D/live-history.e2e-spec.ts` (describe "Live stream: history, async moderation and consumers"), failing: AS-43 (1,000 events / 3 minutes, groups ≤ 25, throttled leftovers retried, retry limit → redelivery), AS-44 (duplicate post, removal before post, removal twice, orphan marker expiry), AS-45 (invalid payload / unknown version dead-lettered in a mixed batch, both consumers), AS-46 (cursor, ascending, removed excluded, `422` malformed `minute`/`limit`, `404`, scheduled empty, anonymous), AS-47 (≥ 0.7 removed ≤ 1 s p95 with `auto`+score; duplicate delivery → one removal; classifier timeout → 3 retries, dead-letter, `live_moderation_failed_total`), AS-48.

### Implementation
- [X] T055 [US5] `D/infra/live-comments.projector.ts`: `UpdateItem` upserts for both `live.comment_posted` and `live.comment_removed` v2 (removal-only marker expiry = id time; post expiry = post time + 30 days), per-message schema validation with dead-lettering, groups ≤ 25, retry bound kept, `live_history_lag_seconds`, `live_consumer_failures_total{consumer}` (G-16); group `live-comments-history`; `D/live-projector.module.ts`. Done: per-message validation and dead-lettering are the consumer framework's (`handles`); the marker expiry is the comment time + 30 days like a post's.
- [X] T056 [US5] `D/infra/live-moderation.consumer.ts`: independent group `live-moderation`, classifier port with 2 s timeout, 3 retries then dead-letter, `live_moderation_failed_total`, removal through the shared removal service with `reason: 'auto'` + `score`, threshold from config (G-17); classifier adapter in `D/infra/`.
- [X] T057 [US5] `GET /live/:streamId/history?minute&limit&cursor` in `D/api/live-history.controller.ts` + `D/infra/dynamo-comment-history.reader.ts`: ascending by ID, cursor without gaps/duplicates, removed excluded, `liveHistoryPageSchema`.
- [X] T058 [US5] Run T054 until green.

---

## Phase 8: User Story 6 — Survives faults, operable (P3)

**Goal**: AS-49…AS-54. **Independent test**: `live-operations.e2e-spec.ts`.

### Tests first
- [X] T059 [US6] `D/live-operations.e2e-spec.ts` (describe "Live stream: degradation, configuration, observability and domain isolation"), failing: AS-49 (wipe mid-stream), AS-50 (missing LIVE added, stale ENDED removed, mute cache rebuilt, two concurrent runs same result), AS-51 (event stream down; fast store down → snapshot `200` degraded; recovery without restart), AS-52 (metrics present after full flow; log scan: `streamId` + request ID present, no text/e-mail/token/`clientId`), AS-53 (invalid window, sample size, viewer cap, threshold each refuse start naming the setting; defaults 250/5/50,000/0.7), AS-54 (barrel exports only the five modules and contract types; ownership registry lists `LiveStream`, `LiveMute`).

### Implementation
- [X] T060 [US6] `D/infra/live-reconcile.job.ts` handler (`launch-events.live-reconcile`): rebuild `live:active` from LIVE streams, drop ENDED, rebuild mute cache; safe under concurrent/duplicate runs (G-14).
- [X] T061 [US6] Metrics and structured logs across the live path per AS-52 list (`live_batch_items`, `live_window_comments`, `live_delivery_lag_seconds`, `live_viewers`, `live_removals_total{source}` …), fields `streamId`, `requestId`, no content (G-25); replace message-string logs (`live-ticker.service.ts:35`).
- [X] T062 [US6] Per-policy fail-open and store-outage behaviour (event stream down → comments `503`, reactions `202`, control events and staff routes work; fast store down → `503`s, snapshot degraded); graceful shutdown closes viewers first.
- [X] T063 [US6] Barrel `D/index.ts` exports only `LiveModule`, `LiveWorkerModule`, `LiveProjectorModule`, `LiveGatewayModule`, `LiveTopicsModule` + contract types; update `B/apps/{core,worker,projector,sse-gateway}` imports (`apps/projector/src/projector.module.ts:10,57`, `apps/sse-gateway/src/sse-gateway.module.ts:24,95`); no app imports a domain internal (G-18, D-8).
- [X] T064 [US6] Run T059 until green.

---

## Phase 9: Polish and cross-cutting

- [X] T065 [P] `scripts/load-tests/live-stream.test.js` + `loadtest:live-stream` script in root `package.json` (5,000 SSE connections plus comment flood) for SC-003/SC-014 (ops artifact, not run here). Done: the repository keeps its k6 scripts and `loadtest:*` entries under `packages/backend`, so the script and the entry are there.
- [X] T066 [P] Confirm SC-003 and SC-014 appear under "Ops artifacts" in quickstart.md and as rows (status "not run") in `specs/UNVERIFIED.md`; both already exist, do not duplicate and never mark verified.
- [X] T067 [P] `docs/work/architecture/domain-map.md` `launch-events` "Emits": add `live.stream_started`, `live.stream_ended`, `live.reactions_aggregated`, `live.comment_removed` v2.
- [X] T068 Fill every `[proof: …]` and `[code: …]` marker in `docs/spec/capabilities/S23-live-stream.md` with the final test names/paths; run `python3 scripts/livespec/check.py`.
- [X] T069 Search the six e2e files and any remaining S23 spec for fixed sleeps (`setTimeout`/`sleep`) and replace with `waitFor` + injected clock (S51 T050 follow-up, G-27, G-30).
- [X] T070 Confirm no `sequelize.transaction` was added in `D/` and none remains with a `// S54 T037 audit` comment in files touched; run `tsc --noEmit` and lint for `packages/backend` and `packages/contracts`.
- [X] T071 Run `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (no `launch-events` line), `pnpm check:module-graph`, `pnpm check:model-registry`.
- [X] T072 Run the whole capability suite once (six e2e files, one file at a time via `test-spec.sh`; unit specs) and record the result in quickstart.md without claiming runtime boot proofs (deferred to the final checkpoint).
- [X] T073 Update gaps.md: tick each gap G-01…G-32 as done with the task that closed it; keep "## Spec changes" (outbox topic `launch_events.events`) and "## Sibling-spec follow-ups" (S22, S28, S40, S05, S50, J03) current.

---

## Dependencies and order

- Phase 1 → Phase 2 → stories. T004–T005 precede every Postgres-using task; T006–T007 precede services; T013 precedes every e2e file; T014 precedes US1.
- US1, US2, US3 share the kit and the state cache: build US2's T036–T037 before US3's T041 and US1's T024 if the kit lacks them (US1 may stub state through `StreamStateStore` port). US4 (T047) feeds the state cache used by all; recommended order after Foundation: US4 → US2 → US1 → US3 → US5 → US6 for fastest green e2e, or priority order if state cache is built first.
- US5 depends on US2 (events) and US4 (removal service). US6 depends on all.
- Polish after all stories; T068 after tests exist; T072 last.

## Parallel opportunities

- Foundational: T006, T007, T008, T011, T012 in parallel.
- Pure unit specs and modules: T015/T016/T017, T029/T030/T031, T044 in parallel (different files); their implementations T020–T022, T033–T035, T046 in parallel.
- Polish: T065, T066, T067 in parallel.

## Implementation strategy

MVP = Foundation + US2 + US4 minimum viable path (create/start stream, post comment) then US1 delivery; the P1 set (US1–US3) is the first shippable increment. Deliver story by story; each phase ends with its e2e file green before the next. Runtime proofs (standalone boots, fresh stack, journeys) are the final checkpoint's, not tasks here.

## Follow-up coverage

S03 → T045, T050, T052; S49 → T011; S51 → T014, T023, T027, T042, T069; S40 → T042 (`replay: false`, `{ published, id }`); S22 → T014; gaps G-01…G-32 → see T073 mapping.
