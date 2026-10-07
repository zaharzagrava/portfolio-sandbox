# Test Plan: J03 — Launch Day

Constitution VII.8: one row per acceptance scenario in [`spec.md`](spec.md) (40 rows). A rule already proven inside one capability is referenced in the last column, never re-tested here. Where the last column names a capability and a topic without a scenario number, that capability's `test-plan.md` has no stable scenario id for it yet (or the id is in its spec); the implementation agent fills the number when it lands.

- Journey file: `packages/backend/test/journeys/launch-day.journey-spec.ts`, top-level `describe` "Journey J03: launch day", one nested `describe` per user story. It runs against the **running local stack** (`moon run :infra-up && moon run :infra-setup`, then `moon run :dev-monolith`; `pnpm test:journeys`; `API_URL` default `http://localhost:8000`), black box: public APIs, SSE, the control surface and the read-only event tap only; no database, topic or queue reads.
- Waiting: `waitForContract(hop, probe)` over `test/utils/async-helpers.ts` `waitFor` (poll 250 ms, deadline = 2 × the hop's maximum in `spec.md`, × `JOURNEY_TIME_FACTOR`). No fixed sleeps. Time-driven steps advance the stack clock through the control surface; `controlSurface` restores the clock and resumes every paused group in `afterAll`.
- Fixtures (`test/journeys/support/`): J01/J02's kit plus `launchFixture`, `sseClient`, `eventTap`.
- Provider doubles at the edge: payment by `paymentMethodRef`, toxicity classifier by content, admin bootstrap, log providers for e-mail/SMS/push.
- Order of the file: US1 → US2 → US3 → US4 → US5 → US6. Each user story creates its own shop products, event, drop, stream and auction with unique names; AS-37 and AS-38 build on the earlier scenarios' fixtures or create their own.
- UI: none (no capability covers launch-event, drop, live or auction pages; the pages' capabilities own their Playwright journeys when they exist).
- Static gates (AS-40): `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`.

| Scenario | Journey test (`packages/backend/test/journeys/launch-day.journey-spec.ts`) | Already proven by capability (ID) |
|---|---|---|
| AS-01 queue, admit, hold, confirm | `US1`: create event, 12 buyers join, advance clock, poll admitted, hold with token and key, seat map, confirm, `my-bookings`; admission per clock second ≤ 5 | S22 AS-01, AS-04, AS-05 (queue, rate, token content), AS-15, AS-33 (hold, confirm rows), AS-45 (bitmap) |
| AS-02 one booking, one notice, one voucher | `US1`: poll inbox, unread, SSE `user:<id>`, voucher list; other buyers and owner have none | S28 AS-01 (inbox, unread, realtime), AS-13 (rule `booking.confirmed`); S22 AS-44 (command emitted once); S10 (voucher consumer, new, no id yet) |
| AS-03 retried confirm | `US1`: ×5 same key, ×10 different keys; one booking, one notice, one voucher; key reuse `422` | S22 AS-34, AS-35 (confirm idempotency), S28 AS-02 (duplicate delivery) |
| AS-04 last seat sold out once | `US1`: confirm ×5 on the last seat; event `SOLD_OUT`, holds `409`, one `event_sold_out` on the tap | S22 AS-43 (sold-out exactly once) |
| AS-05 expired hold | `US1`: clock +10 min; seat free, confirm `409 HOLD_EXPIRED`, no booking, no notice, no voucher, tap has no `booking_confirmed`; next buyer holds | S22 AS-28 (expiry frees), AS-27 (stale holder), AS-36 (confirm vs expiry) |
| AS-06 notification consumer down | `US1`: pause `notification-router`, confirm, lag, resume, one item | S53 (pause, lag), S28 AS-02, AS-03 (idempotent consumer, crash and replay) |
| AS-07 voucher consumer down | `US1`: pause `orders-booking-voucher`, confirm, booking and notice present, resume, one voucher, redelivery | S22 FR-035 (booking never waits), S10 (voucher consumer idempotency: new) |
| AS-08 duplicates, out of order, close | `US1`: replay `launch-events.events` for `notification-router`; organizer close; holds freed ≤ 60 s | S28 AS-10 (version guard), AS-02; S22 AS-54 (close), AS-60 (jobs) |
| AS-09 admission token isolation | `US1`: access token, other event's token, other buyer's token on hold → `403`; admission token on `/auth/me` → `401` | S22 AS-18 (token matrix), S01 (purpose-token isolation, FR-027) |
| AS-10 schedule and load | `US2`: create drop, clock to `startsAt − 60 s`, stock 30, search `inStock`, load twice, regular checkout before start | S11 AS-14, AS-20, AS-21, AS-08; S05 (stock command, event); S32 (index) |
| AS-11 the race | `US2`: 60 concurrent checkouts → 20 `202`, 40 `422`; public view sold out; member stock unchanged; refused have no orders | S11 AS-02, AS-06; S10 AS-32 (no oversell) |
| AS-12 paid orders are notified | `US2`: J01 chain for 5 orders; inbox, owner items, stats sold/held | J01 AS-01, H5; S11 AS-33 (convert); S28 AS-01, AS-07 (shop owners) |
| AS-13 retried drop checkout | `US2`: ×5 same key; one order; quota exhausted | S11 AS-05, AS-07; S10 (idempotency) |
| AS-14 lapsed drop hold | `US2`: clock +15 min; units back, one `order.cancelled` item each, new buyer succeeds, expiry twice | S11 AS-30, AS-31 (release once); S10 AS-36 (expiry); S28 AS-13 (reasons) |
| AS-15 end and reconcile | `US2`: clock past end and reconcile time; `RECONCILED`; stock `45`; one `flash_sale.reconciled` on the tap; rerun no change | S11 AS-23, AS-24, AS-25, AS-37 |
| AS-16 sold-out notice to the brand | `US2`: owner has one `shop.flash_sale_sold_out`; staff none; replay adds none | S11 AS-37 (`sold_out` once); S28 (new types: no id yet) |
| AS-17 failed load | `US2`: reduce stock after scheduling; `START_FAILED`; regular checkout; one tap event; owner notice | S11 AS-22; S28 (new type) |
| AS-18 notification consumer down while selling | `US2`: pause, pay 3 orders, resume; replay; counts unchanged | S28 AS-02, AS-03, SC-002; S53 (replay) |
| AS-19 start the stream | `US3`: viewer snapshot `SCHEDULED`, start ×20, `status LIVE`, one `stream_started` on the tap; non-member `404` | S23 AS-12, AS-34, AS-35 |
| AS-20 comment delivered and stored | `US3`: post; batch, snapshot `recent`, history once | S23 AS-01–AS-06, AS-15, AS-25, AS-43 |
| AS-21 retried comment | `US3`: same `clientId` ×5; one `201`; history once; reuse `422` | S23 AS-22, AS-23 |
| AS-22 pin | `US3`: pin own product; foreign/archived/unknown `422`; read-only `403`; unpin | S23 AS-36, AS-37, AS-38, AS-41; S05 (product lookup) |
| AS-23 removal | `US3`: staff removal ×20; viewers; history; one `comment_removed` on the tap | S23 AS-39, AS-48 |
| AS-24 asynchronous moderation | `US3`: `[[toxic]]` comment removed; one auto removal on the tap | S23 AS-47 |
| AS-25 history consumer down; replay | `US3`: pause `live-comments-history`; post and remove; resume; replay; removal-first order | S23 AS-43, AS-44, AS-45 |
| AS-26 end the stream | `US3`: end ×2; connection closes; `409`s; one `stream_ended` on the tap; stats stop; no notice | S23 AS-12, AS-34, AS-31 |
| AS-27 auction scheduled | `US4`: create ×1/×5 with key; stock `2` once; open at start; second create `409`; no entitlement `403` | S21 AS-01, AS-04, AS-05, AS-06, AS-03 |
| AS-28 bids and outbid notice | `US4`: three bids; view; one outbid item for the previous leader; push; retried bid | S21 AS-10, AS-11, AS-18, AS-43, AS-48; S28 AS-13 (outbid rule), AS-10 (order) |
| AS-29 shill guard and late membership | `US4`: staff bid `403`; leader becomes member; close → `UNSOLD(leader_ineligible)`; unit back; no award notice | S21 AS-40, AS-41, AS-42; S03 (invite and accept routes) |
| AS-30 anti-sniping | `US4`: bid at `end − 90 s`; end moved; original close no-op | S21 AS-24, AS-25, AS-26 |
| AS-31 close, order, notice | `US4`: clock to end; `CLOSED`; winner's order `RESERVED` at the price; seller sees `winnerOrderId`; one `auction.won`; stock still `2` | S21 AS-27, AS-33; S10 (fixed-price command, new: no id yet); S28 (rule `auction.won`) |
| AS-32 close delivered many times | `US4`: control surface sweep + job ×3; one `closed`, one order, one notice | S21 AS-28, AS-31 |
| AS-33 the winner pays | `US4`: J01 chain for the settlement order; `SOLD`; owner items; second payment event no change | J01 AS-01, AS-02; S21 AS-34 |
| AS-34 unpaid winner, second chance, unit returns | `US4`: clock +48 h; `SECOND_CHANCE`; runner-up order and notice; pay → `SOLD`; or +24 h → `UNSOLD`, stock back once | S21 AS-36, AS-37, AS-38, AS-39; S10 AS-36 (expiry) |
| AS-35 reserve not met | `US4`: `UNSOLD(reserve_not_met)`; no order; no award notice; stock back | S21 AS-29, AS-13 |
| AS-36 settlement consumer down; duplicates; late payment | `US4`: pause `auctions-order-results`; pay; resume; replay; late `order.paid` after offer | S21 AS-34, AS-39; S53 (pause, replay, lag) |
| AS-37 the inbox tells the truth | `US5`: one buyer through booking, drop and auction; inbox content and order; unread; read-all; SSE counts | S28 AS-01, AS-02 and its inbox section (unread, mark read; no stable id cited), W03 (UI, not here) |
| AS-38 everything at once | `US5`: concurrent booking, drop, chat, auction miniatures; invariants; no cross-talk; lag 0 | S22 SC-001, S11 SC-001, S23 SC-005, S21 SC-001 (each in isolation) |
| AS-39 every hop is observable | `US6`: metrics counters moved; every group `lag 0`, `RUNNING`; log redaction scan | S22 AS-58, S11 AS-42, S23 AS-52, S21 AS-51, S28 SC-010 |
| AS-40 approved paths only | `US6`: static gates over the five domains | S22 AS-61, S11 AS-43, S23 AS-54, S21 AS-52 |
