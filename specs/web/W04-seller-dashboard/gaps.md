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
