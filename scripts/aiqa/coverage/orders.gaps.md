# Orders: differences between spec and code (mapper, 2026-10-25)

How this was made: read the page, the view, the table, the API client, the server read, the backend controller / service / repository / models, the spec (W04, S10, tests plans). Live checks done without a browser (curl against http://localhost:3000 as seller@marketplace.local, shop "Demo Shop", ACTIVE, OWNER): the list answer, the filters, the limits, the cursor errors, the page HTML. The page was NOT driven in a real browser at 390/1280 px by this mapper, so every layout line is still untested.

## (a) In the code but not in the spec

1. The answer carries `buyerId` and it reaches the browser. `packages/contracts/src/orders/order.ts` (shopOrderPageSchema has `buyerId`), `packages/backend/libs/domains/orders/infra/shop-order.repository.ts` (`o."userId" AS "buyerId"`). The view does not show it, but the server-rendered page HTML contains it (checked: the id of the buyer appears in the HTML of /dashboard/seller/{shopId}/orders). The spec only says the table has no buyer identifier.
2. Forbidden-panel "Overview" button, status banner, offline banner, session-ended text, copy-reference button on the error panel: `packages/web/components/seller/forbidden-panel.tsx`, `shop-status-banner.tsx`, `problem-states.tsx`. They are in W04 as general rules, not as orders behavior.
3. The reference is the first 8 characters of ShopOrder.id (uuid v7, so time-ordered: two orders created within about a minute share the first 8 characters). `packages/web/components/seller/orders/orders-view.tsx`. W04.B-32 says "reference" but not how it is built.
4. "Items" counts lines, not units (`row.items.length`). Not defined in the spec.
5. Page size fixed at 20 (`packages/web/lib/seller/wire.ts` SHOP_ORDERS_PAGE_SIZE); not in W04.
6. Status filter options are the 4 shop-order statuses (Pending, Paid, Cancelled, Refunded); the order has 8 statuses on the buyer side (RESERVED, FULFILLING, SHIPPED, DELIVERED are never on the slice). `packages/contracts/src/orders/order.ts`. The seller cannot see shipping progress here; W04 does not say so.
7. An unknown status is drawn in title case (`orderStatusLabel`) as an outline badge. No spec rule for it (see (c) 3 for why it cannot happen).
8. The skeleton of this page is the generic list skeleton (search box, two chips, action button) which does not match the real page (one select, no action). `packages/web/components/seller/page-skeletons.tsx` ListPageSkeleton, used by `packages/web/app/dashboard/seller/[shopId]/orders/loading.tsx` and `page.tsx`.
9. The list is read again on mount (staleTime 0) and when the browser comes back online; no live update. Not in the spec for orders.
10. The status filter value `?status=` is accepted by the page for any value matching `[A-Z_]{1,32}` (`packages/web/lib/seller/search-params.ts` readOrdersParams) and passed to the API.

## (b) In the spec but not found in the code (likely bugs or missing proof)

1. W04.R-07 "Money MUST be formatted from integer minor units and the currency of the same response": done by `formatMoney`, but marked `[proof: none]` in the spec; no test covers it for orders (and a bad currency code throws in `Intl.NumberFormat`, `packages/web/lib/utils.ts`). Not a missing feature, a missing proof.
2. W04.R-03 "A suspended or closing shop ... MUST still allow every read": the orders read is NOT allowed (see (c) 1). Behavior missing.
3. W04.B-32 "with no buyer identifier": the identifier is not shown but is sent (see (a) 1). Partly missing.
4. W04.AS-86 says disabled controls: the orders page has no write control, so nothing to disable; no orders test for the suspended case exists (`packages/web/components/seller/orders/orders-view.test.tsx` has 6 tests, none about shop status).
5. W04.R-34 / W03 realtime: nothing about orders arriving live is built on this page; the overview has the live panel, the orders page has none. Spec does not promise it, but a seller would expect "Today's new order" to show here; confirm with the owner.
6. S10.R-39 says "for every role of the shop"; there is no check in the web test plan for ADMIN/STAFF/VIEWER on the page (only API e2e `packages/backend/libs/domains/orders/order-read.e2e-spec.ts`).

## (c) Spec and code disagree

1. Suspended shop.
   - Spec W04.R-03: "A suspended or closing shop MUST disable every write control with the banner text as its reason, and MUST still allow every read."
   - Spec S10.R-39: "a shop that is not ACTIVE follows the S03 status gate (403 for a suspended shop)".
   - Code: `packages/backend/libs/domains/tenancy/application/shop-access.service.ts` WHILE_SUSPENDED = shop.read, members.read, shop.export. `orders.read` is not in it, so GET /shops/{id}/orders answers 403 shop_suspended; in the web the page then shows the alert with the suspended text (problem-copy `shop_suspended`) instead of the orders. The two spec rules disagree with each other; the code follows S10. Same for DELETING (403 shop_offboarding).
2. Buyer identity.
   - Spec W04.B-32 / AS-83: "no buyer identifier"; W04 US8 "without buyer identity".
   - Code: `buyerId` is in the API answer and in the page HTML (hydration data) and in the browser query cache; `packages/web/lib/api/seller-orders.ts` comment says "The buyer id is in the answer and is never shown".
3. Unknown status.
   - Code comment/test: "an unknown status shows in title case" (`orders-view.tsx` orderStatusLabel; test "an unknown status shows in title case").
   - Code: the answer is parsed with a strict enum (`shopOrderStatusSchema` in `packages/contracts/src/orders/order.ts`, `parseBody` in `packages/web/lib/api/parse.ts`), so a status outside the four makes the whole answer an error and the page shows the server-error panel, never a title-case badge. The label code can only be reached by a test that skips the parser.
4. Skeleton (W04.R-27 / AS-91: "shaped like its layout"): the orders skeleton has an action button and a search box that the page does not have (`page-skeletons.tsx` ListPageSkeleton; page has only a select).
5. Bad status in the address.
   - Spec W04.R-10: "an unsupported value MUST become its default".
   - Code: `readOrdersParams` only checks the shape `[A-Z_]{1,32}`; `?status=BOGUS` is sent to the API, which answers 400 validation_failed; the page shows an error panel and the select has no matching option. Lower case values (`paid`) do become the default. Expected by the rule: BOGUS becomes "All statuses".
6. Invalid cursor.
   - Spec W04.R-10 says a bad cursor value becomes the default only for the shape; `readCursor` accepts any text of allowed characters up to 512; a well-formed but wrong or foreign cursor goes to the API and the page shows "That page link is no longer valid." with "Go to the first page" (W04.AS-89 describes this, so this one is consistent; included so the tester checks that "Go to the first page" keeps or drops the status filter).
7. Order statuses.
   - Spec S10: the order has 8 statuses; W04 B-32 lists "status" of the slice. Code: the slice only moves PENDING -> PAID/CANCELLED/REFUNDED (`order-lifecycle.service.ts` setStatus), fulfilment statuses never reach it. A shipped order shows "Paid" for ever. Spec does not say which is wanted.
8. Spec text "reference" (W04.B-32) vs W04 view test: reference is 8 characters of ShopOrder.id, while the buyer sees the BisOrder id (`orderId`, in the answer but not shown), so seller and buyer cannot quote the same number to each other.

## Could not map / not done

- No real browser pass (desktop and 390 px) and no pass as VIEWER/STAFF/ADMIN or on a suspended shop: only code reading and curl. Those lines are all `untested`.
- The ledger (S14) and payment intents (S13) are not read by this page; only their effect on ShopOrder.status was traced (via order-lifecycle.service.ts and the payments consumer). The exact payment webhook to ShopOrder path was read at the level of the setStatus calls, not step by step through payment-result.service.ts.
