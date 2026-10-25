# entry, pass 2 (ai-tester, 2026-10-25): findings

Specs added in packages/web/tests/aiqa/: entry-form-more, entry-picker, entry-many, entry-frame, entry-shell, entry-roles (+ entry-support.ts).
Run: `npx playwright test tests/aiqa/entry- --workers=2` (desktop and mobile 390 px projects; Firefox not run).
VIEWER, STAFF and ADMIN were made through the real invitation mail (dev mailbox), so the menu was checked for all four roles.
The failing tests named below are left failing on purpose: each one is a finding.

P2F1 [CONFIRMED] low The "shop not found" page has the wrong title: it is "Overview" or "Seller dashboard", not "Shop not found"
- Steps: signed in, open /dashboard/seller/<unknown or foreign or deleted or malformed id> (also .../inventory).
- Expected (map entry.frame.not-found-page; code intent in app/dashboard/seller/not-found.tsx and [shopId]/not-found.tsx): tab title "Shop not found", the same for every case.
- Actual: "Overview · Marketplace" for the shop root, "Seller dashboard · Marketplace" for a section (e.g. .../zzz/inventory). The page's own metadata (overview page title, layout title) wins over the not-found metadata, so the title also depends on the section the person typed. The words on the page are identical in all five cases (good), the robots tags contain noindex.
- Evidence: test "entry.frame.malformed-shop-id ..." (entry-frame.spec.ts) soft-fails five times at "title of the ... case"; reproduced in 4 runs, desktop and mobile.

P2F2 [CONFIRMED] low The "shop not found" page answers HTTP 200, not 404
- Steps: GET /dashboard/seller/<unknown uuid> (also foreign, malformed) with a signed-in session.
- Expected (map entry.frame.unknown-shop-id / foreign-shop-id: "HTTP status 404"; W04 AS-85).
- Actual: 200 in all three cases. The layout starts streaming the shell skeleton inside Suspense and calls notFound() afterwards, so the status line is already sent. The answer is at least the same for unknown and foreign (nothing is revealed). The page carries noindex, so the effect is cosmetic (no crawler or monitoring sees a 404). Dev server only was checked.
- Evidence: same test, soft check "the not-found page answers with the status 404".

P2F3 [CONFIRMED, same as P1F2 / register B-023] medium Signed-out visit to a section of a shop loses the section and the query
- Re-checked with /dashboard/seller/<id>/orders?status=PAID&x=1: lands on /login?returnTo=%2Fdashboard%2Fseller%2F<id>. A direct /login?returnTo=<full path with repeated parameters> is honoured after sign-in, so only the guard of the frame is at fault (`ShopFrame` builds returnTo from the shop id only).
- Evidence: test "entry.frame.signed-out-shop-url ..." fails, desktop and mobile.

## Not bugs, map corrections found while testing
- Region is not on `Shop`; it is `ShopDirectory.region` (default eu-central-1, first of TENANCY_REGIONS or the built-in pair). The form sends only name and slug.
- Page titles: the layout's "Seller dashboard" is only a default; the overview page sets "Overview", so the tab reads "Overview · Marketplace" (the map line says "Seller dashboard"). Cache-Control of a shop page on the dev server is `no-cache, must-revalidate` (map says no-store).
- Switcher text "Switch shop" cannot be reached: the shop frame always puts the current shop into the list. The "current entry of the Account group" cannot be reached either: /orders and /account/security are outside the shell.
- The root loading screen has an invisible (sr-only) "Loading…" status text; the shell and page skeletons themselves have no text.
- `[shopId]/error.tsx` takes the prop `retry`; "Try again" does work in this Next version (checked with a broken shop row, then repaired).
- A shop whose stored plan is an unknown value is a handy way to make the shop read or the list read fail (error page / soft-fail list) without stopping the API.
- Mailbox: a person invited to several shops gets several mails; `readInviteLink` returns the newest one it finds at once, which can be the old, already used link. The new helper `acceptInvite` in entry-support.ts waits for a link that has not been used yet.
- Blocked (cannot be made without stopping the stack): shop read answers 401 (frame.401-on-shop-read) and 403 (frame.403-as-404; the API answers 404, never 403, for a foreign shop).

## Flake: entry.form.submit-happy-path (found, not a random failure)
Cause: it is a real timing hole on top of the P1F5 bug, not randomness in the machine.
- The product sends a third POST /api/bff/session/refresh although the second answer already says SELLER (P1F5). Measured on 6 runs (3 idle, 3 with another suite running): requests at about +1.1 s, +3.2 s to +3.9 s, +7.3 s to +8.6 s after the click; the third was always sent.
- The test waits for "count == 2", then expects NO further request within 5 s (`waitForRequest(..., {timeout: 5000})` must reject). The third request comes 4.1 s (idle) to 4.7 s (loaded) after the second, so it normally lands inside the 5 s window and the test fails: 8 of 8 runs with 2 workers failed this way.
- The test passes only when the machine is slow enough that the second refresh answer and the poll delay push the third request more than 5 s after the moment the poll saw the second. That is why one run failed and the rerun (with different load) passed. Fixing P1F5 (read `result.user.role` instead of `result.session.role`) makes the test pass every time; no retry is needed or wanted.
