# Quickstart: validating S29 photos

Contracts: [media-api.md](contracts/media-api.md), [events.md](contracts/events.md). Tables and states: [data-model.md](data-model.md). Scenario → file mapping: [test-plan.md](test-plan.md).

## Prerequisites

- Test stack up (PostgreSQL, Redis, MinIO with bucket `marketplace-media`, ElasticMQ with queue `media-processing` and its DLQ in `elasticmq.conf`). A stack created before S29 needs the bucket and queue added: compare with the doctor (L-002, L-011); verify on a fresh stack with `scripts/qa/fresh-run.sh` (L-012).
- Migrations applied (`…-media-s29-expand`, `-backfill`, `-contract`); the e2e fixtures run the same migrations.
- Configuration: `media_cdn_url` (https, a different site from `front_host` and the API host), `media_bucket`, scanner address; tests use the fake scanner, and a non-production run may set the scanner switch off (a warning is logged at startup). Production refuses to start without these (AS-58).

## Run

From `packages/backend`, one fresh process per file (L-008); each prints a condensed result and the log path:

```bash
pnpm test -- libs/domains/media/domain libs/domains/media/infra/image-pipeline.spec.ts   # unit specs (status, matching, pipeline)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-upload.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-processing.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-duplicates.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-gallery.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-consumers.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-read.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-lifecycle.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/media-events.e2e-spec.ts
```

Also, one process each: `media-migrations.e2e-spec.ts` (expand, backfill, contract on a scratch database that starts from the legacy schema), `media.e2e-spec.ts` (the three walks of the first version, through the new routes), `media-gallery-public.e2e-spec.ts` (W02 B-1's four scenarios, kept), `apps/core/src/media-wiring.e2e-spec.ts`, `apps/worker/src/media-wiring.e2e-spec.ts`, `apps/projector/src/media-wiring.e2e-spec.ts` and `apps/lambdas/src/handlers/media-processing.e2e-spec.ts` (the real applications and the real Lambda handler). Unit specs: `pnpm test -- libs/domains/media libs/infrastructure/antivirus libs/infrastructure/storage libs/common/config`.

Expected: every file's summary shows 0 failed; the unit run covers AS-13–AS-16, AS-27–AS-28, AS-49, AS-59 and the declared artifacts of AS-60/AS-61.

## Scenario inventory (L-017)

| Scenarios | Where they are proven |
|---|---|
| AS-01–AS-10 | `media-upload.e2e-spec.ts` (AS-05's outage case is the last `describe`); the journey in `media.e2e-spec.ts` |
| AS-11 | `media-processing.e2e-spec.ts`; the Lambda handler in `apps/lambdas/src/handlers/media-processing.e2e-spec.ts` |
| AS-12, AS-17–AS-24 | `media-processing.e2e-spec.ts` (AS-23 and AS-24 through a TCP fault proxy in front of MinIO) |
| AS-13–AS-16 | `infra/image-pipeline.spec.ts` (real libvips), with AS-13 and AS-16 repeated end to end in `media-processing.e2e-spec.ts` |
| AS-25, AS-26, AS-28 (cap), AS-29 | `media-duplicates.e2e-spec.ts`; the walk in `media.e2e-spec.ts` |
| AS-27, AS-28 (recall) | `domain/duplicate-match.spec.ts` (table-driven and `fast-check`) |
| AS-30–AS-37 | `media-gallery.e2e-spec.ts` |
| AS-38 | `media-gallery.e2e-spec.ts` and `media-gallery-public.e2e-spec.ts` (the four W02 B-1 scenarios of the first version, kept) |
| AS-39, AS-40 | `media-consumers.e2e-spec.ts`; `apps/projector/src/media-wiring.e2e-spec.ts` (the groups register) |
| AS-41–AS-46 | `media-read.e2e-spec.ts` |
| AS-47, AS-48, AS-50, AS-54 | `media-lifecycle.e2e-spec.ts` |
| AS-49 | `domain/media-status.spec.ts` |
| AS-51–AS-53 | `media-lifecycle.e2e-spec.ts`; `apps/worker/src/media-wiring.e2e-spec.ts` (a job runs through the real registry) |
| AS-55–AS-58 | `media-events.e2e-spec.ts` (AS-58 also `libs/common/config/media-config.spec.ts`) |
| AS-59 | `media-barrel.spec.ts`; `check:table-ownership`, `check:boundaries` |
| AS-60, AS-61 | `media-ops-artifacts.spec.ts` proves the artifacts say what the scenario says; the measurements are the "not run" rows below |
| First version, `media.e2e-spec.ts` (3 tests) | kept as `media.e2e-spec.ts` (presign, processing with idempotent re-run and rejection, flagged copy), now through the new routes |
| First version, `media-gallery-public.e2e-spec.ts` (4 tests) | kept as `media-gallery-public.e2e-spec.ts` with the same four expectations, on the R1 visibility rules |

## Static gates (AS-59)

```bash
pnpm --dir packages/backend check:table-ownership --strict    # media: 0 findings
pnpm --dir packages/backend check:boundaries                  # media: 0 findings
pnpm --dir packages/backend exec tsc --noEmit -p tsconfig.json
python3 scripts/livespec/check.py                            # docs/spec/capabilities/S29-photos.md anchors true
```

`.tx.baseline` for this domain stays at its current value (the four direct sites are S30's `video.service.ts`).

## Wiring check (L-004, L-015)

Start the real apps after the last change to imports, events or start-up hooks: `apps/core` (routes mounted, `MediaModule` loads), `apps/worker` (three jobs registered), `apps/projector` (two consumers declared), and import the Lambda handler (`node -e` on the built bundle or the lambda-local runner). A presign → upload to MinIO → complete → processing → `GET /media/:id` → gallery `PUT` walk-through on the fresh stack is the buy-flow equivalent for this capability.

### Wiring check notes (T080, T088)

- Real applications: `CoreModule` (routes mounted, `MediaQueryService` resolves), `WorkerModule` (three job types declared, three schedules registered, an enqueued expiry job is run by the real registry) and the projector composition (both consumer groups register) start in their wiring specs; the Lambda handler is imported and run against Postgres and MinIO. Importing `MediaModule` next to `DiscoveryModule` once failed with a duplicate `media.gallery_changed` definition (S32's local copy): fixed by re-exporting media's definition from `discovery/domain/consumed-events.ts`.
- Dev stack: the three migrations were applied (`pnpm run db:migrate:up`), `scripts/infra/boot-check.sh --wait 120` reported "the monolith is ready" and `scripts/infra/doctor-live.sh` "the stack is healthy". Queue `media-processing` with its DLQ and the bucket exist (`scripts/infra/doctor.py --only queues,buckets`: 0 missing).
- Not done here: a throwaway empty stack (`scripts/qa/fresh-run.sh` without `--here`) cannot start while the dev stack is up; the migration spec starts from the legacy schema on an empty scratch database instead, and the test database was migrated from where it stood.

## Ops artifacts (not proven by an automated test; status "not run", see `specs/UNVERIFIED.md`)

| Criterion | How to run it |
|---|---|
| SC-001: 95% of valid photos ≤ 5 MB are READY within 10 s of `complete`, with 1,000 photos queued | from `packages/backend`: `node -r ./scripts/preload-contracts.cjs -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/load-tests/media-throughput.mjs --images 1000 --workers 1,2,4` against the VPS stack; read `uploadToReadyP95Seconds` |
| SC-005 / AS-61: upload permission p95 < 300 ms at 600 req/s, no image byte on the API | `k6 run scripts/load-tests/media-presign.k6.js` (600 req/s, 2 min) |
| AS-60: originals private, IA after 30 days, archive after 180, incomplete uploads aborted; media origin sends `nosniff`, the immutable cache header and no cookies | after deploy: `bash scripts/ops/check-media-origin.sh <origin> <sample-variant-key>` and `terraform plan` shows no drift in `infra/modules/s3_cloudfront` |
| SC-002 / SC-004 at full corpus size (1,000 images, 100 with GPS; fixture corpus of re-saved copies) | the e2e/unit suites prove 100% on a generated corpus (sizes stated in the tests); the 1,000-image run is the throughput script with `--verify-metadata` |
