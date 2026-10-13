# Data model: S30 — Product video and VOD (domain `media`)

All four tables are owned by `domain:media` (`db/ownership.ts`). No foreign key points to another owner's table (`shopId`, `uploaderId`, `productId` are plain UUID columns). Ids are UUIDs from the repo's generator. Timestamps are `timestamptz`. Closed vocabularies are `CHECK` constraints that mirror the TypeScript unions (a unit test compares the two).

## Video (existing table, extended)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| shopId | uuid NOT NULL | plain ID (FK to `Shop` dropped in the contract migration) |
| uploaderId | uuid NOT NULL | plain ID (FK to `User` dropped) |
| title | varchar(200) NOT NULL | trimmed, 1–200 |
| visibility | varchar NOT NULL CHECK in (`public`,`unlisted`) | fixed at creation |
| status | varchar NOT NULL CHECK in (`UPLOADING`,`UPLOADED`,`PROCESSING`,`READY`,`FAILED`,`EXPIRED`,`DELETED`) | closed union in `domain/video-status.ts` |
| failureCode | varchar NULL CHECK in the closed set below | |
| internalError | varchar(500) NULL | never returned (replaces `error`) |
| retryCount | int NOT NULL DEFAULT 0 CHECK 0..3 | |
| sourceKey | varchar NOT NULL | server-generated `vsrc/<id>/source`, never returned |
| uploadId | varchar NULL | storage multipart id, never returned; NULL until the storage call of R-1 succeeds |
| sizeBytes | bigint NOT NULL CHECK 1024..21474836480 | |
| contentType | varchar NOT NULL CHECK in (`video/mp4`,`video/quicktime`,`video/webm`) | advisory |
| partSize | int NOT NULL | 67108864 |
| sessionExpiresAt | timestamptz NOT NULL | creation + 24 h; never moved |
| shareToken | varchar(43) NULL | unlisted only; 32 random bytes base64url; CHECK `(visibility='unlisted') = (shareToken IS NOT NULL)` |
| productId | uuid NULL | plain ID |
| durationSec | numeric(10,3) NULL | set by `probe` |
| width, height | int NULL | source size from `probe` (the owner/playback view shows the top rendition's size once READY) |
| outputs | jsonb NULL | written by `publish`: `{master, poster, sprite|null, renditions:[{name,width,height,bandwidth,averageBandwidth,frameRate,codecs}]}` (keys relative to the delivery prefix) |
| objectsPurgedAt | timestamptz NULL | set by the purge |
| edgePurgedAt | timestamptz NULL | set when the edge removal succeeded (deleted public videos) |
| readyAt | timestamptz NULL | for `video_upload_to_ready_seconds` |
| version | int NOT NULL DEFAULT 1 | +1 on every row change that a reader can see |
| createdAt, updatedAt | timestamptz NOT NULL | |

Indexes: `video_shop_created_idx (shopId, createdAt DESC, id DESC) WHERE status <> 'DELETED'` (keyset list, E4); `video_product_ready_idx (productId, createdAt DESC, id DESC) WHERE status='READY' AND visibility='public'` (product list); `video_status_created_idx (status, createdAt)` for the three jobs (`UPLOADING` expiry, `UPLOADED` stuck, `PROCESSING` age, purge states); `video_shop_uploading_idx (shopId) WHERE status='UPLOADING'` (quota count); `video_product_active_idx (productId) WHERE productId IS NOT NULL AND status <> 'DELETED'` (link limit count).

`failureCode` vocabulary (`domain/video-errors.ts`): retryable — `transcode_failed`, `task_timeout`, `storage_unavailable`, `processing_timeout`; permanent — `not_a_video`, `no_video_stream`, `duration_exceeded`, `duration_too_short`, `resolution_exceeded`, `source_size_mismatch`.

### Status machine (FR-056)

```text
UPLOADING --complete--> UPLOADED --assembled--> PROCESSING --publish--> READY
    |                        |                      |
    +--expire--> EXPIRED     +--size mismatch-->    +--task fails/timeout--> FAILED --retry--> PROCESSING
                             FAILED                                          (≤ 3 times, retryable codes)
any status except DELETED --delete--> DELETED   (terminal)
```

Every transition is `UPDATE … SET status=$to, version=version+1 … WHERE id=$id AND status=$from` asserting one affected row, plus one `VideoStatusHistory` row in the same transaction. A field edit (title, productId) bumps `version` and writes no history row.

## VideoTask (existing table, extended)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| videoId | uuid NOT NULL | plain ID within the same owner; `ON DELETE` none (rows are kept for audit) |
| name | varchar NOT NULL | `probe`, `poster`, `thumbnails`, `transcode:240`…`transcode:1080`, `package`, `publish`; UNIQUE `(videoId, name)` |
| dependsOn | text[] NOT NULL | task names |
| status | varchar NOT NULL CHECK in (`PENDING`,`QUEUED`,`RUNNING`,`DONE`,`FAILED`,`SKIPPED`,`CANCELLED`) | |
| attempts | int NOT NULL DEFAULT 0 CHECK 0..3 | |
| claimedAttempt | int NULL | the attempt allowed to mark `DONE` |
| leaseExpiresAt | timestamptz NULL | 5 min after the last claim/heartbeat |
| lastSentAt | timestamptz NULL | when a message was last sent (sweep guard, 1 min) |
| output | jsonb NULL | per task: rendition `{width,height,frameRate,codecs,peakBitrate,averageBitrate,segmentCount,playlist}`, poster/sprite paths, probe result |
| internalError | varchar(500) NULL | never returned |
| createdAt, updatedAt | timestamptz NOT NULL | |

Indexes: `(videoId)`; `video_task_lease_idx (leaseExpiresAt) WHERE status='RUNNING'`; `video_task_queued_idx (updatedAt) WHERE status='QUEUED'`.

Task state transitions: `PENDING → QUEUED` (claimed ready under the video row lock), `QUEUED → RUNNING` (claim, attempt +1), `RUNNING → DONE` (fenced), `RUNNING → QUEUED` (transient failure with backoff; or shutdown without an attempt), `RUNNING → FAILED` (last attempt, or permanent), `RUNNING → SKIPPED` (optional task, last attempt), any open state `→ CANCELLED` (video failed/deleted), `FAILED|CANCELLED → PENDING` (retry of the video; attempts reset).

## VideoStatusHistory (new)

`id uuid PK`, `videoId uuid NOT NULL`, `fromStatus varchar NULL`, `toStatus varchar NOT NULL`, `actorType varchar NOT NULL CHECK in (user, system, worker)`, `actorId uuid NULL`, `failureCode varchar NULL`, `createdAt timestamptz NOT NULL`. Index `(videoId, createdAt)`. Append-only: no update/delete statement exists in the code.

## VideoShopState (new, R3 copy of the shop's status)

`shopId uuid PK`, `suspended boolean NOT NULL`, `shopVersion int NOT NULL`, `updatedAt timestamptz NOT NULL`. A missing row means active. Upsert only when `excluded.shopVersion > shopVersion` (out-of-order and duplicate safe).

## Storage layout (not tables)

| Prefix | Content | Reachable by the CDN origin |
|---|---|---|
| `vsrc/<videoId>/source` | the assembled original (retained until purge) | no |
| `p/<videoId>/…` | public outputs: `master.m3u8`, `r/<rung>/a<n>/index.m3u8` + `seg_*.ts`, `poster/a<n>/poster.jpg`, `sprite/a<n>/sprite.jpg` + `sprite.vtt` | yes, unsigned |
| `u/<videoId>/…` | the same, unlisted | yes, signed credential required |

## Events (outbox → `media.events`)

See [contracts/events.md](contracts/events.md).

## Invariants the store holds

1. At most 10 `UPLOADING` videos per shop (advisory lock + count in the inserting transaction).
2. At most 10 non-`DELETED` videos per product (advisory lock + count in the linking transaction).
3. `READY` is reached only from `PROCESSING` with every required task `DONE` (conditional update with `NOT EXISTS`).
4. `DELETED` is terminal (no transition leaves it; the conditional updates name the source status).
5. A task is `DONE` only through the attempt that holds `claimedAttempt`.
6. `shareToken` is present exactly for unlisted videos.
7. `VideoShopState.shopVersion` never decreases.
