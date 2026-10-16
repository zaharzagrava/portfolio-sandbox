# Implementation Plan: S27 — Brand stories CMS (domain `content`)

**Branch**: `S27-brand-stories` (working branch `sdd/auto`) | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-99, FR-001–FR-066, SC-001–SC-009), `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), constitution v3.1.0, and the follow-ups listed below.

## Summary

Rebuild `libs/domains/content` from a draft (one service with raw SQL, last-writer-wins drafts, `SCHEDULED` as a status, a controller that writes headers and XML) into a layered domain (I.2): thin controllers, use-case services in `application/`, ports in `domain/`, Postgres/Redis/CDN/webhook adapters in `infra/`. Behavior moves to the spec: optimistic concurrency (`expectedRevision`, `expectedVersion`), `Idempotency-Key` on publish (platform `@Idempotent`), schedule as an attribute plus a one-minute sweep, tag invalidation by an idempotent consumer (origin → CDN → signed revalidation), signed header-only previews, position-keyed keyset sitemaps, a `StoryShop` copy fed by tenancy events (R3) in place of reads of `Shop`, and removal of the foreign key to `Shop`. The toolkits (S49 jobs, S50 rate limit, S52 cache/ETag, S53 outbox/projections, S54 transactions/config/problem+json) are used as-is; nothing is rebuilt.

## Technical Context

**Language/Version**: TypeScript (NestJS) in `packages/backend`, zod schemas in `packages/contracts`.

**Primary Dependencies**: `@app/infrastructure/{jobs,idempotency,rate-limit,cache,events,outbox,projections,clock,http-client}`; `@app/domains/tenancy` (`ShopScoped`, `ShopQueryService`, `ShopDeleted`/shop events); `@app/domains/catalog` (`ProductQueryService.getProductsByIds`); `sanitize-html` (already used by `domain/blocks.ts`); `fast-check` (unit property test).

**Storage**: Postgres (tables owned by `content`: `Story`, `StoryDraft`, `StoryVersion`, `StoryTransition`, `StoryShop`; sequence for sitemap position), Redis (origin read model, key prefix `story:`), outbox rows (`stories.events`).

**Testing**: jest e2e per `test-plan.md` (nine `story-*.e2e-spec.ts`, replacing `stories.e2e-spec.ts`) run through `scripts/sdd/test-spec.sh`; nine unit specs under `domain/`.

**Target Platform**: existing deployables only: `apps/api` (HTTP), `apps/worker` (jobs), `apps/projector` (consumers). No new app (I.6).

**Project Type**: backend domain module + contracts package.

**Performance Goals**: SC-003 origin 2,000 rps p99 < 50 ms from the read model (ops artifact); sitemap constant memory.

**Constraints**: every query carries `shopId`; no `sequelize.transaction` (use `TransactionRunner`); no `Date`/`new Date()` in `domain/` (injected clock); every outbound call has a timeout; problem+json for all errors.

**Scale/Scope**: 5,000 stories/shop, 20 locales, 200 blocks, 256 KiB draft, 2,500 stories per sitemap page.

No NEEDS CLARIFICATION remains; see [research.md](research.md).

## Constitution Check

| Principle | Gate | Result |
|---|---|---|
| I Layered modules | application reaches infra only via `domain/` port tokens; domain pure; no new app | Pass — ports in [data-model.md](data-model.md); closes D-6 |
| II Pipeline | thin controllers; headers/XML/ETag in application or toolkit (`withEtag`, `buildCacheControl`) | Pass — closes F4/C2 |
| III Data | repositories; `shopId` in every predicate; `TransactionRunner`; keyset only; expand/contract migrations with `lock_timeout`; no network I/O inside a transaction; cache never source of truth | Pass — see research R4–R6 |
| IV Communication | events via outbox in the transaction; consumers with inbox, DLQ; `content` is a leaf (no R1 export) | Pass |
| V Contracts | DTOs validated with `packages/contracts` schemas; problem+json; idempotency header | Pass |
| VI Frontend | n/a (no web owner; recorded as gap) | n/a |
| VII Testing | table in `test-plan.md`; faults at edges; concurrency ×20; no `ShopModel` | Pass |
| VIII Operations | metrics/logs of AS-96; single-run sweep; config validation at start-up | Pass |
| IX DB isolation | `StoryShop` copy (R3), FK to `Shop` dropped, new tables in `db/ownership.ts`, `check:table-ownership --strict` clean | Pass — closes D-12 |
| X Monorepo | barrel exports Nest modules only; closes D-8 | Pass |

Gate failures: none. Complexity Tracking: empty (no violation to justify).

Post-design re-check (after Phase 1): unchanged, Pass.

## Follow-ups from built specs (each is a requirement of this plan)

| From | Requirement | Where planned |
|---|---|---|
| S03 | Replace `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw SQL on tenancy tables by `ShopAccessService`, `ShopQueryService`, `MembershipQueryService`; retest `403 shop_suspended` / `409 shop_offboarding` on write routes and viewer exclusion | Phase 2 (shop copy + `ShopScoped`), Phase 8; AS-91, AS-93, AS-99 |
| S30 | Public playlists `<video_cdn_url>/p/<videoId>/master.m3u8` on `stream.marketplace.dev`; `/u/…` unlisted URLs never stored in a block | Phase 1: `video` block rule rejects any path starting `/u/` and any query/credential; unit table in `blocks.spec.ts`; AS-08 |
| S49 | `declareJobType` with payload contract next to the `JobPayloads` augmentation for `stories.publish` and `stories.publish-due-sweep`; adapt to discriminated `JobsService.cancel` result; catch `InvalidScheduleError` | Phase 4 |
| S52 | `withEtag(body, '"<id>-v<version>-<locale>"')` + `buildCacheControl`; interceptor keeps handler headers on 304 | Phase 3 |
| gaps.md | A1–A8, B1–B10, C1–C6, D1–D6, E1–E2, F1–F5, G1–G6, debt D-6/D-7/D-8/D-12, ownership line, FK | Phases 1–9 (matrix below) |

## Phases (delivery order; each ends green on its narrowest spec)

0. **Living spec first** (rule 0): create `docs/spec/capabilities/S27-brand-stories.md` (none exists) with rules and behaviors from spec.md, each `[proof: S27 AS-nn]`; run `python3 scripts/livespec/check.py`. No `*.reviewed.json`.
1. **Domain core + schema**: pure modules in `domain/` (blocks with exact-host video rule and `/p/` vs `/u/`, `locale-chain`, `story-input`, `story-status`, `schedule-rules`, `etag` (delegates to toolkit matcher), `sitemap-position`, `sitemap-xml`, `revalidation-signature`, errors, ports/tokens, limits). Migrations (expand): `StoryDraft.revision`, `Story.scheduledBy/scheduleFailure/sitemapPosition`, `StoryVersion.publishedAt/publishedBy`, `StoryTransition`, `StoryShop`, position sequence, drop FK `Story.shopId→Shop`; register tables in `db/ownership.ts`. Unit specs. (G3, A4, A5, B3-rule, S30.)
2. **Shop copy + guard**: `StoryShop` repository, tenancy consumer (`shop_created|updated|status_changed|deleted`, `shopVersion` guard, validated, `natural` idempotency, bounded-batch delete), R1 `getShopsByIds` single fallback fetch; staff routes use `ShopScoped`. (D6, C5, A7 partly, AS-97/98.)
3. **Stories, drafts, list/detail** (US1): repositories (every statement carries `shopId`), `StoriesService`, `DraftsService`, controllers with zod DTOs, 422/409 codes, size limits (413 via body limit), cursor pagination, `content.write.shop` policy (`rate-limit-policies.ts`, fail closed). (A1–A3, A6, A8, C6, FR-001–006, 060–061, 066.)
4. **Publish, versions, schedule, archive, restore** (US2/3/7): `PublishService` in a `TransactionRunner` unit (row lock on `Story`, gapless version, history row, outbox append, sitemap position at first publish); `@Idempotent` on publish/schedule; S05 check **before** the transaction with 2 s timeout → 503; `stories.publish` job (+`declareJobType`, `NonRetryableJobError` for permanent codes, exhausted retries → `publish_failed`) and `stories.publish-due-sweep` (cron single-run, `FOR UPDATE SKIP LOCKED`); schedule cancel/archive/restore/versions; post-commit cache `DEL` wrapped so Redis failure never fails the request. (B1–B10.)
5. **Public read** (US2): read model via `CacheService` single-flight, TTL 60 s, durable fallback, `withEtag` + `buildCacheControl`, locale-in-path, `HEAD`, 404 `s-maxage=10`, `StoryShop` visibility. (C1–C5.)
6. **Invalidation consumer** (US4): events `story.published|archived|schedule_failed` via `defineEvent`; consumer: origin clear → CDN purge (≤30 tags, 3 in-call retries, full jitter, 5 s) → signed webhook → origin clear again before purge ordering; inbox by `eventId`; permanent 4xx; DLQ after 8; logging adapters outside production, config validation in production. (D1–D5, FR-030–034.)
7. **Preview** (US5): dedicated secret, pinned HS256, `aud=story-preview`, header-only, `products.write`, uniform 404. (E1–E2.)
8. **Sitemap** (US6): keyset by `sitemapPosition`, 2,500/page, 1,000-row batches, backpressure, abort handling, abnormal termination; logic in application, controller only pipes. (F1–F5.)
9. **Tenancy/ops** (US8): metrics and logs (AS-96), outbound timeouts (G6), barrel reduced to Nest modules (G4, D-8), `apps/projector`/`apps/worker` imports adjusted, replace `stories.e2e-spec.ts` by nine e2e files, load script `scripts/load-tests/stories.test.js`, `pnpm loadtest:stories`, final `check:table-ownership --strict` for `content`.

## Gap coverage matrix

| gaps.md | Phase | gaps.md | Phase |
|---|---|---|---|
| A1–A3, A6, A8 | 3 | D1–D5 | 6 |
| A4, A5 | 1 | D6 | 2 |
| A7 | 3 (all repos) | E1–E2 | 7 |
| B1–B3, B8–B10 | 4 | F1–F5 | 8 |
| B4–B7 | 4 | G1 | 3–9 (tests ship with each phase) |
| C1–C4 | 5 | G2, G3 | 1, 3 |
| C5 | 2, 5 | G4, G5, G6 | 9 |
| C6 | 3 | D-6/7/8/12, ownership FK | 1, 2, 9 |

## Transactions (rule 4)

`content` currently has no `sequelize.transaction` site (verified by grep, no `S54 T037 audit` comments). All transactional code uses `TransactionRunner.run`; the direct-site count must stay at 0.

## Project Structure

```text
specs/domains/S27-brand-stories/
├── plan.md  research.md  data-model.md  quickstart.md
└── contracts/  http-staff.md  http-public.md  events-and-webhook.md

packages/backend/libs/domains/content/
├── content.module.ts          # barrel exposes Nest modules only
├── api/        stories.controller.ts  public-stories.controller.ts  sitemap.controller.ts  dto/
├── application/ stories.service.ts drafts.service.ts publish.service.ts schedule.service.ts
│                lifecycle.service.ts public-read.service.ts preview.service.ts
│                sitemap.service.ts shop-copy.service.ts story-metrics.ts events/
├── domain/     blocks.ts locale-chain.ts story-input.ts story-status.ts schedule-rules.ts
│               sitemap-position.ts sitemap-xml.ts revalidation-signature.ts ports.ts errors.ts limits.ts (+ *.spec.ts)
├── infra/      *.repository.ts  story-read-model.ts  cdn-purger.ts  revalidation-client.ts
│               invalidation.consumer.ts  shop-copy.consumer.ts  stories.jobs.ts  migrations
├── rate-limit-policies.ts
└── story-*.e2e-spec.ts (nine)
packages/contracts/src/stories/…      scripts/load-tests/stories.test.js
```

**Structure Decision**: single domain module in existing apps; reasoning in research R1.
