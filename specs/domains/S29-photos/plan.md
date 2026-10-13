# Implementation Plan: S29 — Product and review photos (domain `media`)

**Branch**: `S29-photos` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-61, FR-001–FR-100, SC-001–SC-009), `test-plan.md`, `gaps.md` (A1–A9, B1–B11, C1–C3, D1–D4, E1–E7, F1–F3, debt D-6/D-7/D-8/D-12, C-1–C-5), `questions.md` (defaults accepted as written; the file has no human edit), the constitution, and the follow-ups left by S05, S32, S49, S50, S53 and W02 (below).

## Summary

Rebuild the photo half of `media` (video, S30, is not touched) so that an image is never visible before it is proven safe, a worker run is idempotent and bounded, and every state change is a conditional update with a history row and an outbox event:

1. **Upload** (`apps/core`): two presign routes → pending-upload quota → one transaction (`Media` row + history) → local signature with an exact content-type list, 1…15 MiB body and the server-generated key; no storage or queue call inside the transaction (R-4). `complete` heads the object, re-checks its size, moves `PENDING_UPLOAD → UPLOADED` conditionally and enqueues after commit; replays answer from the state.
2. **Process** (`createMediaProcessor`, run by `apps/lambdas` and testable in Nest): claim with a 5-minute lease and attempt counter (`BUSY`/`SKIPPED`/cap) → malware scan (port, 15 s) → header checks (50 MP, one frame, allowlist) → orientation, sRGB, metadata dropped, three never-upscaled WebP variants, content-addressed, 10 s per write, 45 s per run → existence check of all three → **one transaction**: band advisory locks, nearest-match scan (product photos only), `→ READY`, history, `media.ready` (+ `media.duplicate_suspected`) via `appendWithExecutor` (R-1–R-7).
3. **Read**: `GET /media/:id` (public for READY, owner/member view otherwise, one `404` for everything else), `GET /batch/media`, `MediaQueryService.getReadyMediaByIds` (R1), member and public gallery reads; URLs only on the configured media origin (R-9).
4. **Gallery**: `PUT` with `expectedVersion` under a row lock on `ProductGallery`, product through S05 R1, per-photo `failures`, `media.gallery_changed`; the public read follows product and shop visibility through S05/S03 (R-8).
5. **Lifecycle**: soft delete, three single-run jobs (expire, re-drive, purge), two projector consumers (`catalog.product_deleted`, `tenancy.shop_deleted`) (R-11).
6. **Operate**: required configuration with startup validation, eight metrics, structured logs with propagated trace, four rate-limit policies, Lambda wired through the exported factory, barrel reduced to the Provides list, ownership registry moved (`ProductMedia`, `ProductGallery`, `MediaStatusHistory` → `domain:media`), expand/contract migrations (R-12–R-15).

No new deployable app (I.6): `MediaModule` stays in `apps/core`, `MediaWorkerModule` joins `apps/worker`, `MediaProjectorModule` joins `apps/projector`, the processor stays the existing `media-processing` Lambda.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, sharp/libvips in `infra/`
**Primary Dependencies**: `TransactionRunner` / `@Transactional` (S54), `OutboxService` + `appendWithExecutor` (S53), `defineEvent`, projections framework `Projector` (S53), `declareJobType` / `upsertSchedule` (S49), `definePolicies` / `@RateLimit` (S50), `ObjectStorage` and `TaskQueue` ports (extended additively), new `MalwareScanner` port in `libs/infrastructure/antivirus`, `ProductQueryService.getProductsByIds` (S05), `ShopAccessService`, `ShopQueryService`, `ShopScoped` (S03), `Firewall` (S01), `Clock`, metrics registry (S54)
**Storage**: PostgreSQL (`Media`, `MediaStatusHistory`, `ProductMedia`, `ProductGallery`, owner `media`), S3-compatible bucket (MinIO in tests), Outbox (infrastructure table, written through the lib's append only), Redis (rate limits only)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` — eight files named in `test-plan.md`; unit specs `domain/media-status.spec.ts`, `domain/duplicate-match.spec.ts` (fast-check), `infra/image-pipeline.spec.ts` (real libvips); static: `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `python3 scripts/livespec/check.py`
**Target Platform**: Linux; `apps/core`, `apps/worker`, `apps/projector`, `apps/lambdas` (media-processing)
**Project Type**: backend domain module + contracts + Lambda wiring + infra module edit; web is W04's
**Performance Goals**: presign p95 < 300 ms at 600 req/s (SC-005, ops artifact), 95% READY ≤ 10 s (SC-001, ops artifact); reads: one statement per request
**Constraints**: 15 MiB / 50 MP / 3 widths; read 20 s, variant write 10 s, scanner 15 s, run 45 s, lease 5 min, 5 attempts; Lambda timeout 60 s; no I/O inside a DB transaction
**Scale/Scope**: 100k photo views/s (served from the media origin, not the API); 20 photos per gallery; candidate scan ≤ 4 × 500 rows per processed product photo

**Connection arithmetic (III.12)**: the Lambda pool is `max: 2` per container (unchanged); Lambda concurrency is capped by the event-source mapping (`scaling_config.maximum_concurrency` in `infra/modules/lambda_sqs_worker/main.tf:131`, value from the module call for `media-processing`, unchanged; WP-11 writes the product cap × 2 next to it and checks it stays below the RDS Proxy limit). The READY transaction holds one connection for the lock + scan + update (target < 50 ms) and takes no network I/O. API and worker use the shared Sequelize pool; the three jobs run one batch at a time (S49 lease), so +1 connection per worker replica.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| I Layers | PASS after work (D-6, E6, B8) | repository ports and `SqlRunner` in `domain/ports.ts`, `PgMediaRepository` in `infra/`; `application/` imports no `infra/` and no `sequelize`; hashing/matching/status table in `domain/` with an injected clock; sharp stays in `infra/` |
| II Pipeline | PASS after work | thin controllers; request bodies by contract schemas through the global pipe (unknown fields rejected); record-level authorization in the query (III.4); problem+json codes from one table |
| III Data | PASS after work | all SQL in `infra/`; transitions are conditional updates + history (III.7); gallery serialised by `FOR UPDATE`, near-duplicates by advisory locks (III.6); no S3/queue/R1 call inside a transaction (III.3); principal in every owned-record predicate (III.4); expand/contract with `lock_timeout` (III.11) |
| IV Messaging | PASS after work | outbox only; consumers declare `idempotency: natural`, validate with zod, dead-letter; timeouts on every outbound call; retries only through the queue (IV.6); scanner behind a port (IV.8) |
| V Contracts | PASS after work | nine schemas in `packages/contracts/src/media`; no model serialised; 5xx details generic; `GET` changes no state |
| VI Frontend | N/A (W04) | gaps bullet for W04 |
| VII Tests | PASS after work | 61 scenarios mapped in `test-plan.md`; faults by TCP proxy and a Postgres trigger, not mocks; only scanner, clock and queue transport faked; `Promise.all` for AS-09/21/29/35 |
| VIII Operations | PASS after work | startup validation (R-13); eight metrics; structured logs; jobs single-run |
| IX Isolation | PASS after work | `check:table-ownership --strict` 0 for `media`; `ProductMedia` moved; FKs dropped; Outbox via lib; reads of product/shop through R1; events carry the ids consumers need (IX.8 `mediaVersion`) |
| X Monorepo | PASS after work (D-8) | barrel = Provides list; `MediaProcessor`, `Sql`, `MEDIA_QUEUE` leave it; Lambda imports `createMediaProcessor`; `media` imports `antivirus` lib, not `catalog-sync` |

Post-design re-check: PASS. Risks: (a) a scanner outage stalls all uploads (by decision: fail closed; the queue backs off, the re-drive job re-sends) — metric `media_scan_unavailable_total` is the alarm; (b) advisory locks on four bands serialise concurrent product-photo READY transactions that share a band value — only near-identical hashes collide, so contention is limited to genuine duplicates; (c) `ProductMedia` ownership move touches `db/ownership.ts` and `domain-map.md` that S05/catalog also read — catalog never queried it (checked by grep over `packages`: only `db/ownership.ts`, `media.service.ts` and `media-gallery-public.e2e-spec.ts` mention `ProductMedia`; the spec's fixture inserts become the media suites' own fixtures); (d) breaking contract changes (list in `contracts/media-api.md`) hit W04 and S25 text only; no web code exists.

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S29** (`getProductsByIds`): the `JOIN "Product"` in `attachToProduct` is deleted; `GalleryService` and the public gallery read use `getProductsByIds([id], {shopId?})` once per request (R-8). The `ProductMedia` read/write is `media`'s alone; S05 gets no query. Test: AS-30/AS-34/AS-38 in `media-gallery.e2e-spec.ts`; `check:table-ownership --strict` shows 0 (AS-59). `ProductModule` import in `media.module.ts` is replaced by the catalog entry point that exports `ProductQueryService` (as today) — no model.
2. **S32 → S29**: publish `media.gallery_changed v1 {productId, shopId, mediaIds, galleryVersion}` (WP-8) and export `MediaQueryService.getReadyMediaByIds` (WP-7); `MediaProjectorModule` loadable in `apps/projector` (it imports no storage/queue/catalog module — R-11; proven by a boot test in `media-consumers.e2e-spec.ts` that builds a module with only `MediaProjectorModule` and the platform modules). S32's switch from the null image resolver is a bullet in `gaps.md` (not editable here). `urls.thumb` is in `MediaDto.urls`.
3. **S49 → S29**: three `declareJobType` calls with payload contracts next to the `JobPayloads` augmentation; `upsertSchedule` errors caught as `InvalidScheduleError`; no `cancel` used (WP-9). Test: `MediaWorkerModule` boots inside the real `apps/worker` module (L-004/L-015) and each handler runs through the job registry in `media-lifecycle.e2e-spec.ts`.
4. **S50 → S29** (G-35): `discussion.write` leaves `media.controller.ts`; four own policies declared in `media/rate-limit-policies.ts` (WP-5, R-10). Sibling bullet for S25 in `gaps.md` (its `discussion.write` budget is no longer shared).
5. **S53 → S29** (G-51): the raw `INSERT INTO "Outbox"` at `media/infra/media-processor.ts:70` is deleted; events go through `appendWithExecutor` (Lambda/processor) or `OutboxService.append` (Nest) (R-7). Test: `media-events.e2e-spec.ts` rollback trigger (AS-56).
6. **W02 → S29**: `GET /products/:productId/gallery` (AS-38) already exists from W02's B-1 (`media.controller.ts:76`, `media-gallery-public.e2e-spec.ts`, 4 tests). The plan keeps those four scenarios (L-017), moves the visibility check from `ProductQueryService.isPubliclyVisible` to R1 `getProductsByIds` + S03 `getShopsByIds` (sandbox/shop state per AS-38), and validates the response with `galleryPublicSchema`. Not re-implemented, not dropped.
7. **S54 toolkit / transactions**: every new transaction uses `TransactionRunner.run`; the Lambda's `pg` `BEGIN/COMMIT` is a framework-free adapter (`tx` dependency), not a `sequelize.transaction` site. `media` has 4 direct sites, all in `video.service.ts` (S30; each keeps its `// S54 T037 audit` comment, untouched here: `.tx.baseline` is 4 and must stay 4). `media.service.ts` has none.
8. **gaps.md items**: all of A1–A9, B1–B11, C1–C3, D1–D4, E1–E7, F2–F3, C-1–C-5 and the debt rows are covered by the work packages (traceability table at the end of `research.md`); F1 (web) is W04's and recorded as a sibling bullet.
9. **Living specification**: `docs/spec/capabilities/` has no `S29-*.md` page (S25's is the model). Per rule (0) the last work package adds `docs/spec/capabilities/S29-photos.md` (rules and behaviours first, `[proof: …]` / `[code: …]` anchors) and validates it with `python3 scripts/livespec/check.py`. W02's page may mention the gallery read: if it carries a `[code:]` anchor to a line this plan moves, the anchor is updated and any `*.reviewed.json` human sign-off over it is reported under "## Spec changes" in `gaps.md` (no `*.reviewed.json` is created or edited).
10. **Unverified criteria** (rule 2): SC-001, SC-005, AS-60, AS-61 are in `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md` (done at plan time, status "not run").

## Project Structure

### Documentation

```text
specs/domains/S29-photos/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/media-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/contracts/src/media/{media.ts,gallery.ts,events.ts,index.ts}      # nine schemas, problem codes, mediaEventSchemas
packages/backend/
├── migrations/…-media-s29-{expand,backfill,contract}.js                   # R-12
├── db/ownership.ts                                                        # ProductMedia → media; + ProductGallery, MediaStatusHistory
├── libs/common/config/{types.ts,api-config.service.ts,config-rules}       # required media keys, scanner switch
├── libs/infrastructure/antivirus/{malware-scanner.ts,clamd-scanner.ts,fake-scanner.ts,index.ts}   # moved from catalog-sync (shim stays)
├── libs/infrastructure/storage/{object-storage.port.ts,s3-object-storage.ts,in-memory-object-storage.ts}   # additive options
├── libs/domains/media/
│   ├── api/{media.controller.ts,gallery.controller.ts,batch.controller.ts,media-problem.ts}   # video.controller.ts untouched
│   ├── application/{upload.service.ts,media-read.service.ts,media-delete.service.ts,gallery.service.ts,
│   │               media-query.service.ts,expire-uploads.service.ts,requeue-stuck.service.ts,purge.service.ts,
│   │               events/media-events.ts}                                 # media.service.ts deleted
│   ├── domain/{media-status.ts,reject-code.ts,duplicate-match.ts,upload-policy.ts,media-urls.ts,ports.ts}
│   ├── infra/{pg-media-repository.ts,pg-gallery-repository.ts,image-pipeline.ts,media-processor.ts (createMediaProcessor),
│   │         media-blobs.ts,media-consumers.ts,media-maintenance.jobs.ts}
│   ├── testing/{fault-proxy.ts,media-fixtures.ts,test-images.ts}
│   ├── rate-limit-policies.ts  media.module.ts  media-worker.module.ts  media-projector.module.ts  index.ts
│   └── media-{upload,processing,duplicates,gallery,consumers,read,lifecycle,events}.e2e-spec.ts
├── apps/lambdas/src/handlers/media-processing.ts                          # createMediaProcessor wiring
├── apps/{core,worker,projector}/src/*.module.ts                           # register the three modules
├── scripts/load-tests/{media-presign.k6.js,media-throughput.mjs}
└── /opt/sdd/repo/scripts/ops/check-media-origin.sh                        # post-deploy header check (AS-60)
infra/modules/s3_cloudfront/main.tf                                        # lifecycle + response-header policy (verified/edited)
docs/spec/capabilities/S29-photos.md  docs/work/architecture/domain-map.md (media and catalog sections, §4 Outbox row)
```

## Work packages (the tasks command splits these; order follows `gaps.md` §D)

| WP | Content | Gaps | Proof |
|---|---|---|---|
| 1 | Migrations (R-12), ownership registry + domain-map text, config keys and validation (R-13), `elasticmq.conf`/doctor check for `media-processing`+DLQ and bucket (L-002, L-011) | E1, E3, C-2, C-3, domain map | migration up/down on a fresh stack (L-012), config boot tests in E, `check:table-ownership` |
| 2 | Contracts package: nine schemas, problem codes, event schemas; parity test with `defineEvent` | A1, E2 | contracts-parity spec, schemas used by every e2e |
| 3 | `domain/` modules + unit specs; image-pipeline additions (header limits, codes, sRGB, multi-frame, hash from `domain/`) | B5, B8, E6, AS-13–AS-16, AS-27–AS-28, AS-49 | three unit specs |
| 3b | Antivirus lib and shim; storage port options; in-memory storage parity | B4, B6, B7 | existing S07 clamav spec, storage unit specs, new port specs |
| 4 | Repository + `createMediaProcessor` (claim, lease, cap, scan, variants, existence check, READY transaction, events, metrics, logs, timeouts) | B1–B3, B6, B9, B10, C1–C3, C-4 | P, D, E files |
| 4b | Lambda handler wiring, barrel (`createMediaProcessor` out, `MediaProcessor`/`Sql`/`MEDIA_QUEUE` removed), `MediaWorkerModule`/`MediaProjectorModule` shells | B11, E4, D-8 | app boot of core, worker, projector and the Lambda import (L-004, L-015) |
| 5 | Rate-limit policies (R-10) | A2 | U and R files (429, 503, fail-open) |
| 6 | Upload service and routes: presign (both), quota, `complete` | A3–A5, E7, C-5 | U file |
| 7 | Reads: owner/public view, batch, `MediaQueryService`, delete, URL origin, headers | A6–A9, A7 | R, L files |
| 8 | Gallery service and routes (member, public, PUT) with R1 product and S03 shop checks; fold in the W02 public-gallery spec | D1–D3, C-1 | G file |
| 9 | Consumers, three jobs (R-11) | D4 | C, L files |
| 10 | Replace `media.e2e-spec.ts` by the eight suites (scenario inventory in the commit: AS-01…AS-61 each map to a test title, L-017); delete the old file only after its three scenarios are matched | E5 | all |
| 11 | Ops artifacts: k6 + throughput scripts, `s3_cloudfront` lifecycle/headers and the post-deploy header check script | F2, F3 | quickstart Ops artifacts (not run) |
| 12 | Living spec page, UNVERIFIED rows check, `check:boundaries`, `check:table-ownership --strict`, `.tx.baseline` still 4, full capability suite once, fresh-stack run (L-012), real API start (L-004) | AS-59 | gates |

Each WP is small enough for the 5-attempt rule; a test failing five times after fixes goes to `questions.md` as a blocker.

## Known failure classes applied

- **L-015/L-004**: WP-4b/12 start the real `apps/core`, `apps/worker`, `apps/projector` and import the Lambda handler; no test builds only a private module for wiring.
- **L-010**: the presign route creates a new slot each call by design; `complete`/`DELETE`/job replays are idempotent (409/200/404, never a duplicate).
- **L-001**: `enqueue` for `media-processing` (standard queue) never passes `groupId`; the re-drive job uses `enqueueBatch` with no FIFO options.
- **L-002/L-011**: queue, DLQ and bucket verified against `elasticmq.conf`/MinIO setup and the doctor in WP-1.
- **L-003**: the scanner "down" and fault-proxy tests assert the exact outcome (`PROCESSING`, attempts+1, no event), never "A or B".
- **L-005/L-006**: every test creates its own shop, user, product and photos; no seeded stock used.
- **L-007/L-008**: fake timers for the 20 s/45 s cuts; each e2e file in its own process; the capability suite runs in batches.
- **L-013**: fault proxy and outbox trigger are removed in `afterEach`/`finally` so the next test never sees the damage.
- **L-017**: scenario inventory (AS-xx → test title) kept in the tasks and checked before `media.e2e-spec.ts` and `media-gallery-public.e2e-spec.ts` are removed.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| `SqlRunner` indirection under the repository | one repository for Nest (CLS transaction) and the Nest-free Lambda | two implementations drift (the present state, D-6/D-8) |
| Advisory locks on four band values | AS-29: two simultaneous copies must see each other | `SERIALIZABLE` causes retry storms; a table-wide lock serialises every upload |
| Three migrations (expand/backfill/contract) | III.11 forbids single-step column drops and FK drops under running code | one migration breaks the rolling deploy |
