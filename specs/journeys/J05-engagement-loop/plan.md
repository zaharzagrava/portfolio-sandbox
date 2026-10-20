# Implementation Plan: J05 — Engagement loop

**Branch**: `J05-engagement-loop` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted; no line edited by a human), constitution v3.1.0, and the follow-up left by S39 (see below).

## Summary

One black-box API journey `packages/backend/test/journeys/engagement-loop.journey-spec.ts` (37 scenarios AS-01..AS-37, AS-34 UI pending), the hop table `J05.H1–H16`, canonical consumer-group aliases, and the hand-off repairs still open. `gaps.md` pre-dates the build of S25–S55: [research.md](research.md) §1 re-audits its 23 rows; most are closed. What remains:

| WP | Work | Gaps | Owner |
|---|---|---|---|
| WP1 | Eight consumer-group aliases in `consumer-groups.ts` (no rename); confirm job allow-list `recommendations.build-bought-together`, tap topics `links.events|feed.events|discussion.events`, topic `links.events` in `scripts/init-kafka-topics.sh` | G-09, G-17, G-23 | S53, S49 |
| WP2 | Checkout `ref` (replaces `refCode`), R1 `resolveAttributions`, frozen attribution on the order (`attributionOwnerId` migration), `GET /orders/:id` `attribution`, `order.paid.attribution`; never fails on a bad ref | G-01, G-02 | S10 (S37 export) |
| WP3 | Conversion capability slice in marketing: table `AffiliateConversion`, consumer `marketing-affiliate-conversions` (`order.paid`, `order.refunded`; idempotent on `orderId`, version guard, out-of-order refund), outbox events `link.converted|link.conversion_reversed`, `GET /links/:code/conversions`, stats `conversions`/`convertedMinor`; verify click dedupe by `clickId`; injected `Clock` | G-12, G-14, G-22 | S37 |
| WP4 | Journey kit (`engagementFixture`, `storefrontDouble`, hop rows H1–H16) and the journey file, story by story; each hop found broken is fixed in its owner (feed, discussions, notifications, recommendations, trending, experiments) | G-04..G-08, G-10, G-11, G-15, G-16 | S26, S25, S28, S34, S35, S39 |
| WP5 | Storefront double stands in for emitters; AS-34 Playwright spec stub marked pending | G-19 | journey kit |
| WP6 | Static gates: no foreign model in `orders` controller / `discovery`, barrels export modules not projectors, direct `sequelize.transaction` count in the domains does not rise | G-13, G-20 | S10, S26, S34, S35, S37, S39 |
| WP7 | Living spec pages edited first (rule 0): S10, S37, S53 capability pages; sibling follow-ups and UNVERIFIED rows | all | docs |

## Technical Context

**Language/Version**: TypeScript strict, Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`, `packages/web` for the pending UI test).

**Primary Dependencies**: Sequelize + Postgres, Kafka (outbox relay), Redis, Scylla (feed), ClickHouse (clicks/analytics), jest (`pnpm test:journeys`, serial).

**Storage**: one new table (`AffiliateConversion`, marketing), one new nullable column (`Order.attributionOwnerId`), see [data-model.md](data-model.md). One new topic `links.events` if absent.

**Testing**: domain e2e via `scripts/sdd/test-spec.sh`; journey against the running stack; gates `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`, `python3 scripts/livespec/check.py`.

**Target Platform**: Linux, `apps/local-monolith`; every app also boots alone (L-018).

**Project Type**: web-service monorepo; API journey, one pending UI scenario.

**Performance Goals**: hop table of spec.md (H2/H3/H4/H9/H10/H12 ≤ 10 s, H6 5 s, H7/H14 60 s, H13 35 s after clock advance, H15 15 s).

**Constraints**: stack clock and pauses are global ⇒ journeys serial; doubles and control surface refused in production; no fixed sleeps.

**Scale/Scope**: 37 scenarios, 8 domains, 2 new routes, 2 new events, 1 table.

### Connection arithmetic (III.12)
The conversion consumer reuses marketing's existing Postgres pool; one batch consumer, one transaction per batch. No new pool.

## Constitution Check

*Pre-research and post-design.*

| Rule | Status | Note |
|---|---|---|
| I/IV.1 boundaries | PASS | Orders calls marketing only via the exported R1 `LinkAttributionService`; marketing never reads orders (event only). |
| IV.2 no cycles | WORK | orders → marketing edge is new; marketing must not import orders; `check:module-graph` gates it. If the edge cycles, introduce a port in orders (`AttributionResolverPort`) bound by the app. |
| IV.3/IV.4 outbox | WORK | `link.converted|reversed` written with the conversion row in one transaction; `order.paid` attribution read from the order row in the paid transaction. |
| IV.5 idempotent consumers | WORK | Conversion unique key + `orderVersion` guard + DLQ; AS-15/AS-35 prove replay. |
| III.8 transactions (S54) | WORK | `TransactionRunner.run` only; migrate touched `// S54 T037 audit` sites (none found in these domains). |
| V.2/V.3 contracts | WORK | new request/response/event zod schemas in `packages/contracts`. |
| V.6 Idempotency-Key | PASS | Checkout, links, posts, comments already keyed. |
| VII.2/VII.3 e2e per endpoint | WORK | e2e for checkout `ref` and the conversions route/consumer. |
| VII.8 traceability | PASS | `test-plan.md` 37 rows; titles keep the `J05 AS-nn` prefix (L-017). |
| VIII safety | WORK | No buyer/order id in conversion routes or events; no keys in logs (AS-36). |
| IX table ownership | WORK | `AffiliateConversion` registered to marketing; `check:table-ownership --strict`. |
| Cross-spec rule 0 | WORK | Edit `docs/spec/capabilities/S10-*.md`, `S37-*.md`, `S53-*.md` first; `[proof]`/`[code]` tags true; never touch `*.reviewed.json`; anything signed goes under `## Spec changes` in gaps.md. |

Violations needing justification: none. Post-design re-check: same; only the orders → marketing edge needs the cycle check.

## Known-failure-class checklist

- **L-018/L-015/L-004**: after WP2/WP3 boot core, worker, projector and local-monolith alone (final checkpoint by script, not a task).
- **L-001/L-002/L-020**: no queue added; topic `links.events` added to the init script and verified against the doctor.
- **L-003**: no "A or B" assertions; absence only after `lag: 0` plus hop maximum on the stack clock.
- **L-005/L-006**: every scenario creates its own products, users, link, experiment (unique run token).
- **L-007/L-008/L-023**: run per story with `-t`; a batch without summary line is a crash.
- **L-010**: fixtures idempotent (409 ⇒ open existing).
- **L-013/L-016/L-029**: `afterAll` restores clock and resumes groups, idempotent; journey serial and last.
- **L-017**: stable `J05 AS-nn` titles.
- **L-032**: log scans read lines of this run (`logMark` in `beforeAll`).
- **L-012/L-019**: runtime proofs belong to the final checkpoint and are **not** tasks.

## Follow-ups from built specs (each is a requirement)

| From | Requirement | Where |
|---|---|---|
| S39 | J05 creates a `unit: "user"`, metric `purchase` experiment and polls `GET /api/admin/experiments/:key/results` for up to 60 s after the purchase (FR-044) | US6, AS-30..AS-33, H14 = 60 s deadline 120 s |
| S37 | `resolveAttributions` consumer is checkout (J05) | WP2 |
| gaps.md | every row: code fixes and constitution debt | research.md §1 |

## Sibling-spec follow-ups (to record in gaps.md under that heading)

- **S10**: adopt body field `ref`, `attribution` on orders, `order.paid.attribution`.
- **S37**: adopt conversions (store, consumer, route, stats fields, `links.events` types).
- **S53**: adopt the eight canonical aliases.
- **S28/S35**: none (already as specified).

## Project Structure

### Documentation
```text
specs/journeys/J05-engagement-loop/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/journey-kit.md
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # /speckit-tasks
```

### Source Code
```text
packages/backend/
├── libs/infrastructure/projections/consumer-groups.ts      # aliases (WP1)
├── libs/domains/orders/{api,application,infra,domain}/     # ref, attribution, order.paid (WP2)
├── libs/domains/marketing/{application,infra,api,domain}/  # conversions (WP3)
├── libs/domains/{community,notifications,discovery,experimentation}/   # only fixes the journey exposes (WP4)
├── scripts/init-kafka-topics.sh                            # links.events (WP1)
└── test/journeys/
    ├── engagement-loop.journey-spec.ts
    ├── README.md                                           # J05 variables
    └── support/{engagement-fixture,storefront-double,wait-for-contract}.ts
packages/contracts/src/                                     # checkout ref, conversion, link events
packages/web/tests/engagement-loop.spec.ts                  # AS-34, pending
docs/spec/capabilities/                                     # S10, S37, S53 pages first (rule 0)
```

**Structure Decision**: fixes live with the owning domain; the kit is test-only. J05 adds no runtime module of its own.

## Phase order

1. WP1 (names, topic, allow-list), then WP2 → WP3 (nothing credits without attribution).
2. WP4 slices US1 → US7: write the scenario, run it narrowly, fix the owner.
3. WP6 and WP7 last (they follow the sinks being idempotent).
4. Final checkpoint (loop, not tasks): capability suites once, `pnpm test:journeys`, standalone boots, fresh stack.

## Complexity Tracking

No violations. Judgment calls: aliases not renames; `ref` replaces `refCode` rather than coexisting; Postgres table + outbox for conversions rather than Dynamo.
