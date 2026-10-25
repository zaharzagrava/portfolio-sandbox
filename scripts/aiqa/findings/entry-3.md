# entry, pass 3 (ai-tester, 2026-10-25): findings

Specs added in packages/web/tests/aiqa/: entry-switcher, entry-drawer, entry-banner, entry-offline, entry-api, entry-misc, entry-retry (reuse entry-support.ts, db.ts; invitations through `acceptInvite`, which takes the newest unused link).
Run: `npx playwright test tests/aiqa/entry- --workers=2` (desktop and mobile 390 px projects; each drawer test sets 390 px itself).
The failing tests named below are left failing on purpose: each one is a finding.

P3F1 [CONFIRMED] medium A long shop name with no spaces pushes the dashboard pages sideways at 390 px
- Steps: shop named `WWWW...(40) mmm...(39)` (80 characters, allowed); open /dashboard/seller/<id>/inventory (also /orders, /team, /developers/api-keys, /campaigns) at 390 px width.
- Expected (map entry.drawer.sideways-scroll, W04.B-37): document.scrollWidth equals the viewport, no sideways scroll.
- Actual: scrollWidth 544 on every page of that shop. On /inventory the culprit is the page head: `<div class="space-y-1">` with the h1 and the line "The products of <shop name>." (right edge at 544 px); the other pages are wide for the same reason. A short name gives 390. The switcher and the shop bar themselves cut the name with an ellipsis (fine).
- Evidence: test "entry.drawer.sideways-scroll" (entry-drawer.spec.ts), desktop project at 390 px; reproduced in 3 runs plus a probe listing the elements with right edge > 390. (In the `mobile` project the emulated phone widens the layout viewport, so the check passes there and proves nothing.)

P3F2 [CONFIRMED] low Growing the window to 1280 px with the drawer open leaves the drawer open over the page and the page locked
- Steps: 390 px, press Open menu, then resize to 1280 px (rotate tablet, resize window).
- Expected (map entry.drawer.rotate-resize, W04.B-37): the sidebar shows, the drawer is closed or hidden, no scroll lock on the body.
- Actual: the "Seller menu" dialog stays visible (x 0, 384 px wide) on top of the sidebar, `body` keeps `overflow: hidden` / `data-scroll-locked`, until Escape is pressed.
- Evidence: test "entry.drawer.rotate-resize" (desktop and mobile projects, 3 runs) and a probe printing `dlg: true, bodyOv: hidden, locked: true`.

P3F3 [CONFIRMED] low While the drawer is open the page behind it is still in the accessibility tree
- Steps: 390 px, press Open menu, ask the accessibility tree for `main`.
- Expected (map entry.drawer.open: "page behind inert"): the content behind the sheet is hidden from screen readers.
- Actual: `<header>` and `<main>` (and the "Last 30 days" region) carry no `aria-hidden`/`inert` (other body children do); `getByRole('main')` still finds one element. Keyboard focus is trapped in the sheet (40 Tab presses stay inside) and the backdrop blocks the mouse, so only the screen-reader virtual cursor reaches the page.
- Evidence: soft check in "entry.drawer.open ..." (entry-drawer.spec.ts), desktop and mobile; probe listing the body children.

P3F4 [CONFIRMED] medium A write refused with 403 shop_suspended shows the words but not the banner, and the controls stay enabled
- Steps: open Team > Invitations of an active shop; an admin suspends the shop (POST /admin/shops/:id/suspend, 200); type an e-mail and press "Send invitation".
- Expected (W04 AS-86: "When a write still returns 403 shop_suspended ... the same banner is shown and the list refetches"; map entry.banner.refresh-after-status-change).
- Actual: the alert "This shop is suspended. You can view data but not make changes." appears under the form, but the amber "Shop status" banner never appears and "Send invitation" stays enabled (the shop data is not re-read: the `refetch: true` of problem-copy only invalidates the page's React Query data, while the status comes from the server-rendered frame). A reload shows the banner and the disabled controls.
- Evidence: test "entry.banner.refresh-after-status-change" (entry-banner.spec.ts), both projects, 3 runs. The same page after a navigation shows the banner correctly (other banner tests pass).

P3F5 [CONFIRMED] low Coming back online refetches the open product list twice, not once
- Steps: /inventory open, go offline (notice shows), come back online; watch GETs.
- Expected (W04 AS-88 / map entry.offline.banner-clear-refetch): "open queries refetch once".
- Actual: `GET /shops/<id>/products?status=ACTIVE&limit=20` is sent twice (and `GET /shops/<id>` once) after the browser is back. Two triggers add up: `OfflineBanner` calls `invalidateQueries(seller.all())` and the query client has `refetchOnReconnect: true`.
- Evidence: test "entry.offline.banner-show ..." (entry-offline.spec.ts), soft check "refetches of .../products", both projects; a second offline period refetches again in the same way.

P3F6 [CONFIRMED] medium A write pressed while offline does nothing visible, then is sent by itself when the connection returns
- Steps: Team > Invitations, type an e-mail, go offline, press "Send invitation".
- Expected (W04 AS-88, map entry.offline.write-while-offline): the alert "Couldn't reach the server. Check your connection and try again." with the typed input kept.
- Actual: no request leaves, no message; the button turns busy and disabled (`aria-busy`, disabled) for as long as the browser is offline (React Query `networkMode: 'online'` pauses the mutation). When the network returns the invitation is sent on its own (POST 201), without another press. A person who gave up and reloaded might still send it later from another tab state; the text of the spec is never shown.
- Evidence: test "entry.offline.write-while-offline" (entry-offline.spec.ts) fails at the missing alert, both projects; probe: `busy true true` while offline, `POST .../invites` and `201` after going online.

P3F7 [CONFIRMED] low GET /shops/mine answers `validation_failed` for a bad limit or cursor, not `invalid_limit` / `invalid_cursor`
- Steps: `GET /api/shops/mine?limit=0` (also abc, -1, 101, 1.5) and `?cursor=garbage` (also %00, 400 characters).
- Expected (S03 B-04, map entry.api.shops-mine-paging): 400 with `invalid_limit` / `invalid_cursor`.
- Actual: 400 with code `validation_failed` in all eight cases (the DTO check runs before the service's own codes; those codes in `shop.service.ts` are never reached). Status is right. Same root as P1F1 (the page cannot tell a bad cursor from other errors).
- Evidence: test "entry.api.shops-mine-paging ..." (entry-api.spec.ts), soft checks, both projects.

P3F8 [SUSPICIOUS] low A malformed percent-encoding in the address gives the bare "400 Bad Request." page, not the shop not-found page
- Steps: open /dashboard/seller/%E0%A4%A or /dashboard/seller/%E0%A4%A/inventory.
- Expected (W04 R-04, map entry.misc.invalid-percent-path): no 500 and the same not-found page. No 500 holds (HTTP 400).
- Actual: a plain page "400 / Bad Request." with no site frame and no way back; produced by the framework before the app runs, so it may be unavoidable. `<uuid>%00` gives the normal not-found page (200).
- Evidence: soft check in "entry.misc.invalid-percent-path ..." (entry-misc.spec.ts).

P3F9 [CONFIRMED] low Seller pages do not have their own tab title, and no route announcement is made when moving between them
- Steps: open Inventory, Orders, Team, Usage, Request logs, Campaigns, Help documents of a shop and read `document.title`; click from Overview to Inventory in the menu and read Next's route announcer.
- Expected (map entry.misc.title-focus-on-navigation, W04 R-24): a distinct title per page; the new page is announced.
- Actual: only Overview ("Overview · Marketplace") and Payouts ("Payouts") have their own title; the other seven all read "Seller dashboard · Marketplace" (so tabs and history look alike). The route announcer region stays empty after the client navigation. Each page has exactly one h1 and focus lands on `main` (fine).
- Evidence: test "entry.misc.title-focus-on-navigation" (entry-misc.spec.ts), two soft failures, both projects.

P3F10 [CONFIRMED, same as P1F2 / register B-023] medium Sign-in return loses the section and query of a deep link
- Re-checked twice more: a signed-out visit to /dashboard/seller/<id>/orders?status=PAID&page=2 returns to the shop root after sign-in; a cleared cookie plus a click on the Inventory entry gives returnTo of the shop root, not of /inventory. The two-step code step does keep a returnTo it was given (/login?returnTo=<full path> then code lands on the full path).
- Evidence: tests "entry.auth.login-return" and "entry.auth.expired-cookie-on-navigation" (entry-misc.spec.ts), soft checks.

## Not bugs, map corrections found while testing
- `entry.banner.deleted-status`: not reachable. The database refuses any status except ACTIVE, SUSPENDED, DELETING, DELETED (check constraint) and a DELETED shop is shown as "We couldn't find that shop." with no banner. The closing words for DELETED exist only in the unit test (`shop-status-banner.test.tsx`). Marked n/a.
- `entry.api.legacy-seller-shop`: `ensureShopsForLegacySellers` is called only by the product and chat backfill jobs (no route, no screen, no dev hook); the stack has no `seller-` shop. Blocked.
- `entry.rbac.missing-permissions-grants-nothing`: the shop answer is read on the server during the page render; a test browser cannot change it. Blocked (the unit test of `shopCan` covers the rule).
- Entry counts: OWNER and ADMIN 18 entries plus 2 account links, STAFF 11 + 2, VIEWER 9 + 2 (map text said STAFF also sees Team, Import, Order export, Campaigns, Help documents, Request logs, Usage, API docs: that is the 11).
- A session whose role claim is not SELLER (fresh register) shows the whole menu; the claim is `USER` for a new account (map says BUYER).
- A suspended shop's write controls are disabled with the words (Add product, Create key, Add endpoint, Start import, Start export, Add site, Add document, Create campaign, Send invitation; Connect Shopify/WooCommerce use `title` plus a paragraph). API: 403 `shop_suspended` / 409 `shop_offboarding`, reads stay 200; for a VIEWER the permission check (403 `permission_denied`) comes before the status gate, for a stranger 404 comes first.
- The switcher does refresh with the page: a shop opened while a page is open shows after a reload only (as the map says).
- Dev stack only: the Next dev overlay can sit over "Open menu"; specs use `clickThroughDevOverlay`.
- Blocked lines retried: `entry.index.error-boundary` now passes (entry-retry.spec.ts; an unreadable stored plan makes the picker fail the same way a failed list read does, the API itself answers 200, so a real 5xx was not produced). Still blocked: `entry.form.error-rate-limit` (a real 429 needs the 6th creation from a non-allow-listed address; this stack allow-lists 127.0.0.1 and ignores X-Forwarded-For: 7 creations in a row all gave 201), `entry.index.session-expired-401`, `entry.frame.401-on-shop-read`, `entry.frame.403-as-404` (server-side reads; need an expired token or a 403 from the API, which means moving the API clock or changing the stack), `entry.rbac.missing-permissions-grants-nothing`, `entry.api.legacy-seller-shop`.
- `entry.rbac.x-shop-id-mismatch` is API only: the web server's route to the API does not forward an X-Shop-Id sent by the browser (answer 200), so the 400 `shop_mismatch` is reachable by API only. status.mjs still lints that one line ("pass without ui").
- The two lines flagged by status.mjs (`entry.form.api-name-limits`, `entry.form.api-unknown-shop-id`) now have a UI check each (entry-misc.spec.ts) and are `pass` with ui,api(,db).
- Test-data left on the dev stack: shops/users named "Aiqa ...", "E2E Shop ...", `aiqa-*` handles, one throwaway user with 7 shops (`rl-*@example.com`, rate-limit probe), shop `aiqa-lim-81-*` with an 80-letter name from an early run of entry-misc.
