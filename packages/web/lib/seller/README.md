# W04 seller modules: the exact names used

Read before writing seller code: `packages/web/AGENTS.md` and the Next 16.3.8 guides in `node_modules/next/dist/docs/` named in
`specs/web/W04-seller-dashboard/plan.md` (authentication with Cache Components, rendering philosophy, `instant`, server functions and
forms, redirecting). Per module: what it exports that W04 uses (3 lines at most).

## W01 (used, not owned)

- `lib/auth/guards.ts`: `authPageRedirect({user, returnTo, error})` (auth pages only). `lib/auth/return-to.ts`: `safeReturnTo(raw)`, `loginHref(returnTo)`.
- `lib/auth/session.server.ts` (server only): `getServerSession()` (memoized, call under Suspense), `requireServerSession(returnTo)` (redirects to `loginHref`); type `SessionUser`.
- `lib/auth/session-ended.ts`: `endSession()` (runs the session-ended flow once), `setSessionEndHandler`, `rearmSessionEnd`; the shared client calls `endSession()` on a 401 with an ended code.
- `lib/api/errors.ts`: `problemFromError(error): Problem` (`status`, `code`, `errors[]`, `retryAfterSeconds`, `requestId`; never `title`/`detail`), `apiErrorMessage` (legacy toasts only).
- `lib/api/client.ts`: `apiClient` (axios, relative URLs, CSRF header on non-GET, no token). `lib/api/csrf.ts`: `csrfHeaders()`, `CSRF_HEADER`. `lib/api/parse.ts`: `parseBody(schema, data)`, `ApiParseError`.
- `lib/api/idempotency.ts`: `newIdempotencyKey()`. `components/auth/problem-alert.tsx`: `<ProblemAlert problem context? surface? />`. `hooks/use-auth-actions.ts`: `useRefreshSession()` (mutation, W04 calls it 3 times after opening a shop).
- `lib/realtime/user-stream.ts`: `subscribeUserEvents`, `addTopic`, `watchStreamSilence`, `claimStreamBanner`, `getUserStreamSnapshot`; W04 adds `subscribeTopic(topic, handler, eventTypes?)` and `parseLiveFrame(data)`.
- `lib/server/member-read.server.ts`: `readAsMember(path, schema)` (cookie only, `no-store`, `ReadResult`), `isUuid`. `lib/server/read.server.ts`: `ReadResult`, `ReadFailure`.

## W04 modules (new)

- `lib/seller/permissions.ts`: `ShopPermission`, `shopCan(shop, permission)`, `pageRequires`, `shopPages`, `shopWritable(shop)`, `useShopWritable(shop)`, `SUSPENDED_COPY`, `CLOSING_COPY`.
- `lib/seller/money-input.ts`: `parseMoneyInput(text, fractionDigits)`, `fractionDigitsOf(currency)`. `lib/seller/stock.ts`: `LOW_STOCK_THRESHOLD`, `stockStatus`, `STOCK_LABEL`.
- `lib/seller/problem-copy.ts`: `sellerProblemCopy(problem, context)`, `problemDetailOf(error)` (for `endpoint_url_rejected` only). `lib/seller/countdown.ts`: `useCountdown(seconds, token?)`. `lib/seller/format-date.ts`: `formatInstant`, `formatClock`.
- `lib/seller/search-params.ts`: `readDays`, `readInventoryParams`, `readOrdersParams`, `readTeamParams`, `readUsageParams`, `readWebhookAttemptsParams`, `readLogsParams`, `readCursor`, `buildQuery`. `lib/seller/wire.ts`: page sizes, `inventoryQuery`, `logsQuery`, `attemptsQuery`, `listQuery`, `browsePage`, `searchPage` (shared by browser and server).
- `lib/query-keys.ts`: `queryKeys.seller.{shops, shop, scope, overview, inventory, product, orders, team.{members, invites, roles}, apiKeys, apiVersion, logs, usage, webhooks, webhookEventTypes, webhook, webhookAttempts, webhookEvent}`; `scope(shopId, section)` is the prefix to invalidate a section.
- `lib/api/seller.ts`: `useShop`, `useMyShops`, `useOverview`, `useOpenShop`. `lib/api/seller-products.ts`: `useInventory`, `useProduct`, `useCreateProduct`, `useUpdateProduct`, `useAdjustStock`, `useArchiveProduct`, `useRestoreProduct`.
- `lib/api/seller-developers.ts`: keys, version, logs, usage and webhook hooks of `contracts/web-modules.md`; secret-bearing mutations take `reveal(created)` and return the record without the secret (`gcTime: 0`).
- `lib/api/seller-team.ts`: `useMembers`, `useChangeRole`, `useRemoveMember`, `useInvites`, `useInvite`, `useResendInvite`, `useRevokeInvite`, `useRoles` (`acceptInvite` is the server action of `app/invites/[token]`). `lib/api/seller-orders.ts`: `useShopOrders`.
- `lib/server/seller.server.ts`: `readMyShops`, `readShop`, `readOverview`, `readInventoryFirstPage`, `readShopOrders`, `readMembers`, `readInvites`, `readApiKeys`, `readApiVersion`, `readRequestLogs`, `readUsage`, `readWebhooks`, `readWebhook`, `readWebhookAttempts`.
- `components/seller/`: `RevealSecretDialog`, `ConfirmDialog`, `RowMenu`, `ResponsiveTable` (+ `Column`), `CopyButton`, `FiltersSheet`, `ShopStatusBanner`, `OverviewSkeleton`, `ListPageSkeleton`, `DetailPageSkeleton`, `CardPageSkeleton`.
- Test helpers (not shipped): `lib/test/seller-handlers.ts` (fixtures, `sellerProblem(code)`), `lib/test/event-source-stub.ts` (`installLiveStreamStub`), `lib/test/clipboard-stub.ts` (`installClipboardStub`), `lib/test/stub-registry.ts`; Playwright: `tests/helpers.ts` `openShop`, `seedProduct`, `shopPath`, `readInviteLink`.
