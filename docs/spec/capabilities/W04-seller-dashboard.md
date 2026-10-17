---
id: W04
title: Seller dashboard (shop entry and switcher, live overview, inventory, API keys, webhooks, API version, request logs, usage, team, invitations, orders)
kind: capability
status: draft
generated_at: 5d63da2a
depends_on: [S03, S05, S40, S42, S43, S48, S51, W01, W02, W03, W07]
concepts: [tenant-shop-rbac, realtime-topic-stream, bff-aggregate, problem-json-errors, idempotency-key, rate-limit-policy]
models: []
scope:
  - packages/web/app/dashboard/seller/**
  - packages/web/components/seller/**
  - packages/web/lib/seller/**
---
# W04 - Seller dashboard
## Purpose
A member opens a shop and runs it from one place. The member sees how it sells now and over a period, keeps products and stock right, gives programs access with API keys and webhooks, and keeps the team in order. Every screen works at phone and desktop width, from the keyboard, and in every state a member can reach: loading, empty, error, partial, forbidden, read-only and offline. The business rules belong to the backend capabilities; this capability shows them and handles their refusals.

## Entry points
- `/dashboard/seller`: open-shop form for a member without a shop, a redirect for one shop, a picker for several.
- `/dashboard/seller/{shopId}`: overview with the live panel, "Today (UTC)", period tiles, rank, daily chart and top products; `?days=` takes 7, 30 or 90.
- `/dashboard/seller/{shopId}/inventory`: product list with `q`, `status`, `inStock` and `cursor`.
- `/dashboard/seller/{shopId}/orders`: the shop's order slices without buyer identity.
- `/dashboard/seller/{shopId}/team`: members, invitations and the roles matrix; `tab`, `status` and `cursor` in the address.
- `/dashboard/seller/{shopId}/developers/api-keys`, `…/webhooks`, `…/webhooks/{endpointId}`, `…/api-version`, `…/logs` and `…/usage`.
- `/invites/{token}`: the page the invitation e-mail links to.
- `/dashboard` redirects permanently to `/dashboard/seller`; `/dashboard/settings` redirects to `/account/security`.
- Live topic `shop:{shopId}:live`, event `dashboard`, on the page's single stream of {{cap:W03}}.

## Rules
- **W04.R-01** The UI MUST offer a control only when the shop answer lists its permission in `myPermissions`; a missing `myPermissions` MUST grant nothing, and the platform role claim MUST NOT be read. [proof: W04 AS-42] [code: packages/web/lib/seller/permissions.ts#shopCan]
- **W04.R-02** API keys and API version MUST need `shop.manage`, webhooks MUST need `webhooks.manage`, request logs and usage MUST need `shop.read`, inventory MUST need `products.read`, orders MUST need `orders.read`, and the invitations tab MUST need `members.manage`. [proof: W04 AS-54] [code: packages/web/lib/seller/permissions.ts#pageRequires]
- **W04.R-03** A suspended or closing shop MUST disable every write control with the banner text as its reason, and MUST still allow every read. [proof: W04 AS-86] [code: packages/web/components/seller/shop-status-banner.tsx#ShopStatusBanner]
- **W04.R-04** A shop id that is not a UUID MUST get the same not-found answer as an unknown or foreign shop, and MUST NOT reach the API. [proof: W04 AS-85] [code: packages/web/lib/server/seller.server.ts#readShop]
- **W04.R-05** A typed price MUST become minor units by string parsing, accepting a comma or a point and at most the currency's fraction digits, and MUST NOT pass through floating-point arithmetic. [proof: W04 AS-35] [code: packages/web/lib/seller/money-input.ts#parseMoneyInput]
- **W04.R-06** The platform currency MUST come from the server variable `PLATFORM_CURRENCY` (an ISO 4217 code, fraction digits from `Intl`), and the API base URL shown to sellers MUST come from `PUBLIC_API_BASE_URL`, or read `https://<your-api-host>` when unset. [proof: W04 AS-35, W04 AS-55] [code: packages/web/lib/config-parse.ts#parseConfig]
- **W04.R-07** Money MUST be formatted from integer minor units and the currency of the same response, and no screen may default to a currency. [proof: none]
- **W04.R-08** The stock status MUST read "Out of stock" at 0, "Low stock" from 1 to 5, "In stock" above 5, and "Archived" for an archived product whatever its quantity. [proof: W04 AS-39] [code: packages/web/lib/seller/stock.ts#stockStatus]
- **W04.R-09** The overview period MUST be 7, 30 or 90 days in `?days=`; 30 is the default and is not written, and an unsupported value MUST become 30. [proof: W04 AS-12] [code: packages/web/lib/seller/search-params.ts#readDays]
- **W04.R-10** Filters, search text, tab and cursor MUST live in the address; a default MUST be left out and an unsupported value MUST become its default. [proof: W04 AS-29] [code: packages/web/lib/seller/search-params.ts#readInventoryParams]
- **W04.R-11** Server data MUST be read with TanStack Query under `queryKeys.seller`, and a mutation MUST invalidate the whole section by `queryKeys.seller.scope(shopId, section)`. [proof: W04 AS-92] [code: packages/web/lib/query-keys.ts#queryKeys]
- **W04.R-12** Network calls MUST use relative same-origin paths with the CSRF header on every write and without an `Authorization` header, and every response MUST be parsed with its contract schema. [proof: W04 AS-93] [code: packages/web/lib/api/seller.ts#fetchShop]
- **W04.R-13** The visible form of a problem MUST be chosen by the stable `code`; the server's `title` and `detail` MUST NOT be shown, except the `detail` of `endpoint_url_rejected`. [proof: W04 AS-89] [code: packages/web/lib/seller/problem-copy.ts#sellerProblemCopy]
- **W04.R-14** A `429` MUST show a countdown from `Retry-After` and disable the causing control until it ends, announcing only the start and the end. [proof: W04 AS-90] [code: packages/web/lib/seller/countdown.ts#useCountdown]
- **W04.R-15** A secret MUST live only in the open reveal dialog: not in a cache, the address, storage or the console. Escape and a click outside MUST NOT close it, and "Done" before a copy MUST ask once. [proof: W04 AS-46] [code: packages/web/components/seller/secret-reveal-dialog.tsx#RevealSecretDialog]
- **W04.R-16** A secret-bearing mutation MUST hand the secret to its caller once and MUST return the record without it. [proof: W04 AS-46] [code: packages/web/lib/api/seller-developers.ts#useCreateKey]
- **W04.R-17** After "Copy" the button MUST read "Copied" for 2 seconds with the status "Copied to clipboard"; when the clipboard is denied the secret MUST be selected with the hint "Press Ctrl+C (⌘C on Mac) to copy." [proof: W04 AS-47]
- **W04.R-18** The page MUST hold at most one stream: a topic is added to the shared connection, swapped when the shop changes, and released when the page ends. [proof: W04 AS-25] [code: packages/web/lib/realtime/user-stream.ts#subscribeTopic]
- **W04.R-19** A final refusal of the stream MUST refresh the session once and recreate the stream; a second refusal without an open in between MUST run the session-ended flow of {{cap:W01}}. [proof: W04 AS-22]
- **W04.R-20** A `resync`, or a reconnect after an error, MUST reach the topic's handler so the page re-reads; `revoked` MUST drop that topic only. [proof: W04 AS-21]
- **W04.R-21** A live frame MUST be checked with `liveDashboardFrameSchema` and a frame that fails the check MUST be dropped. [proof: W04 AS-19] [code: packages/web/lib/realtime/user-stream.ts#parseLiveFrame]
- **W04.R-22** Live values MUST NOT be announced every second; only a change of connection state MUST be announced, once. [proof: none]
- **W04.R-23** A destructive or secret-changing action MUST use an accessible confirmation with focus on "Cancel" first, and a double press MUST send one request. [proof: W04 AS-53] [code: packages/web/components/seller/confirm-dialog.tsx#ConfirmDialog]
- **W04.R-24** A dialog MUST move focus inside on open and return it to the opening control on close; a row menu trigger MUST be named after its row. [proof: W04 AS-94] [code: packages/web/components/seller/row-menu.tsx#RowMenu]
- **W04.R-25** A table MUST have a caption, column headers with `scope="col"` and a row header; at 640 px and below the same DOM MUST become cards. [proof: W04 AS-95] [code: packages/web/components/seller/responsive-table.tsx#ResponsiveTable]
- **W04.R-26** While a list loads its next view the previous rows MUST stay, dimmed with `aria-busy="true"`, and an empty table MUST NOT flash. [proof: W04 AS-31]
- **W04.R-27** Every page MUST show a skeleton shaped like its layout, never a spinner and never the word "Loading...". [proof: W04 AS-91] [code: packages/web/components/seller/page-skeletons.tsx#OverviewSkeleton]
- **W04.R-28** Text typed by a seller (shop, product, key and member names, URLs, event bodies) MUST be rendered as text. [proof: W04 AS-43]
- **W04.R-29** A product edit, a stock change, an archive and a restore MUST send `expectedVersion` from the version the seller saw. [proof: W04 AS-36] [code: packages/web/lib/api/seller-products.ts#updateProduct]
- **W04.R-30** A webhook replay MUST send an `Idempotency-Key` created when the event panel opened and reused for retries of the same intent. [proof: W04 AS-67] [code: packages/web/lib/api/seller-developers.ts#useReplayEvent]
- **W04.R-31** The invitation link and token MUST NOT be shown to the inviting member, and a token MUST NOT appear in logs, analytics or the address after an accept. [proof: W04 AS-77]
- **W04.R-32** The shop switcher MUST list the first 50 shops of the member and keep the current section when the member switches. [proof: W04 AS-09]
- **W04.R-33** The overview MUST render each optional section on its own: a section that failed shows its message and "Try again" while the others stay. [proof: W04 AS-17]
- **W04.R-34** The period and "today" queries MUST be invalidated at most once every 30 seconds while frames show new orders, and the stream MUST close while the tab is hidden. [proof: none]

## Behaviors
- **W04.B-01** Given a member without a shop, when they open `/dashboard/seller`, then the page reads "Open your shop" with "Shop name" and "Handle", and the handle follows the name until the member edits it. [proof: none]
- **W04.B-02** Given a valid name and handle, when the member presses "Open shop" twice, then one request is sent, the browser goes to the new overview, and the session role is refreshed in the background up to 3 times. [proof: none]
- **W04.B-03** Given `409 slug_taken` or `422 slug_reserved`, then the message appears under "Handle"; given `409 shop_limit_reached` or `429`, then an alert appears above the button. [proof: none]
- **W04.B-04** Given a member of one shop, when they open `/dashboard/seller`, then the server redirects to that shop; given several, then a picker lists name, handle, role and a status badge. [proof: W04 AS-08]
- **W04.B-05** Given paid orders, when the member opens the overview, then it shows the header, the live panel, "Today (UTC)", the period tiles, the rank, the daily chart and the top products in that order. [proof: none]
- **W04.B-06** Given a new shop, then the tiles show zero in the shop currency, "Today (UTC)" reads "No orders yet today.", and the rank reads "Not ranked yet. Your shop appears on the leaderboard after its first paid order." [proof: none]
- **W04.B-07** Given an order is paid, then within 2 seconds the live panel's orders and revenue increase and its status reads "Live". [proof: W04 AS-19]
- **W04.B-08** Given the connection drops or no frame arrives for 5 seconds, then the status reads "Reconnecting…", the numbers dim with "Last updated {hh:mm:ss}", and they never show as live. [proof: W04 AS-21]
- **W04.B-09** Given the stream is refused twice, then the panel says "Live numbers aren't available right now. Showing today's totals." and "Today (UTC)" refetches every 30 seconds while the tab is visible. [proof: W04 AS-22]
- **W04.B-10** Given 45 products and a page size of 20, when the member opens the inventory, then the table shows 20 rows with a "Next page" link carrying `?cursor=`. [proof: W04 AS-28]
- **W04.B-11** Given the search text "ceramc mug", then after 300 ms the address carries `q=ceramc mug` without a new history entry, and the status tabs are disabled with the hint "Search covers all products." [proof: W04 AS-30]
- **W04.B-12** Given the "Add product" dialog with a title, brand, category, price and stock, when the member presses "Create product", then the dialog closes, the toast "Product created" shows, and the product is the first row. [proof: W04 AS-33]
- **W04.B-13** Given `409 version_conflict` on an edit, then the dialog says "This product changed since you opened it." with "Load latest", and nothing is overwritten. [proof: none]
- **W04.B-14** Given `409 product_archived` or `409 invalid_transition`, then an alert says "This product was archived or restored elsewhere. The list has been refreshed." and the list refetches. [proof: W04 AS-41]
- **W04.B-15** Given a `VIEWER`, then the inventory has no action menu and no "Add product" button. [proof: W04 AS-42]
- **W04.B-16** Given the API keys page, then the table lists each key as `sk_test_{prefix}…` or `sk_live_{prefix}…` with scopes, status, expiry and last use, and never the secret. [proof: W04 AS-44]
- **W04.B-17** Given the "Create key" dialog with a name and the default scope, when the member presses "Create key", then "Save your API key" shows the full key once with "Copy" and "Done". [proof: W04 AS-45]
- **W04.B-18** Given `403 mfa_required` on a live key, then the dialog says "Live keys need two-step verification." with a link to `/account/security?tab=two-step`, and the form values are kept. [proof: none]
- **W04.B-19** Given an active key, when the member rotates it with an overlap, then the new key shows once with "The old key keeps working until {date time}." [proof: W04 AS-51]
- **W04.B-20** Given an active key, when the member confirms "Revoke key", then one request is sent, the row reads "Revoked", and a toast "Key revoked" shows. [proof: W04 AS-53]
- **W04.B-21** Given the webhooks page, then each endpoint shows its full URL, up to 3 events, the API version and a status badge with the reason, the breaker state and the previous-secret end. [proof: none]
- **W04.B-22** Given the "Add endpoint" dialog, then the event choices come from the catalogue in the API's order, and a refusal of the URL appears under "Endpoint URL". [proof: W04 AS-58, W04 AS-59]
- **W04.B-23** Given an endpoint, when the member sends a test event, then the toast "Test event queued" shows and the delivery log refetches every 5 seconds for 30 seconds. [proof: W04 AS-64]
- **W04.B-24** Given the deliveries page, then the table lists attempts newest first, "Failed only" is `ok=false` in the address, and "View event" opens the stored body as text. [proof: none]
- **W04.B-25** Given the API version page, when the member confirms a pin, then the page shows the new pin and the toast "API version pinned"; a deprecated pin shows a warning. [proof: none]
- **W04.B-26** Given the request logs page, then the filters are in the address, the date range allows the last 30 days only, and a row's request ID can be copied. [proof: W04 AS-70, W04 AS-72]
- **W04.B-27** Given the usage page, then a table lists day, version, route, calls, errors and deprecated calls with a totals row, labelled UTC. [proof: W04 AS-73]
- **W04.B-28** Given the team page, then members show with "(you)" on the viewer, a role change shows "Role updated", and `409 last_owner` reads "A shop needs at least one owner." [proof: W04 AS-74, W04 AS-75]
- **W04.B-29** Given the Invitations tab, when an admin sends an invitation, then a pending row appears with "Invitation sent to {email}."; resend and revoke are offered on pending rows only. [proof: W04 AS-77]
- **W04.B-30** Given the Roles tab, then the matrix shows "Allowed" or "Not allowed" as text with an icon, and marks the member's own role "Your role". [proof: W04 AS-79]
- **W04.B-31** Given a signed-in member opens `/invites/{token}` and presses "Accept invitation", then one request is made and the browser goes to the shop replacing the history entry; every refusal reads the same. [proof: none]
- **W04.B-32** Given the orders page, then the table lists reference, status, items, subtotal and date newest first, with no buyer identifier. [proof: W04 AS-83]
- **W04.B-33** Given a signed-out visitor opens any seller URL, then the server redirects to `/login?returnTo=` that path and query before any content is sent. [proof: none]
- **W04.B-34** Given a `401` from any seller request, then the session-ended flow of {{cap:W01}} runs exactly once. [proof: W04 AS-87]
- **W04.B-35** Given the browser goes offline, then the banner "You're offline. Changes can't be saved." shows, and on reconnect the banner clears and the open queries refetch once. [proof: none]
- **W04.B-36** Given a `5xx` problem, then the alert shows a reference with a "Copy" button and no stack, SQL or upstream text; given `400 invalid_cursor`, then "That page link is no longer valid." offers "Go to the first page". [proof: W04 AS-89]
- **W04.B-37** Given any seller page at 390 px and 1280 px, then the sidebar becomes a drawer opened by "Open menu", the current page carries `aria-current="page"`, and nothing scrolls sideways. [proof: W04 AS-96, W04 AS-97]

## Lifecycles
No model is listed. The shop status `ACTIVE`, `SUSPENDED`, `DELETING` is S03's; this capability shows it and disables writes unless it is `ACTIVE`. Key status `active`, `rotating`, `expired`, `revoked` and endpoint status `enabled`, `disabled` are S42's and S43's.

## Owns
- Query keys `seller` in `lib/query-keys.ts`; the modules `lib/seller/*`, `lib/api/seller*.ts`, `lib/server/seller.server.ts` and `components/seller/*`.
- Reads the live stream topic `shop:{shopId}:live` ({{concept:realtime-topic-stream}}) and the overview aggregate ({{concept:bff-aggregate}}).
- Owns no database table, queue or topic.

## Decisions
- Seller entries depend on shop membership and `myPermissions`, never on the session role, which becomes `SELLER` eventually.
- Server data lives in TanStack Query, shareable view state in the address, and dialogs and drafts in local state; no new Context or store.
- A secret is handed to the dialog through a callback and stripped from the mutation result, so no cache keeps it.
- Failure forms are chosen by problem `code` ({{concept:problem-json-errors}}), never by `detail`.
- The request-log "429" status is asked as `4xx` and filtered on the client until S42 accepts it.

## Known gaps
- Proofs are added as each test file lands (names from `specs/web/W04-seller-dashboard/test-plan.md`). Behaviors and rules marked `[proof: none]` or naming only the foundation tests wait for these files:
  - `components/dashboard/dashboard-shell.test.tsx` (AS-84, AS-85, AS-86, AS-91, AS-98) and `components/seller/problem-states.test.tsx` (AS-87, AS-88, AS-89, AS-90).
  - `app/dashboard/seller/open-shop-form.test.tsx` (AS-02 to AS-07) and `components/seller/shop-switcher.test.tsx` (AS-08, AS-09).
  - `components/seller/overview/overview-view.test.tsx` (AS-10 to AS-18, AS-26) and `components/seller/overview/live-panel.test.tsx` (AS-19 to AS-27).
  - `components/seller/inventory/inventory-view.test.tsx` and `product-form.test.tsx` (AS-28 to AS-43, AS-94, AS-95).
  - `components/seller/developers/*-view.test.tsx` (AS-44 to AS-73) and `components/seller/team/team-view.test.tsx`, `app/invites/[token]/accept-invite.test.tsx` (AS-74 to AS-82).
  - `components/seller/orders/orders-view.test.tsx` (AS-83) and the Playwright files `tests/seller-*.spec.ts`, `tests/visual/seller-*.spec.ts` (AS-96 to AS-98).
- Several proofs above name unit tests of the foundations (permissions, money input, API modules, primitives); the screen-level assertion of the same scenario is added with the screen.
- Rules R-07 and R-22 have no test yet.
