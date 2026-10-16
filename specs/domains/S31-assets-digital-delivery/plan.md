# Implementation Plan: S31 — Shop Asset Library and Digital Product Delivery

**Branch**: `S31-assets-digital-delivery` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `.specify/memory/constitution.md`.

## Summary

Rebuild `packages/backend/libs/domains/asset-library` from one 278-line SQL-in-service into the layered domain of constitution I.2 (`domain/` pure rules and ports, `infra/` Sequelize and storage adapters, consumers and jobs, `application/` services that own transactions, `api/` controllers). Behaviour follows the 79 acceptance scenarios; design choices the spec left open are in [research.md](research.md): per-version chunk rows plus a counter (D1), claim-then-delete cleanup with `protectedUntil` (D2), presence check outside the transaction and re-validation inside (D3), a gapless journal from a locked counter row (D4), conditional-update quota (D5), the S54 idempotency facility (D6), opaque digest-stored grants (D7), entitlements from `order.paid`/`order.refunded` through S53 projectors (D8). Cross-domain access becomes R1 (`ProductQueryService.getProductsByIds`) and events (R3); the three `check:table-ownership` findings and both cross-owner foreign keys disappear.

## Technical Context

**Language/Version**: TypeScript (Node, NestJS), zod schemas in `packages/contracts`.
**Primary Dependencies**: Sequelize (repositories only), `TransactionRunner`/`@Transactional` (S54), `OutboxService`, S53 `Projector` consumers, `JobsService`/`@JobHandler` (S49), `RateLimitModule.forFeature` (S50), `RealtimePublisher` (S51), `ObjectStorage` port (`presignPutChecked`, `presignGet`, `head`, `getStream`, `delete`), platform `Clock`, `ProductQueryService` (S05), `ShopScoped` (S03), `Firewall` (S01), `fast-check` (dev).
**Storage**: PostgreSQL (tables in [data-model.md](data-model.md)); MinIO/S3 for chunk objects (key derived server-side from shop and hash); Redis for rate limits and idempotency per toolkits.
**Testing**: Jest e2e through `scripts/sdd/test-spec.sh`, real Postgres/Redis/MinIO, `supertest`; unit specs only for pure logic (`fastcdc`, `asset-path`, `conflict-name`, `content-disposition`, `chunk-plan`).
**Target Platform**: `apps` core (HTTP), worker (jobs), projector (consumers), realtime gateway (topic module). Each must boot alone (L-018): `AssetsModule`, `AssetsWorkerModule` and `AssetsProjectorModule` import what they use rather than relying on the monolith.
**Project Type**: backend domain library in a monorepo.
**Performance Goals**: prepare of 5,000 chunks in one multi-row statement; commit of 15,000 chunks in one transaction without network calls; entitlement lag ≤ 30 s p99.
**Constraints**: no storage call in a transaction (FR-013); bytes never pass the app on upload; downloads stream with constant memory; no model or SQL on other owners' tables.
**Scale/Scope**: files to 50 GiB (15,000 chunks), 500 versions, 100 GiB quota per shop.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I Layered modules (I.2, I.3 clock) | PASS after work (D-6 paid) | layers as above; time only from `Clock`, SQL `now()` removed (A23) |
| II Pipeline and routing | PASS | `ShopScoped`, `Firewall`, rate limit in services (S50 style), anonymous routes explicitly `anonymous: true` |
| III Data and transactions (III.3 no I/O in tx, III.7 guarded transitions, III.10 opaque cursors, III.11 expand/contract) | PASS | D2–D5, conditional `UPDATE … WHERE status`, `TransactionRunner` only; each `// S54 T037 audit` site migrated and its comment deleted |
| IV Communication (outbox, R1/R3) | PASS | outbox for `assets.*`, consumers idempotent, no order or product tables |
| V API contracts (V.1 DTOs, V.2 schemas, V.4 status, V.5 GET safe, V.6 idempotency) | PASS | all responses parsed by `packages/contracts`; share `GET` is preview only; commit idempotent |
| VI Frontend | N/A | no web capability owns the screens yet |
| VII Testing (VII.2 HTTP e2e, VII.3 cases, VII.4 consumers, VII.5 units, VII.8 table, VII.9 faults) | PASS | eight e2e files of `test-plan.md`; old `assets.e2e-spec.ts` replaced, scenario coverage kept (L-017) |
| VIII Operational safety | PASS | metrics AS-73, no secrets in logs AS-74, config validated at boot, user-content origin check |
| IX Isolation (IX.3 registry, IX.4 no FK/model/SQL across owners, IX.7) | PASS after work | D-7/D-12 paid, FK dropped, registry and domain-map updated |
| X Boundaries (X.4 barrel) | PASS | barrel exports four modules only |

No violations to justify. Post-design re-check: unchanged (the design adds only owned tables and uses existing toolkits).

## Project Structure

```text
specs/domains/S31-assets-digital-delivery/   plan.md research.md data-model.md quickstart.md contracts/interfaces.md
packages/contracts/src/asset-library/        schemas (new)
packages/backend/
  migrations/2026101*-asset-library-*.js      expand step, then contract step (new)
  db/ownership.ts                             register new tables
  libs/domains/asset-library/
    domain/    fastcdc.ts asset-path.ts conflict-name.ts content-disposition.ts chunk-plan.ts errors.ts ports.ts limits.ts (+ unit specs)
    infra/     asset|version|chunk|journal|share|entitlement|grant|usage repositories, chunk-store (ObjectStorage with timeouts and test gate),
               orders.consumer.ts catalog-shop.consumer.ts assets.jobs.ts
    application/ upload.service.ts (prepare, commit, restore) library.service.ts (list, journal, manifest, versions, delete, undelete)
               share.service.ts delivery.service.ts digital.service.ts entitlement.service.ts cleanup.service.ts
               events/asset-events.ts asset-metrics.ts
    api/       library.controller.ts share.controller.ts digital.controller.ts purchases.controller.ts downloads.controller.ts zod.pipes.ts realtime-topics.ts (exists)
    rate-limit-policies.ts  assets.module.ts (AssetsModule, AssetsWorkerModule, AssetsProjectorModule)  index.ts
    asset-client.ts + eight *.e2e-spec.ts files
docs/spec/capabilities/S31-assets-digital-delivery.md   living-spec page (new; rules, behaviors, proof and code refs)
docs/work/architecture/domain-map.md                     owned tables, Depends on
```

## Implementation phases (order of `gaps.md` section F; each phase ends green on its narrowest spec)

0. **Living spec first**: create the S31 capability page (rules and behaviors with `[proof:]`/`[code:]`), run `python3 scripts/livespec/check.py`. Never touch `*.reviewed.json`.
1. **Pure domain + contracts** (A3, A8, A32, A34): path rules, conflict naming, content-disposition, chunk plan, FastCDC property tests; zod schemas and problem catalog.
2. **Migrations + ownership** (B1–B8, D-7/D-12 debt, FK drops): expand/contract, registry, domain-map; `check:table-ownership --strict` clean for `asset-library` after phase 8.
3. **Ports, adapters, upload path** (A1–A6, A10, A23, A29, D-6): prepare with quota and `storedAt`, commit with idempotency, storage timeouts, outcomes, `unchanged`, version cap.
4. **Conflicts, journal, listing, manifest, notification** (A7, A9, A12, A13, A25).
5. **Versions, delete, undelete, restore, purge, cleanup safety** (A11, A22).
6. **Share links and delivery** (A14–A17, A26): preview/redeem/grant/download, headers, streaming failure rules, user-content origin.
7. **Digital products and consumers** (A18–A21, A30; S05 R1 follow-up; S10 note): link/unlink, entitlements, purchases, projectors, outbox events, then delete the `Product`/`BisOrder*` SQL.
8. **Operations** (A26, A27, A31, A35): rate-limit policies, metrics, log hygiene, jobs and worker split, the realtime topic assertion (S51 follow-up), rewrite of e2e specs as each area lands.
9. **Close-out**: full capability suite once, static gates (`tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:model-registry`, `check:module-graph`), `livespec/check.py`. Runtime proofs (standalone boots, fresh stack, journeys) are deferred to the final checkpoint and are not tasks.

## Requirements carried in from earlier specs

- S05: R1 `getProductsByIds([id], {shopId})` replaces the `Product` SQL (phase 7).
- S10: remove `BisOrder`/`BisOrderItem` SQL and `BisOrderModel` in the spec (phase 7); the `getOrderLines` call is replaced by events per `questions.md`, noted for S10 in `gaps.md`.
- S51: route registered through `TopicRegistry.define` (done in `api/realtime-topics.ts`); S31 publishes `assets.changed` on it (phase 4) and asserts the policy (phase 8).

## Complexity Tracking

None.
