# Implementation Plan: S30 — Product video and VOD (domain `media`)

**Branch**: `S30-video` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-62, FR-001–FR-100, SC-001–SC-010), `test-plan.md`, `gaps.md` (A1–A8, B1–B15, C-1–C-9, D1–D7, E1–E4, F1–F4, G1–G10, debt D-6/D-7/D-8/D-12), `questions.md` (defaults accepted as written; the file has no human edit), the constitution, and the follow-ups left by S48, S49 and S29 (below).

## Summary

Rebuild the video half of `media` (photos, S29, are built and are not touched except the barrel line for `VideoModule`):

1. **Upload** (`apps/core`): start → one transaction under a per-shop advisory lock (quota ≤ 10 `UPLOADING`, row + history) → storage multipart create **outside** the transaction (5 s limit) → part permissions signed locally, each bound to part number and exact length; resume lists the storage's parts and re-signs the missing ones without moving `expiresAt`; `complete` compares the client's list with the storage's list, claims `UPLOADING → UPLOADED` conditionally, assembles once, checks the size, moves to `PROCESSING` with the `probe` task and sends the first message after commit (R-1–R-5).
2. **Pipeline** (`apps/worker`): a pure graph (`probe` → `poster` ∥ `thumbnails` ∥ `transcode:<rung>`… → `package` → `publish`) stored after `probe`; claim from `QUEUED` or an expired 5-minute lease, `DONE` fenced by the claimed attempt, each attempt writing its own output location, retries 30 s / 120 s as delayed messages, permanent failures at once, optional `thumbnails` ends `SKIPPED`, a bounded child-process runner (argument list, kill on timeout/abort/shutdown, 4 KB of stderr / 1 MB of stdout kept), `package` verifies storage and builds the master from measured values, `publish` is a guarded conditional update with history and `video.ready` in one transaction (R-6–R-12).
3. **Delivery** (`apps/core`): anonymous playback; public videos on `/p/<id>/` unsigned; unlisted on `/u/<id>/` behind the share token and a 4-hour signed credential (cookie on the configured parent domain, one path pattern), 503 and never an unsigned URL when signing is missing; originals under a private prefix outside every delivery path; `GET /products/:id/videos` (R-13–R-15).
4. **Manage**: read, keyset list, optimistic edit and product link (R1 batch read), retry (≤ 3, resumes from the last finished task), soft delete; every lookup carries the shop; one `404` for foreign/unknown (R-16).
5. **Lifecycle**: three single-run jobs (`media.video-expire-uploads`, `media.video-requeue-stuck`, `media.video-purge`), three projector consumers (`catalog.product_deleted`, `tenancy.shop_deleted`, `tenancy.shop_status_changed` → `VideoShopState`) (R-17, R-18).
6. **Operate**: events through the outbox in the state change's transaction, nine metrics, structured logs with propagated trace and `token` redaction, three rate-limit policies, required configuration validated at startup, graceful shutdown (kill encoders, re-queue without an attempt, pools last), barrel reduced to the Provides list, `VideoStatusHistory`/`VideoShopState` registered, foreign keys dropped by expand/contract (R-19–R-22).

No new deployable app (I.6): `VideoModule` joins `apps/core`, `VideoWorkerModule` joins `apps/worker` (the Docker image already installs ffmpeg for `APP=worker`), `VideoProjectorModule` joins `apps/projector`.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, ffmpeg/ffprobe via `child_process.spawn` in `infra/`
**Primary Dependencies**: `TransactionRunner` / `@Transactional` (S54), `OutboxService.append` + `defineEvent` (S53), `Projector` framework (S53), `declareJobType` / `upsertSchedule` (S49), `definePolicies` / `@RateLimit` (S50), `ObjectStorage` and `TaskQueue` ports (extended additively), new `DeliveryEdge` port in `libs/infrastructure/delivery-edge`, `ProductQueryService.getProductsByIds` (S05), `ShopScoped` (S03), `Firewall` (S01), `Clock`, metrics registry and `ConfigRules` (S54), `@aws-sdk/cloudfront-signer` (already a dependency), `fast-check` (already used by S29)
**Storage**: PostgreSQL (`Video`, `VideoTask`, `VideoStatusHistory`, `VideoShopState`; owner `media`), S3-compatible bucket (MinIO in tests; private source prefix, public and unlisted delivery prefixes), Outbox (through the lib), Redis (rate limits only)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` — six files named in `test-plan.md`; six unit specs beside the code; contract parity spec; static: `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `python3 scripts/livespec/check.py`
**Target Platform**: Linux; `apps/core`, `apps/worker` (CPU-heavy, long-lived, ffmpeg installed), `apps/projector`
**Project Type**: backend domain module + contracts + three app registrations + infra module edit; web is W04/W02's
**Performance Goals**: playback p95 < 150 ms at 1,000 req/s with 0 database writes (SC-006, ops artifact; AS-40 proves the 0 writes); 95% of 5-minute 1080p `READY` ≤ 10 min (SC-001, ops artifact)
**Constraints**: 20 GiB / 64 MiB parts / 24 h session / 1 h part URLs; no storage, queue or R1 call inside a database transaction (III.3); lease 5 min, 3 attempts, backoff 30/120 s (SQS delay cap 900 s), task limit `max(600 s, 3×duration)` ≤ 3 h, `PROCESSING` limit 6 h; SQS visibility 900 s extended by heartbeat
**Scale/Scope**: 62 acceptance scenarios; 11 HTTP routes; up to 320 parts per upload; ≤ 7 tasks per video (probe, poster, thumbnails, ≤ 4 renditions, package, publish → ≤ 9); 450-video shop deletion in batches

**Connection arithmetic (III.12)**: API and worker share the Sequelize pool. A transaction holds one connection and does no network I/O (the longest is the 450-row batch, 50 videos per transaction). The worker runs 2 tasks per instance; a running task holds **no** connection while ffmpeg runs (claim, heartbeat and completion are separate short statements). The three jobs run one batch at a time under the S49 lease (+1 connection per worker replica). The advisory locks (start quota, product link) are transaction-scoped.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| I Layers | PASS after work (D-6, B15) | `domain/` holds the status table, graph, ladder, master builder, probe rules, limits, path builders and the ports (`VideoStore`, `TranscoderPort`, `DeliveryEdge` token); `application/` imports no `infra/`, no `sequelize`, no SDK; `infra/` holds the SQL, the ffmpeg runner and the edge adapter; `video.service.ts` is deleted |
| II Pipeline | PASS after work | thin controllers; bodies parsed by contract schemas through the global pipe (unknown fields rejected); every record lookup has the shop in the predicate (III.4); problem codes from one table (`video-errors.ts`) |
| III Data | PASS after work | all SQL in `infra/`; every transition a conditional update + history row (III.7); quotas by transaction advisory locks (III.6); storage/queue/R1 calls outside transactions (III.3, asserted by a transaction-scoped query log in AS-10); expand/contract with `lock_timeout` (III.11); `.tx.baseline` 4 → 0 (all four `// S54 T037 audit` sites disappear with the file) |
| IV Messaging | PASS after work | outbox only; consumers declare `idempotency: natural`/version guard, validate with zod, dead-letter; every outbound call has a timeout; retries only through the delayed queue message, transient causes only (IV.6) |
| V Contracts | PASS after work | eleven schemas in `packages/contracts/src/media/video.ts`; no model serialised; generic 5xx detail; `GET` changes no state (playback writes nothing) |
| VI Frontend | N/A (W04/W02) | sibling bullets in `gaps.md` |
| VII Tests | PASS after work | 62 scenarios mapped; faults by TCP proxy, stub encoder on `PATH` and a Postgres trigger, not mocks; only clock, edge signer key/removal spy and queue transport faked; `Promise.all` for AS-05/12/22/23/27/44/45/46/49; ffmpeg real; **blocked, never skipped** when the binary is missing (L-003) |
| VIII Operations | PASS after work | startup validation (AS-58), nine metrics, structured logs, jobs single-run, graceful shutdown ordering (VIII.4, AS-62) |
| IX Isolation | PASS after work | `check:table-ownership --strict` 0 for `media`; FKs to `Shop`/`User` dropped; product and shop knowledge only by R1 (`getProductsByIds`) and R3 (`VideoShopState`, `catalog.product_deleted`); `videoVersion` in events (IX.8) |
| X Monorepo | PASS after work (D-8) | barrel = Provides list (`VideoModule`, `VideoWorkerModule`, `VideoProjectorModule`, event definitions, schemas); `VideoService`, `Sql`-like helpers not exported; the encoder runner stays in `media/infra` (X.7); `delivery-edge` is a new infrastructure lib used by `media` only for now |

Post-design re-check: PASS. Risks: (a) **MinIO may not enforce the signed `Content-Length` of a presigned part** (AS-08 b) → WP-0 spike first; fallback and stop rule in R-3; (b) **ffmpeg/ffprobe are not installed in this workspace** (`ffmpeg -version` fails) → WP-0; pipeline suites report *blocked*, never skip silently, and the 5-attempt rule does not apply to a missing binary; (c) the loser of two concurrent `complete` calls waits for the winner (≤ 10 s) before driving the step itself (R-5); (d) lease/expiry arithmetic takes the injected `Clock` value as a SQL parameter (as S29 does) so the frozen clock can drive it; the spec's "database time" edge case is honoured as "one clock for write and compare, lease ≫ skew" — documented in R-8 (the same fleet-wide value is used by every worker that compares); (e) breaking contract changes (list in `contracts/video-api.md`) hit W02/W04 only; no web code exists; (f) the CDN host/lifecycle work (G8, AS-60) is an operations artifact in the infrastructure code, not an API test.

## Follow-ups from built sibling specs (treated as requirements)

1. **S48 → S30** (replace the BFF's own schema): `productVideosSchema` moves from `packages/contracts/src/bff/upstream.ts` to `packages/contracts/src/media/video.ts` with the spec's shape `{items:[{videoId,title,posterUrl,durationSec}]}`; the BFF copy is deleted and its importers (`bff/product-page.ts:14`, `libs/composition/bff/upstream/endpoints/video.ts`, `libs/composition/bff/testing/fixtures.ts`) import the package one; the exported name is unchanged; the BFF fixtures are updated to the real shape so a drift shows as `UPSTREAM_INVALID` (WP-2). The BFF's other video endpoint (`videoPlaybackSchema`, W02 B-7) already exists in `media/video.ts` and is kept: `spriteUrl` stays tolerant of absence for old parsers, the server always sends `null` (AS-31).
2. **S48 → S30** (not built → built): S30 gets its `.implemented` marker through the normal flow; the BFF's `UPSTREAM_NOT_FOUND` degradation continues to hold for anything not yet served. A BFF-level check that the real route answers the BFF schema is added to `video-delivery.e2e-spec.ts` (AS-38 parses with the same exported `productVideosSchema` the BFF uses).
3. **S49 → S30**: three `declareJobType` calls (`media.video-expire-uploads`, `media.video-requeue-stuck`, `media.video-purge`) with `z.object({}).strict()` contracts next to the `JobPayloads` augmentation, exactly as S29's `media-maintenance.jobs.ts`; `upsertSchedule` errors are caught as `InvalidScheduleError`; nothing calls `JobsService.cancel`. Test: `VideoWorkerModule` boots inside the real `apps/worker` module (L-004/L-015) and each handler runs through the job registry in `video-lifecycle.e2e-spec.ts`.
4. **S29 → S30** (same domain): `VideoModule`, `VideoWorkerModule` and a new `VideoProjectorModule` stay exported; no reuse of photo tables/statuses/events; `VideoService` leaves the barrel; job and policy namespaces `media.video-*` / `video.*`; the shared storage-port additions (`put` with cache-control/timeout, `head` size) are extended, not replaced.
5. **S27 → S30** (host `stream.marketplace.dev`): `video_cdn_url` setting, public master at `/p/<videoId>/master.m3u8` (FR-040); asserted in `delivery-paths.spec.ts` and AS-31.
6. **S54 toolkit / transactions**: every transaction uses `TransactionRunner.run`; the four direct `sequelize.transaction` sites in `video.service.ts` (lines 104, 155, 234, 376, each with its `// S54 T037 audit` comment) disappear with that file; `.tx.baseline` (4) must end at 0 and never rise.
7. **gaps.md items**: all of A1–A8, B1–B15, C-1–C-9, D1–D7, E1–E4, F1–F4, G1–G10 and the debt rows D-6/D-7/D-8/D-12 are covered by the work packages (traceability table at the end of `research.md`); F3/G10 (web) are W04/W02's and recorded as sibling bullets in `gaps.md`; G7 (domain map) is WP-1; G8 (CDN) and G9 (CI image) are WP-13.
8. **Living specification**: `docs/spec/capabilities/` has no `S30-*.md` page. Per rule (0) WP-0 writes the page's rules and behaviours **first** (`S29-photos.md` is the model: front matter, purpose, entry points, rules, behaviours); the last work package adds the `[proof: …]` / `[code: …]` anchors and runs `python3 scripts/livespec/check.py`. No `*.reviewed.json` is created or edited; the only existing page that may name a moved line is W02's (the BFF/product page); if a signed page's `[code:]` anchor moves, `gaps.md` records it under "## Spec changes".
9. **Unverified criteria** (rule 2): SC-001, SC-002 (at 20 GiB), SC-006, SC-008 (edge propagation), AS-60, AS-61 are under "Ops artifacts" in `quickstart.md` and as rows in `specs/UNVERIFIED.md` (done at plan time, status "not run").

## Project Structure

### Documentation

```text
specs/domains/S30-video/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/video-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/contracts/src/media/{video.ts,video-events.ts}                        # eleven schemas, problem codes, videoEventSchemas; productVideosSchema moves here
packages/contracts/src/bff/upstream.ts                                         # productVideosSchema definition deleted
packages/backend/
├── migrations/…-video-s30-{expand,backfill,contract}.js                       # R-19
├── db/ownership.ts                                                            # + VideoStatusHistory, VideoShopState → domain:media
├── libs/common/config/{types.ts,video-config.ts,config-rules.ts,index.ts}     # video_cdn_url, video_cookie_domain, cloudfront_*; production rule
├── libs/infrastructure/storage/{object-storage.port.ts,s3-object-storage.ts,in-memory-object-storage.ts}   # additive
├── libs/infrastructure/delivery-edge/{delivery-edge.port.ts,cloudfront-delivery-edge.ts,in-memory-delivery-edge.ts,index.ts}
├── libs/domains/media/
│   ├── api/{video.controller.ts,video-playback.controller.ts,video-problem.ts}   # photo controllers untouched
│   ├── application/{video-upload.service.ts,video-pipeline.service.ts,video-task-runner.ts,video-playback.service.ts,
│   │               video-manage.service.ts,video-lifecycle.service.ts,video-sweep.service.ts,video-purge.service.ts,
│   │               video-view.ts}                                              # video.service.ts deleted
│   ├── domain/{video-status.ts,dag.ts,hls.ts,probe-rules.ts,task-limits.ts,delivery-paths.ts,video-errors.ts,
│   │          video-events.ts,video-ports.ts}  + 6 unit specs (video-status, dag, hls, probe-rules, task-limits, delivery-paths)
│   ├── infra/{pg-video-repository.ts,pg-video-task-repository.ts,video-store.ts,ffmpeg-transcoder.ts (replaces ffmpeg.ts),
│   │         child-process.ts,video-consumers.ts,video-observability.ts}
│   ├── testing/{video-app.ts,test-videos.ts,stub-encoder.ts,outbox-trigger.ts}   # fault proxy reused from media-app.ts
│   ├── video-rate-limit-policies.ts  video-maintenance.jobs.ts  video.module.ts  video-worker.module.ts  video-projector.module.ts  index.ts
│   └── video-{upload,pipeline,delivery,management,lifecycle,events}.e2e-spec.ts   # video.e2e-spec.ts and domain/video.spec.ts replaced
├── apps/{core,worker,projector}/src/*.module.ts                                # register the modules
├── scripts/load-tests/video-playback.k6.js
└── /opt/sdd/repo/scripts/ops/check-video-edge.sh                               # post-deploy check (AS-60)
infra/modules/s3_cloudfront/main.tf (+ video host/behaviors)                    # G8
docs/spec/capabilities/S30-video.md  docs/work/architecture/domain-map.md       # media section: emits video.*, depends on tenancy/catalog
packages/web/                                                                   # untouched (W04/W02)
```

## Work packages (the tasks command splits these; order follows `gaps.md` §E)

| WP | Content | Gaps | Proof |
|---|---|---|---|
| 0 | Prerequisites and spikes: ffmpeg/ffprobe on `PATH` (or *blocked* note, L-003); MinIO presigned `UploadPart` with signed `Content-Length` rejects ±1 byte (R-3); doctor check that queue `video-transcode`(+DLQ) and the bucket exist (L-002, L-011); living-spec page rules (rule 0) | F4, G9 | spike test file kept as part of `video-upload.e2e-spec.ts` AS-08; doctor output |
| 1 | Migrations expand → backfill → contract (R-19), ownership registry, domain-map text | E1–E4, C-D12, G7 | migration up/down on a fresh stack (L-012), `check:table-ownership --strict` |
| 2 | Contracts: eleven schemas, problem codes, event schemas; move `productVideosSchema`; update BFF fixtures; parity with `defineEvent` | A1, G6, S48 | contract parity spec, schemas used by every e2e, BFF specs |
| 3 | `domain/` modules + six unit specs (+ fast-check graph property) | B6, B8, B9, B14 | unit specs |
| 4 | Storage port additions (+ in-memory + S3 + port spec); `DeliveryEdge` port + CloudFront and in-memory adapters; settings and production rule | G1, G2, C-5, C-6, C-7, D6 | port specs, config boot tests |
| 5 | Repositories, `VideoStore`, bounded child-process runner, `TranscoderPort` adapter, observability; test harness (`video-app.ts`, test clips, stub encoder, outbox trigger) | B15, B7, D-6, F4 | harness smoke inside the first e2e |
| 6 | Rate-limit policies; upload service and routes: start, resume, complete | A1–A8, B13 | `video-upload.e2e-spec.ts` |
| 7 | Pipeline: graph persistence after `probe`, claim/lease/heartbeat, fence, retry/backoff, skip, `package` verify, `publish` guard, progress, worker consumer, graceful shutdown | B1–B5, B7–B13 | `video-pipeline.e2e-spec.ts`, shutdown in `video-events.e2e-spec.ts` |
| 8 | Delivery: playback, signed credential, product list, metrics, redaction | C-1–C-9 | `video-delivery.e2e-spec.ts` |
| 9 | Management: read, list (keyset), patch, product link, retry, delete | D1, D2, C-9 | `video-management.e2e-spec.ts` |
| 10 | Events, three consumers, three jobs (sweep, expire, purge) | D3–D5, G3–G5 | `video-lifecycle.e2e-spec.ts`, `video-events.e2e-spec.ts` |
| 11 | Module split, barrel, `apps/core`/`worker`/`projector` registration, real app start (L-004, L-015) | D7, D-8 | app boot of the three apps; barrel spec |
| 12 | Replace `video.e2e-spec.ts`/`domain/video.spec.ts` by the six suites + unit specs after the scenario inventory (L-017); `video-contracts.spec.ts` kept | F1, F2 | all |
| 13 | Ops artifacts: k6 playback script, `s3_cloudfront` video host/behaviors/lifecycle, `check-video-edge.sh`, CI image ffmpeg note | G8, G9, F3 | quickstart "Ops artifacts" (not run) |
| 14 | Living-spec anchors + `check.py`, `check:boundaries`, `check:table-ownership --strict`, `.tx.baseline` 0, whole capability suite once in batches, fresh-stack run (L-012) | AS-59 | gates |

Each WP is small enough for the 5-attempt rule; a test failing five times after fixes goes to `questions.md` as a blocker.

## Known failure classes applied

- **L-015/L-004**: WP-11/14 start the real `apps/core`, `apps/worker`, `apps/projector`; no test builds only a private module for wiring (AS-59 boots from the barrel *and* the apps are started).
- **L-010**: `start` creates a new slot per call by design (spec edge case); `complete`, `retry`, `DELETE`, the consumers and the jobs are idempotent (202/200/409/404, never a second effect).
- **L-001**: `video-transcode` is a standard queue: `enqueue` passes `delaySeconds` and `attributes` only, never `groupId`/`dedupeId`; delay values are 30 and 120 (≤ 900) and validated where the message is created (`enqueue` already rejects bad options before the network).
- **L-002/L-011**: `video-transcode` and `video-transcode-dlq` exist in `elasticmq.conf` (lines 61–62, checked); WP-0 adds the readiness/doctor comparison for queue and bucket; the delivery bucket prefixes are created by the code, not by a seed.
- **L-003**: no "A or B" assertions; the MinIO-length spike, fault-proxy and stub-encoder tests assert the exact status, attempt count and state; a missing binary is reported *blocked*.
- **L-005/L-006**: every test creates its own shop, user, product and video; no seeded product stock used.
- **L-007/L-008**: fake timers for backoff/lease; each e2e file in its own process; the capability suite runs in batches; test clips are short (6 s) and low-bitrate.
- **L-013**: fault proxy, stub encoder dir on `PATH`, outbox trigger and edge-removal failure are removed in `afterEach`/`finally`.
- **L-016**: the sweep and the purge survive a failing edge call or a missing object (not an error), and `complete` driven twice after a half failure re-heads the source instead of failing on `NoSuchUpload`.
- **L-017**: scenario inventory (current tests → AS-xx → new test title) is part of WP-12: *waves in the order probe → poster+rungs → package → publish*, *fan-in exactly once*, the three pure checks of `domain/video.spec.ts`, and W02 B-7 (`video-contracts.spec.ts`, public + unlisted + no-sprite bodies) are each matched before the old files are removed.

## Complexity Tracking

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Transaction advisory locks for the 10-pending and 10-per-product quotas | AS-05/AS-45: the store, not the application, must hold the invariant under `Promise.all` | a counter row adds a table and a repair job; `SERIALIZABLE` causes retry storms |
| Start in two transactions around a storage call | III.3 forbids the storage call inside a transaction; AS-07 needs no usable slot after a failure | one transaction holds a connection for the storage timeout |
| Loser of a concurrent `complete` waits then drives | AS-12: both answer `202 PROCESSING`, one assembly | answering `202 UPLOADED` breaks the contract; a distributed lock adds a dependency |
| Per-attempt output locations | AS-26: libx264 is not bit-exact; identical keys are not identical bytes | shared keys let a stale attempt corrupt a published rendition |
| New `delivery-edge` infrastructure lib | I.2/X.3: the SDK call leaves `application/`; the edge-cache removal is a second operation | keeping the signer in `application/` is debt row D-6 |
| Three migrations (expand/backfill/contract) | III.11: new NOT NULL columns, status check change and FK drops under running code | one migration breaks the rolling deploy |
