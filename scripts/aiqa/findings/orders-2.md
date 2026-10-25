# Orders, pass 2 (tester, 2026-10-25)

Proof: permanent specs in `packages/web/tests/aiqa/`: `orders-privacy`, `orders-paging`, `orders-states`, `orders-roles`, `orders-phone-a11y`, `orders-db`, `orders-contract`, `orders-source`, `orders-auction` (helper: `orders-seed.ts`, rows written for shops and buyers the spec made). Each failing test named below is left failing on purpose.
Run: `npx playwright test tests/aiqa/orders-<name>.spec.ts --project=desktop` (and `--project=mobile`).

## Re-run of the two pass 1 specs (orders-list, orders-page), desktop and mobile

Desktop: 14 passed, 7 failed. Mobile: 12 passed, 8 failed.
The 7 desktop failures are exactly the pass 1 findings, unchanged:
- orders.filter.bad-upper-status-ui = P1F5, orders.filter.repeated-status = P1F6, orders.table.reference-collision = P1F3, orders.table.currency-unknown-code = P1F4, orders.table.big-number = P1F7, orders.page.skeleton-shape = P1F2, orders.page.session-guard = P1F1.
The mobile run has the same 7 plus one more: the first test of orders-page.spec ("route-and-nav ... server-first-read ...", line 28). It is a TEST problem, not a product bug: at 390 px the sidebar is hidden in the phone menu, and the test clicks the sidebar link `getByRole('navigation').getByRole('link', {name:'Orders'}).first()`, which is not visible (timeout). The skeleton test (line 86) times out on mobile for the same reason (it also fails on desktop for P1F2). The phone-menu entry itself works (test "the phone drawer has the Orders entry too" passes on mobile). I did not edit the existing tests (rule); a phone-aware version should open the menu first.

## New findings

P2F1 [CONFIRMED] medium The buyer id is in the list answer and in the page HTML (B-035, same as P1F8)
Steps: open Orders; read `GET /api/shops/{id}/orders` and the HTML of `/dashboard/seller/{id}/orders`.
Expected (W04.B-32 / AS-83): the table is "without buyer identity"; no buyer identifier leaves the server.
Actual: every slice has `"buyerId":"<BisOrder.userId>"` in the answer and the same value is in the hydration data of the page HTML. It is not drawn on screen (ui checks pass), so the leak is only in the data.
Evidence: test `[orders.table.no-buyer-api-and-html]` in orders-privacy.spec.ts (desktop and mobile, fails each time; the buyer id is compared with the database value of BisOrder.userId). Source: `shopOrderPageSchema` (packages/contracts) and `SequelizeShopOrderRepository.pageForShop` select `o."userId" AS "buyerId"`.

P2F2 [CONFIRMED] low No sign that the next view is loading (the "busy" state can never be seen)
Steps: open Orders with 45 slices; hold back the page's own server request (the `_rsc=` navigation request) and press "Next page" (also the same when choosing a status).
Expected (map orders.table.busy-keeps-rows / orders.paging.hidden-while-busy, W04 AS-31): old rows stay, dimmed, `aria-busy="true"`, paging links hidden.
Actual: nothing changes while the request is out: table `aria-busy` stays "false", rows are not dimmed, "Next page" stays clickable, address unchanged. The dimmed/busy branch (`isPlaceholderData`) is only reachable when the server read has no data for the new address, and the server answers the navigation with that data in one go. On a slow server a person sees a dead page and can press the link again. Reproduced twice (hand probe and the test, on desktop and mobile).
Evidence: test `[orders.table.busy-keeps-rows, orders.paging.hidden-while-busy]` (orders-paging.spec.ts).
Note: the "empty box never flashes" line passes (no empty text seen during a held request, observer on the DOM).

P2F3 [CONFIRMED] low A long shop name with no spaces makes the page scroll sideways at 390 px
Steps: shop name of 80 letters with no space (the longest the form takes); open Orders at 390 px.
Expected (map orders.table.long-values): long values wrap; the page is not wider than 390 px.
Actual: the subtitle "The orders placed with {name}, newest first." does not wrap; document width 1075 px for a 390 px screen (`MAIN`, the page container and the text block report scrollWidth 1075 > 390). The table rows wrap correctly (a very large amount and JPY were also in the answer). The shell's own shop name in the sidebar header is truncated correctly.
Evidence: test `[orders.table.long-values]` (orders-phone-a11y.spec.ts), reproduced twice by hand and in the test. Fix idea: `break-words` on the subtitle.

P2F4 [CONFIRMED] medium Every checkout the shop could not serve (out of stock) is listed to the seller as a Cancelled order
Steps: product with 1 piece in stock; two buyers press "Place order" at once (or one after the other).
Expected (map orders.source.out-of-stock-cancel asks to check): a checkout that never held any stock should not make work for the seller; the buyer's own list hides it.
Actual: the buyer who lost gets 202 or 422 `out_of_stock`, and in BOTH cases the database keeps a `BisOrder` CANCELLED (`cancelReason out_of_stock`) with a `ShopOrder` CANCELLED, so the seller's Orders page gets a new "Cancelled" row for every refused attempt (seen with an answer 422 too, in 3 runs). A buyer can fill a shop's list with Cancelled rows by pressing checkout on a sold-out product again and again. The rows are real but carry no stock, money or action.
Evidence: test `[orders.source.out-of-stock-cancel]` (orders-source.spec.ts) records the rows (it asserts the observed state: one PENDING and one CANCELLED slice for the single piece); SQL: `select o.status, o."cancelReason", so.status from "BisOrder" o join "ShopOrder" so ...` shows `CANCELLED | out_of_stock | CANCELLED`.

P2F5 [CONFIRMED] medium A suspended or closing shop cannot read its orders, although the spec and the banner say reading still works
Steps: platform admin suspends the shop (`POST /api/admin/shops/{id}/suspend`); open Orders. Same for status DELETING.
Expected (W04.R-03 "MUST still allow every read"; banner text): "This shop is suspended. You can view data but not make changes." and the order list readable.
Actual: the banner is shown, the list read answers 403 `shop_suspended` (DELETING: 409 `shop_offboarding`, not 403 as the map says), and the Orders area shows the same sentence in a red alert with "Try again". "Try again" cannot ever work while the status holds (checked: it asks again, answer 403 again, panel unchanged). After reinstating, a reload shows the list. Cause: `orders.read` is not in `WHILE_SUSPENDED` (shop.read, members.read, shop.export) in `shop-access.service.ts`.
Evidence: test `[orders.shop.suspended-banner, orders.shop.suspended-read, orders.shop.suspended-banner-vs-list, orders.shop.status-change-while-open]` (orders-roles.spec.ts; it asserts the 403 and the alert as the observed state, and that the list comes back after reinstating); `[orders.shop.deleting, orders.shop.deleted]` for the closing shop. The status of a shop is cached by the API for a while: a direct database change shows after a few seconds (the tests poll for it).
Note for the owner: the lines pass on the "what happens" side; the contradiction with the spec sentence is the bug.

P2F6 [SUSPICIOUS] low Coming back online sometimes asks for the orders twice
Steps: open Orders; go offline; come back online.
Expected (map orders.state.offline): the orders on screen are refetched once.
Actual: 2 reads of `GET /orders` in 2 of 4 repeated runs (and 1 of 2 earlier runs), 1 read in the others. Two triggers (the app's own invalidate on reconnect and the query library's refetch-on-reconnect) land at slightly different moments. The test keeps the strict "once" and therefore fails on some runs (flaky by the product's behaviour).
Evidence: test `[orders.state.offline]` (orders-states.spec.ts), `--repeat-each=4`.

P2F7 [SUSPICIOUS] low "Go to the first page" in the invalid-cursor panel drops the status filter
Steps: open `?status=PAID&cursor=<cursor of another shop>`; press "Go to the first page".
Expected: the "First page" buttons of the page keep the status (tested: they do); the map asked to check this one.
Actual: it goes to the plain orders address (`firstPageHref={pathname}` in orders-view.tsx), so the filter is lost and the person sees all statuses.
Evidence: test `[orders.paging.cursor-bound-to-shop, orders.paging.go-to-first-page-button, ...]` (it asserts the address without the status, the observed behavior).

Other open items of pass 1, re-seen and still true (no new id): P1F4 also with `ZZZZ` (test `[orders.table.currency-invalid-crash]`: the whole page falls to "Something went wrong"), P1F5 (test `[orders.filter.invalid-value-select-blank]`: ?status=BOGUS shows "Check this field." with only "Try again"; the select shows "All statuses", not a blank value as the map says).

## Notes (no bug)

- Map text vs code: the map says the closing shop answers 403 `shop_offboarding`; it answers 409.
- The sidebar group names ("Shop", "Developers", "Account") are `h2` inside the navigation; the page's own part has the only `h1` (orders.a11y.landmarks passes on that reading).
- Fixture race seen once in `shopWithOrders` (orders-support.ts): paying right after the slice shows answered 404 `order_not_found` for `/api/payments/intents`; a rerun passed. Not investigated further.
- The dev server compiled a CSS error from `app/globals.css` (an unrelated class with control characters) during one run and showed the Next.js error overlay on a page; it went away on its own. Not an orders issue.
- Not testable here: REFUNDED slices (the only route is the signed payment webhook `charge.refunded`; the signing secret is not available to a tester), fulfilment moves (courier flow), shop discounts (needs a deployed shop function), a member without `orders.read` (every role has it; no custom roles).
