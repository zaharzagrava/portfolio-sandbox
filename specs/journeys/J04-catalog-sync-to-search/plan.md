# Implementation Plan: J04 — Catalog Sync to Search

**Branch**: `J04-catalog-sync-to-search` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted; no line edited by a human), constitution v3.1.0, and the follow-ups left by S07 and S09 (see below).

## Summary

J04 is a test-and-glue capability: (a) one black-box API journey `packages/backend/test/journeys/catalog-sync-to-search.journey-spec.ts` (23 scenarios, AS-01..AS-23) with a kit extension in `test/journeys/support/`, (b) the **timing contract** (hops `J04.H1`–`J04.H16`) and canonical consumer-group names, (c) the hand-off repairs that the audit in [research.md](research.md) found still open. `gaps.md` pre-dates S01–S55: of its 27 rows most are built, one is superseded (G-12), and what remains is:

| WP | Work | Gaps | Owner domain |
|---|---|---|---|
| WP1 | Verify and close stock/event writers: no raw `Product` SQL or raw `products.events` outside catalog (order service/jobs, auction jobs, payments); stale D-7 comment; `check:boundaries` clean on J04's paths | G-02, G-04, D-7/D-8/D-10/D-12/D-15 | S05, S10, S13, auctions |
| WP2 | Canonical consumer aliases `integrations-stock-push`, `offline-sync-feed`, `pickup-availability`; topics `pickup.events`, `tenancy.events`, `catalog-sync.events` in `scripts/init-kafka-topics.sh`; J04 job types in the admin allow-list | G-11, G-15, G-18, G-19, G-22 | S53, S08, S09, S19, S49 |
| WP3 | Provider host allow-list `ALLOWED_PROVIDER_HOSTS` (local profile, refused in production) wired into the Shopify adapter | G-08, G-26 | S08, config |
| WP4 | Journey doubles and fixtures: `shopifyDouble`, `scannerDouble` (+ `clamav_host` in the local profile), `catalogFixture`, `pickupFixture`, `deviceClient`; hop rows `J04.H1..H16`; rate-limit allow-list for the journey address | G-09, G-26, G-27, G-25 | journey kit, apps |
| WP5 | The journey file, story by story; fix each broken hand-off in its owner (search shape and `projectionLagSeconds`, near-me shapes, shop-lifecycle consumers, webhook dedupe, import-finished SSE replay) | G-05, G-10, G-16, G-17, G-20, G-23 | S07, S08, S09, S19, S32 |
| WP6 | Bulk-import fan-out: import-origin creates do not flood followers (coalesce or skip) | G-24 | S26 |
| WP7 | Static gates, transaction migration, living spec pages, sibling follow-ups, UNVERIFIED rows (done) | all | all |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`).

**Primary Dependencies**: Sequelize + Postgres, Kafka (outbox relay), ElasticMQ, Redis, Elasticsearch, S3-compatible store, jest (`jest-journeys.json`, `pnpm test:journeys`, serial).

**Storage**: no new table, queue or migration. Topic list edit only (data-model.md).

**Testing**: per-capability e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; journey against the running stack (`API_URL=http://localhost:8000`, `bash scripts/sdd/stack-fix.sh api-ready` after edits); gates `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `tsc --noEmit`; `python3 scripts/livespec/check.py`.

**Target Platform**: Linux; the local deployment `apps/local-monolith`; every app also boots alone (L-018).

**Project Type**: web-service monorepo, API journey, **no UI scenario**.

**Performance Goals**: hop table of spec.md (H1 30 s, H3/H7/H8/H10/H11/H14 10 s, H5/H6/H13/H15 15 s, H12 5 s); deadline 2 × max × `JOURNEY_TIME_FACTOR`.

**Constraints**: doubles, allow-list, clock control refused in production (FR-018); no fixed sleeps; `afterAll` resumes every consumer and resets the clock.

**Scale/Scope**: 23 scenarios, ~9 domains, 0 new routes.

### Connection arithmetic (III.12)
No new pool; the runner opens no database connection. Unchanged from S54 sizing.

## Constitution Check

*Pre-research and post-design.*

| Rule | Status | Note |
|---|---|---|
| I/IV.1 boundaries | PASS | The journey uses public APIs; fixes use R1/R3 only. |
| IV.2 no cycles | PASS | No new module edge; WP3 touches catalog-sync config only. |
| IV.3/IV.4 outbox | WORK | WP1 moves any remaining raw stock writer to `applyStockDelta` (one event per change, same transaction). |
| IV.5 idempotent consumers | PASS | Aliases do not change groups; journey AS-19 proves replay. |
| III.8 transactions (S54) | WORK | Touched `// S54 T037 audit` sites are migrated and the comment deleted; direct-site count must not rise. |
| V.2/V.3 contracts | WORK | Responses parsed with `packages/contracts` schemas; a missing schema is added. |
| VII.2/VII.3 e2e per endpoint | WORK | Allow-list (accepted/refused host, production refusal) and alias registry get e2e. |
| VII.8 traceability | PASS | `test-plan.md` maps 23 rows; titles keep the stable `J04 AS-nn` prefix (L-017). |
| VIII safety | PASS | New settings refuse production boot; no secret in test output. |
| IX table ownership | WORK | `check:table-ownership --strict` for the nine domains (WP7). |
| Cross-spec rule 0 | WORK | Edit `docs/spec/capabilities/<ID>-*.md` first for any behaviour change (S08 allow-list, S53 aliases, S26 fan-out); never touch `*.reviewed.json`; signed-off changes go under `## Spec changes` in gaps.md. |

Violations needing justification: none. Post-design re-check: same.

## Known-failure-class checklist

- **L-018/L-015/L-004**: after WP2–WP4 boot core, worker, projector, local-monolith alone (final checkpoint by script, not a task).
- **L-001**: no FIFO option on the standard sync/import queues; no new queue.
- **L-002/L-011**: three topics added to `init-kafka-topics.sh`; compare with the doctor.
- **L-003**: no "A or B" assertions; absence is asserted only after `lag: 0` and the hop maximum on the stack clock (AS-12, AS-18, AS-19).
- **L-005/L-006**: every scenario creates its own products (`Pc`..`Ph`); unique run token.
- **L-007/L-008/L-023**: run per scenario with `-t`; a batch without summary line is a crash.
- **L-010**: fixtures idempotent (409 → open existing), OAuth callback duplicate answers `400`.
- **L-013/L-016/L-029**: `restoreAll()` idempotent; consumer pauses and clock are global, so the file runs serially and last-resort cleanup is in `afterAll` and global teardown.
- **L-012/L-019**: runtime proofs belong to the final checkpoint and are **not** tasks.

## Follow-ups from built specs (each is a requirement)

| From | Requirement | Where |
|---|---|---|
| S07 | J04 treats `DONE` or `catalogsync.import_finished` as the trigger, then waits for S32's projection (S05's `catalog.product_*` events) | AS-01 / AS-03: poll status or SSE terminal event (`J04.H1`), then `waitForContract('J04.H3', search)`. The topic is never consumed. |
| S09 | The step "an offline store device sells stock" is AS-01 plus AS-52; the journey may assert the offline sale reaches search, pickup and the provider | AS-10..AS-13: push → catalog → search (H10), pickup copy only (AS-12), Shopify (H11), second device (H12). |
| gaps.md | Every row, code fixes and constitution debt | table above and research.md §1 |

## Project Structure

### Documentation
```text
specs/journeys/J04-catalog-sync-to-search/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/journey-kit.md
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # /speckit-tasks
```

### Source Code
```text
packages/backend/
├── libs/infrastructure/projections/consumer-groups.ts   # aliases (WP2)
├── libs/common/config/local-profile-config.ts           # ALLOWED_PROVIDER_HOSTS (WP3)
├── libs/domains/catalog-sync/infra/{shopify.adapter,provider-http}.ts   # host allow-list (WP3)
├── libs/domains/{orders,auctions,payments}/             # stock writers audit (WP1)
├── libs/domains/community/infra/feed-projectors.ts      # import fan-out (WP6)
├── apps/local-monolith/                                 # scanner double wiring, settings (WP3, WP4)
├── scripts/init-kafka-topics.sh                         # topics (WP2)
└── test/journeys/
    ├── catalog-sync-to-search.journey-spec.ts
    ├── README.md                                        # J04 variables and fixtures
    └── support/{shopify-double,scanner-double,catalog-fixture,pickup-fixture,device-client,wait-for-contract}.ts
packages/contracts/src/                                  # schemas lacking one
docs/spec/capabilities/                                  # pages edited first (rule 0)
```

**Structure Decision**: fixes live with the owning domain; the kit is test-only code shared with J01–J03. J04 has no runtime module.

## Phase order

1. WP2, WP3 (nothing is addressable or reachable without names, topics and the allow-list), WP4 kit.
2. WP5 slices: US1 (file) → US2 (Shopify) → US3 (near-me) → US4 (device sale) → US5, US6 → US7, US8; each slice: write the journey scenario first, run it, fix the owner.
3. WP1 and WP6 as the slices expose them; WP7 last.
4. Final checkpoint (loop, not tasks): suites once, `pnpm test:journeys`, standalone boots, fresh stack.

## Complexity Tracking

No constitution violations. Judgment calls: aliases not renames; a journey-owned HTTPS Shopify double over the in-process fake; a protocol-faithful scanner double over disabling the scan.
