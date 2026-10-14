# Quickstart: validating S30 — Product video and VOD

Run backend commands from `packages/backend`. E2E specs run through the condensed runner; open the full log only when the summary is not enough. Contracts: [video-api.md](contracts/video-api.md), [events.md](contracts/events.md); tables: [data-model.md](data-model.md).

## Prerequisites

1. Test stack up: Postgres, Redis (`localhost:6400`), MinIO (`localhost:9210`), ElasticMQ with `video-transcode` and `video-transcode-dlq` (already in `infra/docker/elasticmq/elasticmq.conf`); migrations applied (`video-s30-*`).
2. `ffmpeg` and `ffprobe` on `PATH` (not installed in the authoring workspace; the worker image installs them). The pipeline suites **fail** under `CI=true` and report *blocked* locally when they are missing; they are never skipped silently.
3. Settings for the suites are set by the harness (`video_cdn_url`, `video_cookie_domain`, a throwaway RSA key pair); production values are validated at startup (AS-58).

## Run

```text
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-upload.e2e-spec.ts       # AS-01–AS-14
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-pipeline.e2e-spec.ts     # AS-15, AS-18–AS-30 (real ffmpeg)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-delivery.e2e-spec.ts     # AS-31–AS-41
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-management.e2e-spec.ts   # AS-42–AS-48
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-lifecycle.e2e-spec.ts    # AS-49–AS-55
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/media/video-events.e2e-spec.ts       # AS-56–AS-59, AS-62
pnpm test -- libs/domains/media/domain                                                   # AS-16, AS-17, AS-19 (builder), AS-20, AS-24/25 tables, AS-36 paths, status table
pnpm exec tsc --noEmit ; pnpm check:boundaries ; pnpm check:table-ownership --strict     # AS-59
```

Run the six e2e files in separate processes (L-008); a batch without a summary line is a crash, not a flaky test. After a fix, repeat on a fresh stack (`scripts/qa/fresh-run.sh`, L-012). Then start the real apps (`apps/core`, `apps/worker`, `apps/projector`) and confirm they boot (L-004, L-015). From the repo root: `python3 scripts/livespec/check.py` (the S30 page).

## Scenario walk (what a reviewer can do by hand)

1. As a `STAFF` member `POST /api/shops/:id/videos` with a 200 MB body → `201`, three part URLs; PUT the parts with `curl` (only the correct length is accepted); `GET …/upload` after sending two → one missing; `POST …/complete` → `202`; poll `GET …/videos/:id` until `READY`.
2. Anonymous `GET /api/videos/:id/playback` → `masterUrl` on the video host under `/p/<id>/`; for an unlisted video the same call needs `?token=` and sets three cookies.
3. Delete the video → playback `404` at once; the purge job removes the objects within 5 minutes.

## Ops artifacts (success criteria no automated test proves; status: not run)

| Criterion | How to run it | Status |
|---|---|---|
| SC-001: 95% of 5-minute 1080p sources `READY` within 10 minutes of completing the upload, idle fleet | upload a corpus of 100 sources through the API on the worker fleet; read `video_upload_to_ready_seconds` (p95) | not run |
| SC-002: a 20 GiB upload interrupted at 50% resumes sending 0 bytes of stored parts (AS-09 proves the rule on 12 parts) | script an interrupted 20 GiB upload against the real bucket, count bytes sent after `GET …/upload` | not run |
| SC-006: playback p95 < 150 ms at 1,000 req/s, 0 database writes (AS-40 proves 0 writes) | `k6 run scripts/load-tests/video-playback.k6.js` against a staging core | not run |
| SC-008 (edge half): objects gone within 10 minutes of delete; the edge stops serving the path | delete a public video, run `bash scripts/ops/check-video-edge.sh <videoId>` until `404` at the CDN, time it | not run |
| AS-60: source path private, unlisted path needs a credential, immutable cache + `nosniff`, CORS with credentials on the unlisted path only, no cookies from the delivery host, multipart abort after 2 days, sources to infrequent access after 30 days | `terraform plan` on `infra/modules/s3_cloudfront`, then `bash scripts/ops/check-video-edge.sh` after deploy | not run |
| AS-61: seller picks a file, upload with an interrupted part resumes, product page plays, share link plays anonymously | Playwright journey `packages/web/tests/seller-video.spec.ts` once W04/W02 ship the screens (none exist today) | not run |

| AS-15 (real clip), AS-18, AS-19: real-encoder scenarios; the tests exist and are BLOCKED where `ffmpeg`/`ffprobe` are missing | install ffmpeg >= 5 and ffprobe, run `scripts/sdd/test-spec.sh libs/domains/media/video-pipeline.e2e-spec.ts` | not run |
| Edge-cache removal against the real CDN: `createCloudFrontInvalidator` (a `CreateInvalidation` call) is the default provider when `video_cloudfront_distribution_id` is set; a unit test proves the call shape with a stub client, never a real distribution | set `video_cloudfront_distribution_id` on the worker, delete a public video, watch `edgePurgedAt` and the CDN `404` | not run |
| The video distribution (`aws_cloudfront_distribution.video`) and the `vsrc/` lifecycle rule were written without `terraform plan` (no terraform in this runner) | `terraform plan` on `infra/stack`, then `bash scripts/ops/check-video-edge.sh <host> <publicId> <unlistedId>` (the script's exec bit could not be set by the harness: `chmod +x`) | not run |

Each of the first seven rows, and the two edge rows, has a matching line in `specs/UNVERIFIED.md`; the last two are operations steps tied to the edge row.
