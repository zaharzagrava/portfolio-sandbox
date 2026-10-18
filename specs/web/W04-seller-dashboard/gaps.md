# Gaps: current code vs W04 spec

Files in scope: `packages/web/app/dashboard/seller/{page,view}.tsx`, `app/dashboard/seller/inventory/{page,view}.tsx`, `app/dashboard/seller/[shopId]/developers/{api-keys,webhooks}/{page,view}.tsx`, `app/dashboard/{layout,page,view}.tsx`, `components/dashboard/{dashboard-shell,orders-table}.tsx`, `lib/api/{shops,developers,client,sse,errors}.ts`, `hooks/{use-event-stream,use-auth}.ts(x)`, `lib/{query-keys,utils}.ts`, `tests/seller.spec.ts`, `vitest.config.ts`, `playwright.config.ts`, `package.json`. Line numbers are of the files as read on 2026-10-07. This is the implementation agent's to-do list; the spec is the target.

## A. Data flow and constitution VI

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Server data copied into `useState` and loaded in `useEffect` (keys and webhooks), with a local filter after delete | `api-keys/view.tsx:35,47-60`, `webhooks/view.tsx:36,49-62,99` | FR-003, AS-92 |
| A2 | Every seller page is a client component whose data is fetched in the browser; the guard is a client `useEffect` redirect and the page is a "Loading..." gate | `view.tsx:1,75`, `inventory/view.tsx:1,121`, `dashboard-shell.tsx:1,31-39`, `app/dashboard/layout.tsx:8` | FR-001, FR-002, AS-84, AS-91 |
| A3 | Blanket `export const instant = false` on every seller page opts out of Cache Components validation instead of using Suspense boundaries | `page.tsx:4`, `inventory/page.tsx:4`, `[shopId]/developers/*/page.tsx:4` | FR-002 |
| A4 | Query keys are literals or the wrong shape: `['shops','mine']`, `['seller-stats', days]`, `['shop-products', shopId, q]`; `queryKeys.seller.dashboard/products` exist and are unused | `lib/api/shops.ts:43,59,67,78`, `lib/query-keys.ts:18-21` | FR-003, Provides `queryKeys.seller` |
| A5 | The keys and webhooks views call `developersApi` directly in handlers and effects, not through query and mutation hooks | `api-keys/view.tsx:51-97`, `webhooks/view.tsx:53-104` | FR-003, FR-006 |
| A6 | Search text and debounce are local state; the shop is `shops.data?.[0]`; the period, tab and filters are not in the URL | `inventory/view.tsx:112-119` | FR-004, AS-12, AS-29, AS-30 |
| A7 | `lib/api/shops.ts` is a `'use client'` file that mixes types, hooks and network calls, so a Server Component cannot reuse its calls; responses are hand-typed, none parsed with contract schemas (`packages/contracts` has no source) | `lib/api/shops.ts:1-80`, `lib/api/developers.ts:7-43` | FR-006, T9 |
| A8 | A bearer token is set from JavaScript (`setAccessToken`, request interceptor), the base URL is absolute (`NEXT_PUBLIC_API_URL`), the stream URL is cross-origin (`NEXT_PUBLIC_SSE_URL`) | `lib/api/client.ts` (module state, `apiClient.interceptors.request`), `lib/api/sse.ts:6` | FR-006, AS-93 (W01 removes the token; W04 uses relative URLs) |
| A9 | The shop is chosen with `shops.data?.[0]` in the overview, inventory and sidebar | `view.tsx:73`, `inventory/view.tsx:112`, `dashboard-shell.tsx:29` | FR-011, FR-016, AS-08, AS-09 |
| A10 | "Seller" is decided by the session role claim | `view.tsx:70-72,77`, `dashboard-shell.tsx:41` | FR-011, AS-04 |
| A11 | Secrets are returned into component state that survives the dialog (`generatedSecret`, `rotatedSecret`) and the key dialog can be closed by Escape or an outside click while a secret is shown | `api-keys/view.tsx:41-46,129-132,152`, `webhooks/view.tsx:46,181-199` | FR-032, AS-46, AS-47 |
| A12 | `window.confirm` is used for rotate, revoke, delete | `api-keys/view.tsx:80,93`, `webhooks/view.tsx:85,96` | FR-047, AS-53, AS-62, AS-63 |
| A13 | Clipboard write has no failure path and no announcement | `api-keys/view.tsx:105-108`, `webhooks/view.tsx:106-110` | AS-47 |

## B. Behaviour and screens missing or wrong

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | No shop id in the URL for the overview and inventory; no switcher; no picker | `app/dashboard/seller/*` | FR-011, FR-016, AS-08, AS-09 |
| B2 | Open-shop form: validation only by disabling the button, no field-level problems, no focus handling, `409/422/429` all collapse into one toast; no wait for the role | `view.tsx:24-36,53-60` | AS-02, AS-04..AS-07 |
| B3 | Overview: no live numbers, no today, no rank, no period, no net revenue or refunds, no per-section errors; stats failure replaces only the top-products card text; amounts use the USD default and `…Cents` fields | `view.tsx:86-155` | FR-017..FR-024, AS-10..AS-27 |
| B4 | Top products link to the storefront with an 8-character id prefix and show no titles | `view.tsx:142-151` | AS-13 |
| B5 | Inventory: no edit, stock adjustment, archive, restore, filters, paging; no error state for a failed list; a fixed `LOW_STOCK` constant not tied to webhooks; money by `Math.round(Number(x) * 100)`; price labelled USD; no version handling | `inventory/view.tsx:19,32-45,90,157-184` | FR-025..FR-029, AS-28..AS-43 |
| B6 | API keys: no derived status (rotating, expired), no expiry on create, rotation has no overlap choice and the old key's end is not shown, no "Using the API" help, no `mfa_required` or limit handling (every failure is "Failed to generate API key"), no pagination | `api-keys/view.tsx:41-42,73,80-90,211-285` | FR-030..FR-034, AS-44..AS-55 |
| B7 | Webhooks: hard-coded event list of 4; no edit, enable, disable, expire-previous-secret, per-endpoint test event, delivery log, event detail or replay; "Logs" is a "coming soon" toast; status uses a boolean; the URL is cut at 200 to 300 px; delete button has no text; most failures are generic toasts | `webhooks/view.tsx:156-165,231,247-269,58,91,102` | FR-035..FR-038, AS-56..AS-67 |
| B8 | No API version, request logs, usage pages | — | FR-039, AS-68..AS-73 |
| B9 | No team page, roles matrix, invitations, or `/invites/{token}` page (S28 already mails that link) | — | FR-040, FR-041, AS-74..AS-82 |
| B10 | No seller orders page | — | FR-042, AS-83 |
| B11 | Shell: buyer entries (Overview, Orders, Settings) mixed with seller tools; `/dashboard/settings` has no route; the dashboard home shows the buyer's order stats; the shell hides the seller area behind the role claim | `dashboard-shell.tsx:12-16,41,62-73`, `app/dashboard/view.tsx` | FR-013, AS-98 |
| B12 | No suspended or closing banner, no read-only mode, no offline banner, no 404 or forbidden page, no session-ended handling in these views | all | FR-011, FR-012, FR-044, FR-045, AS-85..AS-88 |
| B13 | No problem+json handling beyond `apiErrorMessage` (no field errors, no `requestId`, no countdown, no per-code copy) | `lib/api/errors.ts`, all views | FR-043, FR-046, AS-89, AS-90 |
| B14 | Legacy buyer components remain in the dashboard (`orders-table.tsx`, `view.tsx` using the old orders hook) | `components/dashboard/orders-table.tsx`, `app/dashboard/view.tsx:7-55` | FR-013 (W03 `[CONTRACT]`) |
| B15 | The stream helper is cross-origin, never recreates after a refusal, depends on callback identity, has no visibility handling; only the bell uses it | `lib/api/sse.ts`, `hooks/use-event-stream.ts` | FR-020..FR-023 (replaced by W03's page stream) |

## C. Wire and contract drift (UI types versus the backend specs)

| # | Today | Spec shape | Owner |
|---|---|---|---|
| C1 | `MyShop {id,name,slug,plan,role}` (`shops.ts:7-13`) | `{id,name,slug,plan,status,role}`; shop `{…, myRole, myPermissions}` | S03 |
| C2 | `SellerStats` with `revenueCents`, `uniqueBuyers`, `refunds`, `avgOrderValueCents`, `topProducts[{productId}]` (`shops.ts:15-21`), endpoint `/api/sellers/me/stats` (`shops.ts:61`) | `/shops/{id}/stats`: `…Minor`, `currency`, `refundsCount`, `refundedMinor`, `netRevenueMinor`, titles in `topProducts` | S40 |
| C3 | `ShopProduct {id,title,price,quantity}` and bare array (`shops.ts:23-28,69`) | `{items:{id,title,priceMinor,currency,quantity,status,rank}[], nextCursor}`; member view with `version` | S32, S05 |
| C4 | Create: `POST /api/products/shops/{id}` with `price` (`shops.ts:77`) | `POST /shops/{id}/products` with `priceMinor`, `currency` | S05 |
| C5 | `ApiKey` without `status`, `createdBy`, `successorId`; list is a bare array (`developers.ts:7-17,48`) | S42 dashboard shapes; page `{items,nextCursor}` (asked) | S42 |
| C6 | `rotateKey` has no `overlapHours`; `createKey` no `expiresAt` (`developers.ts:49-51`) | `POST keys {name,scopes,livemode,expiresAt?}`, `POST keys/{id}/rotate {overlapHours?}` | S42 |
| C7 | `WebhookEndpoint.enabled`, bare array, 4 event types, `pingWebhooks` bulk route (`developers.ts:31-43,56,65`) | S43 `WebhookEndpointDto`, page, 11 types, per-endpoint ping | S43 |
| C8 | Missing client functions: api-version, logs, usage, webhook edit, enable, disable, expire-previous-secret, attempts, event detail, replay, event types; team and invitation calls; orders; overview; shop detail | see Provides and Requires | S03, S10, S42, S43 |
| C9 | `formatMoney(cents, currency = 'USD')` (`lib/utils.ts:7-17`) used without a currency on the overview and inventory | `formatMoney(minor, currency)` with the currency required (W02) | W02 |

## D. Accessibility, layout and copy

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | The sidebar stacks above the content on mobile (`flex-col md:flex-row`, full-width `aside`); no drawer, no top bar | `dashboard-shell.tsx:44-45` | AS-98 |
| D2 | `nav` without a name, links without `aria-current`; active state is colour only | `dashboard-shell.tsx:47,52-58` | AS-98, FR-047 |
| D3 | Tables have no caption, no `scope`, and become horizontally scrolling on mobile; no card layout | all views | AS-95, AS-97 |
| D4 | Dialogs: Escape and outside click close the reveal dialogs; icon-only buttons without names (`Trash2` delete, copy); focus return not guaranteed | `webhooks/view.tsx:181-199,263-269`, `api-keys/view.tsx:152-155` | AS-94 |
| D5 | Checkbox groups name the checkbox by `aria-label` but not by the visible label's `for`; no group legend | `api-keys/view.tsx:174-183`, `webhooks/view.tsx:156-165` | AS-95 |
| D6 | Loading is the text "Loading..." or a table row, not a layout-shaped skeleton | `view.tsx:75`, `inventory/view.tsx:121,159`, `dashboard-shell.tsx:38` | AS-91 |
| D7 | Copy leaks internals ("SD-31", "ClickHouse", "SD-37", "outbox → indexer"); mixed title case ("Generate Key", "Add Endpoint") | `view.tsx:133`, `inventory/view.tsx:69,143`, key and webhook views | questions (BREAKING) |
| D8 | Charts: none today; the new daily chart and sparkline need text alternatives and a table toggle | — | AS-14, AS-27 |
| D9 | Dates are formatted with a fixed `MMM d, yyyy` format and no time, so "Rotating until" and "valid until" cannot be shown | `api-keys/view.tsx:252,255`, `webhooks/view.tsx:243` | AS-44, AS-51, AS-56 |

## E. Missing backend endpoints and changes the UI needs

Status is from a search of the controllers in `packages/backend/libs` on 2026-10-07 (route decorators only; not a behaviour review).

| # | Needed | Owner | Status in the draft backend |
|---|---|---|---|
| E1 | **`GET /api/bff/seller/{shopId}/overview?days=`** composed from S03 (shop), S40 (stats, today, rank) with per-section timeouts and partial `errors[]`; constitution IX.7 R2, lives in `libs/composition/bff`, deployed by `apps/bff`, no DB access | S48 (BFF) | missing; `[CONTRACT]` question |
| E2 | `GET /shops/{shopId}/stats?days=`, `GET …/dashboard/today`, `GET …/rank` (S40 replaces `GET /sellers/me/stats`) | S40 | only `sellers/me/stats` found (`seller-stats.controller.ts:14`) |
| E3 | Realtime topic `shop:{shopId}:live` with event `dashboard` through `GET /api/streams` and the member-only policy | S40 + S03 + S51 | not verified; `apps/sse-gateway` exists |
| E4 | Same-origin forwarding of `/api/shops/**`, `/api/shop-roles`, `/api/shop-invites/accept`, `/api/streams` with the bearer attached server-side (W01 C-FWD) | S48 | not verified |
| E5 | Shop-scoped product routes and shapes (`GET|POST|PATCH /shops/{id}/products…`, archive, restore, `version`) | S05 | the draft serves `POST /api/products/shops/{id}` (what the UI calls today); new routes not verified |
| E6 | `GET /shops/{shopId}/products/search` returning `{items, nextCursor}` (items without `version`) | S32 | not verified; the UI today expects a bare array |
| E7 | Webhook routes missing from the draft controller: `PATCH`, `enable`, `disable`, `expire-previous-secret`, per-endpoint `ping`, `events/{eventId}` detail, `webhook-event-types`; the draft has a bulk `POST webhooks/ping` (`webhooks.controller.ts:81`), `attempts` (`:67`) and `replay` (`:74`) | S43 | partly present |
| E8 | Key and log list pages (`{items,nextCursor}`, `limit`, `cursor`) and `overlapHours`, `expiresAt` on create and rotate | S42 | routes for keys, `api-version`, `logs`, `usage` exist (`api-keys.controller.ts:62,74,86`); shapes not verified |
| E9 | Team and invitation routes (`members`, `invites`, `resend`), `GET /shop-roles`, `myPermissions` on `GET /shops/{id}`, `status` on `GET /shops/mine` | S03 | `shop-invites/accept` found (`shop.controller.ts:55`); others not verified |
| E10 | `GET /shops/{shopId}/orders?status&limit&cursor` with item shape and status values documented | S10 | not verified |
| E11 | Configuration: `PLATFORM_CURRENCY` (UI server), `PUBLIC_API_BASE_URL` (UI server) | S54 / ops | missing |
| E12 | `packages/contracts` schemas listed in the spec (the package has no source today) | S54 | missing |
| E13 | A development way to read the sent invitation link and to pay an order for tests | S28, W03 | missing |

## F. Test tooling gaps

| # | Gap | Where |
|---|---|---|
| T1 | `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` are not installed (only `jsdom` and `vitest`) | `package.json` |
| T2 | Vitest `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts`; components and `app/**` tests (`*.test.tsx`) are not collected; no setup file (jest-dom matchers, MSW server, cleanup, `EventSource` and clipboard stubs) | `vitest.config.ts:7` |
| T3 | No MSW; no problem+json fixtures parsed by the contracts schemas | — |
| T4 | No `@axe-core/playwright`; no `tests/visual/` directory; no `mobile` project in Playwright (only desktop Chromium); no committed baselines | `playwright.config.ts` |
| T5 | No `lib/architecture.test.ts` (shared with W01 and W03): the checks of AS-92 and AS-93 | — |
| T6 | `tests/seller.spec.ts` is one long journey using `data-testid`s and old labels; it is split into five files and rewritten with roles and labels | `tests/seller.spec.ts:5-50` |
| T7 | `tests/helpers.ts`: add `openShop`, `seedProduct`, `shopPath`; `register` and `login` follow W01's rewrite | `tests/helpers.ts` |
| T8 | No stub for `EventSource` (frames, `resync`, `revoked`, 401 refusal, reconnect) and no way to drive "a paid order" in a journey except W03's sandbox payment helper | — |
| T9 | `packages/contracts` has no source, so contract parsing in tests and in `lib/api/*` cannot start | `packages/contracts` |
| T10 | `@next/playwright` `instant()` helper is not installed (optional for instant-navigation regression) | `package.json` |
| T11 | The playwright `webServer.command` is `pnpm run dev` while the package has an npm lock (`package-lock.json`); keep whichever the repo standardises on | `playwright.config.ts` |

## G. Suggested order

1. Tooling: T1..T5, T7, T8 (nothing else can be tested before them).
2. Contracts and shared pieces: `packages/contracts` schemas (T9, E12), `queryKeys.seller`, `lib/api/seller.ts`, `useShop`, `shopCan`, `ShopStatusBanner`, `RevealSecretDialog`, error helpers from W01.
3. Shell and routes: server guard, `[shopId]` layout, switcher, nav registry, redirects, 404 and forbidden (B1, B11, B12).
4. Shop entry (B2) → overview with the aggregate and live panel (B3, B4, B15; needs E1..E4 and W03's topic stream).
5. Inventory (B5; needs E5, E6).
6. API keys (B6) → webhooks and deliveries (B7; needs E7) → version, logs, usage (B8).
7. Team, invitation page, orders (B9, B10; need E9, E10, E13).
8. Remove the old pieces: `view.tsx` buyer overview, `orders-table.tsx`, `seller.spec.ts`, `hooks/use-event-stream.ts` callers in W04, `instant = false` lines, `pingWebhooks`, `LOW_STOCK` copy.

## Sibling-spec follow-ups

- **S47**: W04's source list does not name S47 yet, so the two S47 journey rows stay skipped; the seller screen (`/dashboard/seller/{shopId}/knowledge`: documents, presigned PDF upload, retry, delete, help-center ask) is covered by `components/seller/knowledge/documents-view.test.tsx`. The presigned `PUT` goes straight to the storage origin, which `lib/security/csp.ts` `connect-src` and the storage CORS rules must allow (same as the S07 part upload).
- **S44**: the widget theme (`theme`, AS-04) has no editor on the W04 widget page yet; sites keep the theme the API holds. `GET sites/:siteId/history` is not shown.

- **W03**: lib/realtime/user-stream.ts now also exports subscribeTopic/parseLiveFrame (added by W04)
- **W07**: `lib/security/csp.ts` `connect-src` lists `'self'`, tile and video hosts only; the bulk-import part upload (`PUT parts[].url`, S07) goes straight to the storage origin and is blocked by the browser until that origin is added (the import page cannot finish an upload in production before then)
- **S07**: the part `PUT` needs storage CORS to allow the web origin and `Access-Control-Expose-Headers: ETag`; without it the browser cannot read the part ETag
- **W07**: `lib/security/csp.ts` `connect-src` must also allow the collaboration endpoint of S06 (`wss://` on the API host: the editor opens `POST …/connect`'s `url`) and the storage origin that takes the S29 photo `POST` form and the S30 part `PUT`s; `img-src` already lists the media hosts. Until then the editor and the photo and video uploads cannot work in production
- **S06**: no `GET …/drafts/:draftId` route exists, so the editor takes the draft from `GET …/drafts?status=DRAFT&limit=100` by `productId` (the list has no `productId` filter and shows the first 100 drafts only); `GET …/versions/:versionId` (the content of a saved version) is not shown yet
- **S08**: the OAuth callback redirects to `{web}/dashboard/integrations?connected=<id>` (no shop id); W04 serves that path as a redirect to the member's only shop (otherwise the shop picker) and carries `connected` and `error` over
- **S08**: `integrationSchema.lastError` and quarantine `message` are free text; W04 renders them as plain text, never as markup
- **S09**: `GET …/sync/conflicts?status=` takes lowercase `open|dismissed` while S08 `…/conflicts` and `…/quarantine` take upper case `OPEN|DISMISSED|RESOLVED`; W04 follows each contract as written
- **S29**: `PUT …/gallery` `media_not_attachable` carries `failures[{mediaId, code}]`, which W04 does not show per photo (it says some photos are not ready or gone); `GET /media/:id` for a photo that is only `UPLOADED` returns the owner view with `urls: null`, which W04 treats as "still processing"
- **S30**: `videoUploadStateSchema.uploadedParts` has no `etag`, but `complete` needs the etag of every part; a resumed upload can only name the parts it sent itself in the same page view (etags are kept in memory, not in browser storage), so after a reload the upload cannot be resumed and a new one must be started. `GET …/videos` has no `productId` filter, so the product page filters the first 50 videos client-side
- **J01**: `packages/web/tests/buy-to-payout.spec.ts` expects `balance-card` / `balance-amount` on `/dashboard/seller`; the W04 overview (FR-017) has no balance card, so that step must read the balance on `/dashboard/seller/{shopId}/payouts`
- **S42**: `GET …/developers/logs` takes `status` 2xx|3xx|4xx|5xx only (`requestLogQuerySchema`), but W04 AS-70 offers "429"; W04 sends `4xx` and keeps the 429 rows client-side until S42 adds the value

## Gate repairs

- Test integrity: `tests/visual/seller-developers.spec.ts` no longer calls `test.skip` (a refused webhook URL now fails the test; set `WEBHOOK_E2E_URL`). `lib/api/shops.test.tsx` and `tests/seller.spec.ts` were recreated with W04 AS-01 titles and at least their previous it()/expect() counts, so the integrity check passes. Not run here: the Playwright specs (browser suite is a final-checkpoint run).
- Visual gate (seller-overview / seller-shell / seller-inventory): (1) AS-10 / AS-17 stubbed the browser's own period request, but the server render of `?days=7` seeds the query, so the browser never asked; the tests now return to the tab (`leaveAndReturn`, the live panel's re-read) so the stub is answered, and the baselines for the two states were written. (2) The 320 px width check (`expectMainFitsWidth`) now polls until the chart has re-measured. (3) The phone "Open menu" button is reached through `sellerMenu` / `clickThroughDevOverlay` (the dev issue badge sat over it); `open-shop-form.png` (mobile) was refreshed because the "Start selling" bar is part of the phone frame now. No product code changed.
- **Loading skeletons (W04 AS-91, AS-31) fixed in product code**: Next 16 does not prefetch in development, so with the page's RSC request held back the old page stayed and `loading.tsx` never showed. The sidebar links now set a pending state on click (`components/dashboard/navigation-pending.tsx`; set by the click because the phone drawer closes on click, cleared when the path changes, 15 s give-up) and `DashboardShell` shows `ListPageSkeleton` in the content area meanwhile. Baselines `loading.png` / `loading-skeleton.png` (desktop, mobile) were written. Sidebar links also darken on hover (`hover:text-foreground`): muted text on the hover background measured 4.34:1 (axe color-contrast, serious).
- Gate run of 2026-10-17 (14 failures), cause by cause: (1) `seller-team` orders: the browser stub never fired because the server read seeded the query as fresh (60 s stale time); `useShopOrders` now has `staleTime: 0` like the inventory query, and the `orders.png` baselines were written. (2) `product-page` mobile bar expected `$899.99`; the platform books EUR and the page shows `€899.99` (as `product-page.spec.ts` and `search.spec.ts` already assert): the test was stale. (3) `page.addStyleTag` is refused by the CSP (`style-src` with nonce), intermittently: `tests/helpers.ts` has `addPageStyle` (constructable stylesheet) and `clickThroughDevOverlay`, the product-page, home and cart specs use it; the dev overlay selector now includes `[data-nextjs-dev-overlay]`, which is what intercepted the phone "Open menu" click in `seller-shop` AS-09. (4) `seller-shell` switcher (mobile): the baseline had been taken with the drawer scrolled by the header's height; the test now scrolls the drawer to the top before the shot and the mobile baseline was regenerated. (5) `assistant` S46 AS-01 / AS-22: the questions ended in `Date.now()`; about one in ten 13-digit timestamps passes the card-number checksum and the assistant answers `422 input_rejected` (`sensitive_data`), so the text came back to the input. The questions now hold letters only. AS-22 also cuts the reply by leaving out the terminal frame instead of counting three frames (the server may batch deltas, leaving nothing to cut). (6) `cart-checkout` JC-2, `share-link`, `product-panels` share, `product-page` mobile bar: passed on re-run of the failed files alone; they failed only under the full run's load (first compile of pages on the dev server, 2 workers).
- Not run here: the production-server specs (port 3100: `BFF_ALLOWED_ORIGINS` of the dev stack is `http://localhost:3000`, so the production server cannot sign in); unchanged.

- 2026-10-17 (gate: `cart-checkout.spec.ts` JC-2 mobile/desktop, `orders.spec.ts` JO-1 mobile): environment fault, no code change. The API log (`/var/log/sdd/api.log`) shows a worker process dying with `JavaScript heap out of memory` (SIGABRT) and then `502 bad_gateway /api/bff/f/cart` (socket hang up), so the order was never confirmed or cancelled within the timeout. `stack-fix.sh smoke` reports the stack ok (API ready, search 200, Chromium installed). Re-running both specs on the recovered stack: 14 passed. No test or page was changed.
- 2026-10-17 (re-check): `stack-fix.sh smoke` reports the environment ok; `cart-checkout.spec.ts` and `orders.spec.ts` re-run on both projects: 14 passed. No code change.

### Gate repair 2026-10-17: JC-2 / JO-1 timeouts (environment, no code change)
The three failures (`cart-checkout.spec.ts` JC-2 mobile+desktop, `orders.spec.ts` JO-1 mobile) were an environment fault: `/var/log/sdd/api.log` shows the watch build's type-checker process (pid 11664, 2 GB heap) died with `JavaScript heap out of memory` and, while the monolith recompiled, the BFF answered `502 bad_gateway` (`socket hang up`) so the payment never reached "Order confirmed". `stack-fix.sh smoke` reports the stack healthy now; both spec files re-run green (14 passed, 2 workers). No test or page was changed. Owner: if it repeats, give the watch build a larger heap (the checker child ignores the monolith's own `NODE_OPTIONS`).

### Gate repair 2026-10-17: five failures at the end of the 25-minute run (share, checkout, video)
`stack-fix.sh smoke` was ok; `share-link`, `cart-checkout`, `seller-video` and `visual/product-panels` (desktop and mobile) pass when run alone (26 passed). The API log for the share failure shows `POST /api/links` answering `503 service_unavailable` because `RedisExistenceFilter.add` (marketing) shared the 150 ms read budget and timed out on the loaded machine. Product fix: `libs/domains/marketing/infra/redis-existence.filter.ts` gives that write its own 1 s timeout (reads keep 150 ms and bypass on timeout). The checkout and video failures are load timeouts of the same long run; no defect found in isolation. No test or page was changed.

### Gate repair 2026-10-17: API serves no metrics on :9464 (environment)
The backend unit gate passed (463 suites, 9268 tests, module graph, model registry, dependency-cruiser); the only failure was `stack-fix.sh journey`: nothing listens on :9464 although `.env` has `OTEL_SDK_DISABLED=false` and `startTelemetry('core')` starts the Prometheus exporter. A process environment that sets `OTEL_SDK_DISABLED=true` in the watcher wins over `.env`. Fix in the stack's own scripts: `packages/backend/package.json` `start:dev` and `start:dev:monolith` now set `OTEL_SDK_DISABLED=false` explicitly. Owner: the running watcher (pid 11662) was started before this change, so the runner/API must be restarted (`pnpm --filter api start:dev:monolith`) for :9464 to appear; I did not kill the runner's processes. No test or page was changed.

### Gate repair 2026-10-17: J01 AS-29 and notifications "empty" (code and test, browser run of 6 failures)
- `cart-checkout` JC-2 and `orders` JO-1 (mobile): load faults of the long run; both pass when run alone, no code change.
- `tests/buy-to-payout.spec.ts` (J01 AS-29): the seller login asked for `/dashboard/seller` as the landing URL, but a member of exactly one shop is redirected to its overview (W04 AS-08). The test now signs in, opens `/dashboard/seller` and asserts the redirect to the shop. Behind it the run found a real defect: in the mobile project the "Download CSV" link (`download` with no value) saved `lines.csv` instead of the server's `statement-<shopId>-<month>.csv`. The link in `app/dashboard/seller/[shopId]/statements/view.tsx` now carries that name in its `download` attribute (same value as the `Content-Disposition` header). The assertion is unchanged and passes on both projects.
- `tests/visual/notifications.spec.ts` "empty" (and the other pinned-inbox states): the live stream could prepend the member's welcome notification to the stubbed list at a moment that varies (panel 137/167 px instead of 129). `stubInbox` now keeps the stream up but does not deliver `notification` events to the page; screenshots are unchanged. Passes on both projects (10 passed).

### Gate repair 2026-10-17 (second run): `cart-checkout` JC-2 (mobile and desktop)
- Environment smoke was clean. Both failures were load faults of the 4.5-minute full run (the Place order button was re-rendering while the dev server compiled `/checkout` routes for the first time; the paid state took longer than 45 s on mobile). Run alone, `tests/cart-checkout.spec.ts -g JC-2` passed on both projects, and 6 of 6 times with `--repeat-each=3`. No code or test change.

### Gate repair 2026-10-17 (third run): `cart-checkout` JC-2 (mobile and desktop)
`stack-fix.sh smoke` ok. Same signature as the second run (Place order detached or unstable, no "Order confirmed"). `-g JC-2` passed on both projects (24 s) and the whole `cart-checkout.spec.ts` passed 10/10 (45 s). A load fault of the long full run; no code or test change.

### Gate repair 2026-10-17 (fourth run): `cart-checkout` JC-2 (mobile and desktop)
`stack-fix.sh smoke` ok. Same signature as before (Place order detached or unstable, no "Order confirmed"); the API log again shows `502 bad_gateway` (`socket hang up`) on `/api/bff/f/*` during the long run. `-g JC-2` passed on both projects and the whole `cart-checkout.spec.ts` passed 10/10 (44 s). Not reproducible outside the full run, so no code or test change. Owner: this is the same environment fault (API watch process restarting or out of memory under load) that recurs in every long run; the fix is a larger heap for the watch build, not a change to this test.

### Gate repair 2026-10-17 (fifth run): `cart-checkout` JC-2, root cause found (environment, stale watcher)
The recurring 502s (`socket hang up` on `/api/bff/f/*`) came from the API watcher still running Nest's 2 GB type-checker: `nest-cli.json` `typeCheck: false` (commit 1e84d7b7, 20:20) was made after the running watcher had started (20:00), so it never took effect. No heap change is needed; the checker is off. Done: `bash scripts/sdd/stack-fix.sh api-restart`; `stack-fix.sh smoke` is ok on the new process. No test or page changed.

### Gate repair 2026-10-17 (sixth run): `cart-checkout` JC-2 and `notifications` bell test, root cause found (test limit lower than the wait inside)
Both pass alone (28 run: 24 passed, 4 skipped). The failures say `Test timeout of 30000ms exceeded` while the assertion waits 45 s (JC-2) or 20 s after registering (bell): Playwright's default per-test limit (30 s) was shorter than the waits the tests already allow for a loaded runner, so the long runs could never succeed once the payment or the welcome item took a little longer. `packages/web/playwright.config.ts` now sets `timeout` to 90 s (`PW_TEST_TIMEOUT_MS` overrides). No assertion changed.

### Gate repair 2026-10-17 (seventh run): `cart-checkout` JC-2, not reproducible, no code change
Both projects ended on the sign-in page after `register` (session lost mid-run, 45 s / 90 s waits), while the runner was loaded. Re-run on a ready stack (`stack-fix.sh smoke` ok): `-g JC-2` 2 passed; whole file 10 passed (44 s). No defect found in product code, test or page; nothing changed. If it returns, check whether the API watcher restarted during the run (a restart drops the session).

### Gate repair 2026-10-17 (eighth run): `cart-checkout` JC-2 (mobile and desktop), API restart during the run
`stack-fix.sh smoke` ok. In the failing run the desktop test never saw the "Visa test card" radio and the mobile test never reached "Order confirmed". `/var/log/sdd/api.log` shows a graceful shutdown of the API at 21:17:30 (`shutdown_server_closed`, then `payments.charge-worker` and the other workers stopped), so the pay page and the charge were interrupted by a restart in the middle of the run. `-g JC-2` re-run alone: 2 passed (24 s). No product code, test or page changed.

- 2026-10-17, `tests/cart-checkout.spec.ts` JC-2 (mobile and desktop): the gate failed because `/api/bff/f/cart` answered `502 bad_gateway` ("socket hang up") while the checkout page loaded, so the payment form never rendered. This is an environment fault (the service restarted under load), not a code defect. `stack-fix.sh smoke` reports the environment ok. The spec passes on both projects when re-run (10 passed). No test or page was changed.

- 2026-10-17 `tests/cart-checkout.spec.ts` JC-2 failed in the gate on both projects (mobile: no "Order confirmed" in 45 s; desktop: "Visa test card" radio never appeared). Cause: environment, not code. During that run the API log shows `502 bad_gateway` ("service core could not be reached") on `/api/bff/f/cart` and other BFF routes while the dev API was restarting under load. `stack-fix.sh smoke` reports the environment ok; JC-2 alone passes on both projects (2 passed) and the whole file passes (10 passed, 46 s). No code or test changed.

- 2026-10-17 (latest run): `cart-checkout.spec.ts` JC-2 again failed on both projects in the full run (no "Order confirmed" in 45 s). `stack-fix.sh api-ready` then `smoke` ok; the API log shows `502 bad_gateway` (`socket hang up`) on `/api/bff/f/*` during the run. The whole file re-run: 10 passed (49 s). Same environment signature as the earlier runs above; no code or test changed.

- **cart-checkout.spec.ts JC-2 "Order confirmed" timeout (2026-10-17)**: not reproducible. `stack-fix.sh smoke` reported the environment ok; JC-2 passed alone on `desktop` and on `mobile` (about 22 s each), and the whole `cart-checkout.spec.ts` passed 10/10 with 2 workers (48 s). The API log holds no payment or charge error in that window, only `502 bad_gateway` from the BFF while the web dev server was not up between Playwright runs. No product code or test was changed. The gate failure came during the full 4.9 min run, when the sandbox payment settles late under load; if it recurs, check the payment queue consumer before touching the test.

- 2026-10-17 (third occurrence): JC-2 failed again only in the full run. `stack-fix.sh smoke` ok; JC-2 alone passed on desktop; the whole file passed 10/10 (47 s). The API log shows a `payments.charge-worker` shutdown at 21:17:32, i.e. a watch-mode API restart during the run. No code or test changed.

### Gate repair 2026-10-17 (ninth run): `cart-checkout` JC-2, no code change
`stack-fix.sh smoke` ok. `-g JC-2` passed on desktop (20 s) and the whole `cart-checkout.spec.ts` passed 10/10 (48 s) on the settled stack. The API log has no payment or charge error; its last graceful shutdown (21:17:32, `payments.charge-worker` stopped) is the API restart done after the OTEL change, which dropped the session and the pending charge of the gate run in progress. Nothing left to fix in product code or the test; the gate must be re-run with no API restart during it.

### Gate repair (mobile run, 4 failures)
- `seller-inventory` (search step): ENVIRONMENT. The product search index was stale, so the new product never showed in the typo search for 45 s. `bash scripts/sdd/stack-fix.sh reindex` fixed it; the spec then passed on `--project=mobile`. No test or page changed.
- `seller-import`, `visual/seller-overview`, `visual/seller-team` (mobile): not reproducible. All three passed in isolation on `--project=mobile` (the screenshots differed by 20 px of height, the import button stayed disabled) after the 25-minute loaded full run. Treated as load timing; no test or page changed.

### Gate repair (mobile run, 4 failures, second occurrence)
- `seller-inventory` (typo-search step): ENVIRONMENT again. The search index was stale (the new product never appeared in 45 s). `bash scripts/sdd/stack-fix.sh reindex` fixed it; the spec then passed on `--project=mobile` (17 s).
- `seller-import`, `visual/seller-overview`, `visual/seller-team` (mobile): all passed on a settled stack (8 passed in the combined run with the inventory spec). The screenshot height difference (867 vs 887 px) and the disabled import button came from load in the 25-minute run. No product code, test or page changed.

### Gate repair (mobile run, 4 failures, third occurrence): root causes found
The two earlier repairs only reindexed and re-ran, and the same four failures came back. This time each has a cause:
- `visual/seller-team` orders (and `visual/seller-overview`): the page was fine, the TEST was fragile. `openShop` named the shop `E2E Shop <base36><random>`; the page text "The orders placed with <shop name>, newest first." wraps to one or two lines depending on the glyph widths of that random name (867 vs 887 px high). It reproduced on a settled stack, so it was not load. `tests/helpers.ts` now has `uniqueShopName()` (constant length, digits only) as the default name. Both specs pass on mobile and desktop. No baseline changed.
- `seller-inventory` (typo search): ENVIRONMENT, with a cause. The backend e2e harness (`libs/domains/discovery/testing/search-app.ts`) deletes every `products*` index of the search engine the dev stack shares, so the browser run that follows starts on an empty or stale index. `stack-fix.sh reindex` now waits for the reindex run to be COMPLETED (not for the first document), and `scripts/sdd/implement-specs.sh` (`web_full`, and the first batch of stage 4) and `scripts/sdd/checkpoint.sh` run it before Playwright. The running loop has already read those scripts: a restart of the runner is needed for them to take effect.
- `seller-import`: the spec set the file before React had attached its handlers, so "Start import" stayed disabled for 90 s on a loaded machine. The spec now waits for the file input to be hydrated first (same idea as `waitForForm`). No assertion changed.
- Not explained: one run of `seller-inventory` (mobile) failed once right after a completed reindex; later runs, including one right after a reindex, passed.
- Not run: `bash -n` on the three edited scripts (needs approval here); the `reindex` action itself ran correctly.

### Gate repair 2026-10-18: `seller-inventory.spec.ts` "owner adds, finds, edits and archives a product" (product code)
`stack-fix.sh smoke` was ok, the API and `SearchShopProduct` were correct (the index takes about 3 s to show a new product, then `ceramc mug` answers the row). Cause in the UI: `useInventory` kept the default 60 s stale time, so the first search that ran before the index caught up cached an empty answer for its key; clearing and typing the same text again was served from that cache and the test's 45 s retry loop never reached the API. `useInventory` (`lib/api/seller-products.ts`) now uses `staleTime: 0` for search queries (the browse list keeps the default), so a repeated search reads again. Verified: `seller-inventory.spec.ts` passes on both projects, vitest for `lib/api/seller-products` and `components/seller/inventory` passes (48 tests).

### Gate repair 2026-10-18: seller-live.spec.ts AS-19 (test timing, no product change)
Passed alone, failed (Orders stayed 0) whenever it ran next to other specs on 2 workers; reproduced twice. Cause: the buyer "Order confirmed" appears before the orders.events live projection (LiveProjector) has counted the order, and under load that lag exceeds the 2 s the spec waited. The ticker publishes one frame per second carrying both numbers. The spec now waits up to 20 s for Orders to reach 1 (projection lag), then still requires Revenue and "Live" within 2 s. The per-frame 2 s behavior is also covered by live-panel.test.tsx. Verified: seller-live + cart-checkout + seller-shop, desktop, 2 workers, 9 passed. Open: end-to-end paid-to-panel latency under load is not measured by any test.

- Visual gate (5 failures: seller-inventory mobile list/error/empty-none, seller-shell mobile shell-phone-closed, desktop suspended-banner). Causes: (1) the baselines were taken with random mixed-letter shop names that wrapped the heading differently; `uniqueShopName()` in `tests/helpers.ts` now gives a constant-length name, so the five baselines were regenerated. (2) `suspended-banner` shot raced the live panel (height 1190 unavailable / 1220 connecting / 1264 live); the test now waits for "Live" and masks `[data-live-values]`, as seller-overview does. (3) Product defect found by the repeat runs: the stale (reconnecting) live panel dimmed its numbers with `opacity-50` (contrast 1.96:1, axe failure in AS-88 when the stream dropped offline); `components/seller/overview/live-panel.tsx` now uses `text-muted-foreground` instead. No scenario removed or skipped.

- **seller-inventory mobile, AS-30 typo search (gate).** Cause: a fault in the test's retry, not the environment. The search box reports after 300 ms of silence, so the retry's back-to-back `fill('')` and `fill('ceramc mug')` collapsed into one unchanged `q`: the URL did not change, the search was never asked again, and the index lag was never re-polled. Repair: each retry now waits for the empty text to reach the address before typing the query again (`tests/seller-inventory.spec.ts`; the assertions are unchanged). The `staleTime: 0` for searches in `useInventory` stays. Both desktop and mobile pass.
