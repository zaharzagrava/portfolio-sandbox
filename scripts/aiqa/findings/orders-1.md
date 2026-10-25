# Orders, pass 1 (tester, 2026-10-25)

Proof: the permanent specs `packages/web/tests/seller/orders/page.spec.ts` and `orders-list.spec.ts` (run: `npx playwright test tests/seller/orders/list.spec.ts tests/seller/orders/page.spec.ts --project=desktop`). Each failing test below is left failing on purpose.

P1F1 [CONFIRMED] medium Sign-in redirect forgets the orders address (and its query)
Steps: signed out, open /dashboard/seller/{shopId}/orders?status=PAID&cursor=abc. Sign in.
Expected (orders.page.session-guard, W04.AS-84): /login?returnTo=<same path and query>; after sign-in the same orders view opens.
Actual: returnTo is only /dashboard/seller/{shopId}; after sign-in the person lands on the Overview. The layout guard (ShopFrame in components/dashboard/shop-frame.tsx, returnTo built from the shop root only) runs before the page guard, so the page's own returnTo is never used. Same for every seller section (the inventory and entry specs fail the same way).
Evidence: test "[orders.page.session-guard]" fails (received "/dashboard/seller/<id>"); also reproduced by hand twice with Playwright (aiqa-ord1-f.cjs, deleted).

P1F2 [CONFIRMED] low Orders skeleton is not shaped like the orders page
Steps: from the Overview click Orders while the page loads.
Expected (W04.R-27 / AS-91): skeleton of the real layout: heading, one select, table.
Actual: generic list skeleton: 3 toolbar boxes (search box and two chips) and a heading action box that the page does not have.
Evidence: test "[orders.page.suspense-skeleton, orders.page.skeleton-shape]" (toolbar boxes 3, expected 1).

P1F3 [CONFIRMED] medium Order reference is not unique on screen
Steps: shop with orders placed in the same minute; open Orders.
Expected (W04.B-32): a reference that tells two orders apart.
Actual: reference = first 8 characters of a time-ordered uuid; 20 rows show the same "01a17203" (seen in the test fixture, and 26 of 26 in an earlier live pass). Only the Date column differs.
Evidence: test "[orders.table.reference-collision]".

P1F4 [CONFIRMED] medium One row with an unknown currency code takes the whole Orders page down
Steps: an order whose currency code the browser does not accept (e.g. "XX1"; mocked in the browser read, the same as a bad BisOrder.currency).
Expected (W04.R-07): the other rows still show.
Actual: the page falls to the error boundary "Something went wrong"; formatMoney (lib/utils.ts) throws RangeError from Intl.NumberFormat, no guard.
Evidence: test "[orders.table.currency-unknown-code]".

P1F5 [CONFIRMED] low ?status=BOGUS shows an error panel with no way out
Steps: open /orders?status=BOGUS (upper case, shape accepted by readOrdersParams).
Expected (W04.R-10): an unsupported value becomes its default (All statuses).
Actual: the API answers 400; the panel reads "Check this field." with only "Try again" (which repeats the bad request); the select already shows "All statuses", so choosing it does nothing.
Evidence: test "[orders.filter.bad-upper-status-ui]"; network 400 GET /api/shops/{id}/orders?limit=20&status=BOGUS.

P1F6 [CONFIRMED] low A repeated status in the address is read differently by server and browser
Steps: open /orders?status=PAID&status=PENDING.
Expected (W04.R-10, map line): neither value; the default.
Actual: the server read ignores it (array), the browser takes the last value: the select shows Pending and 17 pending rows (one extra read, first paint discarded).
Evidence: test "[orders.filter.repeated-status]" (received 17 rows, expected 20).

P1F7 [SUSPICIOUS] low Very large amounts lose the last cent on screen; above 2^53 the whole list is a 500
Steps: ShopOrder.subtotal = 9007199254740991 (largest safe integer): the page shows EUR 90,071,992,547,409.90 instead of .91 (formatMoney divides as floating point). With 9007199254740993 the API answers 500 for the whole list (safeNumber RangeError, by design III.8), so one bad row hides every order.
Evidence: test "[orders.table.big-number]" (mocked browser answer); the 500 was seen with curl after a database update of my own shop's row (restored).

P1F8 [CONFIRMED] medium The buyer id is sent to the browser and is in the page source
Steps: open the orders page; read the page HTML (server-rendered hydration data) and the list answer.
Expected (W04.B-32 / AS-83): no buyer identifier.
Actual: every slice has `buyerId` in GET /orders and the same value is in the HTML of /dashboard/seller/{shopId}/orders (checked with page.request.get, true twice). It is not drawn on screen.
Evidence: packages/contracts/src/orders/order.ts shopOrderPageSchema; hand check aiqa-ord1-c.cjs (deleted).
