# Quickstart: validating S09 end to end

Run backend commands from `packages/backend`. Prefer the narrowest test; run the whole capability suite once at the end, in per-file batches of fresh processes (L-008). Prerequisites: test stack up (`docker-compose.test.yaml`: Postgres, Redis, Kafka, ElasticMQ); no queue is added by this capability (L-002/L-020 n/a); every table exists after migrations (L-011).

## Scenarios

| # | Proves | Command | Expected |
|---|---|---|---|
| 1 | Pure domain (AS-17, 19–20, 23, 31, 09, 22, 54) | `pnpm jest libs/domains/catalog-sync/domain` | `hlc`, `merge` (+ `fast-check`), `ops`, `cursor`, `outcome` specs green |
| 2 | Push, idempotency, deltas, faults (AS-01–14, 33, 34, 37, 38) | `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/catalog-sync/sync-push.e2e-spec.ts` | green; AS-13/14/37/38 force their faults |
| 3 | Per-field LWW (AS-15–23) | `…/sync-fields.e2e-spec.ts` | green; AS-18 ×20 |
| 4 | Pull and bootstrap (AS-24, 25, 30–32) | `…/sync-pull.e2e-spec.ts` | green |
| 5 | Feed consumers (AS-26–29) | `…/sync-feed-consumer.e2e-spec.ts` | green; DLQ on invalid payload |
| 6 | Conflict review (AS-39–41) | `…/sync-conflicts.e2e-spec.ts` | green |
| 7 | Access, tenancy, limits (AS-35, 36, 42–47) | `…/sync-access.e2e-spec.ts` | green; role × route matrix |
| 8 | Lifecycle, retention, observability, compaction, catalog-only writes (AS-48–52, 55) | `…/sync-lifecycle.e2e-spec.ts` | green |
| 9 | Boundary (AS-53) | `pnpm check:table-ownership --strict`, `pnpm check:boundaries`, migration inspection spec | zero `catalog-sync` findings for S09 files; no FK/trigger on catalog tables |
| 10 | Migration on populated data | `…/test/` migration spec (existing pattern of `data-migration.e2e-spec.ts`) | old rows keep outcome; fresh DB migrates both steps |
| 11 | Static | `pnpm tsc --noEmit` (backend, contracts); ESLint; direct `sequelize.transaction` count in `catalog-sync` not above baseline (0) | clean |
| 12 | Boot (L-004/L-015/L-018) | start `apps/core`, the worker app and `apps/projector` each alone, then `apps/local-monolith`; hit health and `GET /shops/:id/sync/pull` | each boots alone; no missing import/provider |
| 13 | Fresh stack (L-012, L-019) | `scripts/qa/fresh-run.sh`, then the capability suite per file | every batch prints its summary line |
| 14 | Living spec | `python3 scripts/livespec/check.py` | `[proof:]`/`[code:]` of `docs/spec/capabilities/S09-offline-sync.md` true |
| 15 | S08 regression (shared barrel/consumers) | `…/integration-boundary.e2e-spec.ts`, `…/integration-stock.e2e-spec.ts` | green (see gaps.md sibling follow-up for the pinned export list) |

Manual smoke: sign in as a shop member, `POST /api/shops/:id/sync/push` with a `stock.adjust` (UUIDv7 `opId`, `hlc` built with `X-Device-Id` as node), repeat it (`replayed: true`), then `GET …/sync/pull` and see the entry with the same `version`.

## Ops artifacts

Success criteria no automated test in this capability proves (each also a row in `specs/UNVERIFIED.md`, status `not run`; never described as verified):

| Criterion | How to run it |
|---|---|
| **SC-003** — push of ≤50 operations answers within 1 s p99 and a pull page within 200 ms p99 at 10,000 requests/s; a committed product change is visible to pull within 5 s p99 | k6 script (to write on the VPS runner): 10,000 rps mix 70 % pull / 30 % push against a seeded shop set; record p99 per route and the `catalog_sync_offline_feed_lag_seconds` gauge; compare with thresholds. The e2e suite only proves correctness, not latency. |

SC-001, SC-002 (1,000 generated runs in `merge.spec.ts`), SC-004–SC-008 are proven by the e2e and unit specs named above (SC-005: AS-33; SC-006: AS-26; SC-007: AS-44; SC-008: AS-21 + AS-32).
