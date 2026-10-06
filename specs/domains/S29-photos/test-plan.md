# Test Plan: S29 — Product and review photos (domain `media`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/media/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `MediaModule` (plus `MediaWorkerModule`, `MediaProjectorModule` where the row needs them) with the production pipe, filter, prefix and interceptors, and call it through `supertest`. Postgres, the outbox, Redis (rate limits) and an S3-compatible object store (MinIO) are real, with real migrations.
- Only system-edge dependencies are faked: the malware scanner (a fake adapter that can report clean, infected, slow or down), the clock (frozen), and the queue (the real port with the in-memory transport of the test harness, so messages can be read, delivered twice and delivered concurrently). **Fault injection** uses real mechanisms: a TCP fault proxy in front of MinIO (refuse, hang, fail the nth write) for AS-19, AS-23 and AS-24, and a Postgres trigger that raises on the outbox insert for the rollback check of AS-56.
- The worker is exercised through `createMediaProcessor` wired exactly like `apps/lambdas` (real database, real MinIO, fake scanner), and also through the real queue consumer for the delivery-count rule (AS-22).
- Consumers (`catalog.product_deleted`, `tenancy.shop_deleted`) are driven by delivering real envelopes to the real consumer entry point; each has the duplicate-delivery and invalid-payload test of VII.4 (AS-39, AS-40).
- R1 (`MediaQueryService`) is exercised from a test module that imports only `@app/domains/media` (also proves the barrel is sufficient, AS-59).
- Unit specs sit beside the code, are table-driven (`it.each`), and exist only for pure logic (VII.5): the image transformation (real libvips, no mocks), matching rules, band recall (`fast-check`), the status table. No unit tests for controllers, repositories, consumers or glue.
- UI journeys (Playwright, owned by W04, happy path only): `packages/web/tests/seller-photos.spec.ts`. No photo UI exists in `packages/web` today (gaps F1).
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (AS-59).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`mediaUploadResponseSchema`, `mediaOwnerSchema`, `mediaPublicSchema`, `mediaBatchItemSchema`, `galleryMemberSchema`, `galleryPublicSchema`) and outbox payloads with `mediaEventSchemas`.

Abbreviations for the e2e files (all under `libs/domains/media/`):

| Key | File | Top-level `describe` |
|---|---|---|
| U | `media-upload.e2e-spec.ts` | `Media upload API` |
| P | `media-processing.e2e-spec.ts` | `Media processing pipeline` |
| D | `media-duplicates.e2e-spec.ts` | `Media duplicate detection` |
| G | `media-gallery.e2e-spec.ts` | `Product gallery API` |
| C | `media-consumers.e2e-spec.ts` | `Media event consumers` |
| R | `media-read.e2e-spec.ts` | `Media read API` |
| L | `media-lifecycle.e2e-spec.ts` | `Media lifecycle and jobs` |
| E | `media-events.e2e-spec.ts` | `Media events, observability and configuration` |

Unit files: `infra/image-pipeline.spec.ts` (`image pipeline`), `domain/duplicate-match.spec.ts` (`duplicate matching`), `domain/media-status.spec.ts` (`media status machine`).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 presign, product | U: 201 body, row, key shape, history row, signed conditions in the policy, body ≤ 4 KiB, frozen expiry | `seller-photos.spec.ts` request and upload (first half of the journey) | — |
| AS-02 presign, review | U: 201 with a personal key; `product`, `post`, other and missing purpose → 400, nothing persisted | — | — |
| AS-03 presign validation and authorization | U: table-driven bad bodies, 401, `VIEWER` 403, non-member and unknown shop identical 404, `SUSPENDED` 403, `DELETING` 409 | — | — |
| AS-04 pending-upload quota | U: 50 rows then 409 with count, free one then 201, scopes counted separately | — | — |
| AS-05 rate limits | U: 31st user request and 121st shop request 429 + `Retry-After`; limiter store down (fault proxy on Redis) → 503 | — | — |
| AS-06 storage enforces the policy | U: real POST to MinIO: valid, wrong type, 15 MiB + 1, wrong key; objects asserted | — | — |
| AS-07 complete | U: 202 `UPLOADED`, history, one queue message after commit (message absent when the transaction is rolled back by a trigger) | — | — |
| AS-08 complete before bytes, bad object | U: 409 `upload_incomplete` then success; oversize and empty object → 200 `REJECTED` `size_invalid`, object deleted | — | — |
| AS-09 complete replay and concurrency | U: `Promise.all` of two completes, one transition and one message; replays on each status | — | — |
| AS-10 complete on terminal states | U: `EXPIRED` 409, `DELETED` and unknown identical 404, 400, 401 | — | — |
| AS-11 notification path, out-of-order complete | P: native notification only → `READY`; later `complete` → 200 and no message; foreign prefix ignored | — | — |
| AS-12 happy path | P: JPEG with GPS → `READY`, variants widths, stored objects' metadata and headers, one outbox row, one transaction | `seller-photos.spec.ts` wait for the thumbnail to appear | — |
| AS-13 metadata and orientation | — | — | `image-pipeline.spec.ts`: orientation 6, EXIF, GPS, XMP, IPTC, ICC, sRGB tolerance (`it.each` over metadata kinds) |
| AS-14 never upscaled | — | — | `image-pipeline.spec.ts`: 300×200 table |
| AS-15 deterministic | — | — | `image-pipeline.spec.ts`: two runs, one concurrent pair, equal hashes |
| AS-16 rejection classes | — | — | `image-pipeline.spec.ts`: `it.each` over the ten inputs and their codes, bomb decided from the header |
| AS-17 rejection end to end, declared type ignored | P: PHP declared `image/jpeg` → `REJECTED`, no variant, `media.rejected`; PNG declared `image/jpeg` → `READY` | — | — |
| AS-18 malware | P: infected fake → `REJECTED` `malware_detected`, original deleted, event | — | — |
| AS-19 scanner unavailable | P: hang and refuse → transient failure, `PROCESSING`, attempt counted, never `READY`; then clean retry succeeds | — | — |
| AS-20 duplicate delivery | P: deliver 3 times, one effect, `SKIPPED` for each terminal status, unknown key counter | — | — |
| AS-21 concurrent delivery, lease takeover | P: `Promise.all` of two workers, one `BUSY`, one outbox row; clock +5 min takeover with attempt 2 | — | — |
| AS-22 poison input, attempt cap | P: failing blob store, five deliveries → `REJECTED` `processing_failed`, acknowledged | — | — |
| AS-23 timeouts | P: fault proxy hangs the read; cut at 20 s (fake timers), attempt counted | — | — |
| AS-24 partial variant write | P: fault proxy fails the third put; retry completes with the same keys, no extra objects | — | — |
| AS-25 flagged across shops | D: re-saved copy → `READY`, private row fields, event flag, moderation row, no leak in any response, counter | — | — |
| AS-26 not flagged | D: same shop, unrelated, review purpose both ways, non-`READY` candidates | — | — |
| AS-27 matching rules | — | — | `duplicate-match.spec.ts`: distance 3 vs 4, nearest, tie by earliest ID, near-uniform hashes (`it.each`) |
| AS-28 recall guarantee | — | — | `duplicate-match.spec.ts`: `fast-check` over hashes and up to 3 flipped bits; the cap counter is proven in `media-duplicates.e2e-spec.ts` (D) with 501 seeded candidates in one band |
| AS-29 simultaneous near-duplicates | D: `Promise.all` of two workers on two copies of two shops, both `READY`, exactly one suspicion | — | — |
| AS-30 set the gallery | G: 200 body, rows, version row, event, product through R1 | `seller-photos.spec.ts` put the finished photo first in the gallery | — |
| AS-31 replace, reorder, clear, no-op | G: versions 2 and 3, empty-list event, no-op writes nothing | — | — |
| AS-32 gallery validation | G: table-driven over every class, nothing changes | — | — |
| AS-33 photos that cannot be attached | G: unknown, other shop, review, not ready; `failures` codes indistinguishable | — | — |
| AS-34 product checks | G: unknown and foreign product identical 404, archived 409, stale version 409 with `currentVersion` | — | — |
| AS-35 concurrent edits | G: `Promise.all` of two `PUT`, one 200, one 409, one event | — | — |
| AS-36 gallery authorization | G: 401, `VIEWER` 403, non-member and unknown shop 404, `SUSPENDED` and `DELETING` | — | — |
| AS-37 member read | G: roles incl. `VIEWER`, archived product, unknown product | — | — |
| AS-38 public read follows visibility | G: visible, archived, sandbox, suspended and deleting shop, unknown, malformed | — | — |
| AS-39 product deleted event | C: deliver twice, one effect, invalid payloads dead-lettered, no-gallery no-op | — | — |
| AS-40 shop deleted event | C: deliver twice, photos `DELETED`, galleries gone, invalid payload, late worker run `SKIPPED` | — | — |
| AS-41 public read | R: body, schema, headers, no leaked fields | — | — |
| AS-42 non-ready photos are private | R: seven states × uploader, colleague, stranger, anonymous; owner view fields and headers | — | — |
| AS-43 malformed ID | R: 400 with zero statements | — | — |
| AS-44 batch read (R2) | R: order, nulls, duplicates, one statement, 400s, headers, 429 | — | — |
| AS-45 exported lookup (R1) | R: from a test module importing only `@app/domains/media`: predicates inside the query, 501 refused, DTO only | — | — |
| AS-46 read rate limit, fail open | R: 601st read 429 + `Retry-After`; limiter store down still served, failure counted | — | — |
| AS-47 delete a photo | L: 204, status, history, event, 404 for everyone, replay 404, no storage call in the request | — | — |
| AS-48 delete refused | L: in gallery 409 `media_in_use`, `UPLOADED` and `PROCESSING` 409 `media_busy`, `VIEWER` 403, 401 | — | — |
| AS-49 state machine | — | — | `media-status.spec.ts`: `it.each` over every status pair, `DELETED` final, `assertNever` |
| AS-50 late events never resurrect | L: late notifications for `REJECTED`, `EXPIRED`, `DELETED`; second upload to a used key after `READY` | — | — |
| AS-51 expiry job | L: 61 vs 59 minutes with a frozen clock, object deleted, rerun, two instances | — | — |
| AS-52 re-drive job | L: four photos, exactly two messages, cap of 100, rerun within the minute | — | — |
| AS-53 purge job | L: 8 vs 6 days, shared variant kept, one failing delete (fault proxy), rerun | — | — |
| AS-54 cross-tenant matrix | L: every route × the two users and two shops, identical 404 bodies, data unchanged | — | — |
| AS-55 originals are never served | E: every route in every status scanned for original keys; URLs on the media origin; stored type and key shape | — | — |
| AS-56 events | E: five events parsed with `mediaEventSchemas`, envelope, atomic with the transition (a trigger on the outbox insert rolls the transition back) | — | — |
| AS-57 observability | E: metrics registry increments, log lines structured with trace IDs from the message, no bytes, names or keys | — | — |
| AS-58 configuration | E: boot with each bad production setting fails naming it; non-production scanner switch warns | — | — |
| AS-59 boundary and ownership | static: `pnpm check:table-ownership --strict` and `pnpm check:boundaries` give 0 for `media`; registry check | — | — |
| AS-60 storage tiers and delivery headers | — (operations: bucket lifecycle and CDN response-header policy in `infra/modules/s3_cloudfront`, post-deploy header check) | — | — |
| AS-61 load | — (operations: k6 presign script at 600 requests per second and the 1,000-image worker throughput script in `scripts/load-tests/`) | — | — |
