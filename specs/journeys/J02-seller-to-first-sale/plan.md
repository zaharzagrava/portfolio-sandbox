# Implementation Plan: J02 — Seller to First Sale

**Branch**: `J02-seller-to-first-sale` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written; no line was edited by a human), constitution v3.1.0, and the follow-up left by S40 (**J02 may poll `GET /shops/:shopId/rank` up to 10 s after payment**).

## Summary

J02 is a test-and-glue capability: (a) one black-box API journey (`packages/backend/test/journeys/seller-to-first-sale.journey-spec.ts`, 33 scenarios) with an extension of J01's kit in `test/journeys/support/`, (b) a **timing contract** (hop table H1–H17) and canonical consumer-group names, (c) the hand-off repairs that the audit in [research.md](research.md) found still open after S01–S55 were built. `gaps.md` pre-dates those specs; most of its 40 rows are now built or partial. What is left:

| WP | Work | Gaps | Owner domain |
|---|---|---|---|
| WP1 | Local-profile access: bootstrap `ADMIN` from `BOOTSTRAP_ADMIN_*`; verify register `202`, own rate-limit policy and journey allow-list | G-01, G-02 | S01, S50 |
| WP2 | Canonical consumer-group names (rename, one group `tenancy-shop-lifecycle` for onboarding + billing events, `search-product-index`, `leaderboards`, `identity-seller-promotion`, `entitlements-invalidation`) | G-04, G-06, G-15, G-16, G-25, G-35, G-36 | S01, S03, S18, S32, S40 |
| WP3 | Onboarding verification hand-off: verify topic/payloads/`shop.rejected`, atomic `shop.verified`, add job `onboarding.verify-pending`, extractor outbox command + lease | G-06..G-10 | S04, S03 |
| WP4 | Local extractor + model double by fixture content; extractor runs in the local deployment | G-11 | apps (`local-monolith`, `lambdas`), S04, S46 |
| WP5 | Billing → entitlements: verify interim state and events; `entitlements-invalidation` consumer; `Shop.plan` consumer | G-13..G-16 | S17, S18, S03 |
| WP6 | **Plan limit at product create** (`EntitlementsService.checkLimit` in `ProductCommandService`, `409 plan_limit_reached`, fail closed `503 entitlements_unavailable`) | G-20 | S05, S18 |
| WP7 | Product events and search: verify snapshots, version guard, shop-state copy, response shape, `GET /admin/search/index`; index refresh from config (`1s` locally) | G-21..G-28 | S05, S32 |
| WP8 | Webhooks: `allowedReceiverHosts`, wire headers (`Marketplace-Delivery-Id`, `-Event-Type`, `-Attempt`, `-Replay`), body `resource_version`, attempts filter, shop slicing and deterministic ids | G-29..G-33 | S43, S54 |
| WP9 | Leaderboard inputs: `lineTotalMinor`, `paidAt`, name/slug from `tenancy.*` (H15), `404 not_ranked`; S40 follow-up: rank poll within 10 s | G-34, G-35 | S40 |
| WP10 | Job allow-list additions `billing.run`, `onboarding.verify-pending`, `webhooks.retry`, `search.reindex`; clock reaches `billing.run` and `webhooks.retry` | G-18, G-37 | S49, S17, S43, S32, S04 |
| WP11 | Journey kit and spec (all six stories), fixtures `kyc-*.pdf`, `webhookReceiver`, hop rows H1–H17; metrics/log fields of AS-32 | G-38, G-39 | J02 (+ domains for counters) |
| WP12 | Static gates, transaction migration, living spec, sibling follow-ups, ops artifacts | G-40, AS-33 | all |

Order of work follows research.md §3: write each story's journey slice first, run it, fix the owning domain.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`).

**Primary Dependencies**: Sequelize + Postgres, Kafka (outbox relay), ElasticMQ (SQS), Redis, Elasticsearch, jest (`jest-journeys.json`, `pnpm test:journeys`, `maxWorkers: 1`); journeys use real HTTP via `fetch`.

**Storage**: no new tables, topics, queues or migrations (see [data-model.md](data-model.md)). If WP3 needs an outbox command to a queue not yet in `infra/docker/elasticmq/elasticmq.conf`, the queue is added there in the same task (L-002, L-020).

**Testing**: per-capability e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; journeys against the running local stack (`API_URL=http://localhost:8000`; after backend edits `bash scripts/sdd/stack-fix.sh api-ready`); static gates `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`; `python3 scripts/livespec/check.py`.

**Target Platform**: Linux; one local deployment (`local-monolith`) plus the document extractor; every app also boots alone (L-018).

**Project Type**: web-service monorepo (API journey; **no UI scenario**).

**Performance Goals**: the hop table in spec.md (H1 3 s … H9–H13 10 s, H16 15 s); deadline = 2 × maximum × `JOURNEY_TIME_FACTOR`.

**Constraints**: provider doubles, bootstrap admin, receiver allow-list, clock control refused at startup in production; no fixed sleeps; journeys serial; `afterAll` always resumes consumers and resets the clock.

**Scale/Scope**: 33 scenarios, 11 domains, 0 new routes of J02's own (it extends J01's job allow-list).

### Connection arithmetic (III.12)

No new pool. The journey runner opens no database connection. The advisory lock in WP6 uses the request's own transaction connection. Unchanged from S54's documented sizing.

## Constitution Check

*GATE — pre-research and post-design.*

| Rule | Status | Note |
|---|---|---|
| I/IV.1 module boundaries | PASS | Catalog reaches billing only through exported `EntitlementsService.checkLimit` (R1); no catalog → discovery import; search is built from events (R3). |
| IV.2 no cycles / D-11 | WORK | WP6 adds catalog → billing; confirm no billing → catalog edge (`check:module-graph`). |
| IV.3/IV.4 outbox | PASS | No new dual writes; WP3/WP5 only move appends into the deciding transaction where verify shows otherwise. |
| IV.5 idempotent consumers | WORK | Renamed/merged groups keep inbox + version guard + zod + DLQ; each gets a same-message-twice and invalid-payload test where missing. |
| III.3 no I/O in tx | PASS | WP6 count + insert only; provider calls stay in jobs. |
| III.8 transactions (S54) | WORK | New code uses `TransactionRunner.run` / `@Transactional`; each touched `// S54 T037 audit` site is migrated and the comment deleted; direct-site count must not rise. |
| V.2/V.3 contracts, problem+json | WORK | `plan_limit_reached`, `entitlements_unavailable`, `idempotency_key_*` have stable codes; schemas for any route lacking one go in `packages/contracts`. |
| V.6 idempotency | PASS | `POST /shops`, `…/subscription`, `…/products` honour the key (verify wiring on shop and product create). |
| VII.2/VII.3 e2e per endpoint | WORK | WP6 route behaviours (limit, fail closed, no write) get e2e; WP8 header contract gets e2e. |
| VII.4 consumer tests | WORK | see IV.5. |
| VII.8 traceability | PASS | `test-plan.md` has 33 rows; scenario titles `AS-nn …` stay stable (L-017). |
| VIII safety | PASS | Local-profile settings refuse production boot; secrets never logged (AS-32). |
| IX table ownership | WORK | `check:table-ownership --strict` for the eight domains (WP12). |
| Cross-spec rule 0 (living spec) | WORK | Edit `docs/spec/capabilities` pages (S01, S03, S04, S05, S17, S18, S32, S40, S43, S49) before behaviour changes; keep `[proof]`/`[code]` true; never touch `*.reviewed.json`; signed-off changes are listed under `## Spec changes` in gaps.md. |

Violations needing justification: none. Post-design re-check: same result (data-model.md §Boundary check).

## Known-failure-class checklist (earlier loop failures)

- **L-018/L-015/L-004**: after WP2/WP4/WP8 boot `core`, `worker`, `projector`, `payment-processor`, `sse-gateway` and the extractor standalone, then the monolith; `/health/ready` 200 (listed in quickstart; executed at the final checkpoint by scripts, not added as a task).
- **L-002/L-020/L-025**: any queue the extractor or webhooks need is in `elasticmq.conf`; the local stack runs the extractor consumer from the first minute.
- **L-001**: FIFO options only where the task is created (webhook delivery queue).
- **L-010**: fixture creation (`registerSeller`, shop, endpoint) is idempotent; 409 → open the existing one.
- **L-003**: no "A or B" assertions; absence is asserted only after `lag: 0` and the hop maximum on the stack clock.
- **L-005/L-006**: every scenario that consumes stock or the plan creates its own shop/product (`AS-17`, `AS-31` do).
- **L-007/L-008/L-023**: runner timeouts; the journey file is run per story with `-t` while building; a batch without summary line is a crash.
- **L-011**: no new keyspace, topic or bucket; the pause flag and clock offset are J01's.
- **L-013/L-016**: `restoreAll()` is idempotent and exits 0 when nothing is paused; AS-10 (extractor down) restarts the extractor in `afterAll`.
- **L-029**: the clock and consumer pauses are global, so the J02 file never runs in parallel with another journey.
- **L-012/L-019**: runtime proofs (fresh stack, standalone boots, journey suite) belong to the final checkpoint and are **not** tasks.

## Follow-ups from built specs (each is a requirement here)

| From | Requirement | Work package / test |
|---|---|---|
| S40 | **J02 may poll `GET /shops/:shopId/rank` until `200`, at most 10 s after payment; boards within 5 s p99** | WP9 + AS-25 (d): `waitForContract('H14', …)` with a 10 s floor on the deadline; `404 not_ranked` before payment asserted once. |
| gaps.md | Every row, code fixes and constitution debt (D-7, D-12, D-15, D-16 on this journey's paths) | Table above, research.md §1, WP12. |

## Project Structure

### Documentation (this feature)

```text
specs/journeys/J02-seller-to-first-sale/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── journey-kit.md
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/                      # schemas for routes lacking one (plan limit error, rank, board)
packages/backend/
├── libs/domains/identity/                   # bootstrap admin, group rename (WP1, WP2)
├── libs/domains/tenancy/                    # tenancy-shop-lifecycle (WP2, WP3, WP5)
├── libs/domains/seller-onboarding/          # verify-pending sweep, atomic verified, extract command (WP3)
├── libs/domains/billing/                    # entitlements-invalidation consumer, events (WP5)
├── libs/domains/catalog/application/product-command.service.ts   # checkLimit (WP6)
├── libs/domains/discovery/                  # search-product-index, shop-state (WP7)
├── libs/domains/developer-platform/         # headers, allowedReceiverHosts, slicing (WP8)
├── libs/domains/seller-insights/            # leaderboards group, inputs (WP9)
├── libs/infrastructure/elasticsearch/       # refresh interval from config (WP7)
├── apps/local-monolith, apps/lambdas        # extractor in the local deployment, model double (WP4)
└── test/journeys/
    ├── seller-to-first-sale.journey-spec.ts
    ├── README.md                            # J02 variables and fixtures
    └── support/{webhook-receiver,kyc-fixtures,seller-fixture,wait-for-contract}.ts + fixtures/kyc-*.pdf
infra/docker/elasticmq/elasticmq.conf        # only if WP3 adds a queue
docs/spec/capabilities/                      # pages edited first (rule 0)
```

**Structure Decision**: fixes live with the owning domain; the journey kit is test-only code under `test/journeys/support`, shared with J01. J02 has no runtime module.

## Phase order

1. WP1, WP2, WP10 (names, admin, allow-list: nothing is addressable or driveable without them), then US1 slice.
2. WP3, WP4 → US2 slice. WP5, WP6 → US3, US4 limit slice.
3. WP7, WP8, WP9 → US4 search and US5 slices.
4. WP11 remaining scenarios (replay, consumer-down, observability), then WP12 static gates, living spec, ops artifacts.
5. Final checkpoint (run by the loop, not a task): whole capability suites once, `pnpm test:journeys`, standalone boots, fresh stack.

## Complexity Tracking

No constitution violations. Two judgment calls: (1) rename consumer groups instead of aliasing (research.md §2); (2) serialise the product-count check with a per-shop advisory lock instead of a counter column (research.md §3).
