# Tasks: S44 — Embeddable storefront widget (domain `developer-platform`)

**Input**: `spec.md`, `plan.md`, `test-plan.md`, `gaps.md` (G-01…G-42, D-6/D-7/D-8/D-12), `data-model.md`, `research.md`, `contracts/`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: required (test-plan.md, 54 rows). Within each story the failing test task comes BEFORE the code task it proves.

## Conventions

- `DP` = `packages/backend/libs/domains/developer-platform`. `BE` = `packages/backend`. Backend e2e: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` from `packages/backend`; narrowest test first, whole suite once at the end in batches of fresh processes (L-008). After 5 failed fixes of one test, write the blocker into `questions.md` and stop.
- Rule 0: the living-spec page comes first; keep `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`); never create or edit `*.reviewed.json`.
- Rule 4: only `TransactionRunner.run` / `@Transactional`; never add `sequelize.transaction`; `.tx.baseline` count must not rise.
- Rule 3: never git checkout/restore/reset/stash/clean.
- Each test creates its own shop, site and products (L-005, L-006); no foreign models (`ShopModel`, `ProductModel`) in specs (D-7); assert body AND persisted state; no "A or B" asserts (L-003); fault switches restored in `afterEach` (L-013); no fixed sleeps, use `waitFor`.
- Format: `- [ ] Tnnn [P] [USn] description with path`. `[P]` = different files, no dependency on an unfinished task.

## Phase 1: Setup

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership` and record its `developer-platform` widget lines in a note at the end of `specs/domains/S44-storefront-widget/gaps.md` under "## Reconciliation"; reconcile with gaps section 3 (G-14, G-39, D-12). Also record the current `sequelize.transaction` count from `.tx.baseline`.
- [X] T002 Create the living-spec page `docs/spec/capabilities/S44-storefront-widget.md` FIRST (rules and behaviors from spec.md FR-001…FR-040, with `[proof: …]` pointing at the e2e/unit files of test-plan.md and `[code: …]` at the planned paths; state `WIDGET_APP_BUNDLE_URL` default `/widget/v1/app.js`, shop-copy staleness ≤ 60 s p99); run `python3 scripts/livespec/check.py` and fix until clean (re-run at T095).
- [X] T003 [P] Add the missing contract file `specs/domains/S44-storefront-widget/contracts/rate-limits-config.md` (plan lists it): four policies `widget.config.ip` (open), `widget.identify.ip`, `widget.identify.site`, `widget.manage.shop` (closed); config keys `widget_token_key` (startup fails without), `WIDGET_APP_BUNDLE_URL` (HTTPS absolute in production; default `/widget/v1/app.js`).
- [X] T004 [P] Create `DP/testing/widget-kit.ts`: frozen/advanceable clock, `signWidgetHandoff(secret, claims)` (test-only signer), fixtures creating own shop/user/membership/products through exported services and shared helpers, switchable faults (product lookup, single-use store, limiter store) restored in `afterEach`, `waitFor`, two-instance app builder over one Redis and one database.

## Phase 2: Foundational (blocks all stories) — A foundation

**Contracts, migration, models, ports, pure rules (G-03, G-08, G-14, G-22, G-33, G-39, G-40, D-6, D-8)**

- [X] T005 [P] Write failing unit spec `DP/domain/origin.spec.ts` (`it.each`): normalise/reject table with closed reasons (IP literals, `localhost`, single-label, bare TLD, >253 chars, port range, path/query/fragment, IDN, scheme) and matcher table (scheme, port, suffix look-alike) — AS-02, AS-15.
- [X] T006 [P] Write failing unit spec `DP/domain/theme.spec.ts`: allowlisted keys and value-format table — AS-04.
- [X] T007 [P] Write failing unit spec `DP/domain/handoff-claims.spec.ts`: claims policy with injected clock, closed reason list, `exp-iat ≤ 300`, `sub`/`jti` length limits, e-mail check — AS-24.
- [X] T008 [P] Write failing unit spec `DP/domain/frame-policy.spec.ts`: frame-ancestors builder (sorted, deduplicated, throws on non-normalised input) and CSP assembly (required FR-025 directives present, forbidden tokens absent) — AS-34, AS-38.
- [X] T009 [P] Write failing unit spec `DP/domain/shop-copy.spec.ts`: version-guard table (greater applies; equal/lower ignored) — AS-42, AS-43.
- [X] T010 [P] Implement `DP/domain/origin.ts` (G-03) until T005 is green.
- [X] T011 [P] Implement `DP/domain/theme.ts` (G-08) until T006 is green.
- [X] T012 [P] Implement `DP/domain/handoff-claims.ts` with injected clock, HS256 pinned (G-22) until T007 is green.
- [X] T013 [P] Implement `DP/domain/frame-policy.ts` (G-33) until T008 is green.
- [X] T014 [P] Implement `DP/domain/shop-copy.ts` until T009 is green.
- [X] T015 [P] Implement `DP/domain/site-rules.ts`: limits (10 sites/shop, 10 origins/site, 12 products, name 1–60, key `^pk_live_[A-Za-z0-9_-]{24}$`, body 8 KiB, token 4 KiB) and previous/current secret overlap decision (both previous fields null or both set) with unit spec `DP/domain/site-rules.spec.ts`.
- [X] T016 [P] Add zod schemas in `packages/contracts/src/developer-platform/widget.ts` (site DTO, created-with-secret, pages, `widgetConfigSchema` with `price: {amountMinor, currency}`, identify request/response, session, `developer_platform.widget_site_changed` event, problem codes of FR-038) and export from `packages/contracts/src/index.ts` (G-41, AS-53); `tsc` clean.
- [X] T017 Expand migration in the folder used by `20261001340000-widget-sites.js` (locate with `Glob`): add `name` (varchar(60) NOT NULL default 'Storefront widget'), `version` (integer NOT NULL default 1), `previousIdentitySecretSealed` (text NULL), `previousSecretExpiresAt` (timestamptz NULL), `shopName` (text NOT NULL default ''), `shopStatus` (text NOT NULL default 'ACTIVE'), `shopVersion` (bigint NOT NULL default 0), `featuredProductIds` ≤ 12 CHECK, `allowedOrigins` 1–10 CHECK, key-format CHECK (`NOT VALID` then `VALIDATE`), index `(shopId, createdAt, id)`, create `WidgetSiteChange` (id uuid PK, siteId uuid NOT NULL FK `WidgetSite(id)` ON DELETE CASCADE, shopId uuid NOT NULL no FK, change text NOT NULL, fromValue/toValue text NULL, actorId uuid NULL, at timestamptz NOT NULL, index `(siteId, at DESC, id)`); set `lock_timeout` (G-14).
- [X] T018 Add `WidgetSiteChange` → `domain:developer-platform` in `BE/db/ownership.ts` next to `WidgetSite` (`:152`) (G-14).
- [X] T019 [P] Create Sequelize models `DP/infra/widget-site.model.ts` and `DP/infra/widget-site-change.model.ts`; register them where models are registered (`check:model-registry`). — done as raw-SQL repository without Sequelize models (see gaps.md, "Decisions taken while building")
- [X] T020 Extend `DP/domain/ports.ts` with `WidgetSiteRepository`, `SingleUseStore`, `WidgetTokenSigner` (reuse `ShopDirectory`/clock ports); implement `DP/infra/sequelize-widget-site.repository.ts` (all lookups `WHERE id AND "shopId"`; conditional update by `version`; conditional kill update `WHERE "killSwitch" <> :v RETURNING`; limit insert under `pg_advisory_xact_lock(hashtext(shopId))` with count < 10) (G-39).
- [X] T021 [P] Implement `DP/infra/jwt-widget-token.ts` (sign/verify behind `WidgetTokenSigner`; dedicated `widget_token_key`; `typ: widget+jwt`, `aud: marketplace-widget-session`, `iss: marketplace`, `jti`; refuses other typ/aud/iss) and add boot validation that fails without the key; 900 s lifetime (G-25).
- [X] T022 [P] Implement `DP/infra/redis-single-use.store.ts` (`SET NX` with TTL `exp + 60 s`, throws a typed error on store failure so callers fail closed) (G-24).
- [X] T023 [P] Declare policies in `DP/rate-limit-policies.ts` (`developerPlatformRatePolicies`): `widget.config.ip` (open), `widget.identify.ip`, `widget.identify.site`, `widget.manage.shop` (closed) (G-13, G-19, S50 follow-up).
- [X] T024 Add `widget.manage` (OWNER, ADMIN) permission usage: check `tenancy/domain/permissions.ts` per research R-02; if S03 has not added it, do NOT edit tenancy, keep the sibling follow-up in gaps.md and use the permission name with the test-local grant in `widget-kit.ts` (G-01).
- [X] T025 Rework barrels: `DP/widget.module.ts` exports `WidgetModule` only plus `WidgetSessionService`; `DP/index.ts` exports `WidgetModule`, `WidgetProjectorModule`, `WidgetSessionService`, `WidgetPrincipal`, event contract types; stop exporting `WidgetService` (G-40, D-8). Create empty-but-valid `DP/widget-projector.module.ts` mirroring `PublicApiProjectorModule`.
- [X] T026 Implement `DP/application/widget-site.cache.ts`: shape check of key first, S52 `getOrLoad` with `l1: 'never'`, cross-instance invalidation on every write, unknown well-formed keys remembered ≤ 30 s and cleared on create (G-15, S52 follow-up); no per-process copy of a site record.
- [X] T027 Implement per-site CORS in `DP/api/widget-cors.ts` (registered-origin echo, `Vary: Origin`, no credentials, exact methods/headers, `Max-Age: 600`, OPTIONS handlers) and exempt the `/api/widget/v1` group from the global CORS in `BE/libs/infrastructure/platform/bootstrap-http.ts` with the narrowest route-group metadata (G-16); add the S54 sibling follow-up already listed in gaps.md if a platform change is needed.
- [X] T028 Implement `DP/application/widget-metrics.ts` (counters of AS-52) and a log helper that never emits secrets/tokens/e-mails (G-42).

**Checkpoint**: `pnpm run test libs/domains/developer-platform/domain` green; `tsc` clean for backend + contracts; migration applies on an empty database.

## Phase 3: User Story 1 — A shop registers and manages a widget site (P1) — B dashboard

**Goal**: full dashboard API behind `widget.manage`. **Independent test**: `widget-sites.e2e-spec.ts` (AS-01…AS-13).

- [X] T029 [US1] Write failing `DP/widget-sites.e2e-spec.ts` (describe "Widget: site management (dashboard)") covering AS-01 (secret once, sealed with context at rest), AS-02 (one wired `422 origin_invalid {origin, reason}`), AS-03 (validation, unknown props rejected, duplicate origins collapse), AS-04 (one accept, one reject of theme), AS-05 (20× concurrent creates: exactly 10 succeed, `422 site_limit_reached`), AS-06 (list/read keyset paging), AS-07 (20× concurrent PATCH with `expectedVersion`: one wins, `409 site_version_conflict`), AS-08 (`422 featured_product_invalid`, one R1 batch), AS-09 (matrix OWNER/ADMIN/STAFF/VIEWER/other shop/anonymous over all 9 routes, identical `404 widget_site_not_found` for unknown vs cross-shop, plus suspended-shop `403 shop_suspended` and offboarding `409 shop_offboarding` rows for write routes), AS-10 (rotation with overlap), AS-11 (conflicts, early expiry, 20× concurrent rotations), AS-12 (delete and effects on every instance, event), AS-13 (CSRF cookie vs bearer on every mutation); parse with contract schemas.
- [X] T030 [US1] Implement `DP/application/widget-sites.service.ts` using `TransactionRunner.run`: create (generate ID before insert, `SecretBox.seal(secret, 'widget-site:<id>')`, limit insert, outbox, seed shop copy through `ShopQueryService.getShopsByIds` outside the transaction — G-21), list/read, update with `expectedVersion`, validation of featured products via `ProductQueryService.getProductsByIds(ids, {shopId})` (G-07), rotate-secret / expire-previous-secret (clock-based, G-09), delete (cache invalidation + event, G-10).
- [X] T031 [US1] Implement `DP/api/widget-sites.controller.ts` and `DP/api/widget-dto.ts`: `ShopScoped('widget.manage')` on every route (G-01), whitelisted DTOs with spec limits (G-04), `@RateLimit('widget.manage.shop')` (G-13), CSRF wiring (G-12), problem+json codes; remove the old `create`/`kill` routes from `DP/api/widget.controller.ts` (kill moves in US5).
- [X] T032 [US1] Wire `WidgetSitesController`/services into `DP/widget.module.ts`; run `test-spec.sh libs/domains/developer-platform/widget-sites.e2e-spec.ts` until green.
- [X] T033 [P] [US1] Re-seal job `DP/infra/widget-shop-copy.backfill.ts` part 1: re-seal legacy identity secrets with context in batches ≤ 500, idempotent and resumable (G-09).

## Phase 4: User Story 2 — Config only from a registered origin (P1) — C public routes

**Independent test**: `widget-config.e2e-spec.ts` (AS-14…AS-22).

- [X] T034 [US2] Write failing `DP/widget-config.e2e-spec.ts` (describe "Widget: origin binding, config and CORS") covering AS-14 (body, headers, one R1 batch), AS-15 (three wired mismatches: scheme, port, suffix look-alike; ≥ 30-variant matrix for SC-001), AS-16 (refusals leak nothing, order key → origin → switch/shop status → rest), AS-17 (unknown/malformed keys, identical `404` bodies), AS-18 (per-site preflight table), AS-19 (shaping, configured order, archived hidden, `price {amountMinor, currency}`), AS-20 (two instances: change visible on next request; creation after negative lookup), AS-21 (product lookup forced down: stale copy up to 600 s, then `503 service_unavailable`; headers per response: 410 `s-maxage=30`, others `no-store`), AS-22 (limiter store down: config open, identify closed; policy names).
- [X] T035 [US2] Implement `DP/application/widget-public.service.ts` `authorize` + `config`: shape-check key, origin gate, switch/shop status, shop name from site copy (no `Shop` read), products via R1 (order by configured list, hide archived), shaped-config cache with stale-on-error 600 s and `l1: 'never'` (G-15, G-17, G-18, D-12).
- [X] T036 [US2] Rewrite public `DP/api/widget.controller.ts` `config` + preflight: per-response cache headers, `@RateLimit('widget.config.ip')` (fail-open, remove `skipThrottle`), CORS interceptor (G-16, G-18, G-19); run `test-spec.sh …/widget-config.e2e-spec.ts` until green.

## Phase 5: User Story 3 — Identity hand-off (P1) — D identity

**Independent test**: `widget-identity.e2e-spec.ts` (AS-23…AS-33).

- [X] T037 [US3] Write failing `DP/widget-identity.e2e-spec.ts` (describe "Widget: identity hand-off and widget session") covering AS-23 (exchange), AS-24 (two wired rejections: too long, missing jti), AS-25 (alg none, confusion, wrong secret, foreign issuer; ≥ 15 forged variants for SC-003; single body `401 identity_token_invalid`), AS-26 (replay; 1,000 simultaneous exchanges: exactly one wins, repeated ≥ 20×), AS-27 (single-use store down: `503`, marker not consumed), AS-28 (overlap boundary at `previousSecretExpiresAt`), AS-29 (no user/session rows created), AS-30 (order of checks), AS-31 (415, 413 over 8 KiB, no `Set-Cookie`, cookies ignored), AS-32 (`GET /api/widget/v1/session` and `WidgetSessionService.verify`), AS-33 (widget token refused by S01 access verifier and vice versa).
- [X] T038 [US3] Implement `DP/application/widget-identity.service.ts`: verify signature first (current then previous secret by clock), then claims policy, then single-use marker, fail-closed; one 401 body, reason only in log/metric label; issue token via `WidgetTokenSigner` (G-22…G-25, G-29).
- [X] T039 [US3] Implement `DP/application/widget-session.service.ts` (`WidgetSessionService.verify`) and the `session` route; add `identify` route changes to `DP/api/widget.controller.ts`: `@RateLimit('widget.identify.ip')` + `widget.identify.site` (stop using `auth.login.ip`), JSON-only (415), 8 KiB body limit (413), no cookies read or set (G-19, G-26, G-27, G-28); run `test-spec.sh …/widget-identity.e2e-spec.ts` until green.

## Phase 6: User Story 4 — Only shop pages can frame checkout (P1)

**Independent test**: `widget-embed.e2e-spec.ts` (AS-34…AS-38).

- [X] T040 [US4] Write failing `DP/widget-embed.e2e-spec.ts` (describe "Widget: embed document and framing policy") covering AS-34 (nonce ≥ 128 bits, unique per response, FR-025 directive set, one nonced script, no inline code, `no-store`, `nosniff`, `Referrer-Policy`), AS-35 (frame-ancestors equals the site's sorted list), AS-36 (route table: every other response has `frame-ancestors 'none'`), AS-37 (refusals via problem+json, hostile key `"><script>` not reflected), asserting bundle URL comes from `WIDGET_APP_BUNDLE_URL`.
- [X] T041 [US4] Implement `embed` in `DP/application/widget-public.service.ts` and `DP/api/widget.controller.ts`: nonce CSP built by `domain/frame-policy.ts`, bundle URL from validated config `WIDGET_APP_BUNDLE_URL` (default `/widget/v1/app.js`), malformed key refused before reflection, refusals through the global filter with `frame-ancestors 'none'` (G-30…G-34); run `test-spec.sh …/widget-embed.e2e-spec.ts` until green.

## Phase 7: User Story 5 — The kill switch (P1)

**Independent test**: `widget-kill-lifecycle.e2e-spec.ts` AS-39…AS-41.

- [X] T042 [US5] Write failing `DP/widget-kill-lifecycle.e2e-spec.ts` part 1 (describe "Widget: kill switch and shop lifecycle (consumers)") for AS-39 (off: config/identify/session/embed refused with `410 widget_disabled`, issued tokens refused, history row, event, next request on every instance, `s-maxage=30`), AS-40 (20× concurrent same-value switching: one history row/event, no-op on same value), AS-41 (restore, malformed body); `version` not bumped by the switch.
- [X] T043 [US5] Implement kill switch in `widget-sites.service.ts` + controller `PUT …/kill-switch` returning `200 WidgetSiteDto`: conditional update, `WidgetSiteChange` row and outbox event in one `TransactionRunner.run`, cache invalidation after commit and version check on read; extend the switch to identify/session/embed/issued tokens (G-11, G-02); run the part-1 tests until green.

## Phase 8: User Story 6 — Sites follow their shop (P2) — E lifecycle

**Independent test**: `widget-kill-lifecycle.e2e-spec.ts` AS-42…AS-46.

- [X] T044 [US6] Add failing part 2 to `DP/widget-kill-lifecycle.e2e-spec.ts`: AS-42 (rename, out-of-order and duplicate), AS-43 (suspension → `410`, reverse order), AS-44 (shop deleted purge + per-site events, duplicate), AS-45 (invalid payload and duplicate delivery for each of the three consumers), AS-46 (creation seeds the shop copy); events built from `packages/contracts` schemas via consumer entry points; SC-008 lag measured only as ops artifact.
- [X] T045 [US6] Implement `DP/infra/widget-consumers.ts` (`tenancy.shop_updated`, `tenancy.shop_status_changed`, `tenancy.shop_deleted`) with schema validation, inbox, DLQ, version-guarded updates through `domain/shop-copy.ts`, and register in `DP/widget-projector.module.ts` and `BE/apps/projector/…` (G-20, G-21).
- [X] T046 [US6] Backfill part 2 in `DP/infra/widget-shop-copy.backfill.ts`: shop copy via `ShopQueryService.getShopsByIds` batches ≤ 500, idempotent, resumable.
- [X] T047 [US6] Contract migration (later file, `lock_timeout`): drop FK `WidgetSite.shopId → Shop(id)` (G-14); apply on an empty DB and on one with data; run `test-spec.sh …/widget-kill-lifecycle.e2e-spec.ts` until green.

## Phase 9: User Story 7 — The loader never harms the host page (P2) — F loader

**Independent test**: `pnpm --dir packages/edge-be test widget-loader` (AS-47…AS-49).

- [X] T048 [US7] Write failing `packages/edge-be/src/widget-loader.spec.ts` (jsdom, fake `fetch`, fake windows): AS-47 (size < 5 KiB, single global, no `innerHTML`/`eval`/`document.write`/`'*'`, `credentials: "omit"`, headers of `/widget/v1/loader.js` from the worker `fetch` handler), AS-48 (postMessage origin/source/type filtering, closed message set, extra fields, non-object, 5 s identify deadline, `MarketplaceWidget` defined before the key check), AS-49 (non-array/non-string/boolean shape checks, ≤ 12 products, theme re-validation, out-of-stock disabled, failure drill: zero uncaught errors).
- [X] T049 [US7] Implement the loader changes in `packages/edge-be/src/widget-loader.ts` (and `packages/edge-be/src/index.ts:319-324` if headers change): G-35…G-38 incl. `referrerpolicy="strict-origin-when-cross-origin"` and `loading="eager"`; read price as `{amountMinor, currency}`; run the spec until green.

## Phase 10: User Story 8 — Operable and contract-checked (P2) — G

**Independent test**: `widget-contract.e2e-spec.ts` (AS-51…AS-53) + gates (AS-54).

- [X] T050 [US8] Write failing `DP/widget-contract.e2e-spec.ts` (describe "Widget: events, observability and contracts"): AS-51 (outbox rows with `developer_platform.widget_site_changed`, no event on no-op), AS-52 (counters; captured log output contains no secret, token or e-mail — SC-009), AS-53 (every route's responses parse with `packages/contracts` schemas; problem+json `code` from the closed FR-038 list).
- [X] T051 [US8] Wire events (`DP/application/events/widget-events.ts` via `outbox.append`), metrics and logs into all services until T050 is green (G-41, G-42).
- [X] T052 [US8] Delete `DP/widget.e2e-spec.ts` and `DP/application/widget.service.ts` after verifying its three scenarios exist as AS-14/16, AS-23/25/26, AS-35/39 (L-017); remove every `ShopModel` import and raw SQL on `Shop`/`Product` (G-39, D-6, D-7, D-12).

## Phase 11: Polish & cross-cutting proofs

- [X] T053 [P] Static gates for this capability: `tsc --noEmit` (backend, edge-be, contracts), ESLint, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `pnpm check:module-graph`, `pnpm check:model-registry`, `pnpm check:no-wallclock`; confirm `.tx.baseline` direct-site count not raised and no `// S54 T037 audit` left in touched files (AS-54).
- [X] T054 [P] Create `scripts/load-tests/widget-config.test.js` (k6, SC-007 ops artifact); keep its row in `specs/UNVERIFIED.md` status `not run`.
- [X] T055 Verify `specs/domains/S44-storefront-widget/quickstart.md` "Ops artifacts" (SC-002 intermediary part, SC-004, SC-005, SC-007, SC-008) and the five existing S44 rows in `specs/UNVERIFIED.md` match; never describe them as verified.
- [X] T056 Deferred to the final checkpoint: `scripts/qa/fresh-run.sh` (empty stack), then `scripts/infra/boot-app.sh core` and `scripts/infra/boot-app.sh projector` and the `config` probe expecting `404 widget_site_not_found` (a 503 there is a real wiring defect, L-004/L-015). Real-app boot proofs (L-004, L-015, L-018, L-019): start `apps/core` and `apps/projector` on their own with the checkpoint scripts; `GET /api/widget/v1/config?key=pk_live_<24 chars>` answers `404 widget_site_not_found`; projector lists the three widget consumers; verify queues named exist in `elasticmq.conf` (L-002) and tables/keyspaces exist in the test stack (L-011); run on a fresh stack (`scripts/qa/fresh-run.sh`, L-012). **Partly done**: the real `CoreModule` and `ProjectorModule` boot and answer in `apps/core/src/widget-wiring.e2e-spec.ts` and `apps/projector/src/widget-wiring.e2e-spec.ts` (and the public-api and worker wiring specs still pass with the new required `WIDGET_TOKEN_KEY`); no queue is added and the two new tables exist after `db:jest:migrate:up`. `scripts/infra/boot-check.sh --start` was run on 2026-10-14: the already-running monolith answers `/health/ready` (exit 0). But on that long-running dev process `GET /api/widget/v1/config?key=pk_live_abcdefghijklmnopqrstuvwx` answers `503 service_unavailable`, not `404 widget_site_not_found`; the process predates this work (not restarted, no docker access from this session), so its migrations or `WIDGET_TOKEN_KEY` may be stale. Not run: `scripts/qa/fresh-run.sh` (needs docker). L-012 is still open: the checkpoint must restart the API on a fresh stack and repeat the `config` probe.
- [X] T057 Run `python3 scripts/livespec/check.py`; fix the page `docs/spec/capabilities/S44-storefront-widget.md` until clean; do not touch `*.reviewed.json`.
- [X] T058 Whole capability suite once, in batches of fresh processes (domain unit specs, then each of the six e2e files, then the edge-be loader spec); every batch must end with its summary line (L-008).
- [X] T059 Update `specs/domains/S44-storefront-widget/gaps.md` "## Sibling-spec follow-ups" (S03 `widget.manage`, S54 CORS group exemption and startup validation, S50 policies, W07 bundle address and price shape, W04 screens, S10/S13) and "## Spec changes" (none signed); report follow-ups handled: S03, S05, S42, S50, S52, W07.

## Gap → task map (every gaps.md item has a task)

| Gaps | Tasks |
|---|---|
| G-01, G-02 | T024, T029–T031, T043 |
| G-03 | T005, T010 |
| G-04 | T016, T031 |
| G-05, G-06, G-07, G-09, G-10 | T029, T030 |
| G-08 | T006, T011 |
| G-11 | T042, T043 |
| G-12, G-13 | T023, T031 |
| G-14 | T017, T018, T047 |
| G-15 | T026, T035 |
| G-16 | T027, T036 |
| G-17, G-18, G-19 | T023, T035, T036, T039 |
| G-20, G-21 | T030, T045, T046 |
| G-22…G-29 | T007, T012, T021, T022, T037–T039 |
| G-30…G-34 | T008, T013, T040, T041 |
| G-35…G-38 | T048, T049 |
| G-39, G-40 | T020, T025, T052 |
| G-41, G-42 | T016, T028, T050, T051 |
| D-6, D-7, D-8, D-12 | T020, T052, T025, T035 |
| Section 3 lines | T001, T017, T018, T052 |

## Dependencies and order

- Phase 1 → Phase 2 → stories. Inside every story the e2e/unit test task precedes its code task.
- Phase 2 unit specs (T005–T009) precede their implementations (T010–T014); T017 precedes T018–T020; T020, T026, T027 precede all story code.
- US1 (T029–T033) is the MVP and must precede US2–US5 (they need site creation). US2 → US3 and US4 can run in parallel after T036 (`[P]` across different files). US5 after US1. US6 after US1 and T045 depends on T025. US7 (loader) is independent of backend stories after T016. US8 and Phase 11 come last.
- Parallel examples: T005–T009 together; T010–T014 together; T019/T021/T022/T023 together; after Phase 2, US7 (T048–T049) alongside US1.

## Implementation strategy

MVP = Phase 1 + 2 + US1 (dashboard create/list/update/rotate/delete behind `widget.manage`), then US2 → US3/US4 → US5 (all P1), then P2 stories, then Phase 11 proofs. Commit nothing until the gates of T053 pass for the increment.

## Phase 12: Convergence

- [X] T060 HIGH: Finish the real-app runtime proof that T056 left partial: on a fresh stack (`scripts/qa/fresh-run.sh`, L-012) restart the API and run `scripts/infra/boot-app.sh core` and `scripts/infra/boot-app.sh projector`; `GET /api/widget/v1/config?key=pk_live_abcdefghijklmnopqrstuvwx` must answer `404 widget_site_not_found` (the stale dev process answered `503 service_unavailable`; find out whether migrations or `WIDGET_TOKEN_KEY` were stale and fix any real wiring defect); confirm the projector lists the three widget consumers; record the outcome in `quickstart.md` step 10 and gaps.md, or write the blocker into `questions.md` if docker stays unavailable, and do not describe it as verified until it ran (L-004, L-015, L-018, L-019) per quickstart step 10 / FR-020 boot (partial)
- [X] T061 MEDIUM: Reconcile the event type name: code publishes `developerplatform.widget_site_changed` while spec FR-037/AS-51 and `contracts/events.md` say `developer_platform.widget_site_changed`; make the living-spec page `docs/spec/capabilities/S44-storefront-widget.md` and `contracts/events.md` state the published name (or fix the code if the `defineEvent` pattern allows it), keep `widget-contract.e2e-spec.ts` AS-51 asserting the same name, and list it in gaps.md "Sibling-spec follow-ups" for any consumer per FR-037 / AS-51 (contradicts)
- [X] T062 LOW: Update `contracts/http-dashboard.md` to the decisions already taken in gaps.md "Decisions taken while building" (origin rejection reason names from spec AS-02, theme errors as `400 validation_failed` instead of `422 theme_invalid`, kill switch returns `version` +1, preflight with an unknown key is `403 origin_not_allowed`) and align `data-model.md` on kill-switch `version` per plan: contracts (partial)
