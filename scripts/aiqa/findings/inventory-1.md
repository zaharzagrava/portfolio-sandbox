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
