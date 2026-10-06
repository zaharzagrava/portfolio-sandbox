# Media and File Designs

Designs 25–27 of the practice catalog (`03-practice-catalog.md`). Common themes: keep **bytes out of your API servers** (direct-to-object-storage uploads, CDN downloads), async processing pipelines, and metadata vs blob separation.

---

## 25. File storage and sync (Dropbox / Google Drive)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AssetsService`](../../packages/backend/libs/domains/asset-library/application/assets.service.ts#L32): AssetsService implements chunked uploads, versions, delta sync and sharing for the Dropbox/Drive-style file store. _(assets.service.ts)_
> - [`AssetsController`](../../packages/backend/libs/domains/asset-library/api/assets.controller.ts#L44): AssetsController exposes the upload, versioning, sharing and download routes. _(assets.controller.ts)_
<!-- theory-links:end -->

### Clarify
- Upload/download, folders, sharing (links, users, permissions), sync across devices, version history, offline edits? Max file size?
- Scale: 50M users, 10 GB average stored, files up to 50 GB.

### Design
```
Client sync agent ─► Metadata service (Postgres: files, folders, versions, chunks, ACLs)
        │               ▲ change notifications (long poll / WebSocket per user)
        └─► Block storage via presigned URLs (S3): content-addressed chunks  chunks/{sha256}
```
- Files are split into **chunks** (~4 MB). Each chunk is stored by its **content hash**. A file version = an ordered list of chunk hashes.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CommitInput`](../../packages/backend/libs/domains/asset-library/application/assets.service.ts#L22): CommitInput records a file version as path, baseVersion and an ordered list of chunk hashes. _(assets.service.ts)_
> - [`chunk`](../../packages/backend/libs/domains/asset-library/domain/fastcdc.ts#L82): chunk() splits data into content-defined chunks, each with a SHA256 hash. _(fastcdc.ts)_
> - [`PrepareDto`](../../packages/backend/libs/domains/asset-library/api/assets.controller.ts#L15): PrepareDto carries hash-validated chunk references so the server knows which chunks the client will upload. _(assets.controller.ts)_
<!-- theory-links:end -->

### Deep dives
- **Chunking benefits**: resumable uploads (retry only failed chunks), parallel uploads, **delta sync** (editing one part of a big file re-uploads only the changed chunks; content-defined chunking keeps chunk boundaries stable after inserts), and **deduplication** (identical chunks are stored once, across files and users).
- **Upload flow**: the client hashes chunks → asks the metadata service which hashes are missing → uploads only those via presigned URLs → commits a new version (list of hashes) in one metadata transaction.
- **Sync**: each user has a change journal (`cursor = last seen change ID`). Devices pull "changes since cursor" when notified, then download missing chunks.
- **Conflicts**: two devices edit the same file offline → keep both ("file (conflicted copy)"); version history allows restore.
- **Sharing and permissions**: ACLs on folders inherited by children, share links with tokens and expiry; download URLs are short-lived signed URLs.
- **Storage costs**: lifecycle tiers for old versions, garbage-collect chunks no longer referenced by any version (reference counting, run carefully and asynchronously).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`chunkBoundaries`](../../packages/backend/libs/domains/asset-library/domain/fastcdc.ts#L42): chunkBoundaries finds boundaries with a rolling gear hash (FastCDC), so chunk boundaries stay stable after inserts and delta sync works. _(fastcdc.ts)_
> - [`AssetsService`](../../packages/backend/libs/domains/asset-library/application/assets.service.ts#L32): AssetsService prepares uploads, commits versions, and does delta sync and dedupe by chunk hash. _(assets.service.ts)_
> - [`CommitDto`](../../packages/backend/libs/domains/asset-library/api/assets.controller.ts#L19): CommitDto finalizes an upload with path, version and chunks. _(assets.controller.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Content-addressed dedupe across users can leak information ("does anyone have this file?") through upload timing; some systems dedupe only per user.
- Pitfalls: streaming uploads through API servers, whole-file re-uploads on small edits, deleting chunks still referenced by old versions.

### Theory
design 27 (presigned/multipart uploads), `08-DevOps-Cloud/03` (S3), `06-Distributed-Systems/02` (sync and conflicts).

---

## 26. Video streaming (YouTube / Netflix)

### Clarify
- Upload + watch (YouTube) or curated catalog (Netflix)? Live streaming? Devices? Number of views/day?
- Assumptions: 500k uploads/day, 1B views/day.

### Design
```
Upload (resumable, direct to S3) ─► transcoding pipeline (queue + workers / MediaConvert):
    split into segments ─► transcode each to several bitrates/resolutions (240p … 4K, H.264/VP9/AV1)
    ─► package as HLS/DASH (manifest + 2–6 s segments) ─► S3 ─► CDN
Player ─► fetch manifest ─► adaptive bitrate: choose the quality per segment based on measured bandwidth
Metadata (Postgres): videos, channels, status; views/likes counters (async); recommendations (separate system)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`VideoService`](../../packages/backend/libs/domains/media/application/video.service.ts#L35): VideoService ties together upload, transcoding and authenticated playback delivery. _(video.service.ts)_
> - [`VideoController`](../../packages/backend/libs/domains/media/api/video.controller.ts#L27): VideoController starts and completes multipart video uploads and serves playback. _(video.controller.ts)_
<!-- theory-links:end -->
### Deep dives
- **Adaptive bitrate streaming (HLS/DASH)**: video is cut into short segments in several qualities. The player picks the next segment's quality from current bandwidth and buffer level, so playback continues on a weak network with lower quality instead of stalling.
- **Transcoding at scale**: split the source into chunks and transcode in parallel (a DAG of tasks: split → transcode × N → merge → package → thumbnails); idempotent tasks, retries, priority for popular uploads.
- **CDN is the whole game**: segments are immutable and cacheable; popular content is pre-warmed to edge locations (Netflix places caches inside ISPs).
- **View counts**: events into a stream → aggregated counts (design 32), not a DB row update per view.
- **Access control**: signed URLs/cookies for paid content, DRM (Widevine/FairPlay) for studios.
- **Live streaming** variant: ingest RTMP/SRT → real-time transcoding → low-latency HLS segments; latency of a few seconds is the trade-off of segment-based delivery.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LADDER`](../../packages/backend/libs/domains/media/domain/hls.ts#L2): LADDER defines four renditions from 240p to 1080p for adaptive bitrate streaming. _(hls.ts)_
> - [`buildMasterPlaylist`](../../packages/backend/libs/domains/media/domain/hls.ts#L31): buildMasterPlaylist generates the HLS master playlist with BANDWIDTH and RESOLUTION tags so the player can switch quality. _(hls.ts)_
> - [`VideoService`](../../packages/backend/libs/domains/media/application/video.service.ts#L35): VideoService orchestrates transcoding pipelines and tasks. _(video.service.ts)_
<!-- theory-links:end -->

### Theory
`08-DevOps-Cloud/03` (S3, CloudFront), design 27 (upload), design 32 (counting views).

---

## 27. Large file upload and processing service

**Prompt variants:** "Users upload CSVs/PDFs/videos up to 5 GB, and we process them", "Design document ingestion", "Process inbound emails with attachments".

### Clarify
- File sizes and types, how processing results are delivered (UI progress? webhook? email?), virus scanning requirements, retention.

### Design
```
1. Client ─► POST /uploads {name, size, type} ─► API validates, creates upload record (PENDING),
             returns presigned PUT (or multipart: CreateMultipartUpload + presigned part URLs)
2. Client ─► S3 directly (parallel parts, resumable)          — bytes never touch API servers
3. Client ─► POST /uploads/:id/complete (or S3 event notification)
4. S3 event ─► SQS ─► processing workers: scan (ClamAV), validate, parse/transform, store results
5. Status: PENDING → UPLOADED → PROCESSING → DONE / FAILED; progress via SSE or polling; webhook/email on completion
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`MediaService`](../../packages/backend/libs/domains/media/application/media.service.ts#L28): MediaService manages uploads to S3/MinIO and queues processing on SQS. _(media.service.ts)_
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/media-processing.ts#L48): The media-processing Lambda handler consumes SQS batches, transforms the files, and writes results to S3 and PostgreSQL idempotently. _(media-processing.ts)_
> - [`MEDIA_QUEUE`](../../packages/backend/libs/domains/media/application/media.service.ts#L9): MEDIA_QUEUE is the SQS queue that decouples processing from the upload request. _(media.service.ts)_
<!-- theory-links:end -->
### Deep dives
- **Presigned uploads**: the URL encodes bucket, key, expiry, and conditions (content type, max size with presigned **POST** policies). Keys are generated by the server (`tenant/{id}/uploads/{uuid}`), never trusted from the client's file name.
- **Multipart upload** for large files: parts of 5 MB–5 GB, uploaded in parallel and retried individually; an S3 lifecycle rule aborts incomplete multipart uploads after N days (otherwise you pay for orphaned parts).
- **Processing**: streaming parsers for big CSV/JSON (constant memory, `02-Node.js/02`), batched DB inserts, checkpointing for very long jobs (resume after crashes), idempotent processing per upload ID, visibility timeout > processing time or heartbeat extension, DLQ for poison files.
- **Security**: content-type sniffing (don't trust the extension), virus scan before making files available, serve user files from a **separate domain** (`usercontent.example.com`) with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` (so an uploaded HTML/SVG can't run as your origin, i.e. stored XSS), size limits, zip-bomb protection.
- **Results**: progress events published by workers → SSE to the browser; a large result (exported report) goes to S3 with a presigned download URL.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`PresignPostOptions`](../../packages/backend/libs/infrastructure/storage/object-storage.port.ts#L17): PresignPostOptions sets the key, content-type prefix and maxBytes that go into a presigned POST policy. _(object-storage.port.ts)_
> - [`MultipartUploadInit`](../../packages/backend/libs/infrastructure/storage/object-storage.port.ts#L10): MultipartUploadInit returns an uploadId, a key and presigned PUT URLs, one per part. _(object-storage.port.ts)_
> - [`S3ObjectStorage`](../../packages/backend/libs/infrastructure/storage/s3-object-storage.ts#L21): S3ObjectStorage implements presigned POST and multipart uploads against S3/MinIO. _(s3-object-storage.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- Pitfalls: uploads through the API (memory/timeouts), trusting client file names and MIME types, synchronous processing in the request, serving uploads from the main origin.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ACCEPTED_TYPES`](../../packages/backend/libs/domains/seller-onboarding/application/onboarding-documents.service.ts#L12): ACCEPTED_TYPES allow-lists MIME types with a maximum size per type, so the client's declared type is not trusted blindly. _(onboarding-documents.service.ts)_
<!-- theory-links:end -->

### Theory
`02-Node.js/02` (streams, backpressure), `06-Distributed-Systems/01` (SQS, claim check, DLQ), `05-Security/01` §1 (stored XSS via uploads), `04-API-Design/01` §2.9 (async request-reply).
