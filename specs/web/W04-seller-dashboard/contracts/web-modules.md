# Web modules and routes provided by W04

Exact names (spec "Provides"). Modules under `packages/web`.

## Routes

`/dashboard` (permanent redirect) · `/dashboard/settings` (redirect `/account/security`) · `/dashboard/seller` · `/dashboard/seller/inventory` (redirect) · `/dashboard/seller/[shopId]` (`days`) · `…/inventory` (`q`, `status`, `inStock`, `cursor`) · `…/orders` (`status`, `cursor`) · `…/team` (`tab`, `status`, `cursor`) · `…/developers/api-keys` · `…/developers/webhooks` · `…/developers/webhooks/[endpointId]` (`ok`, `event`, `cursor`) · `…/developers/api-version` · `…/developers/logs` · `…/developers/usage` · `/invites/[token]`. Phase 9 adds routes under `/dashboard/seller/[shopId]/…` (listed in `tasks.md`).

Every page: Server Component; `requireServerSession(returnTo)` first (`returnTo` = path + query); `[shopId]/layout.tsx` resolves the shop with `lib/server/seller.server.ts#readShop(shopId)` (non-UUID, unknown, foreign → `notFound()` → "We couldn't find that shop." with link "Your shops"); content behind `<Suspense fallback={<XSkeleton/>}>`; no `instant = false`, no `use cache` around per-user data.

## Library API

| Module | Exports |
|---|---|
| `lib/query-keys.ts` | `queryKeys.seller.{shops(), shop(shopId), overview(shopId,{days}), inventory(shopId,{q,status,inStock,cursor}), product(shopId,productId), orders(shopId,{status,cursor}), team.{members(shopId,{cursor}), invites(shopId,{status,cursor}), roles()}, apiKeys(shopId,{cursor}), apiVersion(shopId), logs(shopId,filters), usage(shopId,{days,livemode}), webhooks(shopId,{cursor}), webhookEventTypes(shopId), webhook(shopId,endpointId), webhookAttempts(shopId,endpointId,{ok,cursor}), webhookEvent(shopId,endpointId,eventId)}`; removes `seller.dashboard` and `seller.products`. |
| `lib/api/seller.ts` (client) | `useShop(shopId)`, `useMyShops()`, `useOverview(shopId, days, initialData?)`, `useOpenShop()`, `type ShopPermission`; each call parses with the contracts schema. |
| `lib/api/seller-products.ts` | `useInventory`, `useProduct`, `useCreateProduct`, `useUpdateProduct`, `useAdjustStock`, `useArchiveProduct`, `useRestoreProduct`. |
| `lib/api/seller-developers.ts` | `useApiKeys`, `useCreateKey`, `useRotateKey`, `useRevokeKey`, `useApiVersion`, `usePinVersion`, `useRequestLogs`, `useUsage`, `useWebhooks`, `useWebhookEventTypes`, `useCreateWebhook`, `useUpdateWebhook`, `useSetWebhookEnabled`, `useRotateWebhookSecret`, `useExpirePreviousSecret`, `useDeleteWebhook`, `usePingWebhook`, `useWebhookAttempts`, `useWebhookEvent`, `useReplayEvent`. Removes `developersApi.pingWebhooks` and the old `lib/api/developers.ts` wire types. |
| `lib/api/seller-team.ts` | `useMembers`, `useChangeRole`, `useRemoveMember`, `useInvites`, `useInvite`, `useResendInvite`, `useRevokeInvite`, `useRoles`, `acceptInvite(token)` (server action target, see below). |
| `lib/api/seller-orders.ts` | `useShopOrders`. |
| `lib/server/seller.server.ts` | `readMyShops(cursor?)`, `readShop(shopId)`, `readOverview(shopId, days)`, `readInventoryFirstPage(...)`, and one reader per list page for `initialData`. All via `readAsMember` (cookie session, `no-store`), results are a value (`ReadResult`), never a throw. |
| `lib/seller/permissions.ts` | `shopCan(shop, permission): boolean`; `pageRequires` table (page → permission); `useShopWritable(shop): { writable: boolean; reason: string \| null }`. |
| `lib/seller/nav.ts` | `SellerNavItem = { id: string; group: 'shop' \| 'developers'; label: string; href: (shopId: string) => string; icon: LucideIcon; requires?: ShopPermission }`, `sellerNavItems: SellerNavItem[]`. |
| `lib/seller/money-input.ts` | `parseMoneyInput(text, fractionDigits): { ok: true; minor: number } \| { ok: false; reason }` (string parsing, comma or point, no floats), `fractionDigitsOf(currency)`. |
| `lib/seller/problem-copy.ts` | `sellerProblemCopy(problem, context): { form: 'field'\|'alert'\|'page'\|'toast'\|'session'\|'countdown'; message: string; field?: string }` implementing the spec's error catalogue by `code` (never shows `detail` except `endpoint_url_rejected`). |
| `lib/seller/stock.ts` | `LOW_STOCK_THRESHOLD = 5`, `stockStatus(quantity, status)` → `'archived'\|'out'\|'low'\|'in'`. |
| `lib/seller/search-params.ts` | typed readers/writers per route (`readDays`, `readInventoryParams`, …) returning the default for an invalid value. |
| `lib/seller/countdown.ts` | `useCountdown(seconds)`. |
| `lib/realtime/user-stream.ts` | `subscribeTopic(topic: string, handler: (event: { type: string; data: unknown }) => void): () => void` over `addTopic` + `subscribeUserEvents`; calling the returned function releases the topic. `parseLiveFrame(data)` unwraps the hub `{topic, data}` envelope with `liveDashboardFrameSchema`. |

## Components

| Path | Contract |
|---|---|
| `components/seller/secret-reveal-dialog.tsx` | `<RevealSecretDialog title description secret note? onDone />`; Escape and outside click ignored; "Done" before "Copy" shows "You haven't copied this key. It can't be shown again." with "Close anyway" / "Copy key"; copy success "Copied" 2 s + status "Copied to clipboard"; denied → selects text + "Press Ctrl+C (⌘C on Mac) to copy."; secret never leaves dialog state. (Spec Provides path `components/seller/secret-reveal-dialog.tsx`; the test-plan's `components/seller/developers/secret-reveal-dialog.test.tsx` imports it from there.) |
| `components/seller/shop-status-banner.tsx` | `<ShopStatusBanner shop />` (suspended / closing copy). |
| `components/seller/inventory/product-form.tsx` | `<ProductForm mode="create"\|"edit" shopId currency fractionDigits product? onSaved />`. |
| `components/seller/problem-states.tsx` | `<ProblemPanel />`, `<SectionError onRetry />`, `<OfflineBanner />`, `<RateLimitNotice />`; wrap W01's `<ProblemAlert />`. |
| `components/seller/{confirm-dialog,row-menu,responsive-table,copy-button,filters-sheet,page-skeletons}.tsx` | shared primitives (R-16, R-17). |
| `components/dashboard/dashboard-shell.tsx` | Server frame: sidebar (`nav` "Seller"), top bar + drawer ("Open menu"), switcher; reads `sellerNavItems` and `shopCan`; no role claim. |

## Server action

`app/invites/[token]/actions.ts` `'use server'` `acceptInviteAction(token)`: calls `POST /shop-invites/accept` with the session, returns `{ ok: true, shopId, role, alreadyMember } | { ok: false, code, retryAfter? }`; the token is a bound argument read from the route param on the server, never logged, never sent to analytics (page name `/invites/:token` in `lib/routes/page-name.ts`). The client component replaces history with `router.replace('/dashboard/seller/{shopId}')` and shows the toast.

## Playwright helpers (`tests/helpers.ts`)

`openShop(page, name?)` → `{ shopId, shopName }` (through the UI from a signed-in page) · `seedProduct(shopId, input)` → product id (API call with the seller's session) · `shopPath(shopId, section?)` · `readInviteLink(email)` (R-13).

## Events and timing constants

Live topic `shop:{shopId}:live`, event type `dashboard`. `LIVE_STALE_MS = 5_000`, `PERIOD_INVALIDATE_MIN_MS = 30_000`, `TODAY_POLL_MS = 30_000`, `SEARCH_DEBOUNCE_MS = 300`, `PING_REFETCH = 5_000 every, 30_000 total`, `COPIED_MS = 2_000`.
