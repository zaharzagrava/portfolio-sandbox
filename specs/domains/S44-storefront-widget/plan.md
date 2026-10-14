# Implementation Plan: S44 — Embeddable storefront widget (domain `developer-platform`)

**Branch**: `S44-storefront-widget` (working branch `sdd/auto`) | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md` (FR-001…FR-040, AS-01…AS-54, SC-001…SC-009), `test-plan.md`, `gaps.md` (G-01…G-42, D-6/D-7/D-8/D-12), `questions.md` (defaults accepted; no line was edited by a human, so spec.md stands), `.specify/memory/constitution.md`.

## Summary

Turn today's two-route widget backend (`POST sites`, `PUT kill-switch`, `config`, `identify`, `embed`, one 150-line `WidgetService` with raw SQL) into the capability the spec describes: a full dashboard API behind a new `widget.manage` permission, strict origin binding with per-site CORS, a hardened identity hand-off with a dedicated token key and a session verifier, a nonce-based CSP embed document, an instant cross-instance kill switch with history and events, a shop copy (R3) fed by three consumers, a hardened edge loader, and the pure rules, contracts, metrics and tests of `test-plan.md`.

Approach: hexagonal inside `libs/domains/developer-platform/` exactly like S42 (pure rules in `domain/`, a repository port in `domain/ports.ts`, Sequelize adapter in `infra/`, orchestration in `application/`, thin controllers in `api/`), a new `WidgetProjectorModule` mirroring `PublicApiProjectorModule`, contracts in `packages/contracts/src/developer-platform/widget.ts`, an expand/contract migration, and the loader changes in `packages/edge-be`. The living-spec page `docs/spec/capabilities/S44-storefront-widget.md` is written **first** (rule 0), and every `[proof:]`/`[code:]` is kept true (`python3 scripts/livespec/check.py`).

## Technical Context

**Language/Version**: TypeScript (Node, NestJS) in `packages/backend`; TypeScript in `packages/edge-be` (Cloudflare-style worker, loader is a generated string); zod schemas in `packages/contracts`.

**Primary Dependencies** (all already in the repo, see [research.md](research.md)): `@app/domains/tenancy` (`ShopScoped`, `ShopQueryService`, shop events), `@app/domains/catalog` (`ProductQueryService`), `@app/domains/identity` (`SecretBox`, `Firewall`, CSRF), `@app/infrastructure/{cache,rate-limit,outbox,inbox,projections,context,platform}`, `jsonwebtoken`.

**Storage**: Postgres tables `WidgetSite` (existing, expanded) and `WidgetSiteChange` (new), both owned by `domain:developer-platform`; Redis for the site cache (cross-instance invalidation), shaped-config stale copy, unknown-key memory and hand-off single-use markers. No other store.

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (six files of `test-plan.md`), `it.each` unit specs under `domain/`, jsdom spec for the loader in `packages/edge-be`. UI journeys are owned by W07 and W04. Static gates: `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `check:no-wallclock`, `livespec check.py`.

**Target Platform**: Linux services (`apps/core` hosts `WidgetModule`; `apps/projector` hosts `WidgetProjectorModule`); edge worker for the loader.

**Project Type**: web-service (backend domain) + edge script + contracts package.

**Performance Goals**: `config` is edge-cached; SC-007 is 50k RPS with ≥ 99% served by intermediaries (ops artifact). Origin path: one Redis read for the site, no database read on a warm key; one `getProductsByIds` batch (≤ 12 ids) on a cache miss.

**Constraints**: a site change is visible on the next request on every instance (no per-process copy of a site record); shop copy staleness ≤ **60 s p99** (restated here as the spec requires); hand-off marker TTL `exp + 60 s`; widget token 900 s; body 8 KiB, token 4 KiB; 10 sites/shop, 10 origins/site, 12 products.

**Scale/Scope**: 10,000 sites in the load mix; 9 dashboard routes, 5 public routes (+3 preflights), 3 consumers, 2 tables, 1 event type, 4 rate policies.

No `NEEDS CLARIFICATION` remains (see research.md).

## Constitution Check

| Principle | Gate | Result / how the plan satisfies it |
|---|---|---|
| I.1/I.2 layering (D-6) | no SQL, `jsonwebtoken`, `Date.now()` or `randomBytes` in `application/` | **Fix**: port + Sequelize adapter (G-39); signing/verification in `infra/widget-token.ts` behind a port; clock from the S54 clock; random through an injected source. |
| II request pipeline | routes, versioning, CORS placement | Public group `/api/widget/v1` exempt from the global CORS policy via one per-group mechanism; per-site CORS in a single interceptor/handler (G-16). |
| III.4/III.7 data & tx | S54 toolkit, no new `sequelize.transaction` | `TransactionRunner.run` for create (limit + insert + outbox), update, kill, rotate, delete, consumers; the file has no direct sites today (`.tx.baseline` is the gate). |
| III.6 limits | named policies | `widget.config.ip` (open), `widget.identify.ip`, `widget.identify.site`, `widget.manage.shop` (closed) in `rate-limit-policies.ts` (G-19, G-13). |
| IV communication | R1/R3/events only | Products: R1. Shop name/status: R3 copy + R1 seed. Deletion: event. Membership: `ShopScoped`. |
| V contracts/errors | problem+json, closed codes | Codes of FR-038 via the S54 filter; schemas in `packages/contracts` (G-41). |
| VII testing | table of 54 rows, no foreign models, no hollow asserts | `test-plan.md` followed; old `widget.e2e-spec.ts` split and deleted, its three ideas kept as AS-14/16, AS-23/25/26, AS-35/39 (L-017). |
| VIII operational safety | secrets, fail modes | SecretBox with context, dedicated widget key validated at boot, fail-closed single-use store, fail-open config limiter. |
| IX.4/IX.7 isolation | no foreign table, no FK | Drop `WidgetSite.shopId → Shop` FK (contract step); `WidgetSiteChange` added to `db/ownership.ts`; D-12 closed by R1/R3. |
| X.4 barrels | export only modules and contracts | Export `WidgetModule`, `WidgetProjectorModule`, `WidgetSessionService`, `WidgetPrincipal`, event types; stop exporting `WidgetService` (D-8). |

**Gate result: PASS.** Complexity Tracking: no violation to justify. One deliberate deviation is documented: the widget config is assembled in the domain (R1/R3) rather than a composition lib (spec Assumptions, LOCAL line).

**Post-design re-check (after Phase 1)**: PASS. data-model.md holds no foreign key; contracts/ define only owned or consumed shapes; no new direct `sequelize.transaction`.

## Follow-ups from built specs (each is a requirement of this plan)

| From | Requirement | Planned where |
|---|---|---|
| S03 | Replace `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw SQL on tenancy tables by `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`; retest `payouts.read` (excludes VIEWER), `sso.manage` (excludes ADMIN), `403 shop_suspended` / `409 shop_offboarding` on write permissions of closed shops | Phase B (dashboard routes use `ShopScoped('widget.manage')`; no tenancy model import in code or specs). Test: AS-09 matrix adds a suspended-shop and an offboarding-shop row for write routes. The `payouts.read`/`sso.manage` retest is not this domain's route set; recorded as a checked item in the AS-09 table run (no widget route uses them) and noted in the report. |
| S05 | `getProductsByIds(ids, {shopId})`, one batch per page; no `JOIN "Product"`/`ProductModel` | G-07, G-17 (write-time validation and `config`). |
| S42 | Widget reads `Shop` and `Product` directly (`widget.service.ts:96-98`) → `ShopQueryService` / `ProductQueryService` | G-17, G-20, G-21 (R3 copy + R1 seed/backfill). |
| S50 | Replace mis-used policies (G-35 of S50) with own declared names | `identify` stops using `auth.login.ip`; four own policies; `config` loses `skipThrottle`. Names stay declared in `developerPlatformRatePolicies`. |
| S52 | Pass `l1: 'never'` for preference, suppression and site records | Site record cache, unknown-key memory and shaped-config copy use `l1: 'never'` (FR-017; stale copy may use a shared store only). |
| W07 | State the final bundle address `WIDGET_APP_BUNDLE_URL` (default `/widget/v1/app.js`) | Config key `WIDGET_APP_BUNDLE_URL`, default `/widget/v1/app.js`, validated at boot (HTTPS absolute URL in production; the relative default resolves against the API/edge host). Stated in contracts/embed.md and the living-spec page. |

## Gaps coverage (all of gaps.md)

Every code gap G-01…G-42 and every debt row is mapped to a phase in [tasks-seed below](#phases-for-speckit-tasks); nothing is deferred.

| Gaps | Phase |
|---|---|
| G-14, G-39, G-40 (and D-6, D-8) | A foundation |
| G-03, G-08, G-22, G-33 (pure rules) | A foundation |
| G-01, G-02, G-04…G-13 | B dashboard |
| G-15…G-19, G-27, G-30…G-34 | C public routes, embed |
| G-22…G-26, G-28, G-29 | D identity |
| G-20, G-21 (consumers, seed, backfill, FK drop) | E lifecycle |
| G-35…G-38 | F loader |
| G-41, G-42, D-7, D-12, section-3 lines | G contracts, observability, test split, gates |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S44-storefront-widget/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http-dashboard.md, http-public.md, events.md, rate-limits-config.md)
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md            # next command (/speckit-tasks)
```

### Source code

```text
docs/spec/capabilities/S44-storefront-widget.md      # NEW living-spec page, written first

packages/contracts/src/developer-platform/widget.ts  # NEW schemas (site, created, pages, config, identify, session, event, problem codes); exported from index.ts

packages/backend/
├── db/ownership.ts                                  # + WidgetSiteChange
├── db/migrations/…widget-sites-expand / -backfill / -contract   # NEW (naming follows the folder in use by 20261001340000-widget-sites.js)
└── libs/domains/developer-platform/
    ├── domain/   origin.ts  theme.ts  handoff-claims.ts  frame-policy.ts  shop-copy.ts  site-rules.ts(limits, secret overlap)  ports.ts(+WidgetSiteRepository, SingleUseStore, WidgetTokenSigner, ShopDirectory reuse)  (+ *.spec.ts each)
    ├── application/  widget-sites.service.ts  widget-public.service.ts (authorize, config, embed)  widget-identity.service.ts  widget-session.service.ts  widget-shop-lifecycle.handler.ts  widget-site.cache.ts  widget-metrics.ts  events/widget-events.ts
    ├── infra/        sequelize-widget-site.repository.ts  widget-site.model.ts  widget-site-change.model.ts  redis-single-use.store.ts  jwt-widget-token.ts  widget-consumers.ts  widget-shop-copy.backfill.ts
    ├── api/          widget-sites.controller.ts (dashboard)  widget.controller.ts (public, rewritten)  widget-cors.ts  widget-dto.ts
    ├── testing/      widget-kit.ts (signWidgetHandoff, fixtures, clock, fault switches)
    ├── widget.module.ts  widget-projector.module.ts  index.ts  rate-limit-policies.ts
    └── widget-{sites,config,identity,embed,kill-lifecycle,contract}.e2e-spec.ts   # replace widget.e2e-spec.ts (deleted)

packages/edge-be/src/widget-loader.ts (+ widget-loader.spec.ts)   # G-35…G-38
packages/backend/apps/projector/…                  # register WidgetProjectorModule.projectors
packages/backend/apps/core/…                       # WidgetModule already hosted; verify boot (L-015, L-018)
scripts/load-tests/widget-config.test.js            # ops artifact SC-007
```

**Structure Decision**: extend the existing `developer-platform` domain with a widget slice that mirrors S42's layout; no new domain, no new app.

## Design decisions that need care (details in research.md)

1. **Site resolution + origin gate** (FR-011/12/17): `WidgetSiteCache.get(key)` — shape check, then S52 `getOrLoad` with `l1: 'never'`, cross-instance invalidation published by every write; unknown well-formed keys remembered ≤ 30 s and cleared on create. Order: key → origin → switch/shop status → rest.
2. **CORS**: a `WidgetCorsInterceptor` + `OPTIONS` handlers set per-site headers; the group is exempted from the global CORS using the platform's route-group mechanism (`SecurityPolicy`-style metadata; if none exists for CORS, add the narrowest metadata read by `bootstrap-http.ts` — S54 owned, recorded as a sibling follow-up).
3. **Kill switch / writes**: conditional `UPDATE … WHERE id AND "shopId" AND "killSwitch" <> :v RETURNING`, history row and `outbox.append` in one `TransactionRunner.run`; cache invalidation after commit and also on the read side by version check.
4. **Site limit**: `INSERT … SELECT … WHERE (SELECT count(*) …) < 10` under a per-shop advisory lock (`pg_advisory_xact_lock(hashtext(shopId))`) inside the transaction; concurrency test ×20.
5. **Tokens**: dedicated `widget_token_key` (HS256 or ES256 per S01 key tooling; startup fails without it); verifier refuses `typ`/`aud`/`iss` mismatch; S01 access verifier already refuses widget tokens.
6. **Secrets**: `SecretBox.seal(secret, 'widget-site:<id>')`; ID generated before insert; one-off re-seal job for rows sealed without context (`widget-shop-copy.backfill.ts` sibling script, batch ≤ 500).
7. **Migration order**: expand (columns, `WidgetSiteChange`, CHECKs `NOT VALID` then validate) → backfill shop copy through `getShopsByIds` and re-seal → contract (drop FK) in a later migration, `lock_timeout` set.

## Staleness statement (required by the spec)

Shop name/status copy: p99 ≤ 60 s from the tenancy event to the next widget decision (consumer lag budget 30 s + no per-process caching, so the next request sees it).

## Risks

- S03 must add `widget.manage` (OWNER, ADMIN) to its matrix; until then the plan adds it in `tenancy/domain/permissions.ts` only if S03's spec allows editing it — otherwise a sibling follow-up (see gaps.md section below) and the route guard uses the permission name with a test-local grant. Decision recorded in research.md R-02.
- No S44 page exists under `docs/spec/capabilities`; creating it is task 1.
- Real-app boot (L-015/L-018/L-004): `apps/core` and `apps/projector` must start with the new module graph; final checkpoint task runs the boot scripts.

## Phases for /speckit-tasks

A foundation (page, contracts, migration expand, models, ports, pure rules + unit specs, module exports) → B dashboard (RBAC, create/list/read/update/rotate/expire/delete/kill/history, limits, CSRF, policies) → C public routes (site cache, authorize, CORS, config, embed/CSP) → D identity (identify, claims, single-use, session, verifier) → E lifecycle (projector module, consumers, seed, backfill, FK drop) → F loader → G contracts/observability/tests split, delete old e2e, gates, boot proofs, UNVERIFIED rows, full-suite run once.
