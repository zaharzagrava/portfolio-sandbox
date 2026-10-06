# Test Plan: S30 — Product video and VOD (domain `media`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/media/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `VideoModule` (plus `VideoWorkerModule` and `VideoProjectorModule` where the row needs them) with the production pipe, filter, prefix and interceptors, and call it through `supertest`. Postgres, the outbox, Redis (rate limits) and an S3-compatible object store (MinIO) are real, with real migrations. **ffmpeg and ffprobe are real** and the suites **fail** (never skip) when `CI=true` and the binaries are missing; locally they skip with a loud warning (`questions.md` BREAKING, gaps F1).
- Only system-edge dependencies are faked: the clock (frozen), the edge signer's key pair (a throwaway RSA pair, so the signature is verified in the test), the edge cache's removal call (a spy), and the queue (the real port with the in-memory transport of the test harness, so messages can be read, delivered twice, delivered concurrently, delayed). **Fault injection** uses real mechanisms: a TCP fault proxy in front of MinIO (refuse, hang, fail the nth call) for AS-07, AS-14, AS-24; a stub encoder executable placed first on `PATH` (sleeps forever, floods output, exits non-zero on demand) for AS-24, AS-25, AS-62; a Postgres trigger that raises on the outbox insert for the rollback check of AS-56.
- Pipeline waves are driven the way several workers would: every queued message of a wave is delivered concurrently through the real consumer entry point, never by calling the service with the queue mocked.
- Consumers (`catalog.product_deleted`, `tenancy.shop_deleted`, `tenancy.shop_status_changed`) are driven by delivering real envelopes to the real consumer entry point; each has the duplicate-delivery and invalid-payload test of VII.4 (AS-53, AS-54, AS-55).
- Jobs run through the real job entry points with the frozen clock; "two schedulers at once" runs the job twice with `Promise.all`.
- The product check uses catalog's real exported service on a seeded product (R1); the shop gate is S03's real guard with seeded memberships.
- Unit specs sit beside the code, are table-driven (`it.each`) and exist only for pure logic (VII.5): the graph, the ladder and playlist, the probe rules, the limits, the delivery path builders, the status table. A `fast-check` property covers the graph (any acyclic random graph sorts so every dependency precedes its dependents; adding one back edge is always detected). No unit tests for controllers, repositories, consumers or glue.
- UI journeys (Playwright, owned by W04 and W02, happy path only): `packages/web/tests/seller-video.spec.ts`. No video UI exists in `packages/web` today (gaps F1).
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (AS-59).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`videoStartResponseSchema`, `videoUploadStateSchema`, `videoCompleteResponseSchema`, `videoOwnerSchema`, `videoListSchema`, `videoPlaybackSchema`, `productVideosSchema`) and outbox payloads with `videoEventSchemas`.

Abbreviations for the e2e files (all under `libs/domains/media/`):

| Key | File | Top-level `describe` |
|---|---|---|
| U | `video-upload.e2e-spec.ts` | `Video upload API` |
| P | `video-pipeline.e2e-spec.ts` | `Video transcoding pipeline` |
| D | `video-delivery.e2e-spec.ts` | `Video playback and delivery API` |
| M | `video-management.e2e-spec.ts` | `Video management API` |
| L | `video-lifecycle.e2e-spec.ts` | `Video lifecycle jobs and consumers` |
| E | `video-events.e2e-spec.ts` | `Video events, observability and configuration` |

Unit files: `domain/dag.spec.ts` (`task graph`), `domain/hls.spec.ts` (`HLS ladder and master playlist`), `domain/probe-rules.spec.ts` (`source validation`), `domain/task-limits.spec.ts` (`task time limits and backoff`), `domain/delivery-paths.spec.ts` (`delivery path builders`), `domain/video-status.spec.ts` (`video status machine`).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 start | U: 201 body, row, history row, part count and lengths, no key or upload id in the body, body ≤ 4 KiB, frozen expiry, share token for unlisted | — | — |
| AS-02 start validation | U: table-driven bad bodies and both boundaries, nothing persisted, no storage call | — | — |
| AS-03 start authorization and shop gate | U: 401, `VIEWER` 403, non-member and unknown shop identical 404, `SUSPENDED` 403, `DELETING` 409 | — | — |
| AS-04 start product link | U: own `ACTIVE` product 201, unknown and other shop's identical 404, `ARCHIVED` 409; one batch read asserted | — | — |
| AS-05 pending-upload quota | U: 9 held + `Promise.all` of 5 → one 201 and four 409; free one then 201 | — | — |
| AS-06 start and write rate limits | U: 21st start 429 + `Retry-After`; 121st mutation 429; limiter store down (fault proxy on Redis) → 503 | — | — |
| AS-07 storage failure at start | U: fault proxy refuse and hang → 503 within 5 s, quota unchanged, row `EXPIRED`; retry after recovery 201 | — | — |
| AS-08 storage enforces each part permission | U: real PUT to MinIO: correct body, ±1 byte, another part's URL, expired URL, another video's URL; objects asserted | — | — |
| AS-09 resume | U: 7 of 12 parts present → uploaded and missing lists, fresh URLs, unchanged `expiresAt`; closed states 409, hidden states 404 | — | — |
| AS-10 complete | U: 202, storage-side part comparison, size check, two history rows, one `probe` task, one message after commit, no storage call inside a transaction (asserted with a transaction-scoped query log) | — | `video-status.spec.ts`: every from/to pair against the legal table |
| AS-11 complete before all parts, mismatched parts | U: 409 `upload_incomplete` with missing parts; wrong etag 422; duplicate, unsorted, empty 400; status unchanged, no message | — | — |
| AS-12 complete replay and concurrency | U: `Promise.all` of two completes, one transition, one assembly, one message; replays on `PROCESSING`, `READY`, `FAILED` | — | — |
| AS-13 complete illegal states and hidden access | U: `EXPIRED` 409, `DELETED`, unknown and other shop's identical 404, 400, 401, `VIEWER` 403 | — | — |
| AS-14 complete storage failure, size mismatch | U: fault proxy on assembly → 503 and `UPLOADED`, retry succeeds; size mismatch → `FAILED` `source_size_mismatch`, source deleted, one `video.failed` | — | — |
| AS-15 happy path | P: real 6 s 720p clip → wave order, `READY`, master with 3 renditions, VOD playlists, poster, sprite, one `video.ready`, history rows, all tasks `DONE` | — | — |
| AS-16 graph model | — | — | `dag.spec.ts`: order, cycle, unknown, duplicate, self dependency, readiness with `SKIPPED`, `FAILED`, `CANCELLED`; `fast-check` property |
| AS-17 ladder | — | — | `hls.spec.ts`: `it.each` over source heights 2160…144 and odd widths, aspect and even-size checks, lowest-rung bitrate cap |
| AS-18 renditions line up | P: real sources at 24, 25, 30, 50, 60 fps → equal segment counts and boundaries, keyframe at each start, ≤ 4.5 s, VOD, end-of-list, target 4 | — | — |
| AS-19 master playlist accuracy | P: measured peak and average against the segments, real resolution, frame rate, codecs; audio-less source has no audio codec | — | `hls.spec.ts`: master builder with measured inputs (ordering, formatting) |
| AS-20 source validation | — | — | `probe-rules.spec.ts`: `it.each` over every code and every boundary (7,200 s, 3,840×2,160, 1 s, 16×16) |
| AS-21 source rejection end to end | P: text file, audio-only, truncated MP4 → `FAILED` with code, one attempt, other tasks `CANCELLED`, no outputs, one `video.failed`, no decoder text in `GET` | — | — |
| AS-22 fan-in exactly once | P: four siblings finish via `Promise.all` → one `package` claim and message; duplicate messages for finished tasks are stale no-ops | — | — |
| AS-23 one runner per task | P: same message to two workers at once → one runs, one "busy" with no attempt; lease expiry takeover counts an attempt | — | — |
| AS-24 retry with backoff | P: stub encoder fails twice then works → attempts, delays 30 s and 120 s, success; fails three times → `FAILED`, cancelled tasks, event, fourth message no-op; storage cause → `storage_unavailable` | — | `task-limits.spec.ts`: backoff table |
| AS-25 timeout and kill | P: stub encoder that never ends → SIGKILL, process gone, attempt counted `task_timeout`; 10 MB output floods bounded; no shell (argument with metacharacters is inert) | — | `task-limits.spec.ts`: `max(600 s, 3 × duration)` capped at 3 h table |
| AS-26 fenced completion | P: two attempts of one rendition, first loses its lease → separate output locations, only the recorded attempt marks `DONE`, loser's objects removed, master references one attempt | — | — |
| AS-27 publish guard | P: `Promise.all(delete, publish)` repeated → never `READY` after `DELETED`; no `video.ready` when delete won | — | — |
| AS-28 optional sprite | P: stub failure of `thumbnails` ×3 → `SKIPPED`, `READY`, `spriteUrl: null`; success → sprite dimensions, tile count cap and text track | — | — |
| AS-29 progress | P: poll through a run → `tasksTotal` 1 then full, `tasksDone` monotonic, equal at `READY` | — | — |
| AS-30 package verifies storage | P: delete a rendition's last segment before `package` → retryable failure, no master, not published | — | — |
| AS-31 public playback | D: 200 body, host and path, no `Set-Cookie`, cache header, no source key or storage address anywhere | — | — |
| AS-32 unlisted playback | D: token → 200, cookie attributes, `Domain` is the parent, `Expires`, no-store, credential policy decoded and signature verified, scope one video | — | — |
| AS-33 unlisted without token | D: none, wrong, foreign, empty token → identical 404 body to unknown ID, no cookie | — | — |
| AS-34 only ready, only visible | D: every status → 404; suspended shop → 404 then resumes; delete → 404 at once | — | — |
| AS-35 signing misconfigured | D: no key → 503, no URL, no cookie | — | — |
| AS-36 originals never served | D: every route and status scanned for the source location and storage addresses, for owner and anonymous callers | — | `delivery-paths.spec.ts`: public, unlisted and source prefixes pairwise disjoint; no client string in any key (`it.each`) |
| AS-37 delivery objects | D: head on every stored output → content type and immutable cache header | — | — |
| AS-38 product page list | D: mixed videos → only `READY` public, newest first, ≤ 10; archived, sandbox, unknown, suspended-shop product → 404; one batch read | — | — |
| AS-39 read rate limit | D: 601st request 429; limiter store down → served | — | — |
| AS-40 no write per view | D: 1,000 playbacks → row counts and `updatedAt` identical, outbox unchanged, counter = 1,000 | — | — |
| AS-41 secrets out of logs | D: captured logs, error bodies and metrics scanned for the token, cookie values, key, part URLs; `token` shown as `[redacted]` | — | — |
| AS-42 read one | M: owner view fields; no location, upload id, encoder text; other shop, unknown, non-member identical 404; `VIEWER` may read | — | — |
| AS-43 list keyset | M: 45 videos, pages of 20, inserts between pages, limit bounds, bad and foreign cursor 400, `DELETED` absent, no other shop's rows | — | — |
| AS-44 edit optimistic | M: version bump, stale 409 with current version, concurrent edits one 200 one 409, `visibility` and unknown fields 400, `DELETED` 404 | — | — |
| AS-45 link to a product | M: R1 rules, unlink, 11th link 409, two concurrent links on 9 → one succeeds | — | — |
| AS-46 retry failed video | M: retryable codes 202 with resumed tasks and messages after commit; non-retryable 409; wrong state 409; concurrent retries; 4th retry 409; purged source 409 | — | — |
| AS-47 delete | M: 204, row, history, one `video.deleted`, tasks `CANCELLED`, reads stop at once, upload aborted after commit, second delete 404, `VIEWER` 403, 401 | — | — |
| AS-48 cross-tenant matrix | M: every seller route with the other shop's video and as non-member → identical 404 bodies; nothing changed | — | — |
| AS-49 expire unfinished uploads | L: 24 h boundary with frozen clock, multipart aborted, `complete` → 409, double and concurrent runs one effect | — | — |
| AS-50 recover stuck work | L: four stuck kinds each recovered once; repeated and concurrent sweeps add no second message; duplicates stale | — | — |
| AS-51 processing time limit | L: 6 h boundary → `FAILED` `processing_timeout`, tasks `CANCELLED`, one event | — | — |
| AS-52 purge | L: `DELETED`, `EXPIRED`, old `FAILED` removed; `READY` outputs untouched; missing objects fine; edge-cache removal spy called, failure repeated next run; idempotent; batch cap | — | — |
| AS-53 consumer: product deleted | L: effect, duplicate delivery single effect, invalid payload dead-lettered, foreign shop ID no effect | — | — |
| AS-54 consumer: shop deleted | L: 450 videos in batches, one event each, replay no change, invalid payload dead-lettered | — | — |
| AS-55 consumer: shop status, out of order | L: v5 then v4 keeps `SUSPENDED` v5; duplicates; no-video shop; invalid payload; playback and list react | — | — |
| AS-56 events | E: three events in the state-change transaction, envelope, schemas, rollback via trigger leaves nothing, no secret in any payload | — | — |
| AS-57 observability | E: metrics registry names and increments after a scripted run; log fields; trace propagated from the queue message | — | — |
| AS-58 configuration | E: boot with each missing or invalid setting → exit naming it; non-production unsigned mode → 503 for unlisted | — | — |
| AS-59 boundary and ownership | E: runs `check:table-ownership --strict` and `check:boundaries`; registry entries; no foreign key (catalog query on the migrated schema); `VideoModule` boots from a test module importing only the barrel | — | — |
| AS-60 delivery and storage operations | — (operations artifact: infrastructure code plus a post-deploy check; not an API test) | — | — |
| AS-61 UI journey | — | `seller-video.spec.ts`: upload with an interrupted part, processing state, product page plays, share link plays for an anonymous visitor | — |
| AS-62 graceful shutdown | E: stub encoder running three tasks, close the app → encoders killed, tasks `QUEUED` with unchanged attempts, pools closed last, exit within 30 s | — | — |
