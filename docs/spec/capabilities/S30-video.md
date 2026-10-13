---
id: S30
title: Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
kind: capability
status: draft
depends_on: [S01, S03, S05, S29, S49, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, outbox-task-queue, projection-and-replay, job-scheduler-lease, transaction-runner, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/media/api/video.controller.ts
  - packages/backend/libs/domains/media/api/video-playback.controller.ts
  - packages/backend/libs/domains/media/api/video-problem.ts
  - packages/backend/libs/domains/media/application/video-*.ts
  - packages/backend/libs/domains/media/domain/video-*.ts
  - packages/backend/libs/domains/media/domain/dag.ts
  - packages/backend/libs/domains/media/domain/hls.ts
  - packages/backend/libs/domains/media/domain/probe-rules.ts
  - packages/backend/libs/domains/media/domain/task-limits.ts
  - packages/backend/libs/domains/media/domain/delivery-paths.ts
  - packages/backend/libs/domains/media/infra/pg-video-*.ts
  - packages/backend/libs/domains/media/infra/video-*.ts
  - packages/backend/libs/domains/media/infra/ffmpeg-transcoder.ts
  - packages/backend/libs/domains/media/infra/child-process.ts
  - packages/backend/libs/domains/media/video*.module.ts
  - packages/backend/libs/domains/media/video-maintenance.jobs.ts
  - packages/backend/libs/domains/media/video-rate-limit-policies.ts
  - packages/backend/libs/infrastructure/delivery-edge/*.ts
  - packages/backend/libs/common/config/video-config.ts
  - packages/backend/migrations/*-video-s30-*.js
  - packages/contracts/src/media/video.ts
  - packages/contracts/src/media/video-events.ts
---
# S30 - Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
## Purpose
A shop member uploads a product video straight to storage in parts and can resume after a break. A graph of tasks inspects the file, makes a ladder of qualities that is never enlarged, a poster and a preview sprite, packages everything as HLS and publishes it. Public videos play from a stable address; unlisted videos play only with a share token and a short signed credential that covers one video. The original is never served. A seller lists, renames, links, retries and deletes videos. Cleanup jobs expire unused uploads, re-send lost work and purge files.

## Entry points
- `POST /api/shops/:shopId/videos`, `GET …/videos/:id/upload`, `POST …/videos/:id/complete`: resumable upload.
- `GET /api/shops/:shopId/videos`, `GET`, `PATCH`, `DELETE …/videos/:id`, `POST …/videos/:id/retry`: management.
- `GET /api/videos/:id/playback` and `GET /api/products/:productId/videos`: public delivery.
- Queue `video-transcode`, topic `media.events` with `video.ready`, `video.failed`, `video.deleted`.
- Jobs `media.video-expire-uploads`, `media.video-requeue-stuck`, `media.video-purge`.
- Consumers of `catalog.product_deleted`, `tenancy.shop_deleted`, `tenancy.shop_status_changed`.

## Rules
- **S30.R-01** Starting an upload MUST accept only a strict body (`title` 1 to 200 characters, `sizeBytes` 1,024 to 21,474,836,480, `contentType` `video/mp4`, `video/quicktime` or `video/webm`, `visibility` `public` or `unlisted`, optional `productId`); anything else MUST answer `400` `validation_failed` and store nothing. [proof: S30 AS-02] [code: packages/contracts/src/media/video.ts#videoStartRequestSchema]
- **S30.R-02** The server MUST choose the private source location; the answer MUST carry no location and no storage upload identifier, and every part permission MUST bind its part number and exact length for 1 hour. [proof: S30 AS-01, S30 AS-08] [code: packages/backend/libs/domains/media/application/video-upload.service.ts#VideoUploadService]
- **S30.R-03** A shop MUST hold at most 10 `UPLOADING` videos, counted under a per-shop advisory lock; the 11th answers `409` `pending_uploads_limit`. [proof: S30 AS-05] [code: packages/backend/libs/domains/media/infra/pg-video-repository.ts#PgVideoRepository]
- **S30.R-04** Starting MUST be limited to 20 an hour per shop and every other seller write to 120 a minute per shop, failing closed (`429`, `503`). [proof: S30 AS-06] [code: packages/backend/libs/domains/media/video-rate-limit-policies.ts#videoRatePolicies]
- **S30.R-05** A storage failure at start MUST answer `503` `storage_unavailable` within 5 seconds and leave the half-created row `EXPIRED`. [proof: S30 AS-07] [code: packages/backend/libs/domains/media/application/video-upload.service.ts#VideoUploadService]
- **S30.R-06** `complete` MUST compare the listed parts with the storage's own list, assemble once outside any transaction, check the assembled size, and move `UPLOADING → UPLOADED → PROCESSING` conditionally with one `probe` task and one queue message after the commit. [proof: S30 AS-10, S30 AS-11, S30 AS-14] [code: packages/backend/libs/domains/media/application/video-finalize.service.ts#VideoFinalizeService]
- **S30.R-07** A replayed or concurrent `complete` MUST cause one transition and one message; `PROCESSING` answers `202`, `READY` and `FAILED` answer `200`, `EXPIRED` `409` `upload_expired`, and a hidden video `404` `video_not_found`. [proof: S30 AS-12, S30 AS-13] [code: packages/backend/libs/domains/media/application/video-upload.service.ts#VideoUploadService]
- **S30.R-08** A source that is not a decodable video within 2 hours, 3,840×2,160, 1 second and 16×16 MUST fail at once with one code of `not_a_video`, `no_video_stream`, `duration_exceeded`, `duration_too_short`, `resolution_exceeded`, with no retry. [proof: S30 AS-20, S30 AS-21] [code: packages/backend/libs/domains/media/domain/probe-rules.ts#validateProbe]
- **S30.R-09** The ladder MUST be the rungs 240, 480, 720, 1080 whose height does not exceed the source, never enlarged, with even widths, one frame rate and fixed-time keyframes so every rendition has the same segments. [proof: S30 AS-17, S30 AS-18] [code: packages/backend/libs/domains/media/domain/hls.ts#ladderFor]
- **S30.R-10** The master playlist MUST be built from measured peak and average bitrate, real size, frame rate and codecs, and name an audio codec only when the video has audio. [proof: S30 AS-19] [code: packages/backend/libs/domains/media/domain/hls.ts#buildMasterPlaylist]
- **S30.R-11** A task MUST be claimed only from `QUEUED` or an expired five-minute lease, counting an attempt; a held lease answers busy without an attempt; `DONE` MUST be fenced by the claimed attempt and each attempt MUST write its own output location. [proof: S30 AS-23, S30 AS-26] [code: packages/backend/libs/domains/media/infra/pg-video-task-repository.ts#PgVideoTaskRepository]
- **S30.R-12** A transient failure MUST re-queue the task with a delay of 30 then 120 seconds; after three attempts the video MUST become `FAILED` (`transcode_failed`, `task_timeout` or `storage_unavailable`), open tasks `CANCELLED`; a failed `thumbnails` task MUST become `SKIPPED`. [proof: S30 AS-24, S30 AS-28] [code: packages/backend/libs/domains/media/domain/task-limits.ts#nextAfterFailure]
- **S30.R-13** Child processes MUST start with an argument list, never a shell, die with SIGKILL at the task limit, and keep at most 4 KB of error output and 1 MB of standard output. [proof: S30 AS-25] [code: packages/backend/libs/domains/media/infra/child-process.ts#runBounded]
- **S30.R-14** `publish` MUST set `READY` only from `PROCESSING` with every required task `DONE`, in one transaction with the history row and `video.ready`; it MUST never overwrite `DELETED`. [proof: S30 AS-27] [code: packages/backend/libs/domains/media/infra/pg-video-repository.ts#PgVideoRepository]
- **S30.R-15** Playback MUST answer only for `READY` videos of a shop that is not suspended; an unlisted video MUST need its share token (constant-time compare) and answer a signed credential of 4 hours for its own path; every other case, including a wrong token, MUST answer one identical `404`. [proof: S30 AS-31, S30 AS-32, S30 AS-33, S30 AS-34] [code: packages/backend/libs/domains/media/application/video-playback.service.ts#VideoPlaybackService]
- **S30.R-16** Signing MUST never degrade to an unsigned address: a missing key answers `503`, and a production start without delivery host, cookie domain or key pair MUST fail naming the setting. [proof: S30 AS-35, S30 AS-58] [code: packages/backend/libs/common/config/video-config.ts#videoProductionRule]
- **S30.R-17** The original MUST never appear in any response; source, public and unlisted paths MUST be disjoint, and every output MUST be stored with its content type and an immutable cache header. [proof: S30 AS-36, S30 AS-37] [code: packages/backend/libs/domains/media/domain/delivery-paths.ts#deliveryUrl]
- **S30.R-18** Playback MUST write nothing and be limited to 600 a minute per address, failing open. [proof: S30 AS-39, S30 AS-40] [code: packages/backend/libs/domains/media/video-rate-limit-policies.ts#videoRatePolicies]
- **S30.R-19** The product video list MUST return at most 10 `READY` public videos, newest first, only for an `ACTIVE` non-sandbox product of an active shop, with the product taken through catalog's exported service. [proof: S30 AS-38] [code: packages/backend/libs/domains/media/application/video-playback.service.ts#VideoPlaybackService]
- **S30.R-20** The seller list MUST be keyset-paged (20 default, 50 maximum, opaque cursor bound to shop and filter); an edit MUST use `expectedVersion` and answer `409` `version_conflict`; a product link MUST hold at most 10 videos. [proof: S30 AS-43, S30 AS-44, S30 AS-45] [code: packages/backend/libs/domains/media/application/video-manage.service.ts#VideoManageService]
- **S30.R-21** A retry MUST be allowed at most 3 times, only for retryable codes, resume from the last finished task and send one message per ready task after the commit. [proof: S30 AS-46] [code: packages/backend/libs/domains/media/application/video-manage.service.ts#VideoManageService]
- **S30.R-22** `DELETE` MUST soft-delete with a history row and `video.deleted`, cancel open tasks and stop all reads at once; objects are removed by the purge job. [proof: S30 AS-47] [code: packages/backend/libs/domains/media/application/video-manage.service.ts#VideoManageService]
- **S30.R-23** Every seller route MUST answer one identical `404` for a video of another shop or a non-member. [proof: S30 AS-42, S30 AS-48] [code: packages/backend/libs/domains/media/api/video-hidden-shop.filter.ts#VideoHiddenShopFilter]
- **S30.R-24** `media.video-expire-uploads` MUST expire uploads older than 24 hours and abort their multipart upload; `media.video-requeue-stuck` MUST recover lost messages, expired leases, stuck `UPLOADED` and stuck `PROCESSING` once per sweep and fail videos in `PROCESSING` over 6 hours; `media.video-purge` MUST remove objects of `DELETED`, `EXPIRED` and week-old `FAILED` videos, at most 200 a run, never a `READY` video's. [proof: S30 AS-49, S30 AS-50, S30 AS-51, S30 AS-52] [code: packages/backend/libs/domains/media/video-maintenance.jobs.ts#VideoMaintenanceJobs]
- **S30.R-25** The three consumers MUST be idempotent, refuse a malformed event without effect, and keep the shop status copy by version. [proof: S30 AS-53, S30 AS-54, S30 AS-55] [code: packages/backend/libs/domains/media/infra/video-consumers.ts#VideoShopStatusProjector]
- **S30.R-26** Each video event MUST be appended to the outbox in the transaction that changed the state, with `videoVersion`, and contain no URL, key or token. [proof: S30 AS-56] [code: packages/backend/libs/domains/media/domain/video-events.ts#VideoReady]
- **S30.R-27** The entry point MUST export only the Provides list; `Video`, `VideoTask`, `VideoStatusHistory` and `VideoShopState` MUST be registered to the media domain without foreign keys to other domains. [proof: S30 AS-59] [code: packages/backend/libs/domains/media/index.ts#VideoModule]

## Behaviors
- **S30.B-01** Given a member and a 200 MB file, when they start, put the three parts and complete, then the video is `PROCESSING` with one `probe` message. [proof: S30 AS-10]
- **S30.B-02** Given an upload with 7 of 12 parts, when the seller resumes, then only the missing parts get fresh permissions. [proof: S30 AS-09]
- **S30.B-03** Given a six-second clip, when the workers run, then the waves are probe, poster with thumbnails and renditions, package, publish, and the video is `READY` once. [proof: S30 AS-15]
- **S30.B-04** Given an unlisted video, when someone calls playback without the token, then the answer is the same `404` as for an unknown id. [proof: S30 AS-33]
- **S30.B-05** Given a delete and a publish at the same moment, then the video is never `READY` after `DELETED`. [proof: S30 AS-27]

## Lifecycles
A video is `UPLOADING`, `UPLOADED` (parts assembled), `PROCESSING`, then `READY` or `FAILED` (retryable up to three times). An unfinished upload becomes `EXPIRED`. Any state can become `DELETED`, which is final.

## Owns
- Tables `Video`, `VideoTask`, `VideoStatusHistory`, `VideoShopState`.
- Storage prefixes `vsrc/` (private), `p/` (public delivery), `u/` (unlisted delivery); queue `video-transcode`; jobs `media.video-*`; policies `video.*`; metrics `video_*`.

## Decisions
- Delivery is behind a port (`DeliveryEdge`) so the application never calls the CDN signer directly.
- The shop status is a local copy updated by event, so playback makes no cross-domain call.

## Known gaps
- Edge behaviour, the 20 GiB upload and the playback load test have no automated proof (listed in `specs/UNVERIFIED.md`).
- The seller upload screen (W04) and the product page player (W02) do not exist yet.
