# Test Plan: S07 — Bulk Catalog Import (domain `catalog-sync`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (71 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/catalog-sync/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `CatalogImportModule` and `CatalogImportWorkerModule` (plus `CatalogImportProjectorModule` and `ImportJobTopicsModule` where a file needs them, and the tenancy, identity and **catalog** modules they depend on, the outbox, the rate limiter, the realtime hub, the scheduler and the idempotency interceptor) with the production pipe, filter, prefix and interceptors, against real Postgres (migrated), Redis, object storage (MinIO, multipart is native) and the queue stand-in from `docker-compose.test.yaml`. Requests go through `supertest`; the worker entry is driven by delivering real messages to the real consumer. Time is frozen with the shared clock helper, state is reset in `beforeEach`, seeding uses the shared fixture helpers. Every test asserts the response body **and** the persisted state (job row, history, objects in storage, queue messages, outbox rows, products read through the catalog's exported query service from `@app/domains/catalog`).
- Only system-edge dependencies are faked: the malware scanner is a **fake scanner server speaking the real streaming protocol** over TCP (`test/fakes/fake-clamd.ts`: clean, infected, refuse, stall, size-limit reply, garbage). Faults use real mechanisms: a Postgres trigger raising on an insert into the outbox or an update of the job table, a gated storage stream (the test releases bytes to freeze a worker at a chosen batch), a killed lease (the test moves the clock past it), a TCP fault proxy before the scanner. Two application instances (`appA`, `appB`) are booted in one process for the single-run, race and scheduler cases. Storage reads are observed through a recording wrapper on the storage port (range requested, stream `destroyed`); this is observation, never a stub of the project's own stores.
- Consumers (`tenancy.shop_offboarding_started`, `tenancy.shop_deleted`, the import queue message) each have the duplicate-delivery and invalid-payload tests of VII.4 (AS-36, AS-38, AS-41, AS-65, AS-66).
- Unit specs sit beside the code under `domain/` (and `infra/` for the adapter and the stream stage), are table-driven (`it.each`), and exist only for pure logic (VII.5): row coercion (with `fast-check`), content sniffing, batching and the duplicate-SKU rule, state machine, report writing and escaping, file-name sanitising, the scanner protocol, and the parse pipeline's backpressure. No unit tests for controllers, repositories, consumers or glue.
- UI journey (Playwright, owned by W04, happy path only): `packages/web/tests/seller-import.spec.ts` — a seller chooses a CSV, the upload runs in parts, the progress bar moves, the job reaches done, and the report link downloads the file. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-69).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`importStartResponseSchema`, `importUploadStateSchema`, `importJobSchema`, `importPageSchema`, `importErrorReportSchema`, `importProgressEventSchema`) and outbox payloads with `importEventSchemas`.
- Gate 9 (VII.9): AS-23, AS-24, AS-44 and AS-62 are degradation paths and each forces its fault.

Abbreviations for the e2e files (all under `libs/domains/catalog-sync/`):

| Key | File | Top-level `describe` |
|---|---|---|
| U | `import-upload.e2e-spec.ts` | `Bulk import upload API` |
| P | `import-processing.e2e-spec.ts` | `Bulk import processing` |
| X | `import-security.e2e-spec.ts` | `Bulk import file security` |
| R | `import-resilience.e2e-spec.ts` | `Bulk import resilience` |
| E | `import-report.e2e-spec.ts` | `Bulk import error report` |
| S | `import-status.e2e-spec.ts` | `Bulk import status, progress and cancel` |
| F | `import-fairness.e2e-spec.ts` | `Bulk import fairness and limits` |
| L | `import-lifecycle.e2e-spec.ts` | `Bulk import lifecycle and events` |
| B | `import-boundary.e2e-spec.ts` | `Catalog-sync import module boundary` |

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 start | U: member starts, `201` parsed, job row, history, server-made key, open upload, URL expiry | — | — |
| AS-02 start validation classes | U: table-driven over every class and both inclusive boundaries, nothing persisted | — | — |
| AS-03 idempotent start replay | U: same key and body replays the stored body, one job, one upload | — | — |
| AS-04 start in flight | U: `Promise.all` of two identical starts, one `201`, one `409` | — | — |
| AS-05 key misuse | U: different body `422`, missing key `422` | — | — |
| AS-06 resume upload | U: 3 parts, 2 uploaded, `GET …/upload` lists uploaded and missing; other state `409` | — | — |
| AS-07 complete = 202 | U: `202` + `Location`, object size, job `UPLOADED`, one message, no wait for processing | — | — |
| AS-08 invalid parts | U: table-driven over every bad part list, job stays `PENDING_UPLOAD`, no message | — | — |
| AS-09 size mismatch | U: parts short by 1 byte → `422`, job `FAILED`, object deleted, finished event | — | — |
| AS-10 complete replay | U: second `complete` → `200`, no storage call, one message | — | — |
| AS-11 complete race | U: `Promise.all` of two `complete`, one `202` and one `200`, one message, one history row | — | — |
| AS-12 complete in a dead state | U: `CANCELLED` and `EXPIRED` → `409` | — | — |
| AS-13 import happy path | P: 1,200 rows → `DONE`, 3 catalog calls of 500/500/200, counters, products via the catalog's query service, file deleted, event, live `done` | `seller-import.spec.ts` upload → progress → done → report link | — |
| AS-14 dialects | P: BOM/CRLF/quoted newline/header case/extra column/blank line; JSONL parity | — | — |
| AS-15 coercion | — | — | `domain/import-row.spec.ts` table over prices, stock, tags; `fast-check` exactness |
| AS-16 header check | P: missing or repeated required column → `FAILED invalid_header`, zero catalog calls | — | — |
| AS-17 re-import idempotent | P: same file twice → `rowsUnchanged: 1200`, versions unchanged, no new product events | — | — |
| AS-18 changed rows | P: 3 changed + 2 new → counters and versions | — | — |
| AS-19 same SKU twice | P: later row wins, no error line, two catalog calls never share a SKU | — | `domain/import-batcher.spec.ts` flush-before-repeat table |
| AS-20 empty stock cell | P: empty cell keeps stock 5, `0` sets 0, absent column keeps stock | — | — |
| AS-21 clean scan | X: fake scanner clean, `SCANNING → PROCESSING`, verdict stored, buffered bytes bound | — | — |
| AS-22 malware | X: EICAR via fake scanner → `FAILED malware_detected`, file deleted, no catalog call, event, `failed` live event, signature only in logs | — | — |
| AS-23 scanner down | X: refuse connections; deliveries 1–2 stay `SCANNING`, third → `FAILED scan_unavailable`, DLQ (forces the fallback, gate 9) | — | — |
| AS-24 scanner stalls | X: stall past 60 s (clock moved) → abandoned and socket closed; a slow-but-progressing scan completes | — | — |
| AS-25 scanner protocol | — | — | `infra/clamav.spec.ts` against a fake server: OK, FOUND, size-limit, empty, partial, garbage; chunk size; backpressure; socket always destroyed |
| AS-26 content sniffing | X: a zip renamed `.csv` → `FAILED unsupported_file_type`, file deleted | — | `domain/import-sniff.spec.ts` table over signatures, BOMs, NUL, invalid UTF-8 |
| AS-27 names not trusted | X: JSONL named `.csv` and CSV named `.jsonl` both `DONE`; traversal name leaves keys unchanged | — | — |
| AS-28 oversize record | X: 2 MiB JSONL line → row error and continue; unterminated CSV quote → `FAILED malformed_file`, flat memory | — | — |
| AS-29 report delivery | E: URL on the user-content origin, 10-minute expiry, attachment disposition and `text/csv`; no route links the source file; `nosniff` is proven by the user-content edge artifact (ops), not here | — | — |
| AS-30 formula injection | — | — | `domain/error-report.spec.ts` guard table and CSV round-trip property |
| AS-31 display names | — | — | `domain/file-name.spec.ts` table (CRLF, traversal, 300 chars, dots only) |
| AS-32 scanner mandatory | X: boot with production settings and no scanner fails; non-production explicit disable records `skipped` | — | — |
| AS-33 checkpoint per batch | R: stop after batch 3 (gated stream); row holds counters, `lastRow`, `nextByteOffset`, header and format together; progress event after the commit | — | — |
| AS-34 resume | R: redelivery reads from `nextByteOffset` (range observed), no rescan, no row ≤ `lastRow` sent, final equals a clean run | — | — |
| AS-35 crash window | R: fault between catalog write and checkpoint; redelivery sends batch 4 again, counters within the one-batch bound, products equal | — | — |
| AS-36 one runner per job | R: `Promise.all` of two deliveries; one runs, the other has no effect (VII.4 duplicate message) | — | — |
| AS-37 stalled worker fenced | R: lease expired by the clock, B resumes, A's late commit refused, counters never decrease | — | — |
| AS-38 finished-job redelivery | R: table over `DONE`, `FAILED`, `CANCELLED`, `EXPIRED`; no read, no call, no event | — | — |
| AS-39 graceful shutdown | R: shutdown signal mid-batch; checkpoint consistent, streams and sockets destroyed, lease released, job `PROCESSING`, within 10 s | — | — |
| AS-40 recovery | R: lost-message and expired-lease jobs re-enqueued once; fresh and live-lease jobs untouched; two instances at once | — | — |
| AS-41 bad message | R: table over non-JSON, missing, non-UUID, unknown job, extra fields; no side effect, log with `messageId` (VII.4 invalid payload) | — | — |
| AS-42 malformed file mid-stream | R: break after 700 rows → `FAILED malformed_file`, streams `destroyed`, first 500 kept | — | — |
| AS-43 backpressure | — | — | `infra/import-pipeline.spec.ts`: blocked sink never lets more than 500 + 16 records be pulled; resume delivers exactly once in order; abort destroys every stage |
| AS-44 transient failure | R: trigger-made statement timeout on checkpoint: second delivery completes; persistent fault → `FAILED internal_error`, DLQ, no SQL in the body (forces fallback, gate 9) | — | — |
| AS-45 shop stops being active | R: `SUSPENDED` before and during → `FAILED shop_not_active`, no retry, failing batch not written | — | — |
| AS-46 error cap | R: cap 5 (configured in the spec) → `FAILED too_many_errors`, report lines exact, later rows not read | — | — |
| AS-47 report content | E: 10,000 rows with 3 bad (one row with two problems), header, order, `row` ordinals, 20 progress events | — | — |
| AS-48 refusals from the catalog | E: price `0`, 201-character title, long SKU appear with the catalog's code and mapped field; neighbours imported | — | `domain/error-report.spec.ts` field mapping and message table |
| AS-49 report after a crash | E: bad rows before and after the crash, each line once, `rowsFailed: 3` | — | — |
| AS-50 report availability | E: `409` while processing, `404` with no failures, lines so far when `FAILED`/`CANCELLED`, `404` after retention | — | — |
| AS-51 status shape | S: `importJobSchema`, no storage key, upload handle, URL, lease or signature | — | — |
| AS-52 cross-shop matrix | S: every route × (member of another shop, non-member), identical `404` bodies, nothing changes, list isolated | — | — |
| AS-53 auth and roles | S: `401` per route, read-only role `403` on writes, malformed IDs `400` with zero statements | — | — |
| AS-54 list | S: 45 jobs with equal instants, pages 20/20/5, no repeat or gap, filters, bad limit/status/cursor `422` | — | — |
| AS-55 live progress | S: subscribed member receives progress, terminal events replayable, non-member and removed creator refused, status route agrees | — | — |
| AS-56 cancel | S: from each non-final state, running job stops at the next safe point, writes kept, upload aborted, final-state `409`, repeat `200` | — | — |
| AS-57 cancel vs complete | S: `Promise.all`, exactly one transition and one loser `409` | — | — |
| AS-58 state machine | — | — | `domain/import-status.spec.ts` all 56 ordered pairs (13 allowed), exhaustive switch, stale-`from` rule |
| AS-59 expiry | S: 25-hour job expires with upload aborted and event, 23-hour untouched, idempotent, two instances | — | — |
| AS-60 one run per shop | F: gated `J1` of shop A; `J3` of shop B completes; `J2` handed back with 60 s ± 20% delay, status unchanged, no delivery budget spent | — | — |
| AS-61 active cap | F: five concurrent starts → exactly 3 `201`, 2 `409`; terminal jobs do not count | — | — |
| AS-62 start rate limit | F: 11th start `429` with `Retry-After`; limiter store down → `503` and reads fine (forces fallback, gate 9) | — | — |
| AS-63 shop status gate | F: `SUSPENDED` → `403`, `DELETING` → `409`, reads `200` | — | — |
| AS-64 finished event | L: one outbox row per final job in the same transaction, schema-valid, none on redelivery; outbox fault rolls the status back | — | — |
| AS-65 offboarding | L: non-final jobs cancelled, final untouched, other shops untouched; duplicate and invalid payloads; `shop_offboarding_cancelled` ignored | — | — |
| AS-66 deletion purge | L: rows, history and objects gone, others untouched; repeat and reorder safe; storage failure mid-purge retried | — | — |
| AS-67 retention | L: 31/91/10-day and old non-final jobs; report-only vs full purge, cap of 500, idempotent, two instances | — | — |
| AS-68 observability | L: log lines carry IDs and no row data or URLs; metrics present for rows by outcome, jobs by status, durations | — | — |
| AS-69 boundary static | B: `check:table-ownership --strict` and `check:boundaries` zero for the import files; no foreign keys; index exports no model | — | — |
| AS-70 export routes gone | L: app with only this domain's modules answers `404` on both export routes; queue messages carry only `importId` | — | — |
| AS-71 file missing | R: job whose object was removed → `FAILED source_missing`, no retry, event | — | — |

## Coverage notes

- **Pattern rows.** P0207 (streams, backpressure, `pipeline`, object-mode transform): FR-015, FR-016, FR-020; AS-13, AS-19, AS-28, AS-39, AS-42, AS-43. P0407 (async request-reply): FR-006, FR-033, FR-035; AS-07, AS-10, AS-51, AS-55. P0509 (upload security): FR-008–FR-014; AS-21–AS-32.
- **Constitution VII.3 per endpoint.** Happy path (AS-01, AS-07, AS-51, AS-54, AS-56, AS-29), every validation class (AS-02, AS-08, AS-54), `401` and `403` (AS-53), cross-tenant `404` (AS-52), idempotency replay, in-flight and different body (AS-03–AS-05), rate limit (AS-62), illegal transition `409` (AS-12, AS-56, AS-57), invariant under concurrency (AS-04, AS-11, AS-36, AS-57, AS-61).
- **VII.4 consumers.** The import queue consumer (AS-36 and AS-38 duplicate delivery, AS-41 invalid payload), the shop-event consumers (AS-65 and AS-66 duplicate and invalid payload).
- **Not provable in e2e, tracked as artifacts.** (a) SC-001 and SC-002: `scripts/bench/catalog-import-bench.ts` generates a 1,000,000-row file, runs the real pipeline and records memory and throughput; its output is attached to the PR. (b) The `nosniff` header of the user-content origin (AS-29): a test of the edge configuration in the operations artifacts. (c) The storage lifecycle rules (abort incomplete uploads, 7-day source backstop): checked by the same artifact test.
- **Old e2e.** `catalog-import.e2e-spec.ts` is replaced by the files above; its order-export test moves to S12. Its three useful ideas (10k rows with 3 bad, resume at a checkpoint, binary refused) survive as AS-47, AS-34, AS-26.
- **Traceability check.** 71 scenarios, 71 rows (AS-01 to AS-71; AS-71 sits in Story 3); each edge case from `spec.md` appears in exactly one row; rows with both an e2e and a unit entry prove the integration and the pure rule respectively and are not duplicates.
