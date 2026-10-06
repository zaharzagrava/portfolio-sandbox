# Test Plan: S12 — Order Export (domain `orders`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (61 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/orders/`. Each file's top-level `describe` names its feature (VII.8):
  - `order-export.e2e-spec.ts` — `describe('Order export: start, file, download, access')`
  - `order-export-streaming.e2e-spec.ts` — `describe('Order export: streaming, batches and backpressure')`
  - `order-export-progress.e2e-spec.ts` — `describe('Order export: progress and live channel')`
  - `order-export-worker.e2e-spec.ts` — `describe('Order export: worker, failures, cancel and recovery')`
  - `order-export-lifecycle.e2e-spec.ts` — `describe('Order export: retention, shop events, boundaries, observability')`
- They boot the real `OrderExportModule` and `OrderExportWorkerModule` (plus `OrderExportTopicsModule` where a file needs it, and the tenancy, identity, **catalog** and orders modules they depend on, the outbox, the rate limiter, the realtime hub, the scheduler and the idempotency interceptor) with the production pipe, filter, prefix and interceptors, against real Postgres (migrated), Redis, object storage (MinIO) and the queue stand-in from `docker-compose.test.yaml`. Requests go through `supertest`; the worker entry is called with real queue messages. Every test asserts the response body **and** the persisted state (job and history rows, outbox rows, storage contents, queue messages) and parses responses with the contracts schemas (VII.6). State is cleaned before each test and seeded through the shared fixture helpers (the standard orders `F5` is a helper); time is frozen by the injected clock.
- Only system-edge dependencies are faked or wrapped: a **recording and gating wrapper around the storage port** (counts bytes accepted, pauses or fails the upload on command, injects a stall), a failing realtime publisher for AS-17, and the catalog's lookup is the real exported service with a recording spy (call counts and IDs) plus a failing variant for the failure case. Faults use real mechanisms: a killed lease (the test moves the clock past it), two app instances (`appA`, `appB`) in one process for race, single-run and fencing cases, and a Postgres query on `pg_stat_activity` for AS-10. No project repository, model or store is stubbed.
- Consumers (`order-exports` queue message, `tenancy.shop_offboarding_started`, `tenancy.shop_deleted`) each have the duplicate-delivery and invalid-payload tests of VII.4 (AS-43, AS-44, AS-53–AS-55).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): `domain/export-csv.spec.ts`, `domain/export-progress.spec.ts`, `domain/export-failure.spec.ts`, `domain/export-state.spec.ts`. No unit tests for controllers, repositories, consumers or glue. Money has no arithmetic here (digits are passed through), so the only money check is AS-03's large amount; no property test is needed.
- UI journey (Playwright, owned by W04, happy path only): `packages/web/tests/seller-order-export.spec.ts` — a seller opens the orders screen, clicks "Export orders", the progress bar moves, the job reaches done and the download link saves the CSV. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-57).
- Gate 9 (VII.9): AS-17, AS-33, AS-34, AS-38 and AS-51 (delete refused) are degradation paths and each forces its fault.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 start | `order-export.e2e-spec.ts`: `202`, `Location`, body parsed by `orderExportSchema`; job, history, one message on `order-exports`, none on `catalog-imports`, nothing in storage | — | — |
| AS-02 run, full effect | `order-export.e2e-spec.ts`: `F5`, worker handles the message; job `DONE`, file 5 lines, history, outbox row, live events, `GET` equals final state | `seller-order-export.spec.ts` (start → progress → done → download; also covers the happy paths of AS-01 and AS-05) | — |
| AS-03 columns and content | `order-export.e2e-spec.ts`: header exact, `L1`/`L2` records, 9,007,199,254,740,993 exact, UTC ms timestamps, no personal data | — | — |
| AS-04 empty shop | `order-export.e2e-spec.ts`: `DONE`, BOM + header only, `bytesWritten` = size, `done {0, bytes}` | — | — |
| AS-05 download | `order-export.e2e-spec.ts`: `{url, expiresAt}`, link attachment parameters, fetch returns the bytes, one audit log line without the link | — | — |
| AS-06 determinism | `order-export.e2e-spec.ts`: two exports byte-identical | — | — |
| AS-07 SKU and title | `order-export.e2e-spec.ts`: spy shows 2 calls (500 + 200) scoped to the shop; deleted product → empty SKU; title from snapshot | — | — |
| AS-08 only the shop's own lines | `order-export.e2e-spec.ts`: `S` 5 lines, `S2` 1 line, legacy null-shop line in neither, spanning order split by shop | — | — |
| AS-09 batch boundaries | `order-export-streaming.e2e-spec.ts`: 2,500 identical timestamps; 0, 1,000, 1,001; straddling shop order; each line once, documented order | — | — |
| AS-10 orders change during the run | `order-export-streaming.e2e-spec.ts`: gated storage, new order and status change; `pg_stat_activity` shows no open transaction or held connection; file contents | — | — |
| AS-11 backpressure | `order-export-streaming.e2e-spec.ts`: 50,000 lines, storage held, ≤ 3,000 read; release, completes once | — | — |
| AS-12 constant memory (benchmark) | not e2e: `scripts/bench/order-export-bench.ts` generates 1,000,000 lines, runs the real pipeline, records time and heap at 100k and 1M; output attached to the PR | — | — |
| AS-13 CSV encoding | — | — | `domain/export-csv.spec.ts` (`it.each` over the cell table: commas, quotes, CR, LF, padding, Unicode, empty, 10,000 characters; CRLF; determinism) |
| AS-14 formula guard | — | — | `domain/export-csv.spec.ts` (`it.each` over `= + - @ TAB CR` and neutral starts; numeric columns untouched) |
| AS-15 progress | `order-export-progress.e2e-spec.ts`: 25,000 lines, ticking clock, 25 `progress` events then `done`, stored counters equal, replay of `done` only | — | — |
| AS-16 progress throttle | — | — | `domain/export-progress.spec.ts` (`it.each`: none → publish, 999 ms skip, 1,000 ms publish, last always, clock backwards, frozen clock → 2 events) |
| AS-17 live channel is advisory | `order-export-progress.e2e-spec.ts`: failing publisher; export `DONE`, correct file, rate-limited error log, `GET` true | — | — |
| AS-18 who may listen | `order-export-progress.e2e-spec.ts`: `U`, `W` admitted; `V`, `X`, `N`, anonymous, removed member refused identically; replayed terminal event; `job:E` refused | — | — |
| AS-19 status is the truth, not ready yet | `order-export-progress.e2e-spec.ts`: `RUNNING` read (3,000/10,000); download on `QUEUED`/`RUNNING`/`FAILED`/`CANCELLED` → `409 export_not_ready`, nothing signed | — | — |
| AS-20 replay | `order-export.e2e-spec.ts`: stored body, `Idempotency-Replayed: true`, one job, one message | — | — |
| AS-21 in flight | `order-export.e2e-spec.ts`: `Promise.all` of two, `202` + `409 idempotency_in_flight` + `Retry-After: 1`; third replays | — | — |
| AS-22 key reuse | `order-export.e2e-spec.ts`: key `K` on `Sx`'s path → `422 idempotency_key_reuse`, no job for `Sx` | — | — |
| AS-23 key missing or malformed | `order-export.e2e-spec.ts`: missing, 7, 129 characters, space → `422` codes, nothing created | — | — |
| AS-24 one active export per shop | `order-export.e2e-spec.ts`: `Promise.all` of `U` and `W` → one `202`, one `409 export_already_active {activeExportId}`; third request `409`; `S2` unaffected | — | — |
| AS-25 refusal frees the key | `order-export.e2e-spec.ts`: after `DONE`/`FAILED`/`CANCELLED`, `K2` accepted | — | — |
| AS-26 rate limit | `order-export.e2e-spec.ts`: sixth start `429 rate_limited` + `Retry-After`; limiter store down → refused, no job | — | — |
| AS-27 route × caller matrix | `order-export.e2e-spec.ts`: five routes × (anonymous, `N`/`X`, `V`, other shop's path with `E`); identical bodies; nothing changes | — | — |
| AS-28 the export belongs to the shop | `order-export.e2e-spec.ts`: `W` lists, reads, downloads, cancels `U`'s export; removed `W` → `404 shop_not_found` | — | — |
| AS-29 shop status gate | `order-export.e2e-spec.ts`: `SUSPENDED` `403`, `DELETING` `409`, `DELETED` `404`, no permission `403` first | — | — |
| AS-30 validation | `order-export.e2e-spec.ts`: malformed IDs, unknown body property, non-object, `limit` 0/101/abc, bad `status`, `invalid_cursor` | — | — |
| AS-31 list, keyset | `order-export.e2e-spec.ts`: 45 + 3 exports, pages 20/20/5, ties, `status` filter, other shop absent, parsed by `orderExportPageSchema` | — | — |
| AS-32 one export, the shape | `order-export.e2e-spec.ts`: `FAILED` read; generic message; no storage location, internal ID, key, lease | — | — |
| AS-33 transient failure, then success | `order-export-worker.e2e-spec.ts`: storage fails after 3,000 lines once; abort leaves nothing; `QUEUED` `attempt: 1`; second delivery `DONE`, 5,000 lines once, one event | — | — |
| AS-34 persistent failure | `order-export-worker.e2e-spec.ts`: three deliveries fail; `FAILED storage_unavailable`, generic message, no file or upload, one event, new export allowed | — | — |
| AS-35 failure classification | — | — | `domain/export-failure.spec.ts` (`it.each` over the error classes → retry/fail + code; third delivery; unknown class) |
| AS-36 row limit | `order-export-worker.e2e-spec.ts`: limit 10, 11 lines → `FAILED row_limit_exceeded`, nothing written, acked | — | — |
| AS-37 deadline | `order-export-worker.e2e-spec.ts`: gated run, clock past 2 h → `FAILED timeout`, no retry, no file | — | — |
| AS-38 stalled storage | `order-export-worker.e2e-spec.ts`: stall past 60 s → abort, transient failure path | — | — |
| AS-39 cancel a queued export | `order-export-worker.e2e-spec.ts`: `200 CANCELLED`, history, event; message later acked with no effect | — | — |
| AS-40 cancel a running export | `order-export-worker.e2e-spec.ts`: gated run, cancel; stops by next boundary, upload aborted, `cancelled` live event, no `done` | — | — |
| AS-41 cancel twice, illegal, concurrent | `order-export-worker.e2e-spec.ts`: second cancel `200` unchanged; `DONE`/`FAILED`/`EXPIRED` → `409 export_not_cancellable`; `Promise.all` of two cancels → one history row, one event | — | — |
| AS-42 cancel races completion | `order-export-worker.e2e-spec.ts`: gated final step; cancel first → file deleted, `CANCELLED`, no `done`; completion first → cancel `409` | — | — |
| AS-43 duplicate delivery at once | `order-export-worker.e2e-spec.ts`: two workers, same message, `Promise.all`; one claim, one file, one event | — | — |
| AS-44 messages that must not run | `order-export-worker.e2e-spec.ts`: finished states acked, unknown ID acked with warning, four invalid payloads dead-lettered with no side effect | — | — |
| AS-45 crash recovery | `order-export-worker.e2e-spec.ts`: kill at batch 7, clock +6 min, recovery job twice concurrently (`appA`, `appB`); requeued once; final file equals uninterrupted run; no partial visible | — | — |
| AS-46 lost message | `order-export-worker.e2e-spec.ts`: `QUEUED` > 2 min re-enqueued once; younger left alone | — | — |
| AS-47 attempts exhausted by recovery | `order-export-worker.e2e-spec.ts`: `RUNNING` `attempt: 3` expired → `FAILED attempts_exhausted`, no message | — | — |
| AS-48 graceful shutdown | `order-export-worker.e2e-spec.ts`: shutdown signal mid-run; `QUEUED`, `attempt` restored; redelivery completes | — | — |
| AS-49 a healthy long run is left alone | `order-export-worker.e2e-spec.ts`: 30 minutes of clock with heartbeats, recovery every minute changes nothing | — | — |
| AS-50 stale worker is fenced | `order-export-worker.e2e-spec.ts`: A loses lease, B claims; A's writes affect nothing; file has only B's bytes | — | — |
| AS-51 file expiry | `order-export-lifecycle.e2e-spec.ts`: `T−8d` expired and deleted, `T−6d` untouched, `410 export_expired`, second run no change; storage refuses delete → stays `DONE`, retried | — | — |
| AS-52 record purge | `order-export-lifecycle.e2e-spec.ts`: finished > 90 days purged with history and leftover file, active untouched, concurrent runs | — | — |
| AS-53 shop offboarding started | `order-export-lifecycle.e2e-spec.ts`: `QUEUED`/`RUNNING` cancelled, `DONE` untouched, `S2` untouched, duplicate delivery, `…_cancelled` ignored | — | — |
| AS-54 shop deleted | `order-export-lifecycle.e2e-spec.ts`: files, jobs, history of `S` gone, `S2` untouched, duplicate delivery | — | — |
| AS-55 out of order and invalid shop events | `order-export-lifecycle.e2e-spec.ts`: late `started` after `deleted` no effect; three invalid payloads dead-lettered | — | — |
| AS-56 moved out of `catalog-sync` (D-10) | `order-export-lifecycle.e2e-spec.ts`: old paths `404`, one message on `order-exports`, none on `catalog-imports`, `job:E` refused; plus a catalog-sync-only app has no export route or `kind` branch | — | — |
| AS-57 boundaries, static | static: `check:table-ownership --strict` and `check:boundaries` zero for the export files; registry has `ExportJob`, `ExportJobHistory` as `domain:orders`; no FK; barrel has no model and no `OrderExportService` | — | — |
| AS-58 observability | `order-export-lifecycle.e2e-spec.ts`: log capture on one full and one failed export (`requestId`/`traceId`, `exportId`, `shopId`; no line values, links, locations); metrics list; one audit line per download request | — | — |
| AS-59 startup configuration | `order-export-lifecycle.e2e-spec.ts`: boot with each bad value (batch < 1, row limit < 1, retention ≤ 0, lease < 2 × heartbeat, no user-content origin in production) → startup fails naming the key | — | — |
| AS-60 finished event | `order-export-lifecycle.e2e-spec.ts`: one outbox row per `DONE`/`FAILED`/`CANCELLED`, payload parsed by `orderExportEventSchemas`; none for retry, requeue, expiry, purge; trigger-forced rollback of the final update → no event, still `RUNNING` | — | — |
| AS-61 state machine | — | — | `domain/export-state.spec.ts` (`it.each` over all 36 ordered pairs of the six statuses; allowed set exact; exhaustiveness via `assertNever`) |

## Coverage notes

- **Pattern rows.** P0102 (async iteration over streamed and paged sources): FR-014, FR-016; AS-09, AS-10. P0207 (streams, backpressure, `pipeline`, object-mode transform): FR-014, FR-015, FR-017; AS-09–AS-12, AS-33, AS-40. Both are also exercised end to end by AS-02 and AS-15.
- **Constitution VII.3 per endpoint.** Happy path (AS-01, AS-02, AS-05, AS-31, AS-32, AS-39), every validation class (AS-23, AS-30), `401` and cross-tenant `404` (AS-27), `403` (AS-27, AS-29), idempotency replay, in-flight and different request (AS-20–AS-22), rate limit (AS-26), illegal transition `409` (AS-19, AS-41), invariant under concurrency (AS-24, AS-41, AS-43).
- **VII.4 consumers.** The `order-exports` queue consumer (AS-43 duplicate delivery, AS-44 invalid payload), the shop-event consumers (AS-53 and AS-54 duplicate delivery, AS-55 invalid payload).
- **Not provable in e2e, tracked as artifacts.** (a) SC-001 and AS-12: `scripts/bench/order-export-bench.ts` (memory and time at 100k and 1M lines; attached to the PR). (b) The `nosniff` header and separate origin of user content: edge configuration test in the operations artifacts, shared with S07. (c) The storage lifecycle rule that aborts incomplete uploads after one day (backstop for a dead worker's partial upload, AS-45): Terraform assertion in the operations artifacts.
- **Old e2e.** The order-export case of `catalog-import.e2e-spec.ts` (lines 120–128) is deleted there; its single useful idea (an empty shop exports a header-only file with an attachment link) survives as AS-04 and AS-05.
- **Traceability check.** 61 scenarios, 61 rows (AS-01 to AS-61); each edge case in `spec.md` appears in exactly one row; rows that name both an e2e behaviour and a pure rule (AS-33/AS-35, AS-02/AS-16) prove the integration and the pure rule respectively and are not duplicates.
