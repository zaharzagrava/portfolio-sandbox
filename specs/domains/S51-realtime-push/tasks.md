---

description: "Task list for S51 — Realtime push hub"
---

# Tasks: S51 — Realtime push hub

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `research.md` (D1–D12), `data-model.md`, `contracts/`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: required (constitution VII, test-first). For every test-plan.md row the failing test task precedes its code task. Run each spec with `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` from `packages/backend`; narrowest first, the whole `libs/infrastructure/realtime` suite once at the end. After 5 failed fixes of one test: stop, write blocker + attempts + hypothesis in `questions.md`.
**Rules**: no `git checkout/restore/reset/stash/clean` (undo by hand-editing); no new `sequelize.transaction` (the lib has none); remove any `// S54 T037 audit` comment in files touched; do not edit sibling specs (record in gaps.md "Sibling-spec follow-ups").

Paths: `L=packages/backend/libs/infrastructure/realtime`, `APP=packages/backend/apps/sse-gateway/src`, `C=packages/contracts/src`.
User-story map: US1 stream basics (AS-01–06) · US2 replay (AS-07–20) · US3 authorization (AS-21–28) · US4 publisher (AS-29–34) · US5 fan-out (AS-35–43) · US6 limits (AS-44–49) · US7 lifecycle (AS-50–53) · US8 revocation (AS-54–58 + S03 follow-up) · US9 server-side API (AS-59–61) · US10 registry (AS-62–65) · US11 recovery (AS-66–68) · US12 observability (AS-69–70).

## Phase 1: Setup

- [X] T001 Record baselines: `grep -rn "sequelize.transaction\|S54 T037 audit" $L $APP` (expect none) and `grep -rn "prefix: 'job'" packages/backend/libs` into a scratch note for the final gate comparison (G-26).
- [X] T002 [P] Create zod contracts in `$C/realtime.ts` (export from the package index): `streamQuerySchema` (only `topics`, 1–10 distinct), `streamEventEnvelopeSchema` `{topic,data}`, `resyncDataSchema` `{reason:'replay-gap'}`, `revokedDataSchema`, `cursorSchema` (`<topic>~<pos>|…`, pos `^\d{1,16}-\d{1,16}$`, not `0-0`, not > 1 min in the future, header ≤ 2,048 chars) (G-31, FR-053).
- [X] T003 [P] Create validated config in `$L/config/realtime.config.ts` (zod; heartbeat, max buffered 1 MiB, replay page 500, replay buffer 1,000, topics/connection 10, payload 32 KiB, publish timeout 1 s, rule timeout 2 s, discovery timeout 1 s, per-user 20, per-address 10, instance capacity, lifetime 30 min, stall 30 s, drain 10 s, retention 1,000 count / 1 h, retry jitter 2000–5000) replacing constants `HEARTBEAT_MS`, `MAX_BUFFERED_BYTES`, `REPLAY_LIMIT`, `MAX_TOPICS_PER_CONNECTION`, `REPLAY_MAXLEN` (G-34, FR-050).

## Phase 2: Foundational (blocks all stories)

- [X] T004 Move the engine: relocate `$APP/topic-stream/{subscription-hub.service.ts,topic-stream.controller.ts,topic-stream.module.ts}` to `$L/hub/subscription-hub.ts` and `$L/stream/{topic-stream.controller.ts,stream.service.ts}`; create `$L/realtime-stream.module.ts`; gateway `sse-gateway.module.ts` imports `RealtimeStreamModule`; app keeps only `main.ts`, `instrument.ts`, composition (G-01, I.5). Controller stays thin: validate via contracts schema, call one `StreamService`.
- [X] T005 Create barrel `$L/index.ts` and update `$L/realtime.module.ts` (global; exports `RealtimePublisher`, `TopicRegistry`, `TopicSubscriber`, `RealtimeSubscriptions`, typed errors); replace deep imports `@app/infrastructure/realtime/topic-registry` across `packages/backend/libs/domains/**` and the app (G-02).
- [X] T006 [P] Extend `packages/backend/test/utils/sse-client.ts` to return `comments`, `retry`, raw frames, and to read from a raw socket that stops reading; add a polling helper (deadline 5 s, no fixed sleeps) (G-29, G-30).
- [X] T007 [P] Create the test topics module (test code only, no domain imports) in `$L/testing/test-topics.module.ts`: routes `auction`, `stream` (public), `user` (self), `shop`+`live` (members via fixture table), `shop`+`assets`, `order-export` (300 ms async rule), `chat`, `flags` singleton, and gated routes a test can hold open / make throw / hang; plus an app-factory helper booting real `RealtimeModule` + stream module with production pipe/filter/prefix/interceptors + S50 interceptor, frozen clock, ms-level config, and a second-instance option (G-28, test-plan Conventions).
- [X] T008 Add `rt:` key helpers in `$L/keys.ts` per data-model.md (`rt:s:<topic>`, `rt:c:<topic>`, `rt:ctl`) shared by publisher and hub.

**Checkpoint**: engine lives in the lib, builds, test harness ready.

## Phase 3: US10 — Registry (P1) (topic resolution foundation)

**Goal**: route-keyed registry, validated, frozen. **Independent test**: REG e2e + unit files.

- [X] T009 [P] [US10] Write failing unit `$L/topics.spec.ts` (`it.each`): topic grammar/shapes (AS-04 table), route resolution incl. hyphen prefix `order-export` and suffix coexistence (AS-62), cursor decode eight cases (AS-15), resync decision with `now`/retention (AS-16, AS-17), retention cutoff (AS-20), jitter bounds 2000–5000 (AS-51). Move grammar cases out of `topic-registry.spec.ts` (G-25, G-30).
- [X] T010 [P] [US10] Rewrite failing unit `$L/topic-registry.spec.ts` (`it.each` over definitions: valid, upper-case, illegal suffix, 33-char prefix, missing rule, empty suffix list: AS-64; define before/after freeze: AS-65); remove the OR-combination assertion (old `:50`).
- [X] T011 [P] [US10] Write failing `$L/realtime-registry.e2e-spec.ts`: hyphen prefix and suffix coexistence over HTTP, duplicate route fails the boot (AS-62, AS-63).
- [X] T012 [US10] Implement pure `$L/topics.ts` (prefix grammar `^[a-z][a-z-]{0,31}$`, route resolution, cursor encode/decode per `cursorSchema`, resync decision per research D4, retention cutoff, jitter fn); pure, `now` as an argument (G-20, G-25).
- [X] T013 [US10] Rewrite `$L/topic-registry.ts`: route-keyed `define({prefix, suffixes?, singleton?, owner?, policy})`, one rule per (prefix,suffix), duplicate → boot error, definition validation, suffixes belong to their prefix (bare `<prefix>:<id>` rejected when suffixes are listed), frozen on application start → `TopicRegistryFrozenError` (G-25; AS-62–65).
- [X] T014 [US10] Adapt topics modules to the new API without changing policy semantics: `libs/domains/{tenancy,identity,auctions,launch-events,experimentation,chat,fulfilment,catalog-sync,orders}/**/realtime-topics.ts` (`catalog-sync` `job`→`import`, `orders` `job`→`order-export`), add a `shop`+`assets` topics module for assets; `grep -rn "prefix: 'job'" packages/backend` must be empty (G-26). Run T009–T011 green.

## Phase 4: US1 — Viewer receives events (P1) 🎯 MVP

**Goal**: SSE endpoint delivers events; hostile input is safe. **Independent test**: STREAM e2e.

- [X] T015 [P] [US1] Write failing unit `$L/frame.spec.ts` (`it.each` over `\n\n`, `data:`, `id:`, `\r`, U+2028, 30 KiB) (AS-06).
- [X] T016 [US1] Write failing `$L/topic-stream.e2e-spec.ts` replacing the old app spec: live delivery + headers + no compression (AS-01), two topics combined cursor (AS-02), isolation (AS-03), all 11 request-shape classes with zero subscribers asserted and credentials-in-URL / extra query → `400` (AS-04), duplicate topics collapse (AS-05), one hostile payload end to end (AS-06); assert stored state and metrics; no fixed sleeps (G-27).
- [X] T017 [US1] Implement pure `$L/frame.ts` `formatFrame` (single serializer; no raw event type in `event:`) (G-18).
- [X] T018 [US1] Implement stream request handling in `$L/stream/topic-stream.controller.ts` + `stream.service.ts`: `streamQuerySchema` validation, codes `invalid_topics|unknown_topic|unsupported_query`, dedupe, headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Content-Encoding` guard (G-13, G-16). Run T015, T016 green.

## Phase 5: US4 — Publisher (P1)

**Goal**: atomic, validated, best-effort publish. **Independent test**: PUB e2e + unit.

- [X] T019 [P] [US4] Write failing unit `$L/publish-validation.spec.ts` (`it.each` invalid/valid names: topic, type `^[a-z][a-z0-9_.-]{0,63}$` with `open|error|resync|revoked` reserved, payload ≤ 32 KiB) (AS-31).
- [X] T020 [P] [US4] Write failing compile-time spec `$L/realtime-topic-types.spec.ts` (`@ts-expect-error`) (AS-34).
- [X] T021 [US4] Write failing `$L/realtime-publisher.e2e-spec.ts`: result id equals frame cursor and replayed id (AS-29); 200 concurrent publishers across two processes distinct/ordered/complete (AS-30); one rejected call per validation class leaves the store untouched (AS-31); store fault → `{published:false}`, one attempt, ≤ 1 s (AS-32); no viewers (AS-33); retention: publish 2,500 → length ≤ 1,200, entries older than 1 h dropped, key TTL refreshed, live-only unstored (AS-20).
- [X] T022 [US4] Implement `$L/publish/publish-validation.ts` and typed errors (`InvalidRealtimeTopicError`, `InvalidRealtimeEventTypeError`, `RealtimePayloadTooLargeError`, `InvalidRealtimePayloadError`) (G-22).
- [X] T023 [US4] Implement `$L/publish/publish.lua.ts` + `realtime-publisher.service.ts` per research D1: one script (EVALSHA with fallback): `XADD MAXLEN ~ 1000`, `MINID ~ now-1h`, `PEXPIRE` 1 h refreshed, `PUBLISH rt:c:<topic>` with id; live-only = plain `PUBLISH`; 1 s timeout, one attempt, returns `{published,id}`, never throws on store faults (G-21, G-23, G-24).
- [X] T024 [US4] Restore augmentable `RealtimeTopicPrefixes` → `RealtimeTopic` template-literal type and `topicOf` builders in `$L/topics.ts` (G-22). Run T019–T021 green.
- [X] T025 [US4] Re-check the 15 callers in gaps.md G-23 (`orders/application/order.service.ts`, `order-export.service.ts`, `auctions/application/auction.service.ts`, `auctions/infra/auction.jobs.ts`, `chat/application/chat.service.ts`, `chat-sync.service.ts`, `fulfilment/application/dispatch.service.ts`, `courier.service.ts`, `launch-events/application/live.service.ts`, `seat-hold.service.ts`, `waiting-room.service.ts`, `catalog-sync/application/catalog-import.service.ts`, `notifications/application/inbox.service.ts`, `seller-insights/infra/dashboard-ticker.service.ts`, `launch-events/infra/live-ticker.service.ts`): fix any use of the old string return; run `tsc --noEmit`.

## Phase 6: US5 — Fan-out and hub (P1)

**Goal**: one backplane subscription per topic, race-free, leak-free. **Independent test**: FAN e2e.

- [X] T026 [US5] Write failing `$L/realtime-fanout.e2e-spec.ts`: one backplane subscription for 100 viewers (AS-35); a leaving viewer doesn't disturb others (AS-36); 50 concurrent first subscribers → one subscribe (AS-37); two instances + a third without viewers (AS-40); 500 connect/close cycles and 100 aborts leak nothing (AS-42); abort during replay stops writes (AS-43).
- [X] T027 [US5] Rework `$L/hub/subscription-hub.ts` as the ref-counted hub: pending promise per channel shared by concurrent subscribers, entry removed on failed `SUBSCRIBE` (G-05; AS-37); try/catch per listener with `realtime_listener_errors_total` (G-06); graceful `quit` after drain and command timeout on the subscriber connection (G-08); idempotent release.
- [X] T028 [US5] In the stream service register `req.on('close')` first; make `close` idempotent and total (clears heartbeat, lifetime, stall, drain timers; releases subscriptions); check `closed` per replay page (G-10). Run T026 green.

## Phase 7: US2 — Replay (P1)

**Goal**: exact resume, gap → `resync`. **Independent test**: REPLAY e2e.

- [X] T029 [US2] Write failing `$L/topic-replay.e2e-spec.ts`: live-only no `id:`, cursor untouched (AS-07); replay exactness 3..5 after #2 then live (AS-08); handover while publishing via `Promise.all`, no gap/dup (AS-09); replay longer than one page (AS-10); repeatable (AS-11); per-topic cursors (AS-12); baseline frame on first connect (AS-13); reconnect from baseline gets missed events (AS-14); mixed bad `Last-Event-ID` → `200` + counter (AS-15); trimmed gap → `resync` (AS-16); deleted buffer + old cursor → `resync` (AS-17); cursor at latest replays nothing (AS-18); crafted stale/duplicate backplane message dropped (AS-19).
- [X] T030 [US2] Implement in the stream service: live-only messages bypass the cursor and carry no `id:` (G-11); paged `XRANGE` loop until the end of the buffer, stored entries parsed with a guard before headers are committed (G-12); resync via the `topics.ts` decision (oldest retained / max trimmed / retention) emitting `event: resync` `{"reason":"replay-gap"}`; baseline `id:` frame on first connect (G-19); cursor hardening from `cursorSchema` (length, `0-0`, future, duplicates) ignored, not rejected (G-20); bounded live buffer during replay then drain with dedupe. Run T029 green.

## Phase 8: US3 — Authorization (P1)

**Goal**: the topic owner's rule decides; no leaks. **Independent test**: AUTHZ e2e.

- [X] T031 [US3] Write failing `$L/topic-authorization.e2e-spec.ts`: owner-only 200/403/401 and no residue (AS-21); public topic for anonymous (AS-22); all-or-nothing admission (AS-23); existing vs missing shop indistinguishable in body+headers (AS-24); async rule with viewer (`userId`,`roles`) (AS-25); rule throws/times out (2 s) → `503 realtime_policy_unavailable` (AS-26); rule runs once per topic per connection (AS-27); invalid credential → `401`, cookie and bearer accepted (AS-28).
- [X] T032 [US3] Implement admission in `stream.service.ts`: rules evaluated in parallel with a 2 s timeout, fault → `503 realtime_policy_unavailable`, anonymous refusal `401` vs authenticated `403` with a generic `detail` not naming the topic, viewer built from the real principal (not `[req.user.role]`) (G-15).
- [X] T033 [US3] Replace `@Firewall({ anonymous: true, skipThrottle: true })` in the controller with S01's anonymous-allowed marker; if not yet exposed, do an in-controller credential check (invalid presented credential → `401`) and note it in gaps.md "Sibling-spec follow-ups" for S01 and in the final report (G-14). Run T031 green.

## Phase 9: US6 — Limits (P1)

**Goal**: slow/greedy clients cannot hurt the instance. **Independent test**: LIMIT e2e.

- [X] T034 [US6] Write failing `$L/realtime-limits.e2e-spec.ts`: slow consumer dropped at 1 MiB via a non-reading raw socket (AS-44); stalled writer dropped after the stall timeout (AS-45); replay-phase overflow discards buffered live and replay continues (AS-46); per-user 20 and per-address 10 caps → `429 too_many_connections` `Retry-After: 5` (AS-47); instance capacity → `503 realtime_capacity` (AS-48); `realtime.connect` 60/min with the real S50 module, fail open with the limiter store stopped (AS-49).
- [X] T035 [US6] Implement `$L/stream/connection.ts` with bounded write buffer, stall timer, bounded replay buffer (1,000), counters `byUser/byAddress/total`, released on close (G-17).
- [X] T036 [US6] Declare policy `realtime.connect` (sliding 60/min, key user-or-address, fail open) via `RateLimitModule.forFeature` and apply `@RateLimit('realtime.connect')` on the controller (G-14, S50). Run T034 green.

## Phase 10: US7 — Lifecycle (P2)

**Goal**: heartbeat, jitter, lifetime, drain. **Independent test**: LIFE e2e.

- [ ] T037 [US7] Write failing `$L/realtime-lifecycle.e2e-spec.ts`: `: ping` heartbeats and timer cleared on close (AS-50); `retry:` in 2000–5000 over 200 connections with spread (AS-51); lifetime and credential-expiry end with clean resume from cursor (AS-52); graceful shutdown drains with a jittered window and ends connections (AS-53).
- [ ] T038 [US7] Implement per-connection jittered `retry:` (`topics.ts` jitter), max lifetime 30 min and end at `credentialExpiresAt` when the principal provides it, and drain on shutdown via the S54 shutdown registry (jittered 10 s window), subscriber graceful quit after drain (G-16, G-17). Run T037 green.

## Phase 11: US8 — Revocation incl. S03 follow-up (P1)

**Goal**: removing access ends streams within 2 s fleet-wide. **Independent test**: REV e2e + tenancy e2e.

- [X] T039 [US8] Write failing `$L/realtime-revocation.e2e-spec.ts` (two apps): revoke on another instance → `revoked` frame, other topics continue (AS-54); revoking the last topic ends the connection (AS-55); revoke during admission (rule held open, `Promise.all`) not lost (AS-56); revoke without user hits all viewers (AS-57); not a ban — re-admission by rule works (AS-58).
- [X] T040 [US8] Write failing `packages/backend/libs/domains/tenancy/member-revocation.e2e-spec.ts` FIRST (S03 follow-up): member removed through the real API → `revoked` frames for `shop:<id>:live` and `shop:<id>:assets` within 2 s, no later events, other members unaffected, rule still decides re-admission, consuming the same `tenancy.member_removed` twice is a no-op.
- [X] T041 [US8] Implement `RealtimeSubscriptions.revoke({userId?,prefix,id,suffix?})` publishing on `rt:ctl`, and the hub control-channel listener with the per-topic state machine `admitting → active → revoked` (a notice during `admitting` applies after the rule returns) (research D6, G-09). Run T039 green.
- [X] T042 [US8] Implement `packages/backend/libs/domains/tenancy/infra/member-revocation.consumer.ts` (`MemberRevocationConsumer`, idempotent per IV.5; `tenancy.member_removed {shopId,userId,role,reason}` → `revoke({ userId, prefix: 'shop', id: shopId })`), registered next to `ShopPlanConsumer` in the tenancy module (research D7). Run T040 green. No sequelize transaction.

## Phase 12: US9 — Server-side subscribe and discovery (P2)

**Independent test**: SUB e2e.

- [ ] T043 [US9] Write failing `$L/realtime-subscriber.e2e-spec.ts`: in-process subscribe shares the subscription (AS-59); `topicsWithSubscribers` sorted, route-exact, across two apps (AS-60); discovery cap 10,000 and outage → `RealtimeUnavailableError` (AS-61); idempotent unsubscribe (AS-39); throwing listener isolated (AS-41).
- [ ] T044 [US9] Implement `$L/hub/topic-subscriber.service.ts` (`subscribe(topic, handler): Promise<() => Promise<void>>`) and `$L/hub/realtime-subscriptions.service.ts` `topicsWithSubscribers(prefix, suffix?)` via the backplane channel list (`PUBSUB CHANNELS`, 1 s timeout, sorted, ≤ 10,000) (G-09). Run T043 green.
- [ ] T045 [US9] Switch `$APP/live/live-batcher.service.ts` (lines ~64, 171) from `SubscriptionHub` to `TopicSubscriber` (G-02; S23).

## Phase 13: US11 — Recovery (P1)

**Independent test**: REC e2e.

- [X] T046 [US11] Write failing `$L/realtime-recovery.e2e-spec.ts`: failed `SUBSCRIBE` leaves no residue and gives `503 realtime_unavailable`, retry succeeds (AS-38); backplane blip → open viewers gap-fill from cursor, nothing lost (AS-66); backplane down at connect (AS-67); replay read fails midway (AS-68).
- [X] T047 [US11] Implement the `resubscribed` hook on subscriber `ready` after reconnect and per-connection gap-fill replay from cursor (research D5); `503 realtime_unavailable` mapping for subscribe/replay faults before headers; a mid-replay read failure closes the connection cleanly so the client resumes (G-07). Run T046 green.

## Phase 14: US12 — Observability (P2)

**Independent test**: OBS e2e.

- [ ] T048 [US12] Write failing `$L/realtime-observability.e2e-spec.ts`: metrics registry values for connections, subscriptions, events, drops, resyncs, revokes, listener errors, publish outcomes, with closed label sets (no topic/user/cursor labels) (AS-69); structured logs for open/close/drop/revoke/fault without payload or credentials (AS-70).
- [ ] T049 [US12] Implement `$L/metrics/realtime-metrics.ts` (S54 metrics registry) and logs per FR-054/FR-055; gauges for channels/connections replacing `listenerCount` (G-33). Run T048 green.

## Phase 15: Polish, cleanup, ops, gaps

- [ ] T050 Delete fixed sleeps in the files S51 owns (old `$APP/topic-stream/topic-stream.e2e-spec.ts` goes with the move); do not edit `live/live.e2e-spec.ts` (S23's): record its sleeps (`:57,79,93,109,111`) in gaps.md "Sibling-spec follow-ups" under **S23** (G-27).
- [ ] T051 Cleanup G-03/G-04: if S13 and S24 have landed, delete `libs/infrastructure/redis-pubsub`, `$APP/redis-pubsub`, `payment-stream`, `realtime-notifier`, and dead `ThrottlerModule`/Sequelize wiring in `sse-gateway.module.ts` (`grep -rn redis-pubsub packages/backend` empty); otherwise leave them and record the state in the report and gaps.md.
- [ ] T052 [P] Web (G-32): `packages/web/lib/api/sse.ts` handles `resync` and `revoked` regardless of the page's `types` list and recreates the stream after a final `401`/`403`; `packages/web/hooks/use-event-stream.ts` effect key stable; add tests where the web package has them.
- [ ] T053 [P] Load script (G-35): add a reconnect-storm case to `packages/backend/scripts/load-tests/sse.test.js`; do NOT claim results.
- [ ] T054 [P] Docs (G-36): update README showcase text for #24, #30 and the F-03 section paths to `libs/infrastructure/realtime`.
- [ ] T055 [P] Ops artifacts: confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002 (100 reps), SC-005 (10,000 cycles), SC-007, SC-008 (under load) and that `specs/UNVERIFIED.md` has one S51 row each with status "not run" (already present; verify, never describe as verified).
- [ ] T056 Sibling-spec follow-ups: ensure gaps.md `## Sibling-spec follow-ups` lists S01, S50, S54, S03, S07/S12, S13, S24, S23, S40, S22/S31/S38/S20, W03/W04/W05, plus any added by T033/T050/T051.
- [ ] T057 Gates: `tsc --noEmit` (backend, contracts, web), ESLint, `pnpm --dir packages/backend check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (0 lines for `infrastructure/realtime` and `redis-pubsub`; paste result), direct `sequelize.transaction` count unchanged vs T001.
- [ ] T058 Run the whole suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/realtime` and `libs/domains/tenancy/member-revocation.e2e-spec.ts`; report SC-009 coverage and the S03 follow-up (T040/T042) in the final report.

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all) → US10 (registry; the stream resolves topics through it) → US1 → then US4, US5, US2, US3, US6, US7, US8, US9, US11, US12. US2/US3/US6/US7/US8/US11 all extend `stream.service.ts`, so run them sequentially in the listed order; US4 and US9 touch other files.
- Within a story: failing test task → implementation task → run test green.
- T040 before T042; T041 before T042 (the consumer needs `revoke`); T045 after T044; T057–T058 last.

## Parallel Opportunities

- T002, T003, T006, T007 together. T009, T010, T011 together. T015 with T019, T020. T052–T055 together.

## Implementation Strategy

- MVP: Phases 1–2, US10, US1 (the stream delivers events safely). Then P1 stories (US4, US5, US2, US3, US6, US8, US11), then P2 (US7, US9, US12), then polish. Validate each story by its e2e file before moving on; whole suite once at the end.
