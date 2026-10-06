# Test Plan: S15 — Seller Payouts: Weekly Run, Reserves, Provider Transfer with Idempotency, Payout States (domain `payments`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (55 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/payments/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `PayoutsModule` and `PayoutsWorkerModule` with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres (real migrations, partitioned ledger), Redis and the job and outbox tables from `docker-compose.test.yaml`:
  - `payout-run.e2e-spec.ts` — describe "Payouts: weekly run, reserves and eligibility"
  - `payout-transfer.e2e-spec.ts` — describe "Payouts: provider transfer, idempotency, unknown outcomes and states"
  - `payout-api.e2e-spec.ts` — describe "Payouts: seller and operator API"
  - `payout-ops.e2e-spec.ts` — describe "Payouts: audit, events, boundaries, migration and configuration"
- Fixtures: balances are created by posting journals through S14's `LedgerService.postJournal` in a test transaction (never by inserting entries or touching payments models); shops are plain UUIDs registered with the S03 test double behind `ShopQueryService` (status, `payoutsEnabled`); members and admins come from the S01 and S03 fixtures; payouts for API tests are created by the real run.
- Only system edges are faked: identity token verification, tenancy's R1 answers (a scriptable double with a call log, for AS-12), the payment provider (one scriptable double behind the transfer port: success, definite rejection with a code, `429`/`5xx`/reset, timeout, garbage answers, lookup by reference found/not found/reversed, crash after success, blocking mid-call, with a call log and the idempotency-key replay behaviour of the real provider), the rate limiter's store (forced down in AS-36 and AS-48), and the clock (frozen, advanced by the test).
- Jobs are invoked through the S49 handler registration (the same path the worker uses), delivering the same message twice and concurrently where the scenario says so (VII.4 spirit: duplicate delivery gives one effect). There is no async consumer in this capability, so no invalid-payload test beyond the job payload validation in AS-13 and the provider answer validation in AS-25.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); money invariants also get `fast-check` properties: `reserve.spec.ts` (AS-04), `period.spec.ts` (AS-13), `payout-state.spec.ts` (AS-27), `eligibility.spec.ts` (AS-09, AS-35 blocking reason), `destination.spec.ts` (AS-38 format, AS-39 cooling), `backoff.spec.ts` (AS-20, AS-24 schedules), `provider-answer.spec.ts` (AS-25 validation).
- UI journeys (Playwright, happy path only) are owned by W04 (`packages/web/tests/seller-payouts.spec.ts`) and J01 (`packages/web/tests/buy-to-payout.spec.ts`); this capability contributes AS-37 and one step of J01. No edge case below is re-tested in the UI.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` for the payout files (AS-52); `check:model-registry`.
- Gate 9 (VII.9): AS-19 (crash), AS-22 (provider unreachable), AS-36 and AS-48 (limiter down), AS-55 (shutdown) each force their fault.
- Concurrency rows (`Promise.all`) are repeated as stated in the spec and assert both the invariant (ledger sums to `0`, `PAYOUT_CLEARING` equals the sum of non-final payouts) and the exact counts (VII.3).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy path run | `payout-run.e2e-spec.ts`: two payouts `PENDING` with amount, reserve, snapshot; one `PAYOUT` journal each; one job, one `payout.created`, one history row each; balances `5000`/`2000`, clearing `63000`; run `COMPLETED created 2` | — | — |
| AS-02 re-run | `payout-run.e2e-spec.ts`: second run adds no payout, journal, job or event; `existing 2` | — | — |
| AS-03 concurrent runs | `payout-run.e2e-spec.ts`: two runs × 20 repetitions; one payout/journal/job/event per shop | — | — |
| AS-04 reserve arithmetic | — | — | `reserve.spec.ts`: the table of the spec (incl. `2^53` edge) and `fast-check` (`reserve + payout = balance`, bounds, no overflow) |
| AS-05 per-shop reserve | `payout-run.e2e-spec.ts`: override `0` and `2500` bps and default applied in one run | — | — |
| AS-06 minimum payout | `payout-run.e2e-spec.ts`: `1000` paid, `999` not listed, `945` skipped `below_minimum` with nothing created; next week includes it | — | `eligibility.spec.ts`: inclusive minimum boundary table |
| AS-07 cap | `payout-run.e2e-spec.ts`: `5000000` paid, `1000000` stays, reserve held `0`, next week pays the rest | — | — |
| AS-08 nothing owed | `payout-run.e2e-spec.ts`: `0`, `−500`, `+500` create nothing and are not counted as skips | — | — |
| AS-09 eligibility gates | `payout-run.e2e-spec.ts`: five shops, five reasons, nothing created, per-reason counters, log line | — | `eligibility.spec.ts`: gate order and reason table over (status, payoutsEnabled, known, destination, cooling) |
| AS-10 balance changed during the run | `payout-run.e2e-spec.ts`: charge before creation (`36000` from authoritative balance); charge interleaved after the read: `insufficient_balance`, rollback, others proceed | — | — |
| AS-11 ledger trouble | `payout-run.e2e-spec.ts`: listing failure → run `FAILED ledger_unavailable`, nothing created, retried; `LedgerBusy` for one shop → skipped `ledger_busy`, re-run pays it | — | — |
| AS-12 paging, no N+1 | `payout-run.e2e-spec.ts`: 450 shops, pages of 200, 3 tenancy calls, batched balance reads (call-log counts) | — | — |
| AS-13 the period | `payout-run.e2e-spec.ts`: non-Monday, future, malformed, > 52 weeks → `period_invalid`, nothing created | — | `period.spec.ts`: Monday-of-week table (Sunday 23:59:59Z, Monday 00:00:00Z, month and year ends, leap day) and the bounds |
| AS-14 schedule | `payout-run.e2e-spec.ts`: one schedule row `payouts.run-weekly`, re-registration idempotent; one run due in a DST week | — | — |
| AS-15 crash midway | `payout-run.e2e-spec.ts`: forced stop after payout 2; retry yields `existing 2`, three new; totals equal an uninterrupted run | — | — |
| AS-16 one atomic step | `payout-run.e2e-spec.ts`: forced failure at insert, posting, enqueue, event append → none of the four rows exist, no provider call | — | — |
| AS-17 transfer success | `payout-transfer.e2e-spec.ts`: claim committed before the call; one provider transfer with key = payout ID; `PAID`, `transferRef`, sent journal `Pa:sent`, history, `payout.paid`; clearing restored | — | — |
| AS-18 duplicate and concurrent delivery | `payout-transfer.e2e-spec.ts`: 10 deliveries × 20; one claim, one provider transfer, one `PAID`, one journal, one event | — | — |
| AS-19 crash after the provider accepted | `payout-transfer.e2e-spec.ts`: forced stop; payout `SENDING`; redelivery reuses the key and gets the same `transferRef`; stale `SENDING` settled by the resolver's lookup without a new transfer | — | — |
| AS-20 provider does not answer | `payout-transfer.e2e-spec.ts`: timeout → `UNKNOWN`, no reversal, no new key; resolver finds transfer → `PAID`; finds rejection → `FAILED` | — | `backoff.spec.ts`: 1, 2, 4 … 15 min cap, jitter within bounds |
| AS-21 provider has no such transfer | `payout-transfer.e2e-spec.ts`: same-key re-send up to 3 times; confirmed → `PAID`; rejected → `FAILED`; exhausted → stays `UNKNOWN` | — | — |
| AS-22 provider unreachable while resolving | `payout-transfer.e2e-spec.ts`: lookup timeout/failure/breaker open keeps `UNKNOWN`; after 24 h one `payout.in_doubt`, gauge, no state change | — | — |
| AS-23 definite rejection | `payout-transfer.e2e-spec.ts`: `FAILED`, `failureCode`, sanitized reason, `PAYOUT_REVERSAL` journal, history, `payout.failed`; balances restored; no retry | — | — |
| AS-24 transient failures | `payout-transfer.e2e-spec.ts`: `429`/`502`/`503`/`504`/reset retried with the same key, ≤ 5, then `UNKNOWN`; `400`-class not retried; adapter makes one call per attempt | — | `backoff.spec.ts`: job-retry delay table with full jitter |
| AS-25 provider answer not trusted | `payout-transfer.e2e-spec.ts`: wrong amount, currency, destination, missing reference, malformed → `UNKNOWN`, mismatch metric, discrepancy event, nothing posted | — | `provider-answer.spec.ts`: validation table of the answer shapes |
| AS-26 destination fixed at creation | `payout-transfer.e2e-spec.ts`: destination changed after creation; transfer goes to the snapshot | — | — |
| AS-27 the state machine | — | — | `payout-state.spec.ts`: full (state × event) table, exactly the allowed transitions, terminal states accept nothing, `assertNever` over statuses |
| AS-28 late conflicting outcome | `payout-transfer.e2e-spec.ts`: late rejection after `PAID`, late success after `FAILED`; unchanged, counter, one discrepancy event | — | — |
| AS-29 no network inside a transaction | `payout-transfer.e2e-spec.ts`: provider double blocks mid-call; a second connection reads and updates without waiting; claim and result are separate transactions | — | — |
| AS-30 job and resolver at once | `payout-transfer.e2e-spec.ts`: both finish with success × 50; one `PAID`, one journal, one event | — | — |
| AS-31 the list | `payout-api.e2e-spec.ts`: member sees four payouts in order, public statuses, no internal fields, no other shop; body parsed with `payoutPageSchema` | — | — |
| AS-32 paging | `payout-api.e2e-spec.ts`: 2/2/1 with no repeat across an insert; default 20; limits `0`, `101`, text → `400 validation_failed`; tampered cursor → `400 invalid_cursor` | — | — |
| AS-33 one payout | `payout-api.e2e-spec.ts`: detail with timeline; other shop's payout and unknown ID → identical `404 payout_not_found`; malformed → `400` | — | — |
| AS-34 access (401/404/403) | `payout-api.e2e-spec.ts`: no session `401`; non-member `404 shop_not_found` byte-identical to unknown shop; member without permission `403`; all three routes | — | — |
| AS-35 what comes next | `payout-api.e2e-spec.ts`: upcoming body with `nextRunAt 2026-10-12T04:00:00.000Z`; the four blocked reasons; route not read as an ID | — | `eligibility.spec.ts`: blocking-reason precedence |
| AS-36 seller rate limit | `payout-api.e2e-spec.ts`: 121st call `429` with `Retry-After`; limiter store down → reads succeed | — | — |
| AS-37 the journey | — | `seller-payouts.spec.ts` (W04, J01 step): owner sees a `PAID` and a `PENDING` payout and the upcoming payout with reserve and next run date | — |
| AS-38 set a destination | `payout-api.e2e-spec.ts`: masked body, stored once, history row; `422 destination_invalid`; unknown shop `404`; non-admin `403`; no session `401`; no full value in logs | — | `destination.spec.ts`: format table (`acct_` + 8–64 alphanumerics), masking |
| AS-39 cooling after a change | `payout-api.e2e-spec.ts` + `payout-run.e2e-spec.ts`: change at `T`; run at `T+47h59m` skips `destination_cooling`; at `T+48h` pays to the new one; same value again changes nothing | — | `destination.spec.ts`: effective-from rule table |
| AS-40 set a reserve | `payout-api.e2e-spec.ts`: `200`, history row, next run uses it; invalid bps and reasons `400`; non-admin `403` | — | — |
| AS-41 idempotency of operator writes | `payout-api.e2e-spec.ts`: replay with `Idempotency-Replayed`, in-flight `409`, different body `422`, missing header `422`, after 24 h new, validation failure does not consume the key | — | — |
| AS-42 cancel a pending payout | `payout-api.e2e-spec.ts`: `CANCELLED`, reversal, history with actor and reason, `payout.cancelled`, balance restored; later transfer job never calls the provider | — | — |
| AS-43 illegal cancel | `payout-api.e2e-spec.ts`: `SENDING`, `UNKNOWN`, `PAID`, `FAILED`, `CANCELLED` → `409 payout_state_conflict {status}`, unchanged | — | — |
| AS-44 cancel against send | `payout-api.e2e-spec.ts`: `Promise.all` × 50; exactly one wins; ledger sums to `0`; clearing equals non-final payouts | — | — |
| AS-45 who may cancel, what exists | `payout-api.e2e-spec.ts`: shop owner `403`, no session `401`, unknown `404 payout_not_found`, malformed `400`, missing reason `400` | — | — |
| AS-46 the operator list | `payout-api.e2e-spec.ts`: filters, keyset, internal statuses, masked destination; bad filters `400`, bad cursor `400`, non-admin `403`, no session `401` | — | — |
| AS-47 the runs | `payout-api.e2e-spec.ts`: completed, failed and resumed runs listed newest first; non-admin `403` | — | — |
| AS-48 operator rate limit | `payout-api.e2e-spec.ts`: 31st write `429`; limiter down → `503`, nothing changed | — | — |
| AS-49 payout audit | `payout-ops.e2e-spec.ts`: match yields nothing; five discrepancy kinds each counted and evented once; second run emits nothing; outage → `FAILED`, no partial output | — | — |
| AS-50 the events | `payout-ops.e2e-spec.ts`: every transition's event in the outbox in the same transaction, rolled back with it; envelope and payload parsed with the `packages/contracts` schemas; no destination or secret | — | — |
| AS-51 metrics and logs | `payout-ops.e2e-spec.ts`: each metric of FR-052 moves by the stated amount across the scenarios; logs structured, no destination, key or body | — | — |
| AS-52 boundaries | `payout-ops.e2e-spec.ts`: no foreign key from the payout tables to `Shop`; ownership registry entries; static gate `check:table-ownership --strict` clean for the payout files | — | — |
| AS-53 migration of existing data | `payout-ops.e2e-spec.ts`: seed old-shape rows and `Shop.stripeAccountId`, run the migration twice; rows, destinations, history preserved; second run no-op; old readers still work | — | — |
| AS-54 configuration | `payout-ops.e2e-spec.ts`: each invalid setting fails startup naming the key; no secret in the message | — | — |
| AS-55 shutdown during a run | `payout-ops.e2e-spec.ts`: stop signal mid-run; current shop whole, no new shop, run `FAILED interrupted`; retry resumes | — | — |
