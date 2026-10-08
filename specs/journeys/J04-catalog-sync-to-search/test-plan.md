# Test plan: J04 — Catalog sync to search

Constitution VII.8: every acceptance scenario of `spec.md` maps to exactly one row. The journey test file is `packages/backend/test/journeys/catalog-sync-to-search.journey-spec.ts` (top-level `describe` "Journey J04: catalog sync to search"). A rule already proven inside one capability is referenced in the last column and not re-tested here; the journey asserts only the hand-off. No UI journey exists (API journey; screens belong to W04 and the device app).

Test rules: public APIs, the Shopify and scanner doubles, and the control surface only; waiting is polling against the hop deadline of `spec.md` (2 × maximum, 250 ms interval, `JOURNEY_TIME_FACTOR`); no fixed sleeps; unique run token `j04<run>`; `afterAll` restores the clock and resumes every consumer.

| Scenario | Journey test (`packages/backend/test/journeys/catalog-sync-to-search.journey-spec.ts`) | Already proven by capability (ID) |
|---|---|---|
| AS-01 file to search | `US1 › imports a 60-row CSV and the products become searchable` | S07 AS-01, AS-07, AS-13, AS-21, AS-55; S05 AS-60, AS-82; S32 AS-36 |
| AS-02 retried start, re-import unchanged | `US1 › same idempotency key and same file change nothing` | S07 AS-03, AS-10, AS-17; S05 AS-60 (unchanged → no event) |
| AS-03 changed rows reach search | `US1 › changed prices update search, stock untouched` | S07 AS-18, AS-20; S05 AS-60; S32 AS-34, AS-36 |
| AS-04 rejected file reaches nothing | `US1 › a disguised archive fails and writes nothing` | S07 AS-26, AS-16, AS-22 |
| AS-05 connect and backfill | `US2 › install, callback, backfill, products searchable` | S08 AS-01, AS-03, AS-04, AS-05, AS-12, AS-13; S05 AS-60 |
| AS-06 webhook fast path, duplicate delivery | `US2 › signed webhook updates once, duplicate and bad signature ignored` | S08 US3 (webhook receipt, dedupe, signature); S08 AS-13 |
| AS-07 scheduled pull via control surface | `US2 › sync-all job pulls a change that had no webhook` | S08 US2 (watermark, lease); S49 jobs |
| AS-08 stock a point, find it | `US3 › pickup stock makes the product available near me` | S19 AS-01, AS-20, AS-24; S19 product-ownership check (IDOR); S05 AS-13 |
| AS-09 catalog changes follow into near-me | `US3 › title, price, archive and restore reach near-me` | S19 AS-25, AS-29; S05 AS-07, AS-16, AS-17; S32 AS-36 |
| AS-10 sale reaches search and Shopify | `US4 › device sale lowers catalog, search and Shopify once, no echo` | S09 AS-01, AS-52; S05 AS-51, AS-82; S08 AS-35, AS-36, AS-40 |
| AS-11 same operation again, then sell out | `US4 › replayed opId has no second effect; sell-out sets inStock false` | S09 op replay (`replayed`), `op_id_reused`; S05 AS-51; S32 AS-36 |
| AS-12 CSV product: no Shopify write, pickup independent | `US4 › unlinked product never calls Shopify; pickup count only moves by its own route` | S08 AS-40 (unlinked ignored); S19 AS-20 (adjustments, idempotency) |
| AS-13 another device sees the sale | `US4 › second device pulls the sale in order` | S09 AS-24, AS-25 |
| AS-14 both sold, either order | `US5 › both sides sold converges to local + remote − base` | S08 AS-37, AS-45 (merge rule, pure) |
| AS-15 oversold clamps and opens a conflict | `US5 › oversold clamps both sides to zero and opens one conflict` | S08 AS-38, AS-39; S09 AS-09 (clamp) |
| AS-16 Shopify down, repaired by next trigger | `US5 › provider outage does not block the sale; next trigger repairs` | S08 AS-43, AS-57, AS-59 |
| AS-17 search consumer down, catch-up | `US6 › paused search consumer is stale then converges after resume` | S32 AS-33, AS-35; S53 pause/resume/lag |
| AS-18 push consumer down, burst becomes one write | `US6 › three sales while paused become one Shopify write` | S08 AS-44 (coalescing), AS-40 |
| AS-19 replay: duplicates and old after new | `US6 › replay of topics reproduces every observable and writes nothing to Shopify` | S19 AS-26, AS-31; S32 AS-34; S08 AS-40; S05 AS-40 |
| AS-20 suspended shop | `US7 › suspend hides products, halts import, push and sync; reinstate restores` | S19 AS-30; S08 shop-lifecycle story; S07 AS-45; S32 shop-state story; S03 status gate |
| AS-21 no cross-tenant reach | `US7 › another shop's owner reaches nothing across the chain` | S07 and S09 IDOR cases; S19 `product_not_found`; S08 `integration_not_found` |
| AS-22 one writer, one version per change | `US7 › version increases by one per accepted change across four writers` | S05 AS-82, AS-60; S09 AS-52 |
| AS-23 every hop shows progress | `US8 › progress is observable and admin-only` | S07 AS-55; S08 AS-67; S32 AS-77; S53, S49 control surface |

Unit layer: none (a journey adds no pure logic). Contract layer: every response in the journey is parsed with the capability's `packages/contracts` schema (`importJobSchema`, `integrationSchema`, `conflictPageSchema`, `productPageSchema`, `productSearchResponseSchema`, `syncPushResponseSchema`, `syncPullResponseSchema`, the near-me schemas), so a shape drift fails here as well.

Gate: a recorded green run of the journey on the local stack, with every consumer back at `lag: 0` and the clock restored, before the journey counts as done (VII.9).
