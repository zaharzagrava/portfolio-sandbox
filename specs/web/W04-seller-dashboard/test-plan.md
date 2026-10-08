# Test Plan: W04 — Seller dashboard (`packages/web`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (98 scenarios, AS-01 to AS-98), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names more than one layer, the cell states what that layer proves; no part is proven twice. "Proven by backend spec" names the backend scenario that owns the rule; the UI never re-tests it (VII.7). Rows whose rule has no backend scenario yet (the overview aggregate, S48) say so.

## Layers and conventions

- **UI journey (Playwright, happy path only)**: `packages/web/tests/*.spec.ts` against the real local dev stack (`moon run :dev-monolith`, web on 3000), an isolated user per test (`register` from `tests/helpers.ts`, then `openShop`), web-first assertions, no fixed sleeps, roles and labels instead of test ids. A journey never forces a failure and never asserts a backend rule. Five files, each with a top-level `describe` naming its feature: `seller-shop.spec.ts` (shop entry and overview), `seller-live.spec.ts`, `seller-inventory.spec.ts`, `seller-developers.spec.ts`, `seller-team.spec.ts`. The old `tests/seller.spec.ts` is split into them (`gaps.md` T6).
- **UI unit (Vitest + React Testing Library)**: `*.test.tsx` / `*.test.ts` next to the code. Queries by role and label, `@testing-library/user-event`, MSW at the network boundary with problem+json fixtures parsed by the `packages/contracts` schemas, `jsdom`, fake timers for debounce, countdowns, throttles and polling, a stub for `EventSource` (frames, `resync`, `revoked`, refusal, reconnect), a stub for the clipboard. They cover UI-only logic, states, copy, focus and accessibility. No markup snapshots.
- **Visual (Playwright screenshot)**: `packages/web/tests/visual/*.spec.ts`, projects `chromium` (1280 × 800) and `mobile` (390 × 844). The backend is stubbed with `page.route` (layout only), animations disabled, an axe scan (serious or critical = 0) runs on each state, screenshots are compared to committed baselines.
- **Static gates** (VII.1): `tsc --noEmit`, ESLint, `next build` (Cache Components validation), and the architecture test `lib/architecture.test.ts` shared with W03 (reads the source: no `fetch`/`axios`/`EventSource` in components or hooks, query keys only from `lib/query-keys.ts`, no new Context or store, no `use cache` around per-user data, no token or credential storage, no `window.confirm`, no `dangerouslySetInnerHTML`).
- **Fallback and degradation paths (VII.9)** each have a forcing test: partial overview (AS-17), live reconnect (AS-21), refused stream and polling fallback (AS-22), clipboard denied (AS-47), catalogue unavailable (AS-58), offline (AS-88).
- **Edge cases** (spec "Edge Cases") are each a scenario below: concurrent edit (AS-37, AS-38), search lag (AS-30), lost secret (AS-46), blocked clipboard (AS-47), session ending with a secret on screen (AS-87), auto-disabled endpoint (AS-61), invalid cursor (AS-89), time zone and UTC labels (AS-26, AS-73), currency of the response (AS-11, AS-35).

## Test data and tooling needed

- Helpers: `openShop(page, name?)`, `seedProduct(shopId, input)`, `shopPath(shopId, section?)` in `tests/helpers.ts`; a dev-stack way to read the sent invitation link for `seller-team.spec.ts` (the same S28 development hook W01 asks for); a sandbox payment helper from W03 to pay an order of the shop for `seller-live.spec.ts`; the dev-only allowance for a local webhook receiver (S43 FR-041) for the ping journey.
- Everything else is listed in `gaps.md` section F.

## Table

| Scenario | UI journey (Playwright, happy path) | UI unit (Vitest + React Testing Library: UI-only logic, states, a11y) | Visual (Playwright screenshot: layout states at mobile/desktop) | Proven by backend spec (ID) |
|---|---|---|---|---|
| AS-01 A member with no shop is offered the open-shop form | `tests/seller-shop.spec.ts` › owner opens a shop (step 1) (proves: the form is reachable from "Start selling" and submits) | — | `tests/visual/seller-shell.spec.ts` › open-shop form, mobile + desktop (proves: layout) | S03 AS-01 |
| AS-02 The handle follows the name until the member edits it | — | `app/dashboard/seller/open-shop-form.test.tsx` | — | S03 AS-02 |
| AS-03 Opening the shop lands on its overview | `tests/seller-shop.spec.ts` › owner opens a shop (step 2) | — | — | S03 AS-01 |
| AS-04 Seller tools do not wait for the platform role to catch up | — | `app/dashboard/seller/open-shop-form.test.tsx` (fake timers: 1 s, 2 s, 4 s refresh calls) | — | S03 AS-01 (event to S01) |
| AS-05 Field-level problems appear under the field | — | `app/dashboard/seller/open-shop-form.test.tsx` | — | S03 AS-03, AS-08 |
| AS-06 Form-level problems appear above the button | — | `app/dashboard/seller/open-shop-form.test.tsx` | — | S03 AS-04, AS-39 |
| AS-07 Pressing the button twice opens one shop | — | `app/dashboard/seller/open-shop-form.test.tsx` | — | — |
| AS-08 One shop: the index goes straight to it | `tests/seller-shop.spec.ts` › returning owner lands on the overview (proves: the redirect against the real API) | `components/seller/shop-switcher.test.tsx` (proves: the legacy `/inventory` redirect target) | — | — |
| AS-09 Several shops: pick one and switch while keeping the section | `tests/seller-shop.spec.ts` › owner switches between two shops (proves: the section is kept) | `components/seller/shop-switcher.test.tsx` (proves: list content, badges, current marker, 50-shop cap) | — | S03 AS-07 |
| AS-10 The overview answers "how is my shop doing" in one screen | `tests/seller-shop.spec.ts` › owner opens a shop (step 3) (proves: sections render from the real API) | — | `tests/visual/seller-overview.spec.ts` › overview with data, mobile + desktop (proves: the full layout) | S40 AS-50, AS-46; aggregate: S48 (new) |
| AS-11 Money is shown in the shop's currency, with refunds and net separate | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-50, AS-54, FR-040 |
| AS-12 The period choice lives in the URL | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-51, AS-57 |
| AS-13 Top products show titles, not ids | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-50, AS-56 |
| AS-14 The daily chart has a table alternative | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-50 |
| AS-15 A new shop sees honest empty states | — | `components/seller/overview/overview-view.test.tsx` (proves: zero and not-ranked copy) | `tests/visual/seller-overview.spec.ts` › new shop, mobile + desktop (proves: the empty layout) | S40 AS-25 |
| AS-16 The rank card reads like a sentence | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-24, AS-29 |
| AS-17 One failing section does not blank the page | — | `components/seller/overview/overview-view.test.tsx` (proves: per-section failure and retry) | `tests/visual/seller-overview.spec.ts` › partial data, mobile + desktop (proves: layout with a failed section) | S40 AS-48; aggregate: S48 (new) |
| AS-18 The shop itself failing is a page-level state | — | `components/seller/overview/overview-view.test.tsx` | — | S03 AS-09, AS-15 |
| AS-19 Live numbers move when a purchase is paid | `tests/seller-live.spec.ts` › live numbers move after a purchase (proves: a paid order moves the numbers within 2 s) | `components/seller/overview/live-panel.test.tsx` (proves: frame rendering and the Live state with a stubbed stream) | `tests/visual/seller-overview.spec.ts` › live panel connected, mobile + desktop (proves: the connected panel's layout) | S40 AS-37, AS-38, AS-42; S51 AS-01 |
| AS-20 Checkout conversion is shown only when it exists | — | `components/seller/overview/live-panel.test.tsx` | — | S40 AS-42 |
| AS-21 A dropped connection never shows old numbers as live | — | `components/seller/overview/live-panel.test.tsx` (fake timers; `resync`, `revoked`) | — | S51 AS-16, AS-54, AS-55; S40 AS-45 |
| AS-22 A refused stream falls back to polling | — | `components/seller/overview/live-panel.test.tsx` | — | S51 FR-007, A-13; S40 FR-041 |
| AS-23 A hidden tab does not hold a connection | — | `components/seller/overview/live-panel.test.tsx` | — | S40 FR-031 |
| AS-24 Live activity refreshes the period numbers, at most every 30 seconds | — | `components/seller/overview/live-panel.test.tsx` (fake timers) | — | S40 FR-041 |
| AS-25 One stream per page, swapped when the shop changes | — | `components/seller/overview/live-panel.test.tsx` (`EventSource` stub counts connections) | — | S51 A-14, FR-008 |
| AS-26 "Today (UTC)" shows totals and a per-minute series | — | `components/seller/overview/overview-view.test.tsx` | — | S40 AS-46, AS-47 |
| AS-27 Live values are not read aloud every second | — | `components/seller/overview/live-panel.test.tsx` | — | — |
| AS-28 The inventory lists the shop's active products page by page | — | `components/seller/inventory/inventory-view.test.tsx` (proves: paging links, caption, ordering) | `tests/visual/seller-inventory.spec.ts` › list, mobile + desktop (proves: list layout) | S05 AS-14, AS-15 |
| AS-29 Status and stock filters live in the URL | — | `components/seller/inventory/inventory-view.test.tsx` | — | S05 AS-14 |
| AS-30 Search finds a product despite a typo | `tests/seller-inventory.spec.ts` › owner adds, finds, edits and archives a product (step 3) (proves: the typo search finds the product) | `components/seller/inventory/inventory-view.test.tsx` (proves: debounce, URL write, disabled tabs, hints) | — | S32 AS-62, AS-63, AS-64 |
| AS-31 Loading and refetching never flash an empty table | — | `components/seller/inventory/inventory-view.test.tsx` (proves: kept rows, `aria-busy`, error alert) | `tests/visual/seller-inventory.spec.ts` › loading and error, mobile + desktop (proves: skeleton and error layout) | — |
| AS-32 Three empty states say different things | — | `components/seller/inventory/inventory-view.test.tsx` (proves: the three messages) | `tests/visual/seller-inventory.spec.ts` › empty states, mobile + desktop (proves: empty layouts) | — |
| AS-33 Adding a product puts it in the list | `tests/seller-inventory.spec.ts` › owner adds, finds, edits and archives a product (step 1) | — | — | S05 AS-01 |
| AS-34 The form catches what it can, the server decides the rest | — | `components/seller/inventory/product-form.test.tsx` | — | S05 AS-02, AS-03 |
| AS-35 Prices are typed in major units and sent in minor units, exactly | — | `lib/seller/money-input.test.ts` (table-driven) | — | S05 AS-02, AS-03 |
| AS-36 Editing sends only what changed, against the version the seller saw | `tests/seller-inventory.spec.ts` › owner adds, finds, edits and archives a product (step 2) (proves: an edit of the stock shows in the row) | `components/seller/inventory/product-form.test.tsx` (proves: only changed fields, `expectedVersion`, disabled when unchanged) | — | S05 AS-07, AS-09 |
| AS-37 A conflicting edit is never silently overwritten | — | `components/seller/inventory/product-form.test.tsx` | — | S05 AS-10, AS-11, AS-20 |
| AS-38 Stock can be adjusted from the row | — | `components/seller/inventory/inventory-view.test.tsx` | — | S05 AS-07, AS-10 |
| AS-39 Stock status is a word, not only a colour | — | `components/seller/inventory/inventory-view.test.tsx` (table-driven 0, 3, 5, 6, archived) | — | S43 AS-28 |
| AS-40 Archive and restore | `tests/seller-inventory.spec.ts` › owner adds, finds, edits and archives a product (step 4) | — | — | S05 AS-16, AS-17, AS-18 |
| AS-41 Acting on a stale row is explained | — | `components/seller/inventory/inventory-view.test.tsx` | — | S05 AS-19, AS-21, AS-12 |
| AS-42 Viewers read, staff write | — | `lib/seller/permissions.test.ts` (table-driven over roles and permissions) | — | S05 AS-04, AS-05; S03 AS-16 |
| AS-43 Seller-typed text is shown as text | — | `components/seller/inventory/inventory-view.test.tsx` | — | S05 (plain-text assumption) |
| AS-44 The key list shows identity, never the secret | — | `components/seller/developers/api-keys-view.test.tsx` (proves: columns, statuses, empty text) | `tests/visual/seller-developers.spec.ts` › api keys list, mobile + desktop (proves: list layout) | S42 AS-01, AS-10, AS-11 |
| AS-45 Creating a test key shows the secret once | `tests/seller-developers.spec.ts` › owner creates a key, adds an endpoint and sends a test event (step 1) | — | — | S42 AS-01 |
| AS-46 A secret exists only in the open dialog | — | `components/seller/developers/secret-reveal-dialog.test.tsx` (asserts the query cache, URL, `localStorage`, `sessionStorage` and console hold no secret) | — | S42 FR-002, AS-01; S43 FR-015, AS-22 |
| AS-47 Copying reports its result, with a fallback | — | `components/seller/developers/secret-reveal-dialog.test.tsx` (clipboard stub: granted and denied) | — | — |
| AS-48 The create form constrains what it can | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 AS-02 |
| AS-49 A live key asks for a second step first | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 AS-04 |
| AS-50 The 25-key limit is explained | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 AS-05 |
| AS-51 Rotating a key keeps the old one alive for a stated overlap | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 AS-06 |
| AS-52 Illegal rotations are explained | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 AS-07 |
| AS-53 Revoking is immediate and says so | `tests/seller-developers.spec.ts` › owner creates a key, adds an endpoint and sends a test event (step 2) (proves: revoke happy path) | `components/seller/developers/api-keys-view.test.tsx` (proves: double press, focus on Cancel, successor untouched) | — | S42 AS-08, AS-09 |
| AS-54 Developer pages follow the member's permissions | — | `lib/seller/permissions.test.ts` (proves: the page and permission table and the panel) | `tests/visual/seller-shell.spec.ts` › forbidden panel, mobile + desktop (proves: the panel layout) | S42 AS-03; S43 AS-13; S03 AS-16, AS-17 |
| AS-55 The page tells the seller how to use a key | — | `components/seller/developers/api-keys-view.test.tsx` | — | S42 (Provides: public API) |
| AS-56 The endpoint list shows health at a glance | — | `components/seller/developers/webhooks-view.test.tsx` (proves: badges and notices) | `tests/visual/seller-developers.spec.ts` › webhooks list, mobile + desktop (proves: list layout) | S43 AS-05, AS-09 |
| AS-57 Adding an endpoint reveals its signing secret once | `tests/seller-developers.spec.ts` › owner creates a key, adds an endpoint and sends a test event (step 3) | — | — | S43 AS-01, AS-22 |
| AS-58 Event choices come from the catalogue | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-14, AS-04 |
| AS-59 Every rejection of the URL is explained at the URL | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-02, AS-03, AS-11, AS-12 |
| AS-60 Editing changes URL, events or version | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-07 |
| AS-61 Disabling and enabling an endpoint | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-08, AS-09 |
| AS-62 Rotating a secret, with an explicit overlap and early end | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-18, AS-19, AS-20, AS-21 |
| AS-63 Deleting an endpoint | — | `components/seller/developers/webhooks-view.test.tsx` | — | S43 AS-10, AS-13 |
| AS-64 A test event can be sent to one endpoint | `tests/seller-developers.spec.ts` › owner creates a key, adds an endpoint and sends a test event (step 4) (proves: a ping delivery appears) | `components/seller/developers/webhook-detail-view.test.tsx` (proves: toast, 5-second refetch window, `429` countdown) | — | S43 AS-65 |
| AS-65 The delivery log explains what happened | — | `components/seller/developers/webhook-detail-view.test.tsx` (proves: columns, filter, paging, empty text) | `tests/visual/seller-developers.spec.ts` › webhook deliveries, mobile + desktop (proves: log layout) | S43 AS-60 |
| AS-66 One event can be inspected | — | `components/seller/developers/webhook-detail-view.test.tsx` | — | S43 AS-61 |
| AS-67 Replay is explicit and safe to repeat | — | `components/seller/developers/webhook-detail-view.test.tsx` | — | S43 AS-62, AS-63, AS-64 |
| AS-68 The API version can be changed deliberately | — | `components/seller/developers/api-version-view.test.tsx` (proves: badges, confirm, toast) | `tests/visual/seller-developers.spec.ts` › api version, mobile + desktop (proves: page layout) | S42 AS-30 |
| AS-69 A deprecated pin is a warning, a retired one a refusal | — | `components/seller/developers/api-version-view.test.tsx` | — | S42 AS-30, AS-31 |
| AS-70 Request logs can be searched and shared as a link | — | `components/seller/developers/request-logs-view.test.tsx` (proves: filters in the URL and the table) | `tests/visual/seller-developers.spec.ts` › request logs, mobile + desktop (proves: filter bar and cards) | S42 AS-60 |
| AS-71 The date range can't be wrong in the form | — | `components/seller/developers/request-logs-view.test.tsx` | — | S42 AS-60 |
| AS-72 A log row can be copied into a support request | — | `components/seller/developers/request-logs-view.test.tsx` | — | S42 AS-58, AS-60 |
| AS-73 Usage per day, version and route | — | `components/seller/developers/usage-view.test.tsx` (proves: table, totals, empty text) | `tests/visual/seller-developers.spec.ts` › usage, mobile + desktop (proves: table layout) | S42 AS-63 |
| AS-74 The team list shows who can do what | — | `components/seller/team/team-view.test.tsx` (proves: columns and self marker) | `tests/visual/seller-team.spec.ts` › members, mobile + desktop (proves: list layout) | S03 FR-005, AS-07 |
| AS-75 Changing a role | — | `components/seller/team/team-view.test.tsx` | — | S03 AS-18, AS-19, AS-22, AS-23, AS-24 |
| AS-76 Removing a member, or leaving | — | `components/seller/team/team-view.test.tsx` | — | S03 AS-21, AS-25 |
| AS-77 Inviting by e-mail | — | `components/seller/team/team-view.test.tsx` | — | S03 AS-28, AS-29, AS-30, AS-31, AS-39 |
| AS-78 Invitations can be resent and revoked | — | `components/seller/team/team-view.test.tsx` | — | S03 AS-34, AS-36, AS-37 |
| AS-79 The roles matrix is readable without colour | — | `components/seller/team/team-view.test.tsx` | — | S03 AS-82 |
| AS-80 Accepting an invitation from the e-mail link | `tests/seller-team.spec.ts` › invitee accepts an invitation (proves: accept happy path) | `app/invites/[token]/accept-invite.test.tsx` (proves: toast text, `alreadyMember`, history replace, signed-out redirect) | — | S03 AS-32, AS-35 |
| AS-81 Every refusal of an invitation reads the same | — | `app/invites/[token]/accept-invite.test.tsx` | — | S03 AS-32, AS-33, AS-39 |
| AS-82 The invitation token stays private | — | `app/invites/[token]/accept-invite.test.tsx` (the response header is asserted in W07's `next.config.ts` test) | — | S03 FR-030 |
| AS-83 The shop's orders, without buyer identity | — | `components/seller/orders/orders-view.test.tsx` (proves: columns, filter, no buyer id) | `tests/visual/seller-team.spec.ts` › orders, mobile + desktop (proves: list layout) | S10 AS-61 |
| AS-84 Anonymous visitors are sent to sign in and come back | — | `components/dashboard/dashboard-shell.test.tsx` (server guard called with the path and query) | — | W01 (guards) |
| AS-85 A shop that isn't yours does not exist | — | `components/dashboard/dashboard-shell.test.tsx` (table-driven: unknown, malformed, foreign) | — | S03 AS-09, AS-15 |
| AS-86 A suspended or closing shop is read-only and says why | — | `components/dashboard/dashboard-shell.test.tsx` (proves: banner text and disabled controls) | `tests/visual/seller-shell.spec.ts` › suspended banner, mobile + desktop (proves: banner layout) | S03 AS-12; S05 AS-13 |
| AS-87 An expired session ends politely, once | — | `components/seller/problem-states.test.tsx` | — | W01 AS-26; S42 AS-04 |
| AS-88 Offline is visible and recoverable | — | `components/seller/problem-states.test.tsx` (proves: banner, alert, refetch on reconnect) | `tests/visual/seller-shell.spec.ts` › offline banner, mobile + desktop (proves: banner layout) | — |
| AS-89 Server errors are generic but traceable | — | `components/seller/problem-states.test.tsx` (table-driven over the error catalogue rows, including `invalid_cursor`) | — | S54 / constitution V.3 |
| AS-90 Rate limits show a countdown | — | `components/seller/problem-states.test.tsx` (fake timers) | — | S03 AS-39; S05 AS-22; S43 AS-15 |
| AS-91 Every page has a loading state that matches its layout | — | `components/dashboard/dashboard-shell.test.tsx` (proves: skeleton present, no "Loading...") | `tests/visual/seller-shell.spec.ts` › loading skeletons, mobile + desktop (proves: skeleton layout without shift) | — |
| AS-92 Server data, URL state and local state each have one home | — | `lib/architecture.test.ts` | — | constitution VI.3, VI.4, VI.6 |
| AS-93 No token or credential in browser JavaScript | — | `lib/architecture.test.ts` | — | constitution VI.2 |
| AS-94 Dialogs and menus work from the keyboard | — | `components/seller/inventory/inventory-view.test.tsx` (the shared dialog and menu behaviour is asserted once, on the richest screen) | — | — |
| AS-95 Tables and forms are understandable with a screen reader | — | `components/seller/inventory/product-form.test.tsx` (form errors; the table semantics are asserted once, on the inventory table) | — | — |
| AS-96 Overview layout at 390 px and 1280 px | — | — | `tests/visual/seller-overview.spec.ts` › overview layout | — |
| AS-97 List pages at 390 px and 1280 px | — | — | `tests/visual/seller-inventory.spec.ts` › list layout; `tests/visual/seller-developers.spec.ts` › list layouts; `tests/visual/seller-team.spec.ts` › list layouts | — |
| AS-98 The shell at 390 px and 1280 px | — | `components/dashboard/dashboard-shell.test.tsx` (proves: drawer open and close, focus return, `aria-current`) | `tests/visual/seller-shell.spec.ts` › shell, mobile + desktop (proves: shell layouts) | — |

## Coverage check

- Scenarios: 98. Every scenario has at least one layer (0 rows without one).
- Journeys (5 files; each flow's happy path is written once): shop entry and overview (AS-01, AS-03, AS-08, AS-09, AS-10); live numbers (AS-19); inventory (AS-33, AS-36, AS-30, AS-40); developers (AS-45, AS-53, AS-57, AS-64); invitation (AS-80). Fifteen scenarios carry a journey step, in seven Playwright tests across five files (`seller-shop.spec.ts` has three tests).
- Constitution VII.7: no journey repeats an edge case the API proves; every validation, conflict, limit and permission case is a unit test with a problem+json fixture, or a backend scenario named in the last column.
- Pattern rows: P0406 → AS-19, AS-20, AS-21, AS-22, AS-23, AS-24, AS-25, AS-27; P0901 → AS-12, AS-29, AS-30, AS-70, AS-73, AS-92.
- The architecture test `lib/architecture.test.ts` is shared with W03 and W01; W04 adds its own assertions (AS-92, AS-93), not a second file.
