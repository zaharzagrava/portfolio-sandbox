# Tasks: S37 — Share and affiliate short links (domain `marketing`)

**Input**: `plan.md`, `spec.md` (US1–US7, AS-01–AS-66, FR, SC), `test-plan.md`, `gaps.md` (G1–G25, L1–L7, D-6/D-7/D-8/D-12), `data-model.md`, `contracts/`, `research.md`, `quickstart.md`, `questions.md` (defaults accepted).

**Tests**: required (test-plan.md). Within every story the failing test task comes before the code task. A scenario (AS-nn) must stay proven somewhere even if a test file is renamed or merged (L-017).

## Conventions

- `M` = `packages/backend/libs/domains/marketing`. `C` = `packages/contracts/src/marketing`. Backend commands run from `packages/backend`.
- Run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; narrowest test first; whole capability suite once at the end, in batches of fresh processes (L-008). A test that cannot fail is a defect (L-003): no "A or B" assertions. Each e2e creates its own data (L-005, L-006).
- No new `sequelize.transaction` (share links own no SQL table; `.tx.baseline` stays 0). Never use git checkout/restore/reset/stash/clean; never create or edit `*.reviewed.json`.
- Format: `- [ ] Tnnn [P] [USn] description with path`. `[P]` = different files, no dependency on an unfinished task.
- Stories: US1 create (AS-01–16), US2 alias (AS-17–23), US3 redirect (AS-24–37), US4 clicks + attribution (AS-38–47), US5 manage (AS-48–56), US6 stats (AS-57–61), US7 operate (AS-62–65). AS-66 is W02's (not owned here).

## Phase 1: Setup

- [X] T001 Read the existing code once before editing: `M/application/share-link.service.ts`, `M/api/share-links.controller.ts`, `M/infra/id-lease.ts`, `M/infra/link-clicks.projector.ts`, `M/domain/codes.ts`, `M/share-links.module.ts`, `M/index.ts`, `M/share-links.e2e-spec.ts`; note the import paths of the S54 clock (`@app/common/core/clock`), `@Idempotent`, `defineEvent`, projections, `declareJobType`/`upsertSchedule`, `definePolicies`.
- [X] T002 [P] Create `M/testing/share-links.fixtures.ts`: frozen/advanceable `Clock`, fault-injecting wrappers (fail / hang / delay) for link store, counter, filter, publisher and stats reader, fake reputation port, fake edge origin and sink, helper to boot the real feature modules with the production pipe, problem+json filter, prefix and interceptors, token helper for users U1/U2, per-test data creation (L-005, L-006).
- [X] T003 [P] Create compilable scaffolding `M/share-links-worker.module.ts`, `M/share-links-projector.module.ts`, `M/rate-limit-policies.ts` (no behaviour yet) so later tasks can import them.

## Phase 2: Foundational (blocks every story)

### Contracts, config, stores

- [X] T004 [P] Write `packages/contracts/src/marketing/share-links.ts` (G23): `createShortLinkRequestSchema`, `updateShortLinkRequestSchema` (destination only, strict), `shortLinkSchema` (`code, shortUrl, destination, status, kind, createdAt, updatedAt, expiresAt`; no `ownerId`, no `expiresAtEpoch`), `shortLinkPageSchema` (`{items,nextCursor}`), `linkStatsSchema` (`{code, range, from, to, bucket, total, series, countries}`, numeric counts), `linkClickedEventSchema` (`version 1`, `occurredAt`, origin-only referer, validated country, time-ordered `clickId`), problem code list; export from the contracts index. Constraints verbatim from `data-model.md` (destination ≤ 2,048; alias 4–32 chars `[a-z0-9]` with single dashes, no leading/trailing dash) and the expiry range in `spec.md`.
- [X] T005 [P] Config (G5, G21, AS-62): add required keys `share_link_code_key` (≥ 32 bytes, distinct from `jwt_secret` and the S36 ad click secret), `share_link_base_url` (absolute https, no fallback to `backend_host/api/l`), `share_link_edge_secret` (≥ 32 bytes, distinct), `share_link_max_per_owner` (default 1,000), `share_link_reserved_aliases`; `front_host` must be an absolute `https` origin without path; edit `libs/common/config/{types,api-config.service}.ts`, the joi schema and config-rules; remove every fallback to `jwt_secret`; update the test config mock. Each failure names the key.
- [X] T006 [P] `packages/backend/dynamodb/Links.json` (G11, L7): TTL attribute `purgeAtEpoch`, `sk` attribute and `byOwnerV2` index (`ownerId` HASH, `sk` RANGE, projection ALL), `_design.owner: "marketing (S37)"` and the access-pattern list; keep `byOwner`; expand-only for deployed tables. Owner note in the header of `packages/backend/clickhouse/020_link_clicks.sql` (L7); document Redis prefixes `share-links:*` / `link:v1:*` as owned by `marketing`.
- [X] T007 [P] Rate-limit policy (G8, S50 follow-up): in `M/rate-limit-policies.ts` declare `share-link.create` (20/min/user, closed) with `definePolicies('marketing', …)`; register it from `ShareLinksModule`; `discussion.write` stays with S25.
- [X] T008 Boot the real `apps/core` once after T004–T007 to confirm config and policy registration start (L-015, L-004).

### Pure domain logic (unit specs first)

- [X] T009 [P] Write failing `M/domain/destination-policy.spec.ts` (AS-03, AS-04, AS-25, SC-005): `it.each` of 13 refused variants (http, off-site host, `@` trick, user-info, backslash, port, trailing dot, look-alikes, scheme-relative, …) and 2 accepted (upper-case host lowered, IDNA), `ref` removal keeping parameter order, encoding and fragment, URL assembly with/without query and fragment (fragment last).
- [X] T010 [P] Write failing `M/domain/alias-rules.spec.ts` (AS-18, AS-19): valid/invalid table (length 4–32, upper case, dashes, characters) and reserved-word matching (`admin`, `login`, `status`, configured list).
- [X] T011 [P] Write failing `M/domain/click-meta.spec.ts` (AS-39): country (`XX`, `T1`, lower case, bad values → `""`) and referer-to-origin tables.
- [X] T012 [P] Write failing `M/domain/link-state.spec.ts` (AS-28, AS-53, AS-65): `now >= expiresAt` boundary table, state × action transition table, injected-clock cases.
- [X] T013 [P] Extend `M/domain/codes.spec.ts` (AS-05, G22): 7 chars, alphabet, 10,000 distinct, reversible, non-adjacent, key-dependent, range edges, out-of-range → typed error; `fast-check` properties (bijection, range, non-adjacency; fixed seed).
- [X] T014 [P] Implement `M/domain/destination-policy.ts` (G6): pure; checks against the configured `front_host` origin, IDNA normalisation, strips `ref`, assembles the URL with `ref=<code>` before the fragment; typed errors.
- [X] T015 [P] Implement `M/domain/alias-rules.ts` (G3) and `M/domain/click-meta.ts` (G15).
- [X] T016 [P] Implement `M/domain/link-state.ts` (G11, G20): ACTIVE/DISABLED/derived EXPIRED, transition table, `now >= expiresAt`; and `M/domain/link-errors.ts` (`DomainError(code, status)` for each problem code in `contracts/share-links-api.md`, G24).
- [X] T017 Update `M/domain/codes.ts` (G22): typed range error instead of `RangeError`; maths unchanged. Make `check:no-wallclock` / lint cover `M/domain/` (no `Date`, `Date.now()`; L5, AS-65).
- [X] T018 Move the `LinkClicked` contract to `M/domain/link-events.ts` using `defineEvent` + `linkClickedEventSchema` (L2, topic `links.events`); add `M/domain/link-metrics.ts` declaring the `link_*` metrics (G21).
- [X] T019 Run `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/domain` until U1–U5 are green. (The e2e runner only picks up `*.e2e-spec.ts`; the unit specs ran with `pnpm test -- libs/domains/marketing`, 159 passed with the config specs.)

### Ports and adapters (L1, L6, D-6)

- [X] T020 Create `M/domain/ports.ts` with tokens: `LinkRepository`, `CodeSequence`, `ExistenceFilter`, `ClickPublisher`, `ClickStatsReader`, `DestinationReputation`, `LinkCache` (Clock from `@app/common/core/clock`).
- [X] T021 Implement `M/infra/dynamo-link.repository.ts` (G7, G11, G19, G20): conditional `PutItem` `attribute_not_exists(code)`; create with owner counter (`TransactWriteItems`, `activeCount < limit`, item `#owner#<ownerId>`); conditional `UpdateItem` on `status = ACTIVE` for patch/disable; `purgeAtEpoch` = (`expiresAt` or `disabledAt`) + 13 months; `byOwnerV2` keyset query; `batchGet` ≤ 100; lookup by `(owner, code)`; timeouts 500 ms (redirect) / 1,000 ms (writes); legacy-row reads (`expiresAtEpoch`, missing `status`/`kind`).
- [X] T022 [P] Move `M/infra/id-lease.ts` → `M/infra/redis-code-sequence.ts` implementing `CodeSequence` (G22): lease logic unchanged, counter-loss / key-change detection, owner note on `share-links:id-seq`.
- [X] T023 [P] Implement `M/infra/redis-existence.filter.ts` (G9): bloom + `ready` marker (bypass unless the marker exists), rebuild lock, add-before-write, 150 ms timeout.
- [X] T024 [P] Implement `M/infra/redis-link.cache.ts` (G10): `CacheService` wrapper (miss 60 s, stale 24 h, single flight), errors never cached, every key with a TTL.
- [X] T025 [P] Implement `M/infra/kafka-click.publisher.ts` (G15: bounded retry ≤ 2 off-path, in-flight set, 5 s drain, failure metric once + structured warning without visitor data), `M/infra/clickhouse-click-stats.reader.ts` (exact `uniqExact(click_id)`, ranges 24h/7d/30d) and `M/infra/allow-all-reputation.adapter.ts` (2 s timeout, fail closed).
- [X] T026 Wire `M/share-links.module.ts` with explicit imports and providers for all tokens (L6); real `apps/core` must still start (L-015).

**Checkpoint**: contracts, config, ports and adapters compile; unit specs green; `apps/core` boots.

## Phase 3: US1 — Create a short link (P1) 🎯 MVP

**Goal**: a signed-in user turns a marketplace page into a short link, safely and exactly once. **Independent test**: `share-links-create.e2e-spec.ts` AS-01–AS-16.

- [X] T027 [US1] Write failing `M/share-links-create.e2e-spec.ts` (`describe('Share links: creation, codes and aliases')`) for AS-01–AS-16: happy path (`201`, `Location`, body parses `shortLinkSchema`, no owner field, one row, metric `kind=generated`); validation classes incl. missing/out-of-range `Idempotency-Key` → `400 validation_failed`, nothing stored; three destination refusals → `422 destination_not_allowed`; stored destination stripped of `ref`; 1,000 concurrent creates over 3 instances → distinct codes; lease (2,500 numbers → 3 counter calls, stopped instance's block never reissued, 5 concurrent demands → 1 call); planted collision → `201` with another code + metric; 5 collisions → `503 code_generation_failed`, no write; forced counter/filter/store failure → `503` and retry `201`; replay (`Idempotency-Replayed`), other user same key, key after 24 h; `Promise.all` of two → `201`+`409`, different body → `422 idempotency_key_reuse`; expiry (`T+30d`, `3650`, omitted `null`); per-owner limit (limit 5; racing at 999) and disable frees a place; rate limit 21st → `429` + `Retry-After`, budgets independent, limiter down → create `503` and redirect unaffected; reputation block / timeout / allow; `401` on all five authenticated routes with the public redirect still served; one 4xx and one forced 5xx parse the problem schema with `requestId` and no stack.
- [X] T028 [US1] Add `M/api/idempotency-header.guard.ts` (G1): `Idempotency-Key` 8–128 chars else `400 validation_failed` before the platform interceptor (plan risk (a)).
- [X] T029 [US1] Implement `M/application/share-link-command.service.ts` create (G1–G4, G6–G9, G24): policy → reputation → per-owner limit → code from `CodeSequence` → filter entry first → conditional put; generated collision retries ≤ 5 with a new number + collision metric, then `503 code_generation_failed`; dependency failure → `503 service_unavailable`; injected `Clock`; coded errors.
- [X] T030 [US1] Rewrite `POST /links` in `M/api/share-links.controller.ts` (G1, G2, G8, G23, G24): zod schemas from contracts at the pipe, `@Idempotent` (24 h), `@RateLimit('share-link.create')`, response DTO without `ownerId`/`expiresAtEpoch`, `201` + `Location`, `@Firewall()`; thin.
- [X] T031 [US1] Run `test-spec.sh libs/domains/marketing/share-links-create.e2e-spec.ts` until green (AS-01–AS-16). (54 passed with the alias scenarios.)

## Phase 4: US2 — Custom alias (P1)

**Goal**: claim a lower-case alias exactly once; never reuse. **Independent test**: AS-17–AS-23.

- [X] T032 [US2] Add failing cases to `M/share-links-create.e2e-spec.ts` for AS-17–AS-22: alias `201` `kind: custom` then redirect `302`; one valid and one invalid alias (`201`/`400`); `admin`, `login`, `status` → `422 alias_reserved`, nothing stored; `409 alias_taken` with original unchanged and same-owner reclaim `409`; ten `Promise.all` claims → one `201`, nine `409`, one row, redirect to the winner; expired and disabled aliases `409`, and after advancing the clock past 13 months and purging, the claim succeeds.
- [X] T033 [US2] Create `M/share-links-redirect.e2e-spec.ts` (`describe('Share links: redirect, caching and degradation')`) with failing AS-23: `404` first, claim, immediate `302` (no remembered miss).
- [X] T034 [US2] Implement the alias path in `M/application/share-link-command.service.ts` (G3): format and reserved checks before any code is computed, claim by conditional put (`409 alias_taken`, never a retry), invalidate the remembered miss on claim; wire the DTO.
- [X] T035 [US2] Run create and AS-23 tests until green.

## Phase 5: US3 — Visitor follows a link (P1)

**Goal**: redirects never lie, are fast, and degrade safely. **Independent test**: `share-links-redirect.e2e-spec.ts` AS-23–AS-37.

- [X] T036 [US3] Add failing cases to `M/share-links-redirect.e2e-spec.ts` for AS-24–AS-37: `302` with `ref`, exact `Cache-Control: public, max-age=0, s-maxage=10`, no `Set-Cookie`, empty body, one event after the response; fragment last; unknown → `404` `no-store`, no event, store read count 0, filter-reject metric; each malformed code → identical `404` with no read; `T+9 s` `302` / `T+10 s` `410` with `s-maxage=60`, no event; disabled → `410` identical body; `HEAD` same status/headers without event, `POST/PUT/PATCH/DELETE` → `405`; remembered miss (100 requests → one store read, one more after 60 s); 500 concurrent cold requests → one store read; filter lost → bypass `302` counted, rebuild restores marker, two concurrent rebuilds → one runs, interrupted rebuild stays bypassed; store outage warm → stale `302`, cold + timeout → `503` + `Retry-After` with no remembered miss, recovery `302`; destination now disallowed → `410` + rejection metric, no event; publish refused → `302`, one failure metric, one warning without visitor data; publish hangs → latency unchanged; shutdown with in-flight publishes → finish within 5 s then pools close, new requests refused.
- [X] T037 [US3] Implement `M/application/redirect.service.ts` `resolveRedirect(code, meta)` returning `redirect | not_found | gone | unavailable` (G9–G12, L4, L5): format → filter (bypass unless ready) → cache-aside → store (500 ms) → state + destination re-check (`410`, rejection metric) → click publish off the request path; injected `Clock`.
- [X] T038 [US3] Rewrite `GET|HEAD /l/:code` in `M/api/share-links.controller.ts`: one call, map the union to status and headers (G13 `Cache-Control`, `no-store` on `404`, `Retry-After` on `503`, `410` problem), `@Firewall({anonymous:true})`, HEAD records nothing, other methods `405`; no domain logic in the controller.
- [X] T039 [US3] Implement `M/application/filter-rebuild.service.ts` and `M/infra/share-links.jobs.ts` (G9, S49 follow-up): `declareJobType('share-links.rebuild-filter', z.object({}).strict())` next to the `JobPayloads` augmentation, schedule via `upsertSchedule` catching `InvalidScheduleError` (not a generic `Error`), no `JobsService.cancel`; paged table scan, lock so concurrent rebuilds run once, ready marker set last; register in `M/share-links-worker.module.ts`.
- [X] T040 [US3] Shutdown drain in `M/infra/kafka-click.publisher.ts` (registered with the `ShutdownRegistry`, ≤ 5 s before pools close) for AS-37.
- [X] T041 [US3] Run the redirect e2e file (AS-23–AS-37) in a fresh process until green.

## Phase 6: US4 — One attributed click per followed link (P1)

**Goal**: exactly-once counting; attribution lookup for checkout. **Independent test**: `share-links-clicks.e2e-spec.ts` AS-38–AS-47; edge spec AS-41/42.

- [X] T042 [US4] Write failing `M/share-links-clicks.e2e-spec.ts` (`describe('Share links: click events and attribution')`) for AS-38, AS-40, AS-43–AS-47: event envelope/key/`eventId = clickId`/no visitor data parses `linkClickedEventSchema`; valid edge credential → `302` no event; missing/wrong credential → flag ignored, one event `viaEdge: false`; same event twice and after restart → one counted click before any merge; each invalid event dead-lettered with reason beside a valid counted one; shuffled delivery gives same stats, late event in its own minute; attribution lookup (active, expired, disabled, unknown, malformed, empty, 101 codes, one batched read); store down → `AttributionUnavailableError`.
- [X] T043 [US4] Implement the click envelope in `M/application/redirect.service.ts` (G14, G15): `version 1`, `occurredAt` from `Clock`, origin-only referer and validated country via `domain/click-meta`, time-ordered `clickId`; edge flag honoured only with `share_link_edge_secret` (constant-time compare).
- [X] T044 [US4] Rewrite `M/infra/link-clicks.projector.ts` as a validated consumer (G17): `linkClickedEventSchema` validation, dead letter with reason + metric, `idempotency: 'natural'` on `click_id`, `ts` bounds check, gauge `link_click_consumer_lag`; `M/share-links-projector.module.ts` provides it; stats read counts `uniqExact(click_id)` (change `clickhouse/020_link_clicks.sql` only if needed, no schema break).
- [X] T045 [US4] Implement `M/application/link-attribution.service.ts` `resolveAttributions(codes)` (R1): ≤ 100 codes, one `batchGet`, `{code, ownerId, status}`, `EXPIRED` stays resolvable, typed `AttributionUnavailableError`.
- [X] T046 [P] [US4] Write failing `packages/edge-be/test/short-link.spec.ts` (`describe('Edge short-link redirect')`, AS-41, AS-42): fake origin, sink and cache clock; origin `302` → one event; cache hit → second event with new `clickId`, origin not called; `404`/`410`/`5xx` → no event, no caching; sink failure → still `302`; before `t0+10 s` the old `302`, after it the origin is called.
- [X] T047 [US4] Update `packages/edge-be/src/index.ts` `shortLinkRedirect` (G16): record only on a served `302`, `uuidv7` click ID, origin-only referer, send the `SHARE_LINK_EDGE_SECRET` credential, event envelope `version 1`; add the Worker secret to the wrangler config/types.
- [X] T048 [US4] Run the clicks e2e (fresh process) and `pnpm --dir packages/edge-be test -- short-link` until green.

## Phase 7: US5 — Owner manages links (P2)

**Goal**: list, change destination, disable, safely. **Independent test**: `share-links-manage.e2e-spec.ts` AS-48–AS-56.

- [X] T049 [US5] Write failing `M/share-links-manage.e2e-spec.ts` (`describe('Share links: management and statistics')`) for AS-48–AS-56: list pages/order/isolation/insertion between pages; default and bounds, tampered or foreign cursor, empty list; `PATCH` `200` with only destination and `updatedAt` changed and next redirect new `Location`; empty body, immutable/unknown fields → `400`, policy/reputation failures → `422`, nothing changes; disable `200` `DISABLED` + `disabledAt`, redirect `410`, still listed, stats readable, limit count drops; disable/change on disabled or expired → `409 link_not_active`; `Promise.all` change+disable, two disables, two changes → final `DISABLED`; warm cache then change/disable → next request reflects it; another user's `PATCH`/disable/stats and malformed path code → identical `404`, nothing changed; `401` cases.
- [X] T050 [US5] Implement list in `M/application/share-link-query.service.ts` (G18): keyset `createdAt desc, code desc` over `byOwnerV2`, `limit` 1–100 default 20, HMAC'd cursor bound to the owner (key `share_link_code_key`, domain-separated), `status` in items.
- [X] T051 [US5] Implement change/disable in `M/application/share-link-command.service.ts` (G19, G20, FR-048, FR-083): owner in the lookup, conditional updates on `status = ACTIVE` and not expired, `updatedAt`/`disabledAt`, policy + reputation re-run on change, cache removal after the write, `409 link_not_active`, owner counter decrement on disable.
- [X] T052 [US5] Add routes `GET /links`, `PATCH /links/:code`, `POST /links/:code/disable` to `M/api/share-links.controller.ts` with contract schemas and `@Firewall()`.
- [X] T053 [US5] Run the manage e2e (AS-48–AS-56) until green.

## Phase 8: US6 — Owner sees statistics (P2)

**Goal**: exact, fresh statistics; failure isolated. **Independent test**: AS-57–AS-61 in `share-links-manage.e2e-spec.ts`.

- [X] T054 [US6] Add failing cases to `M/share-links-manage.e2e-spec.ts` for AS-57–AS-61: known clicks → body parses `linkStatsSchema`, numeric counts, ordered series, top countries; ranges `24h|7d|30d`, default, bucket sizes, inclusive `from` / exclusive after `to`, invalid range → `400`; no clicks → zeros and empty arrays, expired and disabled links readable; click published + consumer run → immediately visible, lag gauge present; stats store down → `503` on stats only while create, list, change, disable and redirect work.
- [X] T055 [US6] Implement stats in `M/application/share-link-query.service.ts` and `GET /links/:code/stats` in the controller (G19): owner-in-lookup, no cache/filter involvement, range/bucket/countries through `ClickStatsReader`, `503 service_unavailable` on analytics failure.
- [X] T056 [US6] Run the whole manage e2e file until green.

## Phase 9: US7 — Operate safely inside boundaries (P2)

**Goal**: configuration, metrics, logs, boundaries. **Independent test**: `share-links-platform.e2e-spec.ts` AS-62–AS-64.

- [X] T057 [US7] Write failing `M/share-links-platform.e2e-spec.ts` (`describe('Share links: operations and boundaries')`) for AS-62–AS-64: each bad configuration fails startup naming the key (incl. `front_host` not an https origin, secrets equal, no fallback to another secret) and a valid one starts; the metrics scrape matches the actions performed; log and label scan finds no destination, referrer, query, secret or visitor value; static checks run green and the barrel export list equals the Provides list.
- [X] T058 [US7] Wire metrics and structured logs across services (G21): create by kind, collision, filter reject/bypass, redirect outcome, publish failure, consumer lag, dead letters; no destination/referer/visitor data in labels or logs.
- [X] T059 [US7] Barrel and apps (L3, D-8): `M/index.ts` exports `ShareLinksModule`, `ShareLinksWorkerModule`, `ShareLinksProjectorModule`, `LinkAttributionService`, DTO types, `linkClickedEventSchema`; remove `LinkClicksProjector`; `apps/core/src/core.module.ts`, `apps/worker` and `apps/projector/src/projector.module.ts` import the modules.
- [X] T060 [US7] Delete `M/application/share-link.service.ts` and `M/share-links.e2e-spec.ts` once every replacement passes (G25); keep `marketing-contracts.spec.ts` for S36 and move any share-link assertions to the new schemas.
- [X] T061 [US7] Run the platform e2e until green.

## Phase 10: Polish, follow-ups and gates

- [X] T062 Confirm `gaps.md` "Sibling-spec follow-ups" has S25, S36, W02, S10, S50, S39, S54 bullets; W02 note: `SITE_URL` = `front_host` and `__Host-ref` set by `POST /api/attribution/ref` (S37 sets no cookie; AS-24 asserts no `Set-Cookie`). Do not edit sibling specs. (S53 and edge-be bullets added.)
- [X] T063 [P] Ops artifact (SC-001, SC-002, SC-004 p99, SC-006 rate): create `scripts/load-tests/share-links.test.js` (k6: Zipf redirects at the origin, edge scenario, 400 creates/s) and the `loadtest:share-links` script in `packages/backend/package.json`; confirm `quickstart.md` "Ops artifacts" and the four `specs/UNVERIFIED.md` S37 rows (status `not run`) stay accurate; never call them verified.
- [X] T064 [P] Living spec: add `docs/spec/capabilities/S37-share-links.md` with rules, behaviors and `[proof: …]`/`[code: …]` anchors for every scenario in `test-plan.md`; run `python3 scripts/livespec/check.py`; create no `*.reviewed.json`. (0 errors; style warnings on sentence length only.)
- [X] T065 Static gates (AS-64): `pnpm --dir packages/backend exec tsc --noEmit`, ESLint for backend, contracts, edge-be; `check:boundaries`, `check:module-graph`, `check:model-registry`, `check:no-wallclock`, `check:table-ownership --strict` (no share-link line); `.tx.baseline` still 0. (`tsc` clean for backend and edge-be; ESLint clean for the S37 files, one error remains in `search-config.ts` of another capability; the strict table-ownership check fails on other domains' debt, none for share links; no `sequelize.transaction` added.)
- [X] T066 Run the whole capability suite once in batches of fresh processes (L-008): unit specs, five e2e files, edge-be short-link spec; each batch must print its summary line.
- [X] T067 Fresh-stack verification (L-012, L-011, L-002): `scripts/qa/fresh-run.sh`; start the real `apps/core`, `apps/worker` (rebuild job registered) and `apps/projector` (consumer declared) (L-004, L-015); smoke: sign in, `POST /api/links` with `Idempotency-Key`, `curl -si $BASE/api/l/<code>` → `302` with `ref`, stats show the click; every table/queue/topic used exists in the test stack. **Done (2026-10-13)**: `scripts/qa/fresh-run.sh --here` passed (monolith boots, live doctor clean); the throwaway-stack variant refuses to run while the dev stack is up, so it was not run; `scripts/infra/boot-check.sh --start` started the monolith (ready); the real worker (`apps/worker/src/share-links-wiring.e2e-spec.ts`: module, job type, schedule) and the projector composition (`apps/projector/src/share-links-wiring.e2e-spec.ts`) are covered; `scripts/qa/fresh-run.sh` on a throwaway stack and the manual sign-in smoke were not run (see `gaps.md`).
- [X] T068 Final report: follow-ups handled (S49 `declareJobType`/`InvalidScheduleError`, S50 `share-link.create`, W02 `SITE_URL`/`__Host-ref`), unverified criteria, and any `questions.md` blocker.

## Gap coverage

G1 T028–T030 · G2 T030 · G3 T010,T015,T034 · G4 T029 · G5 T005 · G6 T009,T014,T037 · G7 T021,T029 · G8 T007,T030 · G9 T023,T039 · G10 T024,T037 · G11 T006,T016,T021 · G12 T037–T038 · G13 T038 · G14 T043 · G15 T011,T025,T043 · G16 T046–T047 · G17 T044 · G18 T050 · G19 T051,T055 · G20 T051 · G21 T005,T058 · G22 T013,T017,T022 · G23 T004 · G24 T016,T029 · G25 T060 · L1 T020–T026 · L2 T018 · L3 T059 · L4 T037–T038 · L5 T017,T037 · L6 T026 · L7 T006 · D-6 T020 · D-8 T059 · D-7/D-12 not applicable.

## Dependencies

Phase 1 → Phase 2 → stories. US1 → US2 (alias shares the create path) → US3 (needs created links) → US4 (needs redirect + events) → US5 → US6 (needs clicks) → US7 → Polish. T046 (edge spec) is independent of backend tasks.

## Parallel examples

- Phase 2: T004–T007; T009–T013; T014–T016; T022–T025.
- US4: T046 alongside T042.
- Polish: T063 and T064.

## Strategy

MVP = Phases 1–2 + US1 (create, exactly once, safe), validated by `share-links-create.e2e-spec.ts`. Then US2/US3 (a usable link), US4 (counting), then management, statistics and operations. Run each phase's narrowest test after it; the full suite and fresh-stack run happen once at the end. After 5 failed fixes of the same test, stop and write the blocker into `questions.md`.
