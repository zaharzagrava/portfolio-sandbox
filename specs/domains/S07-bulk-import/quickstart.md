# Quickstart: validating S07 bulk import

Run from `packages/backend`. Backend e2e specs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed result + log path); one file at a time (L-008, a batch without its summary line is a crash).

## Prerequisites

Test stack up (`docker-compose.test.yaml`: Postgres, Redis, MinIO, ElasticMQ, Kafka stand-in). Queue `catalog-imports` and DLQ present in `infra/docker/elasticmq.conf` (no new queue ⇒ no reload, L-020). Migrations applied (`expand`, `data`, `contract` files for the import tables). Fake scanner: `libs/domains/catalog-sync/test/fakes/fake-clamd.ts` (started by the specs, not by hand).

## Scenarios

1. **Static** — `pnpm --dir packages/backend exec tsc --noEmit`; ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (import files: zero; domain total not above `.ownership.baseline`); `python3 scripts/livespec/check.py`.
2. **Pure logic** — `scripts/sdd/test-spec.sh libs/domains/catalog-sync/domain/import-` (row, sniff, batcher, status, error-report, file-name) and `libs/domains/catalog-sync/infra/import-` (pipeline backpressure, CSV byte-offset property).
3. **Upload API** — `…/import-upload.e2e-spec.ts` (AS-01…AS-12; use keys ≥ 8 chars).
4. **Processing** — `…/import-processing.e2e-spec.ts` (AS-13…AS-20), `…/import-report.e2e-spec.ts` (AS-29, AS-47…AS-50).
5. **Security** — `…/import-security.e2e-spec.ts` (AS-21…AS-28, AS-32) with the fake scanner in each mode.
6. **Resilience** — `…/import-resilience.e2e-spec.ts` (AS-33…AS-46, AS-71): gated storage stream, killed lease, trigger faults (dropped in `afterEach`, L-013).
7. **Status/progress/cancel, fairness, lifecycle, boundary** — `import-status`, `import-fairness`, `import-lifecycle`, `import-boundary` e2e (AS-51…AS-70).
8. **Whole capability suite once, at the end** — `scripts/sdd/test-spec.sh libs/domains/catalog-sync/import-` then the existing S08/S09 suites of the domain (`integration-boundary`, `sync-access`) to prove nothing regressed.
9. **Runtime proofs (L-018, L-015, L-004, L-019; scripted by the final task)** — boot `apps/core`, `apps/worker`, `apps/projector`, `apps/sse-gateway` each on its own and `apps/local-monolith`; call `POST /api/shops/:id/imports` with a real session and key, upload a part to storage, complete it, watch the job reach `DONE` and `import:<id>` events on the gateway; empty-stack run (`scripts/qa/fresh-run.sh`, L-012).
10. **Old behavior is gone** — `rg -n "INSERT INTO \"Product\"|INSERT INTO \"Outbox\"|kind: 'import'|imports.concurrent|infra/clamav|job:" libs/domains/catalog-sync` (import files) returns nothing.

## Ops artifacts

Success criteria and claims no automated test in this capability proves (each also a row in `specs/UNVERIFIED.md`, status `not run`; never described as verified):

- **SC-001** — 1,000,000 rows / 5 GiB-class file to `DONE` in under 15 min with worker RSS under 200 MB. Run `packages/backend/scripts/bench/catalog-import-bench.ts` (generates the file, runs the real pipeline against MinIO and the real catalog, records throughput and peak RSS). Script is written by this plan's tasks; the run is not.
- **SC-002** — 20 shops × 5 GiB-class imports at once, none delayed by another shop's, each shop's own sequential. Same script, `--shops 20` mode; read per-shop start/finish records.
- **SC-003** — kill the worker at 50 random points of a 100,000-row import and compare final products/counters with an uninterrupted run (counters may move one batch created/updated → unchanged). Kill/restart loop script in the same directory (`catalog-import-kill-loop.ts`); AS-33–AS-35 prove three fixed points only.
- **SC-006** — progress moves at least once per second at 20,000 rows/s, and the seller learns the cause of every refused row from the report without support. The throughput half rides on the SC-001 run (progress event timestamps); the "without support" half is a W04 usability check (not automatable).
- **SC-008** — a seller imports 10,000 rows and downloads the report of 3 bad rows in under 3 minutes of interaction: manual stopwatch run on the seller dashboard once W04 ships the page (the Playwright happy path `packages/web/tests/seller-import.spec.ts` proves the flow, not the time).
- **AS-29 (edge)** — the user-content origin answers every object with `X-Content-Type-Options: nosniff` and a different site from the application's origin: curl the configured `USERCONTENT_ORIGIN` against an uploaded report; belongs to the edge configuration artifact.
- **FR-044 (storage rules)** — bucket lifecycle rules abort incomplete multipart uploads after 1 day and expire `imports/*/source` after 7 days: check with the storage console/terraform plan.

Covered by automated tests (not listed above): SC-004 (AS-22, AS-23, AS-26), SC-005 (AS-52), SC-007 (AS-04, AS-11, AS-36, AS-38, AS-57, AS-61, AS-65, AS-66), SC-009 (AS-69).

## Execution record

Green runs of 2026-10-16, each file in its own fresh process (L-008), from `packages/backend` through `scripts/sdd/test-spec.sh`:

| File | Result | Full log |
|---|---|---|
| `import-upload` (AS-01…AS-12) | 30 passed | `/tmp/test-spec.8kIWLL.log` |
| `import-processing` (AS-13…AS-20) | 10 passed | `/tmp/test-spec.ZKSM9V.log` |
| `import-security` (AS-21…AS-28, AS-32) | 12 passed | `/tmp/test-spec.VcbOFc.log` |
| `import-resilience` (AS-33…AS-46, AS-71) | 16 passed | `/tmp/test-spec.3yvOWT.log` |
| `import-report` (AS-29, AS-47…AS-50) | 10 passed | `/tmp/test-spec.vJFfzT.log` |
| `import-status` (AS-51…AS-59) | 14 passed | `/tmp/test-spec.0UAyni.log` |
| `import-fairness` (AS-60…AS-63) | 6 passed | `/tmp/test-spec.Itkfnr.log` |
| `import-lifecycle` (AS-64…AS-68, AS-70) | 7 passed | `/tmp/test-spec.AStt8T.log` |
| `import-boundary` (AS-69) | 4 passed | `/tmp/test-spec.Mtv7KY.log` |
| `infra/repositories/sequelize-import` | 27 passed | `/tmp/test-spec.osHENL.log` |
| `sync-access` (S09 regression) | 13 passed | `/tmp/test-spec.re6Uox.log` |

Unit specs (`pnpm test`, jest default config): 30 suites / 718 tests passed for `catalog-sync/domain/`, `catalog-sync/infra/import*`, `common/config/catalog-sync-import-config`, `infrastructure/antivirus`, `infrastructure/storage`; the contracts spec `catalog-sync/imports.spec.ts` passed (29 tests, run with `--roots packages/contracts/src/catalog-sync`, the contracts package has no runner of its own). Static: `tsc --noEmit` clean, `check:boundaries` zero, `check:table-ownership --strict` reports nothing for `catalog-sync` (other domains' rows are not this capability's), `python3 scripts/livespec/check.py` 0 errors.

**Not green / not done**
- `integration-boundary` (S08): 1 of 7 fails, "the barrel exports exactly …", because that spec's list does not yet contain `CatalogImportProjectorModule`, which this capability must export (tasks T064). Recorded as a sibling follow-up in `gaps.md`; the S08 spec is not edited here.
- Runtime proofs (T072): the per-app boot (`scripts/infra/boot-apps.sh core worker projector sse-gateway`, `scripts/infra/boot-app.sh local-monolith`), the real-session import against the running gateway, and `scripts/qa/fresh-run.sh` were NOT run: starting them needs an approval this session could not obtain. Run them before this capability is accepted.
- The Playwright happy path `packages/web/tests/seller-import.spec.ts` is written and declared `fixme`: W04 (the page) does not exist, so it reports as skipped, not passed (SC-008 stays `not run`).
- The bench and kill-loop scripts are written and typecheck; they were not run (SC-001, SC-002, SC-003, SC-006 stay `not run`).
