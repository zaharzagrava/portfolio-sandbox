# Research: S38 Feature flags — decisions

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted as written. Items marked **verify** are facts about the platform that the first task of the named work package checks against the code before relying on them.

## Decisions

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| R-1 | Ruleset version = single-row table `FlagRuleset(id=1, version BIGINT)`, locked `FOR UPDATE` first in every write, incremented only for an applied change, returned to the caller | Strictly increasing, survives a cache flush (AS-28), same transaction as the change (FR-031); one global lock order (ruleset row, then flag row) means no deadlock; serialising 30 writes/min is free; also makes the 500-flag cap exact (III.6) | Redis `INCR` (today: resets on flush); Postgres sequence (gaps are fine but a rolled-back change would burn a number and the cap still needs a lock); `max(flag.version)` (not monotonic across archive) |
| R-2 | Status column `status` (`enabled|disabled|killed|archived`) replaces `enabled`; `enabled` stays readable (generated in the response, kept in the table until a contract migration) | Kill must be distinguishable (FR-012); expand/contract (III.11); backfill `true→enabled`, `false→disabled`, never `killed` | Dropping `enabled` now (running code reads it during deploy) |
| R-3 | Lifecycle as a pure state machine in `domain/flag-lifecycle.ts`: `decide(current, command, now) → {kind:'noop'} \| {kind:'apply', next, action} \| {kind:'reject', error}`; switch ends in `assertNever` (III.7). The repository applies it as `UPDATE … WHERE key=:k AND version=:v` and asserts one row | Table-driven unit coverage of every transition, and the e2e files only prove wiring | Logic in the service (hard to table-test); trigger in SQL |
| R-4 | No-op detection = deep equality of the normalised definition (variants, rules, ids, defaults, `bucketBy`, `clientSide`, `owner`, `description`, `expiresAt`, desired `enabled` vs status) after the version check; a stale `expectedVersion` with an equal definition is also a no-op `200` (AS-04) | Safe replay of a lost response without an idempotency key (V.6 does not apply) | `If-Match`/ETag (same effect, more surface) |
| R-5 | `PUT` order of checks: shape (pipe) → size (413 guard, before parse) → semantic validation (422, all errors) → locks → archived (409) → unknown/`expectedVersion` rules (404/409) → killed+enabled (409) → no-op → limit (422) → apply | Each AS has one unambiguous answer; validation errors never leak existence | Version check before validation (would let a stale body hide its own errors) |
| R-6 | Semantic validation is pure in `domain/flag-validation.ts` returning `[{path, code}]`; shape validation is a zod schema (`flagInputSchema`, strict) in `contracts` applied by the global pipe → `400 validation_failed` | Contracts are the single type source (V.2); unit table proves every code (AS-10, AS-11) | class-validator DTO (today, cannot express nested limits) |
| R-7 | Publication: after commit, `RulesetPublisher.publish(version)` builds the snapshot **from the database** (not from the writer's memory), Lua `SET key snapshot EX 3600` only if newer, then pushes the version on the `flags` channel; the whole call is bounded by 500 ms (`Promise.race` + client command timeout) and caught | AS-25 (write ≤ 1.5 s), AS-28; a snapshot built from the database is correct even for racing publishers | Publish inside the transaction (III.3); fire-and-forget without counting |
| R-8 | Repair = `RulesetRepairService.run()` every 30 s: read `FlagRuleset.version`, compare with the cache snapshot version (parse only the `version` field with the schema), republish if missing/older. Single run via `pg_try_advisory_xact_lock` (VIII.6) in `apps/worker`. **verify**: S49 cron granularity is a minute; if the scheduler cannot do 30 s, the worker module owns a `setInterval` (unref'd) that calls the same advisory-locked method, and AS-26 calls the method directly | Heals a lost publish or a flush without admin action (FR-033) | Only SDK polling (does not refill the cache; every SDK would hit the database) |
| R-9 | SDK refresh = `RulesetSource.read()`: cache with 500 ms timeout, database with 2 s timeout, returns `{version, flags}` parsed with `flagRulesetSnapshotSchema`; the client applies only `version > current`, counts ignored (`flags_ruleset_ignored_total`) and rejected (`flags_ruleset_rejected_total`), logs one warning without the payload; a cache error falls through to the database **at run time too** (G9) | AS-22…AS-27 | Cache-only polling (today); trusting `JSON.parse` |
| R-10 | Push subscription uses the shared realtime subscription of `@app/infrastructure/realtime` (**verify**: `RealtimeSubscriptions.subscribe(topic, handler)` or `TopicSubscriber`; if neither fits a service-side subscriber, wrap `RedisPubSubService` from `@app/infrastructure/redis-pubsub`), so the SDK holds no `ioredis` of its own (B6) | One connection pool, one shutdown path | Own `new Redis()` (today) |
| R-11 | Cold start: `onModuleInit` never throws and never awaits more than one refresh attempt bounded by the timeouts; if no store answers, `ready=false` and a 5 s retry timer (unref'd) runs until a ruleset loads; probes are untouched | AS-20, VIII.3 | Failing boot (today) |
| R-12 | Evaluation counters: `Map<key,count>`; on flush take a snapshot `{key:n}`, subtract only what was flushed after `exec` succeeded, keep the rest; day comes from `Clock` (UTC); `shutdown` flushes first; timers `unref` | AS-29, G11 | `counts.clear()` before exec (today) |
| R-13 | `bucketOf(salt, unit) = murmur3_x86_32(salt + ":" + unit, seed 0) % 10000` lives in `domain/bucket.ts` (moved from the evaluator, algorithm unchanged), exported through the barrel | P0811, FR-024; vectors `""→0`, `"hello"→613153351`, pangram `→0x2e4ff723` test the raw hash, so the spec keeps those and a second table pins `bucketOf` values | Re-implementing in S39 |
| R-14 | Request context in `api/request-context.ts` (pure): `userId/role/email_domain` from `req.user`; `shopId` only from the verified shop; anonymous id regex `^[A-Za-z0-9_-]{8,64}$`; platform enum; `country` from the configured edge header only when the edge credential header equals `flags_edge_secret` (constant-time compare). **verify**: whether `share_link_edge_secret` / a general edge credential already exists in `ApiConfigService`; if S37's secret is for the link edge only, add `flags_edge_secret` (optional, no default; absent ⇒ country never trusted) | IV.7, FR-041…FR-044 | Trusting `cf-ipcountry` (today) |
| R-15 | Verified shop for the public endpoint: `GET /flags` is anonymous-capable, so `req.shopId` is set only when the principal is present **and** `X-Shop-Id` passes S03's membership check (**verify** which guard/interceptor in `tenancy` exposes this without making the route 401/403; if only a guard exists, a small `OptionalShopContext` application call through the tenancy entry point is used, and a missing export is a sibling follow-up, not a deep import) | questions.md CONTRACT default | Reading `X-Shop-Id` directly (spoofable, AS-39) |
| R-16 | Gate `404`: throw the same error class the global filter produces for an undefined route (reuse `NotFoundException` only if the filter renders it with the identical `type/title/status/detail`; **verify** by comparing the two bodies in GAT; otherwise a `RouteNotFoundError` from `common` that the filter already maps) | FR-045, AS-51: an assertion compares both bodies minus `instance`/`requestId` | Default Nest body (today) |
| R-17 | Error codes are `FlagError(code, status, extras)` thrown from `application/`, rendered by the global filter (`type` = code). Codes: `validation_failed` (400), `flag_not_found` (404), `version_conflict` (409, `currentVersion`), `flag_killed`, `flag_archived`, `invalid_transition` (409, `currentStatus`), `flag_definition_invalid` (422, `errors`), `flag_limit_reached` (422), `invalid_cursor` (400), `payload_too_large` (413) | FR-062, G18 | `HttpException` in the application layer (today) |
| R-18 | 256 KiB body: `BodySizeGuard`-free approach preferred: register nothing above the default (1 MiB) and check `Content-Length` and the parsed raw size in an interceptor-free guard on the admin `PUT` that answers 413 before validation. **verify** that a guard runs before the body parser's result is used and that chunked bodies are still bounded by the 1 MiB parser; AS-09 sends 300 KiB | AS-09 | Lowering the global limit (affects every route) |
| R-19 | Pagination: `flagPageSchema`/`flagAuditPageSchema` `{items, nextCursor}`; cursor = base64url JSON `{k}` (flags by `key`) or `{at,id}` (history by `at desc, id desc`) signed with the same HMAC helper the platform uses elsewhere (**verify** the helper S37 uses for its list cursor in `domain/list-cursor.ts`; reuse the pattern, not the file) so a forged cursor is `400 invalid_cursor`; fetch `limit+1` rows | III.10, AS-44, AS-56 | Offset; raw cursor |
| R-20 | Audit rows store `before`/`after` as the `flagSchema` response shape (not raw rows), `requestId` from CLS, `actorId NOT NULL`; no update/delete code path exists (no repository method for them; the model is declared with `updatedAt:false` and the repository exposes only `append`) | FR-050, G15 | DB trigger blocking updates (cross-domain-safe but not required; may be added as a follow-up hardening, not in scope) |
| R-21 | Stale report: one SQL read for candidate flags (`status <> 'archived'`), one Redis `HMGET`-style read per day (≤ 30 pipeline commands) bounded by `days ≤ 30`; "older than N days" means `createdAt < now - N days` using `Clock` | AS-48, G16 | `Date.now()` in the service |
| R-22 | Metrics (names exact per AS-58) go through the platform registry; the `flag` label is only added for `flags_evaluations_total`, bounded by the 500-flag cap, and unknown keys are labelled `unknown` (an attacker-chosen key never becomes a label) | FR-064, cardinality | Label with the raw key |
| R-23 | `flag_changed` is a standard-topic event defined with `defineEvent` and appended with `OutboxService.append` in the transaction; keyed by `flagKey`; payload has no definition; no `groupId` (L-001) | FR-052 | Direct publish after commit (dual write) |
| R-24 | Admin write log line is emitted once by `FlagCommandService` after commit with `{requestId, actorId, flagKey, action, flagVersion}` only | AS-58 | Interceptor logging bodies |
| R-25 | Migration is expand-only and idempotent (`IF NOT EXISTS`), `SET LOCAL lock_timeout`, sections: add `status`/`createdAt`/`requestId`, backfill, create `FlagRuleset` seeded from `max(version)` (≥ 1), backfill `actorId IS NULL` with the all-zero system actor, then `SET NOT NULL`, check on `bucketBy`, partial index `WHERE status <> 'archived'`. `enabled` is kept | G2, G15, III.11 | One-step column swap |

## Gap traceability

| Gap | Where it is handled |
|---|---|
| G1, G3, G7, G10 | R-3, R-4, R-5, R-17; `FlagCommandService`, evaluator |
| G2 | R-2, R-3 |
| G4, G5 | R-5, R-6, R-18 |
| G6, G15, G18 | R-17, R-19, R-20; explicit mappers, `FlagError` |
| G8 | R-1, R-7, R-8 |
| G9 | R-9, R-10, R-11 |
| G11, G16 | R-12, R-21 |
| G12, G13, G14 | R-14, R-15, R-16; `ClientFlagsService`, controller headers |
| G17 | policies `flags.admin.write` (30/min/admin), `flags.client.read` (120/min) |
| G19 | R-22, R-24 |
| G20, G21 | six e2e files + three unit specs replace `flags.e2e-spec.ts` and extend `evaluator.spec.ts` |
| G22, G23 | R-13, barrel |
| G24 | `packages/web/lib/api/admin.ts`: `booleanFlag` carries `expectedVersion`, reads `status`; screens are W06 |
| B1–B6, B8 | ports in `domain/ports.ts`, models/adapters in `infra/`, `FlagsClient` in `application/`, `ClientFlagsService` |
| B4 | R-23 |
| B7 | verify `AuthModule`/`Firewall`/`User`/`Role` are exported by identity's barrel (they are imported today without a deep path); no change expected |
| D-6, D-8 | B1/B2, barrel; D-15: no change |

## Verified (T002, checked against the code on 2026-10-14)

- **R-8** The jobs scheduler's cron takes a seconds field (`libs/infrastructure/jobs/cron.ts`, `schedule-validation.ts`), so `*/30 * * * * *` is valid and `FlagsJobs` registers it with `overlap: 'skip'` and a fleet concurrency of 1; AS-26 calls `RulesetRepairService.run()` directly.
- **R-10** `TopicSubscriber.subscribe(topic, handler)` (`@app/infrastructure/realtime`) is the in-process subscriber over the shared hub; the SDK uses it and holds no `ioredis` of its own. `RealtimePublisher.publish(..., {replay: false})` is the plain `PUBLISH` the publisher adapter uses.
- **R-14** `share_link_edge_secret` belongs to the link edge; flags add their own optional `flags_edge_secret` (`libs/common/config/flags-config.ts`, at least 32 bytes when set, no default) and read the credential from `x-edge-credential`, the country from `cf-ipcountry`.
- **R-15** Tenancy's barrel exports `ShopAccessService.getRole(shopId, userId)` (a membership check) and `ShopGuard` sets `req.shopId` for `@ShopScoped` routes; `EvalContextService` uses `req.shopId` when present and otherwise the membership check on `X-Shop-Id`. No sibling export was needed.
- **R-16** The platform answers an undefined route with `404` code `not_found`, detail `Cannot <METHOD> <url>`; `FlagGuard` throws `NotFoundException` with that same detail, and AS-51 compares the two bodies with the URL normalised.
- **R-18** The platform parser bounds every body at 1 MiB and keeps `req.rawBody`; guards run before pipes, so `BodySizeGuard` answers `413 payload_too_large` for more than 256 KiB (declared or received) before validation; AS-09 sends 300 KiB.
- **R-19** S37's `domain/list-cursor.ts` and S36's `ads-cursor.ts` sign `base64url(JSON).hmac` with a subkey of a configured secret; `flag-cursor.ts` follows it with `jwt_secret`, a scope label and typed fields.
- **B7** `AuthModule`, `Firewall`, `User`, `UserRawDto` and `Role` are exported by `@app/domains/identity`; the new controllers import nothing deeper.

## Gap closure (T057)

| Gap | Closed by | Proven by |
|---|---|---|
| G1, G3, G7, G10 | T021, T023, T030 (`flag-lifecycle.ts`, `flag-command.service.ts`, `evaluator.ts`) | `flag-lifecycle.spec.ts`, `flags-admin` AS-04…AS-08 |
| G2 | T006, T021 | `flag-lifecycle.spec.ts`, `flags-lifecycle` AS-30…AS-36 |
| G4, G5 | T016, T021, T024 | `flag-validation.spec.ts`, `flags-admin` AS-09…AS-12 |
| G6, G15, G18 | T009, T012, T022, T044 | `flags-audit` AS-43…AS-47, `flags-admin` AS-56 |
| G8 | T031, T033 | `flags-sdk` AS-25, AS-26, AS-28 |
| G9 | T032, T034 | `flags-sdk` AS-18…AS-20, AS-27 |
| G11, G16 | T032, T034, T046 | `flags-sdk` AS-29, `flags-audit` AS-48, AS-49 |
| G12, G13, G14 | T040, T041 | `flags-client` AS-37…AS-42 |
| G17 | T015, T024, T038 | `flags-admin` AS-55, `flags-client` AS-42 |
| G19 | T014, T023 | `flags-sdk` AS-58, `flags-admin` AS-58 |
| G20, G21 | T018…T020, T026…T029, T036, T039, T043, T045, T047 | the six e2e files and the unit specs |
| G22, G23 | T008, T052 | `bucket.spec.ts`, wiring specs |
| G24 | T053 | `packages/web/lib/api/admin.ts` (payload helper and page read) |
| B1, B2, B3, B5, B8 | T010, T011, T022, T023, T041 | `check:boundaries`, `check:model-registry`, `check:table-ownership --strict` |
| B4 | T013, T023 | `flags-audit` AS-47 |
| B6 | T034 | `flags-sdk` AS-21 (shared hub subscription) |
| B7 | T002 | verified above |
