# SD-26 — Product Video & Launch VOD (adaptive streaming)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-03, F-02, SD-15 (live → VOD), SD-32 (view counts)

## Marketplace adaptation
Shops upload product videos; brand live launches are kept as VOD. Viewers on phones with weak networks must get smooth playback.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Resumable upload direct to S3 (multipart, SD-27 code reused) | 10/08 #26 |
| **Transcoding DAG**: probe → split into segments → transcode ladder (240p…1080p, H.264) in parallel → package **HLS** (master + variant playlists, 4 s segments) → thumbnails/sprite → publish; executed by a DAG runner with **topological ordering** and per-task retries (genuinely needed) | 10/08 #26 |
| ffmpeg via `child_process.spawn` with streams, timeouts, kill on abort (worker, not Lambda: long tasks) | 02/01 §4 |
| Idempotent tasks (output keys deterministic) | 10/08 #26 |
| Delivery: CloudFront with immutable segments; **signed cookies/URLs** for paid/unlisted videos | 10/08 #26 |
| View counts via analytics stream (SD-31/32), not DB updates | 10/08 #26 |
| Production note: AWS Elemental MediaConvert as managed alternative (ADR) | 10/08 #26 |

## Steps
- [x] `Video`, `TranscodeTask` models; DAG definition + runner (pure topo-sort/scheduler unit-tested).
- [x] ffmpeg task executors (`apps/worker`), HLS manifest builder.
- [x] Playback endpoint returning signed manifest URL.
- [x] e2e (needs ffmpeg in test env — marked `describe.skip` unless `FFMPEG_AVAILABLE`): 5 s sample → HLS master with 3 renditions.

## Scale
- Target: 50k uploads/day, 1M concurrent viewers (CDN).
- Hot path: viewers never hit origin except manifest signing (cached per user/video 5 min).
- Capacity: transcoding ≈ 1× realtime per rendition per vCPU → autoscaled worker fleet on SQS depth (spot instances).

## Implementation notes (2026-10-02)
- **Schema:** migration `20261002120000-videos` adds `Video` and `VideoTask` (one row per DAG node: deps, status, attempts, output).
- **`dag.ts`** (pure): `topoSort` (Kahn, cycle/unknown-dependency errors), `readyTasks`, and `videoPipeline` (probe → renditions ‖ poster → package → publish). The ladder is decided after probing, so the DAG is extended by the probe task.
- **`hls.ts`:** H.264/AAC ladder 240–1080p with no upscaling. ffmpeg args use a fixed 2 s GOP and no scene-cut keyframes so segments align across renditions (seamless ABR). There's a master playlist builder.
  - **Verified locally on a generated clip:** VOD playlists with a 4 s target duration plus a poster frame.
  - Unit spec `video.spec.ts`.
- **`ffmpeg.ts`:** `spawn` with bounded stderr; a timeout and the AbortSignal both SIGKILL the process. `probe` uses ffprobe JSON.
- **`VideoService`:**
  - Multipart upload (SD-27 mechanics).
  - `runTask` claims the task (QUEUED/RUNNING → RUNNING, attempts + 1), runs it in a temp dir (source streamed to disk because ffmpeg needs a seekable input), and uploads deterministic keys (idempotent retries).
  - Then `dispatchReady` claims newly ready tasks under the video row lock and sends one SQS message per task, so renditions run on different workers in parallel.
  - 3 attempts per task, then the video is FAILED.
- **Playback:** public videos get a CDN master URL. Unlisted videos get CloudFront **signed cookies** with a wildcard policy over `videos/<id>/*`; per-URL signing can't cover an HLS tree of segments.
- **Worker:** `VideoWorkerModule` (apps/worker), concurrency 2 per instance (ffmpeg uses all cores); shutdown aborts ffmpeg and the task is redelivered.
- **ADR:** in production at scale, AWS Elemental MediaConvert replaces self-run ffmpeg (no fleet to manage, per-minute pricing). The DAG/state model stays the same; tasks become MediaConvert jobs. View counts come from player beacons → SD-31 analytics, never DB updates.

## Test plan
| Scenario | API e2e | UI journey (web / mobile) | Unit |
|---|---|---|---|
| Shop uploads a video → playable HLS (3 renditions + poster) | `video.e2e-spec.ts` (gated on `FFMPEG_AVAILABLE`) | web + mobile: upload → "processing" → plays (happy path) | — |
| DAG order: fan-out after probe, fan-in at package | `video.e2e-spec.ts` (waves) | — | `video.spec.ts` |
| Concurrent sibling completions enqueue `package` once; duplicate message no-op | `video.e2e-spec.ts` | — | — |
| Cycle / unknown dependency rejected; no upscaling; master playlist format | — | — | `video.spec.ts` |
