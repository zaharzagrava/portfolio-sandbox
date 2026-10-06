# Feature Specification: S12 — Order Export: Streamed CSV to Object Storage, Live Progress, Moved Out of Catalog-Sync (domain `orders`)

**Feature Branch**: `S12-order-export` (spec directory `specs/domains/S12-order-export`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S12 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-27-bulk-catalog-import.md` (the "Order export" row), `specs/004-phase2-batch3-domains/plan.md` (debt D-10), `02-Node.js/02-streams-and-backpressure.md` (§2–§4, interview Q&A "2 GB CSV report"). Pattern-map rows covered: **P0102** (async iteration over paged and streamed sources) and **P0207** (streams, backpressure, `pipeline`, object-mode transform) — both are proven here by FR-014–FR-017 and AS-09–AS-12. Debt closed: **D-10** (FR-036, AS-56) and this domain's export share of **D-7 / D-12** (FR-037, AS-57).

## Scope

An **order export** lets a shop's staff download everything the shop has sold as one CSV file. Large shops have millions of order lines, so the file is built in the background, in constant memory, straight into object storage; the seller starts it, watches it progress live, and downloads it through a short-lived link. This capability owns the export job, the CSV file, the routes, the queue, the live progress channel, and the clean-up of old exports. It also takes the export routes, the export job table and the export queue **out of `catalog-sync`**, where the Phase 2 move left them (debt D-10).

In scope:

- Starting an export (idempotent, one active export per shop, rate limited), reading one export or the shop's list of exports, downloading the finished file, cancelling.
- The CSV itself: which lines, which columns, exact money, a safe and readable encoding, a deterministic order.
- Streaming in constant memory with backpressure from the storage side back to the order store; correctness across batch boundaries and while orders change during the run.
- The job state machine (`QUEUED → RUNNING → DONE | FAILED | CANCELLED`, then `EXPIRED`), single-runner claims with a lease, retries, crash recovery, graceful shutdown, limits and deadlines.
- Live and polled progress, the live channel's viewer policy, the "finished" event other capabilities may react to.
- Retention (file and record), reaction to a shop's offboarding and deletion.
- The move out of `catalog-sync` (routes, queue, worker branch, live-topic prefix) and the ownership and boundary checks for the export files.

Out of scope (owned elsewhere):

- The order tables, order lifecycle, item snapshots and the order list reads → **S10** (this capability reads them inside its own domain; they are `orders`' own tables). Flash-sale stock → S11.
- Product records, product SKU data → **S05** (SKU is read through its exported lookup, R1).
- Bulk catalog **import**, its routes, queue and worker → **S07** (it deletes its export branch; this capability provides what replaces it).
- Statement and ledger exports (CSV for accounting) → **S16**. A whole-shop offboarding bundle → composition outside **S03**'s spec.
- The generic realtime hub, rate limiter, job scheduler, outbox, consumer framework, idempotency store and error filter → **S51**, **S50**, **S49**, **S53**, **S54**.
- The export button, progress bar and download in the seller dashboard → **W04** (it calls the routes and the live channel named below).
- Filters (date range, status, columns) and other formats (JSON lines, XLSX, compressed files): not in this release (Assumptions).

## User Scenarios & Testing *(mandatory)*

Notation used by every scenario. `S` and `S2` are `ACTIVE` shops. `U` is the `OWNER` of `S` (has `orders.manage`), `W` a `STAFF` member of `S` (has `orders.manage`), `V` a `VIEWER` of `S` (no `orders.manage`), `X` the owner of `S2`, `N` a signed-in user who is a member of no shop. `B` is a buyer. Time is frozen at `T = 2026-10-05T09:00:00.000Z` unless a scenario moves it ("the clock" is the injected clock the tests control). An **export** is `E`; "the queue" is `order-exports`. Amounts are integer minor units. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`; for 5xx `detail` is generic. "Storage" is the object store behind the storage port; "the file" is the CSV object of one export. "Parsed by the schema" means the response parses with the named `packages/contracts` schema.

**Standard fixture `F5`** (used where a scenario says "the standard orders"): buyer `B`; order `O1` (created `T−3d`, `EUR`) with shop order `SO1` of `S` (`PAID`) holding line `L1` (product `P1`, SKU `SKU-P1`, title snapshot `Cable, braided`, quantity 2, unit price 1000, discount 100, line total 1900) and line `L2` (`P2`, `SKU-P2`, `He said "hi"`, 1 × 500, discount 0, total 500); order `O2` (`T−2d`, `EUR`) with `SO2` of `S` (`SHIPPED`) holding `L3` (`P1`, 1 × 1000, 0, 1000) and shop order `SO2b` of `S2` holding `L5` (`P3`, 1 × 700, 0, 700); order `O3` (`T−1d`, `EUR`) with `SO3` of `S` (`CANCELLED`) holding `L4` (`P2`, 3 × 500, 0, 1500) and `L6` (`P1`, 1 × 1000, 0, 1000). So shop `S` has **5 lines in 3 shop orders**, shop `S2` has 1 line.

### User Story 1 — A seller exports the shop's orders as a CSV file (Priority: P1)

A seller with several years of sales clicks "Export orders". The job is queued at once; a background worker reads the shop's order lines and writes a CSV into storage; when it is done the seller downloads the file through a link that works for ten minutes. The file has exactly the shop's own lines, with exact money, readable in a spreadsheet.

**Why this priority**: it is the capability. Everything else protects, explains or hardens this path.

**Independent Test**: seed `F5` with a real database and real storage, drive the real routes as `U`, run the worker entry on the queued message, download through the link and compare the bytes.

**Acceptance Scenarios**:

1. **AS-01** (start) — **Given** `S` with no export, `U`, and `Idempotency-Key: k-0001-abcd`, **When** `U` calls `POST /shops/S/order-exports` with body `{}`, **Then** `202` with `Location: /api/shops/S/order-exports/<E>` and `{exportId, status: "QUEUED", rowsWritten: 0, totalRows: null, bytesWritten: 0, attempt: 0, failure: null, createdBy: U, createdAt: T, startedAt: null, finishedAt: null, expiresAt: null}` parsed by `orderExportSchema`; and exactly: one job (shop `S`, creator `U`, `QUEUED`), one history row (`null → QUEUED`, actor `U`, at `T`), one message `{exportId: E}` on `order-exports`, **zero** messages on `catalog-imports`, nothing in storage, no outbox row.
2. **AS-02** (run, full effect) — **Given** the standard orders `F5`, the product lookup returning SKUs, and `E` queued for `S`, **When** the worker handles `E`'s message, **Then** the job passes `RUNNING` to `DONE` with `attempt: 1`, `totalRows: 5`, `rowsWritten: 5`, `bytesWritten` equal to the file's size in storage, `startedAt: T`, `finishedAt: T`, `expiresAt: T + 7 days`; exactly one file exists for `E`; it holds the header and **5** lines (none of `S2`'s `L5`); history shows `QUEUED → RUNNING → DONE`; one outbox row `order_export.finished` (AS-60); live events on `order-export:E` are one or more `progress` then one `done {rowsWritten: 5, bytesWritten}`; the job read by `GET /shops/S/order-exports/E` equals the final state and is parsed by `orderExportSchema`.
3. **AS-03** (file content and columns) — **Given** `F5` plus a line of `S` priced `9007199254740993` minor units, **When** the export of `S` is `DONE`, **Then** the file starts with a UTF-8 byte-order mark, its first record is exactly `order_id,shop_order_id,created_at,shop_order_status,currency,product_id,sku,title,quantity,unit_price_minor,discount_minor,line_total_minor`, and `L1` appears as `<O1>,<SO1>,2026-10-02T09:00:00.000Z,PAID,EUR,<P1>,SKU-P1,"Cable, braided",2,1000,100,1900`, `L2` as `…,PAID,EUR,<P2>,SKU-P2,"He said ""hi""",1,500,0,500`; the 9,007,199,254,740,993 amount appears digit for digit (no rounding, no exponent, no decimal point); timestamps are ISO-8601 UTC with milliseconds; **no** column or value holds a buyer ID, e-mail, address, payment reference, shop name or any other personal or payment data (the header is the whole column set).
4. **AS-04** (empty shop) — **Given** a shop with no orders, **When** its export runs, **Then** it ends `DONE` with `totalRows: 0`, `rowsWritten: 0`, a file containing only the byte-order mark and the header record, `bytesWritten` equal to that file's size, and a `done {rowsWritten: 0, bytesWritten}` event.
5. **AS-05** (download) — **Given** `E` `DONE`, **When** `U` calls `GET /shops/S/order-exports/E/download`, **Then** `200 {url, expiresAt: T + 10 minutes}` parsed by `orderExportDownloadSchema`; the `url` is on the user-content origin, valid until `expiresAt`, and carries an attachment disposition with the file name `orders-<E>.csv` and content type `text/csv`; fetching it before `expiresAt` returns the exact bytes of the file; the log has one `order_export_downloaded` line with `exportId`, `shopId`, `userId` and **without** the link.
6. **AS-06** (determinism) — **Given** `F5` unchanged, **When** two exports of `S` run one after another, **Then** their files are byte-identical (same order, same bytes), ordered by shop-order creation time, then shop-order ID, then line ID.
7. **AS-07** (SKU and title) — **Given** a batch of 1,000 lines over 700 distinct products, product `P9` deleted from the catalog since purchase, and product `P1` renamed in the catalog after purchase, **When** the export runs, **Then** the SKU column is filled through the catalog's exported lookup in exactly **2** calls for that batch (500 and 200 distinct IDs, never one call per line), each scoped to the shop; lines of `P9` have an empty SKU cell and are still exported; the title column holds the snapshot taken at purchase (`Cable, braided`), not the catalog's new title.
8. **AS-08** (only the shop's own lines) — **Given** `F5` and a legacy line of `S2` whose shop is unknown (null), **When** `S` and `S2` each export, **Then** `S`'s file has 5 lines and `S2`'s file has 1 line (`L5`); no line appears in both; the legacy line appears in neither; order `O2`, which spans both shops, contributes only each shop's own shop order.

---

### User Story 2 — Large exports run in constant memory and never lose or repeat a line (Priority: P1)

A shop with 10 million order lines starts an export. The worker must not run out of memory, must not hold a database connection or a snapshot for the whole run, must slow down when storage is slow, and must write every line exactly once even when many lines share a timestamp and orders keep arriving.

**Why this priority**: it is what the notes teach (cursor → CSV → multipart upload in one `pipeline`, backpressure all the way) and the main way an export fails in production (out-of-memory, tearing, duplicates).

**Independent Test**: seed 2,500 lines with one identical timestamp and 50,000 lines for the backpressure case, run the worker with a storage wrapper that can pause consumption, and count reads and bytes.

**Acceptance Scenarios**:

1. **AS-09** (batch boundaries) — **Given** a shop with 2,500 lines whose shop orders all share one creation time (batches of 1,000), 1,000 exactly, 1,001 and 0 lines in further runs, and a shop order whose three lines straddle a batch boundary, **When** each export runs, **Then** every line appears **exactly once**, none is skipped or repeated, the order is (shop-order time, shop-order ID, line ID), the straddling shop order appears complete, and `rowsWritten == totalRows == ` the seeded count.
2. **AS-10** (orders change during the run) — **Given** an export of 3,000 lines paused after its first batch (storage gated), **When** a new order of `S` is created, an old shop order's status changes, and the paused state is inspected, **Then** the order store shows **no** open transaction and no connection held by the export between batches; after release, the file does not contain the new order (created after the request), contains each earlier line exactly once, shows each line's shop-order status as it was when its batch was read, and `rowsWritten == totalRows == 3000`.
3. **AS-11** (backpressure) — **Given** 50,000 lines and storage that accepts no bytes (the test holds the consumer), **When** the worker runs, **Then** at most **3,000** lines are read from the order store while storage accepts nothing; **When** storage is released, **Then** the run completes with 50,000 lines, each once; memory use does not grow with the lines read.
4. **AS-12** (constant memory, benchmark) — **Given** a generated shop of 1,000,000 order lines, **When** the export runs end to end through the real pipeline, **Then** it reaches `DONE` in under 5 minutes and the worker's heap stays below 200 MB, with the same ceiling at 100,000 and at 1,000,000 lines (flat, not proportional).
5. **AS-13** (CSV encoding, pure) — **Given** text cells `plain`, `a,b`, `say "x"`, `line1⏎line2` (LF), `line1␍line2` (CR), `  padded  `, `日本語 🚀`, `` (empty) and a 10,000-character title, **When** a record is encoded, **Then** cells containing a comma, a double quote, CR or LF are wrapped in double quotes with inner quotes doubled, others are written as they are (padding and Unicode kept, nothing truncated), fields are separated by commas, records end with CRLF, and the same input always yields the same bytes.
6. **AS-14** (spreadsheet formula guard, pure) — **Given** text cells (`sku`, `title`) beginning with `=`, `+`, `-`, `@`, a tab or a carriage return, **When** encoded, **Then** the cell is written with a single leading apostrophe (`'=HYPERLINK("http://x")`) and is then quoted as in AS-13; cells beginning with any other character are unchanged; numeric columns (quantity and the three money columns) and IDs are never modified.

---

### User Story 3 — The seller watches the export progress, live or by polling (Priority: P1)

While the file is being built the dashboard shows a progress bar and a row count. The live channel is a convenience; the job read is the truth, and a missed message costs nothing.

**Why this priority**: an export of minutes needs visible progress (async request-reply, P0407); without it users start duplicates.

**Independent Test**: run a 25,000-line export with a ticking clock, collect the live events and compare them with the polled job.

**Acceptance Scenarios**:

1. **AS-15** (progress) — **Given** 25,000 lines (batches of 1,000), a clock that advances 1 s per batch, and a listener on `order-export:E`, **When** the export runs, **Then** it publishes 25 `progress` events `{rowsWritten: 1000, 2000, …, 25000, totalRows: 25000, bytesWritten}` with strictly increasing counters, then one `done {rowsWritten: 25000, bytesWritten}`; the stored job counters equal the last progress event at each point; `rowsWritten ≤ totalRows` always; the progress events are not replayable to late subscribers and the `done` event is.
2. **AS-16** (progress throttle, pure) — **Given** the decision "publish a progress event now?" with inputs (now, time of the last event or none, batch is the last), **Then** the table holds: no previous event → publish; previous event 999 ms ago, not last → skip; exactly 1,000 ms ago → publish; the last batch → always publish; clock going backwards (now before the previous event) → publish and reset; with a frozen clock a 25-batch export publishes exactly two events (first and last batch).
3. **AS-17** (live channel is advisory, degradation) — **Given** the realtime backplane failing every publish, **When** the export runs, **Then** it still ends `DONE` with a correct file and counters, the failures are logged once per minute at most without row data, and `GET /shops/S/order-exports/E` shows the true state.
4. **AS-18** (who may listen) — **Given** the topic `order-export:E`, **When** `U` or `W` (current members of `S` with `orders.manage`) subscribe, **Then** they are admitted; **When** `V` (member without the permission), `X` (member of another shop), `N`, an anonymous caller, or a member removed from `S` a moment ago subscribe, **Then** every one is refused identically; a subscriber arriving after the end receives the replayed terminal event; the old topic prefix `job:` carries nothing for exports (AS-56).
5. **AS-19** (status is the truth, not ready yet) — **Given** `E` `RUNNING` with 3,000 of 10,000 rows written, **When** `U` polls `GET /shops/S/order-exports/E`, **Then** `200` with `status: "RUNNING"`, `rowsWritten` a multiple of 1,000 at most 3,000, `totalRows: 10000`, `expiresAt: null`; **When** `U` calls `…/download` on a `QUEUED`, `RUNNING`, `FAILED` or `CANCELLED` export, **Then** `409 export_not_ready` and nothing is signed.

---

### User Story 4 — A double click, a retry or two staff starting at once make one export (Priority: P2)

Starting an export is expensive. A flaky network retry must not start a second one, two members clicking together must not run two at once, and a loop must not hammer the system.

**Why this priority**: protects the worker pool and the order store; the platform's idempotency contract (V.6) and the "invariant under concurrency" case (VII.3).

**Independent Test**: fire real concurrent requests with `Promise.all` and replay requests with the same key.

**Acceptance Scenarios**:

1. **AS-20** (replay) — **Given** AS-01 completed with key `K`, **When** the same request is sent again with `K` (as `U`, same path, same body), **Then** `202`, the byte-identical stored body, `Location` and header `Idempotency-Replayed: true`; still one job, one history row and one message.
2. **AS-21** (in flight) — **Given** no export, **When** two identical requests with the same key `K` are sent at the same instant, **Then** one answers `202` and the other `409 idempotency_in_flight` with `Retry-After: 1`; one job exists; after the first completes a third identical request replays as in AS-20.
3. **AS-22** (key reuse) — **Given** key `K` used by `U` for shop `S`, **When** `U` (also an owner of a third shop `Sx`) sends `K` to `POST /shops/Sx/order-exports`, **Then** `422 idempotency_key_reuse` and no job is created for `Sx`; keys are scoped to the calling user.
4. **AS-23** (key missing or malformed) — **Given** no `Idempotency-Key` header, **Then** `422 idempotency_key_required`; **Given** a key of 7 characters, 129 characters, or one containing a space, **Then** `422 idempotency_key_invalid` (a key is 8–128 characters of `[A-Za-z0-9_-]`); no job is created in any case.
5. **AS-24** (one active export per shop, concurrency) — **Given** `S` with no active export, **When** `U` and `W` send `POST /shops/S/order-exports` at the same instant with different keys, **Then** exactly **one** answers `202` and the other `409 export_already_active` with `activeExportId` set to the winner's ID; one job and one message exist; a third request while the first is `QUEUED` or `RUNNING` also answers `409 export_already_active`; the shop `S2`'s export is unaffected.
6. **AS-25** (refusal frees the key; a new export after the old one ends) — **Given** AS-24's loser used key `K2`, **When** the winner's export is `DONE` (or `FAILED` or `CANCELLED`) and `K2` is sent again, **Then** `202` creating a new export (a refusal before creation stores nothing under the key); the completed export no longer blocks starts.
7. **AS-26** (rate limit) — **Given** `S` has started 5 exports within the last hour (each finished or cancelled), **When** `U` starts a sixth, **Then** `429 rate_limited` with `Retry-After` set to the seconds until the oldest start leaves the window and no job; **Given** the rate-limit store is unreachable, **Then** the request is refused (fail closed) with the problem the platform defines for it and no job exists.

---

### User Story 5 — Only the shop's authorised staff see and use its exports (Priority: P2)

An export is a bulk copy of a shop's sales. It must never reach another shop, a viewer without the permission, or someone who has just been removed.

**Why this priority**: cross-tenant leakage of a whole order history is the worst failure this capability can have (constitution III.4, VII.3, SC-004).

**Independent Test**: a matrix over every route against every caller class, with the persisted state asserted after each call.

**Acceptance Scenarios**:

1. **AS-27** (route × caller matrix) — **Given** export `E` of `S`, **When** each of `POST /shops/S/order-exports`, `GET /shops/S/order-exports`, `GET …/E`, `GET …/E/download`, `POST …/E/cancel` is called without credentials, **Then** `401`; by `N` or `X` (non-members of `S`), **Then** `404 shop_not_found`, byte-identical to the answer for a shop that does not exist; by `V`, **Then** `403 permission_denied`; by `X` calling `GET /shops/S2/order-exports/E` (a real export of `S` under their own shop's path), **Then** `404 export_not_found`, byte-identical to the answer for an ID that does not exist; in every refusal nothing changes (no job, no history row, no message, nothing signed).
2. **AS-28** (the export belongs to the shop) — **Given** `E` started by `U`, **When** `W` lists, reads, downloads and cancels `E`, **Then** all work (an export is a shop resource, not the creator's); **When** `W` is removed from the shop and calls the same routes, **Then** the very next request answers `404 shop_not_found`.
3. **AS-29** (shop status gate) — **Given** `S` `SUSPENDED`, **When** `U` calls any export route, **Then** `403 shop_suspended`; **Given** `S` `DELETING`, **Then** `409 shop_offboarding`; **Given** `S` `DELETED`, **Then** `404 shop_not_found`; a caller lacking the permission gets `403 permission_denied` before any status answer; no job is created in any case.
4. **AS-30** (validation) — **Given** a malformed `shopId` or `exportId` (`abc`), **Then** `400 validation_failed`; **Given** a create body with an unknown property (`{"kind":"orders"}`) or a non-object body, **Then** `400 validation_failed`; **Given** list query `limit=0`, `limit=101`, `limit=abc`, or `status=UNKNOWN`, **Then** `400 validation_failed`; **Given** `cursor=garbage` or a cursor that does not decode, **Then** `400 invalid_cursor`; nothing is created.
5. **AS-31** (list, keyset) — **Given** `S` with 45 finished exports (some sharing one creation time) and `S2` with 3, **When** `U` calls `GET /shops/S/order-exports?limit=20`, **Then** `200 {items, nextCursor}` parsed by `orderExportPageSchema` with 20 items newest first, an opaque `nextCursor`; following it twice returns the other 25 (20 then 5, `nextCursor: null`), every export exactly once in the order (`createdAt` descending, ID descending); `?status=DONE` returns only `DONE`; no item of `S2` appears; `limit` defaults to 20 and is at most 100.
6. **AS-32** (one export, the shape) — **Given** a `FAILED` export, **When** `U` reads it, **Then** `200` with `failure: {code, message}` (message generic, no stack, SQL, storage or catalog text) and none of: storage location, internal IDs, idempotency key, lease holder, history.

---

### User Story 6 — Failures, cancellation, crashes and duplicate deliveries end in one clean outcome (Priority: P2)

Storage hiccups, a killed worker, a deploy in the middle, a duplicate queue message, or the seller changing their mind must each end with either one complete file or no file, never a half-written one visible, and never two workers writing the same job.

**Why this priority**: this is where background exports usually go wrong; it is the "illegal transitions, duplicates, timeouts" part of the notes.

**Independent Test**: inject faults through real mechanisms (a failing or gated storage wrapper, a killed lease by moving the clock, two app instances) and assert the final state, the stored file and the outbox.

**Acceptance Scenarios**:

1. **AS-33** (transient failure, then success) — **Given** 5,000 lines and storage that fails the upload after 3,000 lines on the first delivery only, **When** the message is delivered, **Then** the partial upload is aborted (no file at the export's location, no incomplete upload left), the job returns to `QUEUED` with `attempt: 1`, counters reset (`rowsWritten: 0`), history `RUNNING → QUEUED` reason `retry`, the message is handed back for redelivery after 60 s ± 20 %, and **no** finished event is written; on the second delivery the job ends `DONE` with `attempt: 2`, a file of exactly 5,000 lines (each once), and one `DONE` event.
2. **AS-34** (persistent failure) — **Given** storage that fails on every attempt, **When** the message is delivered three times, **Then** after the third the job is `FAILED` with `attempt: 3`, `failure: {code: "storage_unavailable", message: "The file could not be stored. Start a new export."}`, no file, no incomplete upload, the message is acknowledged (not redelivered), one `FAILED` event and one `failed {code}` live event; a new export can then be started (AS-25).
3. **AS-35** (failure classification, pure) — **Given** the decision "retry or fail, and with which code" over the error classes, **Then**: storage error, storage inactivity timeout, upload abort → retry, code `storage_unavailable`; catalog lookup timeout or error → retry, `catalog_unavailable`; order-store timeout, connection reset, deadlock or serialization error → retry, `database_unavailable`; row limit exceeded → fail now, `row_limit_exceeded`; run deadline exceeded → fail now, `timeout`; shop no longer exists → fail now, `shop_not_found`; any other error → fail now, `internal_error`; a retry on the third delivery becomes a failure with the same code; the table is closed (an unknown class is `internal_error`).
4. **AS-36** (row limit) — **Given** the limit set to 10 and a shop with 11 lines, **When** the export runs, **Then** it ends `FAILED` on the first delivery with `failure.code: "row_limit_exceeded"`, `totalRows: 11`, `rowsWritten: 0`, `attempt: 1`, nothing written to storage, the message acknowledged, one `FAILED` event.
5. **AS-37** (deadline) — **Given** a run held by gated storage and the clock moved past the run deadline (2 hours), **When** the worker next checks, **Then** the run stops, the upload is aborted, the job is `FAILED` with `failure.code: "timeout"` without retry, and no file remains.
6. **AS-38** (stalled storage) — **Given** storage that accepts no bytes for longer than the inactivity limit (60 s), **When** the clock passes it, **Then** the upload is aborted and the delivery is treated as the transient failure of AS-33 (`storage_unavailable`), never waiting forever.
7. **AS-39** (cancel a queued export) — **Given** `E` `QUEUED`, **When** `U` calls `POST /shops/S/order-exports/E/cancel`, **Then** `200` with `status: "CANCELLED"`, `finishedAt: T`, history `QUEUED → CANCELLED` (actor `U`), one `CANCELLED` event; **When** the message of `E` is then delivered, **Then** it is acknowledged with no effect: no `RUNNING`, no file.
8. **AS-40** (cancel a running export) — **Given** `E` `RUNNING` and paused after 3 batches, **When** `U` cancels it, **Then** `200 CANCELLED`; the worker stops no later than its next batch boundary or heartbeat, aborts the upload, leaves no file and no incomplete upload; `rowsWritten` stays at the last stored value; a `cancelled {}` live event is published and no `done`; one `CANCELLED` event.
9. **AS-41** (cancel twice, illegal, concurrent) — **Given** `E` `CANCELLED`, **When** `U` cancels again, **Then** `200` with the same body and no second history row or event; **Given** `E` `DONE`, `FAILED` or `EXPIRED`, **Then** `409 export_not_cancellable` and nothing changes; **Given** `E` `RUNNING` and `U` and `W` cancel at the same instant, **Then** both answer `200`, there is one history row and one event.
10. **AS-42** (cancel races completion) — **Given** a worker that has uploaded all bytes and is about to mark `E` `DONE`, **When** a cancel lands first, **Then** the worker's completion changes nothing, the uploaded file is deleted, `E` stays `CANCELLED`, no `done` event and no `DONE` event; **When** the completion lands first instead, **Then** the cancel answers `409 export_not_cancellable` and the file stays.
11. **AS-43** (duplicate delivery at once) — **Given** `E` `QUEUED`, **When** two workers handle the same message at the same instant, **Then** exactly one claims it (`attempt: 1`) and runs; the other returns without processing; there is one file, each line once, one `DONE` history row, one finished event.
12. **AS-44** (messages that must not run) — **Given** a message for an export that is `DONE`, `FAILED`, `CANCELLED` or `EXPIRED`, **Then** it is acknowledged with no effect (no file, no history, no event); **Given** a message for an ID that does not exist, **Then** it is acknowledged, one warning without row data is logged, no effect; **Given** invalid payloads (`{}`, `{"exportId":"x"}`, `{"exportId":"<uuid>","extra":1}`, the old shape `{"kind":"export","jobId":"<uuid>"}`), **Then** each is rejected to the dead-letter path with no side effect and none touches an import job.
13. **AS-45** (crash recovery) — **Given** a worker killed mid-run (after 7 of 10 batches) whose lease then expires (the clock moves 6 minutes), **When** the recovery job runs, **Then** `E` returns to `QUEUED` (history `RUNNING → QUEUED` reason `lease_expired`, counters reset) and its message is enqueued again; the next delivery produces `DONE` with a file identical to an uninterrupted run; the dead worker's partial upload was never visible as the file; **When** the recovery job runs twice concurrently, **Then** the job is requeued once.
14. **AS-46** (lost message) — **Given** `E` `QUEUED` for more than 2 minutes with no message in flight (the enqueue after commit was lost), **When** the recovery job runs, **Then** exactly one new message for `E` is enqueued and later duplicates are harmless (AS-43); a `QUEUED` export younger than 2 minutes is left alone.
15. **AS-47** (attempts exhausted by recovery) — **Given** `E` `RUNNING` with `attempt: 3` whose lease expired, **When** the recovery job runs, **Then** `E` is `FAILED` with `failure.code: "attempts_exhausted"`, no new message, one `FAILED` event, no file.
16. **AS-48** (graceful shutdown) — **Given** `E` `RUNNING`, **When** the worker receives the shutdown signal, **Then** it stops at the next batch boundary, aborts the upload, returns `E` to `QUEUED` with `attempt` restored to its value before the claim (a deploy never burns a retry), and the redelivered message later completes it with one file; no partial file is visible.
17. **AS-49** (a healthy long run is left alone) — **Given** an export running for 30 minutes of clock time whose worker renews its lease every 60 s, **When** the recovery job runs every minute, **Then** it never changes the job.
18. **AS-50** (stale worker is fenced) — **Given** worker A lost its lease, the job was recovered and claimed by worker B, **When** A then tries to report progress, write counters or finish, **Then** each of A's writes affects nothing, A stops and aborts its own upload, and the file for `E` contains only B's bytes; the job history has no entry by A after the recovery.

---

### User Story 7 — Old exports disappear, deleted shops leave nothing, and the old home is clean (Priority: P3)

Files are kept for a week, records for three months. A shop that is offboarded or deleted takes its exports with it. And nothing about order export is left in `catalog-sync`.

**Why this priority**: data minimisation and the debt payment; correct but not on the daily path.

**Independent Test**: move the clock, run the scheduled jobs and the shop-event consumers, and inspect the tables, storage and the module graph.

**Acceptance Scenarios**:

1. **AS-51** (file expiry, with a degradation path) — **Given** `E1` `DONE` finished at `T−8d` and `E2` `DONE` at `T−6d`, **When** the expiry job runs, **Then** `E1` is `EXPIRED` (history `DONE → EXPIRED` reason `retention`, file deleted) and `E2` is untouched; `GET …/E1/download` answers `410 export_expired` and `GET …/E1` shows `EXPIRED`; a second run changes nothing; **Given** storage refusing the delete, **Then** `E1` stays `DONE` (never `EXPIRED` with a file left), the failure is logged, and the next run retries it.
2. **AS-52** (record purge) — **Given** finished exports (`DONE`, `FAILED`, `CANCELLED`, `EXPIRED`) older than 90 days and active exports of the same age, **When** the purge job runs, **Then** the finished ones and their history are deleted (any leftover file first), `GET …/E` answers `404 export_not_found`, and the active ones are untouched; two concurrent runs end in the same state.
3. **AS-53** (shop offboarding started) — **Given** `S` has `E1` `QUEUED`, `E2` `RUNNING` and `E3` `DONE`, **When** the shop event `tenancy.shop_offboarding_started {shopId: S, purgeAt}` is consumed, **Then** `E1` and `E2` become `CANCELLED` (reason `shop_offboarding`, the running worker aborts, no file), `E3` is untouched, `S2`'s exports are untouched; the same event delivered twice has the same single effect; `tenancy.shop_offboarding_cancelled` is ignored.
4. **AS-54** (shop deleted) — **Given** exports of `S` in several states and of `S2`, **When** `tenancy.shop_deleted {shopId: S}` is consumed, **Then** any active export of `S` is cancelled first, every file of `S` is deleted from storage, every job and history row of `S` is deleted, `S2`'s are untouched; delivering it twice leaves the same end state with no error.
5. **AS-55** (out of order and invalid shop events) — **Given** `tenancy.shop_deleted` for `S` consumed before a late `tenancy.shop_offboarding_started` for `S`, **Then** the late event has no effect and raises no error; **Given** payloads `{shopId: 5}`, `{}`, an unknown `version`, **Then** each is rejected to the dead-letter path with no side effect.
6. **AS-56** (moved out of `catalog-sync`, debt D-10) — **Given** an application loading the orders export modules, **When** `POST /shops/S/exports/orders` or `GET /shops/S/exports/E` is called, **Then** `404` (the old routes have no alias and no redirect); **When** an export starts, **Then** exactly one message `{exportId}` is on `order-exports` and none on `catalog-imports`; handling it touches no import job; the old topic prefix `job:` is not registered by orders, so a subscription to `job:E` is refused; **Given** the catalog-sync modules alone, the import queue consumer has no `kind: 'export'` branch and the import module has no export route (S07 AS-70).
7. **AS-57** (boundaries, static) — **Given** the repository after the change, **When** `pnpm --dir packages/backend check:table-ownership --strict` and `pnpm check:boundaries` run, **Then** they report zero findings for the export files: they query only `ExportJob`, `ExportJobHistory`, `ShopOrder`, `BisOrder`, `BisOrderItem` (all `domain:orders`); no `Product`, `Shop`, `User`, `Payment` or outbox table, model or association; no foreign key from the export tables to another owner's table; no import of `catalog-sync` by `orders` or of `orders` by `catalog-sync`; the barrel of `@app/domains/orders` exports no `*Model` and no `OrderExportService`; both export tables are in the ownership registry under `domain:orders`.
8. **AS-58** (observability) — **Given** one full export and one failed export, **Then** every log line carries `requestId` or `traceId` and, on job lines, `exportId` and `shopId`; no log line contains a title, SKU, product ID, amount of a line, buyer data, a presigned link, a storage location or a stack in a response; metrics exist for exports by final status (`done|failed|cancelled|expired`), lines written, bytes written, run duration, queue wait, retries by failure code, and downloads; the `order_export_downloaded` audit line of AS-05 exists once per download request.
9. **AS-59** (startup configuration) — **Given** configuration with a batch size below 1, a row limit below 1, a retention of zero or less, a lease shorter than twice the heartbeat, or (in production) no user-content origin, **When** the application starts, **Then** startup fails naming the key, before accepting traffic or consuming the queue.
10. **AS-60** (finished event) — **Given** exports ending `DONE`, `FAILED` and `CANCELLED`, **Then** each produces **exactly one** outbox row `order_export.finished` v1 (envelope `{eventId, type, version: 1, occurredAt, aggregateId: exportId}`), written in the same transaction as the final status change, with the payload `{exportId, shopId, createdBy, status, failureCode, rowsWritten, bytesWritten, attempt, startedAt, finishedAt}` parsed by `orderExportEventSchemas`; retries, requeues, expiry and purge produce none; an export whose final-status transaction rolls back produces none and stays `RUNNING`.
11. **AS-61** (state machine, pure) — **Given** the transition table, **Then** the allowed moves are exactly `QUEUED → RUNNING`, `QUEUED → CANCELLED`, `RUNNING → DONE`, `RUNNING → FAILED`, `RUNNING → CANCELLED`, `RUNNING → QUEUED` (retry, lease expiry, graceful release), `DONE → EXPIRED`; every other pair among the six statuses (including from `FAILED`, `CANCELLED`, `EXPIRED`, and `DONE → anything but EXPIRED`) is rejected, and a switch over the statuses fails to compile when one is missing.

### Edge Cases

Each edge case below is a numbered scenario above:

- Concurrency: two starts (AS-24), two cancels (AS-41), cancel vs completion (AS-42), the same message twice (AS-43), recovery run twice (AS-45), a stale worker (AS-50).
- Idempotent replay: AS-20–AS-23, AS-25; duplicate and out-of-order events AS-53–AS-55; duplicate queue messages AS-43, AS-44.
- Illegal state transitions: download too early (AS-19), cancel a finished export (AS-41), the transition table (AS-61), messages for finished exports (AS-44), download after expiry (AS-51).
- Cross-tenant: AS-08 (lines), AS-27 (routes), AS-28 (removed member), AS-18 (live channel), AS-31 (list).
- Limits and timeouts: rate limit (AS-26), one active export (AS-24), row limit (AS-36), run deadline (AS-37), storage stall (AS-38), lease and heartbeat (AS-45, AS-49), link lifetime (AS-05), retention (AS-51, AS-52).
- Streaming correctness: batch boundaries (AS-09), data changing during the run (AS-10), backpressure (AS-11), memory (AS-12).
- A failing collaborator: live channel (AS-17), storage (AS-33, AS-34, AS-38), catalog lookup (AS-35), storage delete (AS-51).

## Requirements *(mandatory)*

### Functional Requirements

**Starting, state and ownership of the job**

- **FR-001**: `POST /shops/:shopId/order-exports` (permission `orders.manage`, `Idempotency-Key` required, body `{}`) creates a job `QUEUED`, answers `202` with `Location` and the job body, and enqueues exactly one message `{exportId}` on the queue `order-exports` after the creating transaction commits (AS-01, AS-56).
- **FR-002**: The job's statuses are `QUEUED`, `RUNNING`, `DONE`, `FAILED`, `CANCELLED`, `EXPIRED`; the allowed transitions are exactly those of AS-61; every transition is a conditional update that must affect exactly one row, with a history row in the same transaction; a refused transition answers `409` to a caller and does nothing to a worker (AS-02, AS-39–AS-42, AS-61).
- **FR-003**: At most one export per shop is `QUEUED` or `RUNNING` at any time, enforced by the store, so two simultaneous starts yield exactly one `202` and one `409 export_already_active {activeExportId}` (AS-24, AS-25).
- **FR-004**: Starting follows the platform idempotency contract (V.6): replay returns the stored status, body and `Idempotency-Replayed: true`; an in-flight duplicate answers `409 idempotency_in_flight` with `Retry-After: 1`; a key reused for a different request or by another user answers `422 idempotency_key_reuse`; a missing or malformed key answers `422 idempotency_key_required` / `idempotency_key_invalid`; keys live 24 hours; a refusal before creation stores nothing under the key (AS-20–AS-23, AS-25).
- **FR-005**: Starts are limited to 5 per shop per hour, failing closed when the limiter is unreachable (AS-26).
- **FR-006**: `GET /shops/:shopId/order-exports/:exportId` and `GET /shops/:shopId/order-exports` (keyset page ordered by creation time then ID descending, opaque cursor, `limit` default 20, at most 100, optional `status`) return the job DTO of AS-01 and AS-32 and never a storage location, internal ID, idempotency key or lease data (AS-19, AS-31, AS-32).

**File content**

- **FR-007**: The file holds one record per order line of the shop's own shop orders created at or before the moment of the request, with exactly the 12 columns of AS-03, in the order (shop-order creation time, shop-order ID, line ID); the same data always yields byte-identical files (AS-02, AS-03, AS-06, AS-08).
- **FR-008**: Money is written as integer minor-unit digits with no loss at any magnitude; timestamps as ISO-8601 UTC with milliseconds (AS-03).
- **FR-009**: The file contains no buyer, payment or shop-identity data (AS-03).
- **FR-010**: The title column is the snapshot taken at purchase; the SKU column is read, per batch, through the catalog's exported lookup (IX.7 **R1**, `ProductQueryService.getProductsByIds`) in calls of at most 500 distinct products scoped to the shop, never per line; a product the catalog no longer knows leaves the SKU empty (AS-07).
- **FR-011**: The file is UTF-8 with a byte-order mark, comma-separated, records end with CRLF, text cells follow RFC 4180 quoting (AS-03, AS-13).
- **FR-012**: Text cells that begin with a spreadsheet formula character are neutralised as in AS-14.
- **FR-013**: A shop with no lines exports a header-only file and ends `DONE` (AS-04).

**Streaming**

- **FR-014**: The run reads the order store in keyset batches of 1,000 lines, each batch its own short read; it holds no long-lived transaction, snapshot or connection between batches; memory use does not depend on the number of lines (AS-09, AS-10, AS-12).
- **FR-015**: A slow or stopped storage slows or stops reading: at most 3,000 lines are read ahead of what storage has accepted (AS-11).
- **FR-016**: Lines created after the request are excluded; lines already in the file are never duplicated or skipped when orders change during the run; each line shows its state when its batch was read (AS-09, AS-10).
- **FR-017**: A file becomes visible only when complete; on any failure, cancellation, shutdown or fencing the partial upload is aborted and no file at the export's location remains (AS-33, AS-34, AS-40, AS-48, AS-50).

**Progress and download**

- **FR-018**: Stored counters (`rowsWritten`, `totalRows`, `bytesWritten`) and live `progress` events follow AS-15 and the throttle of AS-16: `totalRows` is the exact line count at the start of the run, `rowsWritten ≤ totalRows` always and equal on `DONE`; counters reset when a job returns to `QUEUED`.
- **FR-019**: The live channel `order-export:{exportId}` is advisory: its failure never fails or slows the export; terminal events are replayable, progress is not; viewers are admitted only if they are currently members of the job's shop with `orders.manage` (IX.7 **R1**, tenancy's `ShopAccessService.assertMember`) (AS-17, AS-18).
- **FR-020**: `GET …/:exportId/download` returns `{url, expiresAt}` for a `DONE` export only: a 10-minute attachment link on the user-content origin named `orders-<exportId>.csv`; `409 export_not_ready` before `DONE` (or after `FAILED`/`CANCELLED`), `410 export_expired` after `EXPIRED`; each request leaves one audit log line without the link (AS-05, AS-19, AS-51, AS-58).

**Failure, cancellation, recovery**

- **FR-021**: Retries are by queue redelivery only, at most 3 deliveries; the failure table of AS-35 decides retry versus failure and the stable code; the third failed delivery makes the job `FAILED`; no other layer retries (AS-33–AS-35).
- **FR-022**: Limits: a shop with more lines than the row limit (default 20,000,000) fails at the start without writing; a run longer than the deadline (2 h) fails with `timeout` without retry; storage inactivity longer than 60 s aborts the attempt as transient (AS-36–AS-38).
- **FR-023**: `POST …/:exportId/cancel` moves `QUEUED` or `RUNNING` to `CANCELLED`; repeated on `CANCELLED` it answers `200` unchanged; on `DONE`, `FAILED` or `EXPIRED` it answers `409 export_not_cancellable`; a running worker stops no later than its next batch boundary or lease renewal; cancel versus completion has exactly one winner (AS-39–AS-42).
- **FR-024**: A message is claimed by one worker through a conditional update that sets a lease; the lease is renewed every 60 s and lasts 5 minutes; a second concurrent delivery does nothing; a worker that lost its lease cannot change the job or the file (AS-43, AS-49, AS-50).
- **FR-025**: The consumer validates every message (`{exportId: uuid}` and nothing else), acknowledges messages for unknown or finished exports without effect, and sends invalid payloads to the dead-letter path (AS-44).
- **FR-026**: A scheduled, single-run, idempotent recovery job requeues exports whose lease expired (or fails them with `attempts_exhausted` at the third attempt) and re-enqueues `QUEUED` exports left unclaimed for more than 2 minutes (AS-45–AS-47).
- **FR-027**: On the shutdown signal a worker stops at the next batch, aborts its upload and returns the job to `QUEUED` with the attempt restored (AS-48).

**Access and errors**

- **FR-028**: Every export route requires `orders.manage` of the shop in the path and answers per the matrix of AS-27; exports are visible to every current member of the shop with that permission, not only the creator; every lookup of a job puts the shop in the predicate (AS-27, AS-28).
- **FR-029**: The shop's lifecycle gate applies: `SUSPENDED` → `403 shop_suspended`, `DELETING` → `409 shop_offboarding`, `DELETED` → `404 shop_not_found` (AS-29).
- **FR-030**: Inputs are validated with the problem codes of AS-30; all errors are RFC 9457 problem details with a stable `code`; 5xx carry a generic detail.

**Lifecycle**

- **FR-031**: A finished file is deleted 7 days after the job finished (`DONE → EXPIRED`); a finished job record and its history are deleted after 90 days; both by scheduled single-run idempotent jobs that never mark a job `EXPIRED` while its file still exists (AS-51, AS-52).
- **FR-032**: The capability consumes `tenancy.shop_offboarding_started` (cancel the shop's active exports) and `tenancy.shop_deleted` (delete its files, jobs and history); both are idempotent, tolerate out-of-order delivery and validate their payload (AS-53–AS-55).
- **FR-033**: A terminal outcome (`DONE`, `FAILED`, `CANCELLED`) publishes exactly one `order_export.finished` v1 event through the outbox in the transaction of the final status change (AS-60).

**Boundaries and operations**

- **FR-034**: Order export, its routes, its job table, its queue, its worker branch and its live-topic prefix live only in `orders`; `catalog-sync` contains none of them and does not import `orders` (AS-56).
- **FR-035**: The export code reads and writes only tables `orders` owns; product data comes only through R1; the user and shop IDs on the job are plain IDs with no foreign keys or associations; both export tables are registered under `domain:orders` (AS-57).
- **FR-036**: The queue is `order-exports`, message `{exportId}`, at most 3 deliveries then dead-letter; the queue `catalog-imports` never carries an export message (AS-01, AS-56).
- **FR-037**: Logs, metrics and the audit line follow AS-58; no log carries line data.
- **FR-038**: Configuration (batch size, row limit, deadline, lease and heartbeat, retention, link lifetime, the user-content origin) is validated at startup (AS-59).
- **FR-039**: The pure rules — CSV encoding, formula guard, progress throttle, failure classification, the transition table — are domain logic with no framework, clock or I/O imports and are unit-tested table-driven (AS-13, AS-14, AS-16, AS-35, AS-61).
- **FR-040**: Every response parses with its `packages/contracts` schema (`orderExportCreateRequestSchema`, `orderExportSchema`, `orderExportPageSchema`, `orderExportDownloadSchema`, `orderExportProgressEventSchema`, `orderExportEventSchemas`) (AS-01, AS-05, AS-15, AS-31, AS-60 and every route scenario).

### Key Entities

- **Order export job**: one request to export a shop's order lines. Has an ID, the shop, the creator (plain user ID), status, attempt count, counters (rows written, total rows, bytes written), failure code and message, lease holder and expiry, and timestamps (created, started, finished, expires). Owned by `orders`.
- **Export history entry**: one row per status change of a job: from, to, actor or system, reason, time. Owned by `orders`.
- **Export file**: the CSV in object storage, one per `DONE` job; deleted at expiry or shop deletion. Its location is never exposed.
- **Export line**: one row of the file, derived from one order line of the shop (an order's own data, plus the product SKU read through R1).
- **Progress event**: a live message `{rowsWritten, totalRows, bytesWritten}` on `order-export:{exportId}`; advisory.
- **Finished event**: `order_export.finished` v1, the durable terminal notice other capabilities may use.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A shop of 1,000,000 order lines is exported to `DONE` in under 5 minutes by one worker whose memory stays below 200 MB, and the memory ceiling is the same at 100,000 and at 1,000,000 lines (benchmark with a generated shop).
- **SC-002**: With storage stopped, at most 3,000 lines are read from the order store, in 100% of runs; no export keeps a database transaction or connection open between batches.
- **SC-003**: For exports of 0, 1, 999, 1,000, 1,001, 2,500 and 100,000 lines (including all lines sharing one timestamp), 100% contain every line exactly once in the documented order, and two exports of unchanged data are byte-identical.
- **SC-004**: In a matrix over every export route against every caller class, 100% of cross-shop attempts answer the identical "not found", change nothing, and no file ever contains a line of another shop.
- **SC-005**: Killing the worker at 30 random points of a 100,000-line export and letting recovery run ends, in 100% of runs, with one file identical to an uninterrupted export and no partial file visible at any moment.
- **SC-006**: Delivering any queue message, shop event or recovery run a second time changes nothing in 100% of the cases tested; two simultaneous starts, cancels or claims always yield exactly one winner.
- **SC-007**: A seller sees the progress move at least once per second on an export that runs longer than a second, and can start a 10,000-line export, watch it finish and download the file in under 2 minutes of interaction.
- **SC-008**: The ownership check reports 0 cross-domain queries, models, associations or foreign keys for this capability's files; `catalog-sync` has 0 references to order export; the queue `catalog-imports` carries 0 export messages.
- **SC-009**: 0 log lines and 0 metric labels over a full run contain a line value (title, SKU, product ID, amount), a buyer detail, a presigned link or a storage location.

## Assumptions

Each default is also a line in `questions.md`.

- **Who may export**: members with `orders.manage` (owner, admin, staff); viewers may read orders (S10) but not bulk-export them. An export is a shop resource: every such member sees all of the shop's exports.
- **One kind, no filters**: this release exports the shop's whole order-line history as one CSV; date range, status filters, column choice, compression, XLSX and JSON lines are later additions (additive, V.7).
- **Rows**: one record per order line (not per order); shop orders created at or before the request time. A line whose shop is unknown (legacy null) is not exported. A shop order that is `CANCELLED` or `REFUNDED` is exported with its status (the seller wants the whole history).
- **Not a point-in-time snapshot**: the file excludes orders created after the request, but each line shows its shop-order status as of the moment its batch was read, because holding a database snapshot for minutes is rejected (pins resources, blocks cleanup). An order still committing at the request instant may or may not be included.
- **SKU**: read from the catalog at export time (the order snapshot (S10) holds title and prices, not SKU); a product that no longer exists leaves the cell empty.
- **Encoding**: UTF-8 with a byte-order mark and CRLF, so spreadsheets open it correctly; the import capability (S07) accepts such files.
- **Defaults that are configuration, not contract**: batch 1,000 lines; row limit 20,000,000; run deadline 2 h; lease 5 min renewed every 60 s; storage inactivity limit 60 s; message deliveries 3 with a 60 s ± 20 % backoff; unclaimed-job recovery 2 min; one active export per shop; 5 starts per shop per hour; link lifetime 10 min; file retention 7 days after finishing; record retention 90 days; progress at most once per second; read-ahead bound 3,000 lines; idempotency keys 24 h.
- **Retries at one layer**: only the queue redelivery retries (IV.6); the catalog lookup and the storage write are each tried once per delivery with an explicit timeout.
- **Live channel**: the realtime hub may drop messages; the job read is the source of truth (IV.3). Progress is persisted at the same cadence as it is published.
- **Notifications**: no e-mail or in-app notice is sent by this capability; the finished event lets S28 add one later, no consumer is required in this release.
- **Offboarding**: this capability does not build an offboarding bundle; a seller who wants their order history before leaving exports it while the shop is `ACTIVE`. On offboarding start, active exports are cancelled; on deletion, files and records are purged.
- **Download access**: the link is a bearer link for ten minutes (anyone holding it can fetch the file); access is controlled by who can obtain it (`orders.manage`) and each issue is audited.
- **Large-run ceiling**: 20 million lines is roughly a 2.5 GB file; a larger shop is refused with `row_limit_exceeded` until filters exist.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `S12` and `orders`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S07** (spec AS-70, FR-045, questions): the export routes, `OrderExportService` import and the `kind: 'export'` branch leave `catalog-sync`; S12 owns its routes, `ExportJob` and its own queue `order-exports`; the old `job:` realtime prefix goes. Honoured: FR-034, FR-036, AS-56. **Differs on one point**: S07's AS-70 says the old paths answer `404 (served by S12)`; S12 serves the export under new paths (`/shops/:shopId/order-exports`), so the old paths answer `404` everywhere (`[CONTRACT]` in `questions.md`).
- **S10** (spec, gaps A26/D-8/D-10): `OrderExportService` leaves the barrel with S12; S10 does not touch export code except the `Product` join, which S12 removes; order items keep a title and price snapshot (FR-020 of S10). Honoured: FR-010, FR-035, AS-57. **Asks of S10**: the item snapshot columns named below exist and are filled for every item (backfilled for old rows); `unitPriceMinor`, `discountMinor`, `lineTotalMinor` are exported from them.
- **S05** (gaps): orders replaces the `LEFT JOIN "Product"` of the export with R1 `getProductsByIds` per page, batched. Honoured: FR-010, AS-07. **Ask of S05**: the DTO carries `externalSku` (`[CONTRACT]`).
- **S03**: `ShopScoped` gate and `orders.manage`; every shop-owning domain purges on `tenancy.shop_deleted` and exports on `tenancy.shop_offboarding_started`. Honoured: FR-028, FR-029, FR-032; the offboarding *export* is declined (`[CONTRACT]` in `questions.md`).
- **S08, S09, S11**: nothing required of this capability (their gaps list D-10 as "not ours").

**Provides** (exact names; exported from `@app/domains/orders` unless it is an HTTP endpoint, a message or an event):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`orderExportCreateRequestSchema` = strict `{}`, `orderExportSchema`, `orderExportPageSchema` = `{items, nextCursor}`, `orderExportDownloadSchema`, `orderExportProgressEventSchema`, `orderExportEventSchemas`):
  - `POST /shops/:shopId/order-exports` (`orders.manage`, `Idempotency-Key` required) body `{}` → `202 orderExportSchema` + `Location`; replay → `202` + `Idempotency-Replayed: true`.
  - `GET /shops/:shopId/order-exports?status&limit&cursor` (`orders.manage`) → `orderExportPageSchema`; `GET /shops/:shopId/order-exports/:exportId` → `orderExportSchema`.
  - `POST /shops/:shopId/order-exports/:exportId/cancel` → `200 orderExportSchema`.
  - `GET /shops/:shopId/order-exports/:exportId/download` → `200 orderExportDownloadSchema` `{url, expiresAt}`.
  - `orderExportSchema` = `{exportId, status: 'QUEUED'|'RUNNING'|'DONE'|'FAILED'|'CANCELLED'|'EXPIRED', rowsWritten, totalRows: number | null, bytesWritten, attempt, failure: {code, message} | null, createdBy, createdAt, startedAt: string | null, finishedAt: string | null, expiresAt: string | null}`.
  - Problem `code`s: `validation_failed`, `invalid_cursor`, `idempotency_key_required`, `idempotency_key_invalid`, `idempotency_key_reuse`, `idempotency_in_flight`, `export_already_active` (extension `activeExportId`), `export_not_found`, `export_not_ready`, `export_expired`, `export_not_cancellable`, `rate_limited`, `permission_denied`, `shop_not_found`, `shop_suspended`, `shop_offboarding`.
  - Job `failure.code` values: `storage_unavailable`, `catalog_unavailable`, `database_unavailable`, `row_limit_exceeded`, `timeout`, `shop_not_found`, `attempts_exhausted`, `internal_error`.
  - Removed: `POST /shops/:shopId/exports/orders`, `GET /shops/:shopId/exports/:jobId` (no alias).
- File: UTF-8 CSV with the 12 columns of AS-03 (`order_id, shop_order_id, created_at, shop_order_status, currency, product_id, sku, title, quantity, unit_price_minor, discount_minor, line_total_minor`), delivered only through the download link.
- Live channel (through S51): topic `order-export:{exportId}` with events `progress {rowsWritten, totalRows, bytesWritten}` (not replayable), `done {rowsWritten, bytesWritten}`, `failed {code}`, `cancelled {}` (replayable); viewer policy: current member of the job's shop with `orders.manage`. Consumer: **W04** (progress bar and download button). `OrderExportTopicsModule` (loaded by `apps/sse-gateway`) registers it; the old `ExportJobTopicsModule` and the `job:` prefix are removed.
- Event (outbox → topic `order-exports.events`, key `exportId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`): `order_export.finished` v1 `{exportId, shopId, createdBy, status: 'DONE'|'FAILED'|'CANCELLED', failureCode: string | null, rowsWritten, bytesWritten, attempt, startedAt: string | null, finishedAt}`, written once per job in the transaction of the final status change. **Consumers (optional, none required): S28 (tell the creator the file is ready), S40 (seller activity).**
- Queue: `order-exports`, message `{exportId: uuid}`; at most 3 deliveries, then dead-letter queue.
- Rate-limit policy (declared in S50's registry): `orders.export-start.shop` 5/hour per shop (fail closed).
- Scheduled jobs (registered with S49, single-run): `orders.recover-stalled-exports` (every minute), `orders.expire-exports` (every 15 minutes), `orders.purge-exports` (daily).
- Modules for the apps: `OrderExportModule` (core: the routes), `OrderExportWorkerModule` (worker: queue consumer, the three scheduled jobs, the two tenancy event consumers), `OrderExportTopicsModule` (sse-gateway: topic policy). Nothing else of the export code is exported (no model, repository, job or storage class). `OrderExportService` and `ExportJobTopicsModule` leave the barrel.
- Tables (ownership registry, `domain:orders`): `ExportJob`, `ExportJobHistory`.
- Configuration (validated at startup, S54): the defaults of the Assumptions section and the user-content origin (mandatory in production).

**Requires**:

- **S10** (`orders`, same domain; shapes this capability reads inside its own repositories): `ShopOrder {id, bisOrderId, shopId, status: ShopOrderStatus, createdAt}`, `BisOrder {id, currency}`, `BisOrderItem {id, bisOrderId, productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}` with the snapshot columns filled for every item (FR-020 of S10); an index on shop orders by (shop, creation time, ID) for the keyset read; S10 never deletes order rows except through the shop purge it defines.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[] (≤ 500), options?: { shopId?: ShopId }): Promise<ProductDto[]>` where `ProductDto` additionally carries `externalSku: string | null`; unknown IDs are absent from the result; throws on timeout or failure. (`[CONTRACT]`: `externalSku` is not in S05's DTO today.)
- **S03** (`tenancy`): `ShopScoped('orders.manage')` with its status gate and its identical not-found for non-members; `ShopAccessService.assertMember(shopId, userId, permission?)` (R1) for the live-channel policy; events `tenancy.shop_offboarding_started` v1 `{shopId, purgeAt}`, `tenancy.shop_deleted` v1 `{shopId}`, `tenancy.shop_offboarding_cancelled` v1 `{shopId}` (ignored).
- **S01** (`identity`): `Firewall({…})`, `@User()` returning `AuthenticatedUser = {id, role, sessionId, amr}`.
- **S54** (`infrastructure`): problem+json filter with `code`, request context with `requestId`, the idempotency-key interceptor (stored replay / in-flight / different request, 24 h TTL, scoped per user), config validation, metrics registry, an injected clock, graceful-shutdown hooks that signal long-running consumers.
- **S53**: `outbox.append(event)` inside this domain's transaction; the consumer framework (envelope check, schema validation, handled-event record, dead-letter queue) for the two tenancy events.
- **S49**: single-run scheduled jobs with leases. **S50**: the rate-limit policy above with fail-closed mode.
- **S51**: `TopicRegistry.define({prefix: 'order-export', policy})` with an asynchronous policy receiving the viewer's `userId`; `publish(topic, type, payload, { replay })` with per-event replay.
- **Infrastructure ports (no S-capability owns them; this capability's implementation extends them, see `questions.md`)**: object storage: streaming put that aborts its multipart upload on failure or inactivity timeout and exposes backpressure, delete, head, presigned GET with attachment disposition and file name on the user-content origin; task queue: enqueue with delay, long-running consume with visibility heartbeat and a delivery count, dead-letter after 3.
- **W04** (consumer, not a provider): builds the export button, progress bar and download on the routes and the live channel above.
