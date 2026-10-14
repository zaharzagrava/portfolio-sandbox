# Quickstart: validating S21 — Limited-Drop Auctions

Run from `packages/backend` unless noted. Spec runner: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (prints the summary, failing titles, assertion diffs and the full-log path; open the full log only when that is not enough). Run the narrowest file that proves a change; the whole capability once at the end, in batches of fresh processes (L-008: a batch without its summary line is a crash, not a flaky test).

## Prerequisites

- Test stack up: Postgres with real migrations (including the S21 expand and contract migrations and the `orders` `source` CHECK widening), real monthly `Bid` partitions, Redis of the production major version (cache, limiter, realtime only), outbox and job tables, Kafka/ElasticMQ as the other domains' specs use. Compare tables, keyspaces and queues with the doctor (L-011, L-002).
- New config keys have defaults (see research R-14); the test kit sets `auctions_alias_secret`.
- The e2e kit freezes and advances the injected clock; faults use real mechanisms (store rule refusing commands, full flush, refusing outbox appender, tenancy adapter that times out, crash switch, decision gate).

## Scenario runs (each file is one `describe`, see [`test-plan.md`](test-plan.md))

| Step | Command | Expected |
|---|---|---|
| 1 pure rules | `pnpm run test libs/domains/auctions/domain` | `proxy-bid.spec.ts` (AS-53), `auction-state.spec.ts` (AS-54) green |
| 2 S10 command (before editing S10) | `test-spec.sh libs/domains/orders/` in batches | every existing S10/S11 spec green; then again after the amendment |
| 3 order command | `test-spec.sh libs/domains/orders/order-command.e2e-spec.ts` | replay, rejection, no stock operation on cancel/expiry |
| 4 scheduling | `test-spec.sh libs/domains/auctions/auction-schedule.e2e-spec.ts` | AS-01–AS-09 |
| 5 bidding | `test-spec.sh libs/domains/auctions/auction-bidding.e2e-spec.ts` | AS-10–AS-23 (AS-19 runs 50 repeats) |
| 6 shill guard | `test-spec.sh libs/domains/auctions/auction-shill-guard.e2e-spec.ts` | AS-40–AS-42 |
| 7 anti-sniping | `test-spec.sh libs/domains/auctions/auction-anti-sniping.e2e-spec.ts` | AS-24–AS-26 |
| 8 close and settlement | `test-spec.sh libs/domains/auctions/auction-close.e2e-spec.ts` | AS-27–AS-39 |
| 9 public reads | `test-spec.sh libs/domains/auctions/auction-public.e2e-spec.ts` | AS-43–AS-48 |
| 10 operations | `test-spec.sh libs/domains/auctions/auction-operations.e2e-spec.ts` | AS-49–AS-52 |
| 11 contracts | `pnpm run test libs/domains/auctions/auction-contracts.spec.ts libs/composition/bff` (the contracts package has no test runner of its own; the schemas are tested from the backend) and `test-spec.sh libs/composition/bff/bff.e2e-spec.ts` | real auction view parses; `UPSTREAM_INVALID` absent |
| 12 notifications | `test-spec.sh libs/domains/notifications/notifications.e2e-spec.ts` | green with `priceMinor` payloads (A30) |
| 13 static gates | `pnpm tsc --noEmit -p .`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` | clean; auctions files 0 findings (was 5, SC-010); `.tx.baseline` stays 0, `.ownership.baseline` drops from 5 to 0 |
| 14 living spec | `python3 scripts/livespec/check.py` (repo root) | passes with the new `S21` page and the edited `S10` page |

## Start the real apps (L-004, L-015, L-018)

A green jest run does not prove the apps boot. After step 10, start `apps/core` and `apps/worker` **each on its own** (not only inside the monolith) and confirm in their logs: core maps `POST /api/shops/:shopId/auctions`, `GET /api/auctions`, `POST /api/auctions/:auctionId/bids`; worker registers the seven `auctions.*` job handlers, the `auctions.sweep-due` and `auctions.ensure-bid-partitions` schedules, and the `auctions-order-results` consumer on `orders.events`; the worker queue and topic names exist in the stack (L-002). Then `curl -s localhost:<core>/api/auctions/00000000-0000-0000-0000-000000000000` answers `404` with problem+json.

## Manual drill on a fresh stack (L-012): `scripts/qa/fresh-run.sh`

1. Seller creates an auction (start in 2 min, end in 12 min) → `201`; the product's stock drops by 1.
2. Two bidders bid; the public view shows the alias and price, never an ID; `my-bid` shows the own maximum.
3. Advance to the end (or wait): the auction closes, the winner has a `RESERVED` order at the final price; pay it → `SOLD`.
4. Repeat with the winner cancelling the order → the runner-up gets the offer; let it lapse → the unit is back in stock once.

## Ops artifacts (success criteria no automated test proves; each is a row in `specs/UNVERIFIED.md`, status `not run`)

- **SC-002** latency under load: 100 bids/s on one auction (95% < 300 ms, 99% < 800 ms) and 1,000 viewers (99% < 150 ms) — `scripts/load-tests/auction.test.js` (k6, new; written in WP-10, **not run**).
- **SC-004** close timeliness over time: 99% of auctions close within 5 s of their end and 100% within 60 s with a lost trigger — the tests prove the mechanism (AS-26, AS-27, AS-31); the percentages need a soak with many auctions; read `auction_close_lag_seconds` after the load test. Not run.
- **SC-001 at 200 bidders**, **SC-009 at 1,000 randomized retries**, **SC-011 at 1,000 viewers**: the tests run 50 bidders (AS-19), a fixed number of retries (AS-04, AS-18) and a single-flight check (AS-43/AS-44); the larger counts are in the same k6 script. Not run.
- **Application start and fresh-stack drill (L-015, L-012)**: the two sections above; they need an approved real start of `apps/core` and `apps/worker` and an approved `scripts/qa/fresh-run.sh` on the shared stack. Not run unless the run log says otherwise.
- **Old Redis keys**: after deploy, `redis-cli --scan --pattern 'auction:*'` then `UNLINK` (the retired design left them without TTL). Operator step, not run.
- **Replay of a dead-lettered `orders.events` message** (R-05, the pre-ID window after the retry budget): replay by the S53 DLQ tool; not run.
