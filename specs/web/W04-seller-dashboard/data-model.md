# Data model: W04 — Seller dashboard

W04 owns no tables. This file lists the view entities (all parsed from `packages/contracts` schemas), the single home of each kind of state, URL state per route, and the few client state machines.

## Entities (UI view models; schema → field use)

| Entity | Schema (contracts) | Used fields / notes |
|---|---|---|
| Shop context | `shopSchema` | `id, name, slug, plan, status (ACTIVE\|SUSPENDED\|DELETING…), myRole, myPermissions`. `ShopPermission` = `products.read\|products.write\|orders.read\|members.read\|members.manage\|shop.read\|shop.manage\|webhooks.manage` (names from S03 `GET /shop-roles` `permissions`). |
| Shop list item | `shopListItemSchema` | `id, name, slug, plan, status, role`; page `{items, nextCursor}`, size 50. |
| Overview answer | `sellerOverviewResponseSchema` (new) | `{shop, stats\|null, today\|null, rank\|{notRanked:true}\|null, errors[{section,code,retryable}]}`. |
| Stats | `sellerStatsSchema` | `currency, summary{revenueMinor, orders, unitsSold, uniqueBuyers, refundsCount, refundedMinor, netRevenueMinor, avgOrderValueMinor}, daily[{day,revenueMinor,orders,refundedMinor}], topProducts[{productId,title,revenueMinor,unitsSold}]`. |
| Today | `dashboardTodaySchema` | totals and per-minute series for the UTC day. |
| Rank | `shopRankSchema` | `period.kind, category, rank, of, topPercent`. |
| Live frame | `liveDashboardFrameSchema` | `shopId, at, windowSeconds, last60s{checkouts,orders,units,revenueMinor}, ordersPerSecond[60], checkoutConversion\|null`. Held in the panel only. |
| Product row / form | `productMemberSchema`, `shopProductSearchItemSchema`, `productCreateRequestSchema`, `productUpdateRequestSchema`, `productTransitionRequestSchema` | `version` only from the member view; search rows have none. |
| API key | `apiKeyListItemSchema` (page `apiKeyListSchema`), created/rotated payloads | `prefix, name, scopes, livemode, status (active\|rotating\|expired\|revoked), expiresAt, lastUsedAt, createdAt, successorId`, `previousExpiresAt` on rotate. The secret field exists only in the created/rotated response and goes straight to dialog state. |
| API version | `apiVersionStateSchema` | pinned version, pin date, supported list with status and sunset. |
| Request log / usage | `requestLogPageSchema`, `usageReportSchema` | rows as in spec Key Entities. |
| Webhook endpoint | `webhookEndpointSchema` (page `webhookEndpointPageSchema`, created variant with secret) | `status, disabledReason, failingSince, breaker, hasPreviousSecret, previousSecretExpiresAt`. |
| Attempt / event | `webhookAttemptPageSchema`, `webhookEventDetailSchema`, `webhookEventTypesResponseSchema` | body rendered as text. |
| Member / invite / roles | `shopMemberSchema`, `shopInviteSchema`, `shopRolesSchema` | `email` may be null → "Unknown member". |
| Shop order slice | `shopOrderPageSchema` | `shopOrderId, status, subtotalMinor, currency, createdAt, items`; `buyerId` is parsed (schema is strict) and never rendered. |
| Problem | W01 `Problem` (`problemFromError`) | `code, status, detail, requestId, errors[{field,code,message}], retryAfter`. |

## State homes (constitution VI.4)

| Kind | Home | Examples |
|---|---|---|
| Server data | TanStack Query, keys `queryKeys.seller.*`; seeded from the server render with `initialData` | shop, overview, lists, endpoints, attempts, roles |
| Shareable view state | URL search params (defaults omitted, invalid → `router.replace` to default, filter change drops `cursor`) | below |
| Local UI state | `useState` / `useReducer` in the lowest component | dialogs, form drafts, copy feedback, "View as table", open menu, event panel idempotency key |
| Live stream | module-level ref-counted connection (`lib/realtime/user-stream.ts`); the frame in a ref + one state value for rendering | live panel |
| Secrets | state of the open `RevealSecretDialog` only; cleared on close/unmount; never in the cache, URL, storage, console, analytics | key, `whsec_…` |
| Context / store | none added | — |

## URL state per route

| Route | Params (defaults omitted) |
|---|---|
| `/dashboard/seller` | `cursor` |
| `…/{shopId}` | `days` ∈ {7, 90} (30 default) |
| `…/inventory` | `q`, `status` (`ARCHIVED`; `ACTIVE` default), `inStock=false`, `cursor` |
| `…/orders` | `status`, `cursor` |
| `…/team` | `tab` (`invitations`\|`roles`; members default), `status` (Pending default), `cursor` |
| `…/developers/api-keys`, `…/webhooks` | `cursor` |
| `…/webhooks/{endpointId}` | `ok=false`, `event`, `cursor` |
| `…/developers/logs` | `requestId, status, route, keyId, livemode, from, to, cursor` |
| `…/developers/usage` | `days` ∈ {7, 14} (30 default), `livemode=false` (Live default) |

## State machines

**Live panel** (`connecting → live ⇄ reconnecting → unavailable`):

| From | Event | To |
|---|---|---|
| connecting | first frame | live |
| live | error/close, or 5 s without a frame | reconnecting (numbers dimmed, "Last updated {time}") |
| reconnecting | frame | live |
| live/reconnecting | `resync` | same state; refetch today + period keys |
| live/reconnecting | `revoked` | one session check; resubscribe or unavailable |
| any | final `401`/`403` twice (one session refresh between) | unavailable (poll `today` every 30 s while visible) |
| live | tab hidden | closed; on visible: reopen + one refetch |

**Reveal dialog** (`open(secret) → copied? → done`): `Done` without `copied` shows the confirm line (once); `Close anyway` or `Done` after copy clears the secret; Escape and outside click are ignored.

**Webhook endpoint status** (display only, from the API): enabled → (disable) disabled/paused-by-you → (enable) enabled; enabled → (breaker) disabled/automatic → (enable + confirm) enabled; `breaker: open` shows "Retrying after failures".

**Key status** (display only): active → rotating (until `previousExpiresAt`) → expired; active|rotating → revoked.

**Countdown** (`idle → counting(n) → idle`): started by a `429` with `Retry-After`; announces start and end once; the causing control stays disabled while counting.

## Validation (UI-only)

- Open shop: name required; handle 3–40 lowercase letters, digits, inner dashes; validated on first blur or submit.
- Product: title, brand, category required; price decimal with ≤ currency fraction digits (comma or point), non-negative; stock whole number ≥ 0. Parse from string, no floats.
- Key: name trimmed 1–60; ≥ 1 scope; optional expiry between tomorrow and +365 days.
- Webhook: ≥ 1 event; URL left to the API (`endpoint_url_rejected`).
- Logs: dates within 30 days, `to` ≥ `from`.
- Invite: e-mail format and role ∈ {Admin, Staff, Viewer}.
