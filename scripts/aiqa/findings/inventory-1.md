# Inventory findings, pass 1 (ai-tester)

P1F1 [CONFIRMED] medium Signed-out visit to a seller page loses the page and the query in `returnTo`
Steps: signed out, open /dashboard/seller/{shop}/inventory?q=abc (also tried ?status=ARCHIVED). Wait for the redirect.
Expected (W04.B-33, W04.AS-84): /login?returnTo=<full path plus query>, i.e. %2Fdashboard%2Fseller%2F{shop}%2Finventory%3Fq%3Dabc.
Actual: /login?returnTo=%2Fdashboard%2Fseller%2F{shop} (no /inventory, no query), twice. After login the seller would land on the shop root, not the page they asked for. The old address /dashboard/seller/inventory keeps its returnTo correctly.
Cause: components/dashboard/shop-frame.tsx ShopFrame (layout) runs requireServerSession(sellerReturnTo(`/dashboard/seller/${shopId}`)) before the page's own requireSellerSession(path, raw); the layout redirect wins. Also the answer is HTTP 200 with an empty body and the redirect happens in the browser a moment later (no product data leaks; HTML has no "Bulk").
Evidence: aiqa-inv1-t1c.cjs, aiqa-inv1-t2.cjs (deleted after the pass).

P1F2 [CONFIRMED] low Two buttons with the same name "Open menu" at phone width
Steps: 390 px wide, open the inventory page. Header has "Open menu" (site menu: Account, Dashboard, Orders, Browse...) and the Shop bar has another "Open menu" (seller menu: Overview, Inventory, ...). 
Expected (W04.R-25 accessible names): the two controls can be told apart.
Actual: both have aria-label "Open menu", so a screen reader user or a test cannot tell which is which (Playwright strict-mode violation). 
Evidence: aiqa-inv1-t2.cjs / t2c.

P1F3 [CONFIRMED] low A 101 to 200 character search gives only "Check this field."
Steps: type 101 (or 150, 200) letters in "Search your products", or open ?q=<150 letters>.
Expected (gap list (c), W04.B-11 clear message): the person is told the text is too long (limit 100), or the box stops at 100.
Actual: the page keeps up to 200 characters (search-params.ts), the API answers 400 validation_failed, the Products region shows "Check this field." and "Try again" (retry sends the same 400). No maxlength on the box. Hits at exactly 100 work.
Evidence: tests/aiqa/inventory-search.spec.ts [inventory.search.long-text] (fails desktop and mobile); direct API 101 chars 400, 100 chars 200.

P1F4 [CONFIRMED] low A slow next page shows no busy state (W04.R-26 "old rows stay, dimmed, aria-busy")
Steps: shop with 21 products, hold the request of the next-page address (cursor) for a few seconds, press "Next page".
Expected (W04.R-26, AS-31): old rows stay, the table is aria-busy="true" and dimmed, paging links hidden until the new rows arrive.
Actual: the next page is a server-rendered navigation seeded as initial data, so the client query is never in the placeholder state; table aria-busy stays "false", nothing is dimmed, and the "Next page" link stays pressable while the old page is shown (also for search and filters: a changed address is answered by the server render, not by the client query). The busy styling exists in code (inventory-view.tsx busy) but is only reachable when the server's first read failed.
Evidence: tests/aiqa/inventory-search.spec.ts [inventory.paging.busy-dimmed] (fails desktop and mobile).

P1F5 [CONFIRMED] low Search lag note (gap list, info only): an archived product archived right after creation showed in the search only after the outbox relay caught up (a backlog of about 1900 pending outbox rows was on the stack at 07:27). Not counted as a bug; the spec polls up to 90 s.
