# Quickstart: validating S12 — Order Export

Prerequisites: the test stack (Postgres, Redis, ElasticMQ, object storage) up; queue `order-exports` loaded (`elasticmq.conf` reloaded: L-020); migrations applied (`pnpm --dir packages/backend db:jest:migrate:up`). Backend commands run from `packages/backend`.

Queue reload (L-020): the queue server reads `infra/docker/elasticmq/elasticmq.conf` only at start. Dev stack: `scripts/infra/reload-queues.sh`. Test stack: restart the container `marketplace_test_elasticmq` (`docker restart marketplace_test_elasticmq`). Both commands need an approval in an unattended session; the S12 run could not execute them and created the two queues through the SQS API on the running test server instead (they are lost at its next restart). Check with `apps/worker`: readiness `queue:order-exports` is `up` only when `order-exports` and `order-exports-dlq` exist.

## 1. Narrow checks while building
```
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/domain/export-            # unit specs (AS-13,14,16,35,61)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export.e2e-spec.ts   # start, file, download, access
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export-streaming.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export-progress.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export-worker.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export-lifecycle.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/order-export-backpressure.e2e-spec.ts   # 50,000 lines, its own process
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/infra/export-                           # repository and migration specs
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/orders/orders-boundary.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/catalog-sync/catalog-import.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh apps/core/src/order-export-wiring.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh apps/worker/src/order-export-wiring.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh apps/sse-gateway/src/order-export-wiring.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh apps/projector/src/order-export-wiring.e2e-spec.ts
pnpm --dir packages/backend test libs/domains/orders/domain/export- libs/domains/orders/infra/export-queue libs/infrastructure/storage   # unit specs
```
Large cases (25,000 / 50,000 lines) run in their own file process (L-008); a file without a summary line is a crash.

## 2. Static gates
```
pnpm --dir packages/backend exec tsc --noEmit -p tsconfig.json
pnpm --dir packages/backend lint
pnpm check:boundaries
pnpm --dir packages/backend check:table-ownership --strict     # AS-57: 0 findings for orders export files
python3 scripts/livespec/check.py                               # S12 page proofs/code markers true
```
Expected: the `orders` barrel exports no `*Model`, no `OrderExportService`, no `ExportJobTopicsModule`; `catalog-sync` imports nothing from `@app/domains/orders` (grep).

## 3. Runtime proofs (final checkpoint; L-004, L-015, L-018, L-012, L-019)
Start each app on its own, not only the monolith, and confirm it reaches ready: `apps/core`, `apps/worker` (consumer started, three schedules upserted), `apps/sse-gateway` (topic `order-export` defined), `apps/projector` (boots without `ShopMembershipModel`, G-54). The four `apps/*/src/order-export-wiring.e2e-spec.ts` specs do this with `NestFactory.create(<App>Module)`: core routes the five export routes behind credentials and answers the old paths 404; the worker declares the three job types with strict contracts, hosts the consumer and is ready only while `order-exports` and its dead-letter queue exist; the gateway knows `order-export:<id>` and no `job:` topic; the projector boots. Result of the S12 run (2026-10-16): all four green. Then run `scripts/qa/fresh-run.sh` on an empty stack and the capability suite once. Manual smoke: `POST /api/shops/<S>/order-exports` with an `Idempotency-Key` → `202`; watch `order-export:<id>` progress; `GET …/download` → open the link (the e2e files drive the same routes, worker entry and storage end to end).

## 4. Whole capability suite (once, at the end)
All five `order-export*.e2e-spec.ts` files plus `catalog-import.e2e-spec.ts` (the export case removed) and `orders-boundary.e2e-spec.ts` (allow-list shrunk).

## Ops artifacts (not proven by an automated test)
Each is a row in `specs/UNVERIFIED.md` with status `not run`; none may be described as verified.

- **SC-001 / AS-12** — `NODE_ENV=test pnpm --dir packages/backend bench:order-export --lines 100000` and `--lines 1000000` (a throwaway database; the script owns a shop and removes its rows): under 5 minutes, heap growth under 200 MB, same ceiling at both sizes. Attach the output to the PR. Smoke only so far: 30,000 lines, +25 MB heap at most, identical bytes on repeat (a smoke, not the measurement).
- **SC-003 (100,000-line part)** — jest covers 0, 1, 999, 1,000, 1,001 and 2,500; the 100,000-line exactly-once/byte-identical check is run by the benchmark script with `--verify` (hash of two runs). Smoke at 30,000 lines: hashes equal.
- **SC-005** — kill the worker at 30 random points of a 100,000-line export and let recovery run (`bench:order-export --lines 100000 --chaos 30`): one identical file each time, no partial visible. AS-45 proves one kill point only; the smoke with `--chaos 2` at 30,000 lines ended in the identical file.
- **SC-007** — a seller starts a 10,000-line export, sees progress move at least once a second and downloads the file in under 2 minutes of interaction: W04's Playwright journey `packages/web/tests/seller-order-export.spec.ts`, run once W04 lands.
- **Edge (test-plan note b/c)** — user-content origin serves `text/csv` attachment with `X-Content-Type-Options: nosniff` on a separate origin; storage lifecycle rule aborts incomplete multipart uploads after one day. Checked by `curl -I` on a presigned link in the deployed stack, and by reading the Terraform plan.
