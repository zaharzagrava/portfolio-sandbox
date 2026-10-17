# Tasks: W04 — Seller dashboard (`packages/web` + the backend pieces it needs)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `plan.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/backend-endpoints.md`, `contracts/web-modules.md`, constitution.
**Tests**: required. Every `test-plan.md` row (AS-01..AS-98) has a failing-test task that comes before its code task (test-first). A task ticked "deferred to the final checkpoint" is done.
**Paths**: web = `packages/web/`, backend = `packages/backend/`, contracts = `packages/contracts/`. All web test commands run from `packages/web`; backend specs through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; Playwright with `--reporter=line --max-failures=1` and only the spec file of the page changed.
**Rules for every task**: read `packages/web/AGENTS.md` and the matching guide in `packages/web/node_modules/next/dist/docs/` before writing web code; no `git checkout/restore/reset/stash/clean` (undo by hand-editing); no new direct `sequelize.transaction`; no task here starts a fresh-stack run, standalone boot, journey/browser suite or `test_doctor` (the final checkpoint owns them); 5 failed fixes of one test → write the blocker into `questions.md` and stop on it; copy in sentence case, never `window.confirm`, never show `detail` (except `endpoint_url_rejected`).

Stories: US1 open a shop / switch (AS-01..09) · US2 overview + live (AS-10..27) · US3 inventory (AS-28..43) · US4 API keys (AS-44..55) · US5 webhooks + deliveries (AS-56..67) · US6 version / logs / usage (AS-68..73) · US7 team + invitation (AS-74..82) · US8 orders (AS-83) · US9 access limits, failure, devices (AS-84..98) · US10 follow-up screens F1..F9 from built specs.

---

## Phase 1: Setup

- [X] T001 Create the living-spec page `docs/spec/capabilities/W04-seller-dashboard.md` from the rules of `spec.md` (behaviors first; every `[proof: …]` / `[code: …]` true, proofs name the test files of `test-plan.md`); run `python3 scripts/livespec/check.py`; never create or edit a `*.reviewed.json`
- [X] T002 Re-read the Next 16.3.8 guides named in `plan.md` (Authentication with Cache Components, Rendering philosophy, `instant`, Server Functions/forms, Redirecting) and the exports of `packages/web/lib/auth/{guards,session.server,return-to,session-ended}.ts`, `lib/api/{errors,csrf,idempotency}.ts`, `components/auth/problem-alert.tsx`, `lib/realtime/user-stream.ts`, `hooks/use-auth-actions.ts`; write the exact export names you will use at the top of `packages/web/lib/seller/README.md` (3 lines max per module)
- [X] T003 [P] Add test helpers `openShop(page, name?)`, `seedProduct(shopId, input)`, `shopPath(shopId, section?)`, `readInviteLink(email)` (dev notification outbox; if none exists mark `seller-team.spec.ts` blocked with the reason, R-13) to `packages/web/tests/helpers.ts`
- [X] T004 [P] Add `EventSource` stub (frames, `resync`, `revoked`, 401 refusal, reconnect, connection counter) and clipboard stub (granted/denied) in `packages/web/lib/test/event-source-stub.ts` and `packages/web/lib/test/clipboard-stub.ts`; wire into the Vitest setup file
- [X] T005 [P] Add MSW handlers with problem+json fixtures parsed by the contracts schemas in `packages/web/lib/test/seller-handlers.ts` (one fixture per code of the spec's error catalogue)

---

## Phase 2: Foundational (blocks every story)

### Backend and contracts (B-1..B-5)

- [X] T006 [P] Write failing contract spec `packages/contracts/src/bff/seller-overview.spec.ts`: example bodies (full, partial with `errors[]`, `rank: {notRanked: true}`) parse with `sellerOverviewResponseSchema`; unknown keys rejected (`.strict()`)
- [X] T007 Add `packages/contracts/src/bff/seller-overview.ts` (`sellerOverviewErrorSchema` with `section: 'stats'|'today'|'rank'`, `code: string`, `retryable: boolean`; `sellerOverviewResponseSchema` `{shop, stats|null, today|null, rank|{notRanked:true}|null, errors[]}` all `.strict()`), export from `packages/contracts/src/bff/index.ts`
- [X] T008 Write failing e2e `packages/backend/libs/composition/bff/seller/seller-overview.e2e-spec.ts` (real BFF module, upstream edge faked at the HTTP client): happy; `days=0|366|abc` → `400 validation_failed`; malformed shop id → `400`; no credentials → `401`; non-member identical to unknown → `404 shop_not_found`; each of stats/today/rank failing alone leaves the others intact with `errors[]`; shop read failing → `503 upstream_unavailable`; upstream `404 not_ranked` → `rank: {notRanked: true}` and no error; body parses with the schema; `Cache-Control: private, no-store`; no `Set-Cookie`; rate limit → `429`
- [X] T009 Implement `packages/backend/libs/composition/bff/seller/seller-overview.controller.ts` and `seller-overview.service.ts` (model: `orders/order-page.controller.ts`): `GET bff/seller/:shopId/overview?days=7|30|90` default 30, `CredentialsGuard`, `@RateLimit('bff.seller-overview.principal')` (add the policy in `rate-limit-policies.ts`), `ZodPipe` for UUID and `days`, shop read first, then stats/today/rank in parallel with per-section timeouts via `page/section-outcome.ts`, abort signal passed upstream, no database access; add upstream client `upstream/endpoints/seller.ts`; register in `bff.module.ts`
- [X] T010 Run `scripts/sdd/test-spec.sh packages/backend/libs/composition/bff/seller` until green; wait for `GET http://localhost:8000/health/ready` after edits
- [X] T011 [P] Write failing shape-check specs for B-4 in the owning domains' e2e files: `GET /shops/:id` always carries `myRole` and `myPermissions`; `GET /shops/mine` items carry `status`; keys and logs answer `{items, nextCursor}` with `limit`/`cursor`; `GET /shops/:id/orders` accepts `status`, `limit`, `cursor`; `GET /shop-roles` equals `shopRolesSchema`. A mismatch is fixed in the owning domain with its e2e, or recorded under `## Sibling-spec follow-ups` in `gaps.md` (`- **<their id>**: …`) when the owner's spec must change
- [X] T012 If T011 shows `myPermissions` always sent, make `myRole` and `myPermissions` required in `shopSchema` (R-10) in `packages/contracts/src/shops/*`; add `shopOrderStatusSchema` listing the status values for `shopOrderPageSchema`
- [X] T013 B-5 audit: grep every backend file edited by T009–T012 for `// S54 T037 audit`; migrate any direct `sequelize.transaction` to `TransactionRunner.run`/`@Transactional` and delete the comment; add none
- [X] T014 [P] Write failing `packages/web/lib/config.test.ts` cases for `PLATFORM_CURRENCY` (ISO 4217; fraction digits from `Intl.NumberFormat(...).resolvedOptions()`) and `PUBLIC_API_BASE_URL` (absolute URL); then add both (server-only) to `packages/web/lib/config.ts`/`config-parse.ts`, document in `.env.example`/README (B-3, gap E11); missing `PLATFORM_CURRENCY` → product form disabled with a problem alert, missing base URL → `https://<your-api-host>`

### Web foundations (tests first)

- [X] T015 [P] Write failing `packages/web/lib/seller/permissions.test.ts` (table-driven over OWNER/ADMIN/STAFF/VIEWER × `ShopPermission`, `pageRequires` table, missing `myPermissions` = no permission, `useShopWritable` for ACTIVE/SUSPENDED/DELETING) — AS-42, AS-54
- [X] T016 Implement `packages/web/lib/seller/permissions.ts` (`shopCan`, `pageRequires`, `useShopWritable`, `ShopPermission` from the contract; keys/version screens require `shop.manage`, invitations `members.manage`)
- [X] T017 [P] Write failing `packages/web/lib/seller/money-input.test.ts` (table-driven: comma or point, `0,1`, `1.005`, leading/trailing spaces, too many fraction digits, negative, empty, 0-digit and 3-digit currencies, no float errors like `19.99*100`) — AS-35
- [X] T018 Implement `packages/web/lib/seller/money-input.ts` (`parseMoneyInput(text, fractionDigits)` by string parsing, `fractionDigitsOf(currency)`)
- [X] T019 [P] Write failing `packages/web/lib/seller/problem-copy.test.ts` (table-driven over every code in the spec's "Error catalogue": form kind, message, field; never `detail` except `endpoint_url_rejected`; `requestId` for 5xx; `invalid_cursor`; `Retry-After`) — AS-89, SC-006
- [X] T020 Implement `packages/web/lib/seller/problem-copy.ts` (`sellerProblemCopy(problem, context)`) wrapping W01 `lib/api/errors.ts`
- [X] T021 [P] Write failing tests then implement `packages/web/lib/seller/stock.ts` (`LOW_STOCK_THRESHOLD = 5`, `stockStatus(quantity, status)` → `archived|out|low|in`; table 0, 3, 5, 6, archived — AS-39), `lib/seller/search-params.ts` (`readDays`, `readInventoryParams`, … return defaults for invalid values), `lib/seller/countdown.ts` (`useCountdown(seconds)`, one polite announcement at start and end only, R-18), `lib/seller/format-date.ts` (viewer's zone with UTC in tooltip) in matching `*.test.ts` files
- [X] T022 [P] Write failing `packages/web/lib/realtime/subscribe-topic.test.ts` (one connection for several topics, release function drops the topic, `resync` → refetch callback, `revoked` → drop topic, `parseLiveFrame` unwraps the hub `{topic, data}` envelope with `liveDashboardFrameSchema`, recreate after final 401/403) — AS-21, AS-25
- [X] T023 Add `subscribeTopic(topic, handler): () => void` and `parseLiveFrame(data)` to `packages/web/lib/realtime/user-stream.ts` as a thin wrapper over `addTopic` + `subscribeUserEvents` (no second connection); add a bullet under `## Sibling-spec follow-ups` in `gaps.md`: `- **W03**: lib/realtime/user-stream.ts now also exports subscribeTopic/parseLiveFrame (added by W04)`
- [X] T024 Update `packages/web/lib/query-keys.ts`: add `queryKeys.seller.{shops, shop, overview, inventory, product, orders, team.{members,invites,roles}, apiKeys, apiVersion, logs, usage, webhooks, webhookEventTypes, webhook, webhookAttempts, webhookEvent}` exactly as in `contracts/web-modules.md`; remove `seller.dashboard` and `seller.products`
- [X] T025 [P] Create `packages/web/lib/server/seller.server.ts` (`readMyShops`, `readShop`, `readOverview`, `readInventoryFirstPage`, one reader per list page; via `readAsMember`, `no-store`, returns a `ReadResult` value, never throws) and `packages/web/lib/api/seller.ts` (`useShop`, `useMyShops`, `useOverview`, `useOpenShop`, every response parsed with contracts, relative URLs, no `Authorization`, no token)
- [X] T026 [P] Create the client API modules, each parsing responses with contract schemas and using only `queryKeys.seller`: `lib/api/seller-products.ts` (`useInventory`, `useProduct`, `useCreateProduct`, `useUpdateProduct`, `useAdjustStock`, `useArchiveProduct`, `useRestoreProduct`; `POST /shops/:id/products` with `priceMinor`+`currency`, `expectedVersion` on edit/archive/restore), `lib/api/seller-developers.ts` (hooks listed in `contracts/web-modules.md`; remove `developersApi.pingWebhooks`), `lib/api/seller-team.ts`, `lib/api/seller-orders.ts`; add MSW-backed parse tests `lib/api/seller*.test.ts`
- [X] T027 [P] Write failing `packages/web/components/seller/secret-reveal-dialog.test.tsx` (AS-46, AS-47: Escape and outside click ignored; "Done" before copy asks once with "Close anyway"/"Copy key"; copied state 2 s + status "Copied to clipboard"; clipboard denied selects text + "Press Ctrl+C (⌘C on Mac) to copy."; query cache, URL, `localStorage`, `sessionStorage`, console hold no secret) — file path per test-plan: also reachable as `components/seller/developers/secret-reveal-dialog.test.tsx` (re-export or place the test there)
- [X] T028 Implement `packages/web/components/seller/secret-reveal-dialog.tsx` (`<RevealSecretDialog title description secret note? onDone />`) on radix `components/ui/dialog` (R-17)
- [X] T029 [P] Write failing tests then implement shared primitives in `packages/web/components/seller/`: `confirm-dialog.tsx`, `row-menu.tsx`, `responsive-table.tsx` (one DOM, cards ≤ 640 px via CSS, `caption`, `scope`, R-16), `copy-button.tsx` (named icon button, failure path, polite announcement), `filters-sheet.tsx`, `page-skeletons.tsx` (layout-shaped, no "Loading..."), `shop-status-banner.tsx` (suspended / closing copy, read-only reason) with `*.test.tsx` beside each (AS-86, AS-94)

**Checkpoint**: backend e2e green, foundations unit tests green.

---

## Phase 3: User Story 9 — Shell, guard, access limits, failure, every device (Priority: P1, blocks the route stories)

**Goal**: server guard, `[shopId]` layout, sidebar/drawer/switcher/banners, error and offline states. **Independent test**: `pnpm exec vitest run components/dashboard components/seller/problem-states.test.tsx` (AS-84..AS-91, AS-98).

- [X] T030 [P] [US9] Write failing `packages/web/components/seller/problem-states.test.tsx`: session ended once and politely (AS-87), offline banner/alert/refetch on reconnect (AS-88), table-driven error catalogue incl. `invalid_cursor`, `requestId` shown, no raw JSON or bare status (AS-89), rate-limit countdown with fake timers (AS-90)
- [X] T031 [US9] Implement `packages/web/components/seller/problem-states.tsx` (`ProblemPanel`, `SectionError onRetry`, `OfflineBanner`, `RateLimitNotice`, wrapping W01 `ProblemAlert`) and `useCountdown` usage
- [X] T032 [P] [US9] Write failing `packages/web/components/dashboard/dashboard-shell.test.tsx`: guard called with path+query as `returnTo` (AS-84); unknown/malformed/foreign shop → not-found copy "We couldn't find that shop." with "Your shops" (AS-85); suspended/closing banner text and disabled controls (AS-86); skeleton per route, no "Loading..." (AS-91); drawer open/close, focus return, `nav` named "Seller", `aria-current`, "Open menu" (AS-98)
- [X] T033 [P] [US9] Write failing `packages/web/components/seller/shop-switcher.test.tsx`: list content, role badges, current marker, 50-shop cap with cursor, section kept on switch, legacy `/inventory` redirect target (AS-08, AS-09)
- [X] T034 [US9] Create `packages/web/lib/seller/nav.ts` (`SellerNavItem`, `sellerNavItems` registry with `requires`, groups `shop`/`developers`)
- [X] T035 [US9] Rewrite `packages/web/components/dashboard/dashboard-shell.tsx` as a server frame (sidebar, top bar + `mobile-drawer.tsx`, `shop-switcher.tsx`, `banners.tsx`; reads `sellerNavItems` and `shopCan`; no role claim, no client guard, no "Loading...")
- [X] T036 [US9] Create `packages/web/app/dashboard/seller/[shopId]/{layout,loading,not-found,error}.tsx` (`requireServerSession(returnTo)` first; `readShop`; non-UUID/unknown/foreign → `notFound()`; forbidden panel for pages whose `pageRequires` permission is missing) and `loading.tsx` per route; remove every `export const instant = false` under `app/dashboard/seller`
- [X] T037 [US9] Redirects: `app/dashboard/page.tsx` → `permanentRedirect('/dashboard/seller')`, `app/dashboard/settings/page.tsx` → `/account/security`, `app/dashboard/seller/inventory/page.tsx` → the shop's inventory (or picker), `/dashboard/orders` stays → `/orders`; `app/dashboard/layout.tsx` passes children only
- [X] T038 [P] [US9] Write failing `packages/web/lib/architecture.test.ts` assertions for W04 files (AS-92, AS-93): no `fetch`/`axios`/`EventSource` in components or hooks, query keys only from `lib/query-keys.ts`, no new Context/store, no `use cache` around per-user data, no token/credential storage or `Authorization`/`setAccessToken`/`refreshSession`, no `window.confirm`, no `dangerouslySetInnerHTML`, no index keys; extend the shared file, do not create a second
- [X] T039 [P] [US9] Write `packages/web/tests/visual/seller-shell.spec.ts` (mobile + desktop, `page.route` stubs, animations off, axe serious/critical = 0): open-shop form, shell, forbidden panel, suspended banner, offline banner, loading skeletons (AS-01 layout, AS-54, AS-86, AS-88, AS-91, AS-98); commit baselines when the final run produces them

**Checkpoint**: shell unit tests green; routes can be added one registry entry each.

---

## Phase 4: User Story 1 — Open a shop, switch between shops (Priority: P1)

**Independent test**: `pnpm exec vitest run app/dashboard/seller` + `tests/seller-shop.spec.ts` (steps 1, 2 and later tests).

- [X] T040 [P] [US1] Write failing `packages/web/app/dashboard/seller/open-shop-form.test.tsx`: handle follows name until edited (AS-02); calls `useRefreshSession()` after open with fake timers at 1 s, 2 s, 4 s, max 3 (AS-04); field-level problems under the field with focus (AS-05: `slug_taken`, `slug_reserved`, validation); form-level `shop_limit_reached`/`429` countdown above the button (AS-06); double press opens one shop, a `409` opens the existing one (AS-07, L-010)
- [X] T041 [US1] Rewrite `packages/web/app/dashboard/seller/page.tsx` (server: 0 shops → open-shop form, 1 → `redirect` to `/dashboard/seller/{id}`, n → picker; membership not role claim) and create `open-shop-form.tsx` (client) and `shop-picker.tsx`
- [X] T042 [P] [US1] Write `packages/web/tests/seller-shop.spec.ts` (`describe('Seller shop entry and overview')`): owner opens a shop (steps 1–3: form from "Start selling", lands on overview, sections render), returning owner lands on the overview (AS-08), owner switches between two shops keeping the section (AS-09); roles/labels only, isolated user via `register` + `openShop`
- [X] T043 [US1] Delete `packages/web/app/dashboard/seller/view.tsx` after T041/T049 land (never both at once)

---

## Phase 5: User Story 2 — See how the shop is selling, live (Priority: P1)

**Independent test**: `pnpm exec vitest run components/seller/overview` (AS-10..AS-27).

- [X] T044 [P] [US2] Write failing `packages/web/components/seller/overview/overview-view.test.tsx`: shop currency and refunds/net separate, no USD default, `…Minor` (AS-11); period in the URL 7/30/90 (AS-12); top products show titles not ids and no storefront link (AS-13); daily chart has table alternative (AS-14); zero and not-ranked copy (AS-15); rank sentence (AS-16); per-section failure and retry replaces only the failed section (AS-17, SC-005); shop failure is page-level (AS-18); "Today (UTC)" totals and per-minute series (AS-26)
- [X] T045 [P] [US2] Write failing `packages/web/components/seller/overview/live-panel.test.tsx` (stubbed stream, fake timers): frame rendering and "Live" (AS-19); conversion only when present (AS-20); `resync` refetch, `revoked`, "Reconnecting…" after 5 s without a frame, never old numbers as live (AS-21); refused stream → 30 s polling of `today` (AS-22); hidden tab releases the connection (AS-23); period invalidation ≤ 1 per 30 s (AS-24); one stream per page, swapped on shop change (AS-25); values not read aloud every second (AS-27)
- [X] T046 [US2] Implement overview components in `packages/web/components/seller/overview/` (`overview-view`, `tiles`, `today-card`, `rank-card`, `daily-chart` with recharts + table toggle + text alternative, `top-products`); constants `LIVE_STALE_MS`, `PERIOD_INVALIDATE_MIN_MS`, `TODAY_POLL_MS` as in `contracts/web-modules.md`; money via `formatMoney(minor, response.currency)`
- [X] T047 [US2] Implement `packages/web/components/seller/overview/live-panel.tsx` using `subscribeTopic('shop:{shopId}:live')`, timestamp ref for throttling (R-19), `aria-live` off for ticking values
- [X] T048 [US2] Create `packages/web/app/dashboard/seller/[shopId]/page.tsx` (Server Component, `days` search param, content in `<Suspense fallback={<OverviewSkeleton/>}>`, `readOverview` as `initialData`, R-11) and `loading.tsx`
- [X] T049 [US2] Remove the stats call to `/api/sellers/me/stats` and the literal `'USD'` (gap B3/C2/C9); delete `packages/web/app/dashboard/view.tsx` buyer overview and `components/dashboard/orders-table.tsx` if still present (W03/W07 follow-ups)
- [X] T050 [P] [US2] Write `packages/web/tests/seller-live.spec.ts` (`describe('Seller live numbers')`): a sandbox-paid order (W03 payment helper) moves the numbers within 2 s (AS-19)
- [X] T051 [P] [US2] Write `packages/web/tests/visual/seller-overview.spec.ts`: overview with data, new shop, partial data, live connected, at 390 and 1280 px with axe (AS-10, AS-15, AS-17, AS-19, AS-96)

---

## Phase 6: User Story 3 — Manage inventory (Priority: P1)

**Independent test**: `pnpm exec vitest run components/seller/inventory lib/seller/money-input.test.ts` (AS-28..AS-43, AS-94, AS-95).

- [X] T052 [P] [US3] Write failing `packages/web/components/seller/inventory/inventory-view.test.tsx`: paging links, caption, ordering (AS-28); status and stock filters in the URL (AS-29); 300 ms debounce with URL `replace`, tabs disabled while searching (AS-30); kept rows, `aria-busy`, error alert, no empty flash (AS-31); three different empty states (AS-32); stock popover adjust (AS-38); status words 0/3/5/6/archived (AS-39); stale row explained for `version_conflict`/`product_archived`/`product_not_found` (AS-41); seller text rendered as text (AS-43); dialog/menu keyboard behaviour asserted once (AS-94); table semantics (AS-95)
- [X] T053 [P] [US3] Write failing `packages/web/components/seller/inventory/product-form.test.tsx`: client checks vs server decides (AS-34); only changed fields sent with `expectedVersion`, disabled when unchanged (AS-36); conflict shows what changed and never overwrites silently (AS-37); form errors by field with focus (AS-95); price field uses `PLATFORM_CURRENCY` fraction digits, no "USD" label
- [X] T054 [US3] Implement `packages/web/components/seller/inventory/{inventory-view,inventory-toolbar,product-form,stock-popover,archive-dialog}.tsx` using `lib/api/seller-products.ts`, `parseMoneyInput`, `stockStatus`, `ConfirmDialog`, `ResponsiveTable`; archive/restore by `expectedVersion`; viewers read-only via `shopCan` and `useShopWritable`; edit reloads the member view first (search rows carry no `version`)
- [X] T055 [US3] Create `packages/web/app/dashboard/seller/[shopId]/inventory/{page,loading}.tsx` (Server Component, `q`/`status`/`inStock`/`cursor`, `readInventoryFirstPage` as `initialData`); delete `app/dashboard/seller/inventory/view.tsx` and the `LOW_STOCK` constant and engineer copy ("SD-31", "ClickHouse", "outbox → indexer")
- [X] T056 [P] [US3] Write `packages/web/tests/seller-inventory.spec.ts` (`describe('Seller inventory')`): owner adds (step 1), edits stock (step 2), finds by typo search (step 3), archives (step 4); product created with `createIsolatedProduct`/`seedProduct`, never shared stock (L-005, L-006)
- [X] T057 [P] [US3] Write `packages/web/tests/visual/seller-inventory.spec.ts`: list, loading and error, empty states at 390/1280 with axe (AS-28, AS-31, AS-32, AS-97)

---

## Phase 7: User Story 4 — Issue and control API keys (Priority: P1)

**Independent test**: `pnpm exec vitest run components/seller/developers/api-keys-view.test.tsx` (AS-44..AS-55).

- [X] T058 [P] [US4] Write failing `packages/web/components/seller/developers/api-keys-view.test.tsx`: columns/derived status/empty text, never the secret, revoked and expired dimmed (AS-44); create form constraints incl. optional expiry (AS-48); live key asks a second step first and `mfa_required` links to `/account/security?tab=two-step&returnTo=<page>` (AS-49); 25-key limit explained (AS-50); rotation with overlap 0/1/24/72/168 h and old key end shown (AS-51); illegal rotations `key_already_rotating`/`key_revoked`/`key_expired` (AS-52); revoke immediate, double press, focus on Cancel, successor untouched (AS-53); "Using the API" help with `PUBLIC_API_BASE_URL` (AS-55)
- [X] T059 [US4] Implement `packages/web/components/seller/developers/{api-keys-view,create-key-dialog,rotate-key-dialog}.tsx` with query/mutation hooks (no `useState` copies of server data, no `useEffect` loading — gap A1/A5), `RevealSecretDialog` for created/rotated secrets, `ConfirmDialog` for revoke/rotate, cursor paging in the URL, visible checkbox group legends (D5)
- [X] T060 [US4] Rewrite `packages/web/app/dashboard/seller/[shopId]/developers/api-keys/{page,loading}.tsx` (Server Component, requires `shop.manage`, forbidden panel otherwise — AS-54), delete the old `view.tsx` there (removes the unused `error` catch bindings)

---

## Phase 8: User Story 5 — Webhook endpoints and deliveries (Priority: P1)

**Independent test**: `pnpm exec vitest run components/seller/developers/webhooks-view.test.tsx components/seller/developers/webhook-detail-view.test.tsx` (AS-56..AS-67).

- [X] T061 [P] [US5] Write failing `packages/web/components/seller/developers/webhooks-view.test.tsx`: badges/notices for `status`, `disabledReason`, `breaker`, `hasPreviousSecret`, full URL visible (AS-56); event choices from `GET webhook-event-types`, catalogue-unavailable fallback (AS-58); every URL rejection explained at the URL incl. `endpoint_url_rejected` reasons (AS-59); edit URL/events/version (AS-60); disable/enable (AS-61, auto-disabled endpoint); secret rotation with overlap 1/24/48/72 and early end (AS-62); delete with confirmation (AS-63)
- [X] T062 [P] [US5] Write failing `packages/web/components/seller/developers/webhook-detail-view.test.tsx`: ping toast, refetch every 5 s for 30 s, `429` countdown (AS-64); delivery columns, `ok` filter, paging, empty text (AS-65); event panel inspect with JSON in `pre` (AS-66); replay `Idempotency-Key` created when the panel opens, reused on retry, replaced for another event, `202` handling (AS-67)
- [X] T063 [US5] Implement `packages/web/components/seller/developers/{webhooks-view,endpoint-form,webhook-detail-view,event-panel}.tsx` and wire `useCreateWebhook`, `useUpdateWebhook`, `useSetWebhookEnabled`, `useRotateWebhookSecret`, `useExpirePreviousSecret`, `useDeleteWebhook`, `usePingWebhook`, `useWebhookAttempts`, `useWebhookEvent`, `useReplayEvent`; signing secret via `RevealSecretDialog`; all routes need `webhooks.manage`
- [X] T064 [US5] Create `packages/web/app/dashboard/seller/[shopId]/developers/webhooks/{page,loading}.tsx` and `webhooks/[endpointId]/{page,loading}.tsx` (`ok`, `event`, `cursor`); delete the old `webhooks/view.tsx` (fixes the `react-hooks/immutability` lint error at line 50 and the unused catch bindings) and the `pingWebhooks` client
- [X] T065 [P] [US5] Write `packages/web/tests/seller-developers.spec.ts` (`describe('Seller developers')`): owner creates a key (step 1), revokes (step 2), adds an endpoint with secret once (step 3), sends a test event and sees a ping delivery (step 4; needs the local-receiver allowance of S43 FR-041, else mark blocked with reason, L-003)
- [X] T066 [P] [US5] Write `packages/web/tests/visual/seller-developers.spec.ts`: api keys list, webhooks list, deliveries, api version, request logs, usage at 390/1280 with axe (AS-44, AS-56, AS-65, AS-68, AS-70, AS-73, AS-97)

---

## Phase 9: User Story 6 — API version, request logs, usage (Priority: P2)

**Independent test**: `pnpm exec vitest run components/seller/developers/{api-version-view,request-logs-view,usage-view}.test.tsx` (AS-68..AS-73).

- [X] T067 [P] [US6] Write failing `api-version-view.test.tsx` (badges, confirm, toast — AS-68; deprecated = warning, retired `version_retired` = refusal — AS-69), `request-logs-view.test.tsx` (filters in the URL — AS-70; date range cannot be invalid in the form — AS-71; row copy for support with request id — AS-72), `usage-view.test.tsx` (table per day/version/route, totals, empty text, 7/14/30 days, UTC label, no chart — AS-73) under `packages/web/components/seller/developers/`
- [X] T068 [US6] Implement `api-version-view.tsx`, `request-logs-view.tsx`, `usage-view.tsx` in `packages/web/components/seller/developers/` and pages `developers/{api-version,logs,usage}/{page,loading}.tsx` under `app/dashboard/seller/[shopId]/` (require `shop.manage`)

---

## Phase 10: User Story 7 — Team and invitation page (Priority: P2)

**Independent test**: `pnpm exec vitest run components/seller/team "app/invites"` (AS-74..AS-82).

- [X] T069 [P] [US7] Write failing `packages/web/components/seller/team/team-view.test.tsx`: columns, self marker (AS-74); change role with `insufficient_role`/`last_owner` (AS-75); remove member or leave (AS-76); invite by e-mail incl. `seat_limit_reached`, `invite_pending`, `already_member`, `429` countdown (AS-77); resend and revoke (AS-78); roles matrix from `GET /shop-roles` readable without colour (AS-79); invitations tab needs `members.manage`; lists are `{items, nextCursor}`
- [X] T070 [P] [US7] Write failing `packages/web/app/invites/[token]/accept-invite.test.tsx`: toast text, `alreadyMember`, `router.replace` to the shop (AS-80); every refusal reads the same (`invite_not_found`, expired, wrong e-mail) (AS-81); signed-out redirect keeps `returnTo`; token never in console, cache, analytics (AS-82)
- [X] T071 [US7] Implement `packages/web/components/seller/team/{team-view,members-table,invites-table,roles-matrix}.tsx`, `app/dashboard/seller/[shopId]/team/{page,loading}.tsx` (`tab`, `status`, `cursor`)
- [X] T072 [US7] Implement `packages/web/app/invites/[token]/{page,loading}.tsx`, `accept-invite.tsx`, `actions.ts` (`'use server'` `acceptInviteAction(token)` → `POST /shop-invites/accept`, returns `{ok:true, shopId, role, alreadyMember}|{ok:false, code, retryAfter?}`), add the `/invites/:token` rule in `lib/routes/page-name.ts` and the `Referrer-Policy: no-referrer` header for `/invites/:path*` in `next.config.ts` (extend W07's header test; if that test belongs to W07 add a `## Sibling-spec follow-ups` bullet `- **W07**: …` instead of editing their spec)
- [X] T073 [P] [US7] Write `packages/web/tests/seller-team.spec.ts` (`describe('Seller team')`): invitee accepts an invitation via `readInviteLink` (AS-80); blocked with reason if no dev outbox exists (L-003)
- [X] T074 [P] [US7] Write `packages/web/tests/visual/seller-team.spec.ts`: members, orders, list layouts at 390/1280 with axe (AS-74, AS-83, AS-97)

---

## Phase 11: User Story 8 — Orders (Priority: P2)

- [X] T075 [P] [US8] Write failing `packages/web/components/seller/orders/orders-view.test.tsx`: columns (reference = first 8 chars of the shop-order id, item count, status with title-case fallback for unknown values), status filter in the URL, cursor paging, `buyerId` never shown (AS-83)
- [X] T076 [US8] Implement `packages/web/components/seller/orders/orders-view.tsx` and `app/dashboard/seller/[shopId]/orders/{page,loading}.tsx` (`status`, `cursor`, requires `orders.read`), nav entry; "Orders" in the sidebar points to the shop's orders, buyer `/orders` stays W03's

---

## Phase 12: User Story 10 — Follow-up screens from built specs (F1..F9)

Each slice: read the source contract named below first (any mismatch becomes a `## Sibling-spec follow-ups` bullet in `gaps.md`, R-20); add rows for its scenarios to `test-plan.md` under an "Addendum: Phase 9" heading; `lib/api/*` module parsed with contract schemas; one route + one `sellerNavItems` entry; MSW unit tests first; Idempotency keys via `lib/api/idempotency.ts`; mutations hidden/disabled by `shopCan`, handled when refused. Never blocks Phases 1–11. Order: F5, F2, F4, F1, F6, F3, F7, F8, F9.

### F5 — Balance, payouts, statements (S14, S15, S16, J01)

- [X] T077 [P] [US10] Read `specs/domains/S14-ledger-reconciliation/contracts/http.md`, `S15-payouts/contracts/http.md`, `S16-seller-statements/contracts/http.md`; write failing tests `app/dashboard/seller/[shopId]/{balance-card,payouts/view,statements/view}.test.tsx`: balance parses `balanceSchema` `{shopId, currency, availableMinor, asOf, source}`; malformed shop id/unknown query → `400` state; payouts parse `payoutPageSchema` (statuses `PENDING|IN_TRANSIT|PAID|FAILED|CANCELLED`, keyset `nextCursor`) and `upcomingPayoutSchema`; statements tab with "as known on" picker and CSV download
- [X] T078 [US10] Adopt/rewrite the existing `app/dashboard/seller/[shopId]/{balance-card.tsx,payouts,statements}` under the shell (pages in Suspense, nav entries, `lib/api/seller-finance.ts`) so T077 passes; remove the old `{available, source:'projection'}` shape; add the `buy-to-payout`/`seller-statements` journey steps owned by W04 to `tests/` only if the files exist (J01)

### F2 — Bulk import (S07)

- [X] T079 [P] [US10] Read `specs/domains/S07-bulk-import/contracts/http-api.md`; write failing `components/seller/imports/import-view.test.tsx`: start response `importId`, `parts[].url`, `partSize`, `partCount` (no `jobId`/`partUrls`/`uploadId`/`key`); `Idempotency-Key` of 8+ characters per start attempt, reused on retry; resume via `GET …/upload`; `POST …/cancel`; `GET …/error-report` link; subscribe `import:<importId>` (not `job:`)
- [X] T080 [US10] Implement `lib/api/seller-imports.ts`, `components/seller/imports/import-view.tsx`, route `app/dashboard/seller/[shopId]/imports/{page,loading}.tsx` and nav entry; reconcile with the existing `tests/seller-import.spec.ts` (update it, do not leave it stale)

### F4 — Order export (S12)

- [X] T081 [P] [US10] Read `specs/domains/S12-order-export/contracts/*`; write failing `components/seller/exports/export-view.test.tsx`: `POST /shops/:shopId/order-exports` with `Idempotency-Key`, `exportId`, subscribe `order-export:<exportId>` events `progress|done|failed|cancelled`, download only via `GET …/download`, `409 export_already_active {activeExportId}` opens the existing export (L-010)
- [X] T082 [US10] Implement `lib/api/seller-exports.ts`, `components/seller/exports/export-view.tsx`, route `…/exports/{page,loading}.tsx`, nav entry

### F1 — Draft editor (S06)

- [X] T083 [P] [US10] Read `specs/domains/S06-collab-editor/contracts/{http,collab-ws}.md`; write failing `components/seller/editor/listing-editor.test.tsx` (WebSocket stub): connect, close-code handling, reconnect with backoff, `acknowledgeProductVersion` dialog, version list, publish with per-attempt `Idempotency-Key`, `422 listing_invalid` field `brand` shown at the brand field before publish
- [X] T084 [US10] Implement `lib/api/seller-listing-drafts.ts`, `components/seller/editor/*`, route `…/products/[productId]/draft/{page,loading}.tsx`; write `packages/web/tests/listing-editor.spec.ts` (the W04-owned journey, happy path)

### F6 — Photos and video (S29, S30)

- [X] T085 [P] [US10] Read `specs/domains/S29-photos/contracts/*` and `S30-video/contracts/*`; write failing `components/seller/media/{gallery-view,video-upload-view}.test.tsx`: gallery sends `expectedVersion`, reads FR-073 `code` values, polls `GET /media/:id` until `READY`, never builds URLs, `PUT gallery` `200` with body, `complete` `202`/`200` with `rejectCode`; video uses presigned part URLs as given, per-part retry, resume via `GET …/upload`, poll `GET …/videos/:id`, `videoStatus` (`upload_closed`, `invalid_state`), `202` on complete
- [X] T086 [US10] Implement `lib/api/seller-media.ts`, `components/seller/media/*`, routes under `…/products/[productId]/media/` and nav/product-row entry; write `tests/seller-photos.spec.ts` and `tests/seller-video.spec.ts` (AS-61 of S30; update rows in `specs/UNVERIFIED.md` only if the status line text changes — never mark verified without a run)

### F3 — Integrations, quarantine, reconciliation, offline conflicts (S08, S09)

- [X] T087 [P] [US10] Read `specs/domains/S08-integrations/contracts/http-api.md` and `packages/contracts/src/catalog-sync/offline-sync.ts`; write failing `components/seller/integrations/integrations-view.test.tsx`: connect calls `POST …/shopify/install` and handles `?connected=`/`?error=`; Woo form `POST …/integrations`; status via `GET …/integrations[/:id]`; quarantine list `GET …/quarantine?status&limit&cursor`, retry `{outcome:'resolved'|'still_invalid', item}` with `resolution:'expired'`, `409 invalid_integration_transition` message, dismiss; reconciliations list (summaries) and detail (`findings`, `truncated`, `previousRunId`, finding `outcome: 'fixed'|'still_open'`); `sync` `202 {enqueued, reason?}`, `reconcile` `202 {enqueued}`, `DELETE` `204`; non-UUID path ids → `400 invalid_uuid`; offline conflicts list through S09 HTTP routes only (no event subscription, R-14)
- [X] T088 [US10] Implement `lib/api/seller-integrations.ts`, `components/seller/integrations/*`, routes `…/integrations/{page,loading}.tsx` (+ quarantine, reconciliations, conflicts) and nav entries

### F7 — Campaigns (S36)

- [X] T089 [P] [US10] Read `specs/domains/S36-sponsored-listings/contracts/ads-api.md`; write failing `components/seller/ads/campaigns-view.test.tsx`: six campaign routes and the statement route, `statusReason` shown, mutations only for `OWNER`/`ADMIN`, refusals handled
- [X] T090 [US10] Implement `lib/api/seller-ads.ts`, `components/seller/ads/*`, route `…/campaigns/{page,loading}.tsx`, nav entry; write `tests/ad-campaign.spec.ts` (create and pause)

### F8 — Storefront widget (S44)

- [X] T091 [P] [US10] Read `specs/domains/S44-storefront-widget/contracts/*`; write failing `components/seller/widget/widget-view.test.tsx`: permission `widget.manage`, `PATCH` with `expectedVersion`, kill switch `200` with `version` +1, secret once via `RevealSecretDialog`, `422 origin_invalid {details:{origin,reason}}`, `422 featured_product_invalid`, `409 site_version_conflict`
- [X] T092 [US10] Implement `lib/api/seller-widget.ts`, `components/seller/widget/*`, route `…/widget/{page,loading}.tsx`, nav entry (`requires: 'widget.manage'`; add the permission to `ShopPermission` only if the contracts schema has it, else sibling follow-up bullet for S03)

### F9 — Knowledge documents (S47)

- [X] T093 [P] [US10] Read `specs/domains/S47-rag-help-center/contracts/knowledge-api.md`; write failing `components/seller/knowledge/documents-view.test.tsx`: create, presigned upload, `uploaded`, polling, `retry`, delete, help-center ask
- [X] T094 [US10] Implement `lib/api/seller-knowledge.ts`, `components/seller/knowledge/*`, route `…/knowledge/{page,loading}.tsx`, nav entry; the two S47 journey rows stay skipped (W04's source list does not name S47 yet — write that under `## Sibling-spec follow-ups` as `- **S47**: …` if the journey cannot be un-skipped)

---

## Phase 13: Polish and cross-cutting

- [X] T095 Delete what the spec replaces if still present: `packages/web/tests/seller.spec.ts` (after T042/T056/T065/T073/T050 cover its steps), `lib/api/developers.ts` wire types, `lib/api/shops.ts` seller calls (`setAccessToken`/`/api/sellers/me/stats`), `hooks/use-event-stream.ts` callers inside W04 files, remaining `export const instant = false`, `LOW_STOCK` copy, `window.confirm`
- [X] T096 Update `packages/web/lib/api/shops.ts`/`catalog.ts` consumers so web types follow `productPublicSchema`/`productMemberSchema` and the routes are `/shops/:shopId/products…` with `expectedVersion` on edit/archive/restore (S05 follow-up; W02 call sites of `formatMoney(minor, currency)` pass a real currency)
- [X] T097 Add the `## Spec changes` section in `gaps.md` only if a human-signed page was changed (state which); keep `## Sibling-spec follow-ups` complete (W03 `subscribeTopic`, W07 header test, anything found by T011 and the F-slices)
- [X] T098 Confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-003, SC-008, SC-009 and `specs/UNVERIFIED.md` has one `not run` row each (rows already present at lines for W04; edit only if wording must change); SC-004 (AS-46), SC-005 (AS-17), SC-006 (AS-89), SC-007 (axe) stay test-proven
- [X] T099 Run the static gates once: `pnpm exec tsc --noEmit`, `pnpm lint` (must be clean, including `react-hooks/immutability`), `pnpm exec vitest run lib/architecture.test.ts`, then the whole web Vitest suite once; backend `scripts/sdd/test-spec.sh packages/backend/libs/composition/bff/seller` and the specs of domains touched by T011–T012 once; `python3 scripts/livespec/check.py`. (`next build`, journey and visual suites, fresh-stack and standalone boots: deferred to the final checkpoint.)

---

## Dependencies and order

- Phase 1 → Phase 2 (backend T006–T014 and web T015–T029 are parallel groups) → Phase 3 (US9 shell) → US1 → US2; US3, US4, US5, US6, US7, US8 depend only on Phases 2–3 and may run in parallel after US1's route tree exists; US10 slices are independent of each other and run last; Phase 13 last.
- Test task always before its code task (T015→T016, T017→T018, T019→T020, T022→T023, T027→T028, T030→T031, T032/T033→T035–T037, T040→T041, T044/T045→T046–T048, T052/T053→T054–T055, T058→T059, T061/T062→T063, T067→T068, T069/T070→T071–T072, T075→T076, each F-slice test→code).
- Deletions (T043, T049, T055, T060, T064, T095) only after their replacement passes.

## Parallel examples

- Phase 2: T006, T011, T014, T015, T017, T019, T021, T022, T027, T029 together (different files).
- After Phase 3: US3 (T052, T053), US4 (T058), US5 (T061, T062), US7 (T069, T070), US8 (T075) tests together.
- US10: F-slices T077/T079/T081/T083/T085/T087/T089/T091/T093 together.

## Gap coverage (every gaps.md item has a task)

| Gaps | Tasks |
|---|---|
| A1, A5 | T026, T059, T063 |
| A2, A3, A10 | T035–T037, T041 |
| A4 | T024 |
| A6, A9 | T036, T041, T052–T055 |
| A7, A8 | T025, T026, T095 |
| A11, A13 | T027–T028, T059, T063 |
| A12 | T029, T059, T063, T095 |
| B1, B2 | T040, T041 |
| B3, B4 | T044, T046–T049 |
| B5 | T052–T055 |
| B6 | T058–T060 |
| B7 | T061–T064 |
| B8 | T067–T068 |
| B9 | T069–T072 |
| B10 | T075–T076 |
| B11, B12, B14 | T032–T037, T049 |
| B13 | T019–T020, T030–T031 |
| B15 | T022–T023, T045, T047 |
| C1–C9 | T012, T025, T026, T096 |
| D1, D2 | T032, T035 |
| D3, D4, D5, D6 | T029, T031, T052, T059 |
| D7 | T055, T095 |
| D8 | T044, T046 |
| D9 | T021, T058 |
| E1 | T006–T010 |
| E2–E10 | T011 (shape checks; owners' follow-ups under `## Sibling-spec follow-ups`) |
| E11 | T014 |
| E12 | T007, T012 |
| E13 | T003, T073 |
| T1–T5 | already installed (R-07) · T038 (T5), T039 (T4 visual specs) |
| T6 | T042, T050, T056, T065, T073, T095 |
| T7 | T003 |
| T8 | T004, T050 |
| T9 | closed (contracts have source) |
| T10, T11 | no task (optional, R-12; keep `playwright.config.ts`) |

## Follow-up coverage (from built specs)

S03 → T033, T035, T069–T072 · S05 → T026, T052–T055, T096 · S06 → T083–T084 · S07 → T079–T080 · S08/S09 → T087–T088 · S10/W07/S40 → T044–T049 · S12 → T081–T082 · S14/S15/S16/J01 → T077–T078 · S29/S30 → T085–T086 · S36 → T089–T090 · S42 → T058–T068 · S43 → T061–T064 · S44 → T091–T092 · S47 → T093–T094 · S51 → T022–T023, T045 · W01 → T036, T040, T038, T064 (lint error and catch bindings) · W02 → T044, T046, T096 · W03 → T037, T049, T076.

## Implementation strategy

MVP = Phases 1–5 (backend aggregate, foundations, shell, shop entry, overview + live). Then US3 inventory, US4/US5 developers, US6, US7, US8, then US10 slices one at a time (each ships green on its own tests), then Phase 13.

## Phase 14: Convergence

- [X] T100 Fix the stale test `W04 F6-4` in `packages/web/components/seller/media/gallery-view.test.tsx` (about line 154): `lib/api/seller-media.ts:74-78` appends the signed fields, then `Content-Type` (the policy requires `image/`), then `file`; the test expects `[key, policy, x-amz-signature, file]` and `appended[3]` as the File. Expect the extra `Content-Type` field (the file's type) and keep the "file last" assertion with `appended.at(-1)` per F6 photo gallery upload (partial)
