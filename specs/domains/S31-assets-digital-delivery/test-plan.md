# Test Plan: S31 — Shop Asset Library and Digital Product Delivery (domain `asset-library`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (79 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/asset-library/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `AssetsModule` and `AssetsWorkerModule` (jobs and consumers are invoked through their handlers, as other specs do) with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres, Redis, the outbox and MinIO (real object storage, real presigned URLs used with real HTTP PUT and GET), with real migrations, and call HTTP through `supertest`:
  - `asset-upload.e2e-spec.ts` — describe "Asset library: prepare, dedupe, commit, quota and idempotency"
  - `asset-access.e2e-spec.ts` — describe "Asset library: authorization and tenant isolation"
  - `asset-sync.e2e-spec.ts` — describe "Asset library: conflicts, change journal, listing, manifest and notifications"
  - `asset-lifecycle.e2e-spec.ts` — describe "Asset library: versions, delete, restore, retention and chunk cleanup"
  - `asset-share.e2e-spec.ts` — describe "Asset library: share links and download delivery"
  - `digital-delivery.e2e-spec.ts` — describe "Digital delivery: product link, purchases and buyer downloads"
  - `digital-events.e2e-spec.ts` — describe "Digital delivery: consumers of orders, products and tenancy events" (VII.4 duplicate and invalid-payload tests)
  - `asset-operations.e2e-spec.ts` — describe "Asset library: metrics, logs and scheduled jobs"
- The old `assets.e2e-spec.ts` (service calls, `BisOrderModel` seeding) is replaced by these files. The test client is a shared helper `asset-client.ts` beside the specs: it chunks with the exported pure chunker (test parameters 4/16/64 KiB), calls prepare, PUTs bytes to the issued URLs, commits. Users, shops and roles come from the S01 and S03 fixtures. Products come from the S05 fixture and the catalog's exported lookup; orders are never created: `order.paid`, `order.refunded`, `catalog.product_deleted` and `tenancy.shop_deleted` messages are built from the `packages/contracts` event schemas and delivered to the consumers' handlers. No spec injects `ProductModel`, `ShopModel`, `UserModel`, `BisOrderModel` (D-7).
- Every test asserts the response body **and** persisted state (assets, versions, chunk reference counts, journal, shares, grants, entitlements, outbox rows, jobs, objects in storage) and parses responses with the `packages/contracts` schema (VII.6).
- Only system edges are faked: identity token verification, the realtime hub's transport (a recording fake, with a switch to force failure), and the clock (frozen and advanced). Faults use real mechanisms: a gate (latch) inside the storage adapter's existence check for in-flight scenarios (AS-12, AS-16), a storage rule that fails or times out one call (AS-17, AS-41, AS-57), a limiter store switched off (fail-open check inside AS-58).
- Consumers have the duplicate-delivery and invalid-payload tests of VII.4 in `digital-events.e2e-spec.ts` (AS-62, AS-63, AS-70, AS-71).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `fastcdc.spec.ts` (with `fast-check`), `conflict-name.spec.ts`, `content-disposition.spec.ts`, `asset-path.spec.ts`. Controllers, repositories, jobs and glue get no unit tests.
- UI journey (Playwright): **no web capability owns these screens yet** (see `questions.md`, CONTRACT "Web owners"). Proposed journeys, one happy path each, never repeating an edge case: W04 `packages/web/e2e/asset-library.spec.ts` — a seller opens the library (data seeded through the API), creates a share link, copies it; W02 or W07 share landing `packages/web/e2e/share-link.spec.ts` — open the link, press download, the file arrives; W03 `packages/web/e2e/my-purchases.spec.ts` — a buyer of a digital product opens "My purchases" and downloads. Rows below mark the step each journey would cover as "proposed (owner to be named)"; the API column still holds the deep proof. The sync client's save → synced journey is a CLI or desktop test outside the web suite.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-79).
- Gate 9 (VII.9): AS-17 (storage down at commit), AS-33 (hub down), AS-41 (object delete refused), AS-57 (storage fails while streaming), AS-58 (limiter fail-open) each force their fault.
- Concurrency tests use `Promise.all` and assert that exactly one succeeds and the invariant holds (VII.3): AS-15, AS-24, AS-29, AS-43, AS-44, AS-50, AS-62, AS-75; AS-12 and AS-71 use a gate and a duplicate delivery.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 prepare returns only missing | `asset-upload.e2e-spec.ts`: 6 chunks all missing with 900 s permissions, upload, commit, prepare again → 0 missing / 6 stored; chunk rows with reservations | — | — |
| AS-02 dedupe within a call, across files, never across shops | `asset-upload.e2e-spec.ts`: duplicate collapse, second file reuses chunks, shop B sees all missing with own keys, shop A rows untouched | — | — |
| AS-03 prepare validation | `asset-upload.e2e-spec.ts`: `it.each` over each invalid body class, `400`, no rows; 5,000 and 16 MiB boundary `200` | — | — |
| AS-04 one hash, one size | `asset-upload.e2e-spec.ts`: `422 chunk_size_mismatch`, rows unchanged | — | — |
| AS-05 stored means confirmed in storage | `asset-upload.e2e-spec.ts`: never-uploaded chunk missing again after 10 min and 3 h (clock), then stored after real PUT | — | — |
| AS-06 upload integrity | `asset-upload.e2e-spec.ts`: real PUT of wrong bytes and wrong length refused by MinIO, commit `422 chunk_not_uploaded`, correct PUT accepted, expired permission refused | — | — |
| AS-07 commit creates the first version | `asset-upload.e2e-spec.ts`: `201` body, asset, version, refcounts, journal seq 1, hub recorded one event | proposed (W04 library: file appears) | — |
| AS-08 delta sync uploads only changed chunks | `asset-upload.e2e-spec.ts`: 1 MiB random file, 20-byte insertion, ≤ 3 missing, refcounts 2 and 1, byte-identical download via manifest, journal 1 and 2 | CLI/desktop sync journey (outside web suite) | — |
| AS-09 commit validation | `asset-upload.e2e-spec.ts`: `it.each` over path, chunk, size, base, device, header classes; `400`/`422`, no rows; 15,000 and 50 GiB boundaries pass | — | — |
| AS-10 commit refuses what it cannot prove | `asset-upload.e2e-spec.ts`: unknown, not uploaded, other shop's hash, size mismatch; nothing persisted | — | — |
| AS-11 empty file | `asset-upload.e2e-spec.ts`: `/.gitkeep` version 1, zero-chunk manifest, zero-byte download; `size_mismatch` for 5 | — | — |
| AS-12 idempotent commit | `asset-upload.e2e-spec.ts`: replay with header, one version; gate in-flight `409`; different body `422`; other shop/user independent; key expiry with clock | — | — |
| AS-13 a save that changes nothing | `asset-upload.e2e-spec.ts`: `200 unchanged`, no new rows or events | — | — |
| AS-14 storage quota | `asset-upload.e2e-spec.ts`: near-quota shop (small configured quota), `409 quota_exceeded`, dedupe-only `200`, success after delete and cleanup | — | — |
| AS-15 quota under concurrency | `asset-upload.e2e-spec.ts`: two 6 MiB prepares with `Promise.all`, one `200`, one `409`, usage ≤ quota | — | — |
| AS-16 no storage call inside a transaction | `asset-upload.e2e-spec.ts`: gate in the existence check, lock probe on chunk rows succeeds, then `201` | — | — |
| AS-17 storage unavailable at commit | `asset-upload.e2e-spec.ts`: forced timeout → `503`, `Retry-After`, generic detail, nothing persisted, failure metric; retry `201` | — | — |
| AS-18 upload rate limit | `asset-upload.e2e-spec.ts`: 121st call `429` with `Retry-After`, no write, other shop free, reads free | — | — |
| AS-19 who may do what | `asset-access.e2e-spec.ts`: endpoint × (anonymous, VIEWER, OWNER) table; status-gate cases for suspended and offboarding shop | — | — |
| AS-20 cross-tenant access | `asset-access.e2e-spec.ts`: member of S2 on S1 paths → `404 shop_not_found`; S1 asset IDs under S2 on every asset route → `404 asset_not_found`; cross-shop link attempt `404`; no state changes | — | — |
| AS-21 stale save becomes a conflicted copy | `asset-sync.e2e-spec.ts`: names, versions, both contents download, journal | — | — |
| AS-22 copies never overwrite copies | `asset-sync.e2e-spec.ts`: second and third conflict same day → `(2)`, `(3)`, earlier copy untouched | — | — |
| AS-23 conflict naming | — | — | `conflict-name.spec.ts` (`it.each` over extension, dot file, dotted directory, double extension, taken names, UTC date edge) |
| AS-24 concurrent saves, one winner | `asset-sync.e2e-spec.ts`: `Promise.all` two commits on one base, one `updated`, one `conflicted_copy`, versions `[1,2]` and `[1]`, consecutive seq | — | — |
| AS-25 creating a file that already exists | `asset-sync.e2e-spec.ts`: base 0 on existing path → conflicted copy | — | — |
| AS-26 edit versus delete | `asset-sync.e2e-spec.ts`: deleted asset, commit with base 2 → `created` new asset at the path, old stays deleted | — | — |
| AS-27 a base from the future | `asset-sync.e2e-spec.ts`: `422 invalid_base_version {currentVersion}`, nothing changes | — | — |
| AS-28 reading the journal | `asset-sync.e2e-spec.ts`: 5 changes, pages 2/2/1 through `nextCursor`, empty page keeps cursor | — | — |
| AS-29 journal order under concurrency | `asset-sync.e2e-spec.ts`: 20 parallel commits → `n+1..n+20`, no gaps or duplicates | — | — |
| AS-30 cursor misuse | `asset-sync.e2e-spec.ts`: missing, malformed, future, `limit` 0 and 1001 (the expired-cursor case is asserted in AS-76) | — | — |
| AS-31 listing the library | `asset-sync.e2e-spec.ts`: 7 live + deleted + foreign, pages 3/3/1, prefix with `%`/`_`, `deleted=true`, `syncCursor`, limit bounds | proposed (W04 library list) | — |
| AS-32 manifest and parallel chunk download | `asset-sync.e2e-spec.ts`: pages by `from`, real GET of every URL, byte-identical, version param, unknown version, deleted asset, limit bound | — | — |
| AS-33 change notification | `asset-sync.e2e-spec.ts`: one event per journaled change after commit, none for `unchanged`; hub forced down → commit `201`, failure counted | — | — |
| AS-34 version history | `asset-lifecycle.e2e-spec.ts`: 5 versions, pages 2/2/1 newest first, no hashes, foreign asset `404` | — | — |
| AS-35 delete an old version | `asset-lifecycle.e2e-spec.ts`: `204`, refcounts, v2 downloads, no journal entry | — | — |
| AS-36 illegal version deletes | `asset-lifecycle.e2e-spec.ts`: current, only, unknown, already deleted → `409`/`404`, nothing changes | — | — |
| AS-37 restore an old version | `asset-lifecycle.e2e-spec.ts`: v4 with v1's chunks, no upload, refcounts, journal; stale base → copy; deleted asset `409` | — | — |
| AS-38 delete a file | `asset-lifecycle.e2e-spec.ts`: `204`, `DELETED`, journal `delete`, path free, versions kept, share link `410`, second delete `409`, `asset_in_use` | proposed (W04 delete) | — |
| AS-39 undelete | `asset-lifecycle.e2e-spec.ts`: `200`, journal, `path_taken`, active `409`, purged `404` | — | — |
| AS-40 retention purge | `asset-lifecycle.e2e-spec.ts`: clock at 30 d ∓ 1 s, exact single release, double and concurrent run, no negative count | — | — |
| AS-41 cleanup grace and deletion | `asset-lifecycle.e2e-spec.ts`: 23 h 59 m / 24 h 1 s / stale marker with refcount 1, object then row; forced object-delete failure kept and retried | — | — |
| AS-42 reuse restarts the grace | `asset-lifecycle.e2e-spec.ts`: 25-h-old chunk, prepare, cleanup, chunk survives, commit and download | — | — |
| AS-43 cleanup racing a commit | `asset-lifecycle.e2e-spec.ts`: `Promise.all(commit, cleanup)`, either `201` with object present or `422`, every chunk of every version readable | — | — |
| AS-44 reference counts stay exact | `asset-lifecycle.e2e-spec.ts`: 10 parallel commits sharing a chunk (one listing it twice) → 11, delete in two orders → 0 exactly, then collectable | — | — |
| AS-45 version cap | `asset-lifecycle.e2e-spec.ts`: 500 seeded versions through the fixture helper, `409 version_limit_reached`, success after deleting one | — | — |
| AS-46 create and list share links | `asset-share.e2e-spec.ts`: `201` body, token ≥ 32 chars, URL on the user-content origin, digest only in the table, list without tokens, foreign and deleted asset `404` | proposed (W04 share dialog creates a link) | — |
| AS-47 share limits | `asset-share.e2e-spec.ts`: `it.each` over invalid `expiresInHours` and `maxDownloads`; boundary values `201` | — | — |
| AS-48 preview never counts | `asset-share.e2e-spec.ts`: 5 previews `200`, `downloads` 0; every unavailable reason identical `410` body | proposed (share landing shows file name and size) | — |
| AS-49 redeem, then download | `asset-share.e2e-spec.ts`: redeem `200`, count 1, GET bytes identical, repeat GET same count, 121 s → `410` | proposed (share landing: press download, file arrives) | — |
| AS-50 the cap holds under a crowd | `asset-share.e2e-spec.ts`: cap 3, 10 `Promise.all` redeems → 3 `200` + 7 `410`, `downloads` 3 | — | — |
| AS-51 expiry boundary | `asset-share.e2e-spec.ts`: `T − 1 s` `200`, `T` `410`, preview the same (clock) | — | — |
| AS-52 revoke | `asset-share.e2e-spec.ts`: `204`, status, redeem `410`, outstanding URL `410`, second revoke `409`, foreign link `404` | — | — |
| AS-53 deleted file | `asset-share.e2e-spec.ts`: asset deleted → `410`, count unchanged; undelete → works until expiry | — | — |
| AS-54 a link serves the latest version | `asset-share.e2e-spec.ts`: v2 served after redeem; issued URL keeps its version | — | — |
| AS-55 safe delivery headers | `asset-share.e2e-spec.ts`: `/promo/pic.svg` share and buyer-style grant headers asserted exactly, no cookie | — | — |
| AS-56 attachment file names | — | — | `content-disposition.spec.ts` (`it.each` over quotes, CR/LF, `;`, `\`, `%`, long, control-only, empty, non-ASCII) |
| AS-57 storage fails while streaming | `asset-share.e2e-spec.ts`: first chunk unavailable → `503` before any byte; later chunk fails → aborted short body, metric, no leak | — | — |
| AS-58 anonymous rate limit | `asset-share.e2e-spec.ts`: 61st preview/redeem/download call `429`, no counter change, other address free; limiter store off → fail open | — | — |
| AS-59 link a file to a product | `digital-delivery.e2e-spec.ts`: `204`, `GET` link, outbox event once, repeat no event, foreign product/asset/unknown/deleted `404`, VIEWER `403` | — | — |
| AS-60 re-link and unlink | `digital-delivery.e2e-spec.ts`: re-link moves entitlements, unlink with entitlements `409`, free unlink `204` + event, unlinked `404` | — | — |
| AS-61 grant on payment | `digital-events.e2e-spec.ts`: contract-valid `order.paid`, one entitlement with title, none for non-digital line, quantity 3 → one, outbox event | — | — |
| AS-62 duplicate delivery | `digital-events.e2e-spec.ts`: twice in sequence and twice with `Promise.all` → one entitlement, one event | — | — |
| AS-63 invalid or foreign messages | `digital-events.e2e-spec.ts`: `it.each` malformed payloads dead-lettered with no rows; foreign-shop line ignored; next message processed | — | — |
| AS-64 refund revokes | `digital-events.e2e-spec.ts`: `order.refunded` twice → revoked once, event once, download request `404`, outstanding URL `410` | — | — |
| AS-65 events out of order | `digital-events.e2e-spec.ts`: refund before paid, paid replay after refund, unrefunded paid grants | — | — |
| AS-66 My purchases | `digital-delivery.e2e-spec.ts`: buyer with 3 active + 1 revoked, other buyer, pages 2/1, limit bounds, `401` | proposed (W03 "My purchases" lists the item) | — |
| AS-67 download for a buyer | `digital-delivery.e2e-spec.ts`: grant `200`, counter and `lastDownloadAt`, GET bytes identical, `X-Licensed-To`, version pinned across a v2 commit | proposed (W03 "My purchases" → Download) | — |
| AS-68 not yours | `digital-delivery.e2e-spec.ts`: non-buyer, shop member, unknown product, revoked → identical `404`; `401` | — | — |
| AS-69 a download URL is short and uniform | `digital-delivery.e2e-spec.ts`: `expiresAt − 1 s` `200`, `expiresAt` `410`; tampered, truncated, empty, cross-kind, purged → identical `410` | — | — |
| AS-70 product deleted | `digital-events.e2e-spec.ts`: link removed once, event once, entitlements still download, invalid payload dead-lettered | — | — |
| AS-71 shop deleted | `digital-events.e2e-spec.ts`: full purge of S1, entitlements revoked with events, S2 untouched, duplicate no-op, invalid payload dead-lettered; objects removed by the cleanup path | — | — |
| AS-72 grant rate limit | `digital-delivery.e2e-spec.ts`: 31st request `429` with `Retry-After`, no counter change, other buyer free | — | — |
| AS-73 metrics | `asset-operations.e2e-spec.ts`: read the registry after the flows, assert each counter, gauge and histogram increments | — | — |
| AS-74 secrets stay out of logs | `asset-operations.e2e-spec.ts`: captured logs contain no token, presigned query or body; route template and `requestId` present | — | — |
| AS-75 jobs run once, safely | `asset-operations.e2e-spec.ts`: each of the four jobs triggered twice with `Promise.all`, single effect, repeat no change | — | — |
| AS-76 journal retention | `asset-operations.e2e-spec.ts`: 91-day vs 89-day entries, floor recorded; the `410 cursor_expired` assertion of AS-30 is made here after the job | — | — |
| AS-77 chunker | — | — | `fastcdc.spec.ts` (`it.each` over parameter sets plus `fast-check`: reconstruction, bounds, determinism, ≤ 3 changed chunks per insertion, mean size, short input, empty input) |
| AS-78 path rules | — | — | `asset-path.spec.ts` (`it.each` over valid and invalid paths, NFC forms, case distinct) |
| AS-79 ownership gate | static: `check:table-ownership --strict`, `check:boundaries`, `check:model-registry`, no foreign key in this capability's migrations (a one-off script assertion in CI) | — | — |

Notes on duplicated mentions: AS-30's expired-cursor case and AS-76 describe the same behaviour from two sides. The row for AS-30 asserts the malformed, missing, future and limit cases; the expired-cursor assertion is made once, in `asset-operations.e2e-spec.ts` after the purge job (AS-76), so the edge case is proven in exactly one place.
