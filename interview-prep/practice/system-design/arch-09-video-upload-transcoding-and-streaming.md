# arch-09. Video upload, transcoding and streaming

*Media · Medium*

## The question

"We're an online learning platform. Instructors upload course videos (typically 10-60 minutes, up to 20 GB, from flaky home connections); students stream them on phones, laptops and TVs. ~2,000 uploads a day and ~1M video views a day. Paid courses must not be watchable by people who didn't buy them. Design upload, processing and playback."

**Then:** "Instructors complain videos take two hours to become available. And a famous instructor's course launches with 50k students pressing play in the first minute."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Live streaming? → assume: no, video on demand only.
- Protection level? → assume: signed access (no DRM). Studio content would need DRM (Widevine, FairPlay, PlayReady); out of scope.
- Devices? → assume: HLS everywhere (Safari/iOS natively, hls.js elsewhere), CMAF fMP4 segments.
- Captions and thumbnails? → assume: yes, auto-generated captions editable by the instructor, a thumbnail sprite for seeking.
- Numbers, ingest → assume: 2,000 × ~1.5 GB source ≈ 3 TB/day. Rendition ladder 1080p ~5 Mbps, 720p ~3, 480p ~1.5, 360p ~0.8, 240p ~0.4 ≈ 10.7 Mbps total; a 20-minute video ≈ 1.6 GB of renditions → another ~3 TB/day.
- Numbers, playback → assume: 1M views × ~15 min watched × ~2.5 Mbps avg ≈ 280 TB/day egress ≈ 26 Gbps average, ~80 Gbps at evening peak. Egress cost dominates; a CDN is mandatory.

## Design

**1. Upload.** `POST /videos` → create `videos(id, course_id, status='uploading')` and an S3 multipart upload. Client requests presigned URLs per part (e.g. 64 MB parts; S3 allows 5 MiB-5 GiB per part and up to 10,000 parts), uploads 4 in parallel, retries failed parts only. On resume, `ListParts` tells it what's done. `POST /videos/:id/complete {parts: [{n, etag}]}` → `CompleteMultipartUpload`. Bucket lifecycle rule: abort incomplete multipart uploads after 7 days (unfinished parts are billed storage).

**2. Pipeline** (S3 event → SQS → Step Functions):
1. **Probe** with ffprobe: duration, codecs, resolution, corrupt file → `failed` with a readable reason.
2. **Split** the source at keyframes into ~2-minute chunks.
3. **Transcode** chunk × rendition tasks in parallel on an ffmpeg worker fleet (ECS on Spot), H.264 + AAC, fixed GOP of 2 s with keyframes aligned across renditions so the player can switch at any segment boundary.
4. **Package** to HLS (CMAF fMP4, 6 s segments, Apple's recommended target), write a media playlist per rendition and a master playlist.
5. **Extras:** captions (speech-to-text → WebVTT), thumbnail sprite, poster.
6. Mark `ready`; notify the instructor.

**3. Storage layout.** `s3://vod/{videoId}/{rendition}/seg_00042.m4s`, playlists alongside. Segments are immutable: `Cache-Control: public, max-age=31536000, immutable`. Source moves to a cheaper storage class after 30 days.

**4. Playback.** `GET /videos/:id/playback` checks enrollment, sets **CloudFront signed cookies** scoped to `/{videoId}/*` with a 4-6 h expiry, and returns the master playlist URL. The player (hls.js / native) picks a rendition per segment from measured throughput and buffer level (ABR). Signed URLs per segment are impractical, since the playlist would have to be rewritten per viewer.

**5. Progress.** The player posts position every ~15 s; the API batches into Postgres `watch_progress(user_id, video_id, position_s, updated_at)` (upsert, last-write by `updated_at`).

## Deep dives

**1. Two hours to available (twist, part 1).** A single ffmpeg process transcoding a 60-minute video to five renditions sequentially takes a long time on one machine. Chosen: chunked parallel transcoding (30 chunks × 5 renditions = 150 tasks), so wall time ≈ one chunk's time plus split/package overhead, a few minutes. Also publish progressively: mark playable once 360p and 720p are packaged, then add 1080p to the master playlist when done. Rejected: bigger instances only (vertical scaling hits a ceiling; one long job also loses everything on a Spot interruption, while a chunk task just retries).

**2. Managed vs self-run transcoding.** AWS Elemental MediaConvert does the whole pipeline with per-output-minute pricing and no fleet to run; at sustained volume (here ~2,000 × 30 min × 5 renditions ≈ 300k output minutes/day) a Spot ffmpeg fleet is usually cheaper but you own scaling, retries and codec upgrades. Chosen: start managed, move when the bill justifies a team. Either way, per-title encoding (lower bitrates for slides-and-voice lectures) cuts storage and egress a lot, since most course videos are low-motion.

**3. 50k viewers in a minute (twist, part 2).** Everyone requests the master playlist and the first segments at once; a cold CDN sends each edge's miss to S3. Chosen: CloudFront Origin Shield (one regional cache layer in front of S3, which collapses concurrent misses), long TTLs on immutable segments, short TTL on nothing because VOD playlists don't change once `ready`. Playback-auth calls (enrollment check) hit our API: 50k in a minute ≈ 800/s, served from a Redis enrollment cache. Rejected: serving video through our Node API (bandwidth and connection count).

## Traps

- Single PUT uploads for multi-GB files from home connections: one dropped connection restarts from zero.
- Transcoding inside the API process or on a request thread.
- Keyframes not aligned across renditions: the player can't switch quality cleanly; visible stalls.
- Protecting segments with per-request signed URLs or by proxying through the app: breaks CDN caching or the bandwidth budget. Use signed cookies.
- Short CDN TTLs on immutable segments: every edge refetches from S3.
- Forgetting the lifecycle rule for incomplete multipart uploads: invisible storage cost that grows forever.

## Say it (60–90 s)

Uploads use S3 multipart with presigned URLs per part, so a flaky connection only retries the failed part, and a lifecycle rule cleans up abandoned uploads. Completing the upload triggers a Step Functions pipeline: probe the file, split it at keyframes into two-minute chunks, transcode every chunk and rendition in parallel on a Spot fleet with aligned two-second keyframes, then package to HLS with six-second CMAF segments and write the playlists to S3. That parallelism is the answer to the two-hour delay, along with publishing as soon as the lower renditions are ready. Playback goes through CloudFront: segments are immutable with year-long cache headers, and paid content is protected with signed cookies scoped to that video's path, issued after an enrollment check. The player does adaptive bitrate on its own, picking a rendition per segment. The math is about two hundred eighty terabytes of egress a day, so the CDN is the core of the design. For the launch spike, Origin Shield collapses the misses from all edges into one request to S3, and the enrollment check is cached in Redis.

## Follow-ups

**Q:** How do you stop a student from sharing the signed cookie?
**A:** Short expiry, cookie scoped to one video, concurrent-stream limits per account checked on playback-auth renewals. Without DRM a determined user can still record the screen; that's accepted.

**Q:** An instructor replaces a video in a published course.
**A:** New `video_id`, new paths; the lesson points to the new one when it's ready. Never overwrite segments in place, since CDNs and players have cached the old ones.

**Q:** How do you know playback quality is good?
**A:** Player beacons: startup time, rebuffer ratio, average bitrate, errors, by CDN POP and device. Alert on rebuffer ratio per region.

</details>

## Theory in the notes

- [10-system-design/08-media-and-files.md](../../10-system-design/08-media-and-files.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [02-nodejs/02-streams-and-backpressure.md](../../02-nodejs/02-streams-and-backpressure.md)
