# Tasks: S38 — Feature flags and remote config (domain `experimentation`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md` (G1–G24, B1–B8, D-6/D-8/D-15), `research.md` (R-1…R-25), `data-model.md`, `contracts/flags-api.md`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: required (test-plan.md). Order is test-first: in every story the failing test task comes before the code task that makes it pass.

**Paths**: `E` = `packages/backend/libs/domains/experimentation`; `C` = `packages/contracts/src`. Run backend commands from `packages/backend`; run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` (one file per process, L-008). Never use git checkout/restore/reset/stash/clean. No new direct `sequelize.transaction`; use `TransactionRunner.run`. Never create or edit `*.reviewed.json`. Each e2e `it` title carries its `AS-nn` (L-017); each e2e creates its own flags and truncates in `beforeEach` (L-005/L-006); no "A or B" assertions (L-003); tests that break Redis/audit restore it in `afterEach` (L-013); frozen clock, no real sleeps (L-007).

Format: `- [X] Tnnn [P?] [USn?] description with path`. Story labels: US1 admin ships/ramps (AS-01–12), US2 SDK local evaluation (AS-13–29), US3 kill switch (AS-30–36), US4 client endpoint (AS-37–42), US5 audit (AS-43–47), US6 stale report (AS-48–50), US7 route gate (AS-51–52), US8 admin security/ops (AS-53–58).

## Phase 1: Setup

- [X] T001 Create the living-spec page `docs/spec/capabilities/S38-feature-flags.md` first (rules + behaviors for FR-001–FR-064, `[proof: S38 AS-nn]` / `[code: …]` anchors modelled on the S37 page); no `*.reviewed.json`; make `python3 scripts/livespec/check.py` pass now and re-run it at the end of every phase. Keep anchors true as code lands.
- [X] T002 Verify the **verify** items from `specs/domains/S38-feature-flags/research.md` against the code and append a "Verified" section with one line each: R-8 scheduler granularity (S49), R-10 `RealtimeSubscriptions`/`TopicSubscriber` fit for a service-side subscriber, R-14 existing edge credential in `ApiConfigService`, R-15 tenancy optional-shop export, R-16 global filter body for undefined route vs `NotFoundException`, R-18 guard-before-parser 413, R-19 HMAC cursor helper pattern (S37 `domain/list-cursor.ts`), B7 identity exports `AuthModule/Firewall/User/Role`.
- [X] T003 [P] Create the empty file layout under `E/` (`api/`, `application/`, `domain/`, `infra/models/`) as listed in plan.md "Source Code", stubs only, so later tasks have the paths.

## Phase 2: Foundational (blocks every story)

- [X] T004 [P] Write contracts in `C/experimentation/flags.ts`: `flagSchema`, `flagInputSchema` (strict, `expectedVersion` ≥ 0, unknown properties refused), `flagPageSchema`, `flagAuditPageSchema`, `clientFlagsSchema`, `staleFlagsSchema`, `flagRulesetSnapshotSchema` (rollout weights must sum to 10,000; archived excluded), `flagChangedEventSchema` (`type:'experimentation.flag_changed'`, `version:1`); export from the contracts index. Shapes exactly as in `contracts/flags-api.md`.
- [X] T005 [P] Replace the loose `flagsResponseSchema` in `C/bff/upstream.ts` with an alias of `clientFlagsSchema` under the same exported name (keep the `FlagsResponse` type); run `tsc --noEmit` in `packages/contracts` and the BFF upstream/page specs (follow-ups from S48/S30).
- [X] T006 Write expand-only idempotent migration `packages/backend/migrations/<next>-flags-lifecycle.js` (R-25, data-model.md): `SET LOCAL lock_timeout`; `FeatureFlag.status` TEXT NOT NULL check in (`enabled`,`disabled`,`killed`,`archived`) backfilled `true→enabled`, `false→disabled` (never `killed`); `createdAt` TIMESTAMPTZ NOT NULL default now() backfilled with `updatedAt`; `bucketBy` check in (`userId`,`shopId`); partial index `("key") WHERE status <> 'archived'`; `FlagRuleset(id SMALLINT PK CHECK (id=1), version BIGINT NOT NULL)` seeded `max(FeatureFlag.version)` (≥ 1); `FlagAudit.requestId` TEXT nullable, `actorId` backfilled `00000000-0000-0000-0000-000000000000` then `SET NOT NULL`, index `(flagKey, at DESC, id DESC)`; keep `enabled`. Run it on the test stack twice (idempotent; L-011).
- [X] T007 Register `FlagRuleset` under `domain:experimentation` in `packages/backend/db/ownership.ts` (same change as T006; `FeatureFlag`/`FlagAudit` at lines 141-142 stay).
- [X] T008 [P] Write `E/domain/bucket.ts` (`bucketOf(salt, unit) = murmur3_x86_32(salt + ":" + unit, 0) % 10000`, algorithm moved unchanged from the evaluator) and failing-first `E/domain/bucket.spec.ts` (raw hash vectors `""→0`, `"hello"→613153351`, pangram `→0x2e4ff723` moved from `evaluator.spec.ts`, plus a `bucketOf` table) (G21, G22, R-13).
- [X] T009 [P] Write `E/domain/flag-errors.ts`: `FlagError(code, status, extras)` for `validation_failed` 400, `flag_not_found` 404, `version_conflict` 409 (`currentVersion`), `flag_killed` 409, `flag_archived` 409, `invalid_transition` 409 (`currentStatus`), `flag_definition_invalid` 422 (`errors:[{path,code}]`), `flag_limit_reached` 422, `invalid_cursor` 400, `payload_too_large` 413; confirm the global problem+json filter renders `type` = code (R-17, G18).
- [X] T010 [P] Write `E/domain/ports.ts`: tokens `FLAG_REPOSITORY`, `RULESET_PUBLISHER`, `RULESET_SOURCE`, `EVAL_COUNTER_STORE` and their interfaces (repository: locked ruleset version, find-for-update, conditional update asserting one row, insert, count non-archived, list page, append audit, history page, load snapshot; publisher: `publish(version)`; source: `read()` cache 500 ms then DB 2 s; counters: `add`/`flush`). No Nest/ORM/Redis imports in `domain/` (B1).
- [X] T011 [P] Add Sequelize models `E/infra/models/feature-flag.model.ts`, `flag-audit.model.ts` (append-only, `updatedAt:false`), `flag-ruleset.model.ts`; register them in the modules and run `pnpm check:model-registry` (B3, R-20).
- [X] T012 [P] Write `E/domain/flag-cursor.ts` (opaque HMAC-signed keyset cursors: `{k}` for flags, `{at,id}` for history; forged → `invalid_cursor`) following the pattern verified in T002 (R-19).
- [X] T013 [P] Write `E/domain/flag-events.ts`: `defineEvent` for `experimentation.flag_changed` v1, standard topic, keyed by `flagKey`, **no `groupId`** (L-001, R-23).
- [X] T014 [P] Write `E/application/flags-metrics.ts`: `flags_evaluations_total` (label `flag`, unknown keys → `unknown`), `flags_publish_failures_total`, `flags_ruleset_ignored_total`, `flags_ruleset_rejected_total`, repair and refresh counters per AS-58/R-22.
- [X] T015 [P] Write `E/rate-limit-policies.ts` with `definePolicies`: `flags.admin.write` (30/min per admin, writes only) and `flags.client.read` (120/min per principal, per IP for visitors); register names in `packages/backend/libs/infrastructure/rate-limit/rate-limit.types.ts` if needed (G17, G12).

**Checkpoint**: `tsc --noEmit` clean in backend and contracts; migration applied on the test stack.

## Phase 3: US1 — Admin ships dark and ramps up (P1) — AS-01…AS-12

**Goal**: create/update with optimistic concurrency, validation, limits, one ruleset version per applied change. **Independent test**: `flags-admin.e2e-spec.ts` + domain unit specs.

- [X] T016 [P] [US1] Write failing unit spec `E/domain/flag-validation.spec.ts` (`it.each`, `flag definition validation`): every semantic class with exact `{path, code}` (unknown variant, duplicate variant keys/rule ids, weights sum ≠ 10,000, negative/non-integer weights, both `variant` and `rollout`, attribute allowlist, operator arity, `expiresAt`, `bucketBy`, key format) and every limit boundary (20/21 variants, 50/51 rules, 10/11 conditions, 100/101 values, 4 KiB value, 500 flags, 100 chars) (AS-10, AS-11; G4, G5).
- [X] T017 [P] [US1] Write failing unit spec `E/domain/flag-lifecycle.spec.ts` (`it.each`): the full state-machine table of data-model.md (every from-state × command), no-op detection by normalised definition equality including stale version with equal definition (AS-04), `assertNever` on an unknown command (R-3, R-4).
- [X] T018 [P] [US1] Write failing `E/flags-admin.e2e-spec.ts` (`Flags admin API (S38)`): AS-01 (201, `Location`, `flagSchema`, flag row, one `create` audit, ruleset +1), AS-04, AS-05, AS-06 (`Promise.all`), AS-07 (`Promise.all`), AS-08, AS-09 (400 classes + 413 with 300 KiB), AS-10 (three classes, all errors in one response, nothing persisted), AS-11 (two limits), AS-12 (499 seeded + `Promise.all` of two creates → 201 + 422 `flag_limit_reached`, 500 rows, archived not counted); parse bodies with contracts schemas; assert persisted rows.
- [X] T019 [P] [US1] Write failing SDK rollout test in new `E/flags-sdk.e2e-spec.ts` (`Flags local-evaluation SDK (S38)`, extended in US2): AS-02 (4–6% of 20,000 users on, 100 repeats equal, equal after SDK restart, `update` audit row).
- [X] T020 [P] [US1] Add failing AS-03 to `E/domain/evaluator.spec.ts` (`it.each` steps 1%…100%, widening only adds users) (G21).
- [X] T021 [US1] Implement `E/domain/flag-validation.ts` (pure; returns all `[{path, code}]`) and `E/domain/flag-lifecycle.ts` (`decide(current, command, now)` → `noop|apply|reject`, `assertNever`) until T008, T016, T017 pass.
- [X] T022 [US1] Implement `E/infra/sequelize-flag.repository.ts` behind `FLAG_REPOSITORY`: parameterised SQL with fixed column lists, `SELECT … FOR UPDATE` on `FlagRuleset` then the flag, `UPDATE … WHERE key=:k AND version=:v` asserting one row, count of non-archived under the ruleset lock, keyset pages; no `SELECT *` to the wire (B1, B2, B5).
- [X] T023 [US1] Implement `E/application/flag-command.service.ts` `save`: one `TransactionRunner.run`, lock order ruleset → flag, R-5 check order (validate → archived → unknown/`expectedVersion` → killed+enabled → noop → limit → apply); an applied change = flag update + ruleset `+1` + one `FlagAudit` row (`before`/`after` in `flagSchema` shape, `requestId` from CLS, `actorId`) + `OutboxService.append(flag_changed)`; a no-op returns before the version bump; publish is called after commit; emit the one admin log line `{requestId, actorId, flagKey, action, flagVersion}` (R-24). Replace `application/flags-admin.service.ts` and delete its two `// S54 T037 audit` sites.
- [X] T024 [US1] Implement `E/api/flags-admin.controller.ts` (`PUT /admin/flags/:key`: one call, `201`+`Location` or `200`), `E/api/body-size.guard.ts` (413 before validation, 256 KiB), zod pipe with `flagInputSchema`, `Firewall({roles:[ADMIN]})`, `@RateLimit('flags.admin.write')`; wire `E/flags-admin.module.ts`. Make T018 pass.
- [X] T025 [US1] Update `E/domain/evaluator.ts` to import `bucketOf` from `domain/bucket.ts` and make T020 pass. T019 depends on the SDK (T034): keep it red until then.

**Checkpoint**: `test-spec.sh libs/domains/experimentation/domain` and `flags-admin.e2e-spec.ts` green.

## Phase 4: US2 — Services evaluate flags locally, always (P1) — AS-13…AS-29

**Goal**: pure evaluator + SDK that converges on the database truth with stores down, corrupt or slow. **Independent test**: `evaluator.spec.ts`, `flags-sdk.e2e-spec.ts`.

- [X] T026 [P] [US2] Extend failing `E/domain/evaluator.spec.ts` (`flag evaluator`): AS-13 table (status, rule order, AND of conditions, default, every operator × present/absent/array, `killed`), AS-15 (20,000-user collision count < 20), AS-16 (no unit → first slice, reason `rollout`), AS-52 plan targeting (`on`,`on`,`off`); `ruleset_unavailable`, `flagVersion`, asked key on unknown flag (G10, G21).
- [X] T027 [P] [US2] Write failing SDK scenarios in `E/flags-sdk.e2e-spec.ts`: AS-14 (45–55% of 2,000, identical after fresh SDK), AS-17 (unknown/archived via `value`/`isEnabled`/`evaluate`), AS-18 (both stores unreachable, 10,000 identical evaluations, zero client calls, ready), AS-19 (empty cache → DB, version equals DB), AS-20 (both down: not ready, `ruleset_unavailable`, loads within 5 s of recovery), AS-50 (expired flag keeps serving its rollout).
- [X] T028 [P] [US2] Write failing SDK propagation scenarios in `E/flags-sdk.e2e-spec.ts`: AS-21 (save and kill reach SDK within 1 s via `waitFor`), AS-22 (push dropped, fake clock 35 s), AS-23 (v7, v6, v7, v7, v8 → 7 then 8, ignored = 3), AS-24 (bad JSON and schema-invalid rejected, version kept, metric +1, next valid applied), AS-27 (slow cache: 500 ms timeout, DB read, evaluation latency unaffected).
- [X] T029 [P] [US2] Write failing publish/repair scenarios in `E/flags-sdk.e2e-spec.ts`: AS-25 (cache down → 200 within 1.5 s, rows committed, failure metric +1, SDK reads DB at poll), AS-26 (missing and older snapshot repaired, two concurrent runs republish once, key has a TTL; repair catches cache errors, L-016), AS-28 (flush, save → published version = DB version + 1), AS-29 (frozen day counts +3/+1, failed flush keeps counts, shutdown flushes), AS-58 metric values after a scripted sequence.
- [X] T030 [US2] Update `E/domain/evaluator.ts`: add `killed`, `ruleset_unavailable`, `flagVersion`, asked key on unknown flags, no clock/I/O; export `bucketOf`; make T026 pass.
- [X] T031 [US2] Implement `E/infra/redis-ruleset.publisher.ts` (build snapshot from the database, Lua `SET … EX 3600` only if newer, push the version on the `flags` channel, 500 ms bound, caught) and `E/application/ruleset-publisher.service.ts` (counts `flags_publish_failures_total`, never fails the write); call it after commit from `FlagCommandService` (R-7, G8).
- [X] T032 [US2] Implement `E/infra/redis-ruleset.source.ts` (`RULESET_SOURCE`: cache 500 ms → DB 2 s, falls through to DB at run time too, parse with `flagRulesetSnapshotSchema`) and `E/infra/redis-eval-counters.ts` (`flags:evals:<day>`, TTL 40 d, subtract only flushed counts after success, day from `Clock`) (R-9, R-12, G9, G11).
- [X] T033 [US2] Implement `E/application/ruleset-repair.service.ts` + `E/flags-worker.module.ts` (advisory-locked single run per schedule, every 30 s via the scheduler or an unref'd interval as decided in T002; republish when the cache snapshot is missing/older; catch and count cache errors) and import it in `apps/worker/src/worker.module.ts` (R-8).
- [X] T034 [US2] Move `FlagsClient` to `E/application/flags-client.service.ts` over the ports: shared realtime subscription (no own `ioredis`, B6), strictly-newer rule with ignored/rejected counters and one warning without payload, poll 30 s ± 5 s jitter, `ready`, `version`, cold start never throws (5 s unref'd retry), flush at shutdown before connections close; delete `infra/flags.client.ts`; update `flags.module.ts` (`FlagsSdkModule`) providers/tokens. Make T019, T027, T028, T029 pass.
- [X] T035 [US2] Boot check (L-004/L-015): start the real `apps/core`, `apps/worker`, `apps/sse-gateway` after T031–T034; each must reach ready, also with Redis stopped (AS-20). If the sandbox denies it, record the task as `blocked` in `questions.md` as S36/S47 did; never claim it verified.

**Checkpoint**: evaluator unit spec and `flags-sdk.e2e-spec.ts` green.

## Phase 5: US3 — Kill switch (P1) — AS-30…AS-36

**Goal**: kill is a state nobody undoes by saving. **Independent test**: `flags-lifecycle.e2e-spec.ts`.

- [X] T036 [US3] Write failing `E/flags-lifecycle.e2e-spec.ts` (`Flag lifecycle and kill switch (S38)`): AS-30 (204, `killed`, rules kept, one `kill` audit, outbox row, off within 1 s including staff), AS-31 (repeat and `Promise.all` kills, one audit row, version/ruleset unchanged), AS-32 (404 `flag_not_found`, 409 `flag_archived`), AS-33 (`Promise.all(kill, save enabled)` repeated 20 times; assert final `killed` and count the two allowed outcomes separately, L-003), AS-34 (`enabled:true` → 409 `flag_killed`; `enabled:false` → 200 still killed), AS-35 (killed → disabled with `restore` audit; other states → 409 `invalid_transition` with `currentStatus`), AS-36 (transitions, idempotent archive, ruleset removal, list and `includeArchived`, 409 on save and re-create).
- [X] T037 [US3] Add `kill`, `restore`, `archive` to `E/application/flag-command.service.ts` using `flag-lifecycle.decide` (same transaction contents; no-op paths do not bump the ruleset version).
- [X] T038 [US3] Add `POST /admin/flags/:key/{kill,restore,archive}` (204, `Firewall` ADMIN, `@RateLimit('flags.admin.write')`) to `E/api/flags-admin.controller.ts`; make T036 pass.

## Phase 6: US4 — Client endpoint (P1) — AS-37…AS-42

**Goal**: browsers see only their own pre-evaluated client-side flags. **Independent test**: `flags-client.e2e-spec.ts`.

- [X] T039 [P] [US4] Write failing `E/flags-client.e2e-spec.ts` (`Client flags endpoint (S38)`): AS-37 (public 200, `clientFlagsSchema`, exact body, no rules or non-client keys, `Cache-Control: private, no-store`, `Vary: Authorization, X-Anonymous-Id`, admin sees the same), AS-38 (repeat calls, two devices of one user, `clientSide` flip removes the key within 1 s), AS-39 (ignored `X-Shop-Id`, `?shopId`, `X-User-Id`, `X-User-Role`; verified member gets the shop variant), AS-40 (`it.each` bad anonymous ids → 200 first-slice), AS-41 (edge country honoured with the credential, ignored without; platform enum), AS-42 (121st request → 429 `Retry-After`).
- [X] T040 [P] [US4] Write `E/api/request-context.ts` (pure `contextFromRequest`: user from `req.user`, shop only from the verified shop, anonymous id `^[A-Za-z0-9_-]{8,64}$`, platform enum, country only with the constant-time-compared edge credential `flags_edge_secret`, optional, no default, validated at startup) replacing `domain/flags-context.ts` (R-14, G13).
- [X] T041 [US4] Implement `E/application/client-flags.service.ts` (`forContext(ctx)` returns `{version, flags:{key:{variant,value}}}` for `clientSide` non-archived flags) and `E/api/flags-client.controller.ts` (`GET /flags`, `Firewall({anonymous:true})`, one call, headers, `@RateLimit('flags.client.read')`), using the verified-shop mechanism from T002 (R-15); delete the old `api/flags.controller.ts` once admin and client controllers cover it. Make T039 pass.
- [X] T042 [US4] Add a BFF contract check that a real `GET /api/flags` body parses with the aliased `flagsResponseSchema`, and that the BFF still answers `Vary: Authorization, X-Anonymous-Id` and never shared-caches it (follow-up S48).

## Phase 7: US5 — Audit (P2) — AS-43…AS-47

**Goal**: every applied change is auditable, atomically. **Independent test**: `flags-audit.e2e-spec.ts`.

- [X] T043 [US5] Write failing `E/flags-audit.e2e-spec.ts` (`Flag audit and stale report (S38)`) audit part: AS-43 (`[kill, update, create]`, actors, `requestId`, before/after, `flagAuditPageSchema`), AS-44 (120 rows with equal `at` → 50/50/20 no repeats; `limit` bounds, invalid cursor → 400), AS-45 (forced audit failure → full rollback, no outbox row, no push, generic 500; restore in `afterEach`), AS-46 (write verbs on history → 404/405, archived flag's rows remain, unknown key 404), AS-47 (one `flag_changed` outbox row per applied change, none for no-ops, parsed with `flagChangedEventSchema`).
- [X] T044 [US5] Implement `E/application/flag-query.service.ts` (`list`, `get`, `history` with keyset cursors) and the `GET /admin/flags`, `GET /admin/flags/:key`, `GET /admin/flags/:key/history` routes in `E/api/flags-admin.controller.ts` (explicit response mappers, `limit` 1–200 default 50, `status`, `includeArchived`); make T043 pass.

## Phase 8: US6 — Stale report (P2) — AS-48…AS-50

**Goal**: flags do not rot. **Independent test**: `flags-audit.e2e-spec.ts` stale part (AS-50 is covered in T027).

- [X] T045 [US6] Add failing stale scenarios to `E/flags-audit.e2e-spec.ts`: AS-48 (A–E on the frozen day → exactly A and B), AS-49 (`it.each` 0, 31, abc → 400; 30 accepted; default 14).
- [X] T046 [US6] Implement `stale` in `flag-query.service.ts` (one SQL read for non-archived candidates, ≤ 30 Redis day reads, `createdAt < now - N days` via `Clock`, `reason: expired|unused`) and `GET /admin/flags/stale` declared **before** `/:key` (R-21, G16); make T045 pass.

## Phase 9: US7 — Route gate (P2) — AS-51…AS-52

**Goal**: a route stays invisible until its flag is on. **Independent test**: `flags-gate.e2e-spec.ts`.

- [X] T047 [US7] Write failing `E/flags-gate.e2e-spec.ts` (`RequireFlag route gate (S38)`): AS-51 (off → 404 body identical to an undefined route minus `instance`/`requestId`; on → handler runs; unknown/archived/disabled/killed → 404; kill → 404 within 1 s), AS-52 (shop allowlist: shop C → 404).
- [X] T048 [US7] Rewrite `E/api/flags.guard.ts` (`RequireFlag`) to use `FlagsClient` from `application/` and `request-context.ts`, answering exactly the undefined-route problem body (R-16); make T047 pass.

## Phase 10: US8 — Admin security and operations (P2) — AS-53…AS-58

**Goal**: only admins change flags; the capability is safe to operate. **Independent test**: `flags-admin.e2e-spec.ts` security cases, static gates.

- [X] T049 [US8] Add failing cases to `E/flags-admin.e2e-spec.ts`: AS-53 (`it.each` over every admin route → 401), AS-54 (`it.each` role × route → 403, identical bodies for existing and unknown keys, no rows changed), AS-55 (31st write → 429 `Retry-After`, reads not counted), AS-56 (130 flags → 50/50/30, `status` filter, `includeArchived`, limit bounds, get and 404); fix any gap in controllers/policies.
- [X] T050 [US8] Add the AS-58 captured admin log line assertion (fields only, no bodies) to `E/flags-admin.e2e-spec.ts`; fix gaps in T014/T023.
- [X] T051 [US8] Realtime follow-up (S51): keep exactly one `TopicRegistry.define` for `flags` in `E/api/realtime-topics.ts` (policy `SERVICE`, keep the `RealtimeTopicPrefixes` augmentation); add an assertion in `E/flags-sdk.e2e-spec.ts` that a viewer without `SERVICE` is refused and a duplicate definition throws `DuplicateTopicRouteError`; confirm `apps/sse-gateway/src/sse-gateway.module.ts:101` imports the module once.
- [X] T052 [US8] Update the `E/index.ts` barrel (X.4, G22, G23, D-8): export `FlagsSdkModule`, `FlagsAdminModule`, `FlagTopicsModule`, `FlagsClient`, `RequireFlag`, `EvalContext`, `FlagValue`, `Evaluation`, `bucketOf`, `flagChangedEventSchema`; no repository, model, query helper or infrastructure class; leave S39's `PurchaseEventsProjector` line alone; adjust `apps/core/src/core.module.ts:138-139`, `apps/worker/src/worker.module.ts:70` and `apps/sse-gateway` imports only if needed.
- [X] T053 [P] [US8] Update only the `booleanFlag` payload helper in `packages/web/lib/api/admin.ts`: send `expectedVersion`, read `status` (G24); screens remain W06's.
- [X] T054 [US8] Static gates (AS-57): `pnpm tsc --noEmit`, `pnpm lint` (backend and contracts), `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:model-registry`, `pnpm check:table-ownership --strict` (no `experimentation` line); confirm `.tx.baseline` goes 2 → 0 and no `// S54 T037 audit` remains in the domain.

## Phase 11: Polish and cross-cutting

- [X] T055 Delete `E/flags.e2e-spec.ts` only after every scenario in it is covered by the six new files (L-017); confirm all 58 `AS-nn` ids appear in `it` titles or unit tables as test-plan.md says.
- [X] T056 [P] Add the capacity scripts to `packages/backend/package.json`: `bench:flag-evaluator` (Node microbenchmark over a 500-flag ruleset) and `loadtest:client-flags`; keep SC-001 and SC-008 under "Ops artifacts" in `specs/domains/S38-feature-flags/quickstart.md` and as rows (status `not run`) in `specs/UNVERIFIED.md`; never mark them verified.
- [X] T057 Gaps coverage pass: append a table to `specs/domains/S38-feature-flags/research.md` mapping each of G1–G24 and B1–B8 to the task that closed it; `gaps.md` "Sibling-spec follow-ups" (W06, S39, S48, S03, S18/S10/S11/S20/S36, S51) stays as written and "Spec changes: None" stays true.
- [X] T058 Final run: each of the six e2e files in its own process, then the `domain` unit specs, then `python3 scripts/livespec/check.py`; run the quickstart manual smoke on a fresh stack (`scripts/qa/fresh-run.sh`, L-012) or record it `blocked` if the sandbox denies it; report outcomes faithfully.

## Dependencies and order

- Phase 1 → Phase 2 → stories. T001 before any code task. T006/T007 before any e2e. T004 before every schema-parsing test.
- US1 (T016–T025) is the MVP and unblocks the rest (shared `FlagCommandService`, repository, controller). T019 stays red until US2 T034.
- US2: publisher (T031) → source/counters (T032) → repair (T033) → client (T034). US3 depends on T023. US4 depends on T034 and T040. US5/US6 depend on US1. US7 depends on T034 and T040. US8 depends on all controllers.
- Parallel: T003–T005, T008–T015; T016–T020; T026–T029; T039/T040; T053/T056.

## Implementation strategy

MVP = Phases 1–3 (US1): contracts, migration, repository, `save`, admin PUT. Then US2 (SDK), US3 (kill), US4 (client), then the P2 stories. Run the narrowest test per task and the full capability suite once at T058. After 5 failed fixes of the same test, stop and write the blocker into `questions.md`.
