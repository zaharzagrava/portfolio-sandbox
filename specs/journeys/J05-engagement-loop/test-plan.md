# Test Plan: J05 — Engagement loop

Constitution VII.8: one row per acceptance scenario in [`spec.md`](spec.md) (37 rows). A rule already proven inside one capability is referenced in the last column, never re-tested here. Where the last column names a capability and a topic without a scenario number, that capability's `test-plan.md` has no stable scenario id for it yet; the implementation agent fills the number when it lands.

- Journey file: `packages/backend/test/journeys/engagement-loop.journey-spec.ts`, top-level `describe` "Journey J05: engagement loop", one nested `describe` per user story. It runs against the **running local stack** (`pnpm test:journeys`; `API_URL` default `http://localhost:8000`), black box: public APIs, SSE, the control surface and the read-only event tap only; no database, topic or queue reads.
- Waiting: `waitForContract(hop, probe)` over `test/utils/async-helpers.ts` `waitFor` (poll 250 ms, deadline = 2 × the hop's maximum in `spec.md`, × `JOURNEY_TIME_FACTOR`). No fixed sleeps. Time-driven steps advance the stack clock through the control surface; `controlSurface` restores the clock and resumes every paused group in `afterAll`.
- Fixtures (`test/journeys/support/`): J01–J03's kit plus `engagementFixture` and `storefrontDouble`.
- Provider doubles at the edge: payment by `paymentMethodId`, log providers for e-mail/SMS/push.
- Order of the file: US1 → US2 → US3 → US4 → US5 → US6 → US7. US4 to US6 use the paid orders of US3 (`OF`, `OC1`, `OC2`) or create their own.
- UI: AS-34 only, `packages/web/tests/engagement-loop.spec.ts` (Playwright), **pending** a web owner for the follow button and home feed.
- Static gates (AS-37): `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`.

| Scenario | Journey test (`packages/backend/test/journeys/engagement-loop.journey-spec.ts`) | Already proven by capability (ID) |
|---|---|---|
| AS-01 follow, new product in feed | `US1`: follow, status, empty feed, create `P`, poll feed; other buyer empty; tap shows one `feed.item_published` | S26 AS-01 (follow), AS-13 (item shape, announcement); S05 (product event) |
| AS-02 follow later / first read | `US1`: `C1` follows after `P`, first read shows it once | S26 AS-36 (follow makes items visible), AS-32 (rebuild) |
| AS-03 replay changes nothing | `US1`: replay `products.events`, `feed.events` through control surface; feed, tap, follow-status unchanged | S26 AS-15, AS-22 (duplicate delivery), AS-17 |
| AS-04 archived leaves feed; old event harmless | `US1`: archive, feed hides; replay created-after-archived; restore | S26 AS-17 (version guard), AS-38 (visibility at read) |
| AS-05 fan-out consumer down | `US1`: pause `community-feed-fanout`, create `P2`, lag, resume, one item | S53 (pause, lag), S26 AS-22, AS-45, AS-46 (fan-out redelivery, backpressure) |
| AS-06 sandbox/draft/price drop | `US1`: no items for sandbox/draft; one `price_drop`, none within 24 h | S26 AS-14 (kind rules) |
| AS-07 post → followers' feed | `US2`: `W` follows `B`, `B` posts, poll `W`'s feed, board list | S25 AS-01 (post create), S26 AS-14 (post item) |
| AS-08 retried post | `US2`: ×5 same key, again; key reuse `422`; one item | S25 idempotency AS (create), S54 Idempotency-Key |
| AS-09 comment notice | `US2`: `O` comments, poll inbox, unread, SSE; commenter and `W` none | S28 AS-13 (rule), S25 comment event AS; S28 `discussion.comment` row (no id yet) |
| AS-10 deleted post vanishes | `US2`: delete, next feed read omits at once, `404`, tap one `post_deleted`; replay older created | S26 AS-17 (delete before create), AS-38 (hydration hides); S25 delete AS |
| AS-11 discussion consumer down | `US2`: pause `community-feed-discussions`, post, lag, resume, one item | S53 (pause, lag), S26 AS-27 (consumer idempotency) |
| AS-12 board needs a product | `US2`: unknown product `404 board_not_found`, no event, feed unchanged | S25 board validation AS |
| AS-13 link → click → attributed order → paid → conversion | `US3`: create link with key, `GET /l/:code`, stats, checkout with `ref`, order attribution, pay (J01 chain), conversions/stats/tap; third user `404` | S37 AS (create, redirect, stats), S10 checkout AS, J01 AS-01 (pay chain); the conversion hand-off is new (no capability yet) |
| AS-14 retried checkout, same key | `US3`: ×5 same key with `ref`, then different `ref` `422`; one order, one conversion after pay | S10 idempotency AS (checkout), S54 |
| AS-15 conversion consumer down; replay | `US3`: pause `marketing-affiliate-conversions`, pay, lag, resume, one conversion; replay `orders.events`, tap unchanged | S53 (pause, lag, replay); idempotent-consumer AS to be added to S37 |
| AS-16 self-referral | `US3`: own link, order accepted `attribution: null`, no conversion | none (new rule of J05, owned by S37/S10) |
| AS-17 unknown/disabled/expired ref | `US3`: unknown, malformed shape, disabled → `202` null; expired → attributed and credited | S37 AS (disable, expiry, status), S10 checkout AS |
| AS-18 click without `ref` | `US3`: `C1` clicks, buys without `ref`: null, click counted, no conversion | S37 AS (click count) |
| AS-19 refund reverses credit | `US3`: full refund → `REVERSED`, stats drop, tap has `conversion_reversed`; partial refund; refund-before-paid replay | J01 AS-12/H12 (refund path), S13 refund AS; reversal new |
| AS-20 failed order never credits | `US3`: declined and expired attributed orders: no conversion | J01 AS-17, AS-19 (declined, hold expiry) |
| AS-21 link created once per key | `US3`: ×5 same key one link; off-marketplace `422` | S37 AS (idempotent create), AS (destination safety) |
| AS-22 three buyers, build, rail | `US4`: three paid orders, job via control surface, rail both ways, hidden when archived/out of stock | S34 AS-01, AS-13 (threshold), AS-29 (basket), AS-36 (build) |
| AS-23 under the threshold shows nothing | `US4`: one buyer pair `{P,R}`, build, no `R` | S34 AS-13/AS-14 (thresholds) |
| AS-24 basket consumer down; replay | `US4`: pause, `OC3`, build excludes it; resume, replay, build equals single delivery | S34 AS-30 (duplicate), AS-34 (late), AS-35 (replay) |
| AS-25 refund keeps the rail | `US4`: build after refund keeps `Q` with `P` | S34 assumption (refunds do not retract) |
| AS-26 events → trending | `US5`: storefront double posts views/carts, advance clock, poll `GET /trending` with weighted scores | S35 AS-01 (ranking), AS-10 (windows), AS-16 (weights) |
| AS-27 purchase alone no change | `US5`: pay `{P,Q}` orders, score unchanged after `lag: 0` | S35 (purchases not counted, assumption) |
| AS-28 duplicates, bad event, consumer down | `US5`: same `event_id`s, invalid `product_id`, pause/resume `discovery-trending-topk` | S35 AS-29, AS-30 (duplicate, invalid), AS-32 (crash loses nothing), S39 AS (partial accept) |
| AS-29 archived leaves ranking | `US5`: archive `P`, trending omits | S35 AS-03/AS-04 (visibility) |
| AS-30 exposure then purchase | `US6`: admin creates/starts `EX`, assignment stable, exposure, pay, results (403/401 checks) | S39 AS-27, AS-42 (results), AS-40 (admin), S38 assignment AS |
| AS-31 purchase before exposure | `US6`: pay then expose: exposed, not converted; second order after exposure converts once | S39 AS-43 (conversion window rule) |
| AS-32 duplicates and replay | `US6`: same exposure batch, replay `orders.events` for `experimentation-purchases`, pause during payment | S39 AS-13 (dedupe), SC-002 (replay), S53 (pause) |
| AS-33 no identity stitching | `US6`: anonymous exposure then signed-in purchase: no conversion, `excluded.unattributable > 0` | S39 scope (no stitching), AS-28 |
| AS-34 UI: follow → feed | `packages/web/tests/engagement-loop.spec.ts` (**pending**): follow on shop page, `O` publishes, feed card | none (no web owner; S26 asks J05) |
| AS-35 replay the whole loop | `US7`: record all observables, replay every group, rerun build, compare | S26 AS-22, S34 AS-35, S35 AS-31, S39 SC-002 (per-capability replay) |
| AS-36 privacy of the loop | `US7`: scan conversions, stats, tap events, response bodies and logs for buyer identity, keys, props | S37 SC-009 (click privacy), S39 AS-55 (logs) |
| AS-37 static gates | `US7`: run the six gates | constitution X.4/X.5, IX.5 (CI), S26 FR-051 |
