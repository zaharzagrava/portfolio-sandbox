# Feature Specification: W04 — Seller dashboard: shop overview, live sales numbers, inventory, developer settings (API keys, webhooks, API version, logs, usage), team and orders (`packages/web`)

**Capability**: W04 · **Area**: web (`packages/web`, Next.js 16, App Router, Cache Components on) · **Spec directory**: `specs/web/W04-seller-dashboard`

**Feature Branch**: `W04-seller-dashboard` (spec directory only; no branch was created)

**Created**: 2026-10-07

**Status**: Draft

**Input**: "Seller dashboard: shop overview, live sales numbers, inventory management, developer settings (API keys, webhook endpoints) (the Next.js app in `packages/web`)". Sources: constitution V, VI, VII.7; `packages/web/AGENTS.md` and the Next.js guides *Authentication with Cache Components* and `instant`; `docs/architecture/pattern-map.md` (rows naming W04: P0406, P0901); backend specs S03, S05, S40, S42, S43 (and S10, S32, S48, S51 where they define a shape W04 consumes); the specs already written for W01, W02, W03; the current draft in `app/dashboard/seller`.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged, BREAKING first), [`test-plan.md`](test-plan.md) (one row per scenario), [`gaps.md`](gaps.md) (what today's code lacks, missing backend endpoints, test tooling), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

A member opens a shop, then runs it from one place: sees how it is selling right now and over a period, keeps its products and stock correct, gives programs access to its data with API keys and webhooks, and keeps its team in order. Every screen works at phone and desktop width, from the keyboard, and in every state a member can reach (loading, empty, error, partial data, forbidden, read-only, offline).

In scope (every screen and state):

- **Shop entry** (`/dashboard/seller`): the open-shop form, the picker for several shops, and the **shop switcher** in the sidebar.
- **Overview**: shop header, **live sales numbers** (last 60 seconds, pushed), "Today (UTC)", period summary, leaderboard rank, daily chart, top products.
- **Inventory**: list, filters, shop search, add, edit, stock adjustment, archive and restore.
- **Developer settings**: API keys (create, rotate, revoke, shown-once secret), webhook endpoints (add, edit, enable or disable, rotate secret, delete, test event) with their **delivery log**, event detail and replay, **API version** pin, **request logs** and **usage**.
- **Team**: members, role changes, removal and leaving, invitations, the roles matrix, and the **invitation landing page** `/invites/{token}` that S28's e-mail links to.
- **Seller orders**: the read-only list of the shop's order slices (W03 hands the seller-side list to W04).
- **The dashboard shell** (sidebar, mobile drawer, banners, guards, 404 and forbidden states) and the visible form of every error these screens can meet (constitution V.3).
- Layout at mobile (≤ 640 px) and desktop (≥ 1024 px), keyboard and screen-reader access, and the rendering and state rules of constitution VI for all of the above.

Out of scope (owners named):

- Sign-in, registration, sessions, two-step setup, account pages → **W01**. The session read and the session-ended flow are used, not owned.
- The buyer's cart, checkout and order history → **W03** (`/orders`). The buyer's "Overview" and "Recent orders" cards leave the dashboard (see `questions.md`).
- Storefront, product page, search → **W02**. The navbar, footer, skip link, global error and not-found pages, security headers → **W07**.
- Every business rule: roles and permissions, shop status machine, versioned product writes, sales arithmetic, key and secret lifecycle, webhook delivery and retries → **S03, S05, S40, S42, S43**. W04 shows and handles them and never re-implements them.
- **Seller screens that other specs assign to W04 but this release does not build** (each is a `[CONTRACT]` line in `questions.md`; their routes live under `/dashboard/seller/{shopId}/…` and they plug into the sidebar through the navigation registry in Cross-capability contracts): onboarding and verification wizard (S04), the collaborative product editor (S06), bulk import (S07) and order export (S12) with their live progress, marketplace integrations and conflict lists (S08, S09), balance, payouts and finance issues (S14, S15), photo gallery and video upload (S29, S30), sponsored-listing campaigns (S36), storefront widget sites (S44), the help-centre assistant panel (S47), single sign-on and offboarding settings (S03).
- A "stock left" figure on the overview: S40 says it is an R2 composition and no requirement here needs it.

## Screens and routes

Rendering: every page is a Server Component that reads the session on the server and streams its content behind a Suspense boundary (the sidebar frame and the skeletons are the static shell); interactive parts are client components below it (FR-001, FR-002).

| Route | Screen | Needs | URL state |
|---|---|---|---|
| `/dashboard` | permanent redirect to `/dashboard/seller` | — | — |
| `/dashboard/seller` | open-shop form (no shop), redirect (one shop), picker (several) | session | `cursor` (picker) |
| `/dashboard/seller/{shopId}` | Overview | member | `days` (7, 30, 90) |
| `/dashboard/seller/{shopId}/inventory` | Inventory | `products.read` | `q`, `status`, `inStock`, `cursor` |
| `/dashboard/seller/{shopId}/orders` | Seller orders | `orders.read` | `status`, `cursor` |
| `/dashboard/seller/{shopId}/team` | Team: members, invitations, roles | `members.read` (Invitations tab: `members.manage`) | `tab`, `status`, `cursor` |
| `/dashboard/seller/{shopId}/developers/api-keys` | API keys | `shop.manage` | `cursor` |
| `/dashboard/seller/{shopId}/developers/webhooks` | Webhook endpoints | `webhooks.manage` | `cursor` |
| `/dashboard/seller/{shopId}/developers/webhooks/{endpointId}` | Endpoint deliveries | `webhooks.manage` | `ok`, `event`, `cursor` |
| `/dashboard/seller/{shopId}/developers/api-version` | API version | `shop.manage` | — |
| `/dashboard/seller/{shopId}/developers/logs` | Request logs | `shop.read` | `requestId`, `status`, `route`, `keyId`, `livemode`, `from`, `to`, `cursor` |
| `/dashboard/seller/{shopId}/developers/usage` | Usage | `shop.read` | `days`, `livemode` |
| `/invites/{token}` | Accept an invitation | session | — |
| `/dashboard/seller/inventory` | redirect to the shop's inventory (like the index) | session | — |

`/dashboard/orders` is W03's redirect to `/orders`; `/dashboard/settings` redirects to W01's `/account/security`. An id in a path that is not a UUID is a not-found page (FR-011).

## Layout, keyboard and screen-reader access

Common frame (W07 provides the skip link and `<main>`; W04 provides the rest):

- **Desktop (≥ 1024 px)**: a persistent left sidebar (landmark `nav`, name "Seller") with the shop switcher on top, the groups **Shop** (Overview, Inventory, Orders, Team), **Developers** (API keys, Webhooks, API version, Request logs, Usage, API documentation) and **Account** (Orders → `/orders`, Account security → `/account/security`); the content area has a banner region (offline, suspended), one `h1`, then the page body.
- **Mobile (≤ 640 px)**: no sidebar. A top bar holds the button "Open menu", the shop name and the page name; the menu opens a drawer with exactly the sidebar's content, closes on choosing an entry or Escape, and returns focus to "Open menu". Between 641 and 1023 px the mobile frame is used with two-column grids where the desktop has four.
- **Focus order** is reading order: skip link → (menu button | sidebar) → banners → `h1` → primary action → filters → table or cards → pagination. After a route change focus lands on the new `h1`.
- Every page has exactly one `h1`; sections use `h2`; the current sidebar entry has `aria-current="page"`.

| Page | Desktop (≥ 1024 px) | Mobile (≤ 640 px) | Always reachable |
|---|---|---|---|
| Overview | header row (name, handle, plan, role, period select at the right); tiles four per row; live panel and "Today (UTC)" side by side; rank and top products side by side; chart full width | one column in the order of FR-017; tiles two per row; period select under the heading | period select, "Try again" of any failed section |
| Inventory | heading + "Add product" at the right; tabs and filters on one row; table | heading, then "Add product" full width; tabs scroll horizontally inside their own strip; filters in a "Filters" sheet; rows as cards | search box, "Add product", pagination links |
| API keys, Webhooks | heading + primary button; table; "Using the API" below (keys) | primary button full width; rows as cards with a menu button; "Using the API" as the first collapsed section | primary button, row menu |
| Endpoint deliveries | summary card above the table; event panel opens as a side panel | summary stacked; event panel is a full-height sheet | "Failed only" filter, "Send test event" |
| API version, Usage | one card / one table | one card / cards per row | the version buttons, period and mode controls |
| Request logs | filter bar above the table (one row) | "Filters" sheet; rows as cards | "Apply", "Clear filters", Request ID field |
| Team | tabs, table | tabs scroll in their strip; rows as cards | "Invite" button on the Invitations tab |
| Orders | filter + table | filter select + cards | status filter |
| Open-shop form, invitation page | centred card, max 32 rem | full-width card | the submit button |

Dialogs are centred cards on desktop and full-height sheets on mobile; their buttons are in the same order (cancel, then primary) and stay visible without scrolling the page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Open a shop, switch between shops (Priority: P1)

A member with no shop opens one and lands on its dashboard; a member of several shops picks one or switches from the sidebar and keeps the section they were in.

**Why this priority**: nothing else is reachable without a shop.

**Independent Test**: sign in as a new member, open a shop, reload, open a second shop, switch.

**Acceptance Scenarios**:

- **AS-01** (A member with no shop is offered the open-shop form) — **Given** a signed-in member with no shop membership, **When** they open `/dashboard/seller`, **Then** the page heading is "Open your shop", the form has the fields "Shop name" and "Handle" and the button "Open shop", and the sidebar shows "Start selling" and no seller entries.
- **AS-02** (The handle follows the name until the member edits it) — **Given** the form, **When** the member types "Clay Works & Co" in "Shop name" and has not touched "Handle", **Then** "Handle" shows `clay-works-co`; **When** they edit "Handle", **Then** later name edits no longer change it; a handle outside 3 to 40 lowercase letters, digits and inner dashes shows "Use 3 to 40 lowercase letters, digits or dashes." under the field when the field loses focus or the form is submitted, never while typing.
- **AS-03** (Opening the shop lands on its overview) — **Given** a valid name and handle, **When** the member presses "Open shop", **Then** the button shows "Opening…" and is disabled, the request succeeds, the browser goes to `/dashboard/seller/{shopId}`, the heading is the shop name, a status message "Your shop is open" is announced once, and the sidebar now shows the seller entries.
- **AS-04** (Seller tools do not wait for the platform role to catch up) — **Given** the shop was just created and the session still says role `USER` (the promotion is eventual, S03 consistency model), **When** the overview opens, **Then** seller entries and every shop page work because they depend on shop membership, and the app asks W01's `useRefreshSession()` up to 3 times (after 1 s, 2 s, 4 s) until the role shows `SELLER`, then stops without any visible message.
- **AS-05** (Field-level problems appear under the field) — **Given** the form, **When** the API answers `400 validation_failed` with `errors[]`, `409 slug_taken` or `422 slug_reserved`, **Then** the message appears under "Shop name" or "Handle" (for example "That handle is taken. Try another."), the field is marked invalid and gets focus (the first one if several), the typed values stay, and nothing is lost.
- **AS-06** (Form-level problems appear above the button) — **Given** the form, **When** the API answers `409 shop_limit_reached`, `429 rate_limited` or a `5xx`, **Then** an alert above the button says "You already own 10 shops.", "Too many attempts. Try again in {n} s." (the button re-enables when the countdown ends) or the generic server message with its reference (FR-043).
- **AS-07** (Pressing the button twice opens one shop) — **Given** the form is valid, **When** the member presses "Open shop" twice quickly, or presses Enter in a field while the first request runs, **Then** exactly one request is sent.
- **AS-08** (One shop: the index goes straight to it) — **Given** a member of exactly one shop, **When** they open `/dashboard/seller`, **Then** the server redirects to `/dashboard/seller/{shopId}` with no intermediate screen; the legacy `/dashboard/seller/inventory` redirects to `/dashboard/seller/{shopId}/inventory` the same way.
- **AS-09** (Several shops: pick one and switch while keeping the section) — **Given** a member of three shops, **When** they open `/dashboard/seller`, **Then** a list shows each shop's name, handle, their role and a status badge when the shop is not active, and choosing one opens its overview; **When** they use the shop switcher in the sidebar while on "Inventory", **Then** they land on the other shop's "Inventory" and the switcher shows that shop as current.

### User Story 2 — See how the shop is selling, live (Priority: P1)

The overview answers "how is my shop doing" with numbers that move while the member watches, and stays honest when part of the data is missing or the live connection is not available.

**Why this priority**: the first thing a seller looks at, and the showcase of push instead of poll (P0406).

**Independent Test**: open the overview of a shop, pay an order of that shop, watch the live panel change; take the stats section down and see only that section fail.

**Acceptance Scenarios**:

- **AS-10** (The overview answers "how is my shop doing" in one screen) — **Given** a shop with paid orders, **When** the member opens `/dashboard/seller/{shopId}`, **Then** the page shows, in this order: the shop name as the heading with handle, plan and "Your role"; the live panel; "Today (UTC)"; the period summary tiles for the selected period; the leaderboard rank; the daily revenue chart; "Top products".
- **AS-11** (Money is shown in the shop's currency, with refunds and net separate) — **Given** stats with `currency` "EUR", **When** the tiles render, **Then** every amount is formatted from its minor-unit value and the response currency (no default currency); the tiles are "Revenue", "Net revenue", "Refunded" (count and amount), "Orders", "Units sold", "Unique buyers", "Average order value"; `uniqueBuyers` above 1,000 shows a leading "≈".
- **AS-12** (The period choice lives in the URL) — **Given** the overview, **When** the member picks "Last 7 days", "Last 30 days" or "Last 90 days", **Then** the URL gets `?days=7` or `?days=90` (30 is the default and is not written), the tiles, chart and top products refetch with that period, a loading indicator shows only on those sections, and browser Back restores the previous period; an unsupported `days` value in the URL is replaced by 30.
- **AS-13** (Top products show titles, not ids) — **Given** stats with `topProducts`, **When** the section renders, **Then** it lists up to 5 rows "{title} — {units} sold — {revenue}" in the order returned, titles are plain text, and an empty list shows "No sales in this period yet."
- **AS-14** (The daily chart has a table alternative) — **Given** `daily` entries (one per day, zero-filled), **When** the chart renders, **Then** it has an accessible name "Revenue per day, last {n} days", a text summary ("Best day: {date}, {amount}"), and a "View as table" toggle that swaps in a table with the columns Day, Revenue, Orders, Refunded; the toggle state is not in the URL.
- **AS-15** (A new shop sees honest empty states) — **Given** a shop with no paid orders, **When** the overview opens, **Then** all tiles show 0 (money as zero in the shop currency), "Today (UTC)" shows "No orders yet today.", the rank card shows "Not ranked yet. Your shop appears on the leaderboard after its first paid order." (from `404 not_ranked`, not as an error), and the chart shows a flat zero series.
- **AS-16** (The rank card reads like a sentence) — **Given** a rank answer `{period, category: null, rank: 3, of: 120, topPercent: 3, revenueMinor}`, **When** the card renders, **Then** it reads "#3 of 120 shops · top 3 % this week" ("this month" for a month period; "in {category}" when a category is set).
- **AS-17** (One failing section does not blank the page) — **Given** the overview answer lists `errors: [{section: 'stats'}]`, **When** the page renders, **Then** the tiles, chart and top products sections each show "Sales numbers are temporarily unavailable." with a "Try again" button that refetches only the failed sections, while the header, live panel, today and rank still render; the same holds for `today` and `rank`.
- **AS-18** (The shop itself failing is a page-level state) — **Given** the shop section fails with `503`, **When** the page loads, **Then** the page shows the problem alert with "Try again" and no other section; **Given** `404 shop_not_found`, **Then** the not-found page of FR-011 shows.
- **AS-19** (Live numbers move when a purchase is paid) — **Given** the overview is open, **When** an order of the shop is paid, **Then** within 2 seconds the live panel's "Orders" and "Revenue" (last 60 seconds) increase without a reload, and the panel's status reads "Live".
- **AS-20** (Checkout conversion is shown only when it exists) — **Given** a frame with `checkoutConversion: null`, **Then** the tile shows "—"; **Given** `1.5`, **Then** it shows "150 %" (it may exceed 100 %, S40 assumption) with the hint "orders ÷ checkouts, last 60 s".
- **AS-21** (A dropped connection never shows old numbers as live) — **Given** the panel is live, **When** the connection drops (or no frame arrives for 5 seconds), **Then** the status changes to "Reconnecting…" (announced politely once), the numbers dim and show "Last updated {hh:mm:ss}", and when frames resume the status returns to "Live"; **When** a `resync` event arrives, **Then** "Today (UTC)" and the period sections refetch; **When** a `revoked` event arrives, **Then** the panel recreates its subscription once after one session check, and if the member is no longer admitted shows the state of the next scenario.
- **AS-22** (A refused stream falls back to polling) — **Given** the stream is refused (`401`/`403`), **When** the app has refreshed the session once and the second attempt is also refused, **Then** the panel shows "Live numbers aren't available right now. Showing today's totals.", stops retrying, and refetches "Today (UTC)" every 30 seconds while the tab is visible.
- **AS-23** (A hidden tab does not hold a connection) — **Given** the panel is live, **When** the tab becomes hidden, **Then** the stream closes; **When** it becomes visible again, **Then** the stream opens and the page sections refetch once.
- **AS-24** (Live activity refreshes the period numbers, at most every 30 seconds) — **Given** frames show new orders, **When** frames keep arriving, **Then** the "today" and period queries are invalidated at most once per 30 seconds, never once per frame.
- **AS-25** (One stream per page, swapped when the shop changes) — **Given** the overview, **Then** exactly one `EventSource` exists for the page, subscribed to `shop:{shopId}:live` through the shared page stream; **When** the member switches shop, **Then** the topic is swapped on the same connection (never two connections); **When** they leave the page, **Then** the subscription is released.
- **AS-26** ("Today (UTC)" shows totals and a per-minute series) — **Given** `dashboard/today`, **When** the panel renders, **Then** it shows Orders, Units and Revenue for the UTC day, a per-minute bar series with an accessible text alternative ("{n} orders today, busiest minute {hh:mm} UTC"), and the label makes clear the day is UTC.
- **AS-27** (Live values are not read aloud every second) — **Given** frames arriving every second, **Then** the live values are in a region with `aria-live="off"`; only connection-state changes ("Live", "Reconnecting…") use a polite status region, at most one announcement per change; the 60-second sparkline has the text alternative "{n} orders in the last 60 seconds".

### User Story 3 — Manage inventory (Priority: P1)

The member finds products, adds, edits, restocks, archives and restores them, and is never allowed to overwrite a newer version unknowingly.

**Why this priority**: listing and stock are the core seller task (S05 SC-008).

**Independent Test**: add a product, find it with a typo, edit its stock, archive and restore it.

**Acceptance Scenarios**:

- **AS-28** (The inventory lists the shop's active products page by page) — **Given** a shop with 45 products and page size 20, **When** the member opens `/dashboard/seller/{shopId}/inventory`, **Then** a table with the caption "Products of {shop name}" and the columns Name, Price, Stock, Status shows 20 active products in the order returned, a "Next page" link carries `?cursor=…`, and on that page a "First page" link appears; Back returns to the previous page.
- **AS-29** (Status and stock filters live in the URL) — **Given** the inventory, **When** the member selects the "Archived" tab or "Out of stock" in the stock filter, **Then** the URL carries `status=ARCHIVED` and/or `inStock=false` (defaults `ACTIVE` and "All" are not written), the cursor is dropped, and the list shows only matching products; the tabs are a real tab list with arrow-key navigation.
- **AS-30** (Search finds a product despite a typo) — **Given** a product "Handmade Ceramic Mug", **When** the member types "ceramc mug" into "Search your products", **Then** after 300 ms of silence the URL carries `q=ceramc mug` (replacing, not adding, a history entry), the list shows that product (with its Active/Archived status), and the status tabs and stock filter are disabled with the hint "Search covers all products." plus "Search results can take a few seconds to include new products."; clearing the box restores the filtered list.
- **AS-31** (Loading and refetching never flash an empty table) — **Given** the inventory, **Then** first load shows skeleton rows in the table layout; **When** the search text or a filter changes, **Then** the previous rows stay (dimmed, `aria-busy="true"`) until the new rows arrive; a failed list shows the problem alert with "Try again" instead of an empty table.
- **AS-32** (Three empty states say different things) — **Given** a shop with no products, **Then** the table is replaced by "No products yet." with an "Add product" button (for members who can write); **Given** a search or filter with no match, **Then** "No products match “{q}”." with a "Clear search" button; **Given** the Archived tab with none, **Then** "No archived products."
- **AS-33** (Adding a product puts it in the list) — **Given** the "Add product" dialog, **When** the member fills Title, Brand, Category, Price and Stock and presses "Create product", **Then** the button shows "Creating…", the dialog closes, a toast "Product created" shows, the new product is the first row of the Active list, the dialog form is reset, and focus returns to "Add product".
- **AS-34** (The form catches what it can, the server decides the rest) — **Given** the dialog, **Then** the UI itself requires Title, Brand, Category and a price, accepts only a decimal price with at most the currency's fraction digits and a whole-number stock, and shows these under the field after the first submit attempt; **When** the API answers `400 validation_failed` with `errors[]`, **Then** each message appears under its field and the first gets focus; `422 currency_not_supported` shows an alert in the dialog; the dialog stays open with values kept.
- **AS-35** (Prices are typed in major units and sent in minor units, exactly) — **Given** the platform currency has 2 fraction digits, **When** the member types "24.50", "0.10" or "1,5", **Then** the request carries `priceMinor` 2450, 10 and (comma accepted as the decimal mark) 150 from string parsing, never from floating-point multiplication; "0.001", "abc" and "-1" are refused by the form; the label reads "Price ({currency code})".
- **AS-36** (Editing sends only what changed, against the version the seller saw) — **Given** a product row, **When** the member chooses "Edit" in its action menu, **Then** the dialog loads the product (a skeleton until it arrives), fields are prefilled, saving sends only changed fields with `expectedVersion` from that load, the row updates, a toast "Product updated" shows, and an unchanged form disables "Save changes".
- **AS-37** (A conflicting edit is never silently overwritten) — **Given** the edit dialog and `409 version_conflict`, **Then** the dialog shows "This product changed since you opened it." with a "Load latest" button; pressing it replaces the form values with the latest ones (the member's unsaved edits are dropped and the alert says so) and nothing is saved until they save again.
- **AS-38** (Stock can be adjusted from the row) — **Given** a row, **When** the member chooses "Adjust stock", enters a whole number from 0 and confirms, **Then** the row's stock updates and a toast "Stock updated" shows; on `409 version_conflict` (a sale changed the stock meanwhile) the popover shows "Stock changed to {n} while you were editing." and keeps the member's number for them to confirm again.
- **AS-39** (Stock status is a word, not only a colour) — **Given** quantities 0, 3, 5, 6, **Then** the Status column reads "Out of stock", "Low stock", "Low stock", "In stock" (threshold 5 or fewer, the same as webhook `product.stock_low`), "Archived" overrides them for archived products, and each badge text is in the cell.
- **AS-40** (Archive and restore) — **Given** an active product, **When** the member chooses "Archive" and confirms "Archive product" in the dialog ("It disappears from the storefront and search. You can restore it."), **Then** the row leaves the Active list, a toast "Product archived" shows; **When** they open the Archived tab and choose "Restore", **Then** it returns to Active with the toast "Product restored" (no confirmation needed).
- **AS-41** (Acting on a stale row is explained) — **Given** a list that is out of date, **When** an action returns `409 product_archived` or `409 invalid_transition`, **Then** an alert says "This product was archived or restored elsewhere. The list has been refreshed." and the list refetches; `404 product_not_found` says "This product no longer exists." and refetches.
- **AS-42** (Viewers read, staff write) — **Given** a `VIEWER`, **Then** the table has no action menu and there is no "Add product" button; **Given** `STAFF`, `ADMIN` or `OWNER`, **Then** they are present; the decision uses `myPermissions` containing `products.write`.
- **AS-43** (Seller-typed text is shown as text) — **Given** a product titled `<img src=x onerror=alert(1)>`, **Then** the cell shows that exact text and nothing executes.

### User Story 4 — Issue and control API keys (Priority: P1)

The member creates test and live keys, sees each secret exactly once, rotates with a stated overlap and revokes instantly.

**Why this priority**: keys are the only door to the public API (S42 US1).

**Independent Test**: create a test key, copy it, close, see only its prefix; rotate; revoke.

**Acceptance Scenarios**:

- **AS-44** (The key list shows identity, never the secret) — **Given** keys exist, **When** the member opens `/dashboard/seller/{shopId}/developers/api-keys`, **Then** a table with the columns Name, Key, Scopes, Status, Expires, Last used, Created lists each key with the prefix as `sk_test_{prefix}…` or `sk_live_{prefix}…`, a "Test" or "Live" badge, scopes as text, the status "Active", "Rotating until {date time}", "Expired" or "Revoked", and "Never" for no use; `lastUsedAt` is shown to the minute; with no keys the table is replaced by "No API keys yet. Create one to start calling the API."
- **AS-45** (Creating a test key shows the secret once) — **Given** the "Create key" dialog, **When** the member enters a name, keeps the default scope `products:read` and the default "Test mode", and presses "Create key", **Then** the dialog switches to "Save your API key" showing the full key, a "Copy" button and a "Done" button, and after "Done" the list shows the new key by prefix.
- **AS-46** (A secret exists only in the open dialog) — **Given** a created or rotated key (or a webhook secret), **Then** the secret is held only in the state of the open reveal dialog; it is never written to the query cache, the URL, any browser storage, the console or analytics; pressing Escape or clicking outside does not close the dialog; **When** the member presses "Done" without having used "Copy", **Then** an inline message "You haven't copied this key. It can't be shown again." appears with "Close anyway" and "Copy key"; after closing, navigating away or unmounting, the secret is gone.
- **AS-47** (Copying reports its result, with a fallback) — **Given** the reveal dialog, **When** "Copy" succeeds, **Then** the button reads "Copied" for 2 seconds and a status message "Copied to clipboard" is announced; **When** the clipboard is denied, **Then** the secret text is selected and the message "Press Ctrl+C (⌘C on Mac) to copy." shows.
- **AS-48** (The create form constrains what it can) — **Given** the dialog, **Then** Name is required and trimmed (the counter shows "{n}/60"), at least one scope must stay selected (the last one cannot be unchecked, with the hint "A key needs at least one scope."), the optional expiry date input only allows tomorrow through 365 days ahead, and "Live mode" is off by default with the explanation "Live keys act on real data."; server `validation_failed` messages appear under their fields.
- **AS-49** (A live key asks for a second step first) — **Given** the member's session has no second factor, **When** they create or rotate a live key and the API answers `403 mfa_required`, **Then** an alert in the dialog says "Live keys need two-step verification." with the link "Set up or verify two-step" to `/account/security?tab=two-step&returnTo=…` (back to this page); the form values are kept, and creating a test key still works.
- **AS-50** (The 25-key limit is explained) — **Given** `422 key_limit_reached`, **Then** the dialog alert says "You have 25 active keys. Revoke one to create another."
- **AS-51** (Rotating a key keeps the old one alive for a stated overlap) — **Given** an active key, **When** the member chooses "Rotate", picks the overlap ("Expire immediately", "1 hour", "24 hours" (default), "72 hours", "7 days") and confirms, **Then** the reveal dialog shows the new key and the sentence "The old key keeps working until {date time}." (from `previousExpiresAt`), and after "Done" the list shows the old key as "Rotating until {date time}" and a new row named "{name} (rotated)".
- **AS-52** (Illegal rotations are explained) — **Given** `409 key_revoked`, `key_expired` or `key_already_rotating`, **Then** the dialog alert says "This key is already revoked.", "This key has expired." or "This key is already being rotated.", and the list refetches.
- **AS-53** (Revoking is immediate and says so) — **Given** an active key, **When** the member chooses "Revoke" (focus starts on "Cancel") and confirms "Revoke key" ("Every request with this key will be refused right away. This can't be undone."), **Then** one request is sent even on a double press, the row shows "Revoked", loses its actions, and a toast "Key revoked" shows; revoking a rotating key does not change its successor's row.
- **AS-54** (Developer pages follow the member's permissions) — **Given** a table of (page, permission): API keys and API version need `shop.manage`; Webhooks need `webhooks.manage`; Request logs, Usage and Orders need `shop.read` or `orders.read`, **Then** the sidebar shows an item only when `myPermissions` allows it; opening a page directly without the permission (or when the API answers `403 permission_denied`) shows the panel of FR-011 and never the page's content.
- **AS-55** (The page tells the seller how to use a key) — **Given** the API keys page, **Then** a "Using the API" section shows the public API base URL, a request example `curl {base}/v1/products -H "Authorization: Bearer sk_test_…"` (a placeholder, never a real key), one sentence on test versus live keys, and a link "API documentation" to `/developers/docs`.

### User Story 5 — Register webhook endpoints and inspect deliveries (Priority: P1)

The member adds endpoints for the events they care about, keeps the signing secret safe, and can see, inspect and replay what was sent.

**Why this priority**: it is how a seller's systems hear about orders and stock.

**Independent Test**: add an endpoint, send a test event, find its delivery, open the event.

**Acceptance Scenarios**:

- **AS-56** (The endpoint list shows health at a glance) — **Given** endpoints, **When** the member opens `/dashboard/seller/{shopId}/developers/webhooks`, **Then** a table with the columns URL, Events, API version, Status, Created lists each endpoint with the full URL (wrapped, never cut without a way to read it), up to 3 event names plus "+{n} more", the version, and a status badge: "Enabled", "Disabled (paused by you)" or "Disabled automatically after repeated failures (since {date})"; "Retrying after failures" shows when the breaker is `open`, and "Old secret valid until {date time}" shows while a previous secret is active; empty: "No webhook endpoints yet. Add one to receive events."
- **AS-57** (Adding an endpoint reveals its signing secret once) — **Given** the "Add endpoint" dialog, **When** the member enters an https URL, keeps the default event and presses "Add endpoint", **Then** the reveal dialog "Webhook signing secret" shows the `whsec_…` secret once with "Copy" and "Done", and after "Done" the endpoint is in the list.
- **AS-58** (Event choices come from the catalogue) — **Given** the dialog, **Then** the event checkboxes are built from `GET webhook-event-types` (type, description, grouped by resource, in the API's order) and at least one must stay selected; an event type the app has never seen still shows by its name; if the catalogue cannot be loaded the form shows the problem alert with "Try again" and "Add endpoint" stays disabled; "API version" defaults to the shop's pinned version.
- **AS-59** (Every rejection of the URL is explained at the URL) — **Given** the dialog, **When** the API answers `422 endpoint_url_rejected`, `409 duplicate_endpoint_url` or `400 validation_failed`, **Then** the message appears under "Endpoint URL" (for the rejected URL, the API's `detail`; for a duplicate, "You already have an endpoint with this URL."); `422 endpoint_limit_reached` shows the alert "You have 20 endpoints, the maximum. Delete one to add another."; the form values are kept.
- **AS-60** (Editing changes URL, events or version) — **Given** an endpoint, **When** the member chooses "Edit", changes fields and saves, **Then** only changed fields are sent, the list updates, a toast "Endpoint updated" shows, and errors appear as in the add dialog.
- **AS-61** (Disabling and enabling an endpoint) — **Given** an enabled endpoint, **When** the member chooses "Disable", **Then** the status becomes "Disabled (paused by you)"; **Given** an automatically disabled endpoint, **When** they choose "Enable", **Then** a confirmation explains "Enabling clears the failure history and starts deliveries again." and, after confirming, the status becomes "Enabled"; `409 endpoint_state_conflict` shows "The endpoint was changed elsewhere. The list has been refreshed." and refetches; `422 endpoint_url_rejected` on enable shows the URL problem as an alert.
- **AS-62** (Rotating a secret, with an explicit overlap and early end) — **Given** an endpoint, **When** the member chooses "Rotate secret", picks "1 hour", "24 hours" (default), "48 hours" or "72 hours" and confirms, **Then** the reveal dialog shows the new secret once and the old secret shows as "Old secret valid until {date time}" with an "End old secret now" action (confirmation, then `expire-previous-secret`); `409 rotation_in_progress` says "A previous secret is still valid. End it first or wait." with the same action; `409 no_previous_secret` refetches silently.
- **AS-63** (Deleting an endpoint) — **Given** an endpoint, **When** the member chooses "Delete" and confirms "Delete endpoint" ("Pending deliveries are cancelled."), **Then** the row disappears and a toast "Endpoint deleted" shows; `404 webhook_endpoint_not_found` also removes the row with the message "This endpoint was already deleted."
- **AS-64** (A test event can be sent to one endpoint) — **Given** an endpoint, **When** the member chooses "Send test event", **Then** a toast "Test event queued" shows and, on the endpoint's page, a delivery of type `webhook.ping` appears in the list within a few seconds (the page refetches every 5 seconds for 30 seconds after a ping); `429 rate_limited` shows "Too many test events. Try again in {n} s."
- **AS-65** (The delivery log explains what happened) — **Given** `/dashboard/seller/{shopId}/developers/webhooks/{endpointId}`, **Then** the page shows the endpoint summary and a table with the columns Time, Event, Attempt, Result, Duration, Replay listing attempts newest first; "Result" is the HTTP status or the error word, with the response snippet in a details row (as text); the filter "Failed only" is `ok=false` in the URL; "Next page" uses `cursor`; empty: "No deliveries in the last 30 days."
- **AS-66** (One event can be inspected) — **Given** a delivery row, **When** the member opens "View event", **Then** a panel shows the event id, type, created time, state, attempt count and the stored body as formatted JSON in a text block (never as HTML); `404 webhook_event_not_found` shows "This event is older than 30 days or no longer available."
- **AS-67** (Replay is explicit and safe to repeat) — **Given** the event panel, **When** the member chooses "Replay" and confirms ("The same body is sent again, signed now."), **Then** one request goes out with an `Idempotency-Key` created when the panel opened (a retry of the same intent reuses it), a toast "Replay queued" shows; `409 endpoint_disabled` shows "Enable the endpoint first."; `409 idempotency_in_flight` shows "This replay is already being processed."; `429` shows the countdown message.

### User Story 6 — Pin the API version, read request logs and usage (Priority: P2)

The member chooses which version their integrations see, finds one request by its id, and sees how much each version and route is used.

**Why this priority**: operating an integration (S42 US4, US9).

**Independent Test**: pin an older version; search the logs for a request id; read usage.

**Acceptance Scenarios**:

- **AS-68** (The API version can be changed deliberately) — **Given** `/dashboard/seller/{shopId}/developers/api-version`, **Then** the page shows the pinned version and its pin date, the supported versions with status badges ("Latest", "Supported", "Deprecated until {sunset}"), and a "Pin this version" button on the others; **When** the member confirms the change ("New requests without a version header will use {version} within a few seconds."), **Then** the page shows the new pin and a toast "API version pinned".
- **AS-69** (A deprecated pin is a warning, a retired one a refusal) — **Given** the pinned version is deprecated, **Then** a warning at the top says "Version {v} is deprecated and stops working on {sunset}. Pin {latest} after testing."; **Given** `422 version_retired`, **Then** the dialog alert says "That version is retired and can't be pinned."; `400` shows the generic validation message.
- **AS-70** (Request logs can be searched and shared as a link) — **Given** `/dashboard/seller/{shopId}/developers/logs`, **When** the member sets filters Request ID, Status ("Any", "2xx", "4xx", "5xx", "429"), Route, Key, Mode (Live/Test) and a From/To range and presses "Apply", **Then** the URL carries them (`requestId`, `status`, `route`, `keyId`, `livemode`, `from`, `to`; defaults omitted), the table shows newest first with Time, Method, Route, Status, Duration, Version, Key, Mode, a "Deprecated" flag and the error code, "Next page" uses `cursor`, "Clear filters" resets, and opening the URL in another tab shows the same result.
- **AS-71** (The date range can't be wrong in the form) — **Given** the filters, **Then** the date inputs allow only the last 30 days and "To" cannot be earlier than "From"; a `400` from the API for a filter shows under that filter.
- **AS-72** (A log row can be copied into a support request) — **Given** a row, **When** the member opens it, **Then** the details show Request ID with a "Copy" button, the client request id when present and the error code, and never a body, header or secret; a search with no result, including another shop's request id, shows the same "No matching requests."
- **AS-73** (Usage per day, version and route) — **Given** `/dashboard/seller/{shopId}/developers/usage`, **When** the member picks the period (7, 14 or 30 days, `days` in the URL, default 30) and the mode (`livemode`, default Live), **Then** a table with Day, Version, Route, Calls, Errors (server errors), Deprecated calls and a totals row shows; rows with deprecated calls carry the text "Deprecated" beside the count; empty: "No API calls in this period."

### User Story 7 — Run the team and accept an invitation (Priority: P2)

Owners and admins manage members and invitations within the rules of S03; an invitee accepts from the e-mail link.

**Why this priority**: S28's invitation e-mails already point at `/invites/{token}`.

**Independent Test**: invite an e-mail, open the link as that person, accept, see the shop.

**Acceptance Scenarios**:

- **AS-74** (The team list shows who can do what) — **Given** `/dashboard/seller/{shopId}/team`, **Then** a table with the columns Member, Role, Joined, Source lists the members (the e-mail, or "Unknown member" when the API gives none, with "(you)" for the viewer), and the tab "Invitations" and the tab "Roles" are in the same page (`tab` in the URL).
- **AS-75** (Changing a role) — **Given** the actor may manage a row (S03 FR-021: owners any, admins staff and viewers), **When** they choose a new role from the row's role menu, **Then** the row updates and a toast "Role updated" shows; the menu is not offered where S03 FR-021 forbids it; `403 insufficient_role` shows "You can't change this member's role.", `409 last_owner` shows "A shop needs at least one owner.", `404 member_not_found` refetches.
- **AS-76** (Removing a member, or leaving) — **Given** a member row, **When** the actor confirms "Remove {email}", **Then** the row disappears with a toast "Member removed"; **When** the actor chooses "Leave shop" on their own row and confirms, **Then** they are taken to `/dashboard/seller` and the shop is gone from their list; `409 last_owner` shows the same message as above.
- **AS-77** (Inviting by e-mail) — **Given** the Invitations tab, **When** an admin or owner enters an e-mail and a role (Admin, Staff, Viewer; there is no Owner) and presses "Send invitation", **Then** a pending row appears with the e-mail, role and expiry and the status message "Invitation sent to {email}." shows; the invite link is never displayed; `409 seat_limit_reached` says "Your plan has no free seats.", `409 invite_pending` "An invitation is already pending for this address.", `409 already_member` "This person is already a member.", `429` the countdown message, `400` field messages.
- **AS-78** (Invitations can be resent and revoked) — **Given** a pending invitation, **When** the actor chooses "Resend", **Then** a toast "Invitation resent" shows; **When** they choose "Revoke" and confirm, **Then** the row shows "Revoked"; accepted, revoked and expired rows have no actions; the status filter (`status` in the URL) lists Pending (default), Accepted, Revoked, Expired.
- **AS-79** (The roles matrix is readable without colour) — **Given** the Roles tab, **Then** a table with roles as columns and permissions as rows from `GET /shop-roles` shows "Allowed" or "Not allowed" as text with an icon in each cell, the member's own role column is marked "Your role", and the permission names are shown with a plain-language label where the app knows one and the raw name otherwise.
- **AS-80** (Accepting an invitation from the e-mail link) — **Given** a signed-in member opens `/invites/{token}`, **Then** the page says "You've been invited to join a shop." with the button "Accept invitation"; **When** they press it, **Then** the request is made once, the browser is sent to `/dashboard/seller/{shopId}` replacing the invitation entry in history, and a toast says "You joined as {role}." (or "You're already a member." when `alreadyMember`); **Given** a signed-out visitor, **Then** they are sent to sign-in with `returnTo=/invites/{token}` and come back to this page.
- **AS-81** (Every refusal of an invitation reads the same) — **Given** `404 invite_not_found` (unknown, expired, used, revoked, or sent to another address, which the API never distinguishes), **Then** the page says "This invitation isn't valid for this account. It may have expired, been used, or been sent to a different e-mail address." with a link to "Go to your dashboard"; `429 rate_limited` shows the countdown message.
- **AS-82** (The invitation token stays private) — **Given** the invitation page, **Then** the token is read only on the server and passed to the accept action, never logged or placed in analytics (the page name sent is `/invites/:token`), the response carries `Referrer-Policy: no-referrer`, and after any successful accept the token is no longer in the address bar or history.

### User Story 8 — Review the shop's orders (Priority: P2)

Any member can see the shop's order slices; no buyer identity is shown.

**Why this priority**: W03 removed the seller view from the buyer's dashboard.

**Independent Test**: open the orders page of a shop with a paid order.

**Acceptance Scenarios**:

- **AS-83** (The shop's orders, without buyer identity) — **Given** `/dashboard/seller/{shopId}/orders`, **Then** a table with the columns Order, Status, Items, Subtotal, Date lists the shop's slices newest first (the order reference is the first 8 characters of the shop-order id, and the page shows no buyer identifier), the status filter (`status` in the URL) narrows it, "Next page" uses `cursor`, every role of the shop can read it, empty: "No orders yet."

### User Story 9 — Every screen behaves under access limits, failure and every device (Priority: P1)

Guards, 404s, read-only states, offline, errors, rate limits, loading, state discipline, keyboard and layout apply to all screens above.

**Why this priority**: the dashboard handles money and credentials; it must fail safely and be usable by everyone.

**Independent Test**: the scenarios below, run on each page.

**Acceptance Scenarios**:

- **AS-84** (Anonymous visitors are sent to sign in and come back) — **Given** a signed-out visitor, **When** they open any `/dashboard/seller/**` URL, **Then** the server redirects to `/login?returnTo=<that path and query>` before any content is sent, and after sign-in they land on it.
- **AS-85** (A shop that isn't yours does not exist) — **Given** a shop id that is unknown, malformed or belongs to someone else, **Then** every seller page answers the not-found page with the text "We couldn't find that shop." and a link "Your shops", identical in all three cases.
- **AS-86** (A suspended or closing shop is read-only and says why) — **Given** the shop status is `SUSPENDED`, **Then** every seller page shows the banner "This shop is suspended. You can view data but not make changes." and all create, edit, archive, rotate, revoke, delete, invite and role controls are disabled with that reason as their description; **Given** `DELETING`, **Then** the banner says "This shop is being closed. You can view data but not make changes."; **When** a write still returns `403 shop_suspended` or `409 shop_offboarding`, **Then** the same banner is shown and the list refetches.
- **AS-87** (An expired session ends politely, once) — **Given** the session ended, **When** any seller request answers `401`, **Then** W01's session-ended flow runs exactly once (toast with a "Sign in" action to `/login?returnTo=<current URL>&notice=session_expired`); open dialogs close; secrets already shown are not recoverable and the dialog says so before it is dismissed.
- **AS-88** (Offline is visible and recoverable) — **Given** the browser goes offline, **Then** a status banner "You're offline. Changes can't be saved." shows on every seller page; a failed action shows the alert "Couldn't reach the server. Check your connection and try again." with a "Try again" button; **When** the browser comes back online, **Then** the banner clears and open queries refetch once.
- **AS-89** (Server errors are generic but traceable) — **Given** a `5xx` problem+json, **Then** the alert shows the title, the generic detail and "Reference: {requestId}" with a "Copy" button, never a stack, SQL or upstream text; a body that is not problem+json shows the generic message without a reference; a `400 invalid_cursor` on any list shows "That page link is no longer valid." with a "Go to the first page" link.
- **AS-90** (Rate limits show a countdown) — **Given** `429` with `Retry-After`, **Then** the alert says "Too many requests. Try again in {n} s.", the control that caused it is disabled and re-enables when the count reaches 0 (updating once per second without announcing every tick; the start and the end are announced once each).
- **AS-91** (Every page has a loading state that matches its layout) — **Given** any seller page loads or streams, **Then** the sidebar frame is already visible, the content area shows skeletons shaped like the final layout (not a spinner and not the word "Loading..."), and nothing shifts when data arrives.
- **AS-92** (Server data, URL state and local state each have one home) — **Given** the seller source, **Then** server data is read only through TanStack Query with keys from `lib/query-keys.ts` (`queryKeys.seller.*`) and is never copied into `useState`, Context or a store; shareable view state (period, tab, filters, search, cursor, mode) is in the URL; dialogs and form drafts are local state; no `fetch`, `axios` or `EventSource` appears in components or hooks; list rows use stable ids as keys; no new Context or global store is added.
- **AS-93** (No token or credential in browser JavaScript) — **Given** the seller source, **Then** requests go to relative same-origin `/api/...` paths, every non-GET request carries W01's CSRF header, nothing reads or writes `localStorage`, `sessionStorage` or a non-HttpOnly cookie for credentials, and secrets shown by the app (FR-032) are the only credentials the page ever holds.
- **AS-94** (Dialogs and menus work from the keyboard) — **Given** any dialog (create, edit, confirm, reveal), **Then** opening it moves focus inside (to the first field, or to "Cancel" for destructive confirmations), Tab stays inside, Escape closes it except the reveal dialog, and on close focus returns to the control that opened it; row action menus open with Enter or Space, move with arrow keys, and each trigger's accessible name includes its row (for example "Actions for Handmade Ceramic Mug").
- **AS-95** (Tables and forms are understandable with a screen reader) — **Given** any table, **Then** it has a caption (visually hidden when the heading already says it), column headers with `scope="col"`, no layout tables, and status is never conveyed by colour alone; **Given** any form with errors, **Then** a summary alert lists the problems, each invalid field has `aria-invalid` and `aria-describedby` pointing at its message, and focus moves to the first invalid field.
- **AS-96** (Overview layout at 390 px and 1280 px) — **Given** the overview, **Then** at ≤ 640 px the regions stack in one column in the order of FR-017 with tiles two per row, the period selector under the heading, charts at full width, and no horizontal page scroll; at ≥ 1024 px the tiles are four per row, the live panel and "Today (UTC)" sit side by side, rank and top products sit side by side below the chart.
- **AS-97** (List pages at 390 px and 1280 px) — **Given** inventory, API keys, webhooks, logs, usage, team and orders, **Then** at ≥ 1024 px each is a table inside the content area with actions in the last column; at ≤ 640 px each row becomes a card (the main value as its heading, the other columns as labelled pairs, actions in a menu button at the card's end), filters collapse into a "Filters" button that opens a sheet, dialogs become full-height sheets, and nothing requires horizontal scrolling.
- **AS-98** (The shell at 390 px and 1280 px) — **Given** any seller page, **Then** at ≥ 1024 px a persistent left sidebar shows the shop switcher and the groups "Shop" (Overview, Inventory, Orders, Team) and "Developers" (API keys, Webhooks, API version, Request logs, Usage, API documentation) plus "Account" links; at ≤ 640 px a top bar shows the menu button (named "Open menu"), the shop name and the page name, and the same entries open in a drawer that closes after a choice and returns focus to the menu button; the current page carries `aria-current="page"`.

### Edge Cases

- A member of ten shops: the switcher lists the first 50 shops it is given and links to the picker page for more (AS-09).
- A product title of 200 characters, a shop name of 80, a URL of 2,048: long text wraps inside its cell and never widens the page (AS-97).
- Two members edit the same product: the second save is refused with a way forward, never overwritten (AS-37, AS-38).
- A sale changes stock while the stock popover is open (AS-38).
- The search index lags behind a new product: the browse list is authoritative; the search hint says results can take a few seconds (AS-30).
- A key secret is lost: it cannot be recovered; rotate instead (AS-46).
- The clipboard is blocked (AS-47). The session ends while a secret is on screen (AS-87).
- A webhook endpoint is disabled automatically while its page is open: the next refetch shows the new status; enabling clears it (AS-61).
- A cursor link is old or tampered with: `400 invalid_cursor` shows "That page link is no longer valid." with a link to the first page (AS-89).
- Time: server timestamps are shown in the viewer's time zone with the UTC value in a tooltip; "Today (UTC)" and the usage days are UTC and say so (AS-26, AS-73).
- The platform currency differs from what another capability assumes: money always uses the currency of the response it came from (AS-11, AS-35).

## Requirements *(mandatory)*

### Functional Requirements

**Rendering and data flow (constitution VI)**

- **FR-001**: Every seller page and `/invites/{token}` MUST be a Server Component that requires the session on the server (W01 `requireServerSession(returnTo)`), resolves the shop with a server-only call (so a non-member gets a real not-found response and an anonymous visitor a redirect before any content is sent), and passes to client components only the fields they render. Authorization is enforced again by the API on every call; the UI never relies on its own checks (AS-84, AS-85, AS-92).
- **FR-002**: Each page MUST show its frame (sidebar or top bar) at once and stream per-user content behind Suspense with skeletons shaped like the final layout; per-user data (session, shop, keys, secrets) MUST NOT be placed in a shared cache (no `use cache` around it); API responses with secrets are `no-store`; the blanket `instant = false` opt-outs are removed and replaced by Suspense boundaries (AS-91).
- **FR-003**: Server data MUST be read with TanStack Query using keys from `queryKeys.seller.*` (Cross-capability contracts), seeded from the server render, refetched on reconnect, and never copied into `useState`, Context or a store; mutations invalidate by key prefix and never patch the cache by hand except to remove a deleted row after a successful delete (AS-92).
- **FR-004**: Shareable view state MUST live in the URL (table in Screens and routes); defaults are omitted; an invalid value is replaced by the default (`router.replace`), not shown as an error; search text updates the URL after 300 ms without adding history entries; changing a filter drops `cursor` (AS-12, AS-29, AS-30, AS-70, AS-73).
- **FR-005**: Local state MUST be limited to open dialogs, form drafts, copy feedback, the "View as table" toggle and similar; no new Context or global store is introduced (AS-92).
- **FR-006**: Network calls MUST live only in `lib/api/*` (typed functions that validate responses with the `packages/contracts` schemas) and in server-only data modules; requests use relative same-origin `/api/...` paths with W01's CSRF header on every non-GET; no token is read, stored or sent from browser JavaScript (AS-92, AS-93).
- **FR-007**: Money MUST be formatted from integer minor units and the currency of the same response (`formatMoney(minor, currency)`); a typed amount is converted to minor units by string parsing using the currency's fraction digits, never by floating-point arithmetic (AS-11, AS-35).
- **FR-008**: Controls MUST be shown or hidden from the shop's `myPermissions` (presentation only); a refusal from the API is always handled by FR-043 (AS-42, AS-54).
- **FR-009**: User-supplied text (shop, product, key, member names, URLs, event bodies, response snippets) MUST be rendered as text; event bodies are shown as formatted text in a `pre` block (AS-43, AS-66).
- **FR-010**: Lists MUST use stable ids as `key`; page sizes are bounded by the API's limits (default 20 to 50), with keyset "Next page" links, no infinite scroll and no offset pages (AS-28).

**Shell, access and status**

- **FR-011**: The shell MUST provide the sidebar and drawer of the Layout section, the shop switcher (first 50 shops of `GET /shops/mine`, each with name, role and a status badge when not active; choosing one keeps the current section), and seller entries that depend on shop membership and `myPermissions`, never on the session's role claim. A shop that is unknown, malformed or someone else's is one not-found page ("We couldn't find that shop.", link "Your shops"). A page whose permission is missing shows the panel "You don't have access to this page." with the member's role, "Ask a shop owner or admin to change your role." and a link back to the Overview (AS-09, AS-85, AS-54, AS-98).
- **FR-012**: When the shop's status is `SUSPENDED` or `DELETING`, every seller page MUST show the banner of AS-86, disable every write control with that reason, and still allow every read (AS-86).
- **FR-013**: `/dashboard` MUST redirect to `/dashboard/seller`, `/dashboard/settings` to `/account/security`, and `/dashboard/seller/inventory` to the shop's inventory; the buyer-order table and "Recent orders" card are removed from the dashboard (AS-08).

**Shop entry**

- **FR-014**: The open-shop form MUST offer "Shop name" and "Handle" (derived from the name until edited), validate after the first blur or submit, send one request however often the button is pressed, and show the problems of AS-05 and AS-06 (AS-01, AS-02, AS-07).
- **FR-015**: After a shop is created the app MUST go to its overview, announce "Your shop is open" once, and refresh the session role in the background without making any page depend on it (AS-03, AS-04).
- **FR-016**: `/dashboard/seller` MUST redirect on the server when the member has exactly one shop, show the picker (name, handle, role, status badge; `cursor` for more) when several, and the open-shop form when none (AS-08, AS-09).

**Overview and live numbers (P0406)**

- **FR-017**: The overview MUST read one composed answer for the shop (header, period stats, today, rank) in which each optional section can fail on its own, and render in this order: header, live panel, "Today (UTC)", period tiles, rank, daily chart, top products; a failed section shows its own message and "Try again" and never blanks the others (AS-10, AS-17, AS-18).
- **FR-018**: The period tiles, net revenue, refunds, the top-products list (titles as recorded on the sale), the daily chart with its text alternative and "View as table", the rank sentence and the empty states MUST follow AS-11, AS-13, AS-14, AS-16, AS-15, AS-26.
- **FR-019**: The period MUST be 7, 30 (default) or 90 days in the URL (AS-12).
- **FR-020**: The live panel MUST subscribe to the shop's live topic through the page's single shared stream, show the last-60-seconds checkouts, orders, units, revenue, conversion and a 60-point orders-per-second sparkline from each frame, and show one of the states Connecting, Live, Reconnecting (numbers dimmed with "Last updated {time}"), or Unavailable (AS-19, AS-20, AS-21).
- **FR-021**: The live panel MUST handle the stream's in-band `resync` (refetch today and the period sections) and `revoked` (one session check, then resubscribe or show Unavailable), treat a refusal (`401`/`403`) as final for that connection, recreate it once after refreshing the session, and then fall back to refetching "Today (UTC)" every 30 seconds while visible (AS-21, AS-22).
- **FR-022**: The stream MUST be closed while the tab is hidden and reopened with a one-time refetch on return; the topic MUST be swapped on the same connection when the shop changes; there MUST be at most one stream per page (AS-23, AS-25).
- **FR-023**: While frames show new orders, the period and today queries MUST be invalidated at most once per 30 seconds (AS-24).
- **FR-024**: Per-second values MUST NOT be announced to assistive technology; only state changes are, once each (AS-27).

**Inventory**

- **FR-025**: The inventory MUST list the shop's products (member view) with keyset paging, the Active/Archived tabs and the stock filter in the URL, and the three empty states (AS-28, AS-29, AS-31, AS-32).
- **FR-026**: With a search text the list MUST come from the shop search, keep previous rows while loading, disable the tabs and filter, and label each row's status (AS-30, AS-31).
- **FR-027**: The create and edit forms MUST validate only what the UI can (required, numeric, whole stock, decimal places), send `priceMinor` and the platform currency, send only changed fields with `expectedVersion` on edit, map `errors[]` to fields, and handle `version_conflict` without overwriting (AS-33, AS-34, AS-35, AS-36, AS-37).
- **FR-028**: Stock adjustment, the stock badges (0, 5 or fewer, more) and archive and restore MUST follow AS-38, AS-39, AS-40, AS-41; there is no delete.
- **FR-029**: Write controls MUST follow `products.write` (AS-42).

**API keys**

- **FR-030**: The key list MUST show prefix, mode, scopes, derived status, expiry, last use and creation date, never a secret or hash (AS-44).
- **FR-031**: Key creation MUST offer name, scopes (at least one), mode (Test by default), optional expiry within 365 days, and handle `mfa_required`, `key_limit_reached` and validation errors as in AS-45, AS-48, AS-49, AS-50.
- **FR-032**: A secret (API key or webhook signing secret) MUST follow AS-46 and AS-47: held only in the open dialog, never cached, stored or logged, no accidental dismissal, a warning when not copied.
- **FR-033**: Rotation MUST let the member choose the overlap and state when the old key stops; revoke MUST be confirmed, immediate and idempotent (AS-51, AS-52, AS-53).
- **FR-034**: The page MUST explain how to use a key (AS-55).

**Webhooks**

- **FR-035**: The endpoint list MUST show URL, events, API version, status with the reason, breaker state and previous-secret overlap (AS-56).
- **FR-036**: Add and edit MUST build the event choices from the catalogue, default the version to the shop's pin, and place every rejection at the field or alert named in AS-58, AS-59, AS-60.
- **FR-037**: Enable, disable, rotate secret (with overlap and "End old secret now"), delete and "Send test event" MUST behave as in AS-61, AS-62, AS-63, AS-64; the signing secret follows FR-032.
- **FR-038**: The endpoint page MUST show the delivery log, the event detail and replay as in AS-65, AS-66, AS-67; replay sends an `Idempotency-Key` created per intent, and no signature, header or secret is ever displayed.

**API version, logs, usage**

- **FR-039**: The version page, the request-log search (filters in the URL, 30-day window) and the usage report MUST behave as in AS-68, AS-69, AS-70, AS-71, AS-72, AS-73.

**Team, invitations, orders**

- **FR-040**: The team page MUST show members, role changes, removal and leaving, invitations (create, resend, revoke, status filter) and the roles matrix, offering only the actions S03 FR-021 allows the viewer and showing the API's refusal when it still comes (AS-74, AS-75, AS-76, AS-77, AS-78, AS-79).
- **FR-041**: `/invites/{token}` MUST read the token on the server only, require sign-in (returning to the page afterwards), accept on an explicit button press, replace the history entry on success, show one neutral message for every refusal, and keep the token out of logs, analytics and the referrer (AS-80, AS-81, AS-82).
- **FR-042**: The orders page MUST show the shop's order slices without buyer identity (AS-83).

**Errors, resilience, accessibility, layout**

- **FR-043**: Every error a call can return MUST be shown in the form given by the error catalogue below, using W01's `problemFromError` and `<ProblemAlert />`; no raw JSON, status number alone or "[object Object]" is ever shown; the request reference is shown for every `5xx` (AS-89).
- **FR-044**: A `401` MUST run W01's session-ended flow exactly once (AS-87).
- **FR-045**: Offline and reconnecting states MUST be visible and recoverable (AS-88, AS-21).
- **FR-046**: A `429` MUST show a countdown from `Retry-After` and disable the causing control until it ends (AS-90).
- **FR-047**: Destructive and secret-changing actions MUST use accessible confirmation dialogs (never the browser's `confirm`), with focus on "Cancel" first; dialogs, menus, tables and forms MUST satisfy AS-94 and AS-95.
- **FR-048**: Layout MUST satisfy AS-96, AS-97, AS-98.

### Error catalogue (visible form of every problem+json code these screens can meet)

Every error body is `application/problem+json` (V.3). Forms: **F** = message under the field named in `errors[].field`; **A** = alert in the open dialog or above the form, with the API's `detail` unless copy is given; **P** = page-level panel with "Try again"; **T** = toast and refetch; **S** = session-ended flow; **C** = countdown.

| Status · code | Raised by | Form and copy |
|---|---|---|
| 400 `validation_failed` | every write, filters | **F** per field; fields not on the form go to **A**; the first invalid field gets focus |
| 400 `shop_mismatch`, `invalid_topics`, `invalid_query` | cannot be produced by the UI | **A**/**P** generic ("Something went wrong on our side.") with reference |
| 400 `invalid_cursor` | every list | **P** "That page link is no longer valid." + "Go to the first page" (AS-89) |
| 401 `unauthenticated`, `invalid_token`, `session_expired` | any | **S** (AS-87) |
| 403 `permission_denied` | any (S03 FR-012) | page: panel of FR-011 (AS-54); action: **T** "You don't have permission to do that." |
| 403 `insufficient_role` | team | **A** (AS-75) |
| 403 `mfa_required` | live key create/rotate | **A** (AS-49) |
| 403 `shop_suspended`, 409 `shop_offboarding` | any write | banner of AS-86 + refetch |
| 403/401 `forbidden`, `unauthenticated` on the stream | live panel | AS-22 |
| 404 `shop_not_found` | any page or call | not-found page (AS-85); in a dialog: **A** "This shop is no longer available." |
| 404 `product_not_found`, `member_not_found`, `webhook_endpoint_not_found`, `webhook_event_not_found`, `resource_missing`, `invite_not_found`, `not_ranked` | named scenarios | AS-41, AS-75, AS-63, AS-66, AS-81, AS-15; `resource_missing` on a key: **T** "This key no longer exists." |
| 409 `version_conflict`, `product_archived`, `invalid_transition` | inventory | AS-37, AS-38, AS-41 |
| 409 `key_revoked`, `key_expired`, `key_already_rotating` | rotate | AS-52 |
| 409 `endpoint_state_conflict`, `rotation_in_progress`, `no_previous_secret`, `endpoint_disabled`, `idempotency_in_flight`, `duplicate_endpoint_url` | webhooks | AS-61, AS-62, AS-67, AS-59 |
| 409 `slug_taken`, `shop_limit_reached` | open shop | AS-05, AS-06 |
| 409 `seat_limit_reached`, `invite_pending`, `already_member`, `last_owner`, `stale_version` | team | AS-77, AS-75, AS-76; `stale_version`: **T** "This changed elsewhere. The page has been refreshed." |
| 422 `key_limit_reached`, `endpoint_limit_reached`, `currency_not_supported`, `version_retired`, `slug_reserved`, `endpoint_url_rejected`, `idempotency_key_required`, `idempotency_key_reuse` | named scenarios | AS-50, AS-59, AS-34, AS-69, AS-05; the two idempotency codes mean a programming error: **A** generic with reference |
| 429 `rate_limited`, `too_many_connections` | any | **C** (AS-90); the stream: AS-22 |
| 502 `upstream_invalid`, 503 `upstream_unavailable`, `overloaded`, `service_unavailable`, `serialization_failure`, `cell_unavailable`, `search_unavailable`, `realtime_*` | reads and writes | page/section: **P** or section message with "Try again"; action: **A**/**T** "That didn't work. Try again in a moment." (+ `Retry-After` countdown when given); reference shown |
| network failure (no response) | any | AS-88 |

### Key Entities *(UI view models; fields as the API returns them)*

- **Shop context**: `{id, name, slug, plan, status, myRole, myPermissions}`; read once per page from the shop call and refetched by key.
- **Overview answer**: `{shop, stats | null, today | null, rank | null, errors: [{section, code, retryable}]}`; `stats` = S40's stats (summary, daily, topProducts with title), `today` = totals and per-minute series, `rank` = rank or "not ranked".
- **Live frame**: `{shopId, at, windowSeconds, last60s: {checkouts, orders, units, revenueMinor}, ordersPerSecond[60], checkoutConversion | null}`; held only in the panel.
- **Product row**: `{id, title, priceMinor, currency, quantity, status, version?}` (version only from the member view).
- **API key row**: `{id, prefix, name, scopes, livemode, status, expiresAt, lastUsedAt, createdAt, successorId?}`; **Reveal secret**: the full key or `whsec_…`, in dialog state only.
- **Webhook endpoint**: `{id, url, events, apiVersion, status, disabledReason, failingSince, breaker, hasPreviousSecret, previousSecretExpiresAt, createdAt}`; **Attempt** `{attemptId, eventId, type, attempt, startedAt, durationMs, status, ok, error?, responseSnippet?, replay}`; **Event detail** `{eventId, type, createdAt, state, attempts, body}`.
- **Log record**: `{requestId, clientRequestId?, keyId, livemode, version, method, route, status, durationMs, deprecated, errorCode?, at}`; **Usage row** `{day, version, route, calls, errors, deprecatedCalls}`.
- **Member** `{userId, email | null, role, source, joinedAt}`; **Invite** `{id, email, role, status, expiresAt, invitedBy, createdAt}`; **Shop order slice** `{shopOrderId, orderId, status, subtotalMinor, currency, createdAt, items}`.
- **Problem**: `{type, title, status, detail, instance, requestId, code, errors?}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member with no shop reaches a working overview of their new shop in under 60 seconds of interaction, and every later visit lands on the overview in one step.
- **SC-002**: A seller watching the overview sees a paid order reflected in the live numbers within 2 seconds for 99 % of orders, and never sees numbers labelled "Live" that are older than 5 seconds.
- **SC-003**: A seller adds a product and sees it in the inventory in under 90 seconds of interaction, and finds it again by search with one typo.
- **SC-004**: For 100 % of created or rotated keys and signing secrets, the secret is visible only in the dialog that created it: no later screen, link, saved state or copy of the page shows it again.
- **SC-005**: When any one section of the overview fails, 100 % of the other sections still render.
- **SC-006**: Every problem code in the error catalogue produces a specific message and a way forward; 0 occurrences of raw JSON, bare status numbers or technical identifiers in user-visible text.
- **SC-007**: On every seller page and in every listed state at 390 px and 1280 px widths there is no horizontal page scroll and the automated accessibility scan reports 0 serious or critical issues.
- **SC-008**: A keyboard-only member can open a shop, add a product, create an API key and add a webhook endpoint without using a pointer.
- **SC-009**: Switching between pages of the seller area shows the frame immediately and a page-shaped skeleton within 1 second, with no content shifting when data arrives.

## Assumptions

- Business rules, limits and error codes are those of S03, S05, S40, S42, S43 (and S10, S32 for the read shapes); W04 quotes limits only in copy that names them (10 shops, 25 keys, 20 endpoints), taken from those specs.
- The platform has one currency in this release; the product form uses it (`PLATFORM_CURRENCY`, server configuration) and shows it in the price label; every display uses the currency of the response.
- The session carries no tokens in browser code (W01); `useAuth()` is read-only and used only for display and the e-mail of the viewer; shop membership and `myPermissions` decide what is offered.
- Seller visibility in the sidebar is by membership of at least one shop. The platform role `SELLER` appears after the eventual promotion and is not read by W04.
- The Invitations tab needs `members.manage` (S03 lists invitations next to member management); the Roles tab is open to every member.
- The overview is served as one composed answer by the BFF (IX.7 R2) in which `stats`, `today` and `rank` may be missing with an entry in `errors`; this endpoint does not exist yet (`gaps.md` E1).
- The browser opens one realtime connection per page (S51 A-14) through the shared stream of W03; W04 only adds its topic.
- Request-log, usage and delivery-log retention is 30 days (S42, S43); the UI says so where it matters.
- Dates are shown in the viewer's time zone with the UTC instant in a tooltip, except where the label says UTC; copy is English only.
- Product tags and the product editor's rich text are outside this release (tags are not shown in the form; S06 later replaces the form's description field).
- The decisions behind every default are listed in `questions.md`; the ones that change today's behaviour are tagged `[BREAKING]` there.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web` for `W04` and `web`; `specs/journeys` does not exist): **S03, S05, S40, S42, S43, S32, S10, S51, S36, S47, S44, S29, S30, S15, S14, S12, S09, S08, S07, S06, S04** (domains) and **W01, W02, W03** (web) name W04. Every obligation placed on W04 is honoured below, or differs through a `[CONTRACT]` line in `questions.md` (new aggregate, topic-addressable stream, deferred screens, permission names, platform currency).

### Provides

Exact names; modules are in `packages/web`.

- **Routes** other capabilities link to: `/dashboard/seller` · `/dashboard/seller/{shopId}` (parameter `days`) · `/dashboard/seller/{shopId}/inventory` (parameters `q`, `status`, `inStock`, `cursor`) · `/dashboard/seller/{shopId}/orders` · `/dashboard/seller/{shopId}/team` (`tab`, `status`) · `/dashboard/seller/{shopId}/developers/api-keys` · `…/developers/webhooks` · `…/developers/webhooks/{endpointId}` (`ok`, `event`, `cursor`) · `…/developers/api-version` · `…/developers/logs` · `…/developers/usage` · `/invites/{token}` (the link of S03/S28). Removed: `/dashboard/seller/inventory` (redirects), the buyer overview at `/dashboard`.
- **`useShop(shopId)`** (`lib/api/seller.ts`, client): TanStack Query result of `GET /api/shops/{shopId}` (`shopSchema`: `{id, slug, name, plan, status, myRole, myPermissions, …}`); **`shopCan(shop, permission: ShopPermission): boolean`** (`lib/seller/permissions.ts`, pure, used for presentation only). Later seller screens use both instead of reading the role.
- **Navigation registry** (`lib/seller/nav.ts`): `SellerNavItem = { id: string; group: 'shop' | 'developers'; label: string; href: (shopId: string) => string; icon: LucideIcon; requires?: ShopPermission }` and `sellerNavItems: SellerNavItem[]`. A later capability adds one item to this list to appear in the sidebar and drawer; the shell renders the list and nothing else.
- **`<RevealSecretDialog />`** (`components/seller/secret-reveal-dialog.tsx`, client): props `{ title: string; description: string; secret: string | null; note?: string; onDone(): void }`; guarantees of AS-46 and AS-47; reusable by S44's secret reveal (widget identity secret).
- **`<ShopStatusBanner />`** and **`useShopWritable(shop): { writable: boolean; reason: string | null }`**: the read-only rule of AS-86 for later screens.
- **`queryKeys.seller`** (`lib/query-keys.ts`): `shops()`, `shop(shopId)`, `overview(shopId, {days})`, `inventory(shopId, {q, status, inStock, cursor})`, `product(shopId, productId)`, `orders(shopId, {status, cursor})`, `team.members(shopId, {cursor})`, `team.invites(shopId, {status, cursor})`, `team.roles()`, `apiKeys(shopId, {cursor})`, `apiVersion(shopId)`, `logs(shopId, filters)`, `usage(shopId, {days, livemode})`, `webhooks(shopId, {cursor})`, `webhookEventTypes(shopId)`, `webhook(shopId, endpointId)`, `webhookAttempts(shopId, endpointId, {ok, cursor})`, `webhookEvent(shopId, endpointId, eventId)`. Replaces `queryKeys.seller.dashboard` and `.products` and the literals `['shops','mine']`, `['seller-stats', days]`, `['shop-products', …]`.
- **`<ProductForm />`** (`components/seller/inventory/product-form.tsx`): create and edit, used by S06 (publish flow) as the fallback form.
- **Playwright helpers** (`tests/helpers.ts`): `openShop(page, name?)` → `{ shopId, shopName }` (opens a shop through the UI from a signed-in page); `seedProduct(shopId, input)` → product id (API call with the seller's session); `shopPath(shopId, section?)`.
- **Behavioural guarantees**: no W04 request carries a token from JavaScript; every W04 write sends the shared CSRF header; secrets never enter the query cache, URL or storage; `Idempotency-Key` is sent exactly where the backend requires it (webhook replay); a `401` from a W04 call runs W01's session-ended flow once; every list uses stable keys; no per-user data is placed in a shared cache.

### Requires

- **S48 (BFF)**: same-origin forwarding of `/api/*` with the session's bearer attached (W01 C-FWD) covering `GET|POST|PATCH|PUT|DELETE /api/shops/**` (including `/products`, `/members`, `/invites`, `/developers/**`, `/stats`, `/rank`, `/dashboard/today`, `/orders`), `/api/shop-roles`, `/api/shop-invites/accept` and `GET /api/streams` (unbuffered). **New aggregate (`[CONTRACT]`, IX.7 R2)**: `GET /api/bff/seller/{shopId}/overview?days=` (session; member) → `sellerOverviewResponseSchema` = `{shop: shopSchema, stats: sellerStatsSchema | null, today: dashboardTodaySchema | null, rank: shopRankSchema | {notRanked: true} | null, errors: [{section: 'stats' | 'today' | 'rank', code, retryable}]}`; per-section timeouts; `404 shop_not_found` for a non-member; `503 upstream_unavailable` only when the shop itself cannot be read.
- **S03**: `GET /shops/mine?limit&cursor` → page of `{id, name, slug, plan, status, role}`; `POST /shops {name, slug}` → `201`; `GET /shops/{shopId}` → `shopSchema` with `myRole`, `myPermissions`; `GET|PATCH|DELETE …/members`; `GET|POST …/invites`, `POST …/invites/{id}/resend`, `DELETE …/invites/{id}`; `POST /shop-invites/accept {token}` → `201 | 200 {shopId, role, alreadyMember?}`; `GET /shop-roles`; realtime policy for `shop:{id}:live` (members of `ACTIVE` or `SUSPENDED` shops); problem codes of FR-100.
- **S05**: `GET /shops/{shopId}/products?status&category&inStock&limit&cursor` → `productPageSchema`; `GET …/products/{productId}` → `productMemberSchema` (with `version`); `POST …/products` → `201`; `PATCH …/products/{productId} {expectedVersion, …}`; `POST …/archive` and `…/restore {expectedVersion}`; problem codes `validation_failed`, `currency_not_supported`, `version_conflict {currentVersion}`, `product_archived`, `invalid_transition`, `product_not_found`, `rate_limited`.
- **S32**: `GET /shops/{shopId}/products/search?q&limit&cursor` → `shopProductSearchResponseSchema` `{items: {id, title, priceMinor, currency, quantity, status, rank}[], nextCursor}` (`[CONTRACT]`: no `version`, so edit reloads the member view).
- **S40**: `GET /shops/{shopId}/stats?days=` → `sellerStatsSchema`; `GET /shops/{shopId}/dashboard/today` → `dashboardTodaySchema`; `GET /shops/{shopId}/rank` → `shopRankSchema` | `404 not_ranked`; topic `shop:{shopId}:live`, event `dashboard`, payload `liveDashboardFrameSchema` (consumed through S48's forwarding of S51); all as in S40's Provides.
- **S51**: `GET /api/streams?topics=shop:{shopId}:live` with `retry:`, `resync`, `revoked`, `401/403` as final for the connection (A-13), one connection per page (A-14).
- **S42**: `POST|GET …/developers/keys`, `POST …/keys/{keyId}/rotate {overlapHours?}`, `DELETE …/keys/{keyId}`, `GET|PUT …/developers/api-version`, `GET …/developers/logs`, `GET …/developers/usage`; `[CONTRACT]`: key and log lists are `{items, nextCursor}` pages with `limit` and `cursor`; permission names as in `questions.md`; problem codes `mfa_required`, `key_limit_reached`, `key_revoked`, `key_expired`, `key_already_rotating`, `version_retired`, `resource_missing`.
- **S43**: `GET|POST …/developers/webhooks`, `PATCH|DELETE …/webhooks/{id}`, `POST …/enable|disable`, `POST …/rotate-secret {overlapHours?}`, `POST …/expire-previous-secret`, `GET …/attempts`, `GET …/events/{eventId}`, `POST …/events/{eventId}/replay` (`Idempotency-Key`), `POST …/webhooks/{id}/ping`, `GET …/webhook-event-types`; problem codes of FR-050.
- **S10**: `GET /shops/{shopId}/orders?status&limit&cursor` → `shopOrderPageSchema`; `[CONTRACT]`: the item shape and the status values are listed by S10.
- **W01**: `requireServerSession(returnTo)`, `loginHref(returnTo)`, read-only `useAuth()`, `useRefreshSession()`, `problemFromError`, `<ProblemAlert />`, `csrfHeaders()`, the session-ended flow, `/account/security?tab=two-step`; C-REFRESH.
- **W02**: `formatMoney(minor, currency)`, `newIdempotencyKey()`, the not-found conventions. **W03**: the page stream (`lib/realtime/user-stream.ts`) generalised to topics (`[CONTRACT]`): `subscribeTopic(topic: string, handler: (event: { type: string; data: unknown }) => void): () => void` and the same recreate-after-refusal and `resync`/`revoked` handling. **W07**: the frame (skip link, `<main>`, global error and not-found pages), `Referrer-Policy: no-referrer` on `/invites/*`, and a page-name rule that sends `/invites/:token` to analytics.
- **`packages/contracts`**: `shopSchema`, `shopListItemSchema`, `shopMemberSchema`, `shopInviteSchema`, `shopRolesSchema`, `productMemberSchema`, `productPageSchema`, `shopProductSearchResponseSchema`, `sellerStatsSchema`, `dashboardTodaySchema`, `shopRankSchema`, `liveDashboardFrameSchema`, `shopOrderPageSchema`, the S42 dashboard schemas (`apiKeyListSchema`, `apiKeyCreatedSchema`, `apiVersionSchema`, `requestLogPageSchema`, `usageReportSchema`), the S43 schemas (`webhookEndpointSchema`, `webhookEndpointCreatedSchema`, `webhookAttemptPageSchema`, `webhookEventDetailSchema`, `webhookEventTypesSchema`), `problemSchema`, and the new `sellerOverviewResponseSchema` (the package has no source today).
- **Configuration**: `API_URL`, `BFF_URL` (server only); `PLATFORM_CURRENCY` (server; the platform currency of S05 AS-03); `PUBLIC_API_BASE_URL` (server; shown in "Using the API").

## Pattern coverage (pattern-map rows whose Specs column names W04)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0406 Push instead of poll (SSE) | FR-020, FR-021, FR-022, FR-023, FR-024, FR-045 | AS-19, AS-20, AS-21, AS-22, AS-23, AS-24, AS-25, AS-27 (push as primary, `resync` and refusal handling, polling fallback, one connection per page, pause when hidden, throttled refresh) |
| P0901 Server vs client state; Context vs reducer vs store; URL state | FR-003, FR-004, FR-005, FR-010 | AS-12, AS-29, AS-30, AS-70, AS-73, AS-92 (TanStack Query for server data, URL for shareable state, local state for dialogs, no new Context or store) |

## Review & Acceptance Checklist reference

The spec quality checklist is `checklists/requirements.md`; the test plan is `test-plan.md`; the implementation to-do list is `gaps.md`; every default chosen is in `questions.md`.
